const crypto = require('crypto');

const item = $input.first();
const reject = (message) => [{ json: { rejected: true, error_code: 'invalid_input', message } }];

const customerId = Number(item.json.customer_id);
if (!Number.isInteger(customerId) || customerId <= 0) {
  return reject('customer_id must be a positive integer');
}

const hasPdf = Boolean(item.binary && item.binary.data);
const hasLines = Array.isArray(item.json.lines) && item.json.lines.length > 0;
if (!hasPdf && !hasLines) {
  return reject('Provide either a PDF in binary field "data" or a non-empty "lines" array');
}

if (hasPdf) {
  const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return reject('The uploaded file is not a PDF');
  }
  return [{
    json: {
      customer_id: customerId,
      source_name: item.json.source_name || item.binary.data.fileName || 'rfq.pdf',
      source_sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      mode: 'pdf',
    },
    binary: { data: item.binary.data },
  }];
}

const lines = item.json.lines.map((l, i) => ({
  line_no: Number.isInteger(Number(l.line_no)) ? Number(l.line_no) : i + 1,
  code: l.code ? String(l.code).trim() : null,
  description: String(l.description ?? '').trim(),
  qty: l.qty === undefined || l.qty === null || l.qty === '' ? null : Number(String(l.qty).replace(',', '.')),
  unit: l.unit ? String(l.unit).trim() : null,
}));

return [{
  json: {
    customer_id: customerId,
    source_name: item.json.source_name || 'api-lines',
    source_sha256: crypto.createHash('sha256').update(JSON.stringify(lines)).digest('hex'),
    mode: 'lines',
    parser: 'api',
    lines,
  },
}];
