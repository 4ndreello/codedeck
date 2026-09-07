#!/usr/bin/env bash
# Proves the session actually renames itself from the first prompt.
#
# Every part of this chain is invisible to a unit test: the hook only runs
# inside a real session, the keystrokes only mean something to a real TUI, and
# `/rename` only persists when Claude Code executed it as a command instead of
# sending it to the model as a prompt. So the gate drives a real session and
# then reads the title back off the transcript, which is where Claude Code
# writes it (`{"type":"custom-title","customTitle":...}`).
#
# It has to be an INTERACTIVE launch: `--print` never draws the TUI, and there
# is no input box to type into.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CAPTURE="$(mktemp)"
CONFIG_DIR="$(mktemp -d)"
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$CAPTURE" "$CONFIG_DIR" "$STATE_DIR"' EXIT

# Same reason as the theme gate: an empty `models` key means the wizard never
# opens, so the session paints instead of waiting on a question.
printf '{"models":{}}\n' > "$CONFIG_DIR/config.json"
export RUN_AGENT_CONFIG_DIR="$CONFIG_DIR"
# The session file and its name sidecar live under the state directory, so the
# gate reads them from a run of its own rather than from a machine's history.
export RUN_AGENT_DIR="$STATE_DIR"
SESSIONS="$STATE_DIR/sessions"

# The prompt is the name: plugin/hooks/session-name.sh slugifies it, so what
# the session ends up called is predictable enough to grep for.
PROMPT="${RENAME_GATE_PROMPT:-responda apenas ok}"
SLUG="$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-30)"

# Seconds before the prompt is typed, and after it, for the turn to finish and
# the queued command to run. Generous because a cold runner starts slowly.
SETTLE="${RENAME_GATE_SETTLE:-25}"
TURN="${RENAME_GATE_TURN:-45}"
LIMIT="${RENAME_GATE_TIMEOUT:-180}"

if [ ! -f "$HERE/dist/cli/index.js" ]; then
  echo "dist/cli/index.js missing, run npm run build first" >&2
  exit 1
fi

# A first run would spend the typed prompt on the onboarding questions, and the
# hook would never see it. Only written when absent, so a real machine keeps
# whatever it already answered.
CLAUDE_JSON="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
if [ ! -f "$CLAUDE_JSON" ]; then
  printf '{"hasCompletedOnboarding":true}\n' > "$CLAUDE_JSON"
fi

echo "expecting the session to rename itself to \"$SLUG\""

# --no-bypass keeps the gate runnable as root, where Claude Code refuses to
# skip permission prompts. It changes nothing about the rename path.
( sleep "$SETTLE"; printf '%s\r' "$PROMPT"; sleep "$TURN"; printf '\003'; sleep 1; printf '\003'; sleep 2 ) \
  | timeout "$LIMIT" script -qec "node '$HERE/dist/cli/index.js' open general --no-bypass" /dev/null \
  > "$CAPTURE" 2>&1 || true

sidecar="$(ls -t "$SESSIONS"/codedeck-session-*.name 2>/dev/null | head -1 || true)"
if [ -z "$sidecar" ]; then
  echo "no name sidecar was written: the UserPromptSubmit hook never saw the prompt" >&2
  echo "--- capture tail ---" >&2
  tail -c 2000 "$CAPTURE" >&2
  exit 1
fi

echo "hook wrote $sidecar ($(cat "$sidecar"))"

# <session file>.<session id>.name, so the id is the second-to-last field.
session_id="$(basename "$sidecar" .name | awk -F. '{print $NF}')"
transcript="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name "$session_id.jsonl" 2>/dev/null | head -1 || true)"

if [ -z "$transcript" ]; then
  echo "no transcript for session $session_id" >&2
  exit 1
fi

if grep -qF "\"type\":\"custom-title\"" "$transcript" && grep -qF "\"customTitle\":\"$SLUG\"" "$transcript"; then
  echo "session renamed itself to $SLUG"
  exit 0
fi

echo "the session did NOT rename itself" >&2
echo "--- titles seen in the transcript ---" >&2
grep -o '"customTitle":"[^"]*"' "$transcript" | sort -u | head >&2 || echo "(none)" >&2
echo "--- capture tail ---" >&2
tail -c 2000 "$CAPTURE" >&2
exit 1
