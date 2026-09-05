import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as readline from "node:readline";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

import { IpcClient } from "../../daemon/ipc.js";
import { loadConfig, resolveModel } from "../../config/config.js";
import { needsModelSetup, runModelSetupWizard } from "./setup.js";
import { getRegistry } from "../../drivers/registry.js";
import { detectBinary } from "../../drivers/helpers.js";
import {
  findClosestModel,
  getCachedOrDiscoverModels,
  modelNames,
  type HarnessModels,
} from "../../core/models.js";

export const ROLES = ["general", "orchestrator", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export interface OpenFlags {
  model?: string;
  effort?: string;
  resume?: string;
  worktree?: boolean;
  bypass?: boolean;
  theme?: boolean;
}

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_EFFORT = "xhigh";
const PLUGIN_NAME = "codedeck";
const execFileAsync = promisify(execFile);

/**
 * Resolve the bundled plugin from this module, not from the caller's cwd.
 * Source files live below src/cli/commands; built files live below dist/cli/commands.
 */
export function resolvePluginDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distPlugin = path.resolve(moduleDir, "../../plugin");
  const sourcePlugin = path.resolve(moduleDir, "../../../plugin");
  const moduleRoot = path.resolve(moduleDir, "../..");
  const candidates = path.basename(moduleRoot) === "dist"
    ? [distPlugin, sourcePlugin]
    : [sourcePlugin, distPlugin];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function settingsArgument(pluginDir: string, flags: OpenFlags): string {
  if (flags.theme !== false) return path.join(pluginDir, "settings.json");

  // Claude accepts an inline settings JSON value. Keep the status line while
  // removing only the theme, without mutating the plugin's shared settings file.
  // The path is quoted because it is a shell command, and an install under a
  // directory with a space would otherwise lose the status line.
  return JSON.stringify({
    statusLine: {
      type: "command",
      command: `bash "${path.join(pluginDir, "statusline.sh")}"`,
    },
  });
}

export function buildOpenArgs(
  role: Role,
  flags: OpenFlags,
  pluginDir: string,
  passthrough: string[],
): string[] {
  const args = [
    "--model",
    flags.model ?? DEFAULT_MODEL,
    "--effort",
    flags.effort ?? DEFAULT_EFFORT,
    ...(flags.bypass !== false ? ["--dangerously-skip-permissions"] : []),
    "--plugin-dir",
    pluginDir,
    "--append-system-prompt-file",
    path.join(pluginDir, "ultra.md"),
    "--settings",
    settingsArgument(pluginDir, flags),
    ...(role === "general" ? [] : ["--agent", `${PLUGIN_NAME}:${role}`]),
    "-n",
    `CodeDeck · ${role}`,
    ...(flags.resume ? ["--resume", flags.resume] : []),
    ...(flags.worktree ? ["-w"] : []),
    ...passthrough,
  ];

  return args;
}

/**
 * Claude honours the last --model on the line and the passthrough is appended
 * last, so `open --model bad -- --model good` really launches "good". Checking
 * anything but the last one grounds a launch that would have worked.
 */
export function effectiveModel(args: string[]): string | undefined {
  for (let i = args.length - 1; i > 0; i--) {
    if (args[i - 1] === "--model") return args[i];
  }
}

export function parseRole(input: string | undefined): Role | undefined {
  if (input === undefined) return undefined;
  const normalized = input.trim().toLowerCase();
  return (ROLES as readonly string[]).includes(normalized)
    ? (normalized as Role)
    : undefined;
}

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.CLAUDE_CODE_CHILD_SESSION;
  return sanitized;
}

export function renderBanner(role: Role): string {
  const title = ` CodeDeck · ${role} `;
  const border = "─".repeat(title.length);
  return `\n┌${border}┐\n│${title}│\n└${border}┘\n\n`;
}

function selectRole(): Promise<Role> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<Role>((resolve) => {
    let settled = false;
    const finish = (role: Role) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(role);
    };

    // Ctrl+D closes the interface without ever answering the question, so
    // without this the promise stays pending and the command hangs.
    rl.once("close", () => finish("general"));

    const ask = () => {
      rl.question("Role [general] (general/orchestrator/reviewer): ", (answer) => {
        const role = parseRole(answer || "general");
        if (role) {
          finish(role);
          return;
        }

        process.stderr.write(`Invalid role. Available roles: ${ROLES.join(", ")}\n`);
        ask();
      });
    };

    ask();
  });
}

