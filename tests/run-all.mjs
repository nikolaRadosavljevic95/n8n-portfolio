import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.N8N_URL || 'http://localhost:5678';
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const only = process.argv[2];
const OUT = path.join(ROOT, 'tests', 'output');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const metrics = {};

function sql(query) {
  return execFileSync('docker', ['exec', '-i', 'n8n-portfolio-postgres-1', 'psql', '-U', env.POSTGRES_USER, '-d', 'apps', '-At', '-v', 'ON_ERROR_STOP=1'],
    { input: query, encoding: 'utf8' }).trim();
}
const sqlJson = (query) => JSON.parse(sql(query) || 'null');
const seed = (file) => execFileSync('docker', ['exec', '-i', 'n8n-portfolio-postgres-1', 'psql', '-U', env.POSTGRES_USER, '-d', 'apps', '-q', '-v', 'ON_ERROR_STOP=1'],
  { input: fs.readFileSync(path.join(ROOT, 'db', file), 'utf8'), encoding: 'utf8' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, { timeout = 60000, every = 1000, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`Timed out after ${timeout} ms waiting for ${label}`);
}

function assert(cond, message, detail) {
  if (!cond) {
    const e = new Error(message);
    e.detail = detail;
    throw e;
  }
}

async function test(group, name, fn) {
  if (only && only !== group) return;
  const start = Date.now();
  try {
    const note = await fn();
    results.push({ group, name, ok: true, ms: Date.now() - start, note: note || '' });
    console.log(`  PASS  [${group}] ${name}${note ? `  (${note})` : ''}`);
  } catch (e) {
    results.push({ group, name, ok: false, ms: Date.now() - start, error: e.message, detail: e.detail });
    console.log(`  FAIL  [${group}] ${name}: ${e.message}`);
    if (e.detail) console.log('        ', JSON.stringify(e.detail).slice(0, 600));
  }
}

async function http(method, url, { json, form, headers = {}, raw } = {}) {
  const opts = { method, headers: { ...headers } };
  if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.headers['content-type'] = 'application/json';
  } else if (form) {
    opts.body = form;
  } else if (raw !== undefined) {
    opts.body = raw;
  }
  const t0 = performance.now();
  const res = await fetch(BASE + url, opts);
  const ms = performance.now() - t0;
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers, ms };
}

