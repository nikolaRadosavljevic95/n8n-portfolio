const n = $input.first().json;
const calls = n.tool_calls.length ? n.tool_calls : [{ id: null, name: '__none__', args: {} }];

return calls.map((tc) => ({
  json: {
    provider: n.provider,
    call_id: n.call_id,
    caller_phone: n.caller_phone,
    tool_call_id: tc.id,
    tool: tc.name,
    args: tc.args || {},
  },
}));
