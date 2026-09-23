// The agent used its whole step budget without reaching an answer. It hands
// over instead of carrying on, and the audit trail shows exactly how far it got.
const ctx = $('Load run context').first().json.ctx;

return [{
  json: {
    run_id: ctx.run_id,
    status: 'escalated',
    outcome: 'step_budget_exhausted',
    reply: 'I have not managed to sort this out myself, so I am passing you to a colleague who will reply shortly.',
  },
}];
