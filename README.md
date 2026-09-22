# n8n automation portfolio

[![ci](https://github.com/nikolaRadosavljevic95/n8n-portfolio/actions/workflows/ci.yml/badge.svg)](https://github.com/nikolaRadosavljevic95/n8n-portfolio/actions/workflows/ci.yml)

Three working n8n systems, built the way I would build them for a client: business rules in Postgres, idempotent webhooks, retries with dead letters, and end-to-end tests. One command starts everything locally, and 31 automated tests prove it works.

| Demo | What it solves | Proof |
|---|---|---|
| [1. RFQ to quote](#1-rfq-to-quote) | A customer sends a PDF request for quotation, sales gets a priced Excel quote back in 2 to 3 seconds, with the uncertain lines separated for review | 12 of 17 lines priced automatically on a messy ERP export, the other 5 flagged with a reason. 7 of 7 on an email list |
| [2. AI receptionist backend](#2-ai-receptionist-backend-vapi--retell) | The tools a Vapi or Retell voice agent calls to check availability, book, move and cancel appointments | 10 callers racing for one slot: exactly 1 booking. p95 latency 114 ms |
| [3. Payment webhooks to POS](#3-payment-webhooks-to-pos) | Stripe-style payment events turned into fulfilled orders in a POS, without losing or duplicating anything | Duplicates, out-of-order refunds, a flaky POS and a dead POS all handled and tested |

Built on n8n 2.40.5 and Postgres 17. Full test output: [docs/test-report.md](docs/test-report.md).

## Run it

You need Docker, Node 20+ and bash (Git Bash is fine on Windows).

```bash
npm run check                      # static checks, no Docker needed, a few seconds
bash scripts/setup.sh              # starts n8n + Postgres, loads data, imports and publishes 13 workflows
node tests/run-all.mjs             # 30 end-to-end tests, about 80 seconds
bash scripts/test-llm-mock.sh      # the LLM branch, against an OpenAI-compatible mock
```

Then open the editor at http://localhost:5678 (it asks you to create an owner account on first visit) and the sales form at http://localhost:5678/form/rfq.

`setup.sh` generates random secrets into `.env` on the first run. Nothing secret is committed.

---

## 1. RFQ to quote

**The problem.** Distributors get requests for quotation as PDFs in every possible layout. Someone retypes them into the ERP, looks up every item, checks the price list and builds a quote. It is slow, and the expensive mistakes are always the same: a B10 breaker quoted as B16, 250 m of cable quoted as 250 rings, a line forgotten.

**What it does.** Upload a PDF (form or API), get a quote in Postgres and an Excel file with two sheets:

![Quote sheet](docs/img/excel-quote.png)

![Review sheet](docs/img/excel-review.png)

```mermaid
flowchart LR
  A[PDF from form or API] --> B[Validate + SHA-256]
  B --> C{Known layout?}
  C -- ERP table or bullet list --> D[Template parser]
  C -- free text --> E[LLM extraction, JSON schema]
  E --> F[Grounding check: reject invented lines]
  D --> G[(Postgres: match and price)]
  F --> G
  G --> H[Save quote, idempotent per PDF]
  H --> I[Excel: Quote + Review]
  I --> J[Sales resolves review lines]
  J -- remember --> K[(Customer part number learned)]
```

The engine in n8n (a sub-workflow shared by the API and the form):

![RFQ engine canvas](docs/img/canvas-rfq-engine.png)

**Design decisions**

- **The LLM reads, it never decides.** It only turns free text into line items. Products and prices come from SQL. Every line the LLM returns is checked against the source text, so an invented item ends up on the review sheet instead of in the quote (tested with a mock that deliberately hallucinates).
- **Cheap and exact first.** Known layouts (ERP exports, bullet lists in emails) are parsed with deterministic parsers: free, instant, no surprises. Only unknown layouts cost an LLM call. A row that looks like data but does not parse is kept and sent to review. Nothing is dropped silently.
- **Hybrid matching in Postgres.** Customer part numbers, our SKUs, manufacturer codes and EANs first, then trigram text search combined with technical attributes pulled from both sides: 16A, curve B, 3x1.5 mm², 30mA, IP65, 4000K, "single pole", "neutral white". A candidate that contradicts the request on any attribute is never picked automatically.
- **Units are converted to how the product is sold.** 250 m of NYM-J 3x1.5 becomes 3 rings of 100 m, 1000 cable ties become 10 packs, and the rounding is written into the quote as a note. A unit that cannot be converted ("2 box" of LED panels) goes to review.
- **Every review line says why.** Code/description conflict, no match, ambiguous, weak match, unit mismatch, no price. Each comes with the top candidates and a suggested action.
- **It learns.** When sales resolves a line with `remember: true`, the customer's part number is stored, and the next RFQ with that code is matched automatically (tested).
- **Idempotent.** The same PDF for the same customer returns the same quote, so a double click never creates a second one.
- **Client errors do not page anyone.** Bad input comes back as `422 { error, message }`. Only real failures reach the central error workflow.

**API**

```bash
curl -F customer_id=1 -F file=@samples/rfq-01-elektro-mont.pdf http://localhost:5678/webhook/rfq/quote
curl -o quote.xlsx "http://localhost:5678/webhook/rfq/quote/xlsx?quote_no=Q-2026-01001"
curl -H "Content-Type: application/json" -d '{"quote_no":"Q-2026-01001","line_no":15,"sku":"VX-LEVER-3W-P50","remember":true}' \
     http://localhost:5678/webhook/rfq/review/resolve
```

<details>
<summary>API workflow canvas</summary>

![RFQ API canvas](docs/img/canvas-rfq-api.png)

</details>

The sales team uses a form instead:

<img src="docs/img/rfq-form.png" width="420"> <img src="docs/img/rfq-form-done.png" width="420">

The sample data is a fictional electrical wholesaler: 138 products, a price list with project prices and volume tiers, manufacturer and EAN aliases, and three sample RFQs in different formats (`samples/`). `scripts/generate_rfq_data.py` regenerates all of it.

To use a real LLM, put your key in `OPENAI_API_KEY`, set `LLM_ENABLED=true` in `.env` and run `setup.sh` again.

---

## 2. AI receptionist backend (Vapi / Retell)

**The problem.** Voice agents are good at talking and bad at bookings. The things that go wrong in production are always in the backend: double bookings when two people call at once, a retry after a timeout that books twice, offering 10:00, 10:15 and 10:30 as "three options", a caller cancelling someone else's appointment.

**What it does.** One webhook per provider handles the five tools the agent needs (definitions in [docs/voice-tools.json](docs/voice-tools.json)): `check_availability`, `book_appointment`, `find_appointments`, `cancel_appointment`, `reschedule_appointment`. The sample business is a hair salon with three stylists, split shifts, time off and buffers between appointments.

```mermaid
sequenceDiagram
  participant C as Caller
  participant V as Vapi / Retell
  participant N as n8n
  participant DB as Postgres
  C->>V: Haircut Thursday afternoon?
  V->>N: check_availability (x-vapi-secret)
  N->>DB: booking.handle_tool()
  DB-->>N: 3 free times, 60 min apart
  N-->>V: results in ~90 ms
  V->>C: I can offer 12:00 with Ana, 13:00 or 14:00
  C->>V: 12:00 please, I am Jovana
  V->>N: book_appointment (toolCallId)
  N->>DB: insert guarded by EXCLUDE constraint + SMS in the same transaction
  N-->>V: booked, reference D458BB
  V->>N: end-of-call-report
  N->>DB: call log, CRM upsert, follow-up task if no booking
```

![Voice tool calls canvas](docs/img/canvas-voice-tools.png)

**Guarantees, each one tested**

- **No double bookings, even under concurrency.** An `EXCLUDE USING gist` constraint on (stylist, time range) makes overlapping bookings impossible in the database. 10 parallel calls for the same slot: 1 booked, 9 told it was just taken and offered alternatives.
- **Retries are safe.** Voice platforms retry when your webhook is slow. Every tool call is stored by its id, so a retry returns the original answer instead of booking again.
- **Speakable answers.** At most three options, at least an hour apart, "today" and "tomorrow" instead of dates, prices and duration included, all in the salon's time zone.
- **Callers only touch their own bookings.** Cancel and reschedule are matched against caller ID. Guessing a reference returns "not found".
- **Fast hot path.** Adapter, one SQL call, reply: p50 87 ms, p95 114 ms over 30 calls. CRM updates and SMS happen after the reply.
- **Outcome from facts, not from the LLM summary.** After the call, the outcome (booked, rescheduled, cancelled, enquiry without booking) is derived from the tool calls that actually happened. The caller is upserted into the CRM by E.164 phone number, and an enquiry without a booking creates a follow-up task.
- **Transactional outbox for SMS.** Confirmations are written in the same transaction as the booking and sent by a dispatcher with retries and backoff. Set `SMS_PROVIDER=twilio` to use the Twilio branch.

Vapi and Retell payloads go through one adapter, so the booking logic does not care which provider you use.

![After-call and SMS outbox canvas](docs/img/canvas-voice-after-call.png)

---

## 3. Payment webhooks to POS

**The problem.** Payment webhooks look simple until production: the provider retries and you ship twice, a refund arrives before the payment, your POS is down for ten minutes, a slow handler makes the provider disable your endpoint.

```mermaid
flowchart LR
  P[Payment provider] -->|signed webhook| W[Verify HMAC, 5 min window]
  W -->|invalid| X[400]
  W --> I[(Inbox, unique event_id)]
  I --> A[200 in under 100 ms]
  I --> Q[Processor: SKIP LOCKED + lease]
  S[Sweeper every 10 s] --> Q
  Q --> M[Order state machine]
  M -->|paid| POS[POS API with Idempotency-Key]
  POS -->|503 or timeout| R[Retry, exponential backoff + jitter]
  R -->|max attempts| D[Dead letter + alert]
  D -->|after the fix| RP[Admin replay]
```

```mermaid
stateDiagram-v2
  [*] --> pending_payment
  pending_payment --> paid: payment succeeded
  pending_payment --> payment_failed: payment failed
  payment_failed --> paid: customer retried
  paid --> fulfilled: POS accepted
  paid --> refunded: refund
  fulfilled --> refunded: refund
```

![Payments webhook ingest canvas](docs/img/canvas-payments-ingest.png)

![Payments event processor canvas](docs/img/canvas-payments-processor.png)

**What is tested**

- Missing, forged and replayed signatures are rejected before anything is stored. Secrets can be rotated (comma separated list).
- Three simultaneous deliveries of the same event: one processed, two dropped at the inbox.
- POS returns 503 twice: the event is retried with backoff and succeeds on the third attempt. The POS gets the same `Idempotency-Key` each time, so it can never create a second order.
- POS down for good: after the maximum attempts the event is dead-lettered, a critical alert is raised, and the money is still recorded as paid. After the fix, one call to the replay endpoint finishes it.
- A refund that arrives before the payment is parked, retried, and applied once the payment is in: `paid > fulfilled > refunded`.
- 12 orders with every event delivered twice, all in parallel: 12 fulfilled, exactly one POS order each.
- `GET /webhook/payments/admin/health` (admin token) shows inbox and order counts, the oldest waiting event, dead letters and open alerts.

The POS is a mock with failure injection (`mock.pos_config`), so all of this runs locally.

---

## How it is built

```
db/            schema, business logic (SQL functions) and seed data
src/code/      JavaScript for the Code nodes, one file per node
src/workflows/ workflow definitions in JavaScript
workflows/     the generated n8n JSON (import these into any n8n)
scripts/       setup, workflow build, static checks, sample data generator
tests/         end-to-end tests against the running stack
```

**Workflows as code.** The JSON in `workflows/` is generated by `node scripts/build-workflows.mjs` from `src/`. The Code node JavaScript and the SQL live in real files that can be reviewed, diffed and tested, instead of in text boxes. Node ids are stable, so re-importing updates workflows in place.

**Why so much SQL?** Anything that has to be correct under concurrency (bookings, order states, idempotency, claiming work) is enforced by Postgres: constraints, transactions, `FOR UPDATE SKIP LOCKED`. n8n does what it is good at: webhooks, orchestration, integrations, retries and visibility. A workflow can be edited on the canvas without risking double bookings.

**Operations.** Every workflow reports failures to one error workflow, which logs to `ops.workflow_errors` and raises an alert. Sticky notes on each canvas explain the design for whoever maintains it next.

**Taking it to production** I would add queue mode with separate workers (Redis), external task runners, Postgres backups, n8n metrics into Prometheus/Grafana, and real alert channels (Slack, PagerDuty) in place of the alert table. `.github/workflows/ci.yml` runs on every pull request and on `main`: first the static checks (Code node syntax, and a guard that the generated JSON in `workflows/` still matches `src/`), then the same setup and test suite you run locally, with the test report kept as a build artifact.

## About

Nikola Radosavljević, software engineer in Belgrade. Six years of .NET, Angular and Azure (Microsoft Certified: Azure Developer Associate), currently working on event-driven microservices with Kafka and Cassandra. I build n8n automations that can be trusted with money, bookings and customer data.
