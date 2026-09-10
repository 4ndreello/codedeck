import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary } from "../../drivers/helpers.js";
import { getRegistry } from "../../drivers/registry.js";
import { getCachedOrDiscoverModels, type HarnessModels } from "../../core/models.js";
import { parseEffort, type CodexSandbox } from "../../core/driver.js";
import type { Role } from "../../core/roles.js";
import { DISPATCHER_PRESET, type OrchestratorMode } from "../../config/orchestrator-mode.js";
import {
  catalogWarning,
  judgeModelIn,
  resolveRoleContract,
  type ModelVerdict,
  type OpenFlags,
} from "../contract.js";
import { composeOrchestratorProse } from "../orchestrator-prose.js";
import { SESSION_ID_PATTERN } from "../runtime.js";

/**
 * Codex has no system-prompt flag on its interactive TUI (no equivalent of
 * Claude's --append-system-prompt-file), and its config keys for inline
 * instructions were never probed against this CLI version. The role contract
 * therefore travels as the session's first prompt, the same channel `run`
 * already uses for every role. The TUI shows it as the opening message and
 * starts the turn immediately.
 */
export function initialPrompt(
  pluginDir: string,
  role: Role,
  mode: OrchestratorMode = DISPATCHER_PRESET,
): string {
  const { agentBody, ultra } = resolveRoleContract(pluginDir, role, mode);
  const orchestratorProse = role === "orchestrator" ? composeOrchestratorProse(mode) : "";
  const body = orchestratorProse ? `${agentBody}\n\n${orchestratorProse}` : agentBody;
  return `${ultra.trimEnd()}\n\n${body}`;
}

/**
 * Approximate role permissions with the only knob codex offers: the sandbox.
 * Codex cannot deny reads while allowing dispatch the way the opencode
 * permission map can, so the read-only roles land on read-only and everything
 * that dispatches work lands on workspace-write. With the default bypass this
 * mapping is dormant; it only binds under --no-bypass.
 */
export function roleSandbox(role: Role): CodexSandbox {
  switch (role) {
    case "reviewer":
    case "auditor":
      return "read-only";
    case "general":
    case "orchestrator":
      return "workspace-write";
  }
}

/**
 * Interactive codex argv. Mirrors the exec driver's flag spellings (measured
 * against codex-cli 0.154.0): resume is a subcommand, a resumed thread keeps
 * its policy and working root, and effort is a TOML config override.
 *
 * No model default is pinned here: without an explicit model the flag is
 * omitted and the codex config.toml answers.
 */
export function buildOpenArgs(
  role: Role,
  flags: OpenFlags & { model?: string },
  pluginDir: string,
  passthrough: string[],
  openCwd: string,
  mode: OrchestratorMode = DISPATCHER_PRESET,
): string[] {
  const isResume = flags.resume !== undefined;
  const args: string[] = [];
  if (isResume) args.push("resume", flags.resume as string);
  if (flags.model) args.push("-m", flags.model);
  if (!isResume) args.push("-s", roleSandbox(role));
  if (flags.bypass !== false) args.push("--dangerously-bypass-approvals-and-sandbox");
  // Validated, never interpolated raw: the value lands inside a TOML string
  // and an unescaped quote would inject a second config assignment.
  if (flags.effort) args.push("-c", `model_reasoning_effort="${parseEffort(flags.effort)}"`);
  if (!isResume) args.push("-C", openCwd);
  // The resume slot takes an optional follow-up prompt, so a resumed thread
  // never gets the role contract re-injected as a new message.
  if (!isResume) args.push(initialPrompt(pluginDir, role, mode));
  args.push(...passthrough);
  return args;
}

export const CODEX_NOT_FOUND =
  "Codex was not found on PATH. Install Codex and ensure `codex` is available.";

/**
 * The codex half of the split: find this harness's catalog, judge it with
 * the shared pure verdict. Kept while the suite pins this shape.
 */
export function judgeModel(
  model: string,
  catalogs: HarnessModels[] | undefined,
  fromConfig: boolean,
): ModelVerdict {
  return judgeModelIn(
    catalogs?.find((item) => item.agent === "codex"),
    model,
    fromConfig,
    "Codex",
  );
}

