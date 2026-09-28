# Your n8n webhook dedupe is not atomic

*Nikola Radosavljević, software engineer, Belgrade. September 2026.*

Most n8n workflows that take payment webhooks have some kind of deduplication, because everyone knows providers deliver events more than once. The common version goes like this: a Webhook node, then a lookup ("have I seen this event id?"), then an IF, then the work, then an insert that records the id.

That is two steps where there needs to be one. Duplicates rarely arrive politely one after another. They arrive together: a retry after a slow response, two deliveries racing each other. Both executions run the lookup before either has run the insert. Both see "new". Both ship the order. The dedupe passes every test where the duplicates come in sequence, and fails in exactly the case it was built for.

The payments demo in this repo is built around that failure. Stripe-style signed events come in, orders move through a state machine, and a paid order is sent to a POS. Here is what holds it together.

## One statement decides "new or duplicate"

The inbox table has a unique constraint on the provider's event id ([db/40_payments.sql](../../db/40_payments.sql)):

```sql
CREATE TABLE IF NOT EXISTS pay.inbox (
    id        bigserial PRIMARY KEY,
    event_id  text NOT NULL UNIQUE,
    ...
```

Ingestion is one insert that either creates the row or does nothing:

```sql
-- pay.ingest()
WITH ins AS (
    INSERT INTO pay.inbox (event_id, event_type, payload)
    VALUES (p_event_id, p_type, p_payload)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
)
SELECT jsonb_build_object(
    'inbox_id', coalesce((SELECT id FROM ins), (SELECT id FROM pay.inbox WHERE event_id = p_event_id)),
    'is_new', EXISTS (SELECT 1 FROM ins))
```

There is no gap between "check" and "record", because they are the same statement. If three copies arrive at once, the unique index lets exactly one insert through, and the other two come back with `is_new: false`.

Before any of this, a Code node ([src/code/payments/verify-signature.js](../../src/code/payments/verify-signature.js)) checks the signature: HMAC-SHA256 over the raw body, a 5 minute window against replayed requests, and a comma-separated list of secrets so they can be rotated. Anything that fails gets a 400 and is never stored.

## Answer first, work later

The ingest workflow replies 200 straight after the insert, before any business logic, and then hands new events to a processor sub-workflow without waiting for it. The provider only needs to know the event is stored. A slow handler is the usual reason a provider retries, and eventually the reason it disables your endpoint.

## Claim work with SKIP LOCKED and a lease

The processor does not assume it is the only one running. It claims events with `FOR UPDATE SKIP LOCKED` and stamps a lease on them:

```sql
-- pay.claim()
UPDATE pay.inbox i
   SET status = 'processing', attempts = i.attempts + 1, locked_until = now() + interval '2 minutes'
 WHERE i.id IN (
        SELECT id FROM pay.inbox
         WHERE (p_event_id IS NULL OR event_id = p_event_id)
           AND ((status IN ('pending', 'retry') AND next_attempt_at <= now())
                OR (status = 'processing' AND locked_until < now()))
         ORDER BY received_at
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit)
RETURNING i.*
```

`SKIP LOCKED` means two workers, or the direct hand-off and the sweeper, never claim the same row at the same time. The lease covers the other case: an execution that claims an event and then dies. Two minutes later `locked_until` is in the past, and a sweeper that runs every 10 seconds picks the event up again. Nothing stays stuck in "processing".

The order state machine lives in `pay.apply()`, under a row lock on the order. A second `payment_intent.succeeded` for an order that is already fulfilled changes nothing. A refund that arrives before its payment is parked as `out_of_order` and retried later, instead of being applied to an order that has not been paid.

The POS call carries `Idempotency-Key: <event_id>`. With a POS that honours the header (the mock in the repo does, the way Stripe and Square do), a retry after a lost response gets the same POS order back instead of creating a second one.

## Retries with backoff, then dead letters

When the POS fails, `pay.fail()` schedules the next attempt with exponential backoff and jitter:

```sql
-- pay.fail()
v_delay := least(c.max_backoff_seconds, c.base_backoff_seconds * power(2, e.attempts - 1))
           * (0.8 + random() * 0.4);
```

With the defaults in `pay.config` that is roughly 30 s, 60 s, 120 s and so on, capped at an hour, with 20% jitter either way so a batch of failures does not retry in lockstep. After `max_attempts` (6 by default) the event is marked dead and a critical alert is written. The money stays recorded as paid; only fulfilment is waiting.

A dead letter is not the end of the road. Once the cause is fixed, one admin call puts it back in the queue:

```sql
-- pay.replay()
UPDATE pay.inbox
   SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL,
       processed_at = NULL
 WHERE event_id = p_event_id AND status IN ('dead', 'ignored')
```

`POST /webhook/payments/admin/replay` needs an admin token, and `GET /webhook/payments/admin/health` shows inbox counts, the oldest waiting event, dead letters and open alerts.

## What the tests show

From the run on 26 September 2026 on n8n 2.40.7 (49 tests in the repo, all passing; the latest run is always in [docs/test-report.md](../test-report.md)):

- **Burst:** 12 orders, every event delivered twice, all 24 deliveries in parallel. 12 orders fulfilled, exactly one POS order each.
- **Three simultaneous deliveries of one event:** one accepted as new, two dropped at the inbox, one POS order.
- **Acknowledgement:** 79 ms from sending a valid event to getting the 200 back.
- **Flaky POS:** the POS answered 503, 503, then 201, over 3 attempts, with the same `Idempotency-Key` each time.
- **POS down for good:** the event is dead-lettered, an alert is raised, and the order is still paid. After the fix, one replay call fulfils it.
- **Refund before payment:** parked, then applied in the right order: paid > fulfilled > refunded.

One honest note: to keep the suite fast, the retry tests set the base backoff to 1 second, and the dead-letter test sets `max_attempts` to 3. The logic is the same; only the waiting is shorter.

## What I look for in an audit

When I audit an n8n instance that receives webhooks, this is one of the first things I check. Is "have I seen this?" answered by one atomic statement, or by a lookup and a later insert? Is the 200 sent before or after the slow work? Can a crashed execution leave an event stuck forever? Is there a dead-letter state, and a way to replay from it? None of this is exotic. It is what production traffic does to a workflow that passed every manual test.

Everything above is MIT-licensed in this repo: the SQL in [db/40_payments.sql](../../db/40_payments.sql), the workflows in [src/workflows/payments.mjs](../../src/workflows/payments.mjs), and the tests in [tests/run-all.mjs](../../tests/run-all.mjs). If you want someone to run the same checks on your own workflows, see [Work with me](../../README.md#work-with-me).
