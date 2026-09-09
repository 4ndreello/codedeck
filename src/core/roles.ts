import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the bundled plugin from this module, not from the caller's cwd.
 * Source files live below src/core; built files live below dist/core, and the
 * build copies the plugin into dist alongside them.
 */
export function resolvePluginDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distPlugin = path.resolve(moduleDir, "../plugin");
  const sourcePlugin = path.resolve(moduleDir, "../../plugin");
  const moduleRoot = path.resolve(moduleDir, "..");
  const candidates = path.basename(moduleRoot) === "dist"
    ? [distPlugin, sourcePlugin]
    : [sourcePlugin, distPlugin];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export const ROLES = ["general", "orchestrator", "reviewer", "auditor"] as const;
export type Role = (typeof ROLES)[number];
// Three characters is a contract, not a count of today's unique initials. A
// fifth role can make a shorter prefix ambiguous without changing this rule.
const MIN_ROLE_PREFIX_LENGTH = 3;

export function parseRole(input: string | undefined): Role | undefined {
  if (input === undefined) return undefined;
  const normalized = input.trim().toLowerCase();
  const exact = ROLES.find((role) => role === normalized);
  if (exact) return exact;
  if (normalized.length < MIN_ROLE_PREFIX_LENGTH) return undefined;

  const matches = ROLES.filter((role) => role.startsWith(normalized));
  // Multiple matches stay unresolved. Picking one would also choose its
  // harness and model, so ambiguity must not launch an unrequested session.
  if (matches.length === 1) return matches[0];
}

export function roleFile(pluginDir: string, role: Role): string {
  return path.join(pluginDir, "agents", `${role}.md`);
}

/**
 * The body of the agent file, without its frontmatter.
 *
 * Only `open` can hand a role to Claude as `--agent`, because that flag is
 * Claude's. Every other harness gets the same text as a prompt prefix, which is
 * why the frontmatter has to go: `tools:` is an allowlist Claude enforces and
 * nobody else can, so shipping it as prose would read as an instruction to
 * limit itself, which is not what it means.
 */
export function roleBody(pluginDir: string, role: Role): string {
  const raw = fs.readFileSync(roleFile(pluginDir, role), "utf8");
  // The closing delimiter may be the last bytes of the file. Requiring a
  // newline after it used to leave the whole block in the body, which is how
  // `tools:` reached a prompt as if it were prose.
  // v1 boundary: this run-path strip removes frontmatter but does not scope tools.
  // Hand-edited files can carry a leading blank line or BOM before the
  // delimiter, so strip those before the anchored match.
  const text = raw.replace(/^\uFEFF/, "").trimStart();
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

/**
 * The shared core text, byte-identical to what the open path ships.
 * Generated agent files exclude it; the run path prepends it here so every
 * `run --role` worker receives the ultra inviolables. Untrimmed like
 * readUltra: the composer owns the joining. The open path never calls this:
 * it reads ultra.md through its own separate reader and delivers it on a
 * different channel.
 */
export function readCore(pluginDir: string): string {
  const coreFile = path.join(pluginDir, "ultra.md");
  if (!fs.existsSync(coreFile)) {
    throw new Error(`CodeDeck ultra prompt not found at ${coreFile}. The CodeDeck plugin is incomplete.`);
  }
  return fs.readFileSync(coreFile, "utf8");
}

/**
 * The run-path composer: core first, then the role body, then the task.
 * Core-first is deliberate: the inviolables take precedence over role detail
 * and the shared prefix aids cache reuse across roles.
 */
export function composeRunPrompt(pluginDir: string, role: Role, prompt: string): string {
  return `${readCore(pluginDir).trimEnd()}\n\n---\n\n${roleBody(pluginDir, role)}\n\n---\n\n${prompt}`;
}

/**
 * Turns whatever `--role` carried into the prompt a worker receives.
 *
 * Throws rather than degrading. Asking for a role and silently getting a plain
 * run is the failure this repository's own system prompt calls rounding failure
 * to success: the session looks fine, costs full price, and is not the thing
 * that was asked for. An absent flag is the only case that means "no role".
 */
export function resolveRolePrompt(
  pluginDir: string,
  roleInput: string | undefined,
  prompt: string,
): string {
  if (roleInput === undefined) return prompt;

  const role = parseRole(roleInput);
  if (!role) {
    throw new Error(`Invalid role "${roleInput}". Available roles: ${ROLES.join(", ")}`);
  }

  const file = roleFile(pluginDir, role);
  if (!fs.existsSync(file)) {
    throw new Error(`Role "${role}" has no agent file at ${file}. The CodeDeck plugin is incomplete.`);
  }

  return composeRunPrompt(pluginDir, role, prompt);
}
