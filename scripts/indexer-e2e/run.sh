#!/bin/bash
# Indexer end-to-end against a fully local stack. Needs, already running:
#   npx hardhat node                                   (port 8545)
#   firebase emulators:start --only firestore          (port 8080)
# Usage: scripts/indexer-e2e/run.sh <indexer dir> [--replay]
#
# To leave a running local stack alone, point the harness at a second node and emulator:
#   E2E_RPC_URL=http://127.0.0.1:8546 E2E_EMULATOR_HOST=127.0.0.1:8081 scripts/indexer-e2e/run.sh <indexer dir>
# It then stops only the indexer it started, not one already running against the usual ports.
set -e
INDEXER_DIR="${1:?indexer dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$HERE/../.."
LOG="$HERE/out/indexer.log"
mkdir -p "$HERE/out"
export E2E_RPC_URL="${E2E_RPC_URL:-http://127.0.0.1:8545}"
export E2E_EMULATOR_HOST="${E2E_EMULATOR_HOST:-127.0.0.1:8080}"
export LOCAL_FIRESTORE_EMULATOR_HOST="$E2E_EMULATOR_HOST"
if [ "$E2E_EMULATOR_HOST" = "127.0.0.1:8080" ]; then MATCH='*app.py localhost*'; else MATCH='*app.py localhost*indexer-e2e*'; fi

stop_indexer() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '$MATCH' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" || true
}
start_indexer() {
    (cd "$INDEXER_DIR" && PYTHONUNBUFFERED=1 python -u app.py localhost homebase trustless --no-alerts --instance-id indexer-e2e > "$1" 2>&1 &)
}

stop_indexer
# DAOs and their Economy projects all live in homebase-6907d
curl -s -X DELETE "http://$E2E_EMULATOR_HOST/emulator/v1/projects/homebase-6907d/databases/(default)/documents" > /dev/null

cd "$CONTRACTS"
npx hardhat run scripts/indexer-e2e/deploy.js --network localhost > /dev/null
python "$HERE/seed_emulator.py" "$INDEXER_DIR"

start_indexer "$LOG"
until grep -q "Starting from block" "$LOG" 2>/dev/null; do sleep 1; done
echo "indexer up"

npx hardhat run scripts/indexer-e2e/events.js --network localhost

# Let the indexer drain: stop once the log has been quiet for 15s
last=0; quiet=0
while [ $quiet -lt 15 ]; do
    size=$(wc -c < "$LOG"); if [ "$size" = "$last" ]; then quiet=$((quiet+1)); else quiet=0; last=$size; fi; sleep 1
done
stop_indexer
echo "indexer errors: $(grep -c -i -E 'error|traceback|exception' "$LOG" || true)"
python "$HERE/verify.py" "$INDEXER_DIR" || true

# Replay: rewind both checkpoints (DAOs and projects) so a restarted indexer re-processes every
# event, then verify nothing was double counted.
if [ "$2" = "--replay" ]; then
    python - "$INDEXER_DIR" <<'PY'
import os, sys
os.environ["FIRESTORE_EMULATOR_HOST"] = os.environ.get("E2E_EMULATOR_HOST") or "127.0.0.1:8080"
import firebase_admin
from firebase_admin import credentials, firestore
db = firestore.client(firebase_admin.initialize_app(credentials.Certificate(os.path.join(sys.argv[1], "homebase.json"))))
db.collection("contracts").document("Localhost").set({"lastSyncedBlock": 1, "projectsLastSyncedBlock": 1}, merge=True)
print("checkpoints rewound to block 1")
PY
    start_indexer "$LOG.replay"
    LOG="$LOG.replay"; last=0; quiet=0
    until grep -q "Starting from block\|Resuming from checkpoint" "$LOG" 2>/dev/null; do sleep 1; done
    while [ $quiet -lt 20 ]; do
        size=$(wc -c < "$LOG"); if [ "$size" = "$last" ]; then quiet=$((quiet+1)); else quiet=0; last=$size; fi; sleep 1
    done
    stop_indexer
    echo "replay indexer errors: $(grep -c -i -E 'error|traceback|exception' "$LOG" || true)"
    python "$HERE/verify.py" "$INDEXER_DIR"
fi
