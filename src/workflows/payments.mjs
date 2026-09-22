import { Workflow, add, code, nodes, PG } from '../lib/wf.mjs';

const PROCESSOR_ID = 'PfPayProcess0001';

function ingest() {
  const wf = new Workflow({ id: 'PfPayIngest00001', name: 'Payments: Webhook ingest' });
  add(wf, 'POST /payments/webhook', nodes.webhook('POST', 'payments/webhook', { rawBody: true }), [0, 0]);
  add(wf, 'Verify signature', nodes.code(code('payments/verify-signature.js')), [240, 0]);
  add(wf, 'Signature valid?', nodes.ifTrue('={{ $json.valid }}'), [460, 0]);
  add(wf, 'Respond 400', nodes.respondJson("={{ { error: $json.reason } }}", 400), [700, 140]);
  add(wf, 'Store in inbox (dedupe)', nodes.pg(
    'SELECT pay.ingest($1, $2, $3::jsonb) AS r;',
    '={{ [ $json.event_id, $json.event_type, JSON.stringify($json.payload) ] }}',
  ), [700, -80], { credentials: PG });
  add(wf, 'Respond 200 fast', nodes.respondJson('={{ { received: true, duplicate: !$json.r.is_new } }}'), [940, -80]);
  add(wf, 'New event?', nodes.ifTrue('={{ $json.r.is_new }}'), [1160, -80]);
  add(wf, 'Process now (async)', [
    'n8n-nodes-base.executeWorkflow', 1.3,
    {
      workflowId: { __rl: true, value: PROCESSOR_ID, mode: 'list', cachedResultName: 'Payments: Event processor' },
      workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
      mode: 'once',
      options: { waitForSubWorkflow: false },
    },
  ], [1640, -160]);
  add(wf, 'Event id only', nodes.code("return [{ json: { event_id: $('Verify signature').first().json.event_id } }];"), [1400, -160]);

  wf.chain('POST /payments/webhook', 'Verify signature', 'Signature valid?');
  wf.connect('Signature valid?', 'Store in inbox (dedupe)', 0);
  wf.connect('Signature valid?', 'Respond 400', 1);
  wf.chain('Store in inbox (dedupe)', 'Respond 200 fast', 'New event?');
  wf.connect('New event?', 'Event id only', 0);
  wf.connect('Event id only', 'Process now (async)');

  wf.note(
    '## Payment webhooks, done properly\n1. **Verify** the Stripe-style `t=...,v1=...` HMAC over the raw body, with a 5 minute replay window and support for rotating secrets (comma separated).\n2. **Store** the event in an inbox table. `event_id` is unique, so provider retries and duplicates are dropped here.\n3. **Acknowledge** within milliseconds, before any business logic. Slow processing is the number one reason providers retry and disable endpoints.\n4. **Process** asynchronously. If that fails, the sweeper picks it up.',
    [-40, -400], 560, 280, 7,
  );
  return wf;
}

