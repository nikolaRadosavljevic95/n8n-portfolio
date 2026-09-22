#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

wait_ready() {
  for _ in $(seq 1 90); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:5678/healthz/readiness)" = "200" ]; then sleep 3; return 0; fi
    sleep 2
  done
  echo "n8n did not become ready" >&2; exit 1
}

echo "== Restarting n8n with the mock LLM"
LLM_ENABLED=true LLM_BASE_URL=http://localhost:5678/webhook/mock/llm docker compose up -d n8n >/dev/null
wait_ready
status=0
node tests/run-all.mjs llm || status=$?

echo "== Restoring normal configuration"
docker compose up -d n8n >/dev/null
wait_ready
exit $status
