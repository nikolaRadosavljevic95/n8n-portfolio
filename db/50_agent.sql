-- Demo 4: a support agent that is allowed to act.
--
-- The LLM decides *what to try*. Everything it is allowed to do lives here, in
-- SQL, because a system prompt is a request and a constraint is a guarantee.
-- agent.execute_tool() is the only door between the model and the business:
-- it validates arguments, scopes every lookup to the customer who is actually
-- in the conversation, enforces the money rules, holds anything expensive for a
-- human, is idempotent per tool call, and writes an audit row either way.

CREATE SCHEMA IF NOT EXISTS agent;

-- Business policy, the part a merchant would want to change. Technical knobs
-- (timeouts, LLM model, base URL) stay in the environment, not here.
CREATE TABLE IF NOT EXISTS agent.config (
    id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
    return_window_days        int     NOT NULL DEFAULT 30,
    -- A refund at or below this is the agent's to make. Above it, a human decides.
    auto_refund_limit_cents   int     NOT NULL DEFAULT 5000,
    -- How many LLM turns one message may cost before the run is handed over.
    max_steps                 int     NOT NULL DEFAULT 6,
    cancellable_statuses      text[]  NOT NULL DEFAULT '{placed,paid,packing}',
    refundable_statuses       text[]  NOT NULL DEFAULT '{paid,shipped,delivered,partially_refunded}',
    currency                  text    NOT NULL DEFAULT 'eur'
);
INSERT INTO agent.config DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS agent.customers (
    id          bigserial PRIMARY KEY,
    email       text NOT NULL UNIQUE,
    full_name   text NOT NULL,
    phone       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent.orders (
    id            text PRIMARY KEY,
    customer_id   bigint NOT NULL REFERENCES agent.customers (id),
    status        text NOT NULL DEFAULT 'placed'
                  CHECK (status IN ('placed', 'paid', 'packing', 'shipped', 'delivered',
                                    'cancelled', 'refunded', 'partially_refunded')),
    total_cents   int NOT NULL CHECK (total_cents > 0),
    currency      text NOT NULL DEFAULT 'eur',
    carrier       text,
    tracking_no   text,
    placed_at     timestamptz NOT NULL DEFAULT now(),
    shipped_at    timestamptz,
    delivered_at  timestamptz,
    cancelled_at  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON agent.orders (customer_id, placed_at DESC);

CREATE TABLE IF NOT EXISTS agent.order_items (
    order_id          text NOT NULL REFERENCES agent.orders (id) ON DELETE CASCADE,
    line_no           int  NOT NULL,
    sku               text NOT NULL,
    name              text NOT NULL,
    qty               int  NOT NULL CHECK (qty > 0),
    unit_price_cents  int  NOT NULL CHECK (unit_price_cents >= 0),
    PRIMARY KEY (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS agent.refunds (
    id            bigserial PRIMARY KEY,
    order_id      text NOT NULL REFERENCES agent.orders (id),
    amount_cents  int  NOT NULL CHECK (amount_cents > 0),
    reason        text NOT NULL,
    -- Who actually authorised the money: the agent, or the person who approved it.
    authorised_by text NOT NULL DEFAULT 'agent',
    run_id        bigint,
    tool_call_id  text UNIQUE,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refunds_order_idx ON agent.refunds (order_id);

CREATE TABLE IF NOT EXISTS agent.conversations (
    id           bigserial PRIMARY KEY,
    customer_id  bigint NOT NULL REFERENCES agent.customers (id),
    channel      text NOT NULL CHECK (channel IN ('email', 'chat', 'whatsapp')),
    opened_at    timestamptz NOT NULL DEFAULT now()
);

-- One inbound customer message, and everything the agent did about it.
CREATE TABLE IF NOT EXISTS agent.runs (
    id               bigserial PRIMARY KEY,
    conversation_id  bigint NOT NULL REFERENCES agent.conversations (id),
    customer_id      bigint NOT NULL REFERENCES agent.customers (id),
    request_id       text NOT NULL UNIQUE,
    message          text NOT NULL,
    status           text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'answered', 'escalated', 'awaiting_approval', 'failed')),
    outcome          text,
    reply            text,
    steps_used       int NOT NULL DEFAULT 0,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz
);

-- The audit trail. Every model turn and every tool call, including the refused
-- ones, in order, with the arguments and the result. A run can be read back
-- line by line months later without the model or the logs.
CREATE TABLE IF NOT EXISTS agent.run_steps (
    id          bigserial PRIMARY KEY,
    run_id      bigint NOT NULL REFERENCES agent.runs (id) ON DELETE CASCADE,
    step_no     int    NOT NULL,
    kind        text   NOT NULL CHECK (kind IN ('assistant', 'tool')),
    tool        text,
    args        jsonb,
    result      jsonb,
    status      text,
    latency_ms  int,
    at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, step_no)
);

-- Anything the agent is not allowed to do on its own waits here.
CREATE TABLE IF NOT EXISTS agent.approvals (
    id            bigserial PRIMARY KEY,
    run_id        bigint NOT NULL REFERENCES agent.runs (id),
    customer_id   bigint NOT NULL REFERENCES agent.customers (id),
    action        text   NOT NULL,
    args          jsonb  NOT NULL,
    amount_cents  int,
    reason        text   NOT NULL,
    status        text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    tool_call_id  text   NOT NULL UNIQUE,
    requested_at  timestamptz NOT NULL DEFAULT now(),
    decided_at    timestamptz,
    decided_by    text,
    result        jsonb
);
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON agent.approvals (requested_at) WHERE status = 'pending';

-- Idempotency for tool calls. A voice or chat platform that retries, or an n8n
-- execution replayed after a crash, must not refund twice.
CREATE TABLE IF NOT EXISTS agent.tool_calls (
    id         text PRIMARY KEY,
    run_id     bigint NOT NULL REFERENCES agent.runs (id) ON DELETE CASCADE,
    tool       text   NOT NULL,
    args       jsonb  NOT NULL,
    result     jsonb  NOT NULL,
    called_at  timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- The tool catalogue.
--
-- The same rows are sent to the model as OpenAI tool definitions and used to
-- validate what comes back, so the description the model reads and the rule
-- that is enforced can never drift apart.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent.tools (
    name         text PRIMARY KEY,
    description  text NOT NULL,
    parameters   jsonb NOT NULL,
    required     text[] NOT NULL DEFAULT '{}',
    -- true when the tool changes something a customer would notice
    writes       boolean NOT NULL DEFAULT false,
    enabled      boolean NOT NULL DEFAULT true
);

INSERT INTO agent.tools (name, description, parameters, required, writes) VALUES
('lookup_order',
 'Look up one of this customer''s orders, or list their recent orders when order_id is omitted. Returns status, totals, items and refunds.',
 '{"type":"object","properties":{"order_id":{"type":"string","description":"Order reference such as ORD-2043. Omit to list recent orders."}},"additionalProperties":false}'::jsonb,
 '{}', false),
('track_shipment',
 'Get the carrier, tracking number and delivery status for one of this customer''s orders.',
 '{"type":"object","properties":{"order_id":{"type":"string"}},"additionalProperties":false}'::jsonb,
 '{order_id}', false),
('get_policy',
 'Read the shop''s own policy. Use this instead of stating a policy from memory. Topics: returns, cancellation, refunds.',
 '{"type":"object","properties":{"topic":{"type":"string","enum":["returns","cancellation","refunds"]}},"additionalProperties":false}'::jsonb,
 '{topic}', false),
('cancel_order',
 'Cancel an order that has not shipped yet.',
 '{"type":"object","properties":{"order_id":{"type":"string"},"reason":{"type":"string"}},"additionalProperties":false}'::jsonb,
 '{order_id,reason}', true),
('issue_refund',
 'Refund part or all of an order. Small refunds go through immediately; larger ones are held for a human to approve.',
 '{"type":"object","properties":{"order_id":{"type":"string"},"amount_cents":{"type":"integer","minimum":1},"reason":{"type":"string"}},"additionalProperties":false}'::jsonb,
 '{order_id,amount_cents,reason}', true),
('escalate_to_human',
 'Hand the conversation to a person. Use when the customer asks for one, when the request is outside these tools, or when you are unsure.',
 '{"type":"object","properties":{"reason":{"type":"string"}},"additionalProperties":false}'::jsonb,
 '{reason}', true)
ON CONFLICT (name) DO UPDATE
  SET description = EXCLUDED.description,
      parameters  = EXCLUDED.parameters,
      required    = EXCLUDED.required,
      writes      = EXCLUDED.writes;

-- OpenAI-shaped tool list for the chat completions request.
CREATE OR REPLACE FUNCTION agent.tool_definitions() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'type', 'function',
               'function', jsonb_build_object(
                   'name', t.name,
                   'description', t.description,
                   'parameters', t.parameters || jsonb_build_object('required', to_jsonb(t.required))
               )
           ) ORDER BY t.name), '[]'::jsonb)
    FROM agent.tools t
    WHERE t.enabled
