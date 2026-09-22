const item = $input.first();
const body = item.json.body || {};
const query = item.json.query || {};
const binaryKey = Object.keys(item.binary || {})[0];
const file = binaryKey ? item.binary[binaryKey] : null;
const lines = Array.isArray(body.lines) ? body.lines : null;
const customerId = Number(body.customer_id ?? query.customer_id);

const errors = [];
if (!Number.isInteger(customerId) || customerId <= 0) errors.push('customer_id (positive integer) is required');
if (!file && !lines) errors.push('send a PDF as multipart field "file", or JSON with a "lines" array');
if (file && !/pdf/i.test(file.mimeType || '') && !/\.pdf$/i.test(file.fileName || '')) errors.push('only PDF files are supported');
if (lines && lines.length > 500) errors.push('at most 500 lines per request');

if (errors.length) {
  return [{ json: { valid: false, errors } }];
}

const out = {
  json: {
    valid: true,
    customer_id: customerId,
    source_name: file ? file.fileName : body.source_name || 'api-lines',
    format: String(query.format || 'json').toLowerCase(),
  },
};
if (lines) out.json.lines = lines;
if (file) out.binary = { data: file };
return [out];
