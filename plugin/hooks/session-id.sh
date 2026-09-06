#!/usr/bin/env bash

# SessionStart hands the session id on stdin, which is the only place it can be
# had: it does not exist yet when `codedeck open` prints its boot screen, and
# the launcher cannot read it off the session's stdout because that is inherited
# straight by the terminal. So `open` names a file in CODEDECK_SESSION_FILE, this
# writes the id into it, and `open` prints the resume line once the session ends.
#
# ${CLAUDE_PLUGIN_ROOT} is expanded here, unlike in statusLine.command, because
# Claude Code substitutes it only for hooks declared in a plugin's hooks.json.
#
# grep rather than node, which is what the status line uses: this runs on the
# startup path someone is already waiting through, and spawning node costs more
# than the whole read. The id is a plain UUID, so there is nothing to unescape.
set -u

target=${CODEDECK_SESSION_FILE:-}
[ -n "$target" ] || exit 0

id=$(grep -oE '"session_id":"[0-9a-fA-F-]+"' | head -1 | cut -d'"' -f4)
[ -n "$id" ] || exit 0

printf '%s' "$id" > "$target"