$$;

CREATE OR REPLACE FUNCTION agent.refunded_cents(p_order_id text) RETURNS int
LANGUAGE sql STABLE AS $$
    SELECT coalesce(sum(amount_cents), 0)::int FROM agent.refunds WHERE order_id = p_order_id
$$;

-- An order as the customer would see it. Always called with the customer id of
-- the conversation, never with one the model supplied.
CREATE OR REPLACE FUNCTION agent.order_view(p_order_id text, p_customer_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
               'order_id', o.id,
               'status', o.status,
               'placed_at', to_char(o.placed_at, 'YYYY-MM-DD'),
               'total_cents', o.total_cents,
               'currency', o.currency,
               'refunded_cents', agent.refunded_cents(o.id),
               'refundable_cents', greatest(o.total_cents - agent.refunded_cents(o.id), 0),
               'delivered_at', to_char(o.delivered_at, 'YYYY-MM-DD'),
               'items', coalesce((
                   SELECT jsonb_agg(jsonb_build_object('sku', i.sku, 'name', i.name, 'qty', i.qty,
                                                       'unit_price_cents', i.unit_price_cents)
                                    ORDER BY i.line_no)
                   FROM agent.order_items i WHERE i.order_id = o.id), '[]'::jsonb)
           )
    FROM agent.orders o
    WHERE o.id = p_order_id AND o.customer_id = p_customer_id
