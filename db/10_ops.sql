CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.workflow_errors (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    workflow_id     text,
    workflow_name   text,
    execution_id    text,
    execution_url   text,
    node_name       text,
    error_message   text,
    error_stack     text,
    mode            text
);

CREATE TABLE IF NOT EXISTS ops.alerts (
    id           bigserial PRIMARY KEY,
    created_at   timestamptz NOT NULL DEFAULT now(),
    severity     text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    source       text NOT NULL,
    title        text NOT NULL,
    details      jsonb NOT NULL DEFAULT '{}'::jsonb,
    acknowledged boolean NOT NULL DEFAULT false
);
