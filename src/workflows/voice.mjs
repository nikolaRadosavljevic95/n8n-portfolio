import { Workflow, add, code, nodes, PG } from '../lib/wf.mjs';

const AFTER_CALL_ID = 'PfVoiceAfterCall1';

function voiceTools() {
  const wf = new Workflow({ id: 'PfVoiceTools0001', name: 'Voice: Tool calls (Vapi / Retell)' });
  add(wf, 'POST /voice/vapi', nodes.webhook('POST', 'voice/vapi'), [0, 0]);
  add(wf, 'POST /voice/retell', nodes.webhook('POST', 'voice/retell', { rawBody: true }), [0, 200]);
  add(wf, 'Normalize provider payload', nodes.code(code('voice/normalize.js')), [240, 100]);
  add(wf, 'Authorized?', nodes.ifTrue('={{ $json.auth_ok }}'), [460, 100]);
  add(wf, 'Respond 401', nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [700, 260]);
  add(wf, 'Message type', nodes.switchOn('={{ $json.kind }}', ['tool-calls', 'end-of-call']), [700, 60]);
  add(wf, 'Split tool calls', nodes.code(code('voice/split-tool-calls.js')), [960, -80]);
  add(wf, 'Run tool (Postgres)', nodes.pg(
    'SELECT booking.handle_tool($1, $2, $3, $4, $5::jsonb, $6::jsonb) AS result;',
    '={{ [ $json.provider, $json.tool_call_id, $json.call_id, $json.tool, JSON.stringify($json.args ?? {}), JSON.stringify({ caller_phone: $json.caller_phone }) ] }}',
    { queryBatching: 'independently' },
  ), [1180, -80], { credentials: PG });
  add(wf, 'Shape provider response', nodes.code(code('voice/shape-response.js')), [1400, -80]);
  add(wf, 'Respond to voice platform', nodes.respondJson('={{ $json.body }}'), [1620, -80]);
  add(wf, 'Acknowledge report', nodes.respondJson('={{ { received: true } }}'), [960, 100]);
  add(wf, 'Record call (async)', nodes.execute(AFTER_CALL_ID, 'Voice: After-call & SMS outbox', false), [1180, 100]);
  add(wf, 'Respond ignored', nodes.respondJson('={{ { received: true, ignored: true } }}'), [960, 260]);

  wf.connect('POST /voice/vapi', 'Normalize provider payload');
  wf.connect('POST /voice/retell', 'Normalize provider payload');
  wf.connect('Normalize provider payload', 'Authorized?');
  wf.connect('Authorized?', 'Message type', 0);
  wf.connect('Authorized?', 'Respond 401', 1);
  wf.connect('Message type', 'Split tool calls', 0);
  wf.connect('Message type', 'Acknowledge report', 1);
  wf.connect('Message type', 'Respond ignored', 2);
  wf.chain('Split tool calls', 'Run tool (Postgres)', 'Shape provider response', 'Respond to voice platform');
  wf.connect('Acknowledge report', 'Record call (async)');

  wf.note(
    '## Backend for an AI phone receptionist\nVapi and Retell call these webhooks when the voice agent uses a tool: `check_availability`, `book_appointment`, `find_appointments`, `cancel_appointment`, `reschedule_appointment`.\n\nBoth providers go through one adapter, so the booking logic does not care which one you use. Vapi requests carry the shared secret (`x-vapi-secret`). Retell requests are verified by their `x-retell-signature` (HMAC of the raw body with the Retell API key, 5 minute window), because Retell cannot add headers to its call events. Anything else gets a 401.',
    [-40, -320], 520, 220, 7,
  );
  wf.note(
    '## Hot path: under 100 ms\nThe caller is waiting on the line, so the response path is only adapter, SQL, reply. Anything slow (CRM, SMS) happens after the reply or asynchronously.\n\n**Correctness lives in Postgres**\n- `EXCLUDE` constraint: two overlapping bookings for one stylist cannot exist, even under concurrent calls\n- Voice platforms retry on timeouts. The tool call id makes every call idempotent, so a retry never double books\n- Callers can only cancel or move their own bookings (matched by caller ID)',
    [920, -420], 560, 280, 5,
  );
  return wf;
}