$$;


-- ---------------------------------------------------------------------------
-- Run lifecycle
-- ---------------------------------------------------------------------------

-- Idempotent per request_id, so a retry from the chat widget or a replayed n8n
-- execution continues the same run instead of starting a second one.
CREATE OR REPLACE FUNCTION agent.start_run(p_customer_id bigint, p_channel text, p_message text, p_request_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_conv bigint;
    v_run  agent.runs;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM agent.customers WHERE id = p_customer_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unknown_customer');
    END IF;
    IF coalesce(btrim(p_message), '') = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'empty_message');
    END IF;

    SELECT * INTO v_run FROM agent.runs WHERE request_id = p_request_id;
    IF FOUND THEN
        RETURN jsonb_build_object('ok', true, 'run_id', v_run.id, 'customer_id', v_run.customer_id,
                                  'duplicate', true, 'status', v_run.status, 'reply', v_run.reply);
    END IF;

    SELECT id INTO v_conv FROM agent.conversations
    WHERE customer_id = p_customer_id AND channel = p_channel
    ORDER BY opened_at DESC LIMIT 1;
    IF v_conv IS NULL THEN
        INSERT INTO agent.conversations (customer_id, channel) VALUES (p_customer_id, p_channel) RETURNING id INTO v_conv;
    END IF;

    INSERT INTO agent.runs (conversation_id, customer_id, request_id, message)
    VALUES (v_conv, p_customer_id, p_request_id, p_message)
    RETURNING * INTO v_run;

    RETURN jsonb_build_object('ok', true, 'run_id', v_run.id, 'customer_id', v_run.customer_id, 'duplicate', false);
END $$;

