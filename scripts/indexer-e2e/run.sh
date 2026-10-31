#!/bin/bash
# Indexer end-to-end on its own hardhat node and Firestore emulator. It deploys, wipes the
# emulator and moves the chain's clock, so it never runs against the owner's local stack:
#   npx hardhat node --port 8546
#   firebase emulators:start --only firestore (on 8081)
#   E2E_RPC_URL=http://127.0.0.1:8546 E2E_EMULATOR_HOST=127.0.0.1:8081 scripts/indexer-e2e/run.sh <indexer dir> [--replay]
# Both variables are required, and 8545/8080 are refused unless E2E_ALLOW_MAIN_STACK=1.
# It stops only the indexer it started.
set -e
INDEXER_DIR="${1:?indexer dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$HERE/../.."
LOG="$HERE/out/indexer.log"
mkdir -p "$HERE/out"
: "${E2E_RPC_URL:?set E2E_RPC_URL to the e2e node, e.g. http://127.0.0.1:8546}"
: "${E2E_EMULATOR_HOST:?set E2E_EMULATOR_HOST to the e2e emulator, e.g. 127.0.0.1:8081}"
case "$E2E_RPC_URL $E2E_EMULATOR_HOST" in
    *:8545*|*:8080*) if [ "$E2E_ALLOW_MAIN_STACK" != "1" ]; then
        echo "Refusing to run against the main local stack (8545/8080); use other ports" >&2; exit 2; fi ;;
esac
export E2E_RPC_URL E2E_EMULATOR_HOST
export LOCAL_FIRESTORE_EMULATOR_HOST="$E2E_EMULATOR_HOST"
export LOCAL_RPC_URL="$E2E_RPC_URL"
if [ "$E2E_EMULATOR_HOST" = "127.0.0.1:8080" ]; then MATCH='*app.py localhost*'; else MATCH='*app.py localhost*indexer-e2e*'; fi

stop_indexer() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '$MATCH' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" || true
}
start_indexer() {
    # autonet too: a jurisdiction's agent events reach its DAO's activity feed through it
    (cd "$INDEXER_DIR" && PYTHONUNBUFFERED=1 python -u app.py localhost homebase trustless autonet --no-alerts --instance-id indexer-e2e > "$1" 2>&1 &)
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
npx hardhat run scripts/indexer-e2e/legacy.js --network localhost

# Let the indexer drain: stop once the log has been quiet for 15s
last=0; quiet=0
while [ $quiet -lt 15 ]; do
    size=$(wc -c < "$LOG"); if [ "$size" = "$last" ]; then quiet=$((quiet+1)); else quiet=0; last=$size; fi; sleep 1
done
stop_indexer
echo "indexer errors: $(grep -c -i -E 'error|traceback|exception' "$LOG" || true)"
python "$HERE/verify.py" "$INDEXER_DIR" || true

# Downtime: a DAO and proposals created, voted and executed while the indexer is stopped. The restart
# catches up through the historical sync and then the main loop's replay of the same blocks; nothing
# recorded may be reset (verify checks the downtime proposals' tallies and their proposers' records).
npx hardhat run scripts/indexer-e2e/downtime.js --network localhost
start_indexer "$LOG.downtime"
until grep -q "Resuming from checkpoint\|Starting from block" "$LOG.downtime" 2>/dev/null; do sleep 1; done
last=0; quiet=0
while [ $quiet -lt 20 ]; do
    size=$(wc -c < "$LOG.downtime"); if [ "$size" = "$last" ]; then quiet=$((quiet+1)); else quiet=0; last=$size; fi; sleep 1
done
stop_indexer
echo "downtime indexer errors: $(grep -c -i -E 'error|traceback|exception' "$LOG.downtime" || true)"
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
