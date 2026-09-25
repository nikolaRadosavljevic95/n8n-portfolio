# Demo video script (about 3 minutes)

Record the screen with Loom or OBS. Speak slowly, show real results, skip the intro slides.

## 0:00 Intro (15 s)
"Hi, I'm Nikola. These are three n8n systems I built to show how I work: an RFQ to quote pipeline, a backend for an AI phone receptionist, and payment webhooks feeding a POS. Everything you see is running locally and covered by tests."

## 0:15 RFQ to quote (70 s)
1. Open `http://localhost:5678/form/rfq`, log in as `sales` (password `RFQ_FORM_PASSWORD` from `.env`), pick Elektro-Mont, upload `samples/rfq-01-elektro-mont.pdf`.
2. Open the Excel that downloads. Quote sheet: "12 of 17 lines priced from the price list. Note how 250 metres of cable became 3 rings of 100 metres."
3. Review sheet: "Line 7 is the interesting one. The customer's part number says B16, the description says B10. A naive fuzzy match would quote the wrong breaker. Here it goes to review with both candidates."
4. Show the RFQ Engine canvas for 10 seconds: "The LLM only reads free text. Products and prices always come from the database."

## 1:25 AI receptionist (50 s)
1. Show the Voice canvas.
2. In a terminal run the race test only: `node tests/run-all.mjs voice` and point at the line "10 callers race for the same slot: exactly one wins".
3. "Voice platforms retry on timeouts, and two people call at once. The database makes a double booking impossible, and every tool call is idempotent. p95 latency is around 100 ms, which matters when someone is waiting on the line."

## 2:15 Payments (35 s)
1. Show the Payments processor canvas.
2. "Stripe-style signed webhooks, an inbox for duplicates, retries with backoff, dead letters with an alert, and a replay endpoint. The tests break the POS on purpose and check that no order is lost or shipped twice."

## 2:50 Close (10 s)
"Code and tests are on GitHub, link below. If your automation touches money, bookings or customer data, this is how I would build it."
