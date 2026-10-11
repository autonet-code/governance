#!/bin/bash
# Indexer end-to-end against a fully local stack. Needs, already running:
#   npx hardhat node                                   (port 8545)
#   firebase emulators:start --only firestore          (port 8080)
# Usage: scripts/indexer-e2e/run.sh <indexer dir>
set -e
INDEXER_DIR="${1:?indexer dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$HERE/../.."
LOG="$HERE/out/indexer.log"
mkdir -p "$HERE/out"

stop_indexer() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*app.py localhost*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" || true
}

stop_indexer
for project in homebase-6907d trustless-58262; do
    curl -s -X DELETE "http://127.0.0.1:8080/emulator/v1/projects/$project/databases/(default)/documents" > /dev/null
done
rm -f "$INDEXER_DIR/indexer_state_localhost.db"

cd "$CONTRACTS"
npx hardhat run scripts/indexer-e2e/deploy.js --network localhost > /dev/null
python "$HERE/seed_emulator.py" "$INDEXER_DIR"

(cd "$INDEXER_DIR" && PYTHONUNBUFFERED=1 python -u app.py localhost homebase trustless --no-alerts > "$LOG" 2>&1 &)
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

# Replay: rewind both checkpoints so a restarted indexer re-processes every event, then verify
# nothing was double counted.
if [ "$2" = "--replay" ]; then
    python - "$INDEXER_DIR" <<'PY'
import os, sys
os.environ["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8080"
import firebase_admin
from firebase_admin import credentials, firestore
for name, cred in [("homebase", "homebase.json"), ("trustless", "secrets/trustless.json")]:
    db = firestore.client(firebase_admin.initialize_app(credentials.Certificate(os.path.join(sys.argv[1], cred)), name=name))
    db.collection("contracts").document("Localhost").set({"lastSyncedBlock": 1}, merge=True)
print("checkpoints rewound to block 1")
PY
    rm -f "$INDEXER_DIR/indexer_state_localhost.db"
    (cd "$INDEXER_DIR" && PYTHONUNBUFFERED=1 python -u app.py localhost homebase trustless --no-alerts > "$LOG.replay" 2>&1 &)
    LOG="$LOG.replay"; last=0; quiet=0
    until grep -q "Starting from block\|Resuming from checkpoint" "$LOG" 2>/dev/null; do sleep 1; done
    while [ $quiet -lt 20 ]; do
        size=$(wc -c < "$LOG"); if [ "$size" = "$last" ]; then quiet=$((quiet+1)); else quiet=0; last=$size; fi; sleep 1
    done
    stop_indexer
    echo "replay indexer errors: $(grep -c -i -E 'error|traceback|exception' "$LOG" || true)"
    python "$HERE/verify.py" "$INDEXER_DIR"
fi
