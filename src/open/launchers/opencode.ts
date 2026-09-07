import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary } from "../../drivers/helpers.js";
import { getRegistry } from "../../drivers/registry.js";
import { getCachedOrDiscoverModels } from "../../core/models.js";
import {
  catalogWarning,
  judgeModelIn,
  resolveRoleContract,
  type OpenFlags,
} from "../contract.js";
import { DISPATCHER_PRESET, type OrchestratorMode } from "../../config/orchestrator-mode.js";
import type { Role } from "../../core/roles.js";
import { composeOrchestratorProse } from "../orchestrator-prose.js";

export type PermissionValue = "allow" | "ask" | "deny";

/**
 * Claude `tools:` becomes opencode `permission:`. Every key below was
 * resolved live through `opencode debug agent`: `edit: deny` turns off edit
 * and write, `read: deny` turns off read with bash intact, `task: deny`
 * turns off dispatch, and `"*": "allow"` turns everything on. No role leans
 * on user defaults, so `general` stays unrestricted and the restricted three
 * stay restricted whatever the user configured globally.
 */
export function rolePermission(
  role: Role,
  mode: OrchestratorMode = DISPATCHER_PRESET,
): Record<string, PermissionValue> {
  switch (role) {
    case "general":
      return { "*": "allow" };
    case "orchestrator":
      switch (mode.tools) {
        case "dispatch":
          return { read: "deny", edit: "deny", write: "deny", task: "deny", bash: "allow" };
        case "read":
          return { read: "allow", edit: "deny", write: "deny", task: "deny", bash: "allow" };
        case "edit":
          return { read: "allow", edit: "allow", write: "allow", task: "deny", bash: "allow" };
      }
    case "reviewer":
      return { edit: "deny", write: "deny", task: "deny", bash: "allow" };
    case "auditor":
      return { edit: "deny", write: "deny", task: "allow", bash: "allow" };
  }
}

export function agentName(role: Role): string {
  return `codedeck-${role}`;
}

const AUTONOMOUS_COMMAND = "autonomous";

/**
 * The /autonomous slash command for opencode, read from the same file
 * Claude serves via --plugin-dir. Body means the md minus frontmatter,
 * the same strip rule resolveRoleContract applies to agent files, so
 * the contract text stays identical on both harnesses.
 */
export function autonomousCommand(pluginDir: string): { template: string; description: string } {
  const raw = fs.readFileSync(path.join(pluginDir, "commands", `${AUTONOMOUS_COMMAND}.md`), "utf8");
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw);
  const frontmatter = match ? match[0] : "";
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ??
    "Continue this autonomous orchestrator session";
  return {
    template: (match ? raw.slice(match[0].length) : raw).trim(),
    description,
  };
}

/**
 * The whole opencode contract as one `OPENCODE_CONFIG_CONTENT` value: global
 * instructions from ultra plus the role agent carrying its prompt and
 * permission map. Pure and file-free: nothing lands in `~/.config/opencode`
 * or tmp, so there is nothing to clean up and concurrent opens share nothing.
 */
export function buildInlineConfig(
  pluginDir: string,
  role: Role,
  mode: OrchestratorMode = DISPATCHER_PRESET,
): string {
  const { agentBody, ultra } = resolveRoleContract(pluginDir, role);
  const orchestratorProse = role === "orchestrator" ? composeOrchestratorProse(mode) : "";
  return JSON.stringify({
    instructions: [ultra],
    agent: {
      [agentName(role)]: {
        mode: "primary",
        description: `CodeDeck ${role}`,
        prompt: orchestratorProse ? `${agentBody}\n\n${orchestratorProse}` : agentBody,
        permission: rolePermission(role, mode),
      },
    },
    command: {
      [AUTONOMOUS_COMMAND]: autonomousCommand(pluginDir),
    },
  });
}

const MODEL_SHAPE = /^[^/\s]+\/[^/\s]+$/;