-- Everything the next LLM turn needs, read back from the audit trail rather
-- than carried in the workflow execution. A run survives a restart, and the
-- messages the model sees are exactly what was recorded.
CREATE OR REPLACE FUNCTION agent.run_context(p_run_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_run      agent.runs;
    v_cfg      agent.config;
    v_customer agent.customers;
    v_messages jsonb := '[]'::jsonb;
BEGIN
    SELECT * INTO v_run FROM agent.runs WHERE id = p_run_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_run'); END IF;
    SELECT * INTO v_cfg FROM agent.config WHERE id;
    SELECT * INTO v_customer FROM agent.customers WHERE id = v_run.customer_id;

    SELECT coalesce(jsonb_agg(m ORDER BY step_no, ord), '[]'::jsonb) INTO v_messages
    FROM (
        SELECT s.step_no, 0 AS ord,
               jsonb_build_object('role', 'assistant',
                                  'content', s.result->>'content',
                                  'tool_calls', s.result->'tool_calls') AS m
        FROM agent.run_steps s
        WHERE s.run_id = p_run_id AND s.kind = 'assistant'
        UNION ALL
        SELECT s.step_no, 1,
               jsonb_build_object('role', 'tool',
                                  'tool_call_id', s.args->>'tool_call_id',
                                  'content', s.result::text)
        FROM agent.run_steps s
        WHERE s.run_id = p_run_id AND s.kind = 'tool'
    ) x;

    RETURN jsonb_build_object(
        'ok', true,
        'run_id', v_run.id,
        'customer_id', v_run.customer_id,
        'customer_name', v_customer.full_name,
        'status', v_run.status,
        'message', v_run.message,
        'steps_used', v_run.steps_used,
        'max_steps', v_cfg.max_steps,
        'budget_left', greatest(v_cfg.max_steps - v_run.steps_used, 0),
        'messages', v_messages,
        'tools', agent.tool_definitions()
    );
END $$;

-- Record one model turn (its text, and any tool calls it asked for).
CREATE OR REPLACE FUNCTION agent.record_assistant(p_run_id bigint, p_content text, p_tool_calls jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_step int;
BEGIN
    SELECT coalesce(max(step_no), 0) + 1 INTO v_step FROM agent.run_steps WHERE run_id = p_run_id;
    INSERT INTO agent.run_steps (run_id, step_no, kind, result, status)
    VALUES (p_run_id, v_step, 'assistant',
            jsonb_build_object('content', p_content, 'tool_calls', coalesce(p_tool_calls, '[]'::jsonb)),
            CASE WHEN jsonb_array_length(coalesce(p_tool_calls, '[]'::jsonb)) > 0 THEN 'tool_calls' ELSE 'final' END);
    UPDATE agent.runs SET steps_used = steps_used + 1 WHERE id = p_run_id;
    RETURN jsonb_build_object('ok', true, 'step_no', v_step);
END $$;

-- Closes a run. The final status is read back out of the audit trail rather
-- than taken from the workflow: if a tool escalated or parked a refund for
-- approval, that is what happened, whatever the model went on to say.
CREATE OR REPLACE FUNCTION agent.finish_run(p_run_id bigint, p_reply text,
                                            p_fallback_status text, p_outcome text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_run     agent.runs;
    v_status  text;
    v_outcome text := p_outcome;
BEGIN
    IF EXISTS (SELECT 1 FROM agent.run_steps
                WHERE run_id = p_run_id AND kind = 'tool' AND status = 'needs_approval') THEN
        v_status  := 'awaiting_approval';
        v_outcome := 'awaiting_approval';
    ELSIF EXISTS (SELECT 1 FROM agent.run_steps
                   WHERE run_id = p_run_id AND kind = 'tool' AND status = 'escalated') THEN
        v_status  := 'escalated';
        v_outcome := 'escalated_to_human';
    ELSE
        v_status := p_fallback_status;
    END IF;

    UPDATE agent.runs
       SET status = v_status, outcome = v_outcome, reply = p_reply, finished_at = now()
     WHERE id = p_run_id
    RETURNING * INTO v_run;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_run'); END IF;

    RETURN jsonb_build_object('ok', true, 'run_id', v_run.id, 'status', v_run.status,
                              'outcome', v_run.outcome, 'reply', v_run.reply,
                              'steps_used', v_run.steps_used);
END $$;


-- ---------------------------------------------------------------------------
-- The money path, shared by the agent and by a human approval.
--
-- It revalidates every time. An approval that a person clicks twenty minutes
-- later must not move money the order can no longer justify.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent.refund_precheck(p_customer_id bigint, p_order_id text, p_amount int)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_order      agent.orders;
    v_cfg        agent.config;
    v_refunded   int;
    v_refundable int;
    v_window_end date;
BEGIN
    SELECT * INTO v_cfg FROM agent.config WHERE id;

    -- Scoped to the customer in the conversation. An order id that belongs to
    -- somebody else does not exist as far as this conversation is concerned,
    -- and it is refused here, before the amount is even looked at, so a
    -- stranger's order can never reach the approval queue.
    SELECT * INTO v_order FROM agent.orders
     WHERE id = p_order_id AND customer_id = p_customer_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'not_found', 'reason', 'order_not_found_for_customer',
                                  'order_id', p_order_id);
    END IF;

    IF NOT (v_order.status = ANY (v_cfg.refundable_statuses)) THEN
        RETURN jsonb_build_object('status', 'refused', 'reason', 'order_not_refundable',
                                  'order_status', v_order.status);
    END IF;

    v_window_end := (coalesce(v_order.delivered_at, v_order.placed_at)
                     + (v_cfg.return_window_days || ' days')::interval)::date;
    IF current_date > v_window_end THEN
        RETURN jsonb_build_object('status', 'refused', 'reason', 'outside_return_window',
                                  'return_window_days', v_cfg.return_window_days,
                                  'window_ended', to_char(v_window_end, 'YYYY-MM-DD'));
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('status', 'invalid_args', 'reason', 'amount_must_be_positive');
    END IF;

    v_refunded   := agent.refunded_cents(v_order.id);
    v_refundable := v_order.total_cents - v_refunded;
    IF p_amount > v_refundable THEN
        RETURN jsonb_build_object('status', 'refused', 'reason', 'amount_exceeds_refundable',
                                  'requested_cents', p_amount, 'refundable_cents', v_refundable);
    END IF;

    RETURN jsonb_build_object('status', 'ok', 'order_id', v_order.id, 'currency', v_order.currency,
                              'refundable_cents', v_refundable, 'already_refunded_cents', v_refunded);
END $$;


-- Moves the money. Runs the same checks again, because an approval a person
-- clicks twenty minutes later must not act on the order as it was back then.
CREATE OR REPLACE FUNCTION agent.apply_refund(p_run_id bigint, p_customer_id bigint, p_order_id text,
                                              p_amount int, p_reason text, p_tool_call_id text,
                                              p_authorised_by text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_check    jsonb;
    v_total    int;
    v_refunded int;
BEGIN
    PERFORM 1 FROM agent.orders WHERE id = p_order_id AND customer_id = p_customer_id FOR UPDATE;

    v_check := agent.refund_precheck(p_customer_id, p_order_id, p_amount);
    IF v_check->>'status' <> 'ok' THEN RETURN v_check; END IF;

    INSERT INTO agent.refunds (order_id, amount_cents, reason, authorised_by, run_id, tool_call_id)
    VALUES (p_order_id, p_amount, p_reason, p_authorised_by, p_run_id, p_tool_call_id)
    ON CONFLICT (tool_call_id) DO NOTHING;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'ok', 'duplicate', true, 'order_id', p_order_id,
                                  'total_refunded_cents', agent.refunded_cents(p_order_id));
    END IF;

    SELECT total_cents INTO v_total FROM agent.orders WHERE id = p_order_id;
    v_refunded := agent.refunded_cents(p_order_id);

    UPDATE agent.orders
       SET status = CASE WHEN v_refunded >= v_total THEN 'refunded' ELSE 'partially_refunded' END,
           updated_at = now()
     WHERE id = p_order_id;

    RETURN jsonb_build_object('status', 'ok', 'order_id', p_order_id, 'amount_cents', p_amount,
                              'currency', v_check->>'currency', 'authorised_by', p_authorised_by,
                              'total_refunded_cents', v_refunded);
END $$;


-- ---------------------------------------------------------------------------
-- The only door between the model and the business.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent.execute_tool(p_run_id bigint, p_tool_call_id text, p_tool text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_run     agent.runs;
    v_cfg     agent.config;
    v_tool    agent.tools;
    v_prev    jsonb;
    v_result  jsonb;
    v_check   jsonb;
    v_args    jsonb := coalesce(p_args, '{}'::jsonb);
    v_order   agent.orders;
    v_amount  int;
    v_key     text;
    v_step    int;
    v_started timestamptz := clock_timestamp();
BEGIN
    SELECT * INTO v_run FROM agent.runs WHERE id = p_run_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'refused', 'reason', 'unknown_run'); END IF;
    SELECT * INTO v_cfg FROM agent.config WHERE id;

    -- A retry returns the first answer instead of acting again.
    SELECT result INTO v_prev FROM agent.tool_calls WHERE id = p_tool_call_id;
    IF FOUND THEN RETURN v_prev || jsonb_build_object('duplicate', true); END IF;

    SELECT * INTO v_tool FROM agent.tools WHERE name = p_tool AND enabled;
    IF NOT FOUND THEN
        v_result := jsonb_build_object('status', 'refused', 'reason', 'unknown_tool', 'tool', p_tool);
    ELSE
        -- Required arguments, from the same row the model was shown.
        v_key := NULL;
        SELECT r INTO v_key FROM unnest(v_tool.required) r
         WHERE v_args->>r IS NULL OR btrim(v_args->>r) = '' LIMIT 1;
        IF v_key IS NOT NULL THEN
            v_result := jsonb_build_object('status', 'invalid_args', 'reason', 'missing_' || v_key);

        ELSIF p_tool = 'lookup_order' THEN
            IF v_args->>'order_id' IS NULL THEN
                v_result := jsonb_build_object('status', 'ok', 'orders', coalesce((
                    SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'status', o.status,
                                                        'placed_at', to_char(o.placed_at, 'YYYY-MM-DD'),
                                                        'total_cents', o.total_cents)
                                     ORDER BY o.placed_at DESC)
                    FROM (SELECT * FROM agent.orders WHERE customer_id = v_run.customer_id
                          ORDER BY placed_at DESC LIMIT 5) o), '[]'::jsonb));
            ELSE
                v_result := agent.order_view(v_args->>'order_id', v_run.customer_id);
                IF v_result IS NULL THEN
                    v_result := jsonb_build_object('status', 'not_found', 'reason', 'order_not_found_for_customer',
                                                   'order_id', v_args->>'order_id');
                ELSE
                    v_result := v_result || jsonb_build_object('status', 'ok');
                END IF;
            END IF;

        ELSIF p_tool = 'track_shipment' THEN
            SELECT * INTO v_order FROM agent.orders
             WHERE id = v_args->>'order_id' AND customer_id = v_run.customer_id;
            IF NOT FOUND THEN
                v_result := jsonb_build_object('status', 'not_found', 'reason', 'order_not_found_for_customer',
                                               'order_id', v_args->>'order_id');
            ELSE
                v_result := jsonb_build_object('status', 'ok', 'order_id', v_order.id,
                                               'order_status', v_order.status,
                                               'carrier', v_order.carrier, 'tracking_no', v_order.tracking_no,
                                               'shipped_at', to_char(v_order.shipped_at, 'YYYY-MM-DD'),
                                               'delivered_at', to_char(v_order.delivered_at, 'YYYY-MM-DD'));
            END IF;

        ELSIF p_tool = 'get_policy' THEN
            v_result := CASE v_args->>'topic'
                WHEN 'returns' THEN jsonb_build_object('status', 'ok', 'topic', 'returns',
                    'return_window_days', v_cfg.return_window_days,
                    'text', format('Items can be returned within %s days of delivery.', v_cfg.return_window_days))
                WHEN 'cancellation' THEN jsonb_build_object('status', 'ok', 'topic', 'cancellation',
                    'cancellable_statuses', to_jsonb(v_cfg.cancellable_statuses),
                    'text', 'An order can be cancelled until it ships.')
                WHEN 'refunds' THEN jsonb_build_object('status', 'ok', 'topic', 'refunds',
                    'auto_refund_limit_cents', v_cfg.auto_refund_limit_cents,
                    'text', format('Refunds up to %s %s are made immediately; larger ones are approved by a colleague first.',
                                   (v_cfg.auto_refund_limit_cents / 100.0)::numeric(12,2), upper(v_cfg.currency)))
                ELSE jsonb_build_object('status', 'invalid_args', 'reason', 'unknown_topic',
                                        'topic', v_args->>'topic')
            END;

        ELSIF p_tool = 'cancel_order' THEN
            SELECT * INTO v_order FROM agent.orders
             WHERE id = v_args->>'order_id' AND customer_id = v_run.customer_id FOR UPDATE;
            IF NOT FOUND THEN
                v_result := jsonb_build_object('status', 'not_found', 'reason', 'order_not_found_for_customer',
                                               'order_id', v_args->>'order_id');
            ELSIF NOT (v_order.status = ANY (v_cfg.cancellable_statuses)) THEN
                v_result := jsonb_build_object('status', 'refused', 'reason', 'order_already_' || v_order.status,
                                               'order_status', v_order.status);
            ELSE
                UPDATE agent.orders SET status = 'cancelled', cancelled_at = now(), updated_at = now()
                 WHERE id = v_order.id;
                v_result := jsonb_build_object('status', 'ok', 'order_id', v_order.id, 'order_status', 'cancelled');
            END IF;

        ELSIF p_tool = 'issue_refund' THEN
            v_amount := CASE WHEN jsonb_typeof(v_args->'amount_cents') = 'number'
                             THEN (v_args->>'amount_cents')::numeric::int ELSE NULL END;
            -- Order first, amount second. Whether a human may be asked to
            -- approve this is the last question, not the first one.
            v_check := agent.refund_precheck(v_run.customer_id, v_args->>'order_id', v_amount);
            IF v_amount IS NULL OR v_amount <= 0 THEN
                v_result := jsonb_build_object('status', 'invalid_args', 'reason', 'amount_cents_must_be_a_positive_integer');
            ELSIF v_check->>'status' <> 'ok' THEN
                v_result := v_check;
            ELSIF v_amount > v_cfg.auto_refund_limit_cents THEN
                -- Above the limit the agent may ask, not act. Nothing moves here.
                INSERT INTO agent.approvals (run_id, customer_id, action, args, amount_cents, reason, tool_call_id)
                VALUES (p_run_id, v_run.customer_id, 'issue_refund', v_args, v_amount,
                        coalesce(v_args->>'reason', 'no reason given'), p_tool_call_id)
                ON CONFLICT (tool_call_id) DO NOTHING;
                v_result := jsonb_build_object('status', 'needs_approval',
                                               'reason', 'above_auto_refund_limit',
                                               'auto_refund_limit_cents', v_cfg.auto_refund_limit_cents,
                                               'requested_cents', v_amount,
                                               'approval_id', (SELECT id FROM agent.approvals WHERE tool_call_id = p_tool_call_id));
            ELSE
                v_result := agent.apply_refund(p_run_id, v_run.customer_id, v_args->>'order_id',
                                               v_amount, coalesce(v_args->>'reason', 'no reason given'),
                                               p_tool_call_id, 'agent');
            END IF;

        ELSIF p_tool = 'escalate_to_human' THEN
            INSERT INTO agent.approvals (run_id, customer_id, action, args, reason, tool_call_id)
            VALUES (p_run_id, v_run.customer_id, 'escalate_to_human', v_args,
                    coalesce(v_args->>'reason', 'no reason given'), p_tool_call_id)
            ON CONFLICT (tool_call_id) DO NOTHING;
            v_result := jsonb_build_object('status', 'escalated', 'reason', v_args->>'reason');

        ELSE
            v_result := jsonb_build_object('status', 'refused', 'reason', 'tool_not_implemented', 'tool', p_tool);
        END IF;
    END IF;

    v_result := v_result || jsonb_build_object('tool', p_tool);

    INSERT INTO agent.tool_calls (id, run_id, tool, args, result)
    VALUES (p_tool_call_id, p_run_id, p_tool, v_args, v_result)
    ON CONFLICT (id) DO NOTHING;

    SELECT coalesce(max(step_no), 0) + 1 INTO v_step FROM agent.run_steps WHERE run_id = p_run_id;
    INSERT INTO agent.run_steps (run_id, step_no, kind, tool, args, result, status, latency_ms)
    VALUES (p_run_id, v_step, 'tool', p_tool,
            v_args || jsonb_build_object('tool_call_id', p_tool_call_id),
            v_result, v_result->>'status',
            (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int);

    RETURN v_result;
END $$;


-- ---------------------------------------------------------------------------
-- The human side of the gate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent.pending_approvals() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'approval_id', a.id, 'run_id', a.run_id, 'action', a.action,
               'customer', c.full_name, 'customer_email', c.email,
               'order_id', a.args->>'order_id', 'amount_cents', a.amount_cents,
               'reason', a.reason, 'customer_message', r.message,
               'requested_at', a.requested_at
           ) ORDER BY a.requested_at), '[]'::jsonb)
    FROM agent.approvals a
    JOIN agent.runs r ON r.id = a.run_id
    JOIN agent.customers c ON c.id = a.customer_id
    WHERE a.status = 'pending'
