# Test report

Run: 2026-09-22T12:56:37.319Z  |  n8n 2.40.5  |  30 passed, 0 failed in 76.2s

| Demo | Test | Result | Time | Evidence |
|---|---|---|---|---|
| rfq | ERP table PDF is parsed, matched and priced | pass | 3383 ms | Q-2026-01001, 12/17 auto, net 2231.01 EUR, 3345 ms |
| rfq | Same PDF twice returns the same quote (idempotent) | pass | 555 ms |  |
| rfq | Excel download has Quote and Review sheets | pass | 260 ms | 21763 bytes |
| rfq | Email style bullet list is quoted fully automatically | pass | 355 ms | 341 ms |
| rfq | Free text RFQ without LLM goes to manual entry, nothing is guessed | pass | 342 ms |  |
| rfq | Resolving a review line recalculates totals and learns the customer code | pass | 93 ms |  |
| rfq | Next RFQ with the learned code is matched automatically | pass | 405 ms |  |
| rfq | Invalid input is rejected with a clear message | pass | 626 ms |  |
| rfq | Upload form is served | pass | 158 ms |  |
| voice | Requests without the shared secret are rejected | pass | 75 ms |  |
| voice | Availability: max 3 options, at least 60 min apart, inside working hours | pass | 124 ms | For Women's haircut (60 min, 45.00 EUR) I can offer Thursday 24 September at 12:00 with Ana, Thursday 24 September at 13:00 with Ana or Thursday 24 September at 14:00 with Ana. Which one works best? |
| voice | Booking creates the appointment and queues an SMS in the same transaction | pass | 326 ms | Booked: Women's haircut with Jelena on Thursday 24 September at 10:00. Your reference is 5960E9. You will get a text confirmation. |
| voice | Retry of the same tool call does not double book | pass | 202 ms |  |
| voice | 10 callers race for the same slot: exactly one wins, nine get alternatives | pass | 744 ms | winner 934201 |
| voice | Another caller cannot cancel your booking by guessing the reference | pass | 235 ms |  |
| voice | Owner can find, reschedule and cancel | pass | 598 ms | Done, I moved your Women's haircut to Thursday 24 September at 12:00. / Done, your booking on Thursday 24 September at 12:00 is cancelled. |
| voice | Retell payload works through the same adapter | pass | 94 ms |  |
| voice | End-of-call report updates call log and CRM, without double counting | pass | 2173 ms | outcomes: booked, enquiry_no_booking; follow-up task created |
| voice | SMS outbox is delivered by the dispatcher, failures are retried | pass | 8922 ms | 4 sent, unreachable number scheduled for retry |
| voice | Latency of the tool webhook (30 sequential calls) | pass | 2716 ms | p50 87 ms, p95 114 ms |
| payments | Missing, forged and replayed signatures are rejected | pass | 341 ms |  |
| payments | Valid event is acknowledged fast and the order is fulfilled in the POS | pass | 1535 ms | ack 94 ms, POS order POS-50001 |
| payments | Duplicate delivery is dropped at the inbox | pass | 1783 ms |  |
| payments | Flaky POS: two 503s, then success after exponential backoff | pass | 13609 ms | POS calls 503,503,201 |
| payments | POS down for good: event is dead-lettered and an alert is raised | pass | 19195 ms |  |
| payments | After the fix, replay processes the dead letter | pass | 1736 ms |  |
| payments | Refund that arrives before the payment is parked, then applied in order | pass | 8931 ms | trail: paid > fulfilled > refunded |
| payments | Failed card, then successful retry by the customer | pass | 1920 ms |  |
| payments | Burst: 12 orders, every event delivered twice, in parallel | pass | 3783 ms | 24 deliveries, 12 fulfilled once each in 3783 ms |
| payments | Health endpoint requires the admin token and reports state | pass | 131 ms | {"done":20} |

Metrics: rfq_pdf_ms = 3345, voice_p50_ms = 87, voice_p95_ms = 114, payments_ack_ms = 94

## LLM path (against the OpenAI-compatible mock, `bash scripts/test-llm-mock.sh`)

| Demo | Test | Result | Time | Evidence |
|---|---|---|---|---|
| llm | Free text RFQ is parsed by the LLM, invented items are rejected | pass | 2369 ms | 5/6 priced, invented line flagged |

