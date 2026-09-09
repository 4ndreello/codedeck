// Copies plugin/ into dist/ so the launcher can find it in an installed
// package. Node rather than `rm -rf && cp -r`, which npm runs through cmd on
// Windows, where neither exists and the build fails before it copies anything.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const target = join(root, "dist", "plugin");

// ---------------------------------------------------------------------------
// Prompt layers: plugin/agents/*.md are generated from
// plugin/prompts/roles/<role>.md manifests plus plugin/prompts/_partials.
// Hand-edit the manifest or a partial, never the generated file.
// ---------------------------------------------------------------------------

const PROMPTS = join(root, "plugin", "prompts");
const PARTIALS = join(PROMPTS, "_partials");
const MANIFESTS = join(PROMPTS, "roles");
const AGENTS = join(root, "plugin", "agents");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function splitFrontmatter(source, where) {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error(`${where} has no YAML frontmatter`);
  return { front: match[1], body: source.slice(match[0].length).trim() };
}

// Minimal frontmatter reader for the controlled manifest shape: scalar
// name/description/tools plus an `includes:` list. No YAML dependency.
function parseManifest(source, manifestPath) {
  const { front, body } = splitFrontmatter(source, manifestPath);
  let name;
  let description;
  let tools;
  const includes = [];
  let inIncludes = false;
  for (const line of front.split(/\r?\n/)) {
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (inIncludes && item) {
      includes.push(item[1]);
      continue;
    }
    const key = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!key) {
      inIncludes = false;
      continue;
    }
    inIncludes = key[1] === "includes";
    if (key[1] === "name") name = key[2].trim();
    else if (key[1] === "description") description = key[2].trim();
    else if (key[1] === "tools") tools = key[2].trim();
  }
  if (!name) throw new Error(`${manifestPath} frontmatter needs a name`);
  if (!description) throw new Error(`${manifestPath} frontmatter needs a description`);
  return { name, description, tools, includes, body };
}

function readPartial(manifestPath, entry) {
  const file = join(PARTIALS, `${entry}.md`);
  if (!existsSync(file)) {
    throw new Error(`${manifestPath} includes unknown partial "${entry}" (no ${file})`);
  }
  return readFileSync(file, "utf8").trim();
}

// proof.md holds both proof sentences, but the reviewer never spawns workers,
// so it composes only the verify sentence and must not gain the run-worker
// diff sentence. Every other role takes proof whole.
function resolvePartial(manifestPath, role, entry) {
  const text = readPartial(manifestPath, entry);
  if (entry === "proof" && role === "reviewer") {
    const scoped = text
      .split(/\r?\n/)
      .filter((line) => !line.includes("before believing any worker"))
      .join("\n")
      .trim();
    if (!scoped.includes("Verify before you claim.")) {
      throw new Error(`${manifestPath}: reviewer proof scoping dropped the verify sentence`);
    }
    return scoped;
  }
  return text;
}

function generateAgents() {
  mkdirSync(AGENTS, { recursive: true });
  for (const file of readdirSync(MANIFESTS).filter((f) => f.endsWith(".md")).sort()) {
    const role = file.replace(/\.md$/, "");
    const manifestPath = join(MANIFESTS, file);
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    if (manifest.name !== role) {
      throw new Error(`${manifestPath} names role "${manifest.name}" but the file is ${file}`);
    }
    const sections = manifest.includes.map((entry) => resolvePartial(manifestPath, role, entry));
    sections.push(manifest.body);
    const lines = [
      "---",
      `# DO NOT EDIT: generated from roles/${role}.md + partials (${manifest.includes.join(", ")}).`,
      "# Do not hand-edit; edit the manifest or partials and rebuild.",
      `name: ${manifest.name}`,
      `description: ${manifest.description}`,
    ];
    if (manifest.tools) lines.push(`tools: ${manifest.tools}`);
    lines.push("---", "", sections.join("\n\n") + "\n");
    writeFileSync(join(AGENTS, `${role}.md`), lines.join("\n"));
  }
}

generateAgents();

rmSync(target, { recursive: true, force: true });
cpSync(join(root, "plugin"), target, { recursive: true });
