import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os, { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPaths } from "../config/paths.js";
import { getCliName } from "../cli/cli-name.js";
import { INDENT, LOGO, renderFarewell, renderLogo } from "../cli/ui.js";
import type { Role } from "../core/roles.js";
import { ptyUnavailableReason, startPtySession, type PtyLaunch, type PtySession } from "./pty.js";

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
export const SPINNER_VERBS = [
  "ﾊ7ｦ2ｲ9ｷ4ｼ1ﾏ8",
  "ｷ0ｼ9ﾏ3ﾃ6ﾕ1ﾎ8",
  "ﾃ4ﾅ8ﾆ2ｾ7ﾜ0ﾂ5",
  "ｦ1ｱ5ｳ8ﾚ2ｻ6ｸ0",
  "ｵ9ｶ3ｷ7ﾇ1ﾖ5ﾍ8",
  "ｺ2ｻ7ｼ4ﾈ0ﾓ6ﾀ9",
  "ｾ8ｿ0ﾀ3ﾊ6ﾘ2ｳ5",
  "ﾈ5ﾊ1ﾋ4ｿ8ﾔ0ﾃ6",
  "ﾏ3ﾐ6ﾑ9ｽ1ﾌ5ﾗ8",
  "ﾓ7ﾔ2ﾕ5ｶ9ﾄ3ﾚ6",
  "ﾘ0ﾜ4ｦ8ﾆ2ｿ7ﾒ5",
  "ｳ6ｴ9ｵ2ﾀ5ﾊ8ﾙ1",
  "ｶ1ｷ8ｹ3ﾇ7ﾌ0ﾖ5",
  "ｻ4ｼ0ｽ6ﾍ2ﾗ9ﾆ1",
  "ｿ2ﾀ5ﾂ8ﾏ4ｱ7ﾚ0",
  "ﾅ9ﾆ3ﾇ6ﾋ1ﾖ8ｴ4",
  "ﾋ6ﾎ1ﾏ5ﾕ8ｿ2ｷ9",
  "ﾑ8ﾒ4ﾓ7ｱ0ﾂ6ﾘ1",
  "ﾕ0ﾗ7ﾘ2ｳ5ﾐ9ﾀ3",
  "ｱ3ｳ5ｴ8ｶ1ﾖ6ﾎ0",
  "ｹ7ｺ2ｻ9ﾃ4ﾒ8ﾜ1",
  "ｽ1ｾ9ｿ3ﾊ6ｷ0ﾔ5",
  "ﾂ5ﾃ0ﾅ4ﾍ8ﾑ2ｦ7",
  "ﾇ8ﾈ6ﾊ2ﾐ5ｶ9ﾘ3",
  "ｦｧｨｩｪｫ1ｰｬｭｮ2",
  "ｬｭｮｯｰｱ3ｲｳｴｵ4",
  "ｯｰｱｲｳ5ｴｵｶｷｸ6",
  "ｰｶｷｸｹｺ7ｻｼｽｾ8",
  "ｻｼｽｾｿ9ﾀﾁﾂﾃﾄ0",
  "ﾀﾁﾂﾃﾄ1ﾅﾆﾇﾈﾉ2",
  "ﾅﾆﾇﾈﾉ3ﾊﾋﾌﾍﾎ4",
  "ﾊﾋﾌﾍﾎ5ﾏﾐﾑﾒﾓ6",
  "ﾏﾐﾑﾒﾓ7ﾔﾕﾖﾗﾘ8",
  "ﾔﾕﾖﾗﾘ9ﾙﾚﾛﾜﾝ0",
  "ﾙﾚﾛﾜﾝ1ｦｧｨｩｪ2",
  "ｦｧｨｩｪ3ｫｬｭｮｯ4",
  "ｱ9ﾝ8ｲ7ﾝ6ｳ5ﾝ4",
  "ｶ8ﾝ7ｷ6ﾝ5ｸ4ﾝ3",
  "ｻ7ﾝ6ｼ5ﾝ4ｽ3ﾝ2",
  "ﾀ6ﾝ5ﾁ4ﾝ3ﾂ2ﾝ1",
  "ﾅ5ﾝ4ﾆ3ﾝ2ﾇ1ﾝ0",
  "ﾊ4ﾝ3ﾋ2ﾝ1ﾌ0ﾝ9",
  "ﾏ3ﾝ2ﾐ1ﾝ0ﾑ9ﾝ8",
  "ﾔ2ﾝ1ﾕ0ﾝ9ﾖ8ﾝ7",
  "ﾙ1ﾝ0ﾚ9ﾝ8ﾛ7ﾝ6",
  "ｱｲ2ｳｴ3ｵｶ4ｷｸ5",
  "ｹｺ6ｻｼ7ｽｾ8ｿﾀ9",
  "ﾁﾂ0ﾃﾄ1ﾅﾆ2ﾇﾈ3",
  "ﾉﾊ4ﾋﾌ5ﾍﾎ6ﾏﾐ7",
  "ﾑﾒ8ﾓﾔ9ﾕﾖ0ﾗﾘ1",
  "ﾙﾚ2ﾛﾜ3ﾝｦ4ｧｨ5",
  "ｩｪ6ｫｬ7ｭｮ8ｯｰ9",
  "0ｱ1ｲ2ｳ3ｴ4ｵ5ｶ",
  "6ｷ7ｸ8ｹ9ｺ0ｻ1ｼ",
  "1ｼ2ｽ3ｾ4ｿ5ﾀ6ﾁ",
  "7ﾂ8ﾃ9ﾄ0ﾅ1ﾆ2ﾇ",
  "2ﾇ3ﾈ4ﾉ5ﾊ6ﾋ7ﾌ",
  "8ﾌ9ﾍ0ﾎ1ﾏ2ﾐ3ﾑ",
  "3ﾑ4ﾒ5ﾓ6ﾔ7ﾕ8ﾖ",
  "9ﾖ0ﾗ1ﾘ2ﾙ3ﾚ4ﾛ",
  "5ﾛ6ﾜ7ﾝ8ｦ9ｧ0ﾜ",
  "ｨ1ｩ2ｪ3ｫ4ｬ5ｭ6",
  "ｮ7ｯ8ｰ9ｱ0ｲ1ｳｴ",
  "ｴ2ｵ3ｶ4ｷ5ｸ6ｹｵ",
];

