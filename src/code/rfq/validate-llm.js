const prep = $('Build LLM request').first().json;
const response = $input.first().json;

let parsed;
try {
  parsed = JSON.parse(response.choices?.[0]?.message?.content ?? '');
} catch (e) {
  throw new Error('The LLM did not return valid JSON for the RFQ lines');
}

const source = prep.source_text.toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
const tokens = (s) => String(s).toLowerCase().replace(/(\d),(\d)/g, '$1.$2').split(/[^a-z0-9.]+/).filter((t) => t.length >= 2);

const lines = [];
const rejected = [];
for (const l of parsed.lines || []) {
  const description = String(l.description || '').trim();
  const words = tokens(description);
  const grounded = words.length > 0 && words.filter((w) => source.includes(w)).length / words.length >= 0.6;
  if (!description || !grounded) {
    rejected.push({ description, reason: description ? 'NOT_FOUND_IN_SOURCE' : 'EMPTY_DESCRIPTION' });
    continue;
  }
  const qty = Number(l.qty);
  lines.push({
    line_no: lines.length + 1,
    code: l.code ? String(l.code).trim() : null,
    description,
    qty: Number.isFinite(qty) && qty > 0 ? qty : null,
    unit: l.unit ? String(l.unit).trim() : null,
  });
}

for (const r of rejected) {
  lines.push({ line_no: lines.length + 1, code: null, description: `[unverified LLM output] ${r.description}`.trim(), qty: null, unit: null });
}

return [{
  json: {
    customer_id: prep.customer_id,
    source_name: prep.source_name,
    source_sha256: prep.source_sha256,
    mode: prep.mode,
    parser: 'llm',
    lines,
    llm_model: response.model || null,
    llm_rejected: rejected.length,
  },
}];
