#!/usr/bin/env bash

# Claude Code sends the status payload on stdin. Keep parsing in Node so this
# plugin does not require jq or Python on the host.
#
# The JS below is single quoted, so it must not contain a single quote anywhere.
set -u

node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

/**
 * Claude Code dims every status row before printing it, so the palette here is
 * the bright end of the theme on purpose: a mid tone arrives on screen as grey.
 * SGR survives, which is why these are raw escapes and not a library.
 */
const CYAN = "\x1b[38;2;34;211;238m";
const VIOLET = "\x1b[38;2;167;139;250m";
const TEXT = "\x1b[38;2;226;232;240m";
const MUTED = "\x1b[38;2;100;116;139m";
const GREEN = "\x1b[38;2;52;211;153m";
const AMBER = "\x1b[38;2;251;191;36m";
const RED = "\x1b[38;2;251;113;133m";
const OFF = "\x1b[0m";

const paint = (color, value) => color + value + OFF;

const text = (value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const firstText = (...values) => values.map(text).find(Boolean);

/**
 * A row is one line, so anything that could carry a newline is flattened before
 * it reaches the terminal. Branch names and model ids both come from outside.
 */
const clean = (value) => value.replace(/[\t\r\n]/g, " ");

const tail = (value) => {
  const candidate = text(value);
  if (!candidate) return undefined;
  const parts = candidate.split(/[·:]/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? candidate;
};

/**
 * `codedeck open` launches with -n "CodeDeck . <role>", so session_name is the
 * one field that always carries the role. `agent.name` is serialised only when
 * the session actually has an agent set, which makes it the fallback and not
 * the source: reading it first left the label blank on ordinary sessions.
 */
const role =
  tail(text(payload.session_name)?.match(/CodeDeck\s*[·:]\s*(.+)$/i)?.[1]) ??
  tail(payload.agent?.name) ??
  tail(payload.session_name);

const model = firstText(payload.model?.display_name, payload.model?.id, payload.model);
const cwd = firstText(payload.workspace?.current_dir, payload.cwd) ?? process.cwd();

/**
 * `workspace.git_worktree` is NOT a branch. Claude Code fills it with the
 * basename of .git/worktrees/<name>, and only when the session runs inside a
 * linked worktree, so reading it as a branch printed the worktree name in every
 * worktree and nothing anywhere else. `worktree.branch` is a real branch but
 * exists only for worktrees Claude Code created itself, which leaves git as the
 * answer for the ordinary case.
 */
let branch = text(payload.worktree?.branch);
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

/**
 * Context is reported as remaining, not used, because the number people act on
 * is how much room is left before a compaction. Colour carries the same fact so
 * the row reads at a glance without parsing the digits.
 */
const contextField = () => {
  const remaining = payload.context_window?.remaining_percentage;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return undefined;
  const value = Math.max(0, Math.min(100, Math.round(remaining)));
  const color = value <= 15 ? RED : value <= 35 ? AMBER : GREEN;
  return paint(MUTED, "ctx ") + paint(color, value + "%");
};

/**
 * Under a cent the rounded figure is a flat $0.00 for most of a session, which
 * reads as broken rather than as cheap, so the field waits until it can say
 * something true.
 */
const costField = () => {
  const total = payload.cost?.total_cost_usd;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0.01) return undefined;
  return paint(MUTED, "$" + total.toFixed(2));
};

const fields = [
  role && paint(VIOLET, clean(role)),
  model && paint(TEXT, clean(model)),
  branch && paint(CYAN, clean(branch)),
  contextField(),
  costField(),
].filter(Boolean);

const label = paint(CYAN, "▌ULTRA");
process.stdout.write(fields.length > 0 ? label + " " + fields.join(paint(MUTED, " · ")) : label);
'
