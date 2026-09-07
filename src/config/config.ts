import fs from "node:fs";
import path from "node:path";
import { getLegacyConfigFile, getPaths, hasConfigOverride } from "./paths.js";
import { isAgentId, type AgentId } from "../core/session.js";
import { parseSandbox } from "../core/driver.js";
import type { CodexSandbox } from "../core/driver.js";
import type { Role } from "../core/roles.js";
import type { OrchestratorMode } from "./orchestrator-mode.js";

export {
  BALANCED_PRESET,
  DISPATCHER_PRESET,
  EXPLORER_PRESET,
  ORCHESTRATOR_PRESETS,
  isOrchestratorMode,
  orchestratorModeLabel,
  resolveOrchestratorMode,
} from "./orchestrator-mode.js";
export type {
  InvestigateMode,
  OrchestratorMode,
  OrchestratorModeLabel,
  OrchestratorTools,
  SelfWorkMode,
} from "./orchestrator-mode.js";

/**
 * Which harness runs a role, and on which model. Both halves are one answer:
 * a model id means nothing without the harness that lists it, and two
 * harnesses can list the same id.
 */
export interface RoleBinding {
  harness: AgentId;
  model: string;
}

export interface RunAgentConfig {
  defaultAgent?: AgentId;
  worktree?: boolean;
  defaultModel?: string;
  remoteControl?: boolean;
  defaultSandbox?: CodexSandbox;
  /**
   * Run interactive sessions under a pty CodeDeck owns, which is what lets it
   * type harness commands — today the `/rename` that names a Claude Code
   * session after the first prompt. Defaults to true; unset it to keep the
   * plain spawn.
   */
  pty?: boolean;
  /**
   * Per harness, and the fallback for whatever `agents` does not answer: a run
   * with no role, or one whose role nobody bound. Setup no longer writes it.
   */
  models?: Partial<Record<AgentId, string>>;
  agents?: Partial<Record<Role, RoleBinding>>;
  orchestrator?: OrchestratorMode;
}

/**
 * A saved binding is only usable whole. A half-written entry (a harness with
 * no model, or the reverse) resolves to nothing rather than to a guess, so the
 * caller falls back the same way it would for a role nobody configured.
 *
 * The file is JSON someone can edit, and the cast in `loadConfig` believes
 * whatever it finds, so the harness is checked against the four CodeDeck
 * drives. Without that, `{"harness":"wat"}` reached the daemon as an agent id
 * and died there instead of falling back here.
 */
export function resolveRoleBinding(
  role: Role | undefined,
  config: RunAgentConfig = {},
): RoleBinding | undefined {
  if (role === undefined) return undefined;
  const binding = config.agents?.[role];
  if (!binding || !isAgentId(binding.harness)) return undefined;
  if (typeof binding.model !== "string" || binding.model.trim() === "") return undefined;
  return { harness: binding.harness, model: binding.model };
}

/**
 * Resolve the model passed to a driver without making driver defaults part of
 * CodeDeck's config. An undefined result lets the selected driver choose its
 * own default.
 */
export function resolveModel(
  agent: AgentId,
  explicit?: string,
  config: RunAgentConfig = {},
): string | undefined {
  return explicit ?? config.models?.[agent] ?? config.defaultModel;
}

/**
 * Resolve a hand-edited sandbox value without allowing an invalid value to
 * reach a driver. An invalid value is treated as absent, so the driver keeps
 * its own fallback.
 */
export function resolveDefaultSandbox(config: RunAgentConfig = {}): CodexSandbox | undefined {
  try {
    const value = config?.defaultSandbox;
    return typeof value === "string" ? parseSandbox(value) : undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_CONFIG: RunAgentConfig = {
  defaultAgent: "claude",
  worktree: false,
  remoteControl: true,
  pty: true,
};

export function defaultConfig(): RunAgentConfig {
  return { ...DEFAULT_CONFIG };
}

export type SetupConfigStatus = "ok" | "missing" | "invalid";
export type SetupConfigSource = "none" | "canonical" | "legacy";

export interface SetupConfigRead {
  status: SetupConfigStatus;
  source: SetupConfigSource;
  path: string;
  config: RunAgentConfig | null;
  raw: string | null;
  message: string | null;
  readError?: Error;
}

export interface SetupConfigStore {
  read(): SetupConfigRead;
  save(config: RunAgentConfig): void | boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeConfig(config: RunAgentConfig): string {
  const sortJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortJson);
    if (!isJsonObject(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, sortJson(value[key])]),
    );
  };

  return `${JSON.stringify(sortJson(config), null, 2)}\n`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function configInvalidMessage(file: string): string {
  return `Config file "${file}" contains invalid JSON; no changes were written. Repair or move it and retry.`;
}

interface ReadFileResult {
  kind: "missing" | "ok" | "invalid" | "error";
  raw?: string;
  config?: RunAgentConfig;
  message?: string;
  error?: Error;
}

function assertSecureDirectoryPath(directory: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (const part of parts) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`configuration directory component is a symbolic link: ${current}`);
    if (!stat.isDirectory()) throw new Error(`configuration path component is not a directory: ${current}`);
  }
}

