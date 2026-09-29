#!/usr/bin/env bash
# runner.sh — Stage D foundation test orchestrator (docs/TESTING.md).
#
#   ./tests/runner.sh                 T1 (ctest) + T2 (tokens, qmllint)
#   BUILD=build ./tests/runner.sh     explicit build dir (default: build)
#   WITH_DBUS=1 ./tests/runner.sh     + T3 contract check (needs running
#                                     configd+aid on the user bus)
#   AI_OFF=1 ./tests/runner.sh        T7 ai-off smoke
#   MOCK_PORT=8317 ./tests/runner.sh  mock endpoint port for T4 notes
set -u
cd "$(dirname "$0")/.."
BUILD="${BUILD:-build}"
fail=0

run() {
    local name="$1"; shift
    echo "=== $name"
    if "$@"; then
        echo "ok: $name"
    else
        echo "FAIL: $name"
        fail=1
    fi
}

# T1 — unit tests (C++/Qt Test, ctest)
if [ -d "$BUILD" ] && [ -f "$BUILD/CTestTestfile.cmake" ]; then
    run "T1 ctest" ctest --test-dir "$BUILD" --output-on-failure
else
    echo "skip: T1 ctest (no build dir: $BUILD — configure+build first)"
fi

# T2 — design tokens
run "T2 check-tokens" python3 tests/check-tokens.py

# T2 — qmllint (when available)
if command -v qmllint6 > /dev/null 2>&1; then
    run "T2 qmllint src/ui" qmllint6 src/ui/Theme.qml src/ui/Surface.qml \
        src/ui/Chip.qml src/ui/Glyph.qml src/ui/StatusDot.qml src/ui/AIBar.qml
    run "T2 qmllint tests/qml" qmllint6 tests/qml/UiPreview.qml
elif command -v qmllint > /dev/null 2>&1; then
    run "T2 qmllint src/ui" qmllint src/ui/Theme.qml src/ui/Surface.qml \
        src/ui/Chip.qml src/ui/Glyph.qml src/ui/StatusDot.qml src/ui/AIBar.qml
    run "T2 qmllint tests/qml" qmllint tests/qml/UiPreview.qml
else
    echo "skip: T2 qmllint (qmllint6 not found)"
fi

# T2 — offscreen AIArch.Ui capture (when the runner + module are built)
RUNNER_BIN="$BUILD/tests/runner/qml-runner"
UI_MODULE_DIR=""
if [ -f "$RUNNER_BIN" ]; then
    if [ -d "$BUILD/ui/AIArch.Ui" ]; then
        UI_MODULE_DIR="$BUILD/ui"
    elif [ -d "$BUILD/ui" ]; then
        UI_MODULE_DIR="$BUILD/ui"
    fi
    if [ -n "$UI_MODULE_DIR" ] && [ -f "$UI_MODULE_DIR/AIArch.Ui/qmldir" ]; then
        run "T2 offscreen AIArch.Ui (connected)" env QT_QPA_PLATFORM=offscreen \
            "$RUNNER_BIN" -m shot -s 0 -w 1280 -H 720 -o /tmp/aiarch-ui-0.png \
            -i "$UI_MODULE_DIR" tests/qml/UiPreview.qml
        run "T2 offscreen AIArch.Ui (AI off)" env QT_QPA_PLATFORM=offscreen \
            "$RUNNER_BIN" -m shot -s 3 -w 1280 -H 720 -o /tmp/aiarch-ui-3.png \
            -i "$UI_MODULE_DIR" tests/qml/UiPreview.qml
    else
        echo "skip: T2 offscreen (AIArch.Ui module not built at $BUILD/ui)"
    fi
else
    echo "skip: T2 offscreen (qml-runner not built)"
fi

# T3 — D-Bus contracts (live bus)
if [ "${WITH_DBUS:-0}" = "1" ]; then
    run "T3 contracts" python3 tests/contract/check_contracts.py
else
    echo "skip: T3 contracts (WITH_DBUS=1 required; configd+aid must be running)"
fi

# T7 — AI-off smoke
if [ "${AI_OFF:-0}" = "1" ]; then
    run "T7 ai-off smoke" bash tests/desktop/ai_off_smoke.sh
else
    echo "skip: T7 ai-off smoke (AI_OFF=1 required)"
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "runner: PASS"
else
    echo "runner: FAIL"
fi
exit "$fail"