$$;

CREATE OR REPLACE FUNCTION agent.decide_approval(p_approval_id bigint, p_decision text, p_by text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_app    agent.approvals;
    v_result jsonb;
    v_step   int;
BEGIN
    IF p_decision NOT IN ('approved', 'rejected') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'decision_must_be_approved_or_rejected');
    END IF;

    SELECT * INTO v_app FROM agent.approvals WHERE id = p_approval_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_approval'); END IF;
    IF v_app.status <> 'pending' THEN
        -- Two people clicking approve must not refund twice.
        RETURN jsonb_build_object('ok', true, 'duplicate', true, 'approval_id', v_app.id,
                                  'status', v_app.status, 'result', v_app.result);
    END IF;

    IF p_decision = 'rejected' THEN
        v_result := jsonb_build_object('status', 'rejected', 'by', p_by);
    ELSIF v_app.action = 'issue_refund' THEN
        -- Revalidated against the order as it is now, not as it was when asked.
        v_result := agent.apply_refund(v_app.run_id, v_app.customer_id, v_app.args->>'order_id',
                                       v_app.amount_cents, v_app.reason,
                                       'approval:' || v_app.id::text, p_by);
    ELSE
        v_result := jsonb_build_object('status', 'acknowledged', 'action', v_app.action, 'by', p_by);
    END IF;

    UPDATE agent.approvals
       SET status = p_decision, decided_at = now(), decided_by = p_by, result = v_result
     WHERE id = v_app.id;

    SELECT coalesce(max(step_no), 0) + 1 INTO v_step FROM agent.run_steps WHERE run_id = v_app.run_id;
    INSERT INTO agent.run_steps (run_id, step_no, kind, tool, args, result, status)
    VALUES (v_app.run_id, v_step, 'tool', 'human_decision',
            jsonb_build_object('approval_id', v_app.id, 'decision', p_decision, 'by', p_by),
            v_result, v_result->>'status');

    UPDATE agent.runs
       SET status = CASE WHEN p_decision = 'approved' THEN 'answered' ELSE 'escalated' END,
           outcome = v_app.action || '_' || p_decision,
           finished_at = now()
     WHERE id = v_app.run_id AND status = 'awaiting_approval';

    RETURN jsonb_build_object('ok', true, 'approval_id', v_app.id, 'status', p_decision, 'result', v_result);
