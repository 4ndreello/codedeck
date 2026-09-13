import type { Command } from "commander";
import {
  extractProfileSnapshot,
  getProfileSnapshot,
  listProfiles,
  loadConfig,
  parseProfileName,
  resolveEffectiveConfig,
  saveConfig,
  serializeConfig,
  type ProfileSnapshot,
  type RunAgentConfig,
} from "../../config/config.js";
import { ROLES } from "../../core/roles.js";

export type ProfileAction = "list" | "show" | "save" | "use" | "delete";

export const PROFILE_ACTIONS: readonly ProfileAction[] = ["list", "show", "save", "use", "delete"];

export class ProfileUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileUsageError";
  }
}

export interface ParsedProfileArgs {
  action: ProfileAction;
  name?: string;
  json: boolean;
}

function isProfileAction(value: string): value is ProfileAction {
  return (PROFILE_ACTIONS as readonly string[]).includes(value);
}

export function parseProfileArgs(args: readonly string[]): ParsedProfileArgs {
  let action: ProfileAction | undefined;
  let name: string | undefined;
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) throw new ProfileUsageError(`Unknown option "${arg}".`);
    if (action === undefined) {
      if (!isProfileAction(arg)) {
        throw new ProfileUsageError(
          `Unknown action "${arg}". Available: ${PROFILE_ACTIONS.join(", ")}.`,
        );
      }
      action = arg;
      continue;
    }
    if (name !== undefined) throw new ProfileUsageError(`Unexpected argument "${arg}".`);
    name = arg;
  }

  if (action === undefined) {
    throw new ProfileUsageError(`Missing action. Available: ${PROFILE_ACTIONS.join(", ")}.`);
  }
  if (action !== "list" && name === undefined) {
    throw new ProfileUsageError(`profile ${action} needs a name.`);
  }
  if (action === "list" && name !== undefined) {
    throw new ProfileUsageError(`Unexpected argument "${name}".`);
  }
  return { action, ...(name === undefined ? {} : { name }), json };
}

export interface ProfileResult {
  /** Full file content to persist. Unchanged when save is false. */
  config: RunAgentConfig;
  save: boolean;
  /** Human-readable line for stdout. */
  text: string;
  /** Machine-readable payload for --json. */
  payload: unknown;
}

function agentSummary(snapshot: ProfileSnapshot): string {
  return ROLES.map((role) => {
    const binding = snapshot.agents?.[role];
    return `${role} ${binding ? `${binding.harness}:${binding.model}` : "unset"}`;
  }).join(" · ");
}

/**
 * Pure profile transition over the loaded file. IO stays in the caller so
 * the whole matrix is testable without touching the disk.
 */
export function applyProfileAction(
  config: RunAgentConfig,
  action: ProfileAction,
  rawName?: string,
): ProfileResult {
  if (action === "list") {
    const names = listProfiles(config);
    const active = config.activeProfile;
    const text = names.length === 0
      ? "No profiles saved yet."
      : names.map((name) => `${active === name ? "*" : " "} ${name}`).join("\n");
    return { config, save: false, text, payload: { active: active ?? null, profiles: names } };
  }

  const name = parseProfileName(rawName);

  if (action === "show") {
    const snapshot = getProfileSnapshot(config, name);
    if (!snapshot) {
      const available = listProfiles(config);
      throw new ProfileUsageError(
        `Unknown profile "${name}". Available: ${available.join(", ") || "none"}.`,
      );
    }
    return { config, save: false, text: serializeConfig(snapshot), payload: snapshot };
  }

  if (action === "save") {
    const snapshot = extractProfileSnapshot(resolveEffectiveConfig(config));
    const profiles = { ...(config.profiles ?? {}), [name]: snapshot };
    const next: RunAgentConfig = { ...config, profiles };
    return {
      config: next,
      save: true,
      text: `saved profile "${name}": ${agentSummary(snapshot)}`,
      payload: { name, profile: snapshot },
    };
  }

  if (action === "use") {
    if (!getProfileSnapshot(config, name)) {
      const available = listProfiles(config);
      throw new ProfileUsageError(
        `Unknown profile "${name}". Available: ${available.join(", ") || "none"}.`,
      );
    }
    if (config.activeProfile === name) {
      return { config, save: false, text: `profile "${name}" is already active.`, payload: { name } };
    }
    return {
      config: { ...config, activeProfile: name },
      save: true,
      text: `using profile "${name}"`,
      payload: { name },
    };
  }

  if (!getProfileSnapshot(config, name)) {
    const available = listProfiles(config);
    throw new ProfileUsageError(
      `Unknown profile "${name}". Available: ${available.join(", ") || "none"}.`,
    );
  }
  const profiles: Record<string, ProfileSnapshot> = { ...(config.profiles ?? {}) };
  delete profiles[name];
  const next: RunAgentConfig = { ...config, profiles };
  if (Object.keys(profiles).length === 0) delete next.profiles;
  if (next.activeProfile === name) delete next.activeProfile;
  return { config: next, save: true, text: `deleted profile "${name}"`, payload: { name } };
}

export interface ProfileCommandDependencies {
  load?: () => RunAgentConfig;
  save?: (config: RunAgentConfig) => boolean | void;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
}

export async function executeProfileAction(
  args: readonly string[],
  dependencies: ProfileCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const fail = (message: string): number => {
    stderr.write(`${message}\n`);
    return 2;
  };

  let parsed: ParsedProfileArgs;
  try {
    parsed = parseProfileArgs(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let config: RunAgentConfig;
  try {
    config = (dependencies.load ?? loadConfig)();
  } catch (error) {
    stderr.write(`Cannot read config: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let result: ProfileResult;
  try {
    result = applyProfileAction(config, parsed.action, parsed.name);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (parsed.json) {
    stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
  } else {
    stdout.write(`${result.text}\n`);
  }

  if (!result.save) return 0;
  try {
    (dependencies.save ?? saveConfig)(result.config);
  } catch (error) {
    stderr.write(`Cannot save config: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return 0;
}

export function registerProfileCommand(program: Command): void {
  const profile = program
    .command("profile")
    .description("Save and switch named agent setups");

  const run = (args: readonly string[]) => async (opts: { json?: boolean }) => {
    const tokens = [...args];
    if (opts.json) tokens.push("--json");
    process.exitCode = await executeProfileAction(tokens);
  };

  profile
    .command("list")
    .description("list saved profiles (* marks the active one)")
    .option("--json", "output JSON")
    .action(run(["list"]));

  const named: ReadonlyArray<{ action: Exclude<ProfileAction, "list">; description: string }> = [
    { action: "show", description: "print a saved profile" },
    { action: "save", description: "snapshot the current setup as a profile" },
    { action: "use", description: "make a profile the active setup" },
    { action: "delete", description: "delete a saved profile" },
  ];
  for (const { action, description } of named) {
    profile
      .command(action)
      .description(description)
      .argument("<name>", "profile name")
      .option("--json", "output JSON")
      .action(async (name: string, opts: { json?: boolean }) => {
        process.exitCode = await executeProfileAction(
          opts.json ? [action, name, "--json"] : [action, name],
        );
      });
  }
}
