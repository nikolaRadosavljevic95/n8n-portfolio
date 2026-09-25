const crypto = require('crypto');

const item = $input.first();
const headers = item.json.headers || {};

// The Retell webhook keeps the raw body (needed for its signature); parse it when n8n did not.
const raw = item.binary?.data ? (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8') : null;
let body = item.json.body && Object.keys(item.json.body).length ? item.json.body : {};
if (raw && !Object.keys(body).length) {
  try { body = JSON.parse(raw); } catch (e) { body = {}; }
}

const sameSecret = (a, b) => a.length > 0 && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Vapi (and anything we configure ourselves) sends the shared secret as a header.
const secret = String($env.VOICE_WEBHOOK_SECRET || '');
const provided = String(headers['x-vapi-secret'] || headers['x-voice-secret'] || '');
const secretOk = sameSecret(secret, provided);

// Retell cannot add headers to its call events; it signs every request instead:
// x-retell-signature: v=<timestamp ms>,d=hex(HMAC-SHA256(Retell API key, raw body + timestamp)),
// valid for 5 minutes. Same scheme as Retell.verify() in the official SDK.
function retellSignatureOk() {
  const key = String($env.RETELL_API_KEY || '');
  const m = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(String(headers['x-retell-signature'] || ''));
  if (!key || !m || raw === null) return false;
  if (Math.abs(Date.now() - Number(m[1])) > 5 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', key).update(raw + m[1]).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(m[2].toLowerCase()), Buffer.from(expected));
}

const authOk = secretOk || retellSignatureOk();

const parseArgs = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return raw;
};
const toIso = (v) => (v === undefined || v === null ? null : typeof v === 'number' ? new Date(v).toISOString() : v);

const out = { provider: null, kind: 'ignored', auth_ok: authOk, call_id: null, caller_phone: null, tool_calls: [], report: null };

if (body.message && typeof body.message === 'object') {
  const m = body.message;
  out.provider = 'vapi';
  out.call_id = m.call?.id ?? null;
  out.caller_phone = m.customer?.number ?? m.call?.customer?.number ?? null;
  if (m.type === 'tool-calls') {
    out.kind = 'tool-calls';
    const list = m.toolCallList ?? (m.toolWithToolCallList || []).map((t) => t.toolCall);
    out.tool_calls = (list || []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name,
      args: parseArgs(tc.function?.arguments ?? tc.arguments),
    }));
  } else if (m.type === 'end-of-call-report') {
    out.kind = 'end-of-call';
    out.report = {
      provider: 'vapi',
      call_id: out.call_id,
      caller_phone: out.caller_phone,
      started_at: toIso(m.startedAt ?? m.call?.startedAt),
      ended_at: toIso(m.endedAt ?? m.call?.endedAt),
      ended_reason: m.endedReason ?? null,
      summary: m.analysis?.summary ?? m.summary ?? null,
      transcript: m.artifact?.transcript ?? m.transcript ?? null,
      recording_url: m.artifact?.recordingUrl ?? m.recordingUrl ?? null,
    };
  }
} else if (body.name && body.call) {
  out.provider = 'retell';
  out.kind = 'tool-calls';
  out.call_id = body.call.call_id ?? null;
  out.caller_phone = body.call.from_number ?? null;
  const args = parseArgs(body.args);
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 16);
  out.tool_calls = [{ id: `retell:${out.call_id}:${body.name}:${fingerprint}`, name: body.name, args }];
} else if (body.event && body.call) {
  out.provider = 'retell';
  out.call_id = body.call.call_id ?? null;
  out.caller_phone = body.call.from_number ?? null;
  if (body.event === 'call_analyzed' || body.event === 'call_ended') {
    out.kind = 'end-of-call';
    out.report = {
      provider: 'retell',
      call_id: out.call_id,
      caller_phone: out.caller_phone,
      started_at: toIso(body.call.start_timestamp),
      ended_at: toIso(body.call.end_timestamp),
      ended_reason: body.call.disconnection_reason ?? null,
      summary: body.call.call_analysis?.call_summary ?? null,
      transcript: body.call.transcript ?? null,
      recording_url: body.call.recording_url ?? null,
    };
  }
}

return [{ json: out }];
