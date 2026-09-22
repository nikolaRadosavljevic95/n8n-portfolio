const calls = $('Split tool calls').all().map((i) => i.json);
const results = $input.all().map((i, idx) => ({ call: calls[idx], result: i.json.result }));

if (calls[0]?.provider === 'vapi') {
  return [{
    json: {
      body: {
        results: results.map((r) => ({ toolCallId: r.call.tool_call_id, result: JSON.stringify(r.result) })),
      },
    },
  }];
}

return [{ json: { body: results[0]?.result ?? { status: 'error', message: 'No tool call in request' } } }];
