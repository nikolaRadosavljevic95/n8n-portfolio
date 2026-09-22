CREATE SCHEMA IF NOT EXISTS rfq;

CREATE OR REPLACE FUNCTION rfq.norm_code(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT NULLIF(ltrim(regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9]', '', 'g'), '0'), '')
$$;

CREATE OR REPLACE FUNCTION rfq.norm_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT btrim(regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, coalesce(t, ''))),
                     '(\d),(\d)', '\1.\2', 'g'),
                   'mm2|mm²|mm\^2|sqmm|qmm', ' ', 'g'),
                 '(\d)\s*(?:[x×*]|by)\s*(\d)', '\1x\2', 'g'),
               '[^a-z0-9./ ]+', ' ', 'g'),
             '\s+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION rfq.norm_unit(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN t IS NULL OR btrim(t) = '' THEN NULL
        WHEN lower(btrim(t, ' .')) IN ('m', 'mtr', 'mtrs', 'meter', 'meters', 'metre', 'metres', 'lm') THEN 'M'
        WHEN lower(btrim(t, ' .')) IN ('pcs', 'pc', 'piece', 'pieces', 'kom', 'ea', 'each', 'x', 'stk', 'unit', 'units', 'nos') THEN 'PCS'
        WHEN lower(btrim(t, ' .')) IN ('roll', 'rolls', 'ring', 'rings', 'coil', 'coils', 'reel', 'reels', 'kolut', 'rl') THEN 'ROLL'
        WHEN lower(btrim(t, ' .')) IN ('pack', 'packs', 'pk', 'pkg', 'bag', 'bags', 'pak') THEN 'PACK'
        ELSE upper(btrim(t, ' .'))
    END
$$;

