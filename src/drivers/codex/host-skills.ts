import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function discoverCodexHostSkills(opts: { codexHome?: string; homeDir?: string } = {}): string[] {
  const codexHome = opts.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const homeDir = opts.homeDir ?? os.homedir();
  const roots = [
    path.resolve(codexHome, "skills"),
    path.resolve(homeDir, ".agents", "skills"),
  ];
  const skillPaths = new Set<string>();
  const visitedDirectories = new Set<string>();

  const visit = (directory: string) => {
    let realDirectory: string;
    try {
      if (!fs.statSync(directory).isDirectory()) return;
      realDirectory = fs.realpathSync(directory);
    } catch {
      return;
    }

    if (visitedDirectories.has(realDirectory)) return;
    visitedDirectories.add(realDirectory);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(entryPath);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) visit(entryPath);
      else if (isFile && entry.name === "SKILL.md") skillPaths.add(entryPath);
    }
  };

  for (const root of roots) visit(root);
  return [...skillPaths].sort((a, b) => a.localeCompare(b));
}
