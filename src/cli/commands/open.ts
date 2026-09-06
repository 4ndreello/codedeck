import { spawn } from "node:child_process";
import path from "node:path";
import * as readline from "node:readline";
import os from "node:os";
import type { Command } from "commander";

import { IpcClient } from "../../daemon/ipc.js";
import {
  loadConfig,
  resolveModel,
  resolveRoleBinding,
  type RoleBinding,
} from "../../config/config.js";
import { isInteractiveTerminal } from "./setup.js";

import { ROLES, parseRole, resolvePluginDir, type Role } from "../../core/roles.js";
import { effectiveModel, type OpenFlags } from "../../open/contract.js";
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
  SPINNER_TIPS,
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
export { buildOpenArgs, buildSettings, entitlementError, judgeModel } from "../../open/launchers/claude.js";
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
): Promise<void> {
  return spawnHarness(claudeBin, args, {
    cwd,
    sessionFile,
    model,
    notFoundMessage: CLAUDE_NOT_FOUND,
    entitlementError,
    onClose,
    spawnChild,
    signalHost,
  });
}



/**
 * Width of each replacement verb in terminal columns. Keeping this fixed
 * leaves Claude's elapsed-time and token-count fields aligned.
 */
export const SPINNER_VERB_WIDTH = 12;






/**
 * Why an agent bound to another harness cannot be opened, or nothing.
 *
 * `open` launches Claude Code and only Claude Code: the plugin, the theme and
 * the status line are all its features, so there is no version of this that
 * honours the configuration. Launching claude anyway would open a session under
 * a name whose configuration it does not follow, which is the failure this
 * repository's own system prompt calls rounding failure to success.
 *
 * The model is deliberately not part of the check. An explicit --model changes
 * which claude runs, never whether claude is the right harness.
 */
export function harnessMismatch(role: Role, binding: RoleBinding | undefined): string | undefined {
  if (!binding || binding.harness === "claude") return undefined;
  return (
    `Agent "${role}" runs on ${binding.harness}, and codedeck open only launches Claude Code. ` +
    `Use \`codedeck run --role ${role} "<prompt>"\`, or move it to claude with \`codedeck setup\`.`
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
        `Unknown option "${name}" for codedeck open. Options for Claude go after "--".`,
      );
    }

    // Commander honours "=" only on options declared with a value and drops the
    // whole token otherwise, so `--no-bypass=false` would read as accepted and
    // launch with the bypass still on.
    if (separator >= 0 && !wantsValue) {
      throw new Error(`Option "${name}" for codedeck open takes no value.`);
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

      const binding = resolveRoleBinding(role, config);
      const mismatch = harnessMismatch(role, binding);
      if (mismatch) throw new Error(mismatch);

      const resolved = opts.model ?? binding?.model ?? resolveModel("claude", undefined, config) ?? DEFAULT_MODEL;
      const args = buildOpenArgs(role, { ...opts, model: resolved }, pluginDir, invocation.passthrough);
      const model = effectiveModel(invocation.passthrough) ?? resolved;

      // It came from config only when nobody typed a model just now, neither by
      // flag nor by passthrough, and the config actually had one.
      const fromConfig =
        opts.model === undefined &&
        effectiveModel(invocation.passthrough) === undefined &&
        (binding?.model !== undefined || resolveModel("claude", undefined, config) !== undefined);

      await preflightModel(model, fromConfig);
      const claudeBin = await resolveBinary();
      await assertSupport(claudeBin, cwd);

      const sessionFile = path.join(os.tmpdir(), `codedeck-session-${process.pid}`);
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
      );
    });
}