function processor() {
  const wf = new Workflow({ id: PROCESSOR_ID, name: 'Payments: Event processor' });
  add(wf, 'When called for one event', nodes.subworkflowTrigger(), [0, 0]);
  wf.node('Sweep every 10 seconds', 'n8n-nodes-base.scheduleTrigger', 1.4, {
    rule: { interval: [{ field: 'seconds', secondsInterval: 10 }] },
  }, [0, 200]);
  add(wf, 'Claim due events', nodes.pg(
    'SELECT * FROM pay.claim($1, 25);',
    '={{ [ $json.event_id ?? null ] }}',
  ), [240, 100], { credentials: PG });
  add(wf, 'Apply state transition', nodes.pg(
    'SELECT pay.apply($1::bigint) AS r;',
    '={{ [ $json.id ] }}',
    { queryBatching: 'independently' },
  ), [460, 100], { credentials: PG });
  add(wf, 'Next step', nodes.switchOn('={{ $json.r.action }}', ['fulfill', 'retry', 'complete'], false), [700, 100]);
  wf.node('POS: create order', 'n8n-nodes-base.httpRequest', 4.5, {
    method: 'POST',
    url: '={{ $env.MOCK_POS_URL }}',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Idempotency-Key', value: '={{ $json.r.event_id }}' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ order_id: $json.r.order_id, amount_cents: $json.r.amount_cents, currency: $json.r.currency, customer_email: $json.r.customer_email }) }}',
    options: { timeout: 5000, response: { response: { fullResponse: true, neverError: true } } },
  }, [960, -40], { onError: 'continueRegularOutput' });
  add(wf, 'POS accepted?', nodes.ifTrue('={{ [200, 201].includes($json.statusCode) }}'), [1180, -40]);
  add(wf, 'Mark fulfilled', nodes.pg(
    'SELECT pay.fulfilled($1::bigint, $2, $3) AS r;',
    "={{ [ $('Apply state transition').item.json.r.inbox_id, $('Apply state transition').item.json.r.order_id, $json.body.pos_order_id ] }}",
    { queryBatching: 'independently' },
  ), [1420, -120], { credentials: PG });
  add(wf, 'Schedule retry or dead-letter', nodes.pg(
    'SELECT pay.fail($1::bigint, $2) AS r;',
    "={{ [ $('Apply state transition').item.json.r.inbox_id, $json.r?.outcome ? 'Waiting: ' + $json.r.outcome : 'POS error: ' + ($json.statusCode ?? 'no response') + ' ' + JSON.stringify($json.body ?? $json.error ?? '').slice(0, 300) ] }}",
    { queryBatching: 'independently' },
  ), [1420, 120], { credentials: PG });
  add(wf, 'Dead-lettered?', nodes.ifTrue("={{ $json.r.status === 'dead' }}"), [1660, 120]);
  wf.node('Page on-call (dead letter)', 'n8n-nodes-base.noOp', 1, {}, [1900, 60]);
  add(wf, 'Complete event', nodes.pg(
    'SELECT pay.complete($1::bigint, $2) AS r;',
    '={{ [ $json.r.inbox_id, $json.r.outcome ] }}',
    { queryBatching: 'independently' },
  ), [960, 300], { credentials: PG });

  wf.connect('When called for one event', 'Claim due events');
  wf.connect('Sweep every 10 seconds', 'Claim due events');
  wf.chain('Claim due events', 'Apply state transition', 'Next step');
  wf.connect('Next step', 'POS: create order', 0);
  wf.connect('Next step', 'Schedule retry or dead-letter', 1);
  wf.connect('Next step', 'Complete event', 2);
  wf.connect('POS: create order', 'POS accepted?');
  wf.connect('POS accepted?', 'Mark fulfilled', 0);
  wf.connect('POS accepted?', 'Schedule retry or dead-letter', 1);
  wf.connect('Schedule retry or dead-letter', 'Dead-lettered?');
  wf.connect('Dead-lettered?', 'Page on-call (dead letter)', 0);

  wf.note(
    '## Processor: at-least-once, effectively once\n- Events are claimed with `FOR UPDATE SKIP LOCKED` and a 2 minute lease, so several n8n workers never process the same event, and a crashed execution is picked up again after the lease expires.\n- The order state machine lives in `pay.apply()`: duplicates are no-ops, a refund that arrives before the payment is parked and retried (`out_of_order`).\n- The POS call carries `Idempotency-Key = event_id`, so a retry after a timeout cannot create a second POS order.',
    [-40, -360], 600, 240, 7,
  );
  wf.note(
    '## Retries and dead letters\nFailures back off exponentially with jitter (30s, 60s, 120s... capped at 1h). After `max_attempts` the event is dead-lettered and a critical alert is raised in `ops.alerts`.\n\nReplace the NoOp with Slack / PagerDuty. Fix the cause, then `POST /webhook/payments/admin/replay`.',
    [1380, 340], 520, 200, 3,
  );
  return wf;
}

