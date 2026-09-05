import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as readline from "node:readline";
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
  return JSON.stringify({
    statusLine: {
      type: "command",
      command: path.join(pluginDir, "statusline.sh"),
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

function invalidRole(input: string): Error {
  return new Error(`Invalid role "${input}". Available roles: ${ROLES.join(", ")}`);
}

function selectRole(): Promise<Role> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<Role>((resolve) => {
    const ask = () => {
      rl.question("Role [general] (general/orchestrator/reviewer): ", (answer) => {
        const role = parseRole(answer || "general");
        if (role) {
          rl.close();
          resolve(role);
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
    if (!role) return Promise.reject(invalidRole(input));
    return Promise.resolve(role);
  }

  if (!interactive || !process.stdout.isTTY) return Promise.resolve("general");
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

function getInvocation(command: Command, roleArg: string | undefined): OpenInvocation {
  const parent = command.parent as CommandWithRawArgs | null;
  const rawArgs = parent?.rawArgs ?? (command as CommandWithRawArgs).rawArgs ?? [];
  // Searching forward from the executable and script entries, never backwards:
  // `open -- --print open` would otherwise match the passthrough word instead
  // of the command and lose the separator behind it.
  const commandIndex = rawArgs.indexOf(command.name(), 2);
  const separatorIndex = commandIndex >= 0 ? rawArgs.indexOf("--", commandIndex + 1) : -1;

  if (separatorIndex >= 0) {
    const beforeSeparator = rawArgs.slice(commandIndex + 1, separatorIndex);
    const explicitRole = roleArg !== undefined && !roleArg.startsWith("-") && beforeSeparator.includes(roleArg)
      ? roleArg
      : undefined;
    return {
      roleInput: explicitRole,
      passthrough: rawArgs.slice(separatorIndex + 1),
    };
  }

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

async function preflightModel(model: string): Promise<void> {
  let catalogs: HarnessModels[];
  try {
    catalogs = await getCachedOrDiscoverModels(getRegistry(), { agent: "claude" });
  } catch (error) {
    const details = errorDetails(error);
    console.warn(
      `Warning: Claude model catalog is unavailable (${details.text}); continuing with "${model}".`,
    );
    return;
  }

  const catalog = catalogs.find((item) => item.agent === "claude");
  if (!catalog || !catalog.available || catalog.error) {
    const reason = catalog?.error ? ` (${catalog.error})` : "";
    console.warn(`Warning: Claude model catalog is unavailable${reason}; continuing with "${model}".`);
    return;
  }

  const candidates = catalog.providers.flatMap((provider) =>
    provider.models.flatMap((candidate) => [candidate.id, ...(candidate.aliases ?? [])]),
  );
  if (candidates.length === 0) {
    console.warn(`Warning: Claude model catalog is empty; continuing with "${model}".`);
    return;
  }

  if (candidates.includes(model)) return;

  const suggestion = findClosestModel(model, candidates);
  const hint = suggestion
    ? ` Did you mean "${suggestion}"?`
    : " No close model was found.";
  throw new Error(`Model "${model}" is not in the Claude catalog.${hint}`);
}

/**
 * Returns the resolved path rather than a boolean so everything downstream
 * launches the exact binary that was checked, instead of asking PATH again and
 * hoping it answers the same way.
 */
async function resolveClaudeBinary(): Promise<string> {
  const missing = "Claude Code was not found on PATH. Install Claude Code and ensure `claude` is available.";
  let installation;
  try {
    installation = await detectBinary("claude");
  } catch (error) {
    const details = errorDetails(error);
    throw new Error(`${missing} (${details.text})`);
  }

  if (!installation.installed || !installation.path) throw new Error(missing);
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

function relayOutput(child: ChildProcess, output: { value: string }): void {
  const relay = (stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream) => {
    if (!stream) return;
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      output.value += text;
      target.write(chunk);
    });
  };

  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
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

    relayOutput(child, output);

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

      if (/\[claude-code:unrecognized_model\]/i.test(output.value)) {
        reject(
          new Error(
            `Claude Code rejected model "${model}" because this account is not entitled to it. Check the Claude plan or model access for the account.`,
          ),
        );
        return;
      }

      process.exitCode = signal ? 1 : (code ?? 1);
      resolve();
    });
  });
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open [role]")
    .description("Open a configured Claude Code session")
    .option("--model <model>", "model to use (default: claude-opus-4-8)")
    .option("--effort <level>", "reasoning effort (default: xhigh)")
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

      const model = resolveModel("claude", opts.model, config) ?? DEFAULT_MODEL;
      const args = buildOpenArgs(role, { ...opts, model }, pluginDir, invocation.passthrough);

      await preflightModel(model);
      const claudeBin = await resolveClaudeBinary();
      await assertSystemPromptFlagSupported(claudeBin, cwd);

      process.stdout.write(renderBanner(role));
      await launchClaude(claudeBin, model, args, cwd);
    });
}
