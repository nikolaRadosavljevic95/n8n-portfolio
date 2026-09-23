// After the tools have run: go round again, or stop and answer.
//
// The step budget is what stops a model that keeps calling tools from running
// up a bill or spinning forever. Running out is a normal outcome with a
// sensible ending, not an error.
const results = $input.all().map((i) => i.json.r ?? i.json);
const parsed = $('Parse LLM reply').first().json;
const ctx = $('Load run context').first().json.ctx;

const budgetLeft = (ctx.budget_left ?? 0) - 1;
const needsApproval = results.some((r) => r?.status === 'needs_approval');
const escalated = results.some((r) => r?.status === 'escalated');

let next = 'continue';
if (escalated) next = 'escalate';
else if (budgetLeft <= 0) next = 'budget_exhausted';

return [{
  json: {
    run_id: parsed.run_id,
    next,
    budget_left: Math.max(budgetLeft, 0),
    needs_approval: needsApproval,
    tools_run: results.map((r) => ({ tool: r?.tool, status: r?.status, reason: r?.reason ?? null })),
  },
}];