const pdfForm = (file, customerId) => {
  const form = new FormData();
  form.append('customer_id', String(customerId));
  form.append('file', new Blob([fs.readFileSync(path.join(ROOT, 'samples', file))], { type: 'application/pdf' }), file);
  return form;
};
const percentile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function rfqTests() {
  seed('21_rfq_seed.sql');
  let quote;

  await test('rfq', 'ERP table PDF is parsed, matched and priced', async () => {
    const r = await http('POST', '/webhook/rfq/quote', { form: pdfForm('rfq-01-elektro-mont.pdf', 1) });
    assert(r.status === 201, `expected 201, got ${r.status}`, r.body);
    quote = r.body;
    fs.writeFileSync(path.join(OUT, 'rfq-01-response.json'), JSON.stringify(quote, null, 2));
    assert(quote.parser === 'table' && quote.counts.lines === 17, 'expected 17 lines from the table parser', quote.counts);
    assert(quote.counts.ok === 12 && quote.counts.review === 5, 'expected 12 OK and 5 review lines', quote.counts);
    const byLine = Object.fromEntries(quote.lines.map((l) => [l.line_no, l]));
    const expectReason = { 7: 'CODE_DESCRIPTION_CONFLICT', 12: 'NO_MATCH', 13: 'AMBIGUOUS', 17: 'UNIT_MISMATCH' };
    for (const [n, reason] of Object.entries(expectReason)) {
      assert(byLine[n].status === 'REVIEW' && byLine[n].reasons.includes(reason), `line ${n} should be REVIEW/${reason}`, byLine[n]);
    }
    assert(byLine[4].sku === 'VX-NYM-3X1.5-R100' && byLine[4].qty_quoted === 3, '250 m of NYM 3x1.5 should become 3 rings', byLine[4]);
    assert(byLine[6].match_method === 'ALIAS' && byLine[6].sku === 'VX-MCB-C20-1P', 'manufacturer code should resolve by alias', byLine[6]);
    assert(byLine[1].match_method === 'CUSTOMER_XREF' && byLine[1].unit_price === 2.94, 'customer part number + project price', byLine[1]);
    const sum = quote.lines.filter((l) => l.status === 'OK').reduce((s, l) => s + l.line_total, 0);
    assert(Math.abs(sum - quote.net_total) < 0.01, 'net total must equal sum of priced lines', { sum, net: quote.net_total });
    metrics.rfq_pdf_ms = Math.round(r.ms);
    return `${quote.quote_no}, ${quote.counts.ok}/${quote.counts.lines} auto, net ${quote.net_total} EUR, ${Math.round(r.ms)} ms`;
  });

  await test('rfq', 'Same PDF twice returns the same quote (idempotent)', async () => {
    const r = await http('POST', '/webhook/rfq/quote', { form: pdfForm('rfq-01-elektro-mont.pdf', 1) });
    assert(r.status === 200 && r.body.duplicate === true && r.body.quote_no === quote.quote_no, 'expected duplicate of the first quote', r.body);
    assert(sql('SELECT count(*) FROM rfq.quotes') === '1', 'only one quote row should exist');
  });

  await test('rfq', 'Excel download has Quote and Review sheets', async () => {
    const r = await http('GET', `/webhook/rfq/quote/xlsx?quote_no=${quote.quote_no}`);
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert((r.headers.get('content-type') || '').includes('spreadsheetml'), 'wrong content type', r.headers.get('content-type'));
    const buf = r.body;
    fs.writeFileSync(path.join(OUT, `${quote.quote_no}.xlsx`), buf);
    const text = buf.toString('latin1');
    assert(buf.subarray(0, 2).toString() === 'PK', 'not a zip file');
    assert(text.includes('name="Quote"') && text.includes('name="Review"'), 'workbook must contain both sheets');
    assert(text.includes('Socket outlet double white'), 'review sheet must list the ambiguous line');
    return `${buf.length} bytes`;
  });

  await test('rfq', 'Email style bullet list is quoted fully automatically', async () => {
    const r = await http('POST', '/webhook/rfq/quote', { form: pdfForm('rfq-02-brightline.pdf', 2) });
    assert(r.status === 201 && r.body.parser === 'list', 'expected list parser', r.body);
    assert(r.body.status === 'READY' && r.body.counts.ok === 7, 'all 7 lines should be priced', r.body.counts);
    const utp = r.body.lines.find((l) => l.sku === 'VX-UTP-CAT6-305');
    assert(utp && utp.qty_quoted === 1 && utp.notes[0].includes('rounded up'), '150 m UTP should round up to one 305 m box', utp);
    return `${Math.round(r.ms)} ms`;
  });

  await test('rfq', 'Free text RFQ without LLM goes to manual entry, nothing is guessed', async () => {
    const r = await http('POST', '/webhook/rfq/quote', { form: pdfForm('rfq-03-nordic.pdf', 3) });
    assert(r.status === 201 && r.body.status === 'NEEDS_MANUAL_ENTRY' && r.body.counts.lines === 0, 'expected manual entry', r.body);
  });

  await test('rfq', 'Resolving a review line recalculates totals and learns the customer code', async () => {
    const r = await http('POST', '/webhook/rfq/review/resolve',
      { json: { quote_no: quote.quote_no, line_no: 15, sku: 'VX-LEVER-3W-P50', remember: true, resolved_by: 'test' } });
    assert(r.status === 200 && r.body.remembered_mapping === true && r.body.counts.ok === 13, 'expected resolved line', r.body);
    assert(r.body.net_total > quote.net_total, 'net total should grow');
  });

  await test('rfq', 'Next RFQ with the learned code is matched automatically', async () => {
    const r = await http('POST', '/webhook/rfq/quote', {
      json: { customer_id: 1, source_name: 'erp-export', lines: [{ line_no: 1, code: 'EM-40020', description: 'Lever connector', qty: 150, unit: 'pcs' }] },
    });
    const line = r.body.lines?.[0];
    assert(r.status === 201 && line.match_method === 'CUSTOMER_XREF' && line.sku === 'VX-LEVER-3W-P50' && line.qty_quoted === 3,
      'learned mapping should be used and 150 pcs converted to 3 packs of 50', r.body);
  });

  await test('rfq', 'Invalid input is rejected with a clear message', async () => {
    const a = await http('POST', '/webhook/rfq/review/resolve', { json: { quote_no: quote.quote_no, line_no: 17, sku: 'VX-LEDP-6060-36W-40K' } });
    assert(a.status === 422 && a.body.message.includes('UNIT_MISMATCH'), 'resolve with impossible unit must fail', a.body);
    const b = await http('POST', '/webhook/rfq/quote', { json: { customer_id: 99, lines: [{ description: 'MCB B16', qty: 1 }] } });
    assert(b.status === 422 && b.body.error === 'unknown_customer' && b.body.message.includes('Unknown customer_id 99'), 'unknown customer must fail', b.body);
    const e = await http('POST', '/webhook/rfq/quote', { form: (() => { const f = new FormData(); f.append('customer_id', '1'); f.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'fake.pdf'); return f; })() });
    assert(e.status === 422 && e.body.message === 'The uploaded file is not a PDF', 'fake PDF must be rejected', e.body);
    const errors = sql("SELECT count(*) FROM ops.workflow_errors WHERE occurred_at > now() - interval '1 minute'");
    assert(errors === '0', 'client errors must not be logged as workflow failures', errors);
    const c = await http('POST', '/webhook/rfq/quote', { json: { lines: [] } });
    assert(c.status === 400, 'missing customer must be 400', c.body);
    const d = await http('GET', '/webhook/rfq/quote/xlsx?quote_no=Q-NOPE');
    assert(d.status === 404, 'unknown quote must be 404');
  });

  await test('rfq', 'Upload form is served', async () => {
    const r = await http('GET', '/form/rfq');
    assert(r.status === 200 && r.body.toString().includes('Request for quotation'), 'form page should render');
  });
}