export async function preflight(model: string, fromConfig: boolean): Promise<void> {
  let catalogs;
  try {
    catalogs = await getCachedOrDiscoverModels(getRegistry(), { agent: "codex" });
  } catch (error) {
    // A catalog that cannot be reached is not evidence against the model, so
    // this warns and lets the launch decide.
    const text = error instanceof Error ? error.message : String(error);
    console.warn(catalogWarning("Codex", model, `unavailable (${text})`));
    return;
  }

  const verdict = judgeModel(model, catalogs, fromConfig);
  if (verdict.kind === "ok") return;
  if (verdict.kind === "unknown-catalog") {
    console.warn(verdict.warning);
    return;
  }
  throw new Error(verdict.error);
}

/**
 * Returns the resolved path rather than a boolean so everything downstream
 * launches the exact binary that was checked.
 */
export async function resolveBinary(): Promise<string> {
  const installation = await detectBinary("codex");
  if (!installation.installed || !installation.path) {
    throw new Error(CODEX_NOT_FOUND);
  }
  return installation.path;
}

/**
 * Where the TUI persists rollout files, honouring CODEX_HOME like the harness
 * does. Day directories use the local date, matching the filenames codex
 * writes.
 */
export function codexSessionsDir(
  now: Date = new Date(),
  home: string = os.homedir(),
  codexHome: string | undefined = process.env.CODEX_HOME,
): string {
  const base = codexHome && codexHome.length > 0 ? codexHome : path.join(home, ".codex");
  const pad = (n: number): string => String(n).padStart(2, "0");
  return path.join(
    base,
    "sessions",
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  );
}

/**
 * Best-effort snapshot of the day's rollout files. A missing directory means
 * no rollouts yet, not a failed capture; any other read failure stays
 * undefined so the close path refuses the diff instead of guessing.
 */
export function readCodexRollouts(dir: string = codexSessionsDir()): string[] | undefined {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.startsWith("rollout-") && file.endsWith(".jsonl"))
      .sort();
  } catch {
    try {
      if (!fs.existsSync(dir)) return [];
    } catch {}
    return undefined;
  }
}

export interface CodexRolloutIdentity {
  id: string;
  cwd?: string;
}

/**
 * Who a rollout file belongs to, read off its opening session_meta line.
 * Anything unparseable means "cannot tell", and a missing hint beats a
 * wrong one.
 */
export function rolloutIdentity(file: string): CodexRolloutIdentity | undefined {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    const line = JSON.parse(first) as {
      type?: unknown;
      payload?: { id?: unknown; cwd?: unknown };
    };
    const id = line?.payload?.id;
    if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) return undefined;
    const cwd = line?.payload?.cwd;
    return { id, ...(typeof cwd === "string" && cwd ? { cwd } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The thread id a rollout file belongs to. When the launching cwd is known
 * it must match the rollout's own cwd: two concurrent launches in different
 * directories must never record each other's session.
 */
export function threadIdFromRollout(file: string, expectedCwd?: string): string | undefined {
  const identity = rolloutIdentity(file);
  if (!identity) return undefined;
  if (expectedCwd !== undefined && identity.cwd !== expectedCwd) return undefined;
  return identity.id;
}

export interface RolloutSnapshot {
  dir: string;
  files: string[];
}

/**
 * The id of the session created between snapshots, or undefined. Zero or
 * ambiguous new files mean "cannot tell". Snapshots span directories so a
 * session crossing midnight is still found; a resumed thread appends to its
 * existing rollout, so resumes fall back to the --resume value at the close
 * path instead of this diff.
 */
export function diffCodexRolloutsAcross(
  before: string[],
  snapshots: RolloutSnapshot[],
  expectedCwd?: string,
): string | undefined {
  const known = new Set(before);
  const fresh: Array<{ dir: string; file: string }> = [];
  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      if (!known.has(file)) fresh.push({ dir: snapshot.dir, file });
    }
  }
  if (fresh.length !== 1) return undefined;
  return threadIdFromRollout(path.join(fresh[0].dir, fresh[0].file), expectedCwd);
}

/**
 * Single-day form of the across-directories diff.
 */
export function diffCodexRollouts(
  dir: string,
  before: string[],
  after: string[],
  expectedCwd?: string,
): string | undefined {
  return diffCodexRolloutsAcross(before, [{ dir, files: after }], expectedCwd);
}