function afterCall() {
  const wf = new Workflow({ id: AFTER_CALL_ID, name: 'Voice: After-call & SMS outbox' });

  add(wf, 'When called with a call report', nodes.subworkflowTrigger(), [0, 0]);
  add(wf, 'Record call & update CRM', nodes.pg(
    'SELECT booking.record_call($1::jsonb) AS result;',
    '={{ [ JSON.stringify($json.report) ] }}',
  ), [240, 0], { credentials: PG });
  wf.connect('When called with a call report', 'Record call & update CRM');

  wf.node('Every 20 seconds', 'n8n-nodes-base.scheduleTrigger', 1.4, {
    rule: { interval: [{ field: 'seconds', secondsInterval: 20 }] },
  }, [0, 320]);
  add(wf, 'Claim due SMS', nodes.pg('SELECT * FROM booking.claim_outbox(20);'), [240, 320], { credentials: PG });
  add(wf, 'Twilio configured?', nodes.ifTrue("={{ $env.SMS_PROVIDER === 'twilio' }}"), [460, 320]);
  wf.node('Send SMS (Twilio)', 'n8n-nodes-base.twilio', 1, {
    resource: 'sms',
    operation: 'send',
    from: '={{ $env.TWILIO_FROM }}',
    to: '={{ $json.recipient }}',
    message: '={{ $json.message }}',
    options: {},
  }, [700, 220], { onError: 'continueRegularOutput', credentials: { twilioApi: { id: 'twilioCred000001', name: 'Twilio' } } });
  add(wf, 'Twilio result', nodes.code(code('voice/twilio-result.js')), [920, 220]);
  add(wf, 'Mock SMS gateway', nodes.code(code('voice/mock-sms.js')), [700, 420]);
  add(wf, 'Mark sent or schedule retry', nodes.pg(
    'SELECT booking.finish_outbox($1::bigint, $2::boolean, $3, $4) AS result;',
    '={{ [ $json.id, $json.ok, $json.provider_ref, $json.error ] }}',
    { queryBatching: 'independently' },
  ), [1160, 320], { credentials: PG });

  wf.chain('Every 20 seconds', 'Claim due SMS', 'Twilio configured?');
  wf.connect('Twilio configured?', 'Send SMS (Twilio)', 0);
  wf.connect('Twilio configured?', 'Mock SMS gateway', 1);
  wf.chain('Send SMS (Twilio)', 'Twilio result', 'Mark sent or schedule retry');
  wf.connect('Mock SMS gateway', 'Mark sent or schedule retry');

  wf.note(
    '## After the call\nThe outcome is derived from what actually happened (tool calls stored in the DB), not from the LLM summary: booked, rescheduled, cancelled, enquiry without booking, no conversation.\n\nThe caller is upserted into the CRM (dedupe by E.164 phone number). An enquiry without a booking creates a follow-up task for the front desk.\n\nSwap the SQL CRM for HubSpot / Pipedrive by replacing one node.',
    [-40, -300], 520, 250, 7,
  );
  wf.note(
    '## Transactional outbox for SMS\nConfirmations are written in the same DB transaction as the booking, so a booking never exists without its SMS and vice versa.\n\nThis dispatcher claims due messages with `FOR UPDATE SKIP LOCKED` (safe with several n8n workers), sends them, and retries with exponential backoff. After 5 failures an alert is raised.\n\nSet `SMS_PROVIDER=twilio` to use the Twilio branch, otherwise a mock gateway is used.',
    [440, 560], 560, 250, 6,
  );
  return wf;
}

export default function voiceWorkflows() {
  return [afterCall(), voiceTools()];
}