/**
 * Shown under the spinner as "ULTRA: <tip>". Every one of these names a command
 * this repository actually ships, because a tip that describes a flag nobody
 * has is worse than no tip at all.
 */
export function spinnerTips(): string[] {
  const cli = getCliName();
  return [
    `${cli} run --bg hands work to another harness so this session keeps its own context.`,
    `${cli} run --worktree gives each session its own checkout, so two of them cannot fight over a file.`,
    `${cli} ps lists the recent sessions with the harness and model each one ran on.`,
    `${cli} logs <id> prints what a background session actually reported.`,
    `${cli} wait <id> --json blocks until a session reaches a terminal state.`,
    `${cli} diff <id> shows what a worktree session changed, against its base commit.`,
    `${cli} stop <id> interrupts a session, then escalates to SIGTERM and SIGKILL.`,
    `${cli} send <id> continues a session with a new message instead of restarting it.`,
    `${cli} show <id> prints one session in full: status, worktree, usage, recent events.`,
    `${cli} open reviewer opens a session that can read and run but never edit.`,
    `${cli} setup binds each role to a harness and a model, one screen per role.`,
    `${cli} run --role auditor sends a one-off deep review to another harness.`,
  ];
}

/**
 * statusLine.command is handed to a shell, so an install directory carrying a
 * space, a `$`, a backtick or a quote would break the command or inject into
 * it. Single quotes take every one of those literally, and the only character
 * that can end them is a quote, which is why that one is spliced.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Gives Claude's child sessions a `codedeck` command even when this CLI came
 * from a checkout or an npx process that never installed a global shim.
 */
