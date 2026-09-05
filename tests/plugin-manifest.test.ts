import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = (...parts: string[]) => join(root, "plugin", ...parts);

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const readText = (path: string) => readFileSync(path, "utf8");

const frontmatter = (path: string) => {
  const match = readText(path).match(/^---\n([\s\S]*?)\n---/);
  expect(match, `${path} must have YAML frontmatter`).not.toBeNull();
  return match?.[1] ?? "";
};

const field = (source: string, name: string) =>
  source.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1] ?? "";

describe("CodeDeck plugin manifest contract", () => {
  it("pins the plugin identity and experimental theme directory", () => {
    const manifest = readJson(plugin(".claude-plugin", "plugin.json"));

    expect(manifest.name).toBe("codedeck");
    expect(manifest.version).toEqual(expect.any(String));
    expect(manifest.description).toEqual(expect.any(String));
    expect(manifest.author).toEqual(expect.objectContaining({ name: expect.any(String) }));
    expect(manifest.experimental?.themes).toBe("./themes");
  });

  it("pins the namespaced theme reference and statusline path", () => {
    const settings = readJson(plugin("settings.json"));
    const theme = readJson(plugin("themes", "codedeck-ultra.json"));

    expect(settings.theme).toBe("custom:codedeck:codedeck-ultra");
    expect(settings.statusLine).toMatchObject({ type: "command" });
    expect(settings.statusLine.command).toContain("statusline.sh");
    expect(theme.base).toBe("dark");
    expect(theme.overrides).toEqual(expect.objectContaining({
      promptBorder: expect.any(String),
      promptBorderShimmer: expect.any(String),
    }));
  });

  // The slug in the theme ref is the FILE BASENAME, not the theme's `name`
  // field: `zzz-alpha.json` named "Bravo Theme" answers to zzz-alpha and
  // ignores bravo-theme. Getting this wrong costs the whole visual identity
  // with no error anywhere, not even under --debug, so the ref is derived
  // from the filesystem here instead of being compared to a second literal.
  it("resolves the theme ref to a file that actually exists", () => {
    const settings = readJson(plugin("settings.json"));
    const [prefix, pluginName, slug] = String(settings.theme).split(":");
    const manifest = readJson(plugin(".claude-plugin", "plugin.json"));

    expect(prefix).toBe("custom");
    expect(pluginName).toBe(manifest.name);

    const themeFiles = readdirSync(plugin("themes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));

    expect(themeFiles).toContain(slug);
  });

  it("pins tool restrictions for both role agents", () => {
    const reviewerTools = field(frontmatter(plugin("agents", "reviewer.md")), "tools");
    const orchestratorTools = field(frontmatter(plugin("agents", "orchestrator.md")), "tools");

    expect(reviewerTools).not.toMatch(/\b(Edit|Write|Bash)\b/);
    expect(orchestratorTools).not.toMatch(/\b(Edit|Write)\b/);
    expect(orchestratorTools).toMatch(/\bBash\b/);
  });

  it("pins the system prompt and orchestration boundaries", () => {
    const ultra = readText(plugin("ultra.md"));
    const orchestrator = readText(plugin("agents", "orchestrator.md"));
    const statusline = readText(plugin("statusline.sh"));

    expect(ultra).toMatch(/delegation with proof/i);
    expect(ultra).toMatch(/never round failure to success/i);
    expect(orchestrator).toContain("codedeck run --worktree");
    expect(orchestrator).toContain("codedeck diff <session>");
    expect(orchestrator).toContain("codedeck stop <session>");
    expect(orchestrator).toMatch(/without the CodeDeck setup/i);
    expect(statusline).toContain("JSON.parse");
    expect(statusline).toContain("git");
  });
});