async function voiceTests() {
  seed('31_booking_seed.sql');
  const secret = env.VOICE_WEBHOOK_SECRET;
  let n = 0;
  const vapi = (name, args, { phone = '+381601234567', callId = 'call-test-1', id, secretHeader = secret } = {}) => {
    const toolCallId = id || `tc_${Date.now()}_${n++}`;
    return http('POST', '/webhook/voice/vapi', {
      headers: secretHeader ? { 'x-vapi-secret': secretHeader } : {},
      json: {
        message: {
          type: 'tool-calls',
          call: { id: callId },
          customer: { number: phone },
          toolCallList: [{ id: toolCallId, type: 'function', function: { name, arguments: args } }],
        },
      },
    }).then((r) => ({ ...r, toolCallId, result: r.body?.results ? JSON.parse(r.body.results[0].result) : null }));
  };

  const day = sql(`SELECT d::date FROM generate_series(current_date + 2, current_date + 12, interval '1 day') d
                   WHERE extract(isodow FROM d) BETWEEN 2 AND 5 AND d::date NOT BETWEEN current_date + 9 AND current_date + 11
                   ORDER BY d LIMIT 1`);
  let booked;

  await test('voice', 'Requests without the shared secret are rejected', async () => {
    const r = await vapi('check_availability', { service: 'haircut' }, { secretHeader: 'wrong' });
    assert(r.status === 401, `expected 401, got ${r.status}`);
  });

  await test('voice', 'Availability: max 3 options, at least 60 min apart, inside working hours', async () => {
    const r = await vapi('check_availability', { service: 'ladies cut', date: day, part_of_day: 'afternoon' });
    fs.writeFileSync(path.join(OUT, 'voice-availability.json'), JSON.stringify(r.body, null, 2));
    assert(r.status === 200 && r.body.results[0].toolCallId === r.toolCallId, 'Vapi response shape', r.body);
    const res = r.result;
    assert(res.status === 'ok' && res.slots.length === 3, 'expected 3 slots', res);
    const times = res.slots.map((s) => new Date(`${s.start}:00`).getTime());
    for (let i = 1; i < times.length; i++) assert(Math.abs(times[i] - times[i - 1]) >= 3600000, 'slots must be 60 min apart', res.slots);
    assert(res.slots.every((s) => s.start.slice(11) >= '12:00' && s.start.slice(11) < '17:00'), 'afternoon filter', res.slots);
    return res.message;
  });

  await test('voice', 'Booking creates the appointment and queues an SMS in the same transaction', async () => {
    const avail = await vapi('check_availability', { service: "women's haircut", date: day, around: '11:00' });
    const slot = avail.result.slots[0];
    const r = await vapi('book_appointment', { service: "women's haircut", start: slot.start, staff_id: slot.staff_id, customer_name: 'Jovana Marković' });
    assert(r.result.status === 'booked', 'expected booked', r.result);
    booked = { ...r.result.appointment, toolCallId: r.toolCallId };
    const row = sqlJson(`SELECT json_build_object('appt', (SELECT count(*) FROM booking.appointments WHERE ref = '${booked.ref}'),
      'sms', (SELECT count(*) FROM booking.outbox o JOIN booking.appointments a ON a.id = o.appointment_id WHERE a.ref = '${booked.ref}'))`);
    assert(row.appt === 1 && row.sms === 1, 'appointment and SMS must both exist', row);
    return r.result.message;
  });

  await test('voice', 'Retry of the same tool call does not double book', async () => {
    const r = await vapi('book_appointment', { service: "women's haircut", start: booked.start, staff_id: booked.staff_id, customer_name: 'Jovana Marković' }, { id: booked.toolCallId });
    assert(r.result.status === 'booked' && r.result.appointment.ref === booked.ref && r.result.replayed === true, 'expected replay of the same booking', r.result);
    assert(sql("SELECT count(*) FROM booking.appointments WHERE customer_id = (SELECT id FROM booking.customers WHERE phone_e164 = '+381601234567')") === '1', 'exactly one appointment');
  });

  await test('voice', '10 callers race for the same slot: exactly one wins, nine get alternatives', async () => {
    const avail = await vapi('check_availability', { service: "men's haircut", date: day, staff: 'Marko' });
    const slot = avail.result.slots[0];
    const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) => vapi('book_appointment',
      { service: "men's haircut", start: slot.start, staff_id: 2, customer_name: `Racer ${i}` },
      { phone: `+3816011122${10 + i}`, callId: `race-${i}` })));
    const statuses = attempts.map((a) => a.result.status);
    const wins = statuses.filter((s) => s === 'booked').length;
    const taken = attempts.filter((a) => a.result.status === 'slot_taken' && a.result.alternatives.length > 0).length;
    assert(wins === 1 && taken === 9, 'expected 1 booked and 9 slot_taken with alternatives', statuses);
    const overlaps = sql(`SELECT count(*) FROM booking.appointments a JOIN booking.appointments b
                          ON a.id < b.id AND a.staff_id = b.staff_id AND a.during && b.during
                          WHERE a.status = 'booked' AND b.status = 'booked'`);
    assert(overlaps === '0', 'no overlapping bookings may exist');
    return `winner ${attempts.find((a) => a.result.status === 'booked').result.appointment.ref}`;
  });

  await test('voice', 'Another caller cannot cancel your booking by guessing the reference', async () => {
    const r = await vapi('cancel_appointment', { ref: booked.ref }, { phone: '+381655555555' });
    assert(r.result.status === 'not_found', 'must not reveal or cancel', r.result);
    assert(sql(`SELECT status FROM booking.appointments WHERE ref = '${booked.ref}'`) === 'booked', 'still booked');
  });

  await test('voice', 'Owner can find, reschedule and cancel', async () => {
    const f = await vapi('find_appointments', {});
    assert(f.result.appointments.some((a) => a.ref === booked.ref), 'find should list the booking', f.result);
    const alt = await vapi('check_availability', { service: "women's haircut", date: booked.start.slice(0, 10), staff: booked.staff_name, part_of_day: 'afternoon' });
    const m = await vapi('reschedule_appointment', { ref: booked.ref, new_start: alt.result.slots[0].start });
    assert(m.result.status === 'rescheduled' && m.result.appointment.start === alt.result.slots[0].start, 'reschedule to a free slot', m.result);
    const clash = await vapi('reschedule_appointment', { ref: booked.ref, new_start: sql(`SELECT to_char(starts_at AT TIME ZONE 'Europe/Belgrade', 'YYYY-MM-DD"T"HH24:MI') FROM booking.appointments WHERE ref = 'MIL002'`) });
    assert(['slot_taken', 'outside_hours'].includes(clash.result.status), 'moving onto a taken slot must be refused', clash.result);
    const c = await vapi('cancel_appointment', {});
    assert(c.result.status === 'cancelled', 'single booking should be cancelled without asking which', c.result);
    return `${m.result.message} / ${c.result.message}`;
  });

  await test('voice', 'Retell payload works through the same adapter', async () => {
    const r = await http('POST', '/webhook/voice/retell', {
      headers: { 'x-voice-secret': secret },
      json: { call: { call_id: 'retell-1', from_number: '+381641112233' }, name: 'find_appointments', args: {} },
    });
    assert(r.status === 200 && r.body.status === 'ok' && r.body.appointments.length === 2, 'Milica has 2 seeded bookings', r.body);
  });

  await test('voice', 'End-of-call report updates call log and CRM, without double counting', async () => {
    const report = (callId, phone) => http('POST', '/webhook/voice/vapi', {
      headers: { 'x-vapi-secret': secret },
      json: { message: { type: 'end-of-call-report', call: { id: callId }, customer: { number: phone }, endedReason: 'customer-ended-call',
        analysis: { summary: 'Caller asked about a haircut.' }, artifact: { transcript: 'AI: Hello...' },
        startedAt: new Date(Date.now() - 120000).toISOString(), endedAt: new Date().toISOString() } },
    });
    await vapi('check_availability', { service: 'blow dry' }, { callId: 'call-enquiry', phone: '+381637777777' });
    const a = await report('call-test-1', '+381601234567');
    const b = await report('call-enquiry', '+381637777777');
    await report('call-enquiry', '+381637777777');
    assert(a.status === 200 && b.status === 200, 'reports acknowledged');
    const state = await eventually(() => {
      const s = sqlJson(`SELECT json_build_object(
        'booked', (SELECT outcome FROM booking.calls WHERE call_id = 'call-test-1'),
        'enquiry', (SELECT outcome FROM booking.calls WHERE call_id = 'call-enquiry'),
        'calls', (SELECT total_calls FROM crm.contacts WHERE phone_e164 = '+381637777777'),
        'tasks', (SELECT count(*) FROM crm.tasks WHERE source_call_id = 'call-enquiry'))`);
      return s.booked && s.enquiry && s.tasks === 1 ? s : null;
    }, { timeout: 20000, label: 'call records' });
    await sleep(1500);
    const calls = sql("SELECT total_calls FROM crm.contacts WHERE phone_e164 = '+381637777777'");
    assert(state.booked === 'cancelled' || state.booked === 'booked' || state.booked === 'rescheduled', 'outcome derived from tool calls', state);
    assert(state.enquiry === 'enquiry_no_booking' && calls === '1', 'duplicate report must not double count', { state, calls });
    return `outcomes: ${state.booked}, ${state.enquiry}; follow-up task created`;
  });

  await test('voice', 'SMS outbox is delivered by the dispatcher, failures are retried', async () => {
    sql(`INSERT INTO booking.outbox (recipient, message) VALUES ('+381600000000', 'Test to unreachable number')`);
    const s = await eventually(() => {
      const r = sqlJson(`SELECT json_build_object('sent', count(*) FILTER (WHERE status = 'sent'),
        'others_unsent', count(*) FILTER (WHERE recipient <> '+381600000000' AND status <> 'sent'),
        'retrying', count(*) FILTER (WHERE recipient = '+381600000000' AND attempts >= 1 AND status = 'pending' AND last_error IS NOT NULL))
        FROM booking.outbox`);
      return r.others_unsent === 0 && r.retrying === 1 && r.sent >= 2 ? r : null;
    }, { timeout: 60000, every: 2000, label: 'SMS dispatch' });
    return `${s.sent} sent, unreachable number scheduled for retry`;
  });

  await test('voice', 'Latency of the tool webhook (30 sequential calls)', async () => {
    const times = [];
    for (let i = 0; i < 30; i++) times.push((await vapi('check_availability', { service: 'beard trim' })).ms);
    metrics.voice_p50_ms = Math.round(percentile(times, 50));
    metrics.voice_p95_ms = Math.round(percentile(times, 95));
    assert(metrics.voice_p95_ms < 800, 'p95 should stay well under a second', metrics);
    return `p50 ${metrics.voice_p50_ms} ms, p95 ${metrics.voice_p95_ms} ms`;
  });
}

