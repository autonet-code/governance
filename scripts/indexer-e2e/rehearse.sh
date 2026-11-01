#!/bin/bash
# The owner's manual path, rehearsed headless before a manual pass: a fresh suite on its own chain
# and emulator, an indexer instance, and werule's rehearsal_test driven in Chrome with a test wallet.
# Never touches the main local stack (8545/8080/4000/4400) or the running werule checkout: the app
# is mirrored into its own worktree and built there.
#   scripts/indexer-e2e/rehearse.sh <indexer dir> <werule dir> [integration test]
# Needs chromedriver matching Chrome (CHROMEDRIVER, default ~/.tools/cd156/chromedriver-win64/chromedriver.exe).
set -e
INDEXER_DIR="${1:?indexer dir}"; APP_SRC="${2:?werule dir}"; TEST="${3:-integration_test/rehearsal_test.dart}"
RPC_PORT=8546; EMU_PORT=8081; HUB_PORT=4402; DRIVER_PORT=4445
RPC="http://127.0.0.1:$RPC_PORT"; EMU="127.0.0.1:$EMU_PORT"
INSTANCE=indexer-e2e-rehearsal
APP_DIR="${REHEARSAL_APP_DIR:-$(dirname "$APP_SRC")/werule-rehearsal}"
CHROMEDRIVER="${CHROMEDRIVER:-$HOME/.tools/cd156/chromedriver-win64/chromedriver.exe}"
HERE="$(cd "$(dirname "$0")" && pwd)"; CONTRACTS="$HERE/../.."; OUT="$HERE/out/rehearsal"
mkdir -p "$OUT"

kill_port() { powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }" || true; }
stop_indexer() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*--instance-id $INSTANCE*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" || true
}
cleanup() { stop_indexer; kill_port $DRIVER_PORT; kill_port $EMU_PORT; kill_port $HUB_PORT; kill_port $RPC_PORT; }
trap cleanup EXIT
wait_for() { for _ in $(seq 1 "$2"); do eval "$1" > /dev/null 2>&1 && return 0; sleep 1; done; echo "timed out: $1" >&2; exit 1; }
cleanup

# The chain runs 30 seconds ahead of the browser clock, as the owner's restored node does
AHEAD=$(python -c "import datetime as d;print((d.datetime.now(d.timezone.utc)+d.timedelta(seconds=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
(cd "$CONTRACTS" && HARDHAT_INITIAL_DATE="$AHEAD" npx hardhat node --port $RPC_PORT > "$OUT/node.log" 2>&1 &)

cat > "$OUT/firebase.json" <<EOF
{ "emulators": { "firestore": { "host": "127.0.0.1", "port": $EMU_PORT }, "hub": { "port": $HUB_PORT }, "ui": { "enabled": false }, "logging": { "port": 4502 } } }
EOF
(cd "$OUT" && firebase emulators:start --only firestore --project homebase-6907d --config firebase.json > "$OUT/emulator.log" 2>&1 &)
("$CHROMEDRIVER" --port=$DRIVER_PORT > "$OUT/chromedriver.log" 2>&1 &)

wait_for "curl -sf -X POST -H 'content-type: application/json' --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}' $RPC" 90
wait_for "curl -sf http://$EMU/" 90

export E2E_RPC_URL="$RPC" E2E_EMULATOR_HOST="$EMU" LOCAL_RPC_URL="$RPC" LOCAL_FIRESTORE_EMULATOR_HOST="$EMU"
cd "$CONTRACTS"
echo "deploying the suite"
npx hardhat run scripts/indexer-e2e/deploy.js --network localhost > "$OUT/deploy.log"
python "$HERE/seed_emulator.py" "$INDEXER_DIR"
(cd "$INDEXER_DIR" && PYTHONUNBUFFERED=1 python -u app.py localhost homebase trustless autonet --no-alerts --instance-id $INSTANCE > "$OUT/indexer.log" 2>&1 &)
wait_for "grep -q 'Starting from block\|Heartbeat' '$OUT/indexer.log'" 120

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
    --dart-define=LOCAL=true --dart-define=LOCAL_RPC=$RPC --dart-define=LOCAL_FIRESTORE=$EMU > "$OUT/drive.log" 2>&1
STATUS=$?
set -e
grep -E "All tests passed|Some tests failed|FAIL|Expected:|Actual:|timed out|Exception|Error:" "$OUT/drive.log" | head -30
echo "screenshots: $APP_DIR/build/e2e_screens"
echo "indexer errors: $(grep -c -i -E 'traceback|exception' "$OUT/indexer.log" || true)"
exit $STATUS
