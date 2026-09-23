// The model has stopped calling tools. This shapes the reply the customer sees.
//
// It proposes a status; agent.finish_run() has the last word, because what
// actually happened is in the audit trail, not in what the model chose to say.
const parsed = $('Parse LLM reply').first().json;
const ctx = $('Load run context').first().json.ctx;

let status = 'answered';
let outcome = 'answered';
let reply = parsed.content;

if (parsed.parse_error) {
  status = 'escalated';
  outcome = `model_${parsed.parse_error}`;
  reply = 'Sorry, I could not deal with that automatically. A colleague will pick this up shortly.';
} else if (!reply) {
  status = 'escalated';
  outcome = 'no_reply_from_model';
  reply = 'A colleague will come back to you on this shortly.';
}

return [{ json: { run_id: ctx.run_id, status, outcome, reply } }];
