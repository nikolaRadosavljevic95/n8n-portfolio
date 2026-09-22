const crypto = require('crypto');

const TOLERANCE_SECONDS = 300;
const item = $input.first();
const header = String(item.json.headers?.['stripe-signature'] || '');
const secrets = String($env.PAYMENTS_SIGNING_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);

const reject = (reason) => [{ json: { valid: false, reason } }];

if (!header) return reject('missing_signature');
if (!item.binary?.data) return reject('empty_body');

const parts = header.split(',').map((p) => p.trim().split('='));
const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
if (!Number.isFinite(timestamp) || signatures.length === 0) return reject('malformed_signature');
if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return reject('timestamp_outside_tolerance');

const raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
const matches = secrets.some((secret) => {
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return signatures.some((sig) => sig.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
});
if (!matches) return reject('bad_signature');

let event;
try {
  event = JSON.parse(raw);
} catch (e) {
  return reject('invalid_json');
}
if (!event.id || !event.type) return reject('not_an_event');

return [{ json: { valid: true, event_id: event.id, event_type: event.type, payload: event } }];