function readConfigFile(file: string): ReadFileResult {
  try {
    assertSecureDirectoryPath(path.dirname(file));
  } catch (error) {
    return { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    return { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
  }

  if (stat.isSymbolicLink()) {
    return { kind: "error", error: new Error("configuration path is a symbolic link") };
  }
  if (!stat.isFile()) {
    return { kind: "error", error: new Error("configuration path is not a regular file") };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) return { kind: "invalid", raw };
    return { kind: "ok", raw, config: { ...DEFAULT_CONFIG, ...parsed } };
  } catch {
    return { kind: "invalid", raw };
  }
}

function setupConfigResult(
  file: string,
  source: SetupConfigSource,
  result: ReadFileResult,
): SetupConfigRead {
  if (result.kind === "missing") {
    return {
      status: "missing",
      source: "none",
      path: file,
      config: defaultConfig(),
      raw: null,
      message: null,
    };
  }
  if (result.kind === "error") {
    return {
      status: "invalid",
      source,
      path: file,
      config: null,
      raw: result.raw ?? null,
      message: result.error?.message ?? "Unable to read configuration.",
      readError: result.error,
    };
  }
  if (result.config === undefined) {
    return {
      status: "invalid",
      source,
      path: file,
      config: null,
      raw: result.raw ?? null,
      message: configInvalidMessage(file),
    };
  }
  return {
    status: "ok",
    source,
    path: file,
    config: result.config,
    raw: result.raw ?? null,
    message: null,
  };
}

/** Reads setup config without replacing malformed JSON with defaults. */
export function readConfigForSetup(): SetupConfigRead {
  const paths = getPaths();
  const canonical = readConfigFile(paths.configFile);
  if (canonical.kind !== "missing") {
    return setupConfigResult(paths.configFile, "canonical", canonical);
  }

  if (!hasConfigOverride()) {
    const legacyPath = getLegacyConfigFile();
    const legacy = readConfigFile(legacyPath);
    if (legacy.kind !== "missing") return setupConfigResult(legacyPath, "legacy", legacy);
  }

  return {
    status: "missing",
    source: "none",
    path: paths.configFile,
    config: defaultConfig(),
    raw: null,
    message: null,
  };
}

function ensureSecureDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`configuration directory component is a symbolic link: ${current}`);
      if (!stat.isDirectory()) throw new Error(`configuration path component is not a directory: ${current}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isMissing(mkdirError) && (mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`configuration directory component is a symbolic link: ${current}`);
      if (!stat.isDirectory()) throw new Error(`configuration path component is not a directory: ${current}`);
    }
  }
}

function existingConfigBytes(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("configuration target is a symbolic link");
    if (!stat.isFile()) throw new Error("configuration target is not a regular file");
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

let tempSequence = 0;

/** Writes a complete config document without following a symlink. */
export function writeConfigAtomically(file: string, contents: string): boolean {
  const absoluteFile = path.resolve(file);
  const parent = path.dirname(absoluteFile);
  ensureSecureDirectory(parent);

  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (noFollow === undefined) throw new Error("O_NOFOLLOW is not supported on this platform");

  if (existingConfigBytes(absoluteFile) === contents) return false;

  let temporary: string | undefined;
  let fd: number | undefined;
  let renamed = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = `${path.basename(absoluteFile)}.${process.pid}.${Date.now()}.${tempSequence++}.${attempt}.tmp`;
    const candidate = path.join(parent, name);
    try {
      fd = fs.openSync(
        candidate,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
        0o600,
      );
      temporary = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  if (fd === undefined || temporary === undefined) throw new Error("could not create a unique config temporary file");

  try {
    fs.fchmodSync(fd, 0o600);
    const bytes = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("config write made no progress");
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    try {
      const target = fs.lstatSync(absoluteFile);
      if (target.isSymbolicLink()) throw new Error("configuration target is a symbolic link");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    fs.renameSync(temporary, absoluteFile);
    renamed = true;

    const directoryFlag = (fs.constants as typeof fs.constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
    const directoryFd = fs.openSync(parent, fs.constants.O_RDONLY | directoryFlag | noFollow);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (!renamed && temporary !== undefined) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
}

export function loadConfig(): RunAgentConfig {
  const { configFile } = getPaths();
  try {
    if (!fs.existsSync(configFile)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(configFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? { ...DEFAULT_CONFIG, ...parsed } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: RunAgentConfig): boolean {
  const { configFile } = getPaths();
  return writeConfigAtomically(configFile, serializeConfig(cfg));
}

export function createSetupConfigStore(): SetupConfigStore {
  return {
    read: readConfigForSetup,
    save: saveConfig,
  };
}
