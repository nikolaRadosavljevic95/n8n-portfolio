import { Workflow, add, code, nodes, PG } from '../lib/wf.mjs';

export const RFQ_ENGINE_ID = 'PfRfqEngine00001';
export const RFQ_RENDER_ID = 'PfRfqRender00001';

export function rfqRender() {
  const wf = new Workflow({ id: RFQ_RENDER_ID, name: 'RFQ: Render quote (sub-workflow)' });
  add(wf, 'When called by another workflow', nodes.subworkflowTrigger(), [0, 0]);
  add(wf, 'Build sheets', nodes.code(code('rfq/render-sheets.js')), [240, 0]);
  add(wf, 'Build XLSX', nodes.execute('PfUtilBuildXlsx0', 'Util: Build XLSX'), [480, 0]);
  add(wf, 'Attach quote data', nodes.code(
    "const quote = $('Build sheets').first().json.quote;\nreturn [{ json: quote, binary: $input.first().binary }];",
  ), [720, 0]);
  wf.chain('When called by another workflow', 'Build sheets', 'Build XLSX', 'Attach quote data');
  wf.note(
    '## Quote to Excel\nTurns a stored quote into a two sheet workbook:\n- **Quote**: priced lines, totals, VAT\n- **Review**: lines that need a human decision, with the reason, top candidates and a suggested action\n\nUsed right after a quote is created and again when someone downloads it later.',
    [-40, -280], 460, 240, 7,
  );
  return wf;
}

export function rfqEngine() {
  const wf = new Workflow({ id: RFQ_ENGINE_ID, name: 'RFQ: Engine (sub-workflow)' });
  add(wf, 'When called by another workflow', nodes.subworkflowTrigger(), [0, 300]);
  add(wf, 'Prepare input', nodes.code(code('rfq/prepare-input.js')), [220, 300]);
  add(wf, 'Input valid?', nodes.ifTrue('={{ !$json.rejected }}'), [440, 300]);
  add(wf, 'Reject input', nodes.code('return [{ json: { rejected: true, error_code: $json.error_code, message: $json.message } }];'), [660, 460]);
  add(wf, 'PDF or lines?', nodes.ifTrue("={{ $json.mode === 'pdf' }}"), [660, 300]);
  wf.node('Extract PDF text', 'n8n-nodes-base.extractFromFile', 1.1,
    { operation: 'pdf', binaryPropertyName: 'data', options: { joinPages: true } }, [880, 160]);
  add(wf, 'Template parsers', nodes.code(code('rfq/parse-template.js')), [1100, 160]);
  add(wf, 'Parsed by a template?', nodes.ifTrue('={{ $json.lines.length > 0 }}'), [1320, 160]);
  add(wf, 'LLM enabled?', nodes.ifTrue("={{ $env.LLM_ENABLED === 'true' }}"), [1540, 20]);
  add(wf, 'Build LLM request', nodes.code(code('rfq/build-llm-request.js')), [1760, -120]);
  wf.node('LLM: extract line items', 'n8n-nodes-base.httpRequest', 4.5, {
    method: 'POST',
    url: "={{ ($env.LLM_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions' }}",
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'openAiApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.llm_request) }}',
    options: { timeout: 60000 },
  }, [1980, -120], { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: { openAiApi: { id: 'openAiCred000001', name: 'OpenAI' } } });
  add(wf, 'Validate LLM output', nodes.code(code('rfq/validate-llm.js')), [2200, -120]);
  wf.node('Parsed lines', 'n8n-nodes-base.noOp', 1, {}, [2420, 300]);
  add(wf, 'Match & price', nodes.pg(
    `SELECT CASE WHEN c.id IS NULL THEN NULL ELSE rfq.match_lines(x.cid, $2::jsonb) END AS lines,
       c.id IS NOT NULL AS customer_exists
FROM (SELECT $1::int AS cid) x
LEFT JOIN rfq.customers c ON c.id = x.cid;`,
    '={{ [ $json.customer_id, JSON.stringify($json.lines) ] }}',
  ), [2640, 300], { credentials: PG });
  add(wf, 'Known customer?', nodes.ifTrue('={{ $json.customer_exists }}'), [2860, 300]);
  add(wf, 'Reject unknown customer', nodes.code(
    "return [{ json: { rejected: true, error_code: 'unknown_customer', message: 'Unknown customer_id ' + $('Parsed lines').first().json.customer_id } }];",
  ), [3080, 420]);
  add(wf, 'Save quote', nodes.pg(
    'SELECT rfq.save_quote($1::int, $2, $3, $4, $5::jsonb) AS quote;',
    "={{ [ $('Parsed lines').first().json.customer_id, $('Parsed lines').first().json.source_sha256, $('Parsed lines').first().json.source_name, $('Parsed lines').first().json.parser, JSON.stringify($json.lines) ] }}",
  ), [3080, 200], { credentials: PG });
  add(wf, 'Render quote', nodes.execute(RFQ_RENDER_ID, 'RFQ: Render quote (sub-workflow)'), [3300, 200]);

  wf.chain('When called by another workflow', 'Prepare input', 'Input valid?');
  wf.connect('Input valid?', 'PDF or lines?', 0);
  wf.connect('Input valid?', 'Reject input', 1);
  wf.connect('PDF or lines?', 'Extract PDF text', 0);
  wf.connect('PDF or lines?', 'Parsed lines', 1);
  wf.chain('Extract PDF text', 'Template parsers', 'Parsed by a template?');
  wf.connect('Parsed by a template?', 'Parsed lines', 0);
  wf.connect('Parsed by a template?', 'LLM enabled?', 1);
  wf.connect('LLM enabled?', 'Build LLM request', 0);
  wf.connect('LLM enabled?', 'Parsed lines', 1);
  wf.chain('Build LLM request', 'LLM: extract line items', 'Validate LLM output', 'Parsed lines');
  wf.chain('Parsed lines', 'Match & price', 'Known customer?');
  wf.connect('Known customer?', 'Save quote', 0);
  wf.connect('Known customer?', 'Reject unknown customer', 1);
  wf.connect('Save quote', 'Render quote');

  wf.note(
    '## RFQ engine\nPDF (or structured lines) in, priced quote + Excel out. Bad input comes back as `{ rejected, error_code, message }` instead of failing the run, so client mistakes never page on-call.\n\n**Design rules**\n1. The LLM only reads text. It never picks products or prices.\n2. Prices come only from the approved price list (SQL lookup).\n3. Nothing is guessed silently. Every uncertain line goes to review with a reason.\n4. Same PDF twice for the same customer returns the same quote (SHA-256 idempotency).',
    [-60, -180], 480, 290, 5,
  );
  wf.note(
    '## Parsing: cheap and exact first\nTemplate parsers handle known layouts (ERP table exports, bullet lists in emails) for free and without mistakes. Lines that look like data but do not parse are kept and sent to review.\n\nOnly unknown layouts go to the LLM (JSON schema output). Its lines are checked against the source text, so invented items are rejected.',
    [860, -380], 560, 220, 6,
  );
  wf.note(
    '## Matching lives in Postgres\n`rfq.match_lines()` does hybrid retrieval: customer part numbers, SKUs, manufacturer and EAN aliases, then trigram text search plus technical attributes (16A, 3x1.5 mm², 30mA, IP65...).\n\nA candidate whose attributes contradict the request (B16 vs B10) is never auto-picked. Units are converted to how the product is sold (250 m of cable = 3 rings of 100 m).',
    [2400, 480], 560, 220, 4,
  );
  return wf;
}

