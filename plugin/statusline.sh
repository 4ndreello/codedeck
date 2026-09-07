#!/usr/bin/env bash

# Claude Code sends the status payload on stdin. Keep parsing in Node so this
# plugin does not require jq or Python on the host.
#
# The JS below is single quoted, so it must not contain a single quote anywhere.
set -u

node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { basename } from "node:path";

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
if (payload === null || typeof payload !== "object") process.exit(0);

/**
 * Claude Code dims every status row before printing it, so the palette here is
 * the bright end of the theme on purpose: a mid tone arrives on screen as grey.
 * SGR survives, which is why these are raw escapes and not a library.
 */
const BLOOD = "\x1b[38;2;225;29;72m";
const EMBER = "\x1b[38;2;251;146;60m";
const TEXT = "\x1b[38;2;247;237;238m";
const MUTED = "\x1b[38;2;163;139;143m";
const GREEN = "\x1b[38;2;74;222;128m";
const AMBER = "\x1b[38;2;251;191;36m";
const RED = "\x1b[38;2;255;77;109m";
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
 * it reaches the terminal.
 */
const clean = (value) => value.replace(/[\t\r\n]/g, " ");

const tail = (value) => {
  const candidate = text(value);
  if (!candidate) return undefined;
  const parts = candidate.split(/[·:]/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? candidate;
};

/**
 * `codedeck open` puts the role at the end of session_name, so the tail remains
 * the source for ordinary sessions. agent.name is only a fallback.
 */
const role =
  tail(text(payload.session_name)?.match(/CodeDeck\s*[·:]\s*(.+)$/i)?.[1]) ??
  tail(payload.agent?.name) ??
  tail(payload.session_name);

const taskName = (() => {
  const sessionFile = text(process.env.CODEDECK_SESSION_FILE);
  const sessionId = payload.session_id;
  if (
    !sessionFile ||
    typeof sessionId !== "string" ||
    !/^[0-9a-fA-F-]{8,}$/.test(sessionId)
  ) return undefined;

  try {
    const value = readFileSync(`${sessionFile}.${sessionId}.name`, "utf8")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 30);
    return value || undefined;
  } catch {
    return undefined;
  }
})();

const cwd = firstText(payload.workspace?.current_dir, payload.cwd) ?? process.cwd();
const project = text(basename(cwd)) ?? (cwd === "/" ? "/" : undefined);

/**
 * Claude supplies a branch for its own worktrees. Git fills the ordinary case.
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
 * Context is reported as remaining, not used. Colour keeps the existing bands.
 */
const contextField = () => {
  const remaining = payload.context_window?.remaining_percentage;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return undefined;
  const value = Math.max(0, Math.min(100, Math.round(remaining)));
  const color = value <= 15 ? RED : value <= 35 ? AMBER : GREEN;
  return paint(MUTED, "ctx ") + paint(color, value + "%");
};

const nonNegativeNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const compactTokens = (value) => {
  const total = Math.max(0, Math.round(value));
  if (total < 1000) return String(total);
  if (total >= 1_000_000) {
    const millions = total / 1_000_000;
    return millions.toFixed(millions < 10 ? 1 : 0).replace(/\.0$/, "") + "M";
  }
  const thousands = total / 1000;
  const roundedThousands = Number(thousands.toFixed(thousands < 100 ? 1 : 0));
  if (roundedThousands >= 1000) return "1M";
  return String(roundedThousands).replace(/\.0$/, "") + "k";
};

/**
 * Since Claude Code 2.1.132, these fields describe the latest context window,
 * not cumulative session totals. The aggregate token field therefore stays
 * worker-only instead of adding a repeated local window to the run total.
 * Degraded mode may show this current local snapshot when it is available.
 */
