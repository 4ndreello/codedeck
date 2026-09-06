import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import os, { constants } from "node:os";
import type { Command } from "commander";

import { IpcClient } from "../../daemon/ipc.js";
import {
  loadConfig,
  resolveModel,
  resolveRoleBinding,
  type RoleBinding,
} from "../../config/config.js";
import { getPaths } from "../../config/paths.js";
import { isInteractiveTerminal } from "./setup.js";
import { INDENT, LOGO, renderFarewell, renderLogo } from "../ui.js";
import { getRegistry } from "../../drivers/registry.js";
import { detectBinary } from "../../drivers/helpers.js";
import {
  findClosestModel,
  getCachedOrDiscoverModels,
  modelNames,
  type HarnessModels,
} from "../../core/models.js";

import { ROLES, parseRole, resolvePluginDir, type Role } from "../../core/roles.js";

export { ROLES, parseRole, resolvePluginDir, type Role };

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
 * "replace" drops Claude Code's own hundred-odd verbs instead of adding to
 * them, so this list is the entire vocabulary and has to be long enough that a
 * single session does not visibly cycle it.
 *
 * The verb is glyphs rather than a word because the spinner symbol itself
 * cannot be reached. Its frames are module constants (`["·","✢","✳","✶","✻",
 * "✽"]`, mirrored for the ping-pong) picked only by whether TERM is
 * xterm-ghostty, and no setting touches them. The verb is the one part of that
 * line CodeDeck owns, so the character is made there instead.
 *
 * Halfwidth katakana on purpose, mixed with digits. It is the one dense
 * non-latin block that is single width, so a row of it cannot push the elapsed
 * time and token count out of alignment the way fullwidth kana would, and the
 * fonts that ship with a terminal carry it.
 *
 * Nothing is lost by dropping the words. The line still carries the elapsed
 * seconds, the token count and the effort, which is the part anyone reads.
 */
const SPINNER_VERBS = [
  "ﾊ7ｦ2ｲ",
  "ｷ0ｼ9ﾏ",
  "ﾃ4ﾅ8ﾆ",
  "ｦ1ｱ5ｳ",
  "ｵ9ｶ3ｷ",
  "ｺ2ｻ7ｼ",
  "ｾ8ｿ0ﾀ",
  "ﾈ5ﾊ1ﾋ",
  "ﾏ3ﾐ6ﾑ",
  "ﾓ7ﾔ2ﾕ",
  "ﾘ0ﾜ4ｦ",
  "ｳ6ｴ9ｵ",
  "ｶ1ｷ8ｹ",
  "ｻ4ｼ0ｽ",
  "ｿ2ﾀ5ﾂ",
  "ﾅ9ﾆ3ﾇ",
  "ﾋ6ﾎ1ﾏ",
  "ﾑ8ﾒ4ﾓ",
  "ﾕ0ﾗ7ﾘ",
  "ｱ3ｳ5ｴ",
  "ｹ7ｺ2ｻ",
  "ｽ1ｾ9ｿ",
  "ﾂ5ﾃ0ﾅ",
  "ﾇ8ﾈ6ﾊ",
];

/**
 * Shown under the spinner as "ULTRA: <tip>". Every one of these names a command
 * this repository actually ships, because a tip that describes a flag nobody
 * has is worse than no tip at all.
 */
const SPINNER_TIPS = [
  "codedeck run --bg hands work to another harness so this session keeps its own context.",
  "codedeck run --worktree gives each session its own checkout, so two of them cannot fight over a file.",
  "codedeck ps lists the recent sessions with the harness and model each one ran on.",
  "codedeck logs <id> prints what a background session actually reported.",
  "codedeck wait <id> --json blocks until a session reaches a terminal state.",
  "codedeck diff <id> shows what a worktree session changed, against its base commit.",
  "codedeck stop <id> interrupts a session, then escalates to SIGTERM and SIGKILL.",
  "codedeck send <id> continues a session with a new message instead of restarting it.",
  "codedeck show <id> prints one session in full: status, worktree, usage, recent events.",
  "codedeck open reviewer opens a session that can read and run but never edit.",
  "codedeck setup binds each role to a harness and a model, one screen per role.",
  "codedeck run --role auditor sends a one-off deep review to another harness.",
];

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
 * statusLine.command is handed to a shell, so an install directory carrying a
 * space, a `$`, a backtick or a quote would break the command or inject into
 * it. Single quotes take every one of those literally, and the only character
 * that can end them is a quote, which is why that one is spliced.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Gives Claude's child sessions a `codedeck` command even when this CLI came
 * from a checkout or an npx process that never installed a global shim.
 */
