const crypto = require('crypto');

const item = $input.first();
const headers = item.json.headers || {};
const body = item.json.body || {};

const secret = String($env.VOICE_WEBHOOK_SECRET || '');
const provided = String(headers['x-vapi-secret'] || headers['x-voice-secret'] || '');
const authOk = secret.length > 0
  && provided.length === secret.length
  && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));

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
