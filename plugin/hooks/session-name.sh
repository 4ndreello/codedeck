#!/usr/bin/env bash

# UserPromptSubmit already provides the JSON payload on stdin. Keep this entry
# point small so the slow title generation can run after Claude receives it.
set -u

exec node "${CLAUDE_PLUGIN_ROOT}/hooks/session-name.mjs"