/**
 * `claude -p` answers one prompt and exits, so there is no session to choose a
 * role for. A terminal check alone does not catch this: under a pty (CI scripts,
 * `script`, most CI runners) stdout is a TTY and the prompt would block forever.
 */
export function isNonInteractiveLaunch(passthrough: string[]): boolean {
  return passthrough.some((arg) => arg === "-p" || arg === "--print");
}

function resolveRole(input: string | undefined, interactive: boolean): Promise<Role> {
  if (input !== undefined) {
    const role = parseRole(input);
    if (!role) {
      return Promise.reject(
        new Error(`Invalid role "${input}". Available roles: ${ROLES.join(", ")}`),
      );
    }
    return Promise.resolve(role);
  }

  // Both streams matter. `tail -f /dev/null | codedeck open` keeps stdout a TTY
  // while stdin can never answer, and the prompt would wait forever.
  if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve("general");
  }
  return selectRole();
}

interface OpenInvocation {
  roleInput: string | undefined;
  passthrough: string[];
}

// Commander populates rawArgs at parse time but does not declare it, and the
// unparsed argv is the only place the "--" separator survives: commander drops
// it, so `open -- --print` arrives with "--print" bound to the role argument.
type CommandWithRawArgs = Command & { rawArgs?: string[] };

/**
 * Unknown options have to be allowed so the passthrough can carry Claude's own
 * flags, but that acceptance must stop at the separator. Without this check a
 * typo in a safety flag is silent: `open --no-bypas` looks like it turned the
 * permission bypass off and launches with it still on.
 *
 * The known set comes from commander's own registry, so it cannot drift from
 * the options actually declared.
 */
function assertOnlyKnownOptions(tokens: string[], command: Command): void {
  const known = new Set(["-h", "--help"]);
  for (const option of command.options) {
    if (option.short) known.add(option.short);
    if (option.long) known.add(option.long);
  }

  for (const token of tokens) {
    if (!token.startsWith("-") || token === "-") continue;
    const name = token.split("=")[0];
    if (known.has(name)) continue;
    throw new Error(
      `Unknown option "${name}" for codedeck open. Options for Claude go after "--".`,
    );
  }
}

function getInvocation(command: Command, roleArg: string | undefined): OpenInvocation {
  const rawArgs = (command.parent as CommandWithRawArgs | null)?.rawArgs ?? [];
  // Searching forward from the executable and script entries, never backwards:
  // `open -- --print open` would otherwise match the passthrough word instead
  // of the command and lose the separator behind it.
  const commandIndex = rawArgs.indexOf(command.name(), 2);
  const separatorIndex = commandIndex >= 0 ? rawArgs.indexOf("--", commandIndex + 1) : -1;

  if (separatorIndex >= 0) {
    const beforeSeparator = rawArgs.slice(commandIndex + 1, separatorIndex);
    assertOnlyKnownOptions(beforeSeparator, command);
    const explicitRole = roleArg !== undefined && !roleArg.startsWith("-") && beforeSeparator.includes(roleArg)
      ? roleArg
      : undefined;
    return {
      roleInput: explicitRole,
      passthrough: rawArgs.slice(separatorIndex + 1),
    };
  }

  assertOnlyKnownOptions(commandIndex >= 0 ? rawArgs.slice(commandIndex + 1) : [], command);
  const parsedArgs = command.args.slice();
  if (roleArg !== undefined && parsedArgs[0] === roleArg) {
    parsedArgs.shift();
  }
  if (parsedArgs.length > 0) {
    throw new Error('Arguments for Claude must follow "--" so CodeDeck can forward them verbatim.');
  }

  return { roleInput: roleArg, passthrough: [] };
}

function assertPluginDirectory(pluginDir: string): void {
  try {
    if (fs.statSync(pluginDir).isDirectory()) return;
  } catch {}

  throw new Error(
    `CodeDeck plugin directory not found at ${pluginDir}. Rebuild or reinstall CodeDeck before running open.`,
  );
}

