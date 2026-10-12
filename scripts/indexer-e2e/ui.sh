#!/bin/bash
# UI write flows against a fresh local stack. Needs the Firestore emulator (port 8080) and
# chromedriver (port 4444) running. Restarts the hardhat node so chain time matches the browser.
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
(cd "$CONTRACTS" && npx hardhat node > "$HERE/out/node.log" 2>&1 &)
until curl -s -X POST -H "content-type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:8545 > /dev/null; do sleep 1; done
for project in homebase-6907d trustless-58262; do
    curl -s -X DELETE "http://127.0.0.1:8080/emulator/v1/projects/$project/databases/(default)/documents" > /dev/null
done

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
