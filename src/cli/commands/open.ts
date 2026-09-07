import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import type { Command } from "commander";

import { IpcClient } from "../../daemon/ipc.js";
import {
  loadConfig,
  resolveRoleBinding,
  resolveOrchestratorMode,
  type RoleBinding,
  type RunAgentConfig,
} from "../../config/config.js";
import type { AgentId } from "../../core/session.js";
import { harnessInjection } from "../../open/injection.js";
import { getGitInfo } from "../../git/repository.js";
import { createWorktree } from "../../git/worktree.js";
import { ptyShimPath, type PtyLaunch } from "../../open/pty.js";
import { isInteractiveTerminal } from "./setup.js";
import { sessionsDir } from "../../open/pty.js";

import { ROLES, parseRole, resolvePluginDir, type Role } from "../../core/roles.js";
import { getCliName } from "../cli-name.js";
import { effectiveModel, resolveOpenModel, type OpenFlags } from "../../open/contract.js";
import {
  buildArgs as buildOpencodeArgs,
  buildInlineConfig,
  createEphemeralTuiDir,
  ensureOpencodeTheme,
  OPENCODE_NOT_FOUND,
  preflight as preflightOpencode,
  removeEphemeralTuiDir,
  resolveBinary as resolveOpencodeBinary,
} from "../../open/launchers/opencode.js";
import {
  assertSupport,
  buildOpenArgs,
  CLAUDE_NOT_FOUND,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  entitlementError,
  judgeModel,
  preflightModel,
  resolveBinary,
} from "../../open/launchers/claude.js";
import {
  SPINNER_VERBS,
  assertPluginDirectory,
  currentWorkingDirectory,
  ensureCodedeckShim,
  errorDetails,
  finishOpenSession,
  playBoot,
  renderBanner,
  sanitizeEnv,
  shellQuote,
  spawnHarness,
  withCodedeckOnPath,
  type SignalHost,
} from "../../open/runtime.js";

export { ROLES, parseRole, resolvePluginDir, type Role };
export { effectiveModel };
export { buildOpenArgs, buildSettings, entitlementError, judgeModel, sessionName } from "../../open/launchers/claude.js";
export type { ModelVerdict } from "../../open/contract.js";
export {
  bootFrame,
  ensureCodedeckShim,
  exitCodeFor,
  finishOpenSession,
  installSigintGuard,
  renderBanner,
  renderExit,
  resumeHint,
  sanitizeEnv,
  spinnerTips,
  withCodedeckOnPath,
  writeStdoutSync,
} from "../../open/runtime.js";

const DEFAULT_ROLE: Role = "orchestrator";

export function launchClaude(
  claudeBin: string,
  model: string,
  args: string[],
  cwd: string,
  sessionFile: string,
  onClose: () => void,
  spawnChild: typeof spawn = spawn,
  signalHost: SignalHost = process,
  envExtra?: Record<string, string>,
  pty?: PtyLaunch,
): Promise<void> {
  return spawnHarness(claudeBin, args, {
    cwd,
    sessionFile,
    envExtra,
    model,
    notFoundMessage: CLAUDE_NOT_FOUND,
    entitlementError,
    onClose,
    spawnChild,
    signalHost,
    pty,
  });
}

/**
 * What CodeDeck may type into this harness, or nothing when the harness has no
 * command worth typing or the caller turned the pty off. Interactive only: a
 * `--print` launch has no TUI to type into.
 */
export function ptyLaunchForHarness(
  harness: AgentId,
  pluginDir: string,
  sessionFile: string,
  flags: { pty?: boolean },
  config: RunAgentConfig,
  interactive: boolean,
): PtyLaunch | undefined {
  if (!interactive) return undefined;
  if (flags.pty === false || config.pty === false) return undefined;
  const rename = harnessInjection(harness).rename;
  if (!rename) return undefined;
  return { shim: ptyShimPath(pluginDir), sessionFile, keystrokesForName: rename };
}



/**
 * Width of each replacement verb in terminal columns. Keeping this fixed
 * leaves Claude's elapsed-time and token-count fields aligned.
 */
export const SPINNER_VERB_WIDTH = 12;