function currentWorkingDirectory(): string {
  try {
    const cwd = process.cwd();
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}

  throw new Error("Cannot launch Claude Code: the current working directory no longer exists.");
}

function errorDetails(error: unknown): { code?: string; text: string } {
  if (typeof error !== "object" || error === null) return { text: String(error) };
  const value = error as {
    code?: unknown;
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const text = [value.stderr, value.stdout, value.message]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  return {
    code: typeof value.code === "string" ? value.code : undefined,
    text: text || String(error),
  };
}

/**
 * What the catalog can say about a model. Reachable is not the same as allowed:
 * the catalog lists what Claude Code knows about, never what this account may
 * use, so an entitlement problem only surfaces at launch (see launchClaude).
 */
export type ModelVerdict =
  | { kind: "ok" }
  | { kind: "unknown-catalog"; warning: string }
  | { kind: "rejected"; error: string };

/**
 * Pure so all three outcomes are testable without touching the disk cache or
 * spawning a harness.
 */
export function judgeModel(model: string, catalogs: HarnessModels[] | undefined): ModelVerdict {
  const keepGoing = (reason: string): ModelVerdict => ({
    kind: "unknown-catalog",
    warning: `Warning: Claude model catalog is unavailable${reason}; continuing with "${model}".`,
  });

  const catalog = catalogs?.find((item) => item.agent === "claude");
  if (!catalog || !catalog.available || catalog.error) {
    return keepGoing(catalog?.error ? ` (${catalog.error})` : "");
  }

  const candidates = modelNames(catalog);
  if (candidates.length === 0) {
    return {
      kind: "unknown-catalog",
      warning: `Warning: Claude model catalog is empty; continuing with "${model}".`,
    };
  }

  if (candidates.includes(model)) return { kind: "ok" };

  const suggestion = findClosestModel(model, candidates);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : " No close model was found.";
  return { kind: "rejected", error: `Model "${model}" is not in the Claude catalog.${hint}` };
}

async function preflightModel(model: string): Promise<void> {
  let catalogs: HarnessModels[] | undefined;
  try {
    catalogs = await getCachedOrDiscoverModels(getRegistry(), { agent: "claude" });
  } catch (error) {
    // A catalog that cannot be reached is not evidence against the model, so
    // this warns and lets the launch decide.
    const details = errorDetails(error);
    console.warn(
      `Warning: Claude model catalog is unavailable (${details.text}); continuing with "${model}".`,
    );
    return;
  }

  const verdict = judgeModel(model, catalogs);
  if (verdict.kind === "ok") return;
  if (verdict.kind === "unknown-catalog") {
    console.warn(verdict.warning);
    return;
  }
  throw new Error(verdict.error);
}

/**
 * Returns the resolved path rather than a boolean so everything downstream
 * launches the exact binary that was checked, instead of asking PATH again and
 * hoping it answers the same way.
 */
async function resolveClaudeBinary(): Promise<string> {
  // detectBinary reports failure in its result and never rejects, so there is
  // nothing here to catch.
  const installation = await detectBinary("claude");
  if (!installation.installed || !installation.path) {
    throw new Error("Claude Code was not found on PATH. Install Claude Code and ensure `claude` is available.");
  }
  return installation.path;
}

async function assertSystemPromptFlagSupported(claudeBin: string, cwd: string): Promise<void> {
  try {
    await execFileAsync(claudeBin, ["--append-system-prompt-file"], {
      cwd,
      env: sanitizeEnv(process.env),
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const details = errorDetails(error);
    if (details.code === "ENOENT") {
      throw new Error("Claude Code was not found on PATH. Install Claude Code and ensure `claude` is available.");
    }

    if (/unknown option|unknown argument|unrecognized option|invalid option/i.test(details.text)) {
      throw new Error(
        "This Claude Code version does not support --append-system-prompt-file. Upgrade Claude Code and retry.",
      );
    }

    // A supported Commander option reports a missing argument for this probe.
    // Other probe failures are left to the real launch, which can provide the
    // harness-specific diagnostic without blocking a valid installation.
  }
}

/**
 * Only stderr is piped, and only because Claude Code reports an unusable model
 * there as a tagged line rather than a distinct exit code. stdout stays
 * inherited so the TUI paints straight to the terminal, which also means
 * `child.stdout` is null and there is nothing to relay.
 */
function relayStderr(child: ChildProcess, output: { value: string }): void {
  const stream = child.stderr;
  if (!stream) return;

  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string | Buffer) => {
    output.value += typeof chunk === "string" ? chunk : chunk.toString();
    process.stderr.write(chunk);
  });
}

/**
 * A signalled death carries no exit code, and collapsing it to 1 tells a caller
 * the session failed rather than that it was killed. Shells report this as
 * 128 plus the signal number, so Ctrl+C stays 130 and a SIGKILL stays 137.
 */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (!signal) return 1;
  const number = constants.signals[signal];
  return typeof number === "number" ? 128 + number : 1;
}

