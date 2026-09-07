#!/usr/bin/env bash
# Proves `codedeck open` really owns the terminal, end to end, with no
# credential and no network.
#
# The rename gate next door drives a real Claude Code session, which needs an
# authenticated CLI and a model turn. This one swaps the harness for a stand-in
# that reports what only a real pty can give it — a tty on fd 0, the terminal's
# size, the bytes typed into it — and then runs the actual `codedeck open` path
# around it: script(1), the shim, the sidecar watcher and the injection.
#
# What it cannot cover is the other half of the chain, which is Claude Code's
# own: that a queued `/rename` executes as a command. scripts/rename-gate.sh
# covers exactly that.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
CONFIG_DIR="$(mktemp -d)"
CAPTURE="$WORK/capture"
trap 'rm -rf "$WORK" "$CONFIG_DIR"' EXIT

ROWS="${PTY_GATE_ROWS:-41}"
COLS="${PTY_GATE_COLS:-137}"
LIMIT="${PTY_GATE_TIMEOUT:-120}"
NAME="corrigir-auth-do-login"

if [ ! -f "$HERE/dist/cli/index.js" ]; then
  echo "dist/cli/index.js missing, run npm run build first" >&2
  exit 1
fi

printf '{"models":{}}\n' > "$CONFIG_DIR/config.json"

# The stand-in harness. `codedeck open` resolves `claude` from PATH, so putting
# this first is all it takes to run the real launcher against a fake session.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/claude" <<'FAKE'
#!/usr/bin/env node
// Reports what only a real terminal can hand it, then echoes what is typed.
const { writeFileSync } = require("node:fs");

const say = (line) => process.stdout.write(`${line}\n`);
say(`FAKE-TTY=${process.stdin.isTTY === true}`);
say(`FAKE-SIZE=${process.stdout.columns}x${process.stdout.rows}`);
// Set by startPtySession only, so this is how the gate knows the pty path was
// taken rather than the plain spawn it falls back to.
say(`FAKE-PTY=${typeof process.env.CODEDECK_PTY_CONTROL === "string"}`);

// Stands in for plugin/hooks/session-name.sh, which runs inside the harness
// when the first prompt is submitted and names the session after it.
const sessionFile = process.env.CODEDECK_SESSION_FILE;
if (sessionFile) {
  setTimeout(() => {
    writeFileSync(`${sessionFile}.11111111-2222-3333-4444-555555555555.name`, process.env.FAKE_NAME ?? "", "utf8");
  }, 1500);
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.search(/[\r\n]/)) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line === "quit") {
      say("FAKE-BYE");
      process.exit(7);
    }
    say(`FAKE-LINE=${line}`);
  }
});
FAKE
chmod +x "$WORK/bin/claude"

# The stand-in names the session on its own, so the keys here only wait for the
# injection to land and then prove the wire still carries them. Waiting on the
# capture rather than on a fixed sleep keeps a slow runner from flaking: CLI
# startup here ranges from 8 to 20 seconds.
: > "$CAPTURE"
(
  for _ in $(seq 1 "$LIMIT"); do
    grep -qF "FAKE-LINE=/rename" "$CAPTURE" && break
    sleep 1
  done
  printf 'quit\r'
  sleep 2
) | RUN_AGENT_CONFIG_DIR="$CONFIG_DIR" PATH="$WORK/bin:$PATH" FAKE_NAME="$NAME" \
  timeout "$LIMIT" script -qec \
    "sh -c 'stty rows $ROWS cols $COLS; exec node \"$HERE/dist/cli/index.js\" open general --no-theme'" \
    /dev/null > "$CAPTURE" 2>&1 || true

failures=()
grep -qF "FAKE-TTY=true" "$CAPTURE" || failures+=("the harness did not get a tty")
grep -qF "FAKE-PTY=true" "$CAPTURE" || failures+=("open fell back to the plain spawn instead of the pty")
grep -qF "FAKE-SIZE=${COLS}x${ROWS}" "$CAPTURE" || failures+=("the harness saw the wrong size (wanted ${COLS}x${ROWS})")
grep -qF "FAKE-LINE=/rename $NAME" "$CAPTURE" || failures+=("the rename was never typed into the harness")
grep -qF "FAKE-BYE" "$CAPTURE" || failures+=("the harness never saw the keys typed after the rename")

if [ ${#failures[@]} -eq 0 ]; then
  echo "pty path ok: tty, ${COLS}x${ROWS}, /rename $NAME typed, keys still flowing"
  exit 0
fi

echo "pty path broken:" >&2
for failure in "${failures[@]}"; do echo "  - $failure" >&2; done
echo "--- capture ---" >&2
tail -c 3000 "$CAPTURE" >&2
exit 1
