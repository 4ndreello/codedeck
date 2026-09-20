#!/usr/bin/env bash
# Proves the codedeck agents pane actually draws on screen.
#
# `npm run build` never type checks plugin/ and `claude plugin validate` only
# checks manifest shape, so both pass against a module that draws nothing or
# draws garbage. That gap cost a day once: the pane looked broken while the
# module was fine, and the real defect was <Box> defaulting to a row layout,
# which shredded 51 lines into vertical slivers of box characters with zero
# errors raised. Only a screen capture showed it.
#
# This probe starts a disposable tmux session running the real CLI against a
# plugin dir, polls the capture until the canvas frame appears, then grades
# the screen. It never sends a prompt to the model: the pane draws at session
# start, and a probe that spends tokens is a probe nobody runs.
#
# Usage: pane-probe.sh [run-id] [plugin-dir]
# Defaults: $CODEDECK_RUN_ID or f5fd, and $PWD/dist/plugin.
# Exit 0 only when every assertion passed.
set -euo pipefail

# Widths are counted in characters, and the dock is made of three-byte box
# drawing glyphs, so a UTF-8 locale is not optional here. Re-exec once under
# C.UTF-8 rather than trust whatever the caller exported.
if [[ ${_PANE_PROBE_UTF8:-} != 1 ]]; then
  export _PANE_PROBE_UTF8=1 LC_ALL=C.UTF-8
  exec "$0" "$@"
fi

RUN_ID="${1:-${CODEDECK_RUN_ID:-f5fd}}"
PLUGIN_DIR="${2:-$PWD/dist/plugin}"
SESSION="pane-probe-$$-${RANDOM}"
COLS=200
ROWS=50
TIMEOUT=45
FRAME_TEXT="Canvas do run $RUN_ID"

probe_char=$'\xc3\xa9'
if [[ ${#probe_char} -ne 1 ]]; then
  echo "pane-probe: no UTF-8 locale available, cannot count box drawing widths" >&2
  exit 2
fi
for tool in tmux claude; do
  command -v "$tool" >/dev/null || { echo "pane-probe: $tool is not installed" >&2; exit 2; }
done
[[ -d $PLUGIN_DIR ]] || { echo "pane-probe: plugin dir not found: $PLUGIN_DIR" >&2; exit 2; }

cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "pane-probe: session=$SESSION run=$RUN_ID plugin=$PLUGIN_DIR" >&2

# exec inside the session keeps death detection honest: when claude quits the
# tmux session goes with it and the poll below stops early instead of waiting
# out the timeout on a corpse.
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" \
  "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CODEDECK_RUN_ID=$RUN_ID exec claude --plugin-dir '$PLUGIN_DIR'"

capture=""
deadline=$((SECONDS + TIMEOUT))
while ((SECONDS < deadline)); do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "pane-probe: session died before the pane drew" >&2
    capture=""
    break
  fi
  capture="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)"
  [[ $capture == *"$FRAME_TEXT"* ]] && break
  sleep 1
done
if tmux has-session -t "$SESSION" 2>/dev/null; then
  capture="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)"
fi

failures=0
result() { # <name> <PASS|FAIL> [detail]
  printf '%-5s %-7s%s\n' "$2" "$1" "${3:+  ($3)}"
  [[ $2 == PASS ]] || failures=$((failures + 1))
}

echo
echo "== captured screen =="
printf '%s\n' "$capture"
echo
echo "== assertions =="

if grep -qF -- "$FRAME_TEXT" <<<"$capture"; then
  result frame PASS
else
  result frame FAIL "no line holds \"$FRAME_TEXT\""
fi

# Counting dock lines that share a width does not work: the dock rail alone
# satisfies it, so a shredded drawing scores the same as a canvas. Measured,
# that check reported PASS on a screen full of confetti.
#
# What does separate them is the horizontal rules. A real drawing is built out
# of long runs of ─, the frame top, the separators, every card edge. Shredding
# chops each of those into two and three character fragments, so the long runs
# vanish. Measured on both captures: 23 such lines when correct, 0 inside the
# dock when shredded. The only long runs left on a shredded screen are the
# prompt separators, which span the terminal and sit outside the dock, so
# restricting the count to the dock region is load bearing.
#
# The threshold is 5 because the floor of a legitimate drawing is 6: the frame
# top, two separators and the closing border, plus the two edges of the
# orchestrator card, which is always drawn. Everything else, the worker cards
# and their edges, comes and goes with what the run is doing. A screen with one
# working agent counts 8. Shredded counts 0. Five sits clear of both.
rule_lines=0
while IFS= read -r line; do
  [[ $line == *│* ]] || continue
  # the dock region starts at the rail, so everything from the first │ on
  dock="│${line#*│}"
  longest=0
  run=0
  rest="$dock"
  while [[ -n $rest ]]; do
    if [[ ${rest:0:1} == ─ ]]; then
      run=$((run + 1))
      ((run > longest)) && longest=$run
    else
      run=0
    fi
    rest="${rest:1}"
  done
  ((longest >= 20)) && rule_lines=$((rule_lines + 1))
done <<<"$capture"

if ((rule_lines >= 5)); then
  result shape PASS "$rule_lines dock lines hold a rule of 20 or more"
else
  result shape FAIL "only $rule_lines dock lines hold a rule of 20 or more, drawing is shredded"
fi

# The closing border of the canvas frame is the widest └…┘ on screen. Its
# width is measured from the frame top line, corner to last visible
# character, because the top-right corner carries the close glyph instead of
# a ┐. An inner card bottom is always narrower, so it cannot match by
# accident.
bottom=""
width=0
frame_line="$(grep -F -- "$FRAME_TEXT" <<<"$capture" | head -n 1)" || true
frame_line="${frame_line%"${frame_line##*[![:space:]]}"}"
if [[ $frame_line == *┌* ]]; then
  span="${frame_line#*┌}"
  width=$(( ${#span} + 1 ))
  dashes=""
  while (( ${#dashes} < width - 2 )); do dashes+="─"; done
  bottom="└${dashes}┘"
fi
if [[ -z $bottom ]]; then
  result footer FAIL "frame top line absent, cannot measure the closing border"
elif grep -qF -- "$bottom" <<<"$capture"; then
  result footer PASS "closing border present at width $width"
else
  result footer FAIL "closing border (width $width) not on screen, drawing is clipped"
fi

offenders=""
for phrase in "hook skipped" "did not load" "refused"; do
  grep -qF -- "$phrase" <<<"$capture" && offenders+="'$phrase' "
done
if [[ -z $offenders ]]; then
  result clean PASS
else
  result clean FAIL "capture holds $offenders"
fi

echo
if ((failures == 0)); then
  echo "VERDICT: PASS"
  exit 0
else
  echo "VERDICT: FAIL ($failures assertion(s))"
  exit 1
fi
