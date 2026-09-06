import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
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
import { getRegistry } from "../../drivers/registry.js";
import { detectBinary } from "../../drivers/helpers.js";
import {
  findClosestModel,
  getCachedOrDiscoverModels,
  modelNames,
  type HarnessModels,
} from "../../core/models.js";

import { ROLES, parseRole, resolvePluginDir, type Role } from "../../core/roles.js";
import { effectiveModel } from "../../open/contract.js";
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
const DEFAULT_ROLE: Role = "orchestrator";
const PLUGIN_NAME = "codedeck";
const THEME_REF = `custom:${PLUGIN_NAME}:codedeck-ultra`;

/**
 * Width of each replacement verb in terminal columns. Keeping this fixed
 * leaves Claude's elapsed-time and token-count fields aligned.
 */
export const SPINNER_VERB_WIDTH = 12;


/**
 * There is no startup text slot worth using, and the two that exist were tried.
 *
 * `companyAnnouncements` renders our string, but Claude Code puts its own dim
 * "Message from <organization>:" above it whenever the account belongs to one,
 * with no way to suppress that from settings. On an account with an org it
 * therefore reads as a message from the employer, which is false.
 *
 * A SessionStart hook can print, but every hook message renders as
 * "<hook> says: <text>", so it cannot draw a clean line either.
 *
 * Nothing is lost by leaving both alone. Claude Code's own opening header
 * already names the model, the effort and the agent, and the footer already
 * says whether permissions are bypassed.
 */
const CLAUDE_NOT_FOUND =
  "Claude Code was not found on PATH. Install Claude Code and ensure `claude` is available.";
const execFileAsync = promisify(execFile);


/**
 * The settings are built here, at launch, rather than shipped as a file, and
 * the reason is the status line.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is expanded only for hooks declared in a plugin's
 * hooks/hooks.json. It is never expanded for statusLine.command: the runner
 * calls its executor with nine arguments where the plugin root sits in the
 * fourteenth, so the check reads undefined and throws "This variable is only
 * available in hooks defined in a plugin's hooks/hooks.json file". The runner
 * swallows that, so the shipped settings.json produced no status line and no
 * error, in any version. `open` knows the real directory, so it writes the
 * resolved path instead of a placeholder nothing will substitute.
 *
 * Building it here also means one definition rather than two: the file that
 * shipped alongside this code was never exercised by a launch, which is exactly
 * how a broken command sat in it unnoticed.
 */
export function buildSettings(pluginDir: string, flags: OpenFlags): Record<string, unknown> {
  const statusLine = {
    type: "command",
    command: `bash ${shellQuote(path.join(pluginDir, "statusline.sh"))}`,
  };

  // --no-theme means "do not restyle my session", so it drops the whole look,
  // renderer included, and not just the palette. The status line is the one
  // thing it keeps, because that is what the flag has always promised.
  if (flags.theme === false) return { statusLine };

  return {
    theme: THEME_REF,
    tui: "fullscreen",
    spinnerVerbs: { mode: "replace", verbs: SPINNER_VERBS },
    spinnerTipsOverride: { excludeDefault: true, label: "ULTRA", tips: SPINNER_TIPS },
    statusLine,
  };
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
    JSON.stringify(buildSettings(pluginDir, flags)),
    // `--agent` layers on top of Claude's own system prompt rather than
    // replacing it, and an agent file with no `tools:` key inherits the whole
    // toolset. So `general` carries its contract the same way the others do,
    // with nothing taken away.
    "--agent",
    `${PLUGIN_NAME}:${role}`,
    "-n",
    `CodeDeck · ${role}`,
    ...(flags.resume ? ["--resume", flags.resume] : []),
    ...(flags.worktree ? ["-w"] : []),
    ...passthrough,
  ];

  return args;
}


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


/**
 * What the catalog can say about a model. Reachable is not the same as allowed:
 * the catalog lists what Claude Code knows about, never what this account may
 * use, so an entitlement problem only surfaces at launch (see launchClaude).
 */
const catalogWarning = (model: string, state: string): string =>
  `Warning: Claude model catalog is ${state}; continuing with "${model}".`;

export type ModelVerdict =
  | { kind: "ok" }
  | { kind: "unknown-catalog"; warning: string }
  | { kind: "rejected"; error: string };

/**
 * Pure so all three outcomes are testable without touching the disk cache or
 * spawning a harness.
 */
export function judgeModel(
  model: string,
  catalogs: HarnessModels[] | undefined,
  fromConfig: boolean,
): ModelVerdict {
  const keepGoing = (reason: string): ModelVerdict => ({
    kind: "unknown-catalog",
    warning: catalogWarning(model, `unavailable${reason}`),
  });

  const catalog = catalogs?.find((item) => item.agent === "claude");
  if (!catalog || !catalog.available || catalog.error) {
    return keepGoing(catalog?.error ? ` (${catalog.error})` : "");
  }

  const candidates = modelNames(catalog);
  if (candidates.length === 0) {
    return { kind: "unknown-catalog", warning: catalogWarning(model, "empty") };
  }

  if (candidates.includes(model)) return { kind: "ok" };

  const suggestion = findClosestModel(model, candidates);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : " No close model was found.";
  // A model can leave the catalog on its own, with nobody having typed it
  // wrong, and `needsModelSetup` never asks again, so the way out has to be
  // spelled out.
  const recovery = fromConfig ? " Run `codedeck setup` to pick another." : "";
  return { kind: "rejected", error: `Model "${model}" is not in the Claude catalog.${hint}${recovery}` };
}

async function preflightModel(model: string, fromConfig: boolean): Promise<void> {
  let catalogs: HarnessModels[] | undefined;
  try {
    catalogs = await getCachedOrDiscoverModels(getRegistry(), { agent: "claude" });
  } catch (error) {
    // A catalog that cannot be reached is not evidence against the model, so
    // this warns and lets the launch decide.
    const details = errorDetails(error);
    console.warn(catalogWarning(model, `unavailable (${details.text})`));
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
 * launches the exact binary that was checked, instead of asking PATH again and
 * hoping it answers the same way.
 */
async function resolveClaudeBinary(): Promise<string> {
  // detectBinary reports failure in its result and never rejects, so there is
  // nothing here to catch.
  const installation = await detectBinary("claude");
  if (!installation.installed || !installation.path) {
    throw new Error(CLAUDE_NOT_FOUND);
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
      throw new Error(CLAUDE_NOT_FOUND);
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
      const claudeBin = await resolveClaudeBinary();
      await assertSystemPromptFlagSupported(claudeBin, cwd);

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
