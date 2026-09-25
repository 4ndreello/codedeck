import fs from "node:fs";
import path from "node:path";

export interface RunSkill {
  name: string;
  description: string;
  path: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) return undefined;
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  return trimmed.replace(/\s+#.*$/, "").trimEnd();
}

function parseSkillFrontmatter(source: string): Pick<RunSkill, "name" | "description"> | undefined {
  const match = FRONTMATTER.exec(source);
  if (!match) return undefined;

  let name: string | undefined;
  let description: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):(?:\s*(.*))?$/.exec(line);
    if (!field) continue;
    const value = parseScalar(field[2] ?? "");
    if (field[1] === "name") name = value;
    else description = value;
  }

  if (!name) return undefined;
  return { name, description: description ?? "" };
}

export function readRunSkills(pluginDir: string): RunSkill[] {
  const skillsDir = path.join(pluginDir, "skills");
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }

  const skills: RunSkill[] = [];
  for (const entry of entries) {
    const skillPath = path.resolve(skillsDir, entry, "SKILL.md");
    try {
      if (!fs.statSync(skillPath).isFile()) continue;
      const parsed = parseSkillFrontmatter(fs.readFileSync(skillPath, "utf8"));
      if (!parsed) continue;
      skills.push({ ...parsed, path: skillPath });
    } catch {
      // One malformed or unreadable skill must not prevent a run prompt.
    }
  }

  return skills.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export function composeRunSection(pluginDir: string): string {
  const lines = [
    "## Run instructions",
    "This worker runs non-interactively in the background.",
    "Nobody answers approval, direction, or confirmation questions during this run.",
    "When a skill or habit says to ask before implementing, make the reasonable call, record the assumption in the final report, and deliver.",
    "Report a real blocker, such as a missing credential, a change outside the owned files, or a stop condition in the briefing, then stop. Follow the briefing's stop conditions.",
  ];

  const skills = readRunSkills(pluginDir);
  if (skills.length === 0) return lines.join("\n");

  lines.push(
    "",
    "## CodeDeck skills",
    "When the prompt asks for a skill by one of these names, read its `SKILL.md` and follow it. Resolve relative references against that file's directory.",
  );
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description}`, `  ${skill.path}`);
  }
  return lines.join("\n");
}
