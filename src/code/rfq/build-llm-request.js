const prep = $input.first().json;

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'description', 'qty', 'unit'],
        properties: {
          code: { type: ['string', 'null'], description: 'Item or part code exactly as written, or null' },
          description: { type: 'string', description: 'Product description copied from the text, not rewritten' },
          qty: { type: ['number', 'null'], description: 'Requested quantity as a number, words converted to digits' },
          unit: { type: ['string', 'null'], description: 'Unit as written (m, pcs, roll...), or null' },
        },
      },
    },
  },
};

const system = [
  'You extract requested line items from a customer request for quotation.',
  'Only extract products the customer asks to be quoted. Ignore greetings, delivery notes and questions.',
  'Copy product descriptions as written. Do not correct, complete or translate them.',
  'Convert quantities written as words to digits. Use null when a code, quantity or unit is not stated.',
  'Never invent items that are not in the text.',
].join(' ');

return [{
  json: {
    ...prep,
    llm_request: {
      model: $env.LLM_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'rfq_lines', strict: true, schema } },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prep.source_text },
      ],
    },
  },
}];
