// Everything the model says is untrusted input until it has been through here.
//
// This step does not decide whether a tool call is allowed - that is the
// database's job - it only makes sure the workflow is handed something with the
// right shape, and that a malformed or oversized reply fails as a refusal
// rather than as a crash halfway through the run.
const MAX_TOOL_CALLS_PER_TURN = 4;

const item = $input.first();
const runId = $('Build LLM request').first().json.run_id;
const body = item.json.body ?? item.json;
const choice = body?.choices?.[0];

const out = { run_id: runId, content: null, tool_calls: [], parse_error: null };

if (!choice) {
  out.parse_error = 'no_choices_in_response';
  return [{ json: out }];
}

const message = choice.message || {};
out.content = typeof message.content === 'string' ? message.content.trim() || null : null;
out.finish_reason = choice.finish_reason ?? null;

const raw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
for (const call of raw.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
  const name = call?.function?.name ?? call?.name;
  if (typeof name !== 'string' || !name) continue;

  // A model can return arguments as a JSON string or as an object, and it can
  // return a string that is not JSON at all.
  let args = call?.function?.arguments ?? call?.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (e) {
      args = { __unparseable: String(args).slice(0, 500) };
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};

  out.tool_calls.push({
    // A tool call id is the idempotency key for anything the call does, so a
    // model that omits one gets a stable one derived from the run and position.
    id: String(call?.id || `run${runId}-auto-${out.tool_calls.length}`),
    name,
    args,
  });
}

if (!out.content && out.tool_calls.length === 0) out.parse_error = 'empty_reply';
return [{ json: out }];
