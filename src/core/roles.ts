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

export function parseRole(input: string | undefined): Role | undefined {
  if (input === undefined) return undefined;
  const normalized = input.trim().toLowerCase();
  return (ROLES as readonly string[]).includes(normalized)
    ? (normalized as Role)
    : undefined;
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
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  return (match ? raw.slice(match[0].length) : raw).trim();
}

/**
 * Prefixes a prompt with its role. Returns the prompt untouched when the role
 * has no file, so a plugin directory that shipped without one degrades to a
 * plain run instead of failing the session.
 */
export function composeRolePrompt(
  pluginDir: string,
  role: Role | undefined,
  prompt: string,
): string {
  if (!role || !fs.existsSync(roleFile(pluginDir, role))) return prompt;
  return `${roleBody(pluginDir, role)}\n\n---\n\n${prompt}`;
}