// Webhook -> token check -> 401 on failure. Returns the name of the IF node,
// whose "true" output continues to the actual endpoint.
function guardedWebhook(wf, name, method, path, key, [x, y]) {
  add(wf, name, nodes.webhook(method, path), [x - 660, y]);
  add(wf, `Authorize (${key})`, nodes.code(code('rfq/authorize.js')), [x - 440, y]);
  add(wf, `Token ok? (${key})`, nodes.ifTrue('={{ $json.authorized }}'), [x - 220, y]);
  add(wf, `Respond 401 (${key})`, nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [x - 220, y + 180]);
  wf.chain(name, `Authorize (${key})`, `Token ok? (${key})`);
  wf.connect(`Token ok? (${key})`, `Respond 401 (${key})`, 1);
  return `Token ok? (${key})`;
}

export function rfqApi() {
  const wf = new Workflow({ id: 'PfRfqApi00000001', name: 'RFQ: API (webhooks)' });

  const quoteOk = guardedWebhook(wf, 'POST /rfq/quote', 'POST', 'rfq/quote', 'quote', [0, 0]);
  add(wf, 'Normalize request', nodes.code(code('rfq/api-normalize.js')), [220, 0]);
  add(wf, 'Valid request?', nodes.ifTrue('={{ $json.valid }}'), [440, 0]);
  add(wf, 'Run RFQ engine', nodes.execute(RFQ_ENGINE_ID, 'RFQ: Engine (sub-workflow)'), [660, -100],
    { onError: 'continueErrorOutput' });
  add(wf, 'Engine accepted?', nodes.ifTrue('={{ !$json.rejected }}'), [900, -200]);
  add(wf, 'Respond 422', nodes.respondJson('={{ { error: $json.error_code, message: $json.message } }}', 422), [1140, -20]);
  add(wf, 'Wants XLSX?', nodes.ifTrue("={{ $('Normalize request').first().json.format === 'xlsx' }}"), [1140, -220]);
  add(wf, 'Respond with XLSX', [
    'n8n-nodes-base.respondToWebhook', 1.5,
    {
      respondWith: 'binary',
      responseDataSource: 'set',
      inputDataFieldName: 'data',
      options: {
        responseHeaders: {
          entries: [{ name: 'Content-Disposition', value: '=attachment; filename="{{ $json.quote_no }}.xlsx"' }],
        },
      },
    },
  ], [1380, -300]);
  add(wf, 'Respond with quote JSON', nodes.respondJson(
    "={{ { ...$json, xlsx_url: $env.WEBHOOK_URL + 'webhook/rfq/quote/xlsx?quote_no=' + $json.quote_no } }}",
    "={{ $json.duplicate ? 200 : 201 }}",
  ), [1380, -140]);
  add(wf, 'Respond 500', nodes.respondJson(
    "={{ { error: 'processing_failed', message: String($json.error?.message ?? $json.error ?? 'unknown error') } }}", 500,
  ), [900, 40]);
  add(wf, 'Respond 400', nodes.respondJson("={{ { error: 'invalid_request', details: $json.errors } }}", 400), [660, 120]);

  wf.connect(quoteOk, 'Normalize request', 0);
  wf.chain('Normalize request', 'Valid request?');
  wf.connect('Valid request?', 'Run RFQ engine', 0);
  wf.connect('Valid request?', 'Respond 400', 1);
  wf.connect('Run RFQ engine', 'Engine accepted?', 0);
  wf.connect('Run RFQ engine', 'Respond 500', 1);
  wf.connect('Engine accepted?', 'Wants XLSX?', 0);
  wf.connect('Engine accepted?', 'Respond 422', 1);
  wf.connect('Wants XLSX?', 'Respond with XLSX', 0);
  wf.connect('Wants XLSX?', 'Respond with quote JSON', 1);

  const xlsxOk = guardedWebhook(wf, 'GET /rfq/quote/xlsx', 'GET', 'rfq/quote/xlsx', 'xlsx', [0, 440]);
  add(wf, 'Load quote', nodes.pg(
    'SELECT rfq.quote_json(id) AS quote FROM rfq.quotes WHERE quote_no = $1;',
    "={{ [ $json.query.quote_no ?? '' ] }}",
  ), [220, 440], { credentials: PG, alwaysOutputData: true });
  add(wf, 'Quote found?', nodes.ifTrue('={{ !!$json.quote }}'), [440, 440]);
  add(wf, 'Render quote', nodes.execute(RFQ_RENDER_ID, 'RFQ: Render quote (sub-workflow)'), [660, 360]);
  add(wf, 'Respond with XLSX file', [
    'n8n-nodes-base.respondToWebhook', 1.5,
    {
      respondWith: 'binary',
      responseDataSource: 'set',
      inputDataFieldName: 'data',
      options: {
        responseHeaders: {
          entries: [{ name: 'Content-Disposition', value: '=attachment; filename="{{ $json.quote_no }}.xlsx"' }],
        },
      },
    },
  ], [900, 360]);
  add(wf, 'Respond 404', nodes.respondJson("={{ { error: 'quote_not_found' } }}", 404), [660, 540]);
  wf.connect(xlsxOk, 'Load quote', 0);
  wf.chain('Load quote', 'Quote found?');
  wf.connect('Quote found?', 'Render quote', 0);
  wf.connect('Quote found?', 'Respond 404', 1);
  wf.connect('Render quote', 'Respond with XLSX file');

  const resolveOk = guardedWebhook(wf, 'POST /rfq/review/resolve', 'POST', 'rfq/review/resolve', 'resolve', [0, 800]);
  add(wf, 'Resolve line', nodes.pg(
    'SELECT rfq.try_resolve_line($1, $2::int, $3, $4::boolean, $5) AS result;',
    "={{ [ String($json.body.quote_no ?? ''), Number.isInteger(Number($json.body.line_no)) ? Number($json.body.line_no) : 0, String($json.body.sku ?? ''), $json.body.remember === true, String($json.body.resolved_by || 'api') ] }}",
  ), [220, 800], { credentials: PG });
  add(wf, 'Resolved?', nodes.ifTrue('={{ $json.result.ok }}'), [440, 800]);
  add(wf, 'Respond resolved', nodes.respondJson('={{ $json.result.quote }}'), [680, 720]);
  add(wf, 'Respond 422 (resolve)', nodes.respondJson(
    "={{ { error: 'cannot_resolve', message: $json.result.error } }}", 422,
  ), [680, 880]);
  wf.connect(resolveOk, 'Resolve line', 0);
  wf.chain('Resolve line', 'Resolved?');
  wf.connect('Resolved?', 'Respond resolved', 0);
  wf.connect('Resolved?', 'Respond 422 (resolve)', 1);

  wf.note(
    '## RFQ API (header `x-api-token`)\n`POST /webhook/rfq/quote` multipart `file` + `customer_id`, or JSON `{ customer_id, lines }`. Add `?format=xlsx` to get the Excel back directly.\n\n`GET /webhook/rfq/quote/xlsx?quote_no=Q-2026-01001` downloads the current version.\n\n`POST /webhook/rfq/review/resolve` `{ quote_no, line_no, sku, remember }` fixes a review line. With `remember: true` the customer part number is learned, so the next RFQ with that code is matched automatically.',
    [-720, -420], 620, 300, 7,
  );
  return wf;
}

