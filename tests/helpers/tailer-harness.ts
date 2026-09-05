// Shared FileTailer harness for tailer tests: one setup shape so the
// per-feature files don't repeat the same block (Sonar duplication gate).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTailer } from "../../src/drivers/tailer.js";

export interface TailerHarness {
  dir: string;
  file: string;
  lines: string[];
  tailer: FileTailer;
}

export function setupTailer(prefix: string): TailerHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "out.ndjson");
  const lines: string[] = [];
  const tailer = new FileTailer(file, {
    pollMs: 20,
    onLine: (line) => lines.push(line),
  });
  return { dir, file, lines, tailer };
}

export function destroyTailer(dir: string | undefined, tailer: FileTailer | undefined): void {
  try {
    tailer?.stop();
  } catch {}
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
