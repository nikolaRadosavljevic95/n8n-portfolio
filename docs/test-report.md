# Test report

Run: 2026-09-25T08:38:46.118Z  |  n8n 2.40.5  |  47 passed, 0 failed in 93.5s

| Demo | Test | Result | Time | Evidence |
|---|---|---|---|---|
| rfq | ERP table PDF is parsed, matched and priced | pass | 1371 ms | Q-2026-01001, 12/17 auto, net 2231.01 EUR, 1311 ms |
| rfq | Same PDF twice returns the same quote (idempotent) | pass | 572 ms |  |
| rfq | Excel download has Quote and Review sheets | pass | 242 ms | 21763 bytes |
| rfq | Email style bullet list is quoted fully automatically | pass | 410 ms | 409 ms |
| rfq | Free text RFQ without LLM goes to manual entry, nothing is guessed | pass | 332 ms |  |
| rfq | Resolving a review line recalculates totals and learns the customer code | pass | 96 ms |  |
| rfq | Next RFQ with the learned code is matched automatically | pass | 320 ms |  |
| rfq | Invalid input is rejected with a clear message | pass | 600 ms |  |
| rfq | Upload form is served to a logged-in user | pass | 221 ms |  |
| rfq | API and form refuse requests without credentials | pass | 664 ms | 3 endpoints x (no token, wrong token) = 401, form = 401 |
| voice | Requests without the shared secret are rejected | pass | 54 ms |  |
| voice | Availability: max 3 options, at least 60 min apart, inside working hours | pass | 130 ms | For Women's haircut (60 min, 45.00 EUR) I can offer Tuesday 29 September at 12:00 with Ana, Tuesday 29 September at 13:00 with Ana or Tuesday 29 September at 14:00 with Ana. Which one works best? |
| voice | Booking creates the appointment and queues an SMS in the same transaction | pass | 227 ms | Booked: Women's haircut with Jelena on Tuesday 29 September at 10:00. Your reference is FB95DE. You will get a text confirmation. |
| voice | Retry of the same tool call does not double book | pass | 142 ms |  |
| voice | 10 callers race for the same slot: exactly one wins, nine get alternatives | pass | 700 ms | winner 03C86A |
| voice | Another caller cannot cancel your booking by guessing the reference | pass | 148 ms |  |
| voice | Owner can find, reschedule and cancel | pass | 432 ms | Done, I moved your Women's haircut to Tuesday 29 September at 12:00. / Done, your booking on Tuesday 29 September at 12:00 is cancelled. |
| voice | Retell payload works through the same adapter | pass | 66 ms |  |
| voice | End-of-call report updates call log and CRM, without double counting | pass | 2047 ms | outcomes: booked, enquiry_no_booking; follow-up task created |
| voice | SMS outbox is delivered by the dispatcher, failures are retried | pass | 18892 ms | 4 sent, unreachable number scheduled for retry |
| voice | Latency of the tool webhook (30 sequential calls) | pass | 2305 ms | p50 73 ms, p95 110 ms |
| payments | Missing, forged and replayed signatures are rejected | pass | 276 ms |  |
| payments | Valid event is acknowledged fast and the order is fulfilled in the POS | pass | 1309 ms | ack 61 ms, POS order POS-50001 |
| payments | Duplicate delivery is dropped at the inbox | pass | 431 ms |  |
| payments | Flaky POS: two 503s, then success after exponential backoff | pass | 15770 ms | POS calls 503,503,201 |
| payments | POS down for good: event is dead-lettered and an alert is raised | pass | 20023 ms |  |
| payments | After the fix, replay processes the dead letter | pass | 1508 ms |  |
| payments | Refund that arrives before the payment is parked, then applied in order | pass | 8109 ms | trail: paid > fulfilled > refunded |
| payments | Failed card, then successful retry by the customer | pass | 1582 ms |  |
| payments | Burst: 12 orders, every event delivered twice, in parallel | pass | 3555 ms | 24 deliveries, 12 fulfilled once each in 3555 ms |
| payments | Health endpoint requires the admin token and reports state | pass | 115 ms | {"done":20} |
| agent | Prompt injection cannot reach another customer’s order | pass | 724 ms | model tried issue_refund, SQL answered not_found, 0 cents moved |
| agent | A small refund is made on the spot | pass | 819 ms | 3 steps, 34.90 EUR refunded |
| agent | A refund above the limit waits for a person | pass | 552 ms | held 129.00 EUR for a human, run 3 |
| agent | Approving releases the money exactly once | pass | 585 ms | approved twice, refunded once, attributed to the approver |
| agent | A rejected approval moves no money | pass | 862 ms | rejected, 0 cents moved, run escalated |
| agent | A refund outside the return window is refused, with the reason | pass | 740 ms | outside_return_window |
| agent | Cancel before dispatch works, after dispatch is refused | pass | 859 ms | ORD-2043 cancelled, ORD-2046 refused (2 steps) |
| agent | Policy answers come from the database, not from the model | pass | 761 ms | window changed in config, answer followed |
| agent | Asking for a person hands over instead of guessing | pass | 340 ms | escalated_to_human |
| agent | A model that will not stop is cut off by the step budget | pass | 777 ms | stopped after 6 of 6 steps |
| agent | A retried message is not acted on twice | pass | 620 ms | run 1 answered twice, refunded once |
| agent | Five conversations racing for the same refund: the order is refunded once | pass | 1742 ms | 5 parallel runs, 1 refund of 4000 cents |
| agent | Unknown tools and bad arguments are refused and recorded | pass | 346 ms | unknown_tool + missing_order_id, both audited |
| agent | Every run can be replayed from the audit trail | pass | 196 ms | run 5: 5 steps replayed |
| agent | The webhook rejects a bad token and bad input | pass | 295 ms | 401 / 401 / 400 / 422 |
| agent | Health shows what the agent did and what it was refused | pass | 59 ms | {"count":1,"by_agent":1,"total_cents":4000} |

Metrics: rfq_pdf_ms = 1311, voice_p50_ms = 73, voice_p95_ms = 110, payments_ack_ms = 61, agent_run_p50_ms = 328, agent_run_p95_ms = 696

## LLM path (against the OpenAI-compatible mock, `bash scripts/test-llm-mock.sh`)

| Demo | Test | Result | Time | Evidence |
|---|---|---|---|---|
| llm | Free text RFQ is parsed by the LLM, invented items are rejected | pass | 1598 ms | 5/6 priced, invented line flagged |
