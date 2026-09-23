import { Workflow, add, code, nodes, PG } from '../lib/wf.mjs';

const AGENT_ID = 'PfAgentSupport01';

// The agent loop. One inbound customer message goes in, and the workflow keeps
// going round - model turn, tool calls, model turn - until the model answers,
// a tool hands over to a person, or the step budget runs out.
function supportAgent() {
  const wf = new Workflow({ id: AGENT_ID, name: 'Agent: Support agent' });

  add(wf, 'POST /agent/message', nodes.webhook('POST', 'agent/message'), [0, 0]);
  add(wf, 'Authorize and validate', nodes.code(code('agent/authorize.js')), [220, 0]);
  add(wf, 'Authorized?', nodes.ifTrue('={{ $json.authorized }}'), [440, 0]);
  add(wf, 'Respond 401', nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [660, 160]);
  add(wf, 'Input valid?', nodes.ifTrue('={{ $json.ok }}'), [660, -80]);
  add(wf, 'Respond 400', nodes.respondJson('={{ { error: $json.error } }}', 400), [880, 60]);

  add(wf, 'Start run', nodes.pg(
    'SELECT agent.start_run($1::bigint, $2, $3, $4) AS r;',
    '={{ [ $json.customer_id, $json.channel, $json.message, $json.request_id ] }}',
  ), [880, -200], { credentials: PG });
  add(wf, 'Run started?', nodes.ifTrue('={{ $json.r.ok }}'), [1100, -200]);
  add(wf, 'Respond 422', nodes.respondJson('={{ { error: $json.r.error } }}', 422), [1320, -60]);
  // A retry of a message that was already dealt with gets the same answer back
  // instead of a second run against the same orders.
  add(wf, 'Already finished?', nodes.ifTrue("={{ $json.r.duplicate === true && $json.r.status !== 'running' }}"), [1320, -320]);
  add(wf, 'Respond with earlier answer', nodes.respondJson(
    '={{ { run_id: $json.r.run_id, status: $json.r.status, reply: $json.r.reply, duplicate: true } }}',
  ), [1540, -440]);
  add(wf, 'Run id', nodes.code('return [{ json: { run_id: $json.r.run_id } }];'), [1540, -240]);

  // ---- the loop ---------------------------------------------------------
  add(wf, 'Load run context', nodes.pg(
    'SELECT agent.run_context($1::bigint) AS ctx;',
    '={{ [ $json.run_id ] }}',
  ), [1760, -240], { credentials: PG });
  add(wf, 'Build LLM request', nodes.code(code('agent/build-llm-request.js')), [1980, -240]);
  wf.node('LLM: chat completions', 'n8n-nodes-base.httpRequest', 4.5, {
    method: 'POST',
    url: '={{ $env.AGENT_LLM_BASE_URL }}/chat/completions',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{ $env.OPENAI_API_KEY }}' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.request) }}',
    options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true } } },
  }, [2200, -240], { onError: 'continueRegularOutput' });
  add(wf, 'Parse LLM reply', nodes.code(code('agent/parse-llm-reply.js')), [2420, -240]);
  add(wf, 'Record model turn', nodes.pg(
    'SELECT agent.record_assistant($1::bigint, $2, $3::jsonb) AS r;',
    "={{ [ $json.run_id, $json.content, JSON.stringify(($json.tool_calls ?? []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))) ] }}",
  ), [2640, -240], { credentials: PG });
  add(wf, 'Wants to use tools?', nodes.ifTrue("={{ $('Parse LLM reply').first().json.tool_calls.length > 0 }}"), [2860, -240]);

  add(wf, 'Fan out tool calls', nodes.code(code('agent/fan-out-tool-calls.js')), [3080, -360]);
  // Every tool call goes through agent.execute_tool(), which is where the
  // allowlist, the argument checks, the ownership scoping, the money limits
  // and the idempotency live.
  add(wf, 'Tool results', nodes.pg(
    'SELECT agent.execute_tool($1::bigint, $2, $3, $4::jsonb) AS r;',
    '={{ [ $json.run_id, $json.tool_call_id, $json.tool, JSON.stringify($json.args) ] }}',
    { queryBatching: 'independently' },
  ), [3300, -360], { credentials: PG });
  add(wf, 'Decide next', nodes.code(code('agent/decide-next.js')), [3520, -360]);
  add(wf, 'Out of steps?', nodes.ifTrue("={{ $json.next === 'budget_exhausted' }}"), [3740, -360]);
  add(wf, 'Budget exhausted', nodes.code(code('agent/budget-exhausted.js')), [3960, -460]);

  add(wf, 'Final answer', nodes.code(code('agent/final-answer.js')), [3080, -120]);
  add(wf, 'Finish run', nodes.pg(
    'SELECT agent.finish_run($1::bigint, $2, $3, $4) AS r;',
    '={{ [ $json.run_id, $json.reply, $json.status, $json.outcome ] }}',
  ), [4180, -260], { credentials: PG });
  add(wf, 'Respond to customer', nodes.respondJson(
    '={{ { run_id: $json.r.run_id, status: $json.r.status, outcome: $json.r.outcome, reply: $json.r.reply, steps_used: $json.r.steps_used } }}',
  ), [4400, -260]);

  wf.chain('POST /agent/message', 'Authorize and validate', 'Authorized?');
  wf.connect('Authorized?', 'Input valid?', 0);
  wf.connect('Authorized?', 'Respond 401', 1);
  wf.connect('Input valid?', 'Start run', 0);
  wf.connect('Input valid?', 'Respond 400', 1);
  wf.connect('Start run', 'Run started?');
  wf.connect('Run started?', 'Already finished?', 0);
  wf.connect('Run started?', 'Respond 422', 1);
  wf.connect('Already finished?', 'Respond with earlier answer', 0);
  wf.connect('Already finished?', 'Run id', 1);
  wf.chain('Run id', 'Load run context', 'Build LLM request', 'LLM: chat completions',
    'Parse LLM reply', 'Record model turn', 'Wants to use tools?');
  wf.connect('Wants to use tools?', 'Fan out tool calls', 0);
  wf.connect('Wants to use tools?', 'Final answer', 1);
  wf.chain('Fan out tool calls', 'Tool results', 'Decide next', 'Out of steps?');
  wf.connect('Out of steps?', 'Budget exhausted', 0);
  // ... and round again. The next turn reads its history back out of Postgres.
  wf.connect('Out of steps?', 'Load run context', 1);
  wf.connect('Budget exhausted', 'Finish run');
  wf.connect('Final answer', 'Finish run');
  wf.connect('Finish run', 'Respond to customer');

  wf.note(
    '## An agent that is allowed to act\nThe model decides **what to try**. What it is *allowed* to do lives in `agent.execute_tool()` in Postgres.\n\nA system prompt is a request. A constraint is a guarantee. Everything a customer could lose money over is enforced in SQL:\n\n- the tool must be on the allowlist and its required arguments must be there\n- every order lookup is scoped to the customer who is actually in this conversation\n- a refund cannot exceed what is left on the order, or leave the return window\n- above the auto-refund limit nothing moves: it becomes an approval for a person\n- each tool call is idempotent on its id, so a retry cannot pay twice\n- refusals are recorded like successes, in `agent.run_steps`',
    [-60, -560], 620, 400, 7,
  );
  wf.note(
    '## The loop\nThe conversation is not carried in this execution. On every turn the workflow reads it back from `agent.run_context()`, so:\n\n- the model sees exactly what was audited, not a copy that drifted\n- a run survives an n8n restart in the middle\n- replaying the run is just reading `agent.run_steps` in order\n\n**Step budget.** `agent.config.max_steps` caps how many model turns one message may cost. Running out is a normal ending: the run is handed to a person, not left spinning.',
    [1740, -720], 600, 340, 4,
  );
  wf.note(
    '## The model is untrusted input\n`Parse LLM reply` assumes nothing: arguments may arrive as a JSON string, as broken JSON, or not at all, and the response may be an error page. Anything unusable ends the run as a hand-over, never as a crash.\n\nThe HTTP node never throws (`neverError`), so a provider outage is an escalation rather than a failed execution.',
    [2380, 60], 520, 280, 3,
  );
  return wf;
}

