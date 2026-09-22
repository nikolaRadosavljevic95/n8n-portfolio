import { Workflow, add, code, nodes, PG } from '../lib/wf.mjs';

export function opsErrorHandler() {
  const wf = new Workflow({ id: 'PfOpsErrorHandlr', name: 'Ops: Error handler', errorWorkflow: null });
  wf.node('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, {}, [0, 0]);
  add(wf, 'Log error and raise alert', nodes.pg(
    `WITH e AS (
    INSERT INTO ops.workflow_errors (workflow_id, workflow_name, execution_id, execution_url, node_name,
                                     error_message, error_stack, mode)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
)
INSERT INTO ops.alerts (severity, source, title, details)
SELECT 'critical', 'n8n', 'Workflow failed: ' || coalesce($2, 'unknown'),
       jsonb_build_object('error_id', e.id, 'node', $5, 'message', $6, 'execution_url', $4)
FROM e
RETURNING id AS alert_id;`,
    `={{ [ $json.workflow?.id ?? null, $json.workflow?.name ?? null, $json.execution?.id ?? null, $json.execution?.url ?? null, $json.execution?.lastNodeExecuted ?? null, $json.execution?.error?.message ?? null, $json.execution?.error?.stack ?? null, $json.execution?.mode ?? null ] }}`,
  ), [240, 0], { credentials: PG });
  wf.connect('Error Trigger', 'Log error and raise alert');
  wf.note(
    '## Central error handler\nEvery workflow in this project points here (Settings > Error workflow).\n\nFailures land in `ops.workflow_errors` and raise a row in `ops.alerts`, so nothing fails silently.\n\nIn production, add a Slack / Teams / email node after the SQL step.',
    [-40, -260], 420, 220, 7,
  );
  return wf;
}

export function utilBuildXlsx() {
  const wf = new Workflow({ id: 'PfUtilBuildXlsx0', name: 'Util: Build XLSX' });
  add(wf, 'When called by another workflow', nodes.subworkflowTrigger(), [0, 0]);
  add(wf, 'Write XLSX', nodes.code(code('util/write-xlsx.js')), [240, 0]);
  wf.connect('When called by another workflow', 'Write XLSX');
  wf.note(
    '## Reusable multi-sheet XLSX writer\nn8n\'s Convert to File node writes one sheet only. This utility writes a real .xlsx with several sheets, styles, frozen header, filters and money formats. No external libraries, so it runs on any n8n instance.\n\n**Input** `{ fileName, sheets: [{ name, colWidths, freezeRows, autoFilter, rows }] }`\nA cell is a value or `{ v, s }`, where `s` is a style: title, bold, header, cell, money, review, wrap, muted...\n\n**Output** binary `data`',
    [-40, -320], 520, 280, 7,
  );
  return wf;
}
