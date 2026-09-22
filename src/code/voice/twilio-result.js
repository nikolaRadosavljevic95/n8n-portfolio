const claimed = $('Claim due SMS').all().map((i) => i.json);

return $input.all().map((i, idx) => ({
  json: {
    id: claimed[idx]?.id,
    ok: !i.json.error,
    provider_ref: i.json.sid ?? null,
    error: i.json.error ? String(i.json.error.message ?? i.json.error) : null,
  },
}));
