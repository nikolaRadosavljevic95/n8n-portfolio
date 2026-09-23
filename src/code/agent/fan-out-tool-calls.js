// One item per tool call, so the Postgres node runs each one as its own
// statement and a refusal in the first does not hide the second.
const reply = $input.first().json;

return reply.tool_calls.map((call) => ({
  json: {
    run_id: reply.run_id,
    tool_call_id: call.id,
    tool: call.name,
    args: call.args,
  },
}));
