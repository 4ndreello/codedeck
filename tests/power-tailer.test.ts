import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTailer } from "../src/drivers/tailer.js";
import { sleep } from "../src/utils/process.js";

let dir: string;
let file: string;
let tailer: FileTailer;

function setup(): { lines: string[] } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "power-tailer-"));
  file = path.join(dir, "out.ndjson");
  const lines: string[] = [];
  tailer = new FileTailer(file, {
    pollMs: 20,
    onLine: (line) => lines.push(line),
  });
  return { lines };
}

afterEach(() => {
  tailer?.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("power shutdown tailer drain", () => {
  it("drops a trailing partial line without emitting it", async () => {
    const { lines } = setup();
    tailer.start();
    fs.writeFileSync(file, "whole\nfrag");
    await sleep(120);
    expect(lines).toEqual(["whole"]);

    tailer.drainForShutdown();

    expect(lines).toEqual(["whole"]);
    expect(tailer.consumedOffset).toBe(6);
  });

  it("drops a file holding only a partial line", async () => {
    const { lines } = setup();
    tailer.start();
    fs.writeFileSync(file, "half-written");
    await sleep(120);
    expect(lines).toEqual([]);

    tailer.drainForShutdown();

    expect(lines).toEqual([]);
  });

  it("still delivers complete lines pending at drain time", async () => {
    const { lines } = setup();
    tailer.start();
    fs.writeFileSync(file, "a\nb\n");
    await sleep(120);

    tailer.drainForShutdown();

    expect(lines).toEqual(["a", "b"]);
    expect(tailer.consumedOffset).toBe(4);
  });

  it("leaves normal flush emitting the leftover", async () => {
    const { lines } = setup();
    tailer.start();
    fs.writeFileSync(file, "whole\nfrag");
    await sleep(120);
    expect(lines).toEqual(["whole"]);

    tailer.flush();

    expect(lines).toEqual(["whole", "frag"]);
  });
});
