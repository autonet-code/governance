#!/bin/bash
# The owner's manual path, rehearsed headless before a manual pass: a fresh suite on its own chain,
# the werule indexer's local edge stack on the e2e ports (dev.py --e2e: indexer, publisher, file server
# 8798, Worker 8797, its own store), and werule's rehearsal_test driven in Chrome with a test wallet.
# Never touches the main local stack (8545, 8787/8788, data/werule.sqlite) or the running werule
# checkout: the app is mirrored into its own worktree (REHEARSAL_APP_DIR, default ../werule-rehearsal,
# which this OVERWRITES) and built there.
#   scripts/indexer-e2e/rehearse.sh <werule-indexer dir> <werule dir> [integration test]
# Needs chromedriver matching Chrome (CHROMEDRIVER, default ~/.tools/cd156/chromedriver-win64/chromedriver.exe).
set -e
INDEXER_DIR="${1:?werule-indexer dir}"; APP_SRC="${2:?werule dir}"; TEST="${3:-integration_test/rehearsal_test.dart}"
RPC_PORT=8546; DATA_PORT=8798; LIVE_PORT=8797; DRIVER_PORT=4445
RPC="http://127.0.0.1:$RPC_PORT"
APP_DIR="${REHEARSAL_APP_DIR:-$(dirname "$APP_SRC")/werule-rehearsal}"
CHROMEDRIVER="${CHROMEDRIVER:-$HOME/.tools/cd156/chromedriver-win64/chromedriver.exe}"
HERE="$(cd "$(dirname "$0")" && pwd)"; CONTRACTS="$HERE/../.."; OUT="$HERE/out/rehearsal"
mkdir -p "$OUT"

kill_port() { powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }" || true; }
stop_edge() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*dev.py --e2e*' } | ForEach-Object { taskkill /T /F /PID \$_.ProcessId | Out-Null }" || true
}
cleanup() { stop_edge; kill_port $DRIVER_PORT; kill_port $LIVE_PORT; kill_port $DATA_PORT; kill_port $RPC_PORT; }
trap cleanup EXIT
wait_for() { for _ in $(seq 1 "$2"); do eval "$1" > /dev/null 2>&1 && return 0; sleep 1; done; echo "timed out: $1" >&2; exit 1; }
cleanup

# The chain runs 30 seconds ahead of the browser clock, as the owner's restored node does
AHEAD=$(python -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(seconds=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
(cd "$CONTRACTS" && HARDHAT_INITIAL_DATE="$AHEAD" npx hardhat node --port $RPC_PORT > "$OUT/node.log" 2>&1 &)

("$CHROMEDRIVER" --port=$DRIVER_PORT > "$OUT/chromedriver.log" 2>&1 &)

wait_for "curl -sf -X POST -H 'content-type: application/json' --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}' $RPC" 90

WIN_OUT="$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")"
export E2E_RPC_URL="$RPC" E2E_STORE="$WIN_OUT/store.sqlite" E2E_NETWORKS="$WIN_OUT/networks-src"
rm -rf "$OUT/store.sqlite"* "$OUT/edge" "$OUT/networks-src"
cd "$CONTRACTS"
echo "deploying the suite"
npx hardhat run scripts/indexer-e2e/deploy.js --network localhost > "$OUT/deploy.log"
python "$HERE/seed_network.py"
(cd "$INDEXER_DIR" && LOG_DIR="$WIN_OUT/logs" python -u dev.py --e2e --store "$E2E_STORE" --out "$WIN_OUT/edge" --networks "dir:$E2E_NETWORKS" --poll 5 > "$OUT/edge.log" 2>&1 &)
wait_for "grep -q 'Starting from block\|Heartbeat' '$OUT/logs/Localhost-indexer.log'" 120

# The app: the owner's working copy (committed or not) mirrored into the rehearsal worktree
if [ ! -d "$APP_DIR" ]; then git -C "$APP_SRC" worktree add --detach "$APP_DIR" HEAD > /dev/null; fi
git -C "$APP_DIR" checkout -q --detach "$(git -C "$APP_SRC" rev-parse HEAD)" -f
git -C "$APP_DIR" clean -fdq
(cd "$APP_SRC" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | (cd "$APP_DIR" && tar -xf -)
# Deleted in the working copy: delete here too
(cd "$APP_SRC" && git ls-files -d -z) | (cd "$APP_DIR" && xargs -0 -r rm -f)

cd "$APP_DIR"
flutter pub get > "$OUT/pub.log" 2>&1
rm -rf build/e2e_screens
echo "driving $TEST"
set +e
flutter drive -d chrome --driver-port=$DRIVER_PORT --driver=test_driver/integration_test.dart --target="$TEST" \
    --dart-define=LOCAL=true --dart-define=LOCAL_RPC=$RPC --dart-define=EDGE_DATA_URL=http://127.0.0.1:$DATA_PORT \
    --dart-define=EDGE_LIVE_URL=ws://127.0.0.1:$LIVE_PORT --dart-define=EDGE_LIVE_HTTP_URL=http://127.0.0.1:$LIVE_PORT > "$OUT/drive.log" 2>&1
STATUS=$?
set -e
grep -E "All tests passed|Some tests failed|FAIL|Expected:|Actual:|timed out|Exception|Error:" "$OUT/drive.log" | head -30
echo "screenshots: $APP_DIR/build/e2e_screens"
echo "indexer errors: $(grep -c -i -E 'traceback|exception' "$OUT/logs/Localhost-indexer.log" || true)"
exit $STATUS