/**
 * The catalog knows which models exist, not which ones this account may use, so
 * an entitlement problem can only be read off the launch itself. Claude Code
 * reports it as a tagged error rather than a distinct exit code.
 */
export function entitlementError(model: string, output: string): string | undefined {
  const tag = /\[claude-code:unrecognized_model\]\s*(\{.*\})?/i.exec(output);
  if (!tag) return undefined;

  // The passthrough can carry its own --model, which wins over the one CodeDeck
  // resolved, so the name in the payload is the one that was actually rejected.
  let rejected = model;
  if (tag[1]) {
    try {
      const payload = JSON.parse(tag[1]) as { model?: unknown };
      if (typeof payload.model === "string" && payload.model) rejected = payload.model;
    } catch {}
  }

  return `Claude Code rejected model "${rejected}" because this account is not entitled to it. Check the Claude plan or model access for the account.`;
}

function launchClaude(claudeBin: string, model: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const output = { value: "" };
    const child = spawn(claudeBin, args, {
      cwd,
      env: sanitizeEnv(process.env),
      stdio: ["inherit", "inherit", "pipe"],
    });

    relayStderr(child, output);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      const details = errorDetails(error);
      if (details.code === "ENOENT") {
        reject(new Error("Claude Code was not found on PATH. Install Claude Code and ensure `claude` is available."));
      } else {
        reject(error);
      }
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;

      const entitlement = entitlementError(model, output.value);
      if (entitlement) {
        reject(new Error(entitlement));
        return;
      }

      process.exitCode = exitCodeFor(code, signal);
      resolve();
    });
  });
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open [role]")
    .description("Open a configured Claude Code session")
    .option("--model <model>", `model to use (default: ${DEFAULT_MODEL})`)
    .option("--effort <level>", `reasoning effort (default: ${DEFAULT_EFFORT})`)
    .option("--resume <session>", "resume a Claude Code session")
    .option("--worktree", "ask Claude Code to create an isolated worktree")
    .option("--no-bypass", "do not skip Claude Code permission prompts")
    .option("--no-theme", "keep the CodeDeck status line without applying its theme")
    .allowUnknownOption()
    .action(async (roleArg: string | undefined, opts: OpenFlags, command: Command) => {
      const invocation = getInvocation(command, roleArg);
      const interactive = !isNonInteractiveLaunch(invocation.passthrough);
      const role = await resolveRole(invocation.roleInput, interactive);
      const pluginDir = resolvePluginDir();
      assertPluginDirectory(pluginDir);
      const cwd = currentWorkingDirectory();

      const client = new IpcClient();
      await client.ensureDaemonStarted();

      // First run picks a model per installed agent. It runs after the daemon
      // check so a broken install fails before the user answers questions, and
      // before the model is resolved so the answer takes effect immediately.
      let config = loadConfig();
      if (interactive && opts.model === undefined && needsModelSetup(config)) {
        config = await runModelSetupWizard({ config });
      }

      const resolved = resolveModel("claude", opts.model, config) ?? DEFAULT_MODEL;
      const args = buildOpenArgs(role, { ...opts, model: resolved }, pluginDir, invocation.passthrough);
      const model = effectiveModel(args) ?? resolved;

      await preflightModel(model);
      const claudeBin = await resolveClaudeBinary();
      await assertSystemPromptFlagSupported(claudeBin, cwd);

      process.stdout.write(renderBanner(role));
      await launchClaude(claudeBin, model, args, cwd);
    });
}