export function ensureCodedeckShim(): string | undefined {
  try {
    const binDir = path.join(getPaths().base, "bin");
    const entry = fileURLToPath(new URL("../index.js", import.meta.url));
    const shim = path.join(binDir, "codedeck");

    fs.mkdirSync(binDir, { recursive: true });
    // The shim leads PATH so a stale global install cannot take over from the
    // CLI instance that is running this checkout.
    fs.writeFileSync(
      shim,
      `#!/usr/bin/env sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`,
      { mode: 0o755 },
    );
    // Rewriting is deliberate because the Node binary or checkout can move
    // after a previous launch, and writeFileSync preserves an existing mode.
    fs.chmodSync(shim, 0o755);
    return binDir;
  } catch {
    // A missing shim must not turn an otherwise valid Claude launch into a
    // failure.
  }
}

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

const MODEL_PREFIX = "--model=";

/**
 * Claude honours the last --model on the line and the passthrough is appended
 * last, so `open --model bad -- --model good` really launches "good". Checking
 * anything but the last one grounds a launch that would have worked.
 *
 * Only the passthrough is scanned, never the built vector. That vector always
 * opens with a --model pair, so scanning it could never answer "the passthrough
 * overrode nothing", and a bare "--model" swallowed as another flag's value (as
 * in `open --resume --model`) would be read as a model of its own.
 *
 * Known limit: a literal "--model" passed as the value of one of Claude's own
 * flags still reads as an override. Telling that apart needs Claude's option
 * arity, which CodeDeck does not have.
 */
export function effectiveModel(passthrough: string[]): string | undefined {
  for (let i = passthrough.length - 1; i >= 0; i--) {
    const token = passthrough[i];
    if (token.startsWith(MODEL_PREFIX)) return token.slice(MODEL_PREFIX.length);
    if (i > 0 && passthrough[i - 1] === "--model") return token;
  }
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

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.CLAUDE_CODE_CHILD_SESSION;

  // A mise shim announces the tool it resolved on every run. It costs 36ms,
  // which nobody would notice, and one line of output, which lands on top of
  // the boot screen. Only the line matters. A setting of the user's own is left
  // alone, since silencing mise everywhere is not this command's call.
  sanitized.MISE_QUIET ??= "1";
  return sanitized;
}

export function withCodedeckOnPath(env: NodeJS.ProcessEnv, binDir: string): NodeJS.ProcessEnv {
  const currentPath = env.PATH;
  const entries = currentPath ? currentPath.split(path.delimiter) : [];
  if (entries[0] === binDir) return { ...env };

  return {
    ...env,
    PATH: [binDir, ...entries].join(path.delimiter),
  };
}

/**
 * What to say once the session is over, so the id is there when it is wanted
 * rather than buried in a picker.
 *
 * It cannot be said any earlier. The id does not exist when the boot screen
 * prints, and the launcher cannot read it off the session either, because
 * stdout is inherited by the terminal so that the TUI can paint straight to it.
 * A SessionStart hook is the one thing that sees it, and it can only leave it
 * in a file for afterwards.
 */
export function resumeHint(role: Role, id: string | undefined): string | undefined {
  if (id === undefined || !/^[0-9a-fA-F-]{8,}$/.test(id)) return undefined;
  return `${INDENT}resume: codedeck open ${role} --resume ${id}\n`;
}

/**
 * The way out, on the primary screen the alternate one just handed back.
 *
 * Drawn even when there is no id to offer, because the sign-off is the point
 * and a session that ended without one still ended.
 */
export function renderExit(role: Role, id: string | undefined): string {
  const farewell = renderFarewell()
    .split("\n")
    .map((line) => (line.trim() === "" ? line : blood(line)))
    .join("\n");
  const hint = resumeHint(role, id);
  return hint ? `${farewell}${muted(hint)}` : farewell;
}

