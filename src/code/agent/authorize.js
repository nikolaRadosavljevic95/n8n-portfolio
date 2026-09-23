// The support widget talks to this webhook on behalf of a signed-in customer.
// The customer id comes from that trusted channel, never from the message text
// and never from the model, which is what makes the ownership checks in SQL
// mean something.
const crypto = require('crypto');

const item = $input.first();
const headers = item.json.headers || {};
const body = item.json.body || {};

const expected = String($env.AGENT_API_TOKEN || '');
const provided = String(headers['x-agent-token'] || '');
const authorized = expected.length > 0
  && provided.length === expected.length
  && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

const customerId = Number(body.customer_id);
const message = typeof body.message === 'string' ? body.message.trim() : '';
const channel = ['email', 'chat', 'whatsapp'].includes(body.channel) ? body.channel : 'chat';

// A client that retries after a timeout sends the same request id, so the run
// is resumed instead of started again.
const requestId = String(body.request_id || '').trim()
  || crypto.createHash('sha256').update(`${customerId}:${channel}:${message}`).digest('hex').slice(0, 32);

let error = null;
if (!authorized) error = 'unauthorized';
else if (!Number.isInteger(customerId) || customerId <= 0) error = 'customer_id_required';
else if (!message) error = 'message_required';
else if (message.length > 4000) error = 'message_too_long';

return [{
  json: {
    authorized,
    ok: error === null,
    error,
    customer_id: customerId,
    channel,
    message,
    request_id: requestId,
  },
}];
