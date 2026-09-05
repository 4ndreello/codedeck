#!/usr/bin/env bash
# Proves the theme actually paints.
#
# `claude plugin validate` does not look at themes at all: a theme file
# containing invalid JSON passes it without a word. And a wrong theme ref
# fails SILENTLY at runtime, with no error and no log entry even under
# --debug. So the only honest check is to launch a real session and look
# for the colours on the wire.
#
# It has to be an INTERACTIVE launch. `--print` answers and exits without
# ever drawing the TUI, so the capture comes back with no colour at all and
# the gate would fail on a perfectly good theme.
#
# The expected colours are read from the theme file rather than hardcoded, so
# this script never has to be edited when the palette changes.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
THEME="$HERE/plugin/themes/codedeck-ultra.json"
CAPTURE="$(mktemp)"
CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$CAPTURE" "$CONFIG_DIR"' EXIT

# A config with no `models` key means first run, and `open` then asks which
# model each agent should use. That prompt would sit there until the quit keys
# arrive and nothing would ever paint, so the gate brings its own answered
# config instead of depending on whatever the machine happens to have.
printf '{"models":{}}\n' > "$CONFIG_DIR/config.json"
export RUN_AGENT_CONFIG_DIR="$CONFIG_DIR"

# Seconds to let the TUI paint before sending the quit keys. Generous because
# a cold CI runner starts slower than a warm laptop.
SETTLE="${THEME_GATE_SETTLE:-20}"
LIMIT="${THEME_GATE_TIMEOUT:-120}"

if [ ! -f "$THEME" ]; then
  echo "theme file missing: $THEME" >&2
  exit 1
fi

if [ ! -f "$HERE/dist/cli/index.js" ]; then
  echo "dist/cli/index.js missing, run npm run build first" >&2
  exit 1
fi

# promptBorder frames the input box and inactive paints the hint text, so both
# land on the first paint. Two slots instead of one: a single colour could in
# principle collide with a built-in theme, two matching ours could not.
read_slot() {
  node -e '
    const fs = require("node:fs");
    const theme = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = theme.overrides?.[process.argv[2]];
    if (!value) {
      console.error(`no overrides.${process.argv[2]} slot in the theme`);
      process.exit(1);
    }
    const hex = String(value).replace(/^#/, "");
    const channel = (at) => parseInt(hex.slice(at, at + 2), 16);
    console.log(`38;2;${channel(0)};${channel(2)};${channel(4)}`);
  ' "$THEME" "$1"
}

prompt_border="$(read_slot promptBorder)"
inactive="$(read_slot inactive)"

echo "expecting promptBorder $prompt_border and inactive $inactive"

# A pty is required: claude renders nothing recognisable when stdout is a pipe.
# `script` supplies one. Two Ctrl+C keys are how the TUI is asked to quit.
( sleep "$SETTLE"; printf '\003'; sleep 1; printf '\003'; sleep 2 ) \
  | timeout "$LIMIT" script -qec "node '$HERE/dist/cli/index.js' open general" /dev/null \
  > "$CAPTURE" 2>&1 || true

missing=()
grep -qF "$prompt_border" "$CAPTURE" || missing+=("promptBorder $prompt_border")
grep -qF "$inactive" "$CAPTURE" || missing+=("inactive $inactive")

if [ ${#missing[@]} -eq 0 ]; then
  echo "theme applied"
  exit 0
fi

echo "theme did NOT paint, absent from the capture: ${missing[*]}" >&2
echo "--- colours actually seen ---" >&2
grep -o '38;2;[0-9]*;[0-9]*;[0-9]*' "$CAPTURE" | sort -u | head -20 >&2
echo "--- capture head ---" >&2
head -c 2000 "$CAPTURE" >&2
exit 1