function admin() {
  const wf = new Workflow({ id: 'PfPayAdmin000001', name: 'Payments: Admin API' });
  add(wf, 'GET /payments/admin/health', nodes.webhook('GET', 'payments/admin/health'), [0, 0]);
  add(wf, 'Authorize (health)', nodes.code(code('payments/authorize-admin.js')), [240, 0]);
  add(wf, 'Admin token ok?', nodes.ifTrue('={{ $json.authorized }}'), [460, 0]);
  add(wf, 'Health snapshot', nodes.pg('SELECT pay.health() AS h;'), [700, -80], { credentials: PG });
  add(wf, 'Respond health', nodes.respondJson('={{ $json.h }}'), [940, -80]);
  add(wf, 'Respond 401', nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [700, 80]);
  wf.chain('GET /payments/admin/health', 'Authorize (health)', 'Admin token ok?');
  wf.connect('Admin token ok?', 'Health snapshot', 0);
  wf.connect('Admin token ok?', 'Respond 401', 1);
  wf.connect('Health snapshot', 'Respond health');

  add(wf, 'POST /payments/admin/replay', nodes.webhook('POST', 'payments/admin/replay'), [0, 320]);
  add(wf, 'Authorize (replay)', nodes.code(code('payments/authorize-admin.js')), [240, 320]);
  add(wf, 'Admin token ok? ', nodes.ifTrue('={{ $json.authorized }}'), [460, 320]);
  add(wf, 'Requeue event', nodes.pg(
    'SELECT pay.replay($1) AS r;',
    "={{ [ String($json.body?.event_id ?? '') ] }}",
  ), [700, 240], { credentials: PG, alwaysOutputData: true });
  add(wf, 'Requeued?', nodes.ifTrue('={{ !!$json.r }}'), [940, 240]);
  add(wf, 'Respond 202', nodes.respondJson('={{ { requeued: $json.r.event_id } }}', 202), [1180, 160]);
  add(wf, 'Event id for processor', nodes.code('return [{ json: { event_id: $json.r.event_id } }];'), [1420, 160]);
  add(wf, 'Process now (async)', nodes.execute(PROCESSOR_ID, 'Payments: Event processor', false), [1660, 160]);
  add(wf, 'Respond 404', nodes.respondJson("={{ { error: 'event_not_found_or_not_dead' } }}", 404), [1180, 320]);
  add(wf, 'Respond 401 ', nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [700, 420]);
  wf.chain('POST /payments/admin/replay', 'Authorize (replay)', 'Admin token ok? ');
  wf.connect('Admin token ok? ', 'Requeue event', 0);
  wf.connect('Admin token ok? ', 'Respond 401 ', 1);
  wf.connect('Requeue event', 'Requeued?');
  wf.connect('Requeued?', 'Respond 202', 0);
  wf.connect('Requeued?', 'Respond 404', 1);
  wf.chain('Respond 202', 'Event id for processor', 'Process now (async)');

  wf.note(
    '## Ops endpoints (header `x-admin-token`)\n`GET /webhook/payments/admin/health`: inbox and order counts by status, oldest waiting event, dead letters, open alerts. Point Uptime Kuma or Grafana at it.\n\n`POST /webhook/payments/admin/replay` `{ event_id }`: puts a dead-lettered event back in the queue and processes it right away.',
    [-40, -300], 540, 240, 7,
  );
  return wf;
}

function mockPos() {
  const wf = new Workflow({ id: 'PfMockPos0000001', name: 'Mock: POS API' });
  add(wf, 'POST /mock/pos/orders', nodes.webhook('POST', 'mock/pos/orders'), [0, 0]);
  add(wf, 'Simulate POS', nodes.pg(
    'SELECT mock.pos_handle($1, $2) AS r;',
    "={{ [ $json.headers['idempotency-key'] ?? '', $json.body?.order_id ?? '' ] }}",
  ), [240, 0], { credentials: PG });
  add(wf, 'Respond', nodes.respondJson('={{ $json.r.body }}', '={{ $json.r.http_status }}'), [480, 0]);
  wf.chain('POST /mock/pos/orders', 'Simulate POS', 'Respond');
  wf.note(
    '## Stand-in for a real POS / ERP\nHonours `Idempotency-Key` like Stripe or Square do. Failure injection via `mock.pos_config`: fail the first N calls per key, or always fail for given orders. The tests use it to prove retries, backoff and dead letters.',
    [-40, -240], 460, 200, 7,
  );
  return wf;
}

function mockLlm() {
  const wf = new Workflow({ id: 'PfMockLlm0000001', name: 'Mock: OpenAI-compatible LLM' });
  add(wf, 'POST /mock/llm/chat/completions', nodes.webhook('POST', 'mock/llm/chat/completions'), [0, 0]);
  add(wf, 'Canned completion', nodes.code(code('mock/llm-completion.js')), [240, 0]);
  add(wf, 'Respond', nodes.respondJson('={{ $json }}'), [480, 0]);
  wf.chain('POST /mock/llm/chat/completions', 'Canned completion', 'Respond');
  wf.note(
    '## Test double for the LLM step\nSpeaks the OpenAI chat completions format. Returns the lines from the free text sample RFQ plus one invented item, so the tests can prove that the grounding check rejects hallucinated lines.\n\nPoint `LLM_BASE_URL` at `http://localhost:5678/webhook/mock/llm` to use it.',
    [-40, -240], 460, 200, 7,
  );
  return wf;
}

export default function paymentWorkflows() {
  return [mockPos(), mockLlm(), processor(), ingest(), admin()];
}
