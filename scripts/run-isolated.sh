#!/usr/bin/env bash
# Run a command in a sibling systemd scope with RAM+swap caps, so an OOMing
# child dies alone instead of taking the whole terminal scope with it.
#
# Why: systemd-oomd kills by cgroup, and everything a shell spawns inherits
# the terminal's scope (app-Hyprland-xdg-terminal-exec-*.scope) — including
# the orchestrator. `detached`/setsid does NOT leave the cgroup. A node
# process inflating toward 20G+ of swap therefore kills the agent session
# that launched it, not just itself. A sibling scope contains the kill.
#
# Usage: scripts/run-isolated.sh <cmd> [args...]
#   scripts/run-isolated.sh node --test tests/foo.test.ts
#   scripts/run-isolated.sh npm test
#
# Env:
#   CODEDECK_TEST_MEMORY_MAX  RAM cap for the scope (default 4G)
#   CODEDECK_TEST_SWAP_MAX    swap cap for the scope (default 0 — the
#                             load-bearing half: oomd fires on swap pressure)
#   CODEDECK_NO_SCOPE=1       bypass the scope, plain exec (containers/macOS)
#
# Outside Linux/systemd the script degrades to a plain exec.
set -euo pipefail

MEM_MAX="${CODEDECK_TEST_MEMORY_MAX:-4G}"
SWAP_MAX="${CODEDECK_TEST_SWAP_MAX:-0}"

# systemd spellings only (uppercase suffix): lowercase ('4g') fails to parse
# and MemoryMax=0 is out of range, so a typo must fall back, never exec a
# doomed scope. MemorySwapMax=0 stays valid (disables swap).
valid_size() {
  printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+)?[KMGTPE]?$'
}
is_zero_size() {
  stripped="$(printf '%s' "${1%[KMGTPE]}" | tr -d '0.')"
  [ -z "$stripped" ]
}
if ! valid_size "$MEM_MAX" || is_zero_size "$MEM_MAX"; then
  echo "run-isolated: invalid CODEDECK_TEST_MEMORY_MAX='$MEM_MAX', using 4G" >&2
  MEM_MAX="4G"
fi
if ! valid_size "$SWAP_MAX"; then
  echo "run-isolated: invalid CODEDECK_TEST_SWAP_MAX='$SWAP_MAX', using 0" >&2
  SWAP_MAX="0"
fi

if [ "${CODEDECK_NO_SCOPE:-0}" = "1" ]; then
  exec "$@"
fi
if [ "$(uname -s)" != "Linux" ]; then
  exec "$@"
fi
BIN=""
for candidate in /usr/bin/systemd-run /bin/systemd-run; do
  if [ -x "$candidate" ]; then
    BIN="$candidate"
    break
  fi
done
if [ -z "$BIN" ]; then
  exec "$@"
fi
if [ ! -S "/run/user/$(id -u)/systemd/private" ]; then
  exec "$@"
fi

exec "$BIN" --user --scope --quiet \
  -p "MemoryMax=${MEM_MAX}" \
  -p "MemorySwapMax=${SWAP_MAX}" \
  -- "$@"
