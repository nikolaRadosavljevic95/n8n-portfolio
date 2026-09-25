// The RFQ API is for the sales team's tools, not the public, so every call
// carries the x-api-token header. Uploaded files are passed through untouched.
const crypto = require('crypto');

const item = $input.first();
const expected = String($env.RFQ_API_TOKEN || '');
const provided = String(item.json.headers?.['x-api-token'] || '');
const ok = expected.length > 0
  && provided.length === expected.length
  && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

return [{ json: { ...item.json, authorized: ok }, binary: item.binary }];