// The other half of the gate: what a person sees, and how they release it.
function approvals() {
  const wf = new Workflow({ id: 'PfAgentApproval1', name: 'Agent: Approvals and audit API' });

  add(wf, 'GET /agent/approvals', nodes.webhook('GET', 'agent/approvals'), [0, 0]);
  add(wf, 'Authorize (list)', nodes.code(code('payments/authorize-admin.js')), [220, 0]);
  add(wf, 'Token ok? (list)', nodes.ifTrue('={{ $json.authorized }}'), [440, 0]);
  add(wf, 'Pending queue', nodes.pg(
    'SELECT jsonb_build_object(\'pending\', agent.pending_approvals(), \'health\', agent.health()) AS r;',
  ), [660, -80], { credentials: PG });
  add(wf, 'Respond queue', nodes.respondJson('={{ $json.r }}'), [880, -80]);
  add(wf, 'Respond 401 (list)', nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [660, 100]);
  wf.chain('GET /agent/approvals', 'Authorize (list)', 'Token ok? (list)');
  wf.connect('Token ok? (list)', 'Pending queue', 0);
  wf.connect('Token ok? (list)', 'Respond 401 (list)', 1);
  wf.connect('Pending queue', 'Respond queue');

  add(wf, 'POST /agent/approvals/decide', nodes.webhook('POST', 'agent/approvals/decide'), [0, 320]);
  add(wf, 'Authorize (decide)', nodes.code(code('payments/authorize-admin.js')), [220, 320]);
  add(wf, 'Token ok? (decide)', nodes.ifTrue('={{ $json.authorized }}'), [440, 320]);
  add(wf, 'Apply decision', nodes.pg(
    'SELECT agent.decide_approval($1::bigint, $2, $3) AS r;',
    "={{ [ $json.body?.approval_id ?? 0, String($json.body?.decision ?? ''), String($json.body?.decided_by ?? 'admin') ] }}",
  ), [660, 240], { credentials: PG });
  add(wf, 'Decision applied?', nodes.ifTrue('={{ $json.r.ok }}'), [880, 240]);
  add(wf, 'Respond decision', nodes.respondJson('={{ $json.r }}'), [1100, 160]);
  add(wf, 'Respond 422 (decide)', nodes.respondJson('={{ { error: $json.r.error } }}', 422), [1100, 320]);
  add(wf, 'Respond 401 (decide)', nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [660, 420]);
  wf.chain('POST /agent/approvals/decide', 'Authorize (decide)', 'Token ok? (decide)');
  wf.connect('Token ok? (decide)', 'Apply decision', 0);
  wf.connect('Token ok? (decide)', 'Respond 401 (decide)', 1);
  wf.connect('Apply decision', 'Decision applied?');
  wf.connect('Decision applied?', 'Respond decision', 0);
  wf.connect('Decision applied?', 'Respond 422 (decide)', 1);

  add(wf, 'GET /agent/runs/trace', nodes.webhook('GET', 'agent/runs/trace'), [0, 640]);
  add(wf, 'Authorize (trace)', nodes.code(code('payments/authorize-admin.js')), [220, 640]);
  add(wf, 'Token ok? (trace)', nodes.ifTrue('={{ $json.authorized }}'), [440, 640]);
  add(wf, 'Read the audit trail', nodes.pg(
    'SELECT agent.run_trace($1::bigint) AS r;',
    "={{ [ Number($json.query?.run_id ?? 0) ] }}",
  ), [660, 560], { credentials: PG, alwaysOutputData: true });
  add(wf, 'Run exists?', nodes.ifTrue('={{ !!$json.r }}'), [880, 560]);
  add(wf, 'Respond trace', nodes.respondJson('={{ $json.r }}'), [1100, 480]);
  add(wf, 'Respond 404 (trace)', nodes.respondJson("={{ { error: 'run_not_found' } }}", 404), [1100, 640]);
  add(wf, 'Respond 401 (trace)', nodes.respondJson("={{ { error: 'unauthorized' } }}", 401), [660, 740]);
  wf.chain('GET /agent/runs/trace', 'Authorize (trace)', 'Token ok? (trace)');
  wf.connect('Token ok? (trace)', 'Read the audit trail', 0);
  wf.connect('Token ok? (trace)', 'Respond 401 (trace)', 1);
  wf.connect('Read the audit trail', 'Run exists?');
  wf.connect('Run exists?', 'Respond trace', 0);
  wf.connect('Run exists?', 'Respond 404 (trace)', 1);

  wf.note(
    '## What a person sees (header `x-admin-token`)\n`GET /webhook/agent/approvals` - everything the agent asked permission for, with the customer, the order, the amount and the message that led to it.\n\n`POST /webhook/agent/approvals/decide` `{ approval_id, decision, decided_by }` - releases it. The money rules are checked **again** at this moment, because the order may have changed since the agent asked.\n\n`GET /webhook/agent/runs/trace?run_id=N` - the whole run, step by step: every model turn, every tool call, every refusal.\n\nIn production these back an inbox view in the support tool.',
    [-60, -320], 620, 340, 7,
  );
  return wf;
}

function mockAgentLlm() {
  const wf = new Workflow({ id: 'PfMockAgentLlm01', name: 'Mock: Agent LLM' });
  add(wf, 'POST /mock/llm-agent/chat/completions', nodes.webhook('POST', 'mock/llm-agent/chat/completions'), [0, 0]);
  add(wf, 'Scripted completion', nodes.code(code('mock/agent-completion.js')), [240, 0]);
  add(wf, 'Respond', nodes.respondJson('={{ $json }}'), [480, 0]);
  wf.chain('POST /mock/llm-agent/chat/completions', 'Scripted completion', 'Respond');
  wf.note(
    '## Test double for the model\nSpeaks the OpenAI chat completions format, tool calls included, and is deliberately **obedient**: told by a customer message to refund somebody else\'s order, it tries.\n\nThat is the point. The guarantees come from `agent.execute_tool()`, so proving them needs a model that will happily do the wrong thing.\n\nPoint `AGENT_LLM_BASE_URL` at a real provider to swap it out. Nothing else changes.',
    [-40, -280], 480, 240, 3,
  );
  return wf;
}

export default function agentWorkflows() {
  return [mockAgentLlm(), supportAgent(), approvals()];
}