export function rfqForm() {
  const wf = new Workflow({ id: 'PfRfqForm0000001', name: 'RFQ: Upload form' });
  wf.node('RFQ upload form', 'n8n-nodes-base.formTrigger', 2.6, {
    formTitle: 'Request for quotation',
    formDescription: 'Upload the customer RFQ as a PDF. You get an Excel quote back: priced lines on the first sheet, lines that need a decision on the second.',
    formFields: {
      values: [
        {
          fieldLabel: 'Customer',
          fieldName: 'customer',
          fieldType: 'dropdown',
          fieldOptions: {
            values: [
              { option: '1 · Elektro-Mont d.o.o. (project prices)' },
              { option: '2 · Brightline Installations Ltd' },
              { option: '3 · Nordic Facility Services AB' },
            ],
          },
          requiredField: true,
        },
        {
          fieldLabel: 'RFQ document (PDF)',
          fieldName: 'rfq_file',
          fieldType: 'file',
          multipleFiles: false,
          acceptFileTypes: '.pdf',
          requiredField: true,
        },
      ],
    },
    authentication: 'basicAuth',
    options: { path: 'rfq', buttonLabel: 'Create quote', appendAttribution: false },
  }, [0, 0], { credentials: { httpBasicAuth: { id: 'rfqFormLogin0001', name: 'RFQ form login' } } });
  add(wf, 'Map form input', nodes.code(code('rfq/form-map.js')), [240, 0]);
  add(wf, 'Run RFQ engine', nodes.execute(RFQ_ENGINE_ID, 'RFQ: Engine (sub-workflow)'), [480, 0]);
  add(wf, 'Quote created?', nodes.ifTrue('={{ !$json.rejected }}'), [720, 0]);
  wf.node('Could not create quote', 'n8n-nodes-base.form', 2.5, {
    operation: 'completion',
    respondWith: 'text',
    completionTitle: 'Could not create the quote',
    completionMessage: '={{ $json.message }}',
    options: {},
  }, [960, 140]);
  wf.node('Quote ready', 'n8n-nodes-base.form', 2.5, {
    operation: 'completion',
    respondWith: 'returnBinary',
    inputDataFieldName: 'data',
    completionTitle: '=Quote {{ $json.quote_no }} is ready',
    completionMessage: "={{ $json.counts.ok }} of {{ $json.counts.lines }} lines were priced automatically. {{ $json.counts.review ? $json.counts.review + ' need a decision, see the Review sheet.' : 'Nothing needs review.' }} Net total {{ $json.currency }} {{ Number($json.net_total).toFixed(2) }}.{{ $json.duplicate ? ' (This PDF was already quoted, you got the existing quote.)' : '' }}",
    options: {},
  }, [960, -80]);
  wf.chain('RFQ upload form', 'Map form input', 'Run RFQ engine', 'Quote created?');
  wf.connect('Quote created?', 'Quote ready', 0);
  wf.connect('Quote created?', 'Could not create quote', 1);
  wf.note(
    '## Form for the sales team\nOpen `/form/rfq`, log in as `sales` (password `RFQ_FORM_PASSWORD` in `.env`), pick the customer, drop the PDF, get the Excel quote back in a few seconds. Same engine as the API.',
    [-40, -220], 420, 180, 7,
  );
  return wf;
}

export default function rfqWorkflows() {
  return [rfqRender(), rfqEngine(), rfqApi(), rfqForm()];
}
