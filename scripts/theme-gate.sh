#!/usr/bin/env bash
# Proves the theme actually paints.
#
# `claude plugin validate` does not look at themes at all: a theme file
# containing invalid JSON passes it without a word. And a wrong theme ref
# fails SILENTLY at runtime, with no error and no log entry even under
# --debug. So the only honest check is to launch a real session and look
# for the colour on the wire.
#
# The expected colour is read from the theme file rather than hardcoded, so
# this script never has to be edited when the palette changes.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
THEME="$HERE/plugin/themes/codedeck-ultra.json"
CAPTURE="$(mktemp)"
trap 'rm -f "$CAPTURE"' EXIT

if [ ! -f "$THEME" ]; then
  echo "theme file missing: $THEME" >&2
  exit 1
fi

# promptBorder is the loudest slot: it frames the input box on first paint,
# so it lands in the capture without needing a turn to complete.
hex="$(node -e '
  const fs = require("node:fs");
  const theme = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const value = theme.overrides?.promptBorder;
  if (!value) { console.error("no overrides.promptBorder slot in the theme"); process.exit(1); }
  console.log(String(value).replace(/^#/, ""));
' "$THEME")"

expected="38;2;$((16#${hex:0:2}));$((16#${hex:2:2}));$((16#${hex:4:2}))"

echo "expecting $expected from promptBorder #$hex"

# A pty is required: claude renders nothing recognisable when stdout is a
# pipe. `script` supplies one. The session is told to exit immediately; the
# theme is applied during the first paint, before any turn runs.
script -qec "node '$HERE/dist/cli/index.js' open -- --print --max-turns 0 exit" /dev/null \
  > "$CAPTURE" 2>&1 || true

if grep -qF "$expected" "$CAPTURE"; then
  echo "theme applied"
  exit 0
fi

echo "theme did NOT paint: $expected absent from the capture" >&2
echo "--- capture head ---" >&2
head -c 2000 "$CAPTURE" >&2
exit 1