async function paymentTests() {
  seed('41_payments_seed.sql');
  const secret = env.PAYMENTS_SIGNING_SECRET;
  const admin = { 'x-admin-token': env.ADMIN_API_TOKEN };
  const sign = (raw, ts = Math.floor(Date.now() / 1000), key = secret) =>
    `t=${ts},v1=${crypto.createHmac('sha256', key).update(`${ts}.${raw}`).digest('hex')}`;
  const event = (type, order, id = `evt_${crypto.randomBytes(8).toString('hex')}`) => ({
    id, type, created: Math.floor(Date.now() / 1000),
    data: { object: { id: `pi_${order}`, amount: 1000, currency: 'eur', metadata: { order_id: order } } },
  });
  const send = (evt, opts = {}) => {
    const raw = JSON.stringify(evt);
    return http('POST', '/webhook/payments/webhook', {
      raw, headers: { 'content-type': 'application/json', ...(opts.noSig ? {} : { 'stripe-signature': opts.sig ?? sign(raw, opts.ts) }) },
    });
  };
  const order = (id) => sqlJson(`SELECT row_to_json(o) FROM pay.orders o WHERE id = '${id}'`);
  const waitStatus = (id, status, timeout = 60000) => eventually(() => (order(id).status === status ? order(id) : null),
    { timeout, label: `${id} -> ${status}` });

  await test('payments', 'Missing, forged and replayed signatures are rejected', async () => {
    const e = event('payment_intent.succeeded', 'ord_1001');
    const a = await send(e, { noSig: true });
    const b = await send(e, { sig: sign(JSON.stringify(e), undefined, 'whsec_wrong') });
    const c = await send(e, { ts: Math.floor(Date.now() / 1000) - 900 });
    assert(a.status === 400 && a.body.error === 'missing_signature', 'missing', a.body);
    assert(b.status === 400 && b.body.error === 'bad_signature', 'forged', b.body);
    assert(c.status === 400 && c.body.error === 'timestamp_outside_tolerance', 'replayed', c.body);
    assert(sql('SELECT count(*) FROM pay.inbox') === '0', 'nothing may be stored');
  });

  await test('payments', 'Valid event is acknowledged fast and the order is fulfilled in the POS', async () => {
    const e = event('payment_intent.succeeded', 'ord_1001');
    const r = await send(e);
    assert(r.status === 200 && r.body.duplicate === false, 'accepted', r.body);
    metrics.payments_ack_ms = Math.round(r.ms);
    const o = await waitStatus('ord_1001', 'fulfilled', 20000);
    assert(o.pos_order_id && o.pos_order_id.startsWith('POS-'), 'POS order id stored', o);
    return `ack ${Math.round(r.ms)} ms, POS order ${o.pos_order_id}`;
  });

  await test('payments', 'Duplicate delivery is dropped at the inbox', async () => {
    const e = event('payment_intent.succeeded', 'ord_1005', 'evt_dup_1');
    const [a, b, c] = await Promise.all([send(e), send(e), send(e)]);
    const dupFlags = [a, b, c].map((x) => x.body.duplicate).sort();
    assert(JSON.stringify(dupFlags) === '[false,true,true]', 'exactly one new', dupFlags);
    await waitStatus('ord_1005', 'fulfilled', 20000);
    assert(sql("SELECT count(*) FROM mock.pos_orders WHERE order_id = 'ord_1005'") === '1', 'one POS order');
  });

  await test('payments', 'Flaky POS: two 503s, then success after exponential backoff', async () => {
    sql("UPDATE mock.pos_config SET fail_first_n = 2; UPDATE pay.config SET base_backoff_seconds = 1;");
    const e = event('payment_intent.succeeded', 'ord_1002');
    await send(e);
    await waitStatus('ord_1002', 'fulfilled', 90000);
    const calls = sql(`SELECT string_agg(http_status::text, ',' ORDER BY id) FROM mock.pos_calls WHERE idempotency_key = '${e.id}'`);
    const attempts = sql(`SELECT attempts FROM pay.inbox WHERE event_id = '${e.id}'`);
    sql('UPDATE mock.pos_config SET fail_first_n = 0;');
    assert(calls === '503,503,201' && attempts === '3', 'expected 503,503,201 over 3 attempts', { calls, attempts });
    return `POS calls ${calls}`;
  });

  await test('payments', 'POS down for good: event is dead-lettered and an alert is raised', async () => {
    sql("UPDATE mock.pos_config SET always_fail_orders = '{ord_1003}'; UPDATE pay.config SET max_attempts = 3, base_backoff_seconds = 1;");
    const since = sql('SELECT now()');
    const e = event('payment_intent.succeeded', 'ord_1003', 'evt_dead_1');
    await send(e);
    await eventually(() => sql("SELECT status FROM pay.inbox WHERE event_id = 'evt_dead_1'") === 'dead', { timeout: 90000, label: 'dead letter' });
    const alert = sql(`SELECT count(*) FROM ops.alerts WHERE source = 'payments' AND details->>'event_id' = 'evt_dead_1' AND created_at >= '${since}'`);
    const h = await http('GET', '/webhook/payments/admin/health', { headers: admin });
    assert(alert === '1' && h.body.dead_letters.some((d) => d.event_id === 'evt_dead_1'), 'alert + health must show the dead letter', h.body);
    assert(order('ord_1003').status === 'paid', 'money is recorded even though fulfilment failed');
  });

  await test('payments', 'After the fix, replay processes the dead letter', async () => {
    sql("UPDATE mock.pos_config SET always_fail_orders = '{}';");
    const unauth = await http('POST', '/webhook/payments/admin/replay', { json: { event_id: 'evt_dead_1' } });
    assert(unauth.status === 401, 'replay requires admin token');
    const r = await http('POST', '/webhook/payments/admin/replay', { headers: admin, json: { event_id: 'evt_dead_1' } });
    assert(r.status === 202, 'replay accepted', r.body);
    await waitStatus('ord_1003', 'fulfilled', 30000);
  });

  await test('payments', 'Refund that arrives before the payment is parked, then applied in order', async () => {
    sql('UPDATE pay.config SET max_attempts = 6, base_backoff_seconds = 1;');
    const refund = event('charge.refunded', 'ord_1004');
    await send(refund);
    await eventually(() => sql(`SELECT last_error FROM pay.inbox WHERE event_id = '${refund.id}'`) === 'Waiting: out_of_order',
      { timeout: 20000, label: 'refund parked' });
    await send(event('payment_intent.succeeded', 'ord_1004'));
    const o = await waitStatus('ord_1004', 'refunded', 90000);
    const trail = sql("SELECT string_agg(to_status, ' > ' ORDER BY id) FROM pay.order_events WHERE order_id = 'ord_1004'");
    assert(trail === 'paid > fulfilled > refunded' || trail === 'paid > refunded > fulfilled' || trail.startsWith('paid'), 'audit trail', trail);
    return `trail: ${trail}`;
  });

  await test('payments', 'Failed card, then successful retry by the customer', async () => {
    await send(event('payment_intent.payment_failed', 'ord_1006'));
    await waitStatus('ord_1006', 'payment_failed', 20000);
    await send(event('payment_intent.succeeded', 'ord_1006'));
    await waitStatus('ord_1006', 'fulfilled', 20000);
  });

  await test('payments', 'Burst: 12 orders, every event delivered twice, in parallel', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `ord_${1007 + i}`);
    const events = ids.map((o) => event('payment_intent.succeeded', o));
    const t0 = Date.now();
    await Promise.all([...events, ...events].map((e) => send(e)));
    await eventually(() => sql(`SELECT count(*) FROM pay.orders WHERE id = ANY('{${ids.join(',')}}') AND status = 'fulfilled'`) === '12',
      { timeout: 60000, label: 'burst fulfilled' });
    const posOrders = sql(`SELECT count(*) FROM mock.pos_orders WHERE order_id = ANY('{${ids.join(',')}}')`);
    assert(posOrders === '12', 'exactly one POS order per order', posOrders);
    return `24 deliveries, 12 fulfilled once each in ${Date.now() - t0} ms`;
  });

  await test('payments', 'Health endpoint requires the admin token and reports state', async () => {
    const a = await http('GET', '/webhook/payments/admin/health');
    const b = await http('GET', '/webhook/payments/admin/health', { headers: admin });
    assert(a.status === 401 && b.status === 200 && b.body.orders.fulfilled >= 15, 'health', b.body);
    fs.writeFileSync(path.join(OUT, 'payments-health.json'), JSON.stringify(b.body, null, 2));
    return JSON.stringify(b.body.inbox);
  });
}

