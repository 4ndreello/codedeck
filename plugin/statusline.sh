#!/usr/bin/env bash

# Claude Code sends the status payload on stdin. Keep parsing in Node so this
# plugin does not require jq or Python on the host.
set -u

input=$(cat)
printf '%s' "$input" | node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const text = (value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const firstText = (...values) => values.map(text).find(Boolean);

const roleFrom = (value) => {
  const candidate = text(value);
  if (!candidate) return undefined;
  const parts = candidate.split(/[·:]/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? candidate;
};

const role = roleFrom(
  payload.agent?.name,
  payload.agent?.role,
  payload.role,
  payload.session_role,
) ?? roleFrom(
  text(payload.session_name)?.match(/CodeDeck\s*·\s*(.+)$/i)?.[1],
);
const model = firstText(payload.model?.display_name, payload.model?.id, payload.model);
const cwd = firstText(payload.workspace?.current_dir, payload.cwd) ?? process.cwd();

let branch = firstText(
  payload.worktree?.branch,
  payload.workspace?.git_worktree,
  payload.branch,
);
if (!branch) {
  try {
    branch = text(execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    branch = undefined;
  }
}

const clean = (value) => value?.replace(/[\t\r\n]/g, " ");
const fields = [
  role && `role:${clean(role)}`,
  model && `model:${clean(model)}`,
  `branch:${clean(branch) ?? "(none)"}`,
].filter(Boolean);

process.stdout.write(fields.join(" · "));
' 