function writeShim(file: string, entry: string, cliName?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Rewriting is deliberate because the Node binary or checkout can move
  // after a previous launch, and writeFileSync preserves an existing mode.
  // The alias shim carries its own name so it prints right even when the
  // parent environment did not propagate CODEDECK_CLI_NAME.
  const rename = cliName !== undefined ? `export CODEDECK_CLI_NAME=${shellQuote(cliName)}\n` : "";
  fs.writeFileSync(
    file,
    `#!/usr/bin/env sh\n${rename}exec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`,
    { mode: 0o700 },
  );
  fs.chmodSync(file, 0o700);
}

export function ensureCodedeckShim(): string | undefined {
  try {
    const binDir = path.join(getPaths().base, "bin");
    const entry = fileURLToPath(new URL("../cli/index.js", import.meta.url));

    // The shim leads PATH so a stale global install cannot take over from the
    // CLI instance that is running this checkout.
    writeShim(path.join(binDir, "codedeck"), entry);
    // A renamed alias (CODEDECK_CLI_NAME) gets its own shim so workers type
    // the same name they were launched with.
    const alias = getCliName();
    if (alias !== "codedeck" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(alias)) {
      writeShim(path.join(binDir, alias), entry, alias);
    }
    return binDir;
  } catch {
    // A missing shim must not turn an otherwise valid Claude launch into a
    // failure.
  }
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
/**
 * Session ids CodeDeck prints back as resume hints: Claude UUIDs and
 * opencode `ses_` ids (probe-session-id-2026-09-07). One check so the
 * farewell and the sidecar cleanup agree on what counts as an id.
 */
export const SESSION_ID_PATTERN = /^(?:[0-9a-fA-F-]{8,}|ses_[A-Za-z0-9]{16,})$/;

export function resumeHint(role: Role, id: string | undefined): string | undefined {
  if (id === undefined || !SESSION_ID_PATTERN.test(id)) return undefined;
  return `${INDENT}resume: ${getCliName()} open ${role} --resume ${id}\n`;
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

/** Reads what the SessionStart hook left, and takes both sidecars with it. */
function takeSessionId(file: string): string | undefined {
  let id: string | undefined;
  try {
    id = fs.readFileSync(file, "utf8").trim() || undefined;
    return id;
  } catch {
    // No file means the hook never ran: an older Claude Code, a session that
    // died before startup, or a plugin the launch could not load. None of those
    // are worth a diagnostic on the way out of a session that otherwise worked.
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
    if (id && SESSION_ID_PATTERN.test(id)) {
      try {
        fs.rmSync(`${file}.${id}.name`, { force: true });
      } catch {}
    }
  }
}

const SIGINT_ESCALATION_COUNT = 3;
const SIGINT_KILL_GRACE_MS = 1000;

export interface SignalHost {
  on(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
}

type KillableChild = Pick<ChildProcess, "kill">;

export interface SigintGuard {
  childClosed(): void;
  dispose(): void;
}

/**
 * Keeps the parent alive while Claude leaves the terminal and CodeDeck writes
 * the resume hint.
 *
 * Claude inherits stdin and stays in the parent's foreground process group
 * (`detached: false`), so a tty sends Ctrl+C to both processes. This listener
 * absorbs only the parent's copy. Claude still receives the first Ctrl+C and
 * can exit normally. A flood eventually escalates the child itself so a stuck
 * session cannot prevent the hint from being written.
 */
export function installSigintGuard(
  getChild: () => KillableChild | undefined,
  signalHost: SignalHost = process,
): SigintGuard {
  let signals = 0;
  let escalationStarted = false;
  let childClosed = false;
  let disposed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const clearKillTimer = () => {
    if (killTimer === undefined) return;
    clearTimeout(killTimer);
    killTimer = undefined;
  };

  const send = (signal: NodeJS.Signals) => {
    const child = getChild();
    if (!child) return;
    try {
      child.kill(signal);
    } catch {}
  };

  const onSigint = () => {
    if (disposed || childClosed || escalationStarted) return;
    signals += 1;
    if (signals < SIGINT_ESCALATION_COUNT || !getChild()) return;

    escalationStarted = true;
    send("SIGTERM");
    killTimer = setTimeout(() => {
      killTimer = undefined;
      if (disposed || childClosed) return;
      send("SIGKILL");
    }, SIGINT_KILL_GRACE_MS);
  };

  signalHost.on("SIGINT", onSigint);

  return {
    childClosed() {
      childClosed = true;
      clearKillTimer();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearKillTimer();
      signalHost.removeListener("SIGINT", onSigint);
    },
  };
}

export function writeStdoutSync(text: string): void {
  try {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(1, bytes, offset, bytes.length - offset);
      if (written <= 0) break;
      offset += written;
    }
  } catch {}
}

/**
 * Claude Code prints its own resume hint on exit
 * ("Resume this session with: claude --resume ..."), with no setting to turn
 * it off. It always lands right above the farewell — a leading blank line
 * plus its two hint rows — so when there is an id to offer, which is the same
 * condition under which Claude printed its hint, this backs the cursor over
 * those two rows and clears down before the farewell goes out, leaving only
 * the BYE resume line. A wrapped hint (narrow terminal, long title) leaves
 * its top row behind, still strictly less noise than the duplicate.
 *
 * A pipe gets nothing: Claude skips its hint off-tty too, so there is nothing
 * to erase and escape codes would only pollute redirected output.
 */
export const CLAUDE_RESUME_ERASE = "\x1b[2A\x1b[J";

/** Takes the session id, writes the farewell while the SIGINT guard is live, and returns the native session id. */
export function finishOpenSession(
  role: Role,
  sessionFile: string,
  write: (text: string) => void = writeStdoutSync,
  stdoutIsTty: boolean = process.stdout.isTTY === true,
): string | undefined {
  try {
    const id = takeSessionId(sessionFile);
    if (resumeHint(role, id) !== undefined && stdoutIsTty) write(CLAUDE_RESUME_ERASE);
    write(renderExit(role, id));
    return id;
  } catch {
    return undefined;
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
const KATAKANA = [
  ...new Set([...SPINNER_VERBS.join("")].filter((glyph) => !/[0-9]/.test(glyph))),
];

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
export async function playBoot(role: Role, model: string, effort: string): Promise<void> {
  const out = process.stdout;
  if (!out.isTTY) {
    out.write(renderBanner(role, model, effort));
    return;
  }

  const noise = () => KATAKANA[randomInt(KATAKANA.length)];
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

export function assertPluginDirectory(pluginDir: string): void {
  try {
    if (fs.statSync(pluginDir).isDirectory()) return;
  } catch {}

  throw new Error(
    `CodeDeck plugin directory not found at ${pluginDir}. Rebuild or reinstall CodeDeck before running open.`,
  );
}

export function currentWorkingDirectory(): string {
  try {
    const cwd = process.cwd();
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}

  throw new Error("Cannot launch Claude Code: the current working directory no longer exists.");
}

export function errorDetails(error: unknown): { code?: string; text: string } {
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
 * How much of a pty session's output is kept for the entitlement check. Under
 * a pty the harness's stderr is merged into stdout, so the tagged refusal
 * arrives in the same stream the TUI paints with — and that stream never ends.
 * The refusal is written before the first frame, so a small window is enough
 * and the session does not accumulate its own transcript in memory.
 */
const PTY_SCAN_LIMIT = 64 * 1024;

/**
 * The pty variant of relayStderr: bytes are written through to the terminal
 * untouched, and only the opening window is remembered.
 */
function relayPtyOutput(child: ChildProcess, output: { value: string }, stdout: NodeJS.WriteStream): void {
  child.stdout?.pipe(stdout, { end: false });
  child.stdout?.on("data", (chunk: string | Buffer) => {
    if (output.value.length >= PTY_SCAN_LIMIT) return;
    output.value += typeof chunk === "string" ? chunk : chunk.toString();
  });
  relayStderr(child, output);
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

export interface SpawnHarnessOptions {
  cwd: string;
  envExtra?: Record<string, string>;
  sessionFile: string;
  model?: string;
  notFoundMessage: string;
  entitlementError?: (model: string, output: string) => string | undefined;
  onClose: () => void | Promise<void>;
  onSpawn?: (child: ChildProcess) => void | Promise<void>;
  spawnChild?: typeof spawn;
  signalHost?: SignalHost;
  /**
   * Ask for the session to run under a pty CodeDeck owns, so it can type into
   * the harness. Dropped whenever the terminal, the platform or the plugin
   * cannot support it — a session that opens without renaming itself beats a
   * session that does not open.
   */
  pty?: PtyLaunch;
}

/** Left as a seam so a test can assert the fallback without a real terminal. */
export function ptyLaunchFor(opts: SpawnHarnessOptions): PtyLaunch | undefined {
  if (!opts.pty) return undefined;
  const reason = ptyUnavailableReason({
    shim: opts.pty.shim,
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
  });
  return reason === undefined ? opts.pty : undefined;
}

export function spawnHarness(
  bin: string,
  args: string[],
  opts: SpawnHarnessOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const output = { value: "" };
    const binDir = ensureCodedeckShim();
    const childEnv =
      binDir === undefined
        ? sanitizeEnv(process.env)
        : withCodedeckOnPath(sanitizeEnv(process.env), binDir);
    let child: ChildProcess | undefined;
    let pty: PtySession | undefined;
    const launch = ptyLaunchFor(opts);
    const signalHost = opts.signalHost ?? process;

    // Under a pty the terminal is in raw mode, so Ctrl+C never reaches this
    // process as a signal: it is a byte on the way to the harness. The
    // escalation that kills a wedged session is fed from that byte instead,
    // through the same guard, so the escape hatch behaves as it always did.
    const keyboard = launch ? new EventEmitter() : undefined;
    const relayInterrupt = keyboard ? () => keyboard.emit("SIGINT") : undefined;
    if (relayInterrupt) signalHost.on("SIGINT", relayInterrupt);

    const sigintGuard = installSigintGuard(() => child, keyboard ?? signalHost);
    const releaseKeyboard = () => {
      if (relayInterrupt) signalHost.removeListener("SIGINT", relayInterrupt);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      pty?.dispose();
      releaseKeyboard();
      sigintGuard.childClosed();
      sigintGuard.dispose();
      reject(error);
    };

    const spawnChild = opts.spawnChild ?? spawn;
    const env = { ...childEnv, CODEDECK_SESSION_FILE: opts.sessionFile, ...(opts.envExtra ?? {}) };
    try {
      if (launch) {
        pty = startPtySession({
          target: { bin, args },
          launch,
          cwd: opts.cwd,
          env,
          spawnChild,
          onInterrupt: relayInterrupt,
        });
        child = pty.child;
      } else {
        child = spawnChild(bin, args, {
          cwd: opts.cwd,
          env,
          // Keep Claude in the foreground process group so the terminal sends
          // the first Ctrl+C to it as well as to this parent guard.
          detached: false,
          stdio: ["inherit", "inherit", "pipe"],
        });
      }
    } catch (error) {
      fail(error);
      return;
    }

    if (opts.onSpawn && child) {
      try {
        const res = opts.onSpawn(child);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {}
    }

    if (pty) relayPtyOutput(child, output, process.stdout);
    else relayStderr(child, output);

    child.once("error", (error) => {
      if (settled) return;
      const details = errorDetails(error);
      if (details.code === "ENOENT") {
        fail(new Error(opts.notFoundMessage));
      } else {
        fail(error);
      }
    });

    child.once("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      pty?.dispose();
      releaseKeyboard();
      sigintGuard.childClosed();

      const entitlement = opts.entitlementError?.(opts.model ?? "", output.value);
      if (entitlement) {
        sigintGuard.dispose();
        reject(new Error(entitlement));
        return;
      }

      process.exitCode = exitCodeFor(code, signal);
      try {
        await opts.onClose();
        sigintGuard.dispose();
        resolve();
      } catch (error) {
        sigintGuard.dispose();
        reject(error);
      }
    });
  });
}
