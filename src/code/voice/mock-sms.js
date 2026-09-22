return $input.all().map((i) => {
  const m = i.json;
  const fail = /0000$/.test(m.recipient);
  return {
    json: {
      id: m.id,
      ok: !fail,
      provider_ref: fail ? null : `mock-${m.id}-${Date.now()}`,
      error: fail ? 'Mock gateway: number unreachable' : null,
    },
  };
});
