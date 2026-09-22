const body = $input.first().json.body || {};
const text = String(body.messages?.find((m) => m.role === 'user')?.content || '');

const lines = [];
if (/NYM 3x2\.5/i.test(text)) {
  lines.push(
    { code: null, description: 'NYM 3x2.5 cable', qty: 200, unit: 'm' },
    { code: null, description: 'B16 single pole breakers', qty: 30, unit: 'pcs' },
    { code: null, description: '600 by 600 LED panels, 40 watt, neutral white 4000K', qty: 18, unit: 'pcs' },
    { code: null, description: '4-pole residual current devices, 40 amp, 30mA', qty: 4, unit: 'pcs' },
    { code: null, description: 'surface IP44 sockets', qty: 6, unit: 'pcs' },
    { code: null, description: 'Surge arrester type 1 50kA', qty: 2, unit: 'pcs' },
  );
}

return [{
  json: {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `${body.model || 'unknown'}-mock`,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ lines }) } }],
    usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: 180, total_tokens: Math.ceil(text.length / 4) + 180 },
  },
}];
