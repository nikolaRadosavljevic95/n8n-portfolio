CREATE SCHEMA IF NOT EXISTS pay;
CREATE SCHEMA IF NOT EXISTS mock;

CREATE TABLE IF NOT EXISTS pay.config (
    id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
    max_attempts          int NOT NULL DEFAULT 6,
    base_backoff_seconds  numeric NOT NULL DEFAULT 30,
    max_backoff_seconds   numeric NOT NULL DEFAULT 3600
);
INSERT INTO pay.config DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS pay.orders (
    id              text PRIMARY KEY,
    customer_email  text NOT NULL,
    amount_cents    int  NOT NULL CHECK (amount_cents > 0),
    currency        text NOT NULL DEFAULT 'eur',
    status          text NOT NULL DEFAULT 'pending_payment'
                    CHECK (status IN ('pending_payment', 'paid', 'fulfilled', 'payment_failed', 'refunded', 'cancelled')),
    pos_order_id    text,
    paid_at         timestamptz,
    fulfilled_at    timestamptz,
    refunded_at     timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pay.inbox (
    id               bigserial PRIMARY KEY,
    event_id         text NOT NULL UNIQUE,
    event_type       text NOT NULL,
    payload          jsonb NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now(),
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'retry', 'done', 'ignored', 'dead')),
    attempts         int NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    locked_until     timestamptz,
    outcome          text,
    last_error       text,
    processed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS inbox_due_idx ON pay.inbox (next_attempt_at) WHERE status IN ('pending', 'retry', 'processing');

