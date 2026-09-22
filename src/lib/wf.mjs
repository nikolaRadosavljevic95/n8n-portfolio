import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PG = { postgres: { id: 'pgAppsCred000001', name: 'Apps DB (Postgres)' } };
export const ERROR_WORKFLOW_ID = 'PfOpsErrorHandlr';

export function code(relPath) {
  return fs.readFileSync(path.join(ROOT, 'src', 'code', relPath), 'utf8').trimEnd();
}

export function sql(relPath) {
  return fs.readFileSync(path.join(ROOT, 'src', 'sql', relPath), 'utf8').trimEnd();
}

function uuidFrom(seed) {
  const h = crypto.createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class Workflow {
  constructor({ id, name, errorWorkflow = ERROR_WORKFLOW_ID }) {
    this.id = id;
    this.name = name;
    this.errorWorkflow = errorWorkflow;
    this.nodes = [];
    this.connections = {};
    this.stickyCount = 0;
  }

  node(name, type, typeVersion, parameters, position, extra = {}) {
    if (this.nodes.some((n) => n.name === name)) throw new Error(`Duplicate node name "${name}" in ${this.name}`);
    const node = {
      parameters,
      id: uuidFrom(`${this.id}:${name}`),
      name,
      type,
      typeVersion,
      position,
      ...extra,
    };
    if (type === 'n8n-nodes-base.webhook' || type === 'n8n-nodes-base.formTrigger' || type === 'n8n-nodes-base.form') {
      node.webhookId = uuidFrom(`${this.id}:${name}:webhook`);
    }
    this.nodes.push(node);
    return name;
  }

  connect(from, to, output = 0, input = 0) {
    for (const n of [from, to]) {
      if (!this.nodes.some((x) => x.name === n)) throw new Error(`Unknown node "${n}" in ${this.name}`);
    }
    this.connections[from] ??= { main: [] };
    const main = this.connections[from].main;
    while (main.length <= output) main.push([]);
    main[output].push({ node: to, type: 'main', index: input });
    return to;
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
    return names[names.length - 1];
  }

  note(content, position, width = 360, height = 200, color = 7) {
    this.stickyCount += 1;
    this.node(`Note ${this.stickyCount}`, 'n8n-nodes-base.stickyNote', 1, { content, height, width, color }, position);
  }

  toJSON() {
    const settings = { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' };
    if (this.errorWorkflow && this.errorWorkflow !== this.id) settings.errorWorkflow = this.errorWorkflow;
    return {
      id: this.id,
      name: this.name,
      nodes: this.nodes,
      connections: this.connections,
      settings,
      pinData: {},
      active: false,
    };
  }
}

export const nodes = {
  code: (jsCode, mode = 'runOnceForAllItems') => ['n8n-nodes-base.code', 2, { mode, jsCode }],
  pg: (query, replacement, extraOptions = {}) => [
    'n8n-nodes-base.postgres',
    2.7,
    {
      operation: 'executeQuery',
      query,
      options: { ...(replacement ? { queryReplacement: replacement } : {}), ...extraOptions },
    },
  ],
  subworkflowTrigger: () => ['n8n-nodes-base.executeWorkflowTrigger', 1.1, { inputSource: 'passthrough' }],
  execute: (workflowId, cachedName, wait = true) => [
    'n8n-nodes-base.executeWorkflow',
    1.3,
    {
      workflowId: { __rl: true, value: workflowId, mode: 'list', cachedResultName: cachedName },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {},
        matchingColumns: [],
        schema: [],
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      mode: 'once',
      options: { waitForSubWorkflow: wait },
    },
  ],
  webhook: (method, path, extraOptions = {}) => [
    'n8n-nodes-base.webhook',
    2.1,
    { httpMethod: method, path, responseMode: 'responseNode', options: extraOptions },
  ],
  respondJson: (body, status = 200, headers = []) => [
    'n8n-nodes-base.respondToWebhook',
    1.5,
    {
      respondWith: 'json',
      responseBody: body,
      options: {
        responseCode: status,
        ...(headers.length ? { responseHeaders: { entries: headers.map(([name, value]) => ({ name, value })) } } : {}),
      },
    },
  ],
  respondBinary: (fieldName = 'data') => [
    'n8n-nodes-base.respondToWebhook',
    1.5,
    { respondWith: 'binary', responseDataSource: 'set', inputDataFieldName: fieldName, options: {} },
  ],
  ifTrue: (expression) => [
    'n8n-nodes-base.if',
    2.3,
    {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
        conditions: [
          {
            id: crypto.createHash('md5').update(expression).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5'),
            leftValue: expression,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
  ],
  switchOn: (valueExpression, cases, fallback = true) => [
    'n8n-nodes-base.switch',
    3.4,
    {
      rules: {
        values: cases.map((c) => ({
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
            conditions: [
              {
                id: crypto.createHash('md5').update(valueExpression + c).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5'),
                leftValue: valueExpression,
                rightValue: c,
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: c,
        })),
      },
      options: fallback ? { fallbackOutput: 'extra', renameFallbackOutput: 'other' } : {},
    },
  ],
};

export function add(wf, name, spec, position, extra = {}) {
  const [type, version, params] = spec;
  return wf.node(name, type, version, params, position, extra);
}