END $$;

-- One run, end to end, the way an auditor or a customer's lawyer would read it.
CREATE OR REPLACE FUNCTION agent.run_trace(p_run_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'run_id', r.id, 'customer_id', r.customer_id, 'message', r.message,
        'status', r.status, 'outcome', r.outcome, 'reply', r.reply, 'steps_used', r.steps_used,
        'steps', coalesce((
            SELECT jsonb_agg(jsonb_build_object('step_no', s.step_no, 'kind', s.kind, 'tool', s.tool,
                                                'args', s.args, 'result', s.result, 'status', s.status)
                             ORDER BY s.step_no)
            FROM agent.run_steps s WHERE s.run_id = r.id), '[]'::jsonb)
    )
    FROM agent.runs r WHERE r.id = p_run_id
$$;

CREATE OR REPLACE FUNCTION agent.health() RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'runs', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                 FROM (SELECT status, count(*) AS n FROM agent.runs GROUP BY status) x),
        'pending_approvals', (SELECT count(*) FROM agent.approvals WHERE status = 'pending'),
        'refunds', jsonb_build_object(
            'count', (SELECT count(*) FROM agent.refunds),
            'total_cents', (SELECT coalesce(sum(amount_cents), 0) FROM agent.refunds),
            'by_agent', (SELECT count(*) FROM agent.refunds WHERE authorised_by = 'agent')),
        'refused_tool_calls', (SELECT count(*) FROM agent.run_steps
                               WHERE kind = 'tool' AND status IN ('refused', 'not_found', 'invalid_args')),
        'open_alerts', (SELECT count(*) FROM ops.alerts WHERE NOT acknowledged)
    )
$$;
