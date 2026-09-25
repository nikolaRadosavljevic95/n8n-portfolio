#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  gen() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
  cat > .env <<EOF
POSTGRES_USER=n8n
POSTGRES_PASSWORD=$(gen 12)
N8N_ENCRYPTION_KEY=$(gen 24)
LLM_ENABLED=false
VOICE_WEBHOOK_SECRET=$(gen 16)
PAYMENTS_SIGNING_SECRET=whsec_$(gen 16)
ADMIN_API_TOKEN=$(gen 16)
AGENT_API_TOKEN=$(gen 16)
RFQ_API_TOKEN=$(gen 16)
RFQ_FORM_PASSWORD=$(gen 8)
RETELL_API_KEY=key_$(gen 16)
EOF
  echo "Created .env with random secrets"
fi
# Keys added after the first release: append them to an existing .env.
for key in RFQ_API_TOKEN RFQ_FORM_PASSWORD RETELL_API_KEY; do
  if ! grep -q "^$key=" .env; then
    echo "$key=$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")" >> .env
    echo "Added $key to .env"
  fi
done
set -a; . ./.env; set +a

N8N=n8n-portfolio-n8n-1
PG=n8n-portfolio-postgres-1

echo "== Building workflows"
node scripts/build-workflows.mjs

echo "== Starting containers"
docker compose up -d

wait_ready() {
  for _ in $(seq 1 90); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:5678/healthz/readiness)" = "200" ]; then return 0; fi
    sleep 2
  done
  echo "n8n did not become ready" >&2; exit 1
}
wait_ready

echo "== Applying database schema and seed data"
for f in db/[1-9]*.sql; do
  docker exec -i "$PG" psql -U "$POSTGRES_USER" -d apps -v ON_ERROR_STOP=1 -q < "$f" 2>&1 | grep -v NOTICE || true
done

echo "== Importing credentials"
tmp=.credentials.tmp.json
cat > "$tmp" <<EOF
[{"id":"pgAppsCred000001","name":"Apps DB (Postgres)","type":"postgres","data":{"host":"postgres","database":"apps","user":"$POSTGRES_USER","password":"$POSTGRES_PASSWORD","port":5432,"ssl":"disable","allowUnauthorizedCerts":false,"maxConnections":20}},
 {"id":"openAiCred000001","name":"OpenAI","type":"openAiApi","data":{"apiKey":"${OPENAI_API_KEY:-not-configured}","url":"https://api.openai.com/v1","header":false}},
 {"id":"twilioCred000001","name":"Twilio","type":"twilioApi","data":{"authType":"authToken","accountSid":"${TWILIO_ACCOUNT_SID:-not-configured}","authToken":"${TWILIO_AUTH_TOKEN:-not-configured}"}},
 {"id":"rfqFormLogin0001","name":"RFQ form login","type":"httpBasicAuth","data":{"user":"sales","password":"$RFQ_FORM_PASSWORD"}}]
EOF
docker cp "$tmp" "$N8N":/tmp/credentials.json
rm -f "$tmp"
docker exec "$N8N" n8n import:credentials --input=/tmp/credentials.json | tail -1
docker exec -u root "$N8N" rm -f /tmp/credentials.json

echo "== Importing and publishing workflows"
docker exec "$N8N" n8n import:workflow --separate --input=/import/workflows | tail -1
for id in $(node -e "const fs=require('fs');for(const f of fs.readdirSync('workflows'))if(f.endsWith('.json'))console.log(JSON.parse(fs.readFileSync('workflows/'+f)).id)"); do
  docker exec "$N8N" n8n publish:workflow --id="$id" >/dev/null 2>&1 || echo "  could not publish $id"
done

echo "== Restarting n8n so published webhooks go live"
docker compose restart n8n >/dev/null
wait_ready
sleep 3
echo "Done. Editor: http://localhost:5678   RFQ form: http://localhost:5678/form/rfq (user: sales, password: RFQ_FORM_PASSWORD in .env)"
