#!/bin/bash
# UI write flows against a fresh MAIN local stack: restarts hardhat on 8545 a day behind the browser
# clock (see below), wipes the werule indexer's main store and local-edge files, and runs dev.py (the
# edge stack werule's LOCAL=true reads, 8788/8787). Needs chromedriver on 4444.
# Usage: scripts/indexer-e2e/ui.sh <werule-indexer dir> <app dir> <integration test>
set -e
if [ "$E2E_ALLOW_MAIN_STACK" != "1" ]; then
    echo "ui.sh restarts hardhat on 8545 and wipes the main local store and edge files; set E2E_ALLOW_MAIN_STACK=1 to confirm" >&2; exit 2
fi
INDEXER_DIR="${1:?werule-indexer dir}"; APP_DIR="${2:?app dir}"; TEST="${3:?integration test}"
HERE="$(cd "$(dirname "$0")" && pwd)"; CONTRACTS="$HERE/../.."; LOG="$HERE/out/indexer-ui.log"
mkdir -p "$HERE/out"

kill_port() { powershell -NoProfile -Command "\$p=(Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if (\$p) { Stop-Process -Id \$p -Force }" || true; }
stop_edge() {
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*dev.py' -or \$_.CommandLine -like '*dev.py ' } | ForEach-Object { taskkill /T /F /PID \$_.ProcessId | Out-Null }" || true
    kill_port 8787; kill_port 8788
}

stop_edge; kill_port 8545
# The chain starts a day behind the browser: the app counts cooling-off down against the browser
# clock, and the UI test jumps the chain forward by the one-day buffer right before signing.
INITIAL_DATE=$(python -c "import datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
(cd "$CONTRACTS" && HARDHAT_INITIAL_DATE="$INITIAL_DATE" npx hardhat node > "$HERE/out/node.log" 2>&1 &)
until curl -s -X POST -H "content-type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:8545 > /dev/null; do sleep 1; done
rm -rf "$INDEXER_DIR/data/werule.sqlite"* "$INDEXER_DIR/../local-edge"

cd "$CONTRACTS"
# On the main chain deploy.js writes deployments/networks/Localhost.json, which dev.py's indexer reads
npx hardhat run scripts/indexer-e2e/deploy.js --network localhost > /dev/null
(cd "$INDEXER_DIR" && LOG_DIR="$HERE/out/edge-logs" python -u dev.py > "$LOG" 2>&1 &)
until grep -q "Starting from block" "$HERE/out/edge-logs/Localhost-indexer.log" 2>/dev/null; do sleep 1; done
npx hardhat run scripts/indexer-e2e/ui_setup.js --network localhost
sleep 15

UI="$HERE/out/ui.json"
DEFINES=$(python -c "import json;u=json.load(open(r'$(cygpath -w "$UI")'));print(' '.join(f'--dart-define={k.upper()}={v}' for k,v in u.items()))")
cd "$APP_DIR" && rm -rf build/e2e_screens
flutter drive -d chrome --driver=test_driver/integration_test.dart --target="$TEST" $DEFINES 2>&1 | grep -E "All tests|FAIL|Expected|Actual|Exception|══" || true
stop_edge
echo "indexer errors: $(grep -c -i -E 'traceback|exception' "$HERE/out/edge-logs/Localhost-indexer.log" || true)"
