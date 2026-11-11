#!/usr/bin/env bash
# Linux/WSLg native checks against the already-built debug binary. The app and
# Trash Portal share a disposable D-Bus session and XDG data directory. HOME and
# the developer's existing session/Trash are never changed.
# Default: real Rust IPC with explicitly labeled DOM-dispatched UI input.
# Optional: QPANES_NATIVE_PHASE=trash; QPANES_NATIVE_INPUT=xtest;
# QPANES_WSLG_POINTER=1; QPANES_NATIVE_PORT=9242.
set -euo pipefail

qpanes_script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$qpanes_script_dir/../.."
qpanes_launcher="$qpanes_script_dir/run-operations.sh"

if [[ "${1:-}" == --private-session ]]; then
  # This internal branch must originate from this launcher's freshly allocated
  # fixture and a new bus, before even writing logs or identifying a daemon PID.
  [[ -n "${QPANES_NATIVE_TRASH_ROOT:-}" &&
      "${QPANES_PRIVATE_NATIVE_SESSION:-}" == "$QPANES_NATIVE_TRASH_ROOT" &&
      "${XDG_DATA_HOME:-}" == "$QPANES_NATIVE_TRASH_ROOT/data" &&
      -f "$QPANES_NATIVE_TRASH_ROOT/qpanes-native-isolation" &&
      "$(cat -- "$QPANES_NATIVE_TRASH_ROOT/qpanes-native-isolation")" == 'QPanes disposable native Trash fixtures' &&
      -n "${DBUS_SESSION_BUS_ADDRESS:-}" &&
      "$DBUS_SESSION_BUS_ADDRESS" != "${QPANES_NATIVE_PARENT_BUS:-}" ]] || {
    printf '%s\n' 'Refusing an unverified private native session.' >&2
    exit 1
  }
  qpanes_portal_pid=
  QPANES_NATIVE_APP_PID=
  cleanup_processes() {
    if [[ -n "$QPANES_NATIVE_APP_PID" ]]; then kill "$QPANES_NATIVE_APP_PID" 2>/dev/null || true; fi
    if [[ -n "$qpanes_portal_pid" ]]; then kill "$qpanes_portal_pid" 2>/dev/null || true; fi
    wait 2>/dev/null || true
  }
  trap cleanup_processes EXIT
  # Activation through this private bus guarantees the daemon inherits the
  # generated XDG_DATA_HOME. No call is made to the developer session daemon.
  for ((qpanes_attempt=0; qpanes_attempt<100; qpanes_attempt++)); do
    if gdbus introspect --session --dest org.freedesktop.portal.Desktop \
      --object-path /org/freedesktop/portal/desktop --only-properties \
      >"$QPANES_NATIVE_TRASH_ROOT/introspection.txt" \
      2>"$QPANES_NATIVE_TRASH_ROOT/portal-probe.log"; then break; fi
    sleep 0.1
  done
  rg -q 'org.freedesktop.portal.Trash' "$QPANES_NATIVE_TRASH_ROOT/introspection.txt"
  # Resolve only the private daemon's PID; its environment is verified again by
  # operations.mjs before any native Trash operation.
  qpanes_portal_reply=$(gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetConnectionUnixProcessID org.freedesktop.portal.Desktop)
  if [[ "$qpanes_portal_reply" =~ uint32[[:space:]]+([0-9]+) ]]; then
    qpanes_portal_pid="${BASH_REMATCH[1]}"
  else
    printf '%s\n' 'Could not identify the private Trash Portal.' >&2
    exit 1
  fi
  if [[ "${QPANES_NATIVE_BACKGROUND:-}" == 1 ]]; then
    cc -shared -fPIC tests/native/io-faults.c -o "$QPANES_NATIVE_TRASH_ROOT/io-faults.so"
    export QPANES_TEST_IO_ROOT="$QPANES_NATIVE_TRASH_ROOT"
    export LD_PRELOAD="$QPANES_NATIVE_TRASH_ROOT/io-faults.so"
  fi
  src-tauri/target/debug/qpanes >"$QPANES_NATIVE_TRASH_ROOT/app.log" 2>&1 &
  export QPANES_NATIVE_APP_PID=$!
  for ((qpanes_attempt=0; qpanes_attempt<100; qpanes_attempt++)); do
    kill -0 "$QPANES_NATIVE_APP_PID"
    if curl --fail --silent --show-error "$QPANES_INSPECTOR" \
      -o "$QPANES_NATIVE_TRASH_ROOT/inspector.html" 2>/dev/null; then break; fi
    sleep 0.1
  done
  test -s "$QPANES_NATIVE_TRASH_ROOT/inspector.html"
  # WebKit publishes its inspector before the initial blank page has loaded.
  sleep 2
  if [[ "${QPANES_NATIVE_PHASE:-all}" == history ]]; then
    node tests/native/history-invalidation.mjs
  elif [[ "${QPANES_NATIVE_PHASE:-all}" == hardening ]]; then
    node tests/native/hardening.mjs
  else
    if [[ "${QPANES_NATIVE_PHASE:-all}" != trash ]]; then node tests/native/smoke.mjs; fi
    node tests/native/operations.mjs
    if [[ "${QPANES_NATIVE_BACKGROUND:-}" == 1 ]]; then node tests/native/background-operations.mjs; fi
  fi
  exit