/** Reads what the SessionStart hook left, and takes the file with it. */
function takeSessionId(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    // No file means the hook never ran: an older Claude Code, a session that
    // died before startup, or a plugin the launch could not load. None of those
    // are worth a diagnostic on the way out of a session that otherwise worked.
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

/**
 * The boot screen, and it works because of the fullscreen renderer rather than
 * in spite of it.
 *
 * Claude Code takes a moment to paint, and until it does the terminal shows
 * whatever stood there. Since it opens on the alternate screen, this is drawn
 * on the primary one, replaced the instant Claude takes over and restored,
 * unseen, when the session ends. So it fills exactly the gap and cleans itself
 * up, with nothing to tear down and no escape of ours left interleaved with
 * Claude's output.
 *
 * Colour is written by hand here for the same reason the status line writes its
 * own: this runs before Claude Code exists, so no theme is loaded yet.
 */
/**
 * The logo resolving out of katakana noise, one frame at a time.
 *
 * Same alphabet as the spinner, so the launch and the session read as one
 * thing. Blanks in the logo stay blank: the mark keeps its silhouette the whole
 * way through and the noise fills only the strokes, which is what makes it look
 * like the letters arriving rather than a rectangle of static.
 *
 * Pure, with the noise supplied by the caller, so a test can pin an exact frame
 * instead of asserting around randomness.
 */
export function bootFrame(progress: number, noise: (column: number) => string): string[] {
  const width = LOGO[0].length;
  const settled = Math.round(width * Math.min(1, Math.max(0, progress)));

  return LOGO.map((line) =>
    [...line]
      .map((glyph, column) => {
        if (column < settled || glyph === " ") return glyph;
        return noise(column);
      })
      .join(""),
  );
}

const BOOT_STEPS = 18;
const BOOT_STEP_MS = 40;
const KATAKANA = [...SPINNER_VERBS.join("")].filter((glyph) => !/[0-9]/.test(glyph));

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Plays the launch animation, then leaves the finished banner on screen.
 *
 * It runs BEFORE the spawn, and that ordering is the whole design. Once Claude
 * Code is spawned the two processes share one terminal, and the moment it
 * switches to the alternate screen anything written here lands inside its TUI.
 * There is no layer to sit on top of, so the choice is before or corrupted.
 * The cost is honest: this animation is time added to the launch, not time
 * borrowed from Claude Code starting up.
 *
 * A pipe gets the still banner. Cursor movement assumes a terminal that is
 * showing the last thing written, which a redirect into a file is not.
 */
async function playBoot(role: Role, model: string, effort: string): Promise<void> {
  const out = process.stdout;
  if (!out.isTTY) {
    out.write(renderBanner(role, model, effort));
    return;
  }

  const noise = () => KATAKANA[Math.floor(Math.random() * KATAKANA.length)];
  out.write("\n");

  for (let step = 0; step <= BOOT_STEPS; step++) {
    if (step > 0) out.write(`\x1b[${LOGO.length}A`);
    for (const line of bootFrame(step / BOOT_STEPS, noise)) {
      out.write(`\r\x1b[2K${INDENT}${blood(line)}\n`);
    }
    await delay(BOOT_STEP_MS);
  }

  out.write(`${INDENT}${muted(`${role} · ${model} · ${effort}`)}\n`);
  out.write(`${INDENT}${muted("booting…")}\n`);
}

const blood = (value: string) => `\x1b[38;2;225;29;72m${value}\x1b[0m`;
const muted = (value: string) => `\x1b[38;2;163;139;143m${value}\x1b[0m`;

export function renderBanner(role: Role, model: string, effort: string): string {
  const logo = renderLogo()
    .split("\n")
    .map((line) => (line.trim() === "" ? line : blood(line)))
    .join("\n");

  return `${logo}${INDENT}${muted(`${role} · ${model} · ${effort}`)}\n${INDENT}${muted("booting…")}\n`;
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

function launchClaude(
  claudeBin: string,
  model: string,
  args: string[],
  cwd: string,
  sessionFile: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const output = { value: "" };
    const binDir = ensureCodedeckShim();
    const childEnv =
      binDir === undefined
        ? sanitizeEnv(process.env)
        : withCodedeckOnPath(sanitizeEnv(process.env), binDir);
    const child = spawn(claudeBin, args, {
      cwd,
      env: { ...childEnv, CODEDECK_SESSION_FILE: sessionFile },
      stdio: ["inherit", "inherit", "pipe"],
    });

    relayStderr(child, output);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      const details = errorDetails(error);
      if (details.code === "ENOENT") {
        reject(new Error(CLAUDE_NOT_FOUND));
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

      await launchClaude(claudeBin, model, args, cwd, sessionFile);
      process.stdout.write(renderExit(role, takeSessionId(sessionFile)));
    });
}
