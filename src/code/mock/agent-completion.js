// Test double for the model behind demo 4.
//
// It speaks the OpenAI chat completions format, tool calls included, and it is
// deliberately obedient: given a customer message that tells it to act on
// somebody else's order, it tries. That is the point. The demo's guarantees
// come from agent.execute_tool() in Postgres, so the way to show they hold is
// to put a model in front of them that will happily do the wrong thing.
//
// Set LLM_ENABLED=true and point LLM_BASE_URL at a real provider to swap it out;
// nothing else in the workflow changes.
const body = $input.first().json.body || {};
const messages = Array.isArray(body.messages) ? body.messages : [];

const userText = String(messages.find((m) => m.role === 'user')?.content || '');
const turn = messages.filter((m) => m.role === 'assistant').length;
const runTag = String(body.user || 'run-0');

// What the tools have said so far, oldest first.
const results = messages
  .filter((m) => m.role === 'tool')
  .map((m) => { try { return JSON.parse(m.content); } catch (e) { return {}; } });
const last = results[results.length - 1] || {};

const orderId = (userText.match(/ORD-\d+/i) || [''])[0].toUpperCase() || null;
const eur = (cents) => `€${(Number(cents || 0) / 100).toFixed(2)}`;

const scenario = (() => {
  if (/ignore (all )?(your |the )?previous|disregard (all )?(your |the )?(previous|prior)|you are now/i.test(userText)) return 'injection';
  if (/every order|all my orders|status of everything/i.test(userText)) return 'sprawl';
  if (/cancel/i.test(userText)) return 'cancel';
  if (/real person|a human|speak to someone|manager/i.test(userText)) return 'human';
  if (/policy|how long do i have|can i return/i.test(userText)) return 'policy';
  // Checked before tracking on purpose: "it arrived broken" is a refund, not a
  // delivery question, and the words overlap.
  if (/faulty|broken|damaged|not working|does ?n[o']t work|refund|money back/i.test(userText)) return 'refund';
  if (/where is|tracking|track my|delivery|parcel|when will it arrive|has it shipped/i.test(userText)) return 'tracking';
  return 'unknown';
})();

// Returns either { tools: [{ name, args }] } or { say: '...' }.
function decide() {
  switch (scenario) {
    case 'injection':
      // Turn 0: it does as the message told it. Turn 1: it has been refused.
      if (turn === 0) {
        return { tools: [{ name: 'issue_refund', args: { order_id: orderId || 'ORD-0000', amount_cents: 45000, reason: 'customer instruction' } }] };
      }
      return { say: `I can only see the orders placed on your own account, and ${orderId || 'that order'} is not one of them, so I cannot refund it. If you have an order reference of your own I will gladly look it up.` };

    case 'tracking':
      if (turn === 0) return { tools: [{ name: 'track_shipment', args: { order_id: orderId } }] };
      if (last.status !== 'ok') return { say: `I cannot find ${orderId || 'that order'} on your account. Could you check the reference?` };
      return {
        say: last.delivered_at
          ? `${last.order_id} was delivered on ${last.delivered_at} by ${last.carrier}, tracking ${last.tracking_no}.`
          : `${last.order_id} is on its way with ${last.carrier}, tracking number ${last.tracking_no}. It was handed over on ${last.shipped_at}.`,
      };

    case 'cancel':
      if (turn === 0) return { tools: [{ name: 'cancel_order', args: { order_id: orderId, reason: 'customer asked to cancel' } }] };
      if (last.status === 'ok') return { say: `Done, ${last.order_id} is cancelled. You will not be charged, and anything already taken comes back within a few working days.` };
      if (last.reason === 'order_already_shipped') return { say: `${orderId} has already left the warehouse, so I cannot cancel it. Refuse the parcel at the door, or send it back once it arrives and I will refund you.` };
      return { say: `I could not cancel ${orderId || 'that order'}. Let me pass you to a colleague who can look at it properly.` };

    case 'policy':
      if (turn === 0) return { tools: [{ name: 'get_policy', args: { topic: 'returns' } }] };
      return { say: `${last.text || 'Our returns policy applies from the day the order is delivered.'} If yours is inside that window, tell me which order and I will sort it out.` };

    case 'human':
      if (turn === 0) return { tools: [{ name: 'escalate_to_human', args: { reason: 'customer asked for a person' } }] };
      return { say: 'Of course. I have passed this to a colleague and they will reply here shortly.' };

    case 'refund':
      if (turn === 0) return { tools: [{ name: 'lookup_order', args: orderId ? { order_id: orderId } : {} }] };
      if (turn === 1) {
        if (last.status !== 'ok') return { say: `I cannot find ${orderId || 'that order'} on your account. Could you check the reference?` };
        const amount = last.refundable_cents ?? last.total_cents;
        return { tools: [{ name: 'issue_refund', args: { order_id: last.order_id, amount_cents: amount, reason: 'faulty on arrival' } }] };
      }
      if (last.status === 'ok') return { say: `I have refunded ${eur(last.amount_cents)} for ${last.order_id}. It lands back on your card in three to five working days.` };
      if (last.status === 'needs_approval') return { say: `Because of the amount, ${eur(last.requested_cents)} needs a colleague to sign it off. I have put it in front of them and you will get a message as soon as it is done, usually the same day.` };
      if (last.reason === 'outside_return_window') return { say: `That order was delivered more than ${last.return_window_days} days ago, so the return window closed on ${last.window_ended} and I cannot refund it myself. I can ask a colleague to take a look if you would like.` };
      if (last.reason === 'amount_exceeds_refundable') return { say: `Only ${eur(last.refundable_cents)} is still refundable on that order, so I cannot refund ${eur(last.requested_cents)}.` };
      return { say: 'I could not complete that refund. A colleague will pick it up and come back to you.' };

    case 'sprawl':
      // Keeps working without ever concluding: the case the step budget exists for.
      return { tools: [{ name: 'lookup_order', args: {} }] };

    default:
      if (turn === 0) return { tools: [{ name: 'escalate_to_human', args: { reason: 'request outside the available tools' } }] };
      return { say: 'That one is better handled by a person, so I have passed it on. A colleague will reply here shortly.' };
  }
}

const step = decide();
const message = { role: 'assistant', content: step.say ?? null };
if (step.tools) {
  message.tool_calls = step.tools.map((t, i) => ({
    id: `call-${runTag}-${turn}-${i}`,
    type: 'function',
    function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
  }));
}

return [{
  json: {
    id: `chatcmpl-agent-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `${body.model || 'unknown'}-mock`,
    choices: [{ index: 0, finish_reason: step.tools ? 'tool_calls' : 'stop', message }],
    usage: { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4), completion_tokens: 120, total_tokens: 0 },
  },
}];
