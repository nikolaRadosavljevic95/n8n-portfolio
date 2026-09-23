// One item per tool call, so the Postgres node runs each one as its own
// statement and a refusal in the first does not hide the second.
//
// The reply is read from the parse step by name, not from $input: the node
// feeding this one is the Postgres node that recorded the model turn, so
// $json here is that insert's result, not the tool calls.
const reply = $('Parse LLM reply').first().json;

return (reply.tool_calls ?? []).map((call) => ({
  json: {
    run_id: reply.run_id,
    tool_call_id: call.id,
    tool: call.name,
    args: call.args,
  },
}));
