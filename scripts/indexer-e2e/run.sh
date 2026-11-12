#!/bin/bash
# Indexer end-to-end on its own hardhat node and a scratch document store. It deploys, wipes the store
# and moves the chain's clock, so it never runs against the owner's local stack:
#   npx hardhat node --port 8546
#   E2E_RPC_URL=http://127.0.0.1:8546 scripts/indexer-e2e/run.sh <werule-indexer dir> [--replay]
# 8545 is refused unless E2E_ALLOW_MAIN_STACK=1. The store (out/store.sqlite) and the network file
# (out/networks-src/networks/Localhost.json) are the run's own. It stops only the indexer it started.
set -e
INDEXER_DIR="${1:?werule-indexer dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$HERE/../.."
LOG="$HERE/out/indexer.log"
mkdir -p "$HERE/out"
: "${E2E_RPC_URL:?set E2E_RPC_URL to the e2e node, e.g. http://127.0.0.1:8546}"
case "$E2E_RPC_URL" in
    *:8545*) if [ "$E2E_ALLOW_MAIN_STACK" != "1" ]; then
        echo "Refusing to run against the main local chain (8545); use another port" >&2; exit 2; fi ;;
esac
export E2E_RPC_URL
# Python on Windows needs C:/... paths, not Git Bash /c/... ones
WIN_OUT="$(cygpath -m "$HERE/out" 2>/dev/null || echo "$HERE/out")"
export E2E_STORE="$WIN_OUT/store.sqlite" E2E_NETWORKS="$WIN_OUT/networks-src"
export DOCSTORE_PATH="$E2E_STORE" NETWORKS_SOURCE="dir:$E2E_NETWORKS"
MATCH='*app.py Localhost*indexer-e2e*'

stop_indexer() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '$MATCH' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" || true
}
start_indexer() {
    # every module: DAOs, projects, and the agents' events in their DAOs' activity feeds
    (cd "$INDEXER_DIR" && PYTHONUNBUFFERED=1 python -u app.py Localhost --no-alerts --instance-id indexer-e2e > "$1" 2>&1 &)
}

stop_indexer
rm -f "$E2E_STORE" "$E2E_STORE-wal" "$E2E_STORE-shm"

cd "$CONTRACTS"
npx hardhat run scripts/indexer-e2e/deploy.js --network localhost > /dev/null
python "$HERE/seed_network.py"

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
sys.path.insert(0, os.path.abspath(sys.argv[1]))
import docstore
db = docstore.Client(os.environ["E2E_STORE"])
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
