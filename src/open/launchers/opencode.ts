import { detectBinary } from "../../drivers/helpers.js";
import { getRegistry } from "../../drivers/registry.js";
import { getCachedOrDiscoverModels } from "../../core/models.js";
import {
  catalogWarning,
  judgeModelIn,
  resolveRoleContract,
  type OpenFlags,
} from "../contract.js";
import type { Role } from "../../core/roles.js";

export type PermissionValue = "allow" | "ask" | "deny";

/**
 * Claude `tools:` becomes opencode `permission:`. Every key below was
 * resolved live through `opencode debug agent`: `edit: deny` turns off edit
 * and write, `read: deny` turns off read with bash intact, `task: deny`
 * turns off dispatch, and `"*": "allow"` turns everything on. No role leans
 * on user defaults, so `general` stays unrestricted and the restricted three
 * stay restricted whatever the user configured globally.
 */
export function rolePermission(role: Role): Record<string, PermissionValue> {
  switch (role) {
    case "general":
      return { "*": "allow" };
    case "orchestrator":
      return { read: "deny", edit: "deny", write: "deny", task: "deny", bash: "allow" };
    case "reviewer":
      return { edit: "deny", write: "deny", task: "deny", bash: "allow" };
    case "auditor":
      return { edit: "deny", write: "deny", task: "allow", bash: "allow" };
  }
}

export function agentName(role: Role): string {
  return `codedeck-${role}`;
}

/**
 * The whole opencode contract as one `OPENCODE_CONFIG_CONTENT` value: global
 * instructions from ultra plus the role agent carrying its prompt and
 * permission map. Pure and file-free: nothing lands in `~/.config/opencode`
 * or tmp, so there is nothing to clean up and concurrent opens share nothing.
 */
export function buildInlineConfig(pluginDir: string, role: Role): string {
  const { agentBody, ultra } = resolveRoleContract(pluginDir, role);
  return JSON.stringify({
    instructions: [ultra],
    agent: {
      [agentName(role)]: {
        mode: "primary",
        description: `CodeDeck ${role}`,
        prompt: agentBody,
        permission: rolePermission(role),
      },
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

const OPENCODE_NOT_FOUND =
  "Opencode was not found on PATH. Install opencode and ensure `opencode` is available.";

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