const localTokens = () => {
  const context = payload.context_window;
  const totalInput = nonNegativeNumber(context?.total_input_tokens);
  const totalOutput = nonNegativeNumber(context?.total_output_tokens);
  if (totalInput !== undefined && totalOutput !== undefined) return totalInput + totalOutput;

  const current = context?.current_usage;
  const input = nonNegativeNumber(current?.input_tokens);
  const output = nonNegativeNumber(current?.output_tokens);
  const cacheCreation = nonNegativeNumber(current?.cache_creation_input_tokens);
  const cacheRead = nonNegativeNumber(current?.cache_read_input_tokens);
  if (
    input !== undefined &&
    output !== undefined &&
    cacheCreation !== undefined &&
    cacheRead !== undefined
  ) return input + output + cacheCreation + cacheRead;
  return undefined;
};

const COST_DISPLAY_THRESHOLD = 0.01;
const COST_TEXT_THRESHOLD = 1;
const COST_EMBER_THRESHOLD = 5;
const COST_BLOOD_THRESHOLD = 10;

const costColor = (total) =>
  total < COST_TEXT_THRESHOLD ? MUTED :
  total < COST_EMBER_THRESHOLD ? TEXT :
  total < COST_BLOOD_THRESHOLD ? EMBER : BLOOD;

const costAmount = (total, incomplete = false) => {
  const value = total >= COST_DISPLAY_THRESHOLD ? "$" + total.toFixed(2) : "$";
  const amount = paint(costColor(total), value);
  return incomplete ? amount + paint(AMBER, "?") : amount;
};

const localCost = () => {
  const total = payload.cost?.total_cost_usd;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
};

const getRunUsage = () => {
  const runId = text(process.env.CODEDECK_RUN_ID);
  if (!runId) return undefined;

  try {
    const output = execFileSync("codedeck", ["usage", runId, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
    const usage = JSON.parse(output);
    if (
      usage === null ||
      typeof usage !== "object" ||
      usage.runId !== runId ||
      typeof usage.inputTokens !== "number" ||
      !Number.isFinite(usage.inputTokens) ||
      typeof usage.outputTokens !== "number" ||
      !Number.isFinite(usage.outputTokens) ||
      typeof usage.cachedTokens !== "number" ||
      !Number.isFinite(usage.cachedTokens) ||
      typeof usage.costUsd !== "number" ||
      !Number.isFinite(usage.costUsd) ||
      typeof usage.sessionCount !== "number" ||
      !Number.isFinite(usage.sessionCount) ||
      typeof usage.activeSessionCount !== "number" ||
      !Number.isFinite(usage.activeSessionCount) ||
      typeof usage.costComplete !== "boolean" ||
      typeof usage.sessionsWithoutCost !== "number" ||
      !Number.isFinite(usage.sessionsWithoutCost)
    ) return undefined;
    return usage;
  } catch {
    return undefined;
  }
};

const local = localCost();
const runUsage = getRunUsage();
const workerTokens = runUsage
  ? runUsage.inputTokens + runUsage.outputTokens + runUsage.cachedTokens
  : undefined;
const tokenField = () => {
  const total = workerTokens ?? (runUsage ? undefined : localTokens());
  return total === undefined ? undefined : paint(MUTED, compactTokens(total) + " tok");
};

const runField = () => {
  if (!runUsage) return undefined;
  const total = (local ?? 0) + runUsage.costUsd;
  const incomplete = !runUsage.costComplete;
  if (!incomplete && total < COST_DISPLAY_THRESHOLD) return undefined;
  return paint(MUTED, "run ") + costAmount(total, incomplete);
};

const localField = () => {
  if (local === undefined || local < COST_DISPLAY_THRESHOLD) return undefined;
  return costAmount(local);
};

const projectBranch = project && branch
  ? paint(TEXT, clean(project)) + paint(MUTED, "/") + paint(BLOOD, clean(branch))
  : project
    ? paint(TEXT, clean(project))
    : branch
      ? paint(BLOOD, clean(branch))
      : undefined;

const fields = [
  taskName && paint(EMBER, clean(taskName)),
  role && paint(EMBER, clean(role)),
  projectBranch,
  contextField(),
  tokenField(),
  runUsage ? runField() : localField(),
  runUsage && paint(TEXT, String(Math.max(0, Math.round(runUsage.activeSessionCount))) + " agents"),
].filter(Boolean);

writeSync(1, fields.join(paint(MUTED, " · ")));
'
