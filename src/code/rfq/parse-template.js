const prep = $('Prepare input').first().json;
const text = String($input.first().json.text || '');
const rows = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

const UNIT = '(?:pcs|pc|kom|ea|each|x|m|mtr|mtrs|meters?|metres?|lm|rolls?|rings?|coils?|reels?|packs?|pk|pkg|box(?:es)?|sets?|nos)';
const TABLE_ROW = new RegExp(`^(\\d{1,3})\\s+(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s+(${UNIT})\\.?$`, 'i');
const BULLET_ROW = new RegExp(`^(?:[-\\u2022*\\u2013]|\\d{1,3}[.)])\\s*(\\d+(?:[.,]\\d+)?)\\s*(${UNIT})?\\b\\.?\\s*(.+)$`, 'i');
const HEADER_WORDS = ['pos', 'item', 'code', 'description', 'qty', 'quantity', 'unit', 'uom', 'article'];

const toNumber = (s) => Number(String(s).replace(',', '.'));
const looksLikeCode = (token) => (token.match(/\d/g) || []).length >= 3
  && token.length >= 5
  && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(token);

function parseTable() {
  const headerAt = rows.findIndex((l) => {
    const words = l.toLowerCase().split(/[^a-z]+/);
    return HEADER_WORDS.filter((w) => words.includes(w)).length >= 3;
  });
  if (headerAt < 0) return null;

  const lines = [];
  const unparsed = [];
  for (const row of rows.slice(headerAt + 1)) {
    const m = row.match(TABLE_ROW);
    if (m) {
      const [, pos, middle, qty, unit] = m;
      const first = middle.split(' ')[0];
      const code = looksLikeCode(first) ? first : null;
      lines.push({
        line_no: Number(pos),
        code,
        description: code ? middle.slice(first.length).trim() : middle,
        qty: toNumber(qty),
        unit,
      });
    } else if (/^\d{1,3}\s+\S/.test(row)) {
      unparsed.push(row);
    }
  }
  return lines.length ? { parser: 'table', lines, unparsed } : null;
}

function parseList() {
  const lines = [];
  for (const row of rows) {
    const m = row.match(BULLET_ROW);
    if (m) {
      lines.push({ line_no: lines.length + 1, code: null, description: m[3].trim(), qty: toNumber(m[1]), unit: m[2] || null });
    }
  }
  return lines.length ? { parser: 'list', lines, unparsed: [] } : null;
}

const result = parseTable() || parseList() || { parser: 'none', lines: [], unparsed: [] };

let next = result.lines.reduce((max, l) => Math.max(max, l.line_no), 0) + 1;
for (const row of result.unparsed) {
  result.lines.push({ line_no: next++, code: null, description: row, qty: null, unit: null });
}

return [{
  json: {
    ...prep,
    parser: result.parser,
    lines: result.lines,
    unparsed_count: result.unparsed.length,
    source_text: text.slice(0, 20000),
  },
}];
