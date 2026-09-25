import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The dist root of a compiled module: two directories above `dist/<dir>/<file>.js`. */
export function distRootFor(moduleUrl: string): string {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

/** Newest `.js` mtime under `root`, as a decimal string; `"0"` when there is none. */
export function computeBuildId(root: string): string {
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(root);
  return String(newest);
}
