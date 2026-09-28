# Why your Vapi or Retell agent double-books

*Nikola Radosavljević, software engineer, Belgrade. September 2026.*

A voice agent that books appointments makes two tool calls that feel like one action to the caller. First `check_availability`: "I can offer 12:00 with Ana, 13:00 or 14:00." Then, once the caller has thought about it and said "12:00 please", `book_appointment`. There is a whole conversational turn between those two calls. On a quiet day nothing happens in that gap. On a busy morning a second caller is having the same conversation on another line, and both of them were told 12:00 is free.

That is the first way agents double-book. The second one is quieter. Voice platforms retry when your webhook is slow. If your booking workflow already inserted the appointment and then took too long to answer, the retry inserts it again. The caller hears one confirmation. The salon has two rows.

A better prompt fixes neither of these, and neither does checking harder. An n8n workflow that does "look up the slot, IF free, insert" has a gap between the lookup and the insert, and two executions running at the same moment can both see "free". A second check right before the insert makes the gap smaller. It does not close it.

In this repo I built the booking backend so that both failures are impossible at the database level, and then wrote tests that try to cause them anyway. This is how it works.

## Make overlapping bookings impossible, not unlikely

The appointments table carries an exclusion constraint ([db/30_booking.sql](../../db/30_booking.sql)):

```sql
CONSTRAINT no_double_booking
  EXCLUDE USING gist (staff_id WITH =, during WITH &&)
  WHERE (status = 'booked')
```

`during` is a `tstzrange` column, a start and an end time stored as one value. The constraint says that no two booked rows may have the same stylist and overlapping time ranges. Postgres enforces it inside the insert itself, under concurrency, whatever the workflow in front of it does. It needs the `btree_gist` extension for the `=` on an integer column, which is one line in [db/00_create_apps_db.sql](../../db/00_create_apps_db.sql). Cancelled rows fall outside the `WHERE`, so cancelling a 12:00 frees that slot again.

The range stored in `during` includes the service's buffer time, so the cleanup time after a haircut is protected by the same rule:

```sql
tstzrange(v_start, v_start + make_interval(mins => svc.duration_min + svc.buffer_min))
```

With the constraint in place, the booking function does not have to "check first". It tries the insert, and if Postgres refuses it, it moves on to the next stylist who does that service and works at that time (unless the caller asked for a specific one):

```sql
-- booking.tool_book()
BEGIN
    INSERT INTO booking.appointments (staff_id, service_id, customer_id, starts_at, ends_at, during, ...)
    VALUES (...)
    RETURNING id INTO v_id;
    EXIT;
EXCEPTION WHEN exclusion_violation THEN
    CONTINUE;
END;
```

If nobody can take it, the caller does not hear an error. The function returns `slot_taken` with up to three alternatives close to the time they asked for, and a sentence the agent can read out as it is: "Sorry, that time was just taken. I can offer ..."

## Make a retry return the first answer

Every Vapi tool call arrives with an id in `toolCallList`. All five tools go through one SQL function, `booking.handle_tool()`, and the first thing it does is look that id up:

```sql
-- booking.handle_tool()
IF p_tool_call_id IS NOT NULL THEN
    SELECT result INTO v_prev FROM booking.tool_invocations WHERE tool_call_id = p_tool_call_id;
    IF v_prev IS NOT NULL THEN
        RETURN v_prev || jsonb_build_object('replayed', true);
    END IF;
END IF;
```

After running the tool, it stores the result under that id (`tool_call_id` is the primary key of `booking.tool_invocations`). A retry of a call that already booked gets the original answer back, with the same booking reference, and books nothing.

There is a second guard for two copies of the same call arriving at the same instant, before either has stored its result: `appointments.tool_call_id` is `UNIQUE`. The second insert fails with a `unique_violation`, which `handle_tool()` catches and answers with "That booking is already confirmed."

Retell needs one extra step. The Retell payload shape the adapter handles (`name`, `args`, `call`) has no per-invocation id to key on, so the adapter ([src/code/voice/normalize.js](../../src/code/voice/normalize.js)) derives a stable one from the call id, the function name and a hash of the arguments:

```js
const fingerprint = crypto.createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 16);
out.tool_calls = [{ id: `retell:${out.call_id}:${body.name}:${fingerprint}`, name: body.name, args }];
```

The same booking request repeated within the same call maps to the same id and is answered from the stored result. After the adapter, both providers run through the same SQL, so the booking logic does not care which one the agency uses.

## Keep the hot path short

Retries are triggered by slowness, so the other half of the fix is not being slow. The n8n workflow for tool calls ([src/workflows/voice.mjs](../../src/workflows/voice.mjs)) is: webhook, normalize the provider payload, one Postgres call, shape the response, reply. The SMS confirmation is written to an outbox table in the same transaction as the booking and sent by a separate dispatcher afterwards. The call log and CRM update run when the end-of-call report arrives. Nothing that talks to a third party sits between the caller and the answer.

## What the tests show

The repo has 49 automated tests: 48 end-to-end tests against a running n8n and Postgres, and one for the LLM path. The ones that matter here, from the run on 26 September 2026 on n8n 2.40.7 (the latest run is always in [docs/test-report.md](../test-report.md)):

- **10 callers race for the same slot.** Ten `book_appointment` calls for the same stylist and start time, fired in parallel from ten different phone numbers and call ids. Result: exactly 1 booked, 9 got `slot_taken` with alternatives, and a SQL check afterwards finds zero overlapping booked rows.
- **Retry of the same tool call.** The same `book_appointment` sent again with the same `toolCallId` returns the same reference with `replayed: true`, and the customer still has exactly one appointment.
- **Latency.** 30 sequential `check_availability` calls through the webhook: p50 92 ms, p95 127 ms.

To be precise about that last number: it is measured against n8n and Postgres running locally in Docker, so it covers the workflow and the database, not the network hop from Vapi or Retell to your server.

## What this does not solve

The constraint protects the table it is on. If the real source of truth is a Google Calendar or a practice management system that staff also edit by hand, two systems can still disagree, and someone has to decide which one wins and sync accordingly. In this setup the Postgres table is the source of truth and everything else is fed from it.

I also keep the scope to inbound calls: the agent answers callers and books for them. Outbound campaigns have different problems.

## If you run a voice agency

All of this is in this repo under the MIT licence. The SQL is in [db/30_booking.sql](../../db/30_booking.sql), the n8n workflows are generated from [src/workflows/voice.mjs](../../src/workflows/voice.mjs), and `node tests/run-all.mjs` runs the race on your own machine. If you would rather not build and maintain it yourself, I set this backend up as a white-label deployment on the agency's own infrastructure, for inbound booking agents on Vapi or Retell. See [Work with me](../../README.md#work-with-me).