/**
 * Why an agent bound to a harness without a launcher cannot be opened, or
 * nothing. `open` launches claude and opencode sessions; anything else has no
 * launcher, so refusing beats opening a session under a name whose
 * configuration it does not follow.
 *
 * The model is deliberately not part of the check. An explicit --model changes
 * which binary runs, never whether it is the right harness.
 */
export function harnessMismatch(role: Role, binding: RoleBinding | undefined): string | undefined {
  if (!binding || binding.harness === "claude" || binding.harness === "opencode") {
    return undefined;
  }
  return (
    `Agent "${role}" runs on ${binding.harness}, and ${getCliName()} open only launches claude and opencode sessions. ` +
    `Use \`${getCliName()} run --role ${role} "<prompt>"\`, or move it with \`${getCliName()} setup\`.`
  );
}

export type OpenHarness = "claude" | "opencode";

export interface OpencodeSessionRow {
  id: unknown;
  created: unknown;
}

/**
 * Best-effort snapshot of `opencode session list`, or undefined. Capture
 * is allowed to fail: no snapshot means no resume hint (OP-09), never a
 * failed launch. No daemon, no config writes (OP-10, OP-19).
 */
export function readOpencodeSessions(bin: string): OpencodeSessionRow[] | undefined {
  try {
    const parsed: unknown = JSON.parse(
      execFileSync(bin, ["session", "list", "--format", "json", "-n", "50"], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }),
    );
    return Array.isArray(parsed) ? (parsed as OpencodeSessionRow[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The id of the one session that appeared between snapshots, or
 * undefined. Zero or several new sessions mean "cannot tell", and a
 * missing hint beats a wrong one.
 */
export function diffOpencodeSession(
  before: OpencodeSessionRow[],
  after: OpencodeSessionRow[],
): string | undefined {
  const known = new Set(
    before.map((row) => (typeof row.id === "string" ? row.id : "")),
  );
  const fresh = after.filter(
    (row): row is { id: string } & OpencodeSessionRow =>
      typeof row.id === "string" && !known.has(row.id),
  );
  if (fresh.length !== 1) return undefined;
  return fresh[0].id;
}

/**
 * The one dispatch decision: the binding owns the harness, and an unbound
 * role opens claude like it always did. Anything else throws instead of
 * rounding down to the wrong session.
 */
export function launcherFor(role: Role, binding: RoleBinding | undefined): OpenHarness {
  const harness = binding?.harness ?? "claude";
  if (harness === "claude" || harness === "opencode") return harness;
  const mismatch = harnessMismatch(role, binding);
  throw new Error(
    mismatch ?? `Agent "${role}" runs on ${harness}, which ${getCliName()} open does not launch.`,
  );
}






function selectRole(): Promise<Role> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<Role>((resolve, reject) => {
    let settled = false;
    const finish = (role: Role) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(role);
    };

    // Ctrl+D closes the interface without ever answering, so without this the
    // promise stays pending and the command hangs. It is a walk-out, not a
    // choice: EOF here used to launch a permission-bypassed session the user
    // never picked, and the model wizard already treats the same keystroke as
    // leaving. Reaching this needs a TTY, so a piped launch cannot trip it.
    rl.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Role selection was interrupted; nothing was launched."));
    });

    const ask = () => {
      rl.question(`Role [${DEFAULT_ROLE}] (${ROLES.join("/")}): `, (answer) => {
        const role = parseRole(answer || DEFAULT_ROLE);
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

export function resolveRole(input: string | undefined, interactive: boolean): Promise<Role> {
  if (input !== undefined) {
    const role = parseRole(input);
    if (!role) {
      return Promise.reject(
        new Error(`Invalid role "${input}". Available roles: ${ROLES.join(", ")}`),
      );
    }
    return Promise.resolve(role);
  }

  if (!interactive || !isInteractiveTerminal()) return Promise.resolve(DEFAULT_ROLE);
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
 * The rule enforced is commander's own: reject exactly what commander would
 * treat as unknown under allowUnknownOption(). Looser lets a dropped flag
 * through, which is the bug this exists to catch; stricter refuses a command
 * line commander parses happily.
 *
 * Returns the operands, meaning the tokens commander did not swallow as an
 * option or an option's value, so the caller can tell a role from a value that
 * happens to spell one.
 *
 * The known set is read from commander's registry so it cannot drift from the
 * declared options. Help is the exception: commander keeps its help option out
 * of `command.options`, so those two spellings are mirrored from the
 * `.helpOption()` call in src/cli/index.ts and change with it.
 */
export function scanOptions(tokens: string[], command: Command): string[] {
  const takesValue = new Map<string, boolean>([
    ["-h", false],
    ["--help", false],
  ]);
  for (const option of command.options) {
    const wantsValue = option.required || option.optional;
    if (option.short) takesValue.set(option.short, wantsValue);
    if (option.long) takesValue.set(option.long, wantsValue);
  }

  const operands: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("-") || token === "-") {
      operands.push(token);
      continue;
    }

    const separator = token.indexOf("=");
    const name = separator >= 0 ? token.slice(0, separator) : token;
    const wantsValue = takesValue.get(name);
    if (wantsValue === undefined) {
      throw new Error(
        `Unknown option "${name}" for ${getCliName()} open. Options for Claude go after "--".`,
      );
    }

    // Commander honours "=" only on options declared with a value and drops the
    // whole token otherwise, so `--no-bypass=false` would read as accepted and
    // launch with the bypass still on.
    if (separator >= 0 && !wantsValue) {
      throw new Error(`Option "${name}" for ${getCliName()} open takes no value.`);
    }

    // The next token belongs to this option even when it looks like a flag,
    // which is what keeps `--model -weird` from reading as an unknown option.
    if (wantsValue && separator < 0) i += 1;
  }

  return operands;
}

function getInvocation(command: Command, roleArg: string | undefined): OpenInvocation {
  const rawArgs = (command.parent as CommandWithRawArgs | null)?.rawArgs ?? [];
  // Searching forward from the executable and script entries, never backwards:
  // `open -- --print open` would otherwise match the passthrough word instead
  // of the command and lose the separator behind it.
  const commandIndex = rawArgs.indexOf(command.name(), 2);
  const separatorIndex = commandIndex >= 0 ? rawArgs.indexOf("--", commandIndex + 1) : -1;
  const beforeSeparator = commandIndex >= 0
    ? rawArgs.slice(commandIndex + 1, separatorIndex >= 0 ? separatorIndex : undefined)
    : [];
  const operands = scanOptions(beforeSeparator, command);

  if (separatorIndex >= 0) {
    // Commander folds the separator away, so roleArg can just as easily have
    // come from the passthrough. It counts as a role only when it really stood
    // before the separator as an operand, never as some option's value:
    // `open --resume reviewer -- reviewer` asks for no role at all.
    const explicitRole = roleArg !== undefined && operands.includes(roleArg) ? roleArg : undefined;
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









export function registerOpenCommand(program: Command): void {
  program
    .command("open [role]")
    .description(`Open a configured Claude Code session (roles: ${ROLES.join(" | ")}, default: ${DEFAULT_ROLE}, 3-letter prefixes accepted)`)
    .option("--model <model>", `model to use (default: ${DEFAULT_MODEL})`)
    .option("--effort <level>", `reasoning effort (default: ${DEFAULT_EFFORT})`)
    .option("--resume <session>", "resume a Claude Code session")
    .option("--worktree", "ask Claude Code to create an isolated worktree")
    .option("--no-bypass", "do not skip Claude Code permission prompts")
    .option("--no-theme", "keep only the CodeDeck status line, without the theme or the renderer")
    .option("--no-pty", "do not run the session under a pty, which also drops the automatic rename")
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

      // Launching never opens the wizard. Asking a model per harness was the
      // wrong question to greet someone with, and `codedeck setup` is the place
      // to answer it deliberately.
      const config = loadConfig();
      const orchestratorMode = resolveOrchestratorMode(config);

      const binding = resolveRoleBinding(role, config);
      const launcher = launcherFor(role, binding);

      const passthroughModel = effectiveModel(invocation.passthrough);
      const { model: boundModel, fromConfig } = resolveOpenModel(
        role,
        { model: opts.model, passthroughModel },
        config,
      );

      // Not the shared temp directory: `open` types the name it finds beside
      // this file into a live session, and on Linux anyone on the box can put
      // a file in /tmp under a name that is only a pid.
      const sessionFile = path.join(sessionsDir(), `codedeck-session-${process.pid}`);
      const runId = randomUUID();

      if (launcher === "opencode") {
        // Dispatch needs a binding, and a binding always carries a model, so
        // this is unreachable through the CLI. It stays because buildArgs
        // takes a string and a TypeError is not a diagnostic.
        if (boundModel === undefined) {
          throw new Error(
            `Agent "${role}" has no model bound. Run \`${getCliName()} setup\` to bind one.`,
          );
        }
        // OO-20 (warn-and-continue) is retired: --worktree now isolates
        // through a CodeDeck-side checkout, the same machinery as
        // `run --worktree`. The harness has no native flag; CodeDeck does.
        let openCwd = cwd;
        if (opts.worktree) {
          const gitInfo = await getGitInfo(cwd);
          if (!gitInfo) {
            throw new Error(
              `--worktree needs a git repository, and the current directory is outside one.`,
            );
          }
          // A creation failure propagates before the spawn: OP-14 would
          // rather fail than open in the wrong cwd.
          const wt = await createWorktree({
            repoRoot: gitInfo.root,
            sessionId: runId,
            prompt: role,
            name: role,
          });
          openCwd = wt.path;
        }
        const model = passthroughModel ?? boundModel;
        await preflightOpencode(model, fromConfig);
        const opencodeBin = await resolveOpencodeBinary();
        // Effort has no opencode flag; the banner names the fallback.
        const effort = opts.effort ?? "default";

        // --no-theme asks for no CodeDeck styling, and an animation is styling.
        if (opts.theme === false) {
          process.stdout.write(renderBanner(role, model, effort));
        } else {
          await playBoot(role, model, effort);
        }

        // --no-theme leaves the user's own opencode theme alone. Otherwise the
        // managed rage theme is ensured once and selected through an ephemeral
        // config dir, so the user's tui.json is never rewritten.
        const tuiDir = opts.theme === false || !ensureOpencodeTheme(pluginDir)
          ? undefined
          : createEphemeralTuiDir();
        // Snapshot before the spawn so the close path can tell which
        // session this launch created (probe-session-id-2026-09-07).
        const sessionsBefore = readOpencodeSessions(opencodeBin);
        const closeOpencode = () => {
          if (tuiDir !== undefined) removeEphemeralTuiDir(tuiDir);
          const after = readOpencodeSessions(opencodeBin);
          const id = after === undefined || sessionsBefore === undefined
            ? undefined
            : diffOpencodeSession(sessionsBefore, after);
          if (id !== undefined) {
            try {
              fs.writeFileSync(sessionFile, id);
            } catch {}
          }
          finishOpenSession(role, sessionFile);
        };

        await spawnHarness(
          opencodeBin,
          buildOpencodeArgs(role, { ...opts, model: boundModel }, invocation.passthrough),
          {
            cwd: openCwd,
            envExtra: {
              CODEDECK_RUN_ID: runId,
              OPENCODE_CONFIG_CONTENT: buildInlineConfig(pluginDir, role, orchestratorMode),
              ...(tuiDir !== undefined ? { OPENCODE_CONFIG_DIR: tuiDir } : {}),
            },
            sessionFile,
            model,
            notFoundMessage: OPENCODE_NOT_FOUND,
            onClose: closeOpencode,
          },
        );
        return;
      }

      const resolved = boundModel ?? DEFAULT_MODEL;
      const args = buildOpenArgs(
        role,
        { ...opts, model: resolved, remoteControl: config.remoteControl },
        pluginDir,
        invocation.passthrough,
        cwd,
        orchestratorMode,
      );
      const model = passthroughModel ?? resolved;

      await preflightModel(model, fromConfig);
      const claudeBin = await resolveBinary();
      await assertSupport(claudeBin, cwd);

      const effort = opts.effort ?? DEFAULT_EFFORT;

      // --no-theme asks for no CodeDeck styling, and an animation is styling.
      if (opts.theme === false) {
        process.stdout.write(renderBanner(role, model, effort));
      } else {
        await playBoot(role, model, effort);
      }

      await launchClaude(
        claudeBin,
        model,
        args,
        cwd,
        sessionFile,
        () => finishOpenSession(role, sessionFile),
        undefined,
        undefined,
        { CODEDECK_RUN_ID: runId },
        ptyLaunchForHarness("claude", pluginDir, sessionFile, opts, config, interactive),
      );
    });
}
