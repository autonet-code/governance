#!/bin/bash
# UI write flows against a fresh local stack. Needs the Firestore emulator (port 8080) and
# chromedriver (port 4444) running. Restarts the hardhat node a day behind the browser clock (see below).
# Usage: scripts/indexer-e2e/ui.sh <indexer dir> <app dir> <integration test>
set -e
INDEXER_DIR="${1:?indexer dir}"; APP_DIR="${2:?app dir}"; TEST="${3:?integration test}"
HERE="$(cd "$(dirname "$0")" && pwd)"; CONTRACTS="$HERE/../.."; LOG="$HERE/out/indexer-ui.log"
mkdir -p "$HERE/out"

kill_port() { powershell -NoProfile -Command "\$p=(Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if (\$p) { Stop-Process -Id \$p -Force }" || true; }
stop_indexer() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*app.py localhost*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" || true
}

stop_indexer; kill_port 8545
# The chain starts a day behind the browser: the app counts cooling-off down against the browser
# clock, and the UI test jumps the chain forward by the one-day buffer right before signing.
INITIAL_DATE=$(python -c "import datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
(cd "$CONTRACTS" && HARDHAT_INITIAL_DATE="$INITIAL_DATE" npx hardhat node > "$HERE/out/node.log" 2>&1 &)
until curl -s -X POST -H "content-type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:8545 > /dev/null; do sleep 1; done
# DAOs and their Economy projects all live in homebase-6907d
curl -s -X DELETE "http://127.0.0.1:8080/emulator/v1/projects/homebase-6907d/databases/(default)/documents" > /dev/null

cd "$CONTRACTS"
npx hardhat run scripts/indexer-e2e/deploy.js --network localhost > /dev/null
python "$HERE/seed_emulator.py" "$INDEXER_DIR"
(cd "$INDEXER_DIR" && PYTHONUNBUFFERED=1 python -u app.py localhost homebase trustless --no-alerts --skip-historical > "$LOG" 2>&1 &)
until grep -q "Starting from block" "$LOG" 2>/dev/null; do sleep 1; done
npx hardhat run scripts/indexer-e2e/ui_setup.js --network localhost
sleep 15

UI="$HERE/out/ui.json"
DEFINES=$(python -c "import json;u=json.load(open(r'$(cygpath -w "$UI")'));print(' '.join(f'--dart-define={k.upper()}={v}' for k,v in u.items()))")
cd "$APP_DIR" && rm -rf build/e2e_screens
flutter drive -d chrome --driver=test_driver/integration_test.dart --target="$TEST" $DEFINES 2>&1 | grep -E "All tests|FAIL|Expected|Actual|Exception|══" || true
stop_indexer
echo "indexer errors: $(grep -c -i -E 'error|traceback|exception' "$LOG" || true)"
