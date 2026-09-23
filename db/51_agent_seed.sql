-- Sample shop for demo 4: a small online electronics retailer.
-- Dates are relative to now(), so the return window rules behave the same
-- whenever the suite runs.

TRUNCATE agent.run_steps, agent.tool_calls, agent.approvals, agent.runs, agent.conversations,
         agent.refunds, agent.order_items, agent.orders, agent.customers RESTART IDENTITY CASCADE;

UPDATE agent.config
   SET return_window_days = 30, auto_refund_limit_cents = 5000, max_steps = 6,
       cancellable_statuses = '{placed,paid,packing}',
       refundable_statuses  = '{paid,shipped,delivered,partially_refunded}';

INSERT INTO agent.customers (id, email, full_name, phone) VALUES
    (1, 'jelena.markovic@example.com', 'Jelena Marković', '+381641234567'),
    (2, 'milos.petrovic@example.com',  'Miloš Petrović',  '+381649876543'),
    (3, 'ana.kovac@example.com',       'Ana Kovač',       '+381631112223');
ALTER SEQUENCE agent.customers_id_seq RESTART WITH 4;

INSERT INTO agent.orders (id, customer_id, status, total_cents, carrier, tracking_no,
                          placed_at, shipped_at, delivered_at) VALUES
    -- Jelena: a delivered order small enough for the agent to refund on its own
    ('ORD-2041', 1, 'delivered',  3490, 'BEX', 'BEX7741002', now() - interval '9 days',  now() - interval '7 days', now() - interval '5 days'),
    -- in transit, the "where is my parcel" case
    ('ORD-2042', 1, 'shipped',    8750, 'Post Express', 'PE5590188', now() - interval '3 days', now() - interval '2 days', NULL),
    -- not shipped yet, so it can still be cancelled
    ('ORD-2043', 1, 'paid',       5990, NULL, NULL, now() - interval '20 hours', NULL, NULL),
    -- delivered long ago: outside the 30 day return window
    ('ORD-2044', 1, 'delivered',  2990, 'BEX', 'BEX7712004', now() - interval '95 days', now() - interval '93 days', now() - interval '90 days'),
    -- delivered, but too expensive for the agent to refund without a human
    ('ORD-2045', 1, 'delivered', 12900, 'BEX', 'BEX7741119', now() - interval '6 days', now() - interval '5 days', now() - interval '3 days'),
    -- already on its way, so cancelling is no longer possible
    ('ORD-2046', 1, 'shipped',    4590, 'Post Express', 'PE5590231', now() - interval '4 days', now() - interval '1 day', NULL),
    -- Miloš. Nothing Jelena's conversation does may ever touch this row.
    ('ORD-2090', 2, 'delivered', 45000, 'BEX', 'BEX7799001', now() - interval '8 days', now() - interval '6 days', now() - interval '4 days'),
    -- Ana, for the concurrency test
    ('ORD-2120', 3, 'delivered',  4000, 'BEX', 'BEX7800115', now() - interval '7 days', now() - interval '5 days', now() - interval '2 days');

INSERT INTO agent.order_items (order_id, line_no, sku, name, qty, unit_price_cents) VALUES
    ('ORD-2041', 1, 'HD-ANC-200',  'Wireless headphones ANC 200',      1, 3490),
    ('ORD-2042', 1, 'KB-MECH-87',  'Mechanical keyboard 87 keys',      1, 6900),
    ('ORD-2042', 2, 'MS-ERG-3',    'Ergonomic mouse',                  1, 1850),
    ('ORD-2043', 1, 'MON-27-QHD',  '27" QHD monitor',                  1, 5990),
    ('ORD-2044', 1, 'CBL-USBC-2M', 'USB-C cable 2 m',                  2, 1495),
    ('ORD-2045', 1, 'TAB-10-128',  'Tablet 10" 128 GB',                1, 12900),
    ('ORD-2046', 1, 'SPK-BT-40',   'Bluetooth speaker 40 W',           1, 4590),
    ('ORD-2090', 2, 'LPT-14-512',  'Laptop 14" 512 GB',                1, 45000),
    ('ORD-2120', 1, 'PWB-20K',     'Power bank 20000 mAh',             1, 4000);
