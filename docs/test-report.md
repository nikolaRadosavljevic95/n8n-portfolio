# Test report

Run: 2026-09-24T22:15:26.100Z  |  n8n 2.40.5  |  46 passed, 0 failed in 75.5s

| Demo | Test | Result | Time | Evidence |
|---|---|---|---|---|
| rfq | ERP table PDF is parsed, matched and priced | pass | 1209 ms | Q-2026-01001, 12/17 auto, net 2231.01 EUR, 1156 ms |
| rfq | Same PDF twice returns the same quote (idempotent) | pass | 536 ms |  |
| rfq | Excel download has Quote and Review sheets | pass | 244 ms | 21763 bytes |
| rfq | Email style bullet list is quoted fully automatically | pass | 456 ms | 455 ms |
| rfq | Free text RFQ without LLM goes to manual entry, nothing is guessed | pass | 390 ms |  |
| rfq | Resolving a review line recalculates totals and learns the customer code | pass | 80 ms |  |
| rfq | Next RFQ with the learned code is matched automatically | pass | 349 ms |  |
| rfq | Invalid input is rejected with a clear message | pass | 712 ms |  |
| rfq | Upload form is served | pass | 148 ms |  |
| voice | Requests without the shared secret are rejected | pass | 59 ms |  |
| voice | Availability: max 3 options, at least 60 min apart, inside working hours | pass | 147 ms | For Women's haircut (60 min, 45.00 EUR) I can offer Tuesday 29 September at 12:00 with Ana, Tuesday 29 September at 13:00 with Ana or Tuesday 29 September at 14:00 with Ana. Which one works best? |
| voice | Booking creates the appointment and queues an SMS in the same transaction | pass | 255 ms | Booked: Women's haircut with Jelena on Tuesday 29 September at 10:00. Your reference is F3C489. You will get a text confirmation. |
| voice | Retry of the same tool call does not double book | pass | 159 ms |  |
| voice | 10 callers race for the same slot: exactly one wins, nine get alternatives | pass | 789 ms | winner 4FFA0A |
| voice | Another caller cannot cancel your booking by guessing the reference | pass | 150 ms |  |
| voice | Owner can find, reschedule and cancel | pass | 489 ms | Done, I moved your Women's haircut to Tuesday 29 September at 12:00. / Done, your booking on Tuesday 29 September at 12:00 is cancelled. |
| voice | Retell payload works through the same adapter | pass | 67 ms |  |
| voice | End-of-call report updates call log and CRM, without double counting | pass | 1950 ms | outcomes: booked, enquiry_no_booking; follow-up task created |
| voice | SMS outbox is delivered by the dispatcher, failures are retried | pass | 2254 ms | 4 sent, unreachable number scheduled for retry |
| voice | Latency of the tool webhook (30 sequential calls) | pass | 2160 ms | p50 68 ms, p95 113 ms |
| payments | Missing, forged and replayed signatures are rejected | pass | 249 ms |  |
| payments | Valid event is acknowledged fast and the order is fulfilled in the POS | pass | 1329 ms | ack 57 ms, POS order POS-50001 |
| payments | Duplicate delivery is dropped at the inbox | pass | 1559 ms |  |
| payments | Flaky POS: two 503s, then success after exponential backoff | pass | 14783 ms | POS calls 503,503,201 |
| payments | POS down for good: event is dead-lettered and an alert is raised | pass | 19082 ms |  |
| payments | After the fix, replay processes the dead letter | pass | 1512 ms |  |
| payments | Refund that arrives before the payment is parked, then applied in order | pass | 8145 ms | trail: paid > fulfilled > refunded |
| payments | Failed card, then successful retry by the customer | pass | 1590 ms |  |
| payments | Burst: 12 orders, every event delivered twice, in parallel | pass | 3610 ms | 24 deliveries, 12 fulfilled once each in 3609 ms |
| payments | Health endpoint requires the admin token and reports state | pass | 155 ms | {"done":20} |
| agent | Prompt injection cannot reach another customer’s order | pass | 707 ms | model tried issue_refund, SQL answered not_found, 0 cents moved |
| agent | A small refund is made on the spot | pass | 809 ms | 3 steps, 34.90 EUR refunded |
| agent | A refund above the limit waits for a person | pass | 596 ms | held 129.00 EUR for a human, run 3 |
| agent | Approving releases the money exactly once | pass | 553 ms | approved twice, refunded once, attributed to the approver |
| agent | A rejected approval moves no money | pass | 981 ms | rejected, 0 cents moved, run escalated |
| agent | A refund outside the return window is refused, with the reason | pass | 719 ms | outside_return_window |
| agent | Cancel before dispatch works, after dispatch is refused | pass | 873 ms | ORD-2043 cancelled, ORD-2046 refused (2 steps) |
| agent | Policy answers come from the database, not from the model | pass | 700 ms | window changed in config, answer followed |
| agent | Asking for a person hands over instead of guessing | pass | 336 ms | escalated_to_human |
| agent | A model that will not stop is cut off by the step budget | pass | 760 ms | stopped after 6 of 6 steps |
| agent | A retried message is not acted on twice | pass | 622 ms | run 1 answered twice, refunded once |
| agent | Five conversations racing for the same refund: the order is refunded once | pass | 1760 ms | 5 parallel runs, 1 refund of 4000 cents |
| agent | Unknown tools and bad arguments are refused and recorded | pass | 369 ms | unknown_tool + missing_order_id, both audited |
| agent | Every run can be replayed from the audit trail | pass | 245 ms | run 5: 5 steps replayed |
| agent | The webhook rejects a bad token and bad input | pass | 274 ms | 401 / 401 / 400 / 422 |
| agent | Health shows what the agent did and what it was refused | pass | 53 ms | {"count":1,"by_agent":1,"total_cents":4000} |

Metrics: rfq_pdf_ms = 1156, voice_p50_ms = 68, voice_p95_ms = 113, payments_ack_ms = 57, agent_run_p50_ms = 353, agent_run_p95_ms = 679

## LLM path (against the OpenAI-compatible mock, `bash scripts/test-llm-mock.sh`)

| Demo | Test | Result | Time | Evidence |
|---|---|---|---|---|
| llm | Free text RFQ is parsed by the LLM, invented items are rejected | pass | 1337 ms | 5/6 priced, invented line flagged |
