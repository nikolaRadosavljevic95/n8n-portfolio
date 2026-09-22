TRUNCATE booking.outbox, booking.tool_invocations, booking.calls, booking.appointments, booking.customers,
         booking.time_off, booking.working_hours, booking.staff_services, booking.staff, booking.services,
         crm.tasks, crm.contacts RESTART IDENTITY CASCADE;

INSERT INTO booking.services (name, duration_min, buffer_min, price, synonyms) VALUES
    ('Women''s haircut', 60, 10, 45.00, 'ladies cut womens cut woman haircut trim for women'),
    ('Men''s haircut',   30,  5, 20.00, 'gents cut mens cut man haircut barber'),
    ('Hair colouring',  120, 15, 85.00, 'color colour dye highlights balayage roots'),
    ('Blow-dry',         30,  5, 20.00, 'blowout blow dry styling'),
    ('Beard trim',       15,  5, 10.00, 'beard shave');

INSERT INTO booking.staff (name) VALUES ('Ana'), ('Marko'), ('Jelena');

INSERT INTO booking.staff_services (staff_id, service_id) VALUES
    (1, 1), (1, 3), (1, 4),
    (2, 1), (2, 2), (2, 5),
    (3, 1), (3, 3), (3, 4);

INSERT INTO booking.working_hours (staff_id, weekday, start_time, end_time)
SELECT 1, d, time '09:00', time '17:00' FROM generate_series(1, 5) d
UNION ALL SELECT 2, d, time '11:00', time '19:00' FROM generate_series(2, 6) d
UNION ALL SELECT 3, d, time '10:00', time '14:00' FROM generate_series(1, 5) d
UNION ALL SELECT 3, d, time '15:00', time '18:00' FROM generate_series(1, 5) d
UNION ALL SELECT 3, 6, time '09:00', time '13:00';

INSERT INTO booking.time_off (staff_id, during, reason)
SELECT 1, tstzrange(((current_date + 9)::timestamp AT TIME ZONE 'Europe/Belgrade'),
                    ((current_date + 11)::timestamp AT TIME ZONE 'Europe/Belgrade')), 'Training';

INSERT INTO booking.customers (phone_e164, name) VALUES
    ('+381641112233', 'Milica Petrović'),
    ('+381652223344', 'Stefan Ilić');

WITH next_workday AS (
    SELECT d::date AS day FROM generate_series(current_date + 2, current_date + 9, interval '1 day') d
    WHERE extract(isodow FROM d) BETWEEN 2 AND 5 ORDER BY d LIMIT 1
)
INSERT INTO booking.appointments (ref, staff_id, service_id, customer_id, starts_at, ends_at, during, source)
SELECT v.ref, v.staff_id, v.service_id, v.customer_id,
       (day + v.t) AT TIME ZONE 'Europe/Belgrade',
       (day + v.t) AT TIME ZONE 'Europe/Belgrade' + make_interval(mins => sv.duration_min),
       tstzrange((day + v.t) AT TIME ZONE 'Europe/Belgrade',
                 (day + v.t) AT TIME ZONE 'Europe/Belgrade' + make_interval(mins => sv.duration_min + sv.buffer_min)),
       'web'
FROM next_workday,
     (VALUES ('MIL001', 1, 1, 1, time '10:00'), ('STE001', 2, 2, 2, time '12:00'), ('MIL002', 3, 3, 1, time '15:00'))
       AS v(ref, staff_id, service_id, customer_id, t)
JOIN booking.services sv ON sv.id = v.service_id;