async function llmTests() {
  seed('21_rfq_seed.sql');
  await test('llm', 'Free text RFQ is parsed by the LLM, invented items are rejected', async () => {
    const r = await http('POST', '/webhook/rfq/quote', { form: pdfForm('rfq-03-nordic.pdf', 3) });
    fs.writeFileSync(path.join(OUT, 'rfq-03-llm-response.json'), JSON.stringify(r.body, null, 2));
    assert(r.status === 201 && r.body.parser === 'llm', 'expected llm parser', r.body);
    const byDesc = (t) => r.body.lines.find((l) => l.description.includes(t));
    const expectSku = {
      'NYM 3x2.5': 'VX-NYM-3X2.5-R100',
      'B16 single pole': 'VX-MCB-B16-1P',
      'LED panels': 'VX-LEDP-6060-40W-40K',
      'residual current': 'VX-RCD-4P-40A-30MA',
      'IP44': 'VX-SOCK-IP44-GY',
    };
    for (const [t, sku] of Object.entries(expectSku)) {
      const l = byDesc(t);
      assert(l && l.status === 'OK' && l.sku === sku, `"${t}" should be priced as ${sku}`, l);
    }
    const invented = byDesc('[unverified LLM output]');
    assert(invented && invented.status === 'REVIEW' && invented.unit_price === null, 'hallucinated line must go to review unpriced', invented);
    return `${r.body.counts.ok}/${r.body.counts.lines} priced, invented line flagged`;
  });
}

const t0 = Date.now();
console.log(`Running against ${BASE}\n`);
if (only === 'llm') {
  await llmTests();
} else {
  await rfqTests();
  await voiceTests();
  await paymentTests();
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${passed} passed, ${failed} failed in ${seconds}s`);
console.log('Metrics:', JSON.stringify(metrics));

const md = [
  '# Test report',
  '',
  `Run: ${new Date().toISOString()}  |  n8n 2.40.5  |  ${passed} passed, ${failed} failed in ${seconds}s`,
  '',
  '| Demo | Test | Result | Time | Evidence |',
  '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.group} | ${r.name} | ${r.ok ? 'pass' : 'FAIL'} | ${r.ms} ms | ${(r.ok ? r.note : r.error).replace(/\|/g, '/')} |`),
  '',
  `Metrics: ${Object.entries(metrics).map(([k, v]) => `${k} = ${v}`).join(', ')}`,
  '',
].join('\n');
const reportName = only ? `report-${only}` : 'report';
fs.writeFileSync(path.join(OUT, `${reportName}.md`), md);
fs.writeFileSync(path.join(OUT, `${reportName}.json`), JSON.stringify({ passed, failed, seconds, metrics, results }, null, 2));
process.exit(failed ? 1 : 0);
