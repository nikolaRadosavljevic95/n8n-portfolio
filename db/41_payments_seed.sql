TRUNCATE pay.order_events, pay.inbox, pay.orders, mock.pos_calls, mock.pos_orders RESTART IDENTITY CASCADE;
UPDATE mock.pos_config SET fail_first_n = 0, always_fail_orders = '{}';
UPDATE pay.config SET max_attempts = 6, base_backoff_seconds = 30, max_backoff_seconds = 3600;
ALTER SEQUENCE mock.pos_order_seq RESTART WITH 50001;

INSERT INTO pay.orders (id, customer_email, amount_cents, currency)
SELECT 'ord_' || (1000 + g), 'customer' || g || '@example.com', 1990 + g * 750, 'eur'
FROM generate_series(1, 20) g;