CREATE TABLE IF NOT EXISTS pay.order_events (
    id           bigserial PRIMARY KEY,
    order_id     text NOT NULL REFERENCES pay.orders (id),
    event_id     text NOT NULL,
    from_status  text NOT NULL,
    to_status    text NOT NULL,
    at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mock.pos_config (
    id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
    fail_first_n        int NOT NULL DEFAULT 0,
    always_fail_orders  text[] NOT NULL DEFAULT '{}'
);
INSERT INTO mock.pos_config DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS mock.pos_order_seq START 50001;

CREATE TABLE IF NOT EXISTS mock.pos_calls (
    id               bigserial PRIMARY KEY,
    idempotency_key  text NOT NULL,
    order_id         text,
    http_status      int NOT NULL,
    called_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mock.pos_orders (
    idempotency_key  text PRIMARY KEY,
    pos_order_id     text NOT NULL,
    order_id         text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION pay.ingest(p_event_id text, p_type text, p_payload jsonb) RETURNS jsonb
LANGUAGE sql AS $$
    WITH ins AS (
        INSERT INTO pay.inbox (event_id, event_type, payload)
        VALUES (p_event_id, p_type, p_payload)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING id
    )
    SELECT jsonb_build_object(
        'inbox_id', coalesce((SELECT id FROM ins), (SELECT id FROM pay.inbox WHERE event_id = p_event_id)),
        'is_new', EXISTS (SELECT 1 FROM ins))
$$;

CREATE OR REPLACE FUNCTION pay.claim(p_event_id text, p_limit int DEFAULT 25) RETURNS SETOF pay.inbox
LANGUAGE sql AS $$
    UPDATE pay.inbox i
       SET status = 'processing', attempts = i.attempts + 1, locked_until = now() + interval '2 minutes'
     WHERE i.id IN (
            SELECT id FROM pay.inbox
             WHERE (p_event_id IS NULL OR event_id = p_event_id)
               AND ((status IN ('pending', 'retry') AND next_attempt_at <= now())
                    OR (status = 'processing' AND locked_until < now()))
             ORDER BY received_at
             FOR UPDATE SKIP LOCKED
             LIMIT p_limit)
    RETURNING i.*
$$;

CREATE OR REPLACE FUNCTION pay.transition(p_order pay.orders, p_event_id text, p_to text) RETURNS void
LANGUAGE sql AS $$
    UPDATE pay.orders
       SET status = p_to, updated_at = now(),
           paid_at = CASE WHEN p_to = 'paid' THEN now() ELSE paid_at END,
           refunded_at = CASE WHEN p_to = 'refunded' THEN now() ELSE refunded_at END
     WHERE id = p_order.id;
    INSERT INTO pay.order_events (order_id, event_id, from_status, to_status) VALUES (p_order.id, p_event_id, p_order.status, p_to);
$$;

CREATE OR REPLACE FUNCTION pay.apply(p_inbox_id bigint) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    e        pay.inbox%ROWTYPE;
    o        pay.orders%ROWTYPE;
    v_order  text;
    v_out    text;
    v_action text;
BEGIN
    SELECT * INTO e FROM pay.inbox WHERE id = p_inbox_id;
    v_order := e.payload #>> '{data,object,metadata,order_id}';

    IF e.event_type NOT IN ('payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.refunded') THEN
        v_out := 'ignored_event_type'; v_action := 'complete';
    ELSE
        SELECT * INTO o FROM pay.orders WHERE id = v_order FOR UPDATE;
        IF o.id IS NULL THEN
            v_out := 'unknown_order'; v_action := 'retry';
        ELSIF e.event_type = 'payment_intent.succeeded' THEN
            IF o.status IN ('pending_payment', 'payment_failed') THEN
                PERFORM pay.transition(o, e.event_id, 'paid');
                v_out := 'marked_paid'; v_action := 'fulfill';
            ELSIF o.status = 'paid' THEN
                v_out := 'already_paid'; v_action := 'fulfill';
            ELSIF o.status = 'fulfilled' THEN
                v_out := 'already_fulfilled'; v_action := 'complete';
            ELSE
                v_out := 'stale_event'; v_action := 'complete';
            END IF;
        ELSIF e.event_type = 'payment_intent.payment_failed' THEN
            IF o.status = 'pending_payment' THEN
                PERFORM pay.transition(o, e.event_id, 'payment_failed');
                v_out := 'marked_failed';
            ELSE
                v_out := 'stale_event';
            END IF;
            v_action := 'complete';
        ELSE
            IF o.status IN ('paid', 'fulfilled') THEN
                PERFORM pay.transition(o, e.event_id, 'refunded');
                v_out := 'marked_refunded'; v_action := 'complete';
            ELSIF o.status = 'refunded' THEN
                v_out := 'already_refunded'; v_action := 'complete';
            ELSE
                v_out := 'out_of_order'; v_action := 'retry';
            END IF;
        END IF;
    END IF;

    SELECT * INTO o FROM pay.orders WHERE id = v_order;
    RETURN jsonb_build_object(
        'inbox_id', e.id, 'event_id', e.event_id, 'event_type', e.event_type, 'attempt', e.attempts,
        'order_id', v_order, 'order_status', o.status, 'outcome', v_out, 'action', v_action,
        'amount_cents', o.amount_cents, 'currency', o.currency, 'customer_email', o.customer_email);
END
$$;

CREATE OR REPLACE FUNCTION pay.complete(p_inbox_id bigint, p_outcome text) RETURNS jsonb
LANGUAGE sql AS $$
    UPDATE pay.inbox
       SET status = CASE WHEN p_outcome LIKE 'ignored%' OR p_outcome = 'stale_event' THEN 'ignored' ELSE 'done' END,
           outcome = p_outcome, processed_at = now(), locked_until = NULL, last_error = NULL
     WHERE id = p_inbox_id
    RETURNING jsonb_build_object('inbox_id', id, 'status', status, 'outcome', outcome)
$$;

CREATE OR REPLACE FUNCTION pay.fulfilled(p_inbox_id bigint, p_order_id text, p_pos_order_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    o pay.orders%ROWTYPE;
BEGIN
    SELECT * INTO o FROM pay.orders WHERE id = p_order_id FOR UPDATE;
    IF o.status = 'paid' THEN
        UPDATE pay.orders SET status = 'fulfilled', pos_order_id = p_pos_order_id, fulfilled_at = now(), updated_at = now()
         WHERE id = o.id;
        INSERT INTO pay.order_events (order_id, event_id, from_status, to_status)
        SELECT o.id, event_id, 'paid', 'fulfilled' FROM pay.inbox WHERE id = p_inbox_id;
    END IF;
    RETURN pay.complete(p_inbox_id, 'fulfilled') || jsonb_build_object('pos_order_id', p_pos_order_id);
END
$$;

CREATE OR REPLACE FUNCTION pay.fail(p_inbox_id bigint, p_error text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    c  pay.config%ROWTYPE;
    e  pay.inbox%ROWTYPE;
    v_delay numeric;
BEGIN
    SELECT * INTO c FROM pay.config;
    SELECT * INTO e FROM pay.inbox WHERE id = p_inbox_id FOR UPDATE;
    IF e.attempts >= c.max_attempts THEN
        UPDATE pay.inbox SET status = 'dead', last_error = p_error, locked_until = NULL, processed_at = now()
         WHERE id = e.id;
        INSERT INTO ops.alerts (severity, source, title, details)
        VALUES ('critical', 'payments', 'Payment event dead-lettered',
                jsonb_build_object('event_id', e.event_id, 'event_type', e.event_type, 'attempts', e.attempts, 'error', p_error));
        RETURN jsonb_build_object('inbox_id', e.id, 'event_id', e.event_id, 'status', 'dead', 'attempts', e.attempts, 'error', p_error);
    END IF;

    v_delay := least(c.max_backoff_seconds, c.base_backoff_seconds * power(2, e.attempts - 1)) * (0.8 + random() * 0.4);
    UPDATE pay.inbox
       SET status = 'retry', last_error = p_error, locked_until = NULL,
           next_attempt_at = now() + make_interval(secs => v_delay)
     WHERE id = e.id;
    RETURN jsonb_build_object('inbox_id', e.id, 'event_id', e.event_id, 'status', 'retry', 'attempts', e.attempts,
                              'retry_in_seconds', round(v_delay, 1), 'error', p_error);
END
$$;

CREATE OR REPLACE FUNCTION pay.replay(p_event_id text) RETURNS jsonb
LANGUAGE sql AS $$
    UPDATE pay.inbox
       SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, last_error = NULL,
           processed_at = NULL
     WHERE event_id = p_event_id AND status IN ('dead', 'ignored')
    RETURNING jsonb_build_object('event_id', event_id, 'status', status)
$$;

CREATE OR REPLACE FUNCTION pay.health() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'inbox', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                    FROM (SELECT status, count(*) n FROM pay.inbox GROUP BY status) t),
        'orders', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                     FROM (SELECT status, count(*) n FROM pay.orders GROUP BY status) t),
        'oldest_waiting_seconds', (SELECT round(extract(epoch FROM now() - min(received_at)))
                                     FROM pay.inbox WHERE status IN ('pending', 'retry', 'processing')),
        'dead_letters', (SELECT coalesce(jsonb_agg(jsonb_build_object('event_id', event_id, 'type', event_type,
                                                    'attempts', attempts, 'error', last_error) ORDER BY id DESC), '[]'::jsonb)
                           FROM (SELECT * FROM pay.inbox WHERE status = 'dead' ORDER BY id DESC LIMIT 20) d),
        'open_alerts', (SELECT count(*) FROM ops.alerts WHERE NOT acknowledged AND source = 'payments'))
$$;

CREATE OR REPLACE FUNCTION mock.pos_handle(p_key text, p_order_id text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    c        mock.pos_config%ROWTYPE;
    v_prev   mock.pos_orders%ROWTYPE;
    v_calls  int;
    v_pos    text;
BEGIN
    IF coalesce(p_key, '') = '' THEN
        RETURN jsonb_build_object('http_status', 400, 'body', jsonb_build_object('error', 'Idempotency-Key header is required'));
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext(p_key));
    SELECT * INTO c FROM mock.pos_config;

    SELECT * INTO v_prev FROM mock.pos_orders WHERE idempotency_key = p_key;
    IF v_prev.idempotency_key IS NOT NULL THEN
        INSERT INTO mock.pos_calls (idempotency_key, order_id, http_status) VALUES (p_key, p_order_id, 200);
        RETURN jsonb_build_object('http_status', 200, 'body',
            jsonb_build_object('pos_order_id', v_prev.pos_order_id, 'idempotent_replay', true));
    END IF;

    SELECT count(*) INTO v_calls FROM mock.pos_calls WHERE idempotency_key = p_key;
    IF v_calls < c.fail_first_n OR p_order_id = ANY (c.always_fail_orders) THEN
        INSERT INTO mock.pos_calls (idempotency_key, order_id, http_status) VALUES (p_key, p_order_id, 503);
        RETURN jsonb_build_object('http_status', 503, 'body', jsonb_build_object('error', 'POS temporarily unavailable'));
    END IF;

    v_pos := 'POS-' || nextval('mock.pos_order_seq');
    INSERT INTO mock.pos_orders (idempotency_key, pos_order_id, order_id) VALUES (p_key, v_pos, p_order_id);
    INSERT INTO mock.pos_calls (idempotency_key, order_id, http_status) VALUES (p_key, p_order_id, 201);
    RETURN jsonb_build_object('http_status', 201, 'body', jsonb_build_object('pos_order_id', v_pos));
END
$$;