CREATE OR REPLACE FUNCTION rfq.extract_attrs(t text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    n text := ' ' || rfq.norm_text(t) || ' ';
    m text[];
    a jsonb := '{}'::jsonb;
BEGIN
    m := regexp_match(n, '[^0-9.x](\d{1,2})x(\d{1,3}(?:\.\d+)?)(?![0-9x])');
    IF m IS NOT NULL THEN
        a := a || jsonb_build_object('xs', m[1] || 'x' || trim_scale(m[2]::numeric)::text,
                                     'sec', trim_scale(m[2]::numeric)::text);
    ELSE
        m := regexp_match(lower(coalesce(t, '')), '(?:^|[^0-9.,])(\d{1,3}(?:[.,]\d+)?) ?(?:mm2|mm²|sqmm)');
        IF m IS NOT NULL THEN
            a := a || jsonb_build_object('sec', trim_scale(replace(m[1], ',', '.')::numeric)::text);
        END IF;
    END IF;

    m := regexp_match(n, '[^a-z0-9]([bcd]) ?(\d{1,2})(?: ?a)?(?![0-9a-z])');
    IF m IS NOT NULL THEN
        a := a || jsonb_build_object('curve', upper(m[1]), 'amp', m[2]);
    ELSE
        m := regexp_match(n, '[^0-9.x](\d{1,3}) ?(?:a|amp|amps|ampere)(?![a-z0-9])');
        IF m IS NOT NULL THEN
            a := a || jsonb_build_object('amp', m[1]);
        END IF;
    END IF;

    m := regexp_match(n, '[^0-9.](\d{2,3}) ?ma(?![a-z])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('ma', m[1]); END IF;

    m := regexp_match(n, '[^0-9.x]([1-4]) ?(?:p|pol|pole|poles|polni)(?![a-z])');
    IF m IS NOT NULL THEN
        a := a || jsonb_build_object('poles', m[1]);
    ELSE
        m := regexp_match(n, '(single|double|two|triple|three|four) ?(?:pole|poles|polni)(?![a-z])');
        IF m IS NOT NULL THEN
            a := a || jsonb_build_object('poles', CASE m[1] WHEN 'single' THEN '1' WHEN 'double' THEN '2' WHEN 'two' THEN '2'
                                                             WHEN 'four' THEN '4' ELSE '3' END);
        END IF;
    END IF;

    m := regexp_match(n, '[^0-9.x](\d{2}) ?mm(?![a-z0-9])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('dia', m[1]); END IF;

    m := regexp_match(n, '[^0-9.](\d{1,3}) ?(?:w|watt|watts)(?![a-z])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('watt', m[1]); END IF;

    m := regexp_match(n, 'ip ?(\d{2})(?![0-9])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('ip', m[1]); END IF;

    m := regexp_match(n, '[^a-z0-9]m(\d{2})(?![0-9])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('thread', 'M' || m[1]); END IF;

    m := regexp_match(n, '[^0-9](\d{1,2}) ?(?:modules?|mod)(?![a-z])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('modules', m[1]); END IF;

    m := regexp_match(n, '[^0-9](\d) ?way(?![a-z])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('way', m[1]); END IF;

    m := regexp_match(n, 'cat ?(5e|6a|6|7)(?![0-9a-z])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('cat', m[1]); END IF;

    m := regexp_match(n, '[^0-9](\d{4}) ?k(?![a-z])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('cct', m[1]); END IF;

    m := regexp_match(n, '(nym|nyy|h07v ?k|h05vv ?f|utp|ftp)(?![a-z])');
    IF m IS NOT NULL THEN a := a || jsonb_build_object('fam', replace(m[1], ' ', '')); END IF;

    IF n ~ '(yellow ?/? ?green|green ?/? ?yellow|gn ?/? ?ye)' THEN
        a := a || jsonb_build_object('color', 'yellow-green');
    ELSIF n ~ '(neutral|warm|cool|cold|day) ?(white|light)' THEN
        IF NOT a ? 'cct' THEN
            a := a || jsonb_build_object('cct',
                CASE substring(n FROM '(neutral|warm|cool|cold|day) ?(?:white|light)')
                    WHEN 'warm' THEN '3000' WHEN 'neutral' THEN '4000' ELSE '6500' END);
        END IF;
    ELSE
        m := regexp_match(n, '[^a-z](black|blue|brown|grey|gray|red|white)(?![a-z])');
        IF m IS NOT NULL THEN
            a := a || jsonb_build_object('color', CASE m[1] WHEN 'gray' THEN 'grey' ELSE m[1] END);
        END IF;
    END IF;

    IF n ~ '[^a-z]rcbo[^a-z]' THEN
        a := a || jsonb_build_object('dev', 'rcbo');
    ELSIF n ~ '([^a-z]rcd[^a-z]|residual current)' THEN
        a := a || jsonb_build_object('dev', 'rcd');
    ELSIF n ~ '([^a-z]mcb[^a-z]|circuit breaker|[^a-z]breakers?[^a-z])' THEN
        a := a || jsonb_build_object('dev', 'mcb');
    END IF;

    RETURN a;
END
$$;

CREATE TABLE IF NOT EXISTS rfq.settings (
    id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
    auto_accept_score   numeric NOT NULL DEFAULT 0.55,
    ambiguity_margin    numeric NOT NULL DEFAULT 0.06,
    currency            text    NOT NULL DEFAULT 'EUR',
    vat_rate            numeric NOT NULL DEFAULT 0.20
);
INSERT INTO rfq.settings DEFAULT VALUES ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS rfq.customers (
    id           int PRIMARY KEY,
    name         text NOT NULL,
    email_domain text,
    price_group  text NOT NULL DEFAULT 'STANDARD'
);

CREATE TABLE IF NOT EXISTS rfq.products (
    sku                      text PRIMARY KEY,
    name                     text NOT NULL,
    category                 text NOT NULL,
    sales_unit               text NOT NULL CHECK (sales_unit IN ('M', 'PCS', 'ROLL', 'PACK')),
    base_unit                text NOT NULL CHECK (base_unit IN ('M', 'PCS')),
    base_qty_per_sales_unit  numeric NOT NULL DEFAULT 1 CHECK (base_qty_per_sales_unit > 0),
    search_terms             text NOT NULL DEFAULT '',
    active                   boolean NOT NULL DEFAULT true,
    sku_norm                 text GENERATED ALWAYS AS (rfq.norm_code(sku)) STORED,
    search_norm              text GENERATED ALWAYS AS (rfq.norm_text(name || ' ' || search_terms)) STORED,
    attrs                    jsonb GENERATED ALWAYS AS (rfq.extract_attrs(name)) STORED
);
CREATE INDEX IF NOT EXISTS products_sku_norm_idx ON rfq.products (sku_norm);
CREATE INDEX IF NOT EXISTS products_search_trgm_idx ON rfq.products USING gin (search_norm gin_trgm_ops);

CREATE TABLE IF NOT EXISTS rfq.product_aliases (
    alias       text NOT NULL,
    alias_norm  text GENERATED ALWAYS AS (rfq.norm_code(alias)) STORED,
    sku         text NOT NULL REFERENCES rfq.products (sku),
    kind        text NOT NULL CHECK (kind IN ('MANUFACTURER', 'EAN', 'LEGACY')),
    PRIMARY KEY (alias, sku)
);
CREATE INDEX IF NOT EXISTS product_aliases_norm_idx ON rfq.product_aliases (alias_norm);

CREATE TABLE IF NOT EXISTS rfq.customer_part_xref (
    customer_id         int  NOT NULL REFERENCES rfq.customers (id),
    customer_code       text NOT NULL,
    customer_code_norm  text GENERATED ALWAYS AS (rfq.norm_code(customer_code)) STORED,
    sku                 text NOT NULL REFERENCES rfq.products (sku),
    source              text NOT NULL DEFAULT 'IMPORT' CHECK (source IN ('IMPORT', 'REVIEW')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, customer_code)
);
CREATE INDEX IF NOT EXISTS customer_part_xref_norm_idx ON rfq.customer_part_xref (customer_id, customer_code_norm);

CREATE TABLE IF NOT EXISTS rfq.price_list (
    sku          text    NOT NULL REFERENCES rfq.products (sku),
    price_group  text    NOT NULL DEFAULT 'STANDARD',
    min_qty      numeric NOT NULL DEFAULT 1,
    unit_price   numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
    valid_from   date    NOT NULL DEFAULT DATE '2026-01-01',
    valid_to     date,
    PRIMARY KEY (sku, price_group, min_qty, valid_from)
);

CREATE SEQUENCE IF NOT EXISTS rfq.quote_no_seq START 1001;

CREATE TABLE IF NOT EXISTS rfq.quotes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_no        text NOT NULL UNIQUE,
    customer_id     int  NOT NULL REFERENCES rfq.customers (id),
    source_name     text,
    source_sha256   text NOT NULL,
    parser          text NOT NULL,
    status          text NOT NULL CHECK (status IN ('READY', 'NEEDS_REVIEW', 'NEEDS_MANUAL_ENTRY')),
    currency        text NOT NULL,
    net_total       numeric(14, 2) NOT NULL DEFAULT 0,
    vat_total       numeric(14, 2) NOT NULL DEFAULT 0,
    gross_total     numeric(14, 2) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (customer_id, source_sha256)
);

CREATE TABLE IF NOT EXISTS rfq.quote_lines (
    quote_id        uuid NOT NULL REFERENCES rfq.quotes (id) ON DELETE CASCADE,
    line_no         int  NOT NULL,
    customer_code   text,
    description     text NOT NULL,
    qty_requested   numeric,
    unit_requested  text,
    sku             text REFERENCES rfq.products (sku),
    product_name    text,
    match_method    text,
    confidence      numeric,
    qty_quoted      numeric,
    sales_unit      text,
    unit_price      numeric(12, 2),
    line_total      numeric(14, 2),
    status          text NOT NULL CHECK (status IN ('OK', 'REVIEW')),
    reasons         text[] NOT NULL DEFAULT '{}',
    notes           text[] NOT NULL DEFAULT '{}',
    candidates      jsonb NOT NULL DEFAULT '[]'::jsonb,
    resolved_by     text,
    resolved_at     timestamptz,
    PRIMARY KEY (quote_id, line_no)
);

CREATE OR REPLACE FUNCTION rfq.price_for(p_sku text, p_price_group text, p_qty numeric, p_on date)
RETURNS TABLE (unit_price numeric, min_qty numeric, price_group text)
LANGUAGE sql STABLE AS $$
    SELECT pl.unit_price, pl.min_qty, pl.price_group
    FROM rfq.price_list pl
    WHERE pl.sku = p_sku
      AND pl.price_group IN (p_price_group, 'STANDARD')
      AND pl.min_qty <= p_qty
      AND pl.valid_from <= p_on
      AND (pl.valid_to IS NULL OR pl.valid_to >= p_on)
    ORDER BY (pl.price_group = p_price_group) DESC, pl.min_qty DESC
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION rfq.quote_line(
    p_customer_id int, p_sku text, p_qty numeric, p_unit text, p_on date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
    p           rfq.products%ROWTYPE;
    v_group     text;
    v_qty       numeric;
    v_price     numeric;
    v_min_qty   numeric;
    v_reasons   text[] := '{}';
    v_notes     text[] := '{}';
BEGIN
    SELECT * INTO p FROM rfq.products WHERE sku = p_sku;
    SELECT price_group INTO v_group FROM rfq.customers WHERE id = p_customer_id;
    v_group := coalesce(v_group, 'STANDARD');

    IF p_qty IS NULL OR p_qty <= 0 THEN
        v_reasons := v_reasons || 'INVALID_QTY'::text;
    ELSIF p_unit IS NULL THEN
        v_qty := p_qty;
        v_notes := v_notes || format('Unit missing, assumed %s', p.sales_unit);
    ELSIF p_unit = p.sales_unit THEN
        v_qty := p_qty;
    ELSIF p_unit = p.base_unit AND p.base_qty_per_sales_unit > 1 THEN
        v_qty := ceil(p_qty / p.base_qty_per_sales_unit);
        IF v_qty * p.base_qty_per_sales_unit <> p_qty THEN
            v_notes := v_notes || format('%s %s rounded up to %s %s (%s %s)',
                trim_scale(p_qty), p_unit, v_qty, p.sales_unit, trim_scale(v_qty * p.base_qty_per_sales_unit), p.base_unit);
        ELSE
            v_notes := v_notes || format('%s %s converted to %s %s', trim_scale(p_qty), p_unit, v_qty, p.sales_unit);
        END IF;
    ELSIF p_unit = 'PCS' AND p.sales_unit IN ('ROLL', 'PACK') AND p.base_unit = 'M' THEN
        v_qty := p_qty;
        v_notes := v_notes || format('PCS interpreted as %s', p.sales_unit);
    ELSE
        v_reasons := v_reasons || 'UNIT_MISMATCH'::text;
    END IF;

    IF v_qty IS NOT NULL THEN
        SELECT pf.unit_price, pf.min_qty INTO v_price, v_min_qty FROM rfq.price_for(p.sku, v_group, v_qty, p_on) pf;
        IF v_price IS NULL THEN
            v_reasons := v_reasons || 'NO_PRICE'::text;
        ELSIF v_min_qty > 1 THEN
            v_notes := v_notes || format('Volume price from %s %s', trim_scale(v_min_qty), p.sales_unit);
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'sku', p.sku,
        'product_name', p.name,
        'sales_unit', p.sales_unit,
        'qty_quoted', v_qty,
        'unit_price', v_price,
        'line_total', CASE WHEN v_price IS NOT NULL THEN round(v_qty * v_price, 2) END,
        'reasons', to_jsonb(v_reasons),
        'notes', to_jsonb(v_notes));
END
$$;

CREATE OR REPLACE FUNCTION rfq.match_lines(p_customer_id int, p_lines jsonb, p_on date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
    s           rfq.settings%ROWTYPE;
    l           jsonb;
    v_code      text;
    v_desc      text;
    v_desc_norm text;
    v_attrs     jsonb;
    v_attr_count int;
    v_qty       numeric;
    v_unit      text;
    v_cands     jsonb;
    v_code_hit  jsonb;
    v_best      jsonb;
    v_second    jsonb;
    v_reasons   text[];
    v_pricing   jsonb;
    v_status    text;
    v_out       jsonb := '[]'::jsonb;
BEGIN
    SELECT * INTO s FROM rfq.settings;

    FOR l IN SELECT value FROM jsonb_array_elements(p_lines) ORDER BY (value->>'line_no')::int LOOP
        v_code      := nullif(btrim(l->>'code'), '');
        v_desc      := coalesce(l->>'description', '');
        v_desc_norm := rfq.norm_text(v_desc);
        v_attrs     := rfq.extract_attrs(v_desc);
        v_unit      := rfq.norm_unit(l->>'unit');
        v_reasons   := '{}';
        v_pricing   := NULL;
        BEGIN
            v_qty := (l->>'qty')::numeric;
        EXCEPTION WHEN others THEN
            v_qty := NULL;
        END;

        SELECT to_jsonb(h) INTO v_code_hit FROM (
            SELECT x.sku, 'CUSTOMER_XREF' AS method, 1.0 AS score, 1 AS prio
              FROM rfq.customer_part_xref x
             WHERE x.customer_id = p_customer_id AND x.customer_code_norm = rfq.norm_code(v_code)
            UNION ALL
            SELECT p.sku, 'EXACT_SKU', 1.0, 2 FROM rfq.products p
             WHERE p.active AND p.sku_norm = rfq.norm_code(v_code)
            UNION ALL
            SELECT a.sku, 'ALIAS', 0.99, 3 FROM rfq.product_aliases a
             WHERE a.alias_norm = rfq.norm_code(v_code)
            ORDER BY prio
            LIMIT 1
        ) h;

        IF v_code_hit IS NULL AND v_code IS NOT NULL THEN
            v_desc_norm := rfq.norm_text(v_code || ' ' || v_desc);
            v_attrs     := rfq.extract_attrs(v_code || ' ' || v_desc);
        END IF;

        v_attr_count := (SELECT count(*) FROM jsonb_object_keys(v_attrs));

        WITH retrieved AS (
            SELECT p.sku, p.name, p.attrs,
                   (0.5 * similarity(p.search_norm, v_desc_norm)
                  + 0.5 * word_similarity(v_desc_norm, p.search_norm))::numeric AS text_score,
                   (SELECT count(*) FROM jsonb_object_keys(v_attrs) k
                     WHERE p.attrs ? k AND p.attrs->>k = v_attrs->>k) AS agreements,
                   (SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(v_attrs) k
                     WHERE p.attrs ? k AND p.attrs->>k <> v_attrs->>k) AS conflicts
              FROM rfq.products p
             WHERE p.active AND v_desc_norm <> ''
        ), candidates AS (
            SELECT r.*,
                   round(CASE WHEN v_attr_count = 0 THEN r.text_score
                              ELSE 0.5 * r.text_score + 0.5 * r.agreements::numeric / v_attr_count END, 3) AS score
              FROM retrieved r
             WHERE jsonb_array_length(r.conflicts) = 0
               AND (r.text_score >= 0.3 OR r.agreements >= 2)
        )
        SELECT coalesce(jsonb_agg(c ORDER BY c.score DESC, c.sku), '[]'::jsonb) INTO v_cands
          FROM (
            SELECT sku, name, 'FUZZY' AS method, agreements, score
              FROM candidates
             ORDER BY score DESC, sku
             LIMIT 5
          ) c;

        v_best := NULL;
        v_second := v_cands->1;

        IF v_code_hit IS NOT NULL THEN
            SELECT jsonb_build_object(
                       'sku', p.sku, 'name', p.name, 'method', v_code_hit->>'method',
                       'score', (v_code_hit->>'score')::numeric,
                       'conflicts', (SELECT coalesce(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(v_attrs) k
                                      WHERE p.attrs ? k AND p.attrs->>k <> v_attrs->>k))
              INTO v_best
              FROM rfq.products p WHERE p.sku = v_code_hit->>'sku';

            IF jsonb_array_length(v_best->'conflicts') > 0 THEN
                v_reasons := v_reasons || 'CODE_DESCRIPTION_CONFLICT'::text;
            END IF;
            v_cands := jsonb_build_array(v_best) || coalesce((
                SELECT jsonb_agg(e) FROM jsonb_array_elements(v_cands) e WHERE e->>'sku' <> v_best->>'sku'), '[]'::jsonb);
            v_second := v_cands->1;
        ELSIF jsonb_array_length(v_cands) > 0 THEN
            v_best := v_cands->0;
            IF (v_best->>'score')::numeric < s.auto_accept_score THEN
                v_reasons := v_reasons || 'LOW_CONFIDENCE'::text;
            ELSIF v_second IS NOT NULL
                  AND (v_best->>'score')::numeric - (v_second->>'score')::numeric < s.ambiguity_margin THEN
                v_reasons := v_reasons || 'AMBIGUOUS'::text;
            END IF;
        ELSE
            v_reasons := v_reasons || 'NO_MATCH'::text;
        END IF;

        IF v_best IS NOT NULL THEN
            v_pricing := rfq.quote_line(p_customer_id, v_best->>'sku', v_qty, v_unit, p_on);
            v_reasons := v_reasons || ARRAY(SELECT jsonb_array_elements_text(v_pricing->'reasons'));
        ELSIF v_qty IS NULL OR v_qty <= 0 THEN
            v_reasons := v_reasons || 'INVALID_QTY'::text;
        END IF;

        v_status := CASE WHEN cardinality(v_reasons) = 0 THEN 'OK' ELSE 'REVIEW' END;

        v_out := v_out || jsonb_build_object(
            'line_no',        (l->>'line_no')::int,
            'customer_code',  v_code,
            'description',    v_desc,
            'qty_requested',  v_qty,
            'unit_requested', coalesce(v_unit, l->>'unit'),
            'sku',            CASE WHEN v_status = 'OK' OR v_code_hit IS NOT NULL THEN v_best->>'sku' END,
            'product_name',   CASE WHEN v_status = 'OK' OR v_code_hit IS NOT NULL THEN v_best->>'name' END,
            'match_method',   v_best->>'method',
            'confidence',     (v_best->>'score')::numeric,
            'qty_quoted',     CASE WHEN v_status = 'OK' THEN v_pricing->'qty_quoted' END,
            'sales_unit',     CASE WHEN v_status = 'OK' THEN v_pricing->>'sales_unit' END,
            'unit_price',     CASE WHEN v_status = 'OK' THEN v_pricing->'unit_price' END,
            'line_total',     CASE WHEN v_status = 'OK' THEN v_pricing->'line_total' END,
            'status',         v_status,
            'reasons',        to_jsonb(v_reasons),
            'notes',          coalesce(v_pricing->'notes', '[]'::jsonb),
            'attributes',     v_attrs,
            'candidates',     coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'sku', e->>'sku', 'name', e->>'name', 'method', e->>'method',
                                  'score', (e->>'score')::numeric))
                               FROM (SELECT e FROM jsonb_array_elements(v_cands) e LIMIT 3) t), '[]'::jsonb));
    END LOOP;

    RETURN v_out;
END
$$;

CREATE OR REPLACE FUNCTION rfq.save_quote(
    p_customer_id int, p_source_sha256 text, p_source_name text, p_parser text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    s        rfq.settings%ROWTYPE;
    v_id     uuid;
    v_dup    boolean := false;
    v_net    numeric;
    v_status text;
BEGIN
    SELECT * INTO s FROM rfq.settings;

    SELECT id INTO v_id FROM rfq.quotes WHERE customer_id = p_customer_id AND source_sha256 = p_source_sha256;
    IF v_id IS NOT NULL THEN
        v_dup := true;
    ELSE
        v_net := coalesce((SELECT sum((e->>'line_total')::numeric) FROM jsonb_array_elements(p_lines) e
                            WHERE e->>'status' = 'OK'), 0);
        v_status := CASE
            WHEN jsonb_array_length(p_lines) = 0 THEN 'NEEDS_MANUAL_ENTRY'
            WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) e WHERE e->>'status' = 'REVIEW') THEN 'NEEDS_REVIEW'
            ELSE 'READY' END;

        INSERT INTO rfq.quotes (quote_no, customer_id, source_name, source_sha256, parser, status, currency,
                                net_total, vat_total, gross_total)
        VALUES ('Q-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('rfq.quote_no_seq')::text, 5, '0'),
                p_customer_id, p_source_name, p_source_sha256, p_parser, v_status, s.currency,
                round(v_net, 2), round(v_net * s.vat_rate, 2), round(v_net * (1 + s.vat_rate), 2))
        ON CONFLICT (customer_id, source_sha256) DO NOTHING
        RETURNING id INTO v_id;

        IF v_id IS NULL THEN
            SELECT id INTO v_id FROM rfq.quotes WHERE customer_id = p_customer_id AND source_sha256 = p_source_sha256;
            v_dup := true;
        ELSE
            INSERT INTO rfq.quote_lines (quote_id, line_no, customer_code, description, qty_requested, unit_requested,
                                         sku, product_name, match_method, confidence, qty_quoted, sales_unit,
                                         unit_price, line_total, status, reasons, notes, candidates)
            SELECT v_id, (e->>'line_no')::int, e->>'customer_code', e->>'description',
                   (e->>'qty_requested')::numeric, e->>'unit_requested', e->>'sku', e->>'product_name',
                   e->>'match_method', (e->>'confidence')::numeric, (e->>'qty_quoted')::numeric, e->>'sales_unit',
                   (e->>'unit_price')::numeric, (e->>'line_total')::numeric, e->>'status',
                   ARRAY(SELECT jsonb_array_elements_text(e->'reasons')),
                   ARRAY(SELECT jsonb_array_elements_text(e->'notes')),
                   coalesce(e->'candidates', '[]'::jsonb)
              FROM jsonb_array_elements(p_lines) e;
        END IF;
    END IF;

    RETURN rfq.quote_json(v_id) || jsonb_build_object('duplicate', v_dup);
END
$$;

CREATE OR REPLACE FUNCTION rfq.quote_json(p_quote_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'quote_id', q.id,
        'quote_no', q.quote_no,
        'status', q.status,
        'customer', jsonb_build_object('id', c.id, 'name', c.name, 'price_group', c.price_group),
        'source_name', q.source_name,
        'parser', q.parser,
        'currency', q.currency,
        'net_total', q.net_total,
        'vat_total', q.vat_total,
        'gross_total', q.gross_total,
        'created_at', q.created_at,
        'counts', jsonb_build_object(
            'lines', (SELECT count(*) FROM rfq.quote_lines WHERE quote_id = q.id),
            'ok', (SELECT count(*) FROM rfq.quote_lines WHERE quote_id = q.id AND status = 'OK'),
            'review', (SELECT count(*) FROM rfq.quote_lines WHERE quote_id = q.id AND status = 'REVIEW')),
        'lines', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'line_no', ql.line_no, 'customer_code', ql.customer_code, 'description', ql.description,
                'qty_requested', ql.qty_requested, 'unit_requested', ql.unit_requested,
                'sku', ql.sku, 'product_name', ql.product_name, 'match_method', ql.match_method,
                'confidence', ql.confidence, 'qty_quoted', ql.qty_quoted, 'sales_unit', ql.sales_unit,
                'unit_price', ql.unit_price, 'line_total', ql.line_total, 'status', ql.status,
                'reasons', to_jsonb(ql.reasons), 'notes', to_jsonb(ql.notes), 'candidates', ql.candidates,
                'resolved_by', ql.resolved_by) ORDER BY ql.line_no)
            FROM rfq.quote_lines ql WHERE ql.quote_id = q.id), '[]'::jsonb))
    FROM rfq.quotes q JOIN rfq.customers c ON c.id = q.customer_id
    WHERE q.id = p_quote_id
$$;

CREATE OR REPLACE FUNCTION rfq.resolve_line(
    p_quote_no text, p_line_no int, p_sku text, p_remember boolean, p_resolved_by text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    q        rfq.quotes%ROWTYPE;
    ql       rfq.quote_lines%ROWTYPE;
    v_price  jsonb;
    s        rfq.settings%ROWTYPE;
    v_net    numeric;
BEGIN
    SELECT * INTO s FROM rfq.settings;
    SELECT * INTO q FROM rfq.quotes WHERE quote_no = p_quote_no FOR UPDATE;
    IF q.id IS NULL THEN
        RAISE EXCEPTION 'Quote % not found', p_quote_no USING ERRCODE = 'no_data_found';
    END IF;
    SELECT * INTO ql FROM rfq.quote_lines WHERE quote_id = q.id AND line_no = p_line_no;
    IF ql.quote_id IS NULL THEN
        RAISE EXCEPTION 'Line % not found on quote %', p_line_no, p_quote_no USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM rfq.products WHERE sku = p_sku AND active) THEN
        RAISE EXCEPTION 'Unknown or inactive SKU %', p_sku USING ERRCODE = 'foreign_key_violation';
    END IF;

    v_price := rfq.quote_line(q.customer_id, p_sku, ql.qty_requested, ql.unit_requested, q.created_at::date);
    IF jsonb_array_length(v_price->'reasons') > 0 THEN
        RAISE EXCEPTION 'SKU % cannot be quoted for this line: %', p_sku, v_price->'reasons'
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE rfq.quote_lines
       SET sku = p_sku, product_name = v_price->>'product_name', match_method = 'MANUAL', confidence = 1,
           qty_quoted = (v_price->>'qty_quoted')::numeric, sales_unit = v_price->>'sales_unit',
           unit_price = (v_price->>'unit_price')::numeric, line_total = (v_price->>'line_total')::numeric,
           status = 'OK', reasons = '{}', notes = ARRAY(SELECT jsonb_array_elements_text(v_price->'notes')),
           resolved_by = p_resolved_by, resolved_at = now()
     WHERE quote_id = q.id AND line_no = p_line_no;

    IF p_remember AND ql.customer_code IS NOT NULL THEN
        INSERT INTO rfq.customer_part_xref (customer_id, customer_code, sku, source)
        VALUES (q.customer_id, ql.customer_code, p_sku, 'REVIEW')
        ON CONFLICT (customer_id, customer_code) DO UPDATE SET sku = excluded.sku, source = 'REVIEW', created_at = now();
    END IF;

    v_net := coalesce((SELECT sum(line_total) FROM rfq.quote_lines WHERE quote_id = q.id AND status = 'OK'), 0);
    UPDATE rfq.quotes
       SET net_total = round(v_net, 2), vat_total = round(v_net * s.vat_rate, 2),
           gross_total = round(v_net * (1 + s.vat_rate), 2),
           status = CASE WHEN EXISTS (SELECT 1 FROM rfq.quote_lines WHERE quote_id = q.id AND status = 'REVIEW')
                         THEN 'NEEDS_REVIEW' ELSE 'READY' END
     WHERE id = q.id;

    RETURN rfq.quote_json(q.id) || jsonb_build_object('remembered_mapping', p_remember AND ql.customer_code IS NOT NULL);
END
$$;

CREATE OR REPLACE FUNCTION rfq.try_resolve_line(
    p_quote_no text, p_line_no int, p_sku text, p_remember boolean, p_resolved_by text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
    RETURN jsonb_build_object('ok', true, 'quote', rfq.resolve_line(p_quote_no, p_line_no, p_sku, p_remember, p_resolved_by));
EXCEPTION
    WHEN no_data_found OR foreign_key_violation OR check_violation OR invalid_text_representation THEN
        RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END
$$;
