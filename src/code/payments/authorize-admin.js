const crypto = require('crypto');

const item = $input.first();
const expected = String($env.ADMIN_API_TOKEN || '');
const provided = String(item.json.headers?.['x-admin-token'] || '');
const ok = expected.length > 0
  && provided.length === expected.length
  && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

return [{ json: { ...item.json, authorized: ok } }];