export function buildArgs(
  role: Role,
  flags: OpenFlags & { model: string },
  passthrough: string[],
): string[] {
  if (!MODEL_SHAPE.test(flags.model)) {
    throw new Error(
      `Model "${flags.model}" must be provider/model for opencode (e.g. anthropic/claude-sonnet-4-6).`,
    );
  }
  return [
    "--agent",
    agentName(role),
    "--model",
    flags.model,
    // --auto mirrors the claude bypass default; --no-bypass drops it. Effort
    // has no opencode equivalent in this scope and stays unmapped.
    ...(flags.bypass !== false ? ["--auto"] : []),
    ...(flags.resume ? ["--session", flags.resume] : []),
    ...passthrough,
  ];
}

export const OPENCODE_NOT_FOUND =
  "Opencode was not found on PATH. Install opencode and ensure `opencode` is available.";

/**
 * The opencode half of the CodeDeck look. The name answers to the theme file
 * basename: `codedeck-rage.json` selected as `codedeck-rage`, the same rule
 * the Claude side pins for its own slug.
 */
export const OPENCODE_THEME_NAME = "codedeck-rage";
const OPENCODE_THEME_FILE = `${OPENCODE_THEME_NAME}.json`;

/**
 * Where opencode discovers custom theme files. Project directories come
 * first at runtime, but a launch must not write into the user's checkout,
 * so the managed copy lives here, next to the user's own themes.
 */
export function userThemesDir(
  home: string = os.homedir(),
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
): string {
  const configHome = xdgConfigHome && xdgConfigHome.length > 0
    ? xdgConfigHome
    : path.join(home, ".config");
  return path.join(configHome, "opencode", "themes");
}

/** The per-session TUI selection, as an ephemeral config dir understands it. */
export function buildTuiConfig(): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/tui.json",
    theme: OPENCODE_THEME_NAME,
  });
}

/**
 * Installs the managed theme file when it is missing or stale. Returns
 * whether the theme can be selected: a read-only home or a broken plugin
 * directory falls back to the user's own theme instead of failing the launch.
 */
export function ensureOpencodeTheme(
  pluginDir: string,
  themesDir: string = userThemesDir(),
): boolean {
  try {
    const wanted = fs.readFileSync(path.join(pluginDir, "themes", OPENCODE_THEME_FILE), "utf8");
    const target = path.join(themesDir, OPENCODE_THEME_FILE);
    let current: string | undefined;
    try {
      current = fs.readFileSync(target, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== wanted) {
      fs.mkdirSync(themesDir, { recursive: true });
      fs.writeFileSync(target, wanted);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A config dir holding only the TUI selection. The main contract still
 * travels through OPENCODE_CONFIG_CONTENT, which merges with every config
 * dir, so this stays a one-file directory with nothing to drift.
 */
export function createEphemeralTuiDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-opencode-"));
  fs.writeFileSync(path.join(dir, "tui.json"), buildTuiConfig());
  return dir;
}

export function removeEphemeralTuiDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Returns the resolved path rather than a boolean so everything downstream
 * launches the exact binary that was checked.
 */
export async function resolveBinary(): Promise<string> {
  const installation = await detectBinary("opencode");
  if (!installation.installed || !installation.path) {
    throw new Error(OPENCODE_NOT_FOUND);
  }
  return installation.path;
}

export async function preflight(model: string, fromConfig: boolean): Promise<void> {
  let catalogs;
  try {
    catalogs = await getCachedOrDiscoverModels(getRegistry(), { agent: "opencode" });
  } catch (error) {
    // A catalog that cannot be reached is not evidence against the model, so
    // this warns and lets the launch decide.
    const text = error instanceof Error ? error.message : String(error);
    console.warn(catalogWarning("opencode", model, `unavailable (${text})`));
    return;
  }

  const verdict = judgeModelIn(
    catalogs?.find((item) => item.agent === "opencode"),
    model,
    fromConfig,
    "opencode",
  );
  if (verdict.kind === "ok") return;
  if (verdict.kind === "unknown-catalog") {
    console.warn(verdict.warning);
    return;
  }
  throw new Error(verdict.error);
}
