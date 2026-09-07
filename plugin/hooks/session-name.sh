#!/usr/bin/env bash

# UserPromptSubmit sees the first prompt and the native session id. Keep the
# derived name in a sidecar so the status line can read it without changing the
# native session title.
set -u

node --input-type=module -e '
import { existsSync, readFileSync, writeFileSync } from "node:fs";

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const sessionFile = process.env.CODEDECK_SESSION_FILE;
  const sessionId = payload?.session_id;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof sessionFile !== "string" ||
    sessionFile.length === 0 ||
    typeof sessionId !== "string" ||
    !/^[0-9a-fA-F-]{8,}$/.test(sessionId)
  ) process.exit(0);

  const sidecar = `${sessionFile}.${sessionId}.name`;
  if (existsSync(sidecar)) process.exit(0);

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const name = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "task";
  writeFileSync(sidecar, name, { encoding: "utf8", flag: "wx" });
} catch {}
' >/dev/null 2>&1
exit 0