fi

[[ "$(uname -s)" == Linux ]] || { printf '%s\n' 'This native launcher verifies Linux only.' >&2; exit 1; }
test -x src-tauri/target/debug/qpanes
for qpanes_command in node dbus-run-session gdbus curl ss rg; do command -v "$qpanes_command" >/dev/null; done
qpanes_native_port="${QPANES_NATIVE_PORT:-9242}"
[[ "$qpanes_native_port" =~ ^[0-9]+$ ]] && ((qpanes_native_port>0 && qpanes_native_port<65536))
if [[ -n "$(ss -H -ltn "sport = :$qpanes_native_port")" ]]; then
  printf 'Inspector port %s is occupied; choose QPANES_NATIVE_PORT.\n' "$qpanes_native_port" >&2
  exit 1
fi
qpanes_fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/qpanes-slice-002-native.XXXXXX")
qpanes_marker="$qpanes_fixture_root/qpanes-native-isolation"
printf 'QPanes disposable native Trash fixtures\n' >"$qpanes_marker"
mkdir -p "$qpanes_fixture_root/data" test-results
cleanup_fixtures() {
  for qpanes_log in app.log portal-probe.log introspection.txt; do
    if [[ -f "$qpanes_fixture_root/$qpanes_log" ]]; then
      cp -- "$qpanes_fixture_root/$qpanes_log" "test-results/slice-002-native-$qpanes_log"
    fi
  done
  # Never clean an inherited path or a root whose marker has changed.
  if [[ -d "$qpanes_fixture_root" && -f "$qpanes_marker" &&
        "$(cat -- "$qpanes_marker")" == 'QPanes disposable native Trash fixtures' &&
        "${qpanes_fixture_root##*/}" == qpanes-slice-002-native.?????? ]]; then
    rm -rf -- "$qpanes_fixture_root"
  else
    printf 'Fixture cleanup refused: isolation marker changed at %s.\n' "$qpanes_fixture_root" >&2
  fi
}
trap cleanup_fixtures EXIT
export QPANES_NATIVE_TRASH_ROOT="$qpanes_fixture_root"
export QPANES_PRIVATE_NATIVE_SESSION="$qpanes_fixture_root"
export QPANES_NATIVE_PARENT_BUS="${DBUS_SESSION_BUS_ADDRESS:-}"
export XDG_DATA_HOME="$qpanes_fixture_root/data"
export WEBKIT_INSPECTOR_HTTP_SERVER="127.0.0.1:$qpanes_native_port"
export QPANES_INSPECTOR="http://127.0.0.1:$qpanes_native_port"
export GDK_BACKEND=x11
dbus-run-session -- bash "$qpanes_launcher" --private-session \
  > >(tee test-results/slice-002-native-session.log) \
  2> >(tee test-results/slice-002-native-session-errors.log >&2)
