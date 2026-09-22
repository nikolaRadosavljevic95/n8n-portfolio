CREATE SCHEMA IF NOT EXISTS booking;
CREATE SCHEMA IF NOT EXISTS crm;

CREATE TABLE IF NOT EXISTS booking.settings (
    id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
    business_name       text NOT NULL DEFAULT 'Studio Lumen',
    timezone            text NOT NULL DEFAULT 'Europe/Belgrade',
    default_country     text NOT NULL DEFAULT '381',
    min_lead_minutes    int  NOT NULL DEFAULT 60,
    slot_step_minutes   int  NOT NULL DEFAULT 15,
    offer_spread_min    int  NOT NULL DEFAULT 60,
    late_cancel_hours   int  NOT NULL DEFAULT 24,
    max_days_ahead      int  NOT NULL DEFAULT 30
);
INSERT INTO booking.settings DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS booking.services (
    id            serial PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    duration_min  int  NOT NULL CHECK (duration_min > 0),
    buffer_min    int  NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
    price         numeric(10, 2) NOT NULL,
    synonyms      text NOT NULL DEFAULT '',
    active        boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS booking.staff (
    id      serial PRIMARY KEY,
    name    text NOT NULL UNIQUE,
    active  boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS booking.staff_services (
    staff_id    int NOT NULL REFERENCES booking.staff (id),
    service_id  int NOT NULL REFERENCES booking.services (id),
    PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS booking.working_hours (
    staff_id    int      NOT NULL REFERENCES booking.staff (id),
    weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    start_time  time     NOT NULL,
    end_time    time     NOT NULL CHECK (end_time > start_time),
    PRIMARY KEY (staff_id, weekday, start_time)
);

CREATE TABLE IF NOT EXISTS booking.time_off (
    id        serial PRIMARY KEY,
    staff_id  int NOT NULL REFERENCES booking.staff (id),
    during    tstzrange NOT NULL,
    reason    text
);

CREATE TABLE IF NOT EXISTS booking.customers (
    id          serial PRIMARY KEY,
    phone_e164  text NOT NULL UNIQUE,
    name        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking.appointments (
    id                 bigserial PRIMARY KEY,
    ref                text NOT NULL UNIQUE DEFAULT upper(substr(md5(gen_random_uuid()::text), 1, 6)),
    staff_id           int  NOT NULL REFERENCES booking.staff (id),
    service_id         int  NOT NULL REFERENCES booking.services (id),
    customer_id        int  NOT NULL REFERENCES booking.customers (id),
    starts_at          timestamptz NOT NULL,
    ends_at            timestamptz NOT NULL,
    during             tstzrange NOT NULL,
    status             text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show')),
    source             text NOT NULL DEFAULT 'voice',
    call_id            text,
    tool_call_id       text UNIQUE,
    notes              text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    cancelled_at       timestamptz,
    late_cancellation  boolean NOT NULL DEFAULT false,
    CONSTRAINT no_double_booking EXCLUDE USING gist (staff_id WITH =, during WITH &&) WHERE (status = 'booked')
);
CREATE INDEX IF NOT EXISTS appointments_customer_idx ON booking.appointments (customer_id, starts_at);

CREATE TABLE IF NOT EXISTS booking.tool_invocations (
    tool_call_id  text PRIMARY KEY,
    call_id       text,
    provider      text NOT NULL,
    tool          text NOT NULL,
    args          jsonb NOT NULL DEFAULT '{}'::jsonb,
    result        jsonb NOT NULL,
    duration_ms   int,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_invocations_call_idx ON booking.tool_invocations (call_id);

CREATE TABLE IF NOT EXISTS booking.calls (
    call_id        text PRIMARY KEY,
    provider       text NOT NULL,
    caller_phone   text,
    started_at     timestamptz,
    ended_at       timestamptz,
    ended_reason   text,
    summary        text,
    transcript     text,
    recording_url  text,
    outcome        text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking.outbox (
    id               bigserial PRIMARY KEY,
    created_at       timestamptz NOT NULL DEFAULT now(),
    channel          text NOT NULL DEFAULT 'sms',
    recipient        text NOT NULL,
    message          text NOT NULL,
    appointment_id   bigint REFERENCES booking.appointments (id),
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts         int  NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    locked_until     timestamptz,
    sent_at          timestamptz,
    provider_ref     text,
    last_error       text
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON booking.outbox (next_attempt_at) WHERE status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS crm.contacts (
    id               serial PRIMARY KEY,
    phone_e164       text NOT NULL UNIQUE,
    name             text,
    source           text NOT NULL DEFAULT 'voice',
    first_seen_at    timestamptz NOT NULL DEFAULT now(),
    last_contact_at  timestamptz NOT NULL DEFAULT now(),
    last_outcome     text,
    total_calls      int NOT NULL DEFAULT 0,
    total_bookings   int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crm.tasks (
    id              serial PRIMARY KEY,
    contact_id      int NOT NULL REFERENCES crm.contacts (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    due_at          timestamptz NOT NULL,
    title           text NOT NULL,
    details         text,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    source_call_id  text UNIQUE
);

CREATE OR REPLACE FUNCTION booking.norm_phone(p text, p_default_country text DEFAULT '381') RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    d text;
BEGIN
    IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
    d := regexp_replace(p, '[^0-9+]', '', 'g');
    IF d LIKE '+%' THEN d := '+' || replace(substr(d, 2), '+', '');
    ELSIF d LIKE '00%' THEN d := '+' || substr(d, 3);
    ELSIF d LIKE '0%' THEN d := '+' || p_default_country || substr(d, 2);
    ELSIF d LIKE p_default_country || '%' AND length(d) > 9 THEN d := '+' || d;
    ELSE d := '+' || p_default_country || d;
    END IF;
    IF length(d) < 9 OR length(d) > 16 THEN RETURN NULL; END IF;
    RETURN d;
END
$$;

CREATE OR REPLACE FUNCTION booking.tz() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT timezone FROM booking.settings
$$;

CREATE OR REPLACE FUNCTION booking.label(ts timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT CASE (ts AT TIME ZONE booking.tz())::date - (now() AT TIME ZONE booking.tz())::date
               WHEN 0 THEN 'today'
               WHEN 1 THEN 'tomorrow'
               ELSE trim(to_char(ts AT TIME ZONE booking.tz(), 'FMDay')) || ' ' || to_char(ts AT TIME ZONE booking.tz(), 'FMDD FMMonth')
           END || to_char(ts AT TIME ZONE booking.tz(), ' "at" HH24:MI')
$$;

CREATE OR REPLACE FUNCTION booking.parse_start(p text) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
    IF p ~ '(Z|[+-]\d{2}:?\d{2})$' THEN RETURN p::timestamptz; END IF;
    RETURN (p::timestamp) AT TIME ZONE booking.tz();
EXCEPTION WHEN others THEN
    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION booking.resolve_service(p_name text) RETURNS booking.services
LANGUAGE sql STABLE AS $$
    SELECT s.*
    FROM booking.services s
    WHERE s.active AND coalesce(btrim(p_name), '') <> ''
      AND (lower(s.name) = lower(btrim(p_name))
           OR word_similarity(lower(p_name), lower(s.name || ' ' || s.synonyms)) >= 0.5)
    ORDER BY lower(s.name) = lower(btrim(p_name)) DESC,
             word_similarity(lower(p_name), lower(s.name || ' ' || s.synonyms)) DESC
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION booking.resolve_staff(p_name text) RETURNS booking.staff
LANGUAGE sql STABLE AS $$
    SELECT st.*
    FROM booking.staff st
    WHERE st.active AND coalesce(btrim(p_name), '') <> '' AND lower(p_name) NOT IN ('any', 'anyone', 'no preference')
      AND similarity(lower(st.name), lower(p_name)) >= 0.3
    ORDER BY similarity(lower(st.name), lower(p_name)) DESC
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION booking.find_slots(
    p_service_id int, p_from timestamptz, p_to timestamptz, p_staff_id int DEFAULT NULL,
    p_part_of_day text DEFAULT 'any', p_around time DEFAULT NULL, p_limit int DEFAULT 3)
RETURNS TABLE (staff_id int, staff_name text, starts_at timestamptz, ends_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    s       booking.settings%ROWTYPE;
    svc     booking.services%ROWTYPE;
    r       record;
    chosen  timestamptz[] := '{}';
BEGIN
    SELECT * INTO s FROM booking.settings;
    SELECT * INTO svc FROM booking.services WHERE id = p_service_id;

    FOR r IN
        WITH days AS (
            SELECT generate_series((p_from AT TIME ZONE s.timezone)::date,
                                   (p_to AT TIME ZONE s.timezone)::date, interval '1 day')::date AS d
        ), shifts AS (
            SELECT st.id, st.name,
                   (days.d + wh.start_time) AT TIME ZONE s.timezone AS shift_start,
                   (days.d + wh.end_time) AT TIME ZONE s.timezone AS shift_end
              FROM days
              JOIN booking.working_hours wh ON wh.weekday = extract(isodow FROM days.d)
              JOIN booking.staff st ON st.id = wh.staff_id AND st.active
              JOIN booking.staff_services ss ON ss.staff_id = st.id AND ss.service_id = p_service_id
             WHERE p_staff_id IS NULL OR st.id = p_staff_id
        ), cand AS (
            SELECT sh.id, sh.name, g AS c_start, g + make_interval(mins => svc.duration_min) AS c_end
              FROM shifts sh,
                   generate_series(sh.shift_start, sh.shift_end - make_interval(mins => svc.duration_min),
                                   make_interval(mins => s.slot_step_minutes)) g
        )
        SELECT c.id, c.name, c.c_start, c.c_end
          FROM cand c
         WHERE c.c_start >= greatest(p_from, now() + make_interval(mins => s.min_lead_minutes))
           AND c.c_start < p_to
           AND CASE coalesce(p_part_of_day, 'any')
                 WHEN 'morning' THEN (c.c_start AT TIME ZONE s.timezone)::time < time '12:00'
                 WHEN 'afternoon' THEN (c.c_start AT TIME ZONE s.timezone)::time >= time '12:00'
                                   AND (c.c_start AT TIME ZONE s.timezone)::time < time '17:00'
                 WHEN 'evening' THEN (c.c_start AT TIME ZONE s.timezone)::time >= time '17:00'
                 ELSE true END
           AND NOT EXISTS (
                 SELECT 1 FROM booking.appointments a
                  WHERE a.staff_id = c.id AND a.status = 'booked'
                    AND a.during && tstzrange(c.c_start, c.c_end + make_interval(mins => svc.buffer_min)))
           AND NOT EXISTS (
                 SELECT 1 FROM booking.time_off t
                  WHERE t.staff_id = c.id AND t.during && tstzrange(c.c_start, c.c_end))
         ORDER BY CASE WHEN p_around IS NULL THEN 0
                       ELSE abs(extract(epoch FROM ((c.c_start AT TIME ZONE s.timezone)::time - p_around))) END,
                  c.c_start, c.id
    LOOP
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM unnest(chosen) x
             WHERE abs(extract(epoch FROM (x - r.c_start))) < s.offer_spread_min * 60);
        chosen := chosen || r.c_start;
        staff_id := r.id; staff_name := r.name; starts_at := r.c_start; ends_at := r.c_end;
        RETURN NEXT;
        EXIT WHEN cardinality(chosen) >= p_limit;
    END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION booking.slots_json(p_service_id int, p_from timestamptz, p_to timestamptz,
    p_staff_id int, p_part text, p_around time, p_limit int DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'start', to_char(f.starts_at AT TIME ZONE booking.tz(), 'YYYY-MM-DD"T"HH24:MI'),
               'staff_id', f.staff_id,
               'staff_name', f.staff_name,
               'label', booking.label(f.starts_at) || ' with ' || f.staff_name)
             ORDER BY f.starts_at), '[]'::jsonb)
    FROM booking.find_slots(p_service_id, p_from, p_to, p_staff_id, p_part, p_around, p_limit) f
$$;

CREATE OR REPLACE FUNCTION booking.list_labels(p_slots jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE jsonb_array_length(p_slots)
        WHEN 0 THEN ''
        WHEN 1 THEN p_slots->0->>'label'
        ELSE (SELECT string_agg(e->>'label', ', ' ORDER BY ord)
                FROM jsonb_array_elements(p_slots) WITH ORDINALITY AS t(e, ord)
               WHERE ord < jsonb_array_length(p_slots))
             || ' or ' || (p_slots->(jsonb_array_length(p_slots) - 1)->>'label')
    END
$$;

CREATE OR REPLACE FUNCTION booking.tool_check_availability(p_args jsonb, p_ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
    s        booking.settings%ROWTYPE;
    svc      booking.services%ROWTYPE;
    st       booking.staff%ROWTYPE;
    v_day    date;
    v_from   timestamptz;
    v_to     timestamptz;
    v_around time;
    v_part   text := lower(coalesce(p_args->>'part_of_day', 'any'));
    v_slots  jsonb;
    v_later  jsonb;
BEGIN
    SELECT * INTO s FROM booking.settings;
    svc := booking.resolve_service(p_args->>'service');
    IF svc.id IS NULL THEN
        RETURN jsonb_build_object('status', 'unknown_service',
            'services', (SELECT jsonb_agg(name ORDER BY id) FROM booking.services WHERE active),
            'message', 'I could not find that service. We offer: '
                       || (SELECT string_agg(name, ', ' ORDER BY id) FROM booking.services WHERE active) || '.');
    END IF;
    st := booking.resolve_staff(p_args->>'staff');

    BEGIN
        v_day := nullif(p_args->>'date', '')::date;
    EXCEPTION WHEN others THEN
        v_day := NULL;
    END;
    BEGIN
        v_around := nullif(p_args->>'around', '')::time;
    EXCEPTION WHEN others THEN
        v_around := NULL;
    END;

    IF v_day IS NOT NULL AND v_day > (now() AT TIME ZONE s.timezone)::date + s.max_days_ahead THEN
        RETURN jsonb_build_object('status', 'too_far_ahead',
            'message', format('We only take bookings up to %s days ahead.', s.max_days_ahead));
    END IF;

    IF v_day IS NULL THEN
        v_from := now();
        v_to := now() + interval '7 days';
    ELSE
        v_from := v_day::timestamp AT TIME ZONE s.timezone;
        v_to := (v_day + 1)::timestamp AT TIME ZONE s.timezone;
    END IF;

    v_slots := booking.slots_json(svc.id, v_from, v_to, st.id, v_part, v_around);
    IF jsonb_array_length(v_slots) > 0 THEN
        RETURN jsonb_build_object('status', 'ok',
            'service', jsonb_build_object('id', svc.id, 'name', svc.name, 'duration_min', svc.duration_min, 'price', svc.price),
            'slots', v_slots,
            'message', format('For %s (%s min, %s EUR) I can offer %s. Which one works best?',
                              svc.name, svc.duration_min, svc.price, booking.list_labels(v_slots)));
    END IF;

    v_later := booking.slots_json(svc.id, greatest(v_to, now()), greatest(v_to, now()) + interval '7 days', st.id, 'any', v_around);
    RETURN jsonb_build_object('status', 'no_availability',
        'service', jsonb_build_object('id', svc.id, 'name', svc.name, 'duration_min', svc.duration_min, 'price', svc.price),
        'slots', v_later,
        'message', CASE WHEN jsonb_array_length(v_later) = 0
                        THEN format('Sorry, %s is fully booked for the next week.', svc.name)
                        ELSE format('Nothing is free then. The next options for %s are %s.', svc.name, booking.list_labels(v_later))
                   END);
END
$$;

CREATE OR REPLACE FUNCTION booking.upsert_customer(p_phone text, p_name text) RETURNS int
LANGUAGE sql AS $$
    INSERT INTO booking.customers (phone_e164, name)
    VALUES (p_phone, nullif(btrim(p_name), ''))
    ON CONFLICT (phone_e164) DO UPDATE
        SET name = coalesce(nullif(btrim(excluded.name), ''), booking.customers.name), updated_at = now()
    RETURNING id
$$;

CREATE OR REPLACE FUNCTION booking.appointment_json(p_id bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'ref', a.ref, 'status', a.status, 'service', sv.name, 'staff_name', st.name, 'staff_id', st.id,
        'start', to_char(a.starts_at AT TIME ZONE booking.tz(), 'YYYY-MM-DD"T"HH24:MI'),
        'label', booking.label(a.starts_at), 'price', sv.price, 'late_cancellation', a.late_cancellation)
    FROM booking.appointments a
    JOIN booking.services sv ON sv.id = a.service_id
    JOIN booking.staff st ON st.id = a.staff_id
    WHERE a.id = p_id
$$;

CREATE OR REPLACE FUNCTION booking.tool_book(p_args jsonb, p_ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    s         booking.settings%ROWTYPE;
    svc       booking.services%ROWTYPE;
    v_start   timestamptz := booking.parse_start(p_args->>'start');
    v_phone   text;
    v_cust    int;
    v_staff   record;
    v_id      bigint;
    v_alt     jsonb;
    v_tried   int := 0;
BEGIN
    SELECT * INTO s FROM booking.settings;
    v_phone := booking.norm_phone(coalesce(nullif(p_args->>'phone', ''), p_ctx->>'caller_phone'), s.default_country);

    svc := booking.resolve_service(p_args->>'service');
    IF svc.id IS NULL THEN
        RETURN jsonb_build_object('status', 'unknown_service', 'message', 'I could not find that service. Which service would you like?');
    END IF;
    IF v_start IS NULL THEN
        RETURN jsonb_build_object('status', 'invalid_time', 'message', 'I did not catch the time. Which day and time would you like?');
    END IF;
    IF v_phone IS NULL THEN
        RETURN jsonb_build_object('status', 'missing_phone', 'message', 'Could I have a phone number for the booking?');
    END IF;
    IF v_start < now() + make_interval(mins => s.min_lead_minutes) THEN
        RETURN jsonb_build_object('status', 'too_soon',
            'message', format('We need at least %s minutes notice. Shall I look for the next free time?', s.min_lead_minutes));
    END IF;

    v_cust := booking.upsert_customer(v_phone, p_args->>'customer_name');

    FOR v_staff IN
        SELECT st.id, st.name
          FROM booking.staff st
          JOIN booking.staff_services ss ON ss.staff_id = st.id AND ss.service_id = svc.id
         WHERE st.active
           AND (nullif(p_args->>'staff_id', '') IS NULL OR st.id = (p_args->>'staff_id')::int)
           AND EXISTS (
                 SELECT 1 FROM booking.working_hours wh
                  WHERE wh.staff_id = st.id
                    AND wh.weekday = extract(isodow FROM v_start AT TIME ZONE s.timezone)
                    AND (v_start AT TIME ZONE s.timezone)::time >= wh.start_time
                    AND (v_start AT TIME ZONE s.timezone)::time + make_interval(mins => svc.duration_min) <= wh.end_time)
           AND NOT EXISTS (
                 SELECT 1 FROM booking.time_off t
                  WHERE t.staff_id = st.id AND t.during && tstzrange(v_start, v_start + make_interval(mins => svc.duration_min)))
         ORDER BY (SELECT count(*) FROM booking.appointments a
                    WHERE a.staff_id = st.id AND a.status = 'booked'
                      AND (a.starts_at AT TIME ZONE s.timezone)::date = (v_start AT TIME ZONE s.timezone)::date), st.id
    LOOP
        v_tried := v_tried + 1;
        BEGIN
            INSERT INTO booking.appointments (staff_id, service_id, customer_id, starts_at, ends_at, during,
                                              source, call_id, tool_call_id, notes)
            VALUES (v_staff.id, svc.id, v_cust, v_start, v_start + make_interval(mins => svc.duration_min),
                    tstzrange(v_start, v_start + make_interval(mins => svc.duration_min + svc.buffer_min)),
                    coalesce(p_ctx->>'provider', 'voice'), p_ctx->>'call_id', p_ctx->>'tool_call_id', p_args->>'notes')
            RETURNING id INTO v_id;
            EXIT;
        EXCEPTION WHEN exclusion_violation THEN
            CONTINUE;
        END;
    END LOOP;

    IF v_id IS NULL THEN
        v_alt := booking.slots_json(svc.id, v_start - interval '3 hours', v_start + interval '3 days',
                                    nullif(p_args->>'staff_id', '')::int, 'any', (v_start AT TIME ZONE s.timezone)::time);
        RETURN jsonb_build_object(
            'status', CASE WHEN v_tried = 0 THEN 'outside_hours' ELSE 'slot_taken' END,
            'alternatives', v_alt,
            'message', CASE WHEN v_tried = 0 THEN 'We are not working at that time.' ELSE 'Sorry, that time was just taken.' END
                       || CASE WHEN jsonb_array_length(v_alt) > 0 THEN ' I can offer ' || booking.list_labels(v_alt) || '.' ELSE '' END);
    END IF;

    INSERT INTO booking.outbox (recipient, message, appointment_id)
    SELECT v_phone,
           format('%s: your %s with %s is booked for %s. Ref %s. Reply or call to change it.',
                  s.business_name, svc.name, v_staff.name, booking.label(v_start), a.ref),
           v_id
      FROM booking.appointments a WHERE a.id = v_id;

    RETURN jsonb_build_object('status', 'booked',
        'appointment', booking.appointment_json(v_id),
        'message', (SELECT format('Booked: %s with %s on %s. Your reference is %s. You will get a text confirmation.',
                                  svc.name, v_staff.name, booking.label(v_start), a.ref)
                      FROM booking.appointments a WHERE a.id = v_id));
END
$$;

CREATE OR REPLACE FUNCTION booking.caller_appointments(p_phone text) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT coalesce(jsonb_agg(booking.appointment_json(a.id) ORDER BY a.starts_at), '[]'::jsonb)
    FROM booking.appointments a
    JOIN booking.customers c ON c.id = a.customer_id
    WHERE c.phone_e164 = p_phone AND a.status = 'booked' AND a.starts_at > now()
$$;

CREATE OR REPLACE FUNCTION booking.tool_find_appointments(p_args jsonb, p_ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_phone text := booking.norm_phone(p_ctx->>'caller_phone', (SELECT default_country FROM booking.settings));
    v_list  jsonb;
BEGIN
    IF v_phone IS NULL THEN
        RETURN jsonb_build_object('status', 'unknown_caller', 'message', 'I cannot see your number, so I cannot look up bookings.');
    END IF;
    v_list := booking.caller_appointments(v_phone);
    RETURN jsonb_build_object('status', 'ok', 'appointments', v_list,
        'message', CASE jsonb_array_length(v_list)
            WHEN 0 THEN 'I do not see any upcoming bookings for your number.'
            ELSE 'You have ' || (SELECT string_agg((e->>'service') || ' on ' || (e->>'label') || ' (ref ' || (e->>'ref') || ')', ', ')
                                   FROM jsonb_array_elements(v_list) e) || '.'
        END);
END
$$;

CREATE OR REPLACE FUNCTION booking.owned_appointment(p_ref text, p_ctx jsonb, OUT r_id bigint, OUT r_status text, OUT r_list jsonb)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_phone text := booking.norm_phone(p_ctx->>'caller_phone', (SELECT default_country FROM booking.settings));
BEGIN
    r_list := booking.caller_appointments(v_phone);
    IF nullif(btrim(p_ref), '') IS NOT NULL THEN
        SELECT a.id INTO r_id
          FROM booking.appointments a JOIN booking.customers c ON c.id = a.customer_id
         WHERE a.ref = upper(btrim(p_ref)) AND a.status = 'booked' AND a.starts_at > now()
           AND (c.phone_e164 = v_phone OR coalesce((p_ctx->>'is_staff')::boolean, false));
        r_status := CASE WHEN r_id IS NULL THEN 'not_found' ELSE 'ok' END;
    ELSIF jsonb_array_length(r_list) = 1 THEN
        SELECT a.id INTO r_id FROM booking.appointments a WHERE a.ref = r_list->0->>'ref';
        r_status := 'ok';
    ELSIF jsonb_array_length(r_list) = 0 THEN
        r_status := 'not_found';
    ELSE
        r_status := 'which_one';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION booking.tool_cancel(p_args jsonb, p_ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    s     booking.settings%ROWTYPE;
    o     record;
    a     booking.appointments%ROWTYPE;
    v_late boolean;
BEGIN
    SELECT * INTO s FROM booking.settings;
    o := booking.owned_appointment(p_args->>'ref', p_ctx);
    IF o.r_status = 'which_one' THEN
        RETURN jsonb_build_object('status', 'which_one', 'appointments', o.r_list,
            'message', 'You have more than one booking. Which one should I cancel? '
                       || (SELECT string_agg((e->>'service') || ' on ' || (e->>'label') || ' (ref ' || (e->>'ref') || ')', ', ')
                             FROM jsonb_array_elements(o.r_list) e));
    ELSIF o.r_status = 'not_found' THEN
        RETURN jsonb_build_object('status', 'not_found', 'message', 'I could not find an upcoming booking with those details for your number.');
    END IF;

    SELECT * INTO a FROM booking.appointments WHERE id = o.r_id FOR UPDATE;
    v_late := a.starts_at < now() + make_interval(hours => s.late_cancel_hours);
    UPDATE booking.appointments
       SET status = 'cancelled', cancelled_at = now(), late_cancellation = v_late
     WHERE id = a.id;

    INSERT INTO booking.outbox (recipient, message, appointment_id)
    SELECT c.phone_e164, format('%s: your booking %s on %s is cancelled.', s.business_name, a.ref, booking.label(a.starts_at)), a.id
      FROM booking.customers c WHERE c.id = a.customer_id;

    RETURN jsonb_build_object('status', 'cancelled', 'appointment', booking.appointment_json(a.id),
        'message', format('Done, your booking on %s is cancelled.', booking.label(a.starts_at))
                   || CASE WHEN v_late THEN format(' Just so you know, cancellations within %s hours are noted on your profile.', s.late_cancel_hours) ELSE '' END);
END
$$;

CREATE OR REPLACE FUNCTION booking.tool_reschedule(p_args jsonb, p_ctx jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    s        booking.settings%ROWTYPE;
    o        record;
    a        booking.appointments%ROWTYPE;
    svc      booking.services%ROWTYPE;
    v_start  timestamptz := booking.parse_start(p_args->>'new_start');
    v_alt    jsonb;
BEGIN
    SELECT * INTO s FROM booking.settings;
    IF v_start IS NULL THEN
        RETURN jsonb_build_object('status', 'invalid_time', 'message', 'Which day and time would you like instead?');
    END IF;
    IF v_start < now() + make_interval(mins => s.min_lead_minutes) THEN
        RETURN jsonb_build_object('status', 'too_soon', 'message', format('We need at least %s minutes notice.', s.min_lead_minutes));
    END IF;
    o := booking.owned_appointment(p_args->>'ref', p_ctx);
    IF o.r_status <> 'ok' THEN
        RETURN jsonb_build_object('status', o.r_status, 'appointments', o.r_list,
            'message', CASE o.r_status WHEN 'which_one' THEN 'Which booking should I move? Please tell me the reference or the date.'
                                       ELSE 'I could not find an upcoming booking with those details for your number.' END);
    END IF;

    SELECT * INTO a FROM booking.appointments WHERE id = o.r_id FOR UPDATE;
    SELECT * INTO svc FROM booking.services WHERE id = a.service_id;

    IF NOT EXISTS (
        SELECT 1 FROM booking.working_hours wh
         WHERE wh.staff_id = a.staff_id
           AND wh.weekday = extract(isodow FROM v_start AT TIME ZONE s.timezone)
           AND (v_start AT TIME ZONE s.timezone)::time >= wh.start_time
           AND (v_start AT TIME ZONE s.timezone)::time + make_interval(mins => svc.duration_min) <= wh.end_time) THEN
        v_alt := booking.slots_json(svc.id, v_start - interval '1 day', v_start + interval '3 days', a.staff_id, 'any',
                                    (v_start AT TIME ZONE s.timezone)::time);
        RETURN jsonb_build_object('status', 'outside_hours', 'alternatives', v_alt,
            'message', 'That time is outside working hours.'
                       || CASE WHEN jsonb_array_length(v_alt) > 0 THEN ' I can offer ' || booking.list_labels(v_alt) || '.' ELSE '' END);
    END IF;

    BEGIN
        UPDATE booking.appointments
           SET starts_at = v_start,
               ends_at = v_start + make_interval(mins => svc.duration_min),
               during = tstzrange(v_start, v_start + make_interval(mins => svc.duration_min + svc.buffer_min))
         WHERE id = a.id;
    EXCEPTION WHEN exclusion_violation THEN
        v_alt := booking.slots_json(svc.id, v_start - interval '3 hours', v_start + interval '3 days', a.staff_id, 'any',
                                    (v_start AT TIME ZONE s.timezone)::time);
        RETURN jsonb_build_object('status', 'slot_taken', 'alternatives', v_alt,
            'message', 'That time is already taken.'
                       || CASE WHEN jsonb_array_length(v_alt) > 0 THEN ' I can offer ' || booking.list_labels(v_alt) || '.' ELSE '' END);
    END;

    INSERT INTO booking.outbox (recipient, message, appointment_id)
    SELECT c.phone_e164, format('%s: your booking %s is moved to %s.', s.business_name, a.ref, booking.label(v_start)), a.id
      FROM booking.customers c WHERE c.id = a.customer_id;

    RETURN jsonb_build_object('status', 'rescheduled', 'appointment', booking.appointment_json(a.id),
        'message', format('Done, I moved your %s to %s.', svc.name, booking.label(v_start)));
END
$$;

CREATE OR REPLACE FUNCTION booking.handle_tool(
    p_provider text, p_tool_call_id text, p_call_id text, p_tool text, p_args jsonb, p_ctx jsonb)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    v_started  timestamptz := clock_timestamp();
    v_prev     jsonb;
    v_ctx      jsonb;
    v_result   jsonb;
BEGIN
    IF p_tool_call_id IS NOT NULL THEN
        SELECT result INTO v_prev FROM booking.tool_invocations WHERE tool_call_id = p_tool_call_id;
        IF v_prev IS NOT NULL THEN
            RETURN v_prev || jsonb_build_object('replayed', true);
        END IF;
    END IF;

    v_ctx := coalesce(p_ctx, '{}'::jsonb)
             || jsonb_build_object('provider', p_provider, 'call_id', p_call_id, 'tool_call_id', p_tool_call_id);

    BEGIN
        v_result := CASE p_tool
            WHEN 'check_availability' THEN booking.tool_check_availability(coalesce(p_args, '{}'), v_ctx)
            WHEN 'book_appointment' THEN booking.tool_book(coalesce(p_args, '{}'), v_ctx)
            WHEN 'find_appointments' THEN booking.tool_find_appointments(coalesce(p_args, '{}'), v_ctx)
            WHEN 'cancel_appointment' THEN booking.tool_cancel(coalesce(p_args, '{}'), v_ctx)
            WHEN 'reschedule_appointment' THEN booking.tool_reschedule(coalesce(p_args, '{}'), v_ctx)
            ELSE jsonb_build_object('status', 'unknown_tool', 'message', 'Sorry, I cannot do that.')
        END;
    EXCEPTION WHEN unique_violation THEN
        SELECT jsonb_build_object('status', 'booked', 'appointment', booking.appointment_json(a.id),
                                  'message', 'That booking is already confirmed.')
          INTO v_result
          FROM booking.appointments a WHERE a.tool_call_id = p_tool_call_id;
        IF v_result IS NULL THEN RAISE; END IF;
    END;

    IF p_tool_call_id IS NOT NULL THEN
        INSERT INTO booking.tool_invocations (tool_call_id, call_id, provider, tool, args, result, duration_ms)
        VALUES (p_tool_call_id, p_call_id, p_provider, p_tool, coalesce(p_args, '{}'), v_result,
                (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int)
        ON CONFLICT (tool_call_id) DO NOTHING;
    END IF;

    RETURN v_result;
END
$$;

CREATE OR REPLACE FUNCTION booking.record_call(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    s          booking.settings%ROWTYPE;
    v_phone    text;
    v_outcome  text;
    v_booked   int;
    v_name     text;
    v_contact  int;
    v_task     int;
    v_new      boolean;
BEGIN
    SELECT * INTO s FROM booking.settings;
    v_phone := booking.norm_phone(p->>'caller_phone', s.default_country);

    SELECT count(*) FILTER (WHERE tool = 'book_appointment' AND result->>'status' = 'booked'),
           CASE
               WHEN bool_or(tool = 'book_appointment' AND result->>'status' = 'booked') THEN 'booked'
               WHEN bool_or(tool = 'reschedule_appointment' AND result->>'status' = 'rescheduled') THEN 'rescheduled'
               WHEN bool_or(tool = 'cancel_appointment' AND result->>'status' = 'cancelled') THEN 'cancelled'
               WHEN bool_or(tool = 'check_availability') THEN 'enquiry_no_booking'
               ELSE NULL
           END
      INTO v_booked, v_outcome
      FROM booking.tool_invocations WHERE call_id = p->>'call_id';

    v_outcome := coalesce(v_outcome,
        CASE WHEN p->>'ended_reason' IN ('customer-did-not-answer', 'voicemail', 'silence-timed-out') THEN 'no_conversation'
             ELSE 'information_only' END);

    INSERT INTO booking.calls (call_id, provider, caller_phone, started_at, ended_at, ended_reason, summary,
                               transcript, recording_url, outcome)
    VALUES (p->>'call_id', coalesce(p->>'provider', 'vapi'), v_phone, (p->>'started_at')::timestamptz,
            (p->>'ended_at')::timestamptz, p->>'ended_reason', p->>'summary', p->>'transcript', p->>'recording_url', v_outcome)
    ON CONFLICT (call_id) DO UPDATE SET outcome = excluded.outcome,
                                        summary = coalesce(excluded.summary, booking.calls.summary),
                                        transcript = coalesce(excluded.transcript, booking.calls.transcript),
                                        ended_at = coalesce(excluded.ended_at, booking.calls.ended_at)
    RETURNING (xmax = 0) INTO v_new;

    IF v_phone IS NULL OR NOT v_new THEN
        RETURN jsonb_build_object('call_id', p->>'call_id', 'outcome', v_outcome, 'duplicate', NOT v_new,
                                  'contact_id', (SELECT id FROM crm.contacts WHERE phone_e164 = v_phone));
    END IF;

    SELECT name INTO v_name FROM booking.customers WHERE phone_e164 = v_phone;
    INSERT INTO crm.contacts (phone_e164, name, last_outcome, total_calls, total_bookings)
    VALUES (v_phone, v_name, v_outcome, 1, v_booked)
    ON CONFLICT (phone_e164) DO UPDATE
        SET name = coalesce(excluded.name, crm.contacts.name),
            last_contact_at = now(),
            last_outcome = excluded.last_outcome,
            total_calls = crm.contacts.total_calls + 1,
            total_bookings = crm.contacts.total_bookings + excluded.total_bookings
    RETURNING id INTO v_contact;

    IF v_outcome = 'enquiry_no_booking' THEN
        INSERT INTO crm.tasks (contact_id, due_at, title, details, source_call_id)
        VALUES (v_contact, now() + interval '1 day', 'Follow up: asked about availability but did not book',
                coalesce(p->>'summary', 'No summary'), p->>'call_id')
        ON CONFLICT (source_call_id) DO NOTHING
        RETURNING id INTO v_task;
    END IF;

    RETURN jsonb_build_object('call_id', p->>'call_id', 'outcome', v_outcome, 'duplicate', false,
                              'contact_id', v_contact, 'task_id', v_task);
END
$$;

CREATE OR REPLACE FUNCTION booking.claim_outbox(p_limit int DEFAULT 20) RETURNS SETOF booking.outbox
LANGUAGE sql AS $$
    UPDATE booking.outbox o
       SET status = 'sending', attempts = o.attempts + 1, locked_until = now() + interval '2 minutes'
     WHERE o.id IN (
            SELECT id FROM booking.outbox
             WHERE (status = 'pending' AND next_attempt_at <= now())
                OR (status = 'sending' AND locked_until < now())
             ORDER BY id
             FOR UPDATE SKIP LOCKED
             LIMIT p_limit)
    RETURNING o.*
$$;

CREATE OR REPLACE FUNCTION booking.finish_outbox(p_id bigint, p_ok boolean, p_provider_ref text, p_error text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    o booking.outbox%ROWTYPE;
BEGIN
    IF p_ok THEN
        UPDATE booking.outbox SET status = 'sent', sent_at = now(), provider_ref = p_provider_ref, locked_until = NULL, last_error = NULL
         WHERE id = p_id RETURNING * INTO o;
    ELSE
        UPDATE booking.outbox
           SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
               next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, attempts))),
               locked_until = NULL, last_error = p_error
         WHERE id = p_id RETURNING * INTO o;
        IF o.status = 'failed' THEN
            INSERT INTO ops.alerts (severity, source, title, details)
            VALUES ('warning', 'voice-outbox', 'SMS could not be delivered',
                    jsonb_build_object('outbox_id', o.id, 'recipient', o.recipient, 'error', p_error));
        END IF;
    END IF;
    RETURN jsonb_build_object('id', o.id, 'status', o.status, 'attempts', o.attempts);
END
$$;
