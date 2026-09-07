import type { AgentId } from "../core/session.js";

/**
 * What CodeDeck is allowed to type into a live session, per harness.
 *
 * Owning the pty (see pty.ts) makes CodeDeck the keyboard, and a keyboard can
 * reach anything a harness exposes to the person sitting there — which is
 * strictly more than any of them expose programmatically. Renaming is the
 * first use: Claude Code changes a live session's name only through
 * `/rename`, a TUI command with no CLI or hook equivalent.
 *
 * The keystrokes live here, one entry per harness, so the pty stays a dumb
 * wire and adding a harness is a line in this table rather than a branch in
 * the launcher.
 */

/** Longest name that gets typed. A title is a label, not a paragraph. */
const MAX_ARGUMENT_LENGTH = 40;

/** Enter, as a terminal delivers it. */
const SUBMIT = "\r";

export interface HarnessInjection {
  /**
   * Keystrokes that rename the live session, or nothing when the harness has
   * no command for it. A harness with no entry never gets a pty: the cost is
   * only worth paying where something can be typed.
   */
  rename?: (name: string) => string | undefined;
}

/**
 * Text arrives here from a harness hook and leaves as keystrokes, so anything
 * that a terminal would read as an instruction — a newline that submits an
 * extra line, an escape that moves the cursor — is flattened to a space
 * first. What is left is a label.
 */
export function sanitizeInjectedArgument(value: string, maxLength = MAX_ARGUMENT_LENGTH): string | undefined {
  const safe = value
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return safe.length > 0 ? safe : undefined;
}

/** A slash command as a person types it: the line, then Enter. */
export function slashCommandKeystrokes(command: string, argument: string): string | undefined {
  const safe = sanitizeInjectedArgument(argument);
  if (safe === undefined) return undefined;
  return `/${command} ${safe}${SUBMIT}`;
}

export const HARNESS_INJECTION: Record<AgentId, HarnessInjection> = {
  claude: {
    rename: (name) => slashCommandKeystrokes("rename", name),
  },
  // The other three are listed so a harness is never silently forgotten. None
  // has a rename command CodeDeck has verified, and an unverified guess would
  // be typed into someone's session as a prompt, so they stay empty until one
  // is probed the way `/rename` was.
  codex: {},
  opencode: {},
  omp: {},
};

export function harnessInjection(harness: AgentId): HarnessInjection {
  return HARNESS_INJECTION[harness] ?? {};
}

/** Whether typing into this harness buys anything today. */
export function supportsInjection(harness: AgentId): boolean {
  return Object.values(harnessInjection(harness)).some((value) => typeof value === "function");
}
