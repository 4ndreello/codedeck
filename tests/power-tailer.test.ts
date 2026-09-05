import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { sleep } from "../src/utils/process.js";
import { destroyTailer, setupTailer, type TailerHarness } from "./helpers/tailer-harness.js";

let t: TailerHarness | undefined;

afterEach(() => {
  destroyTailer(t?.dir, t?.tailer);
});

describe("power shutdown tailer drain", () => {
  it("drops a trailing partial line without emitting it", async () => {
    const { lines, file, tailer } = (t = setupTailer("power-tailer-"));
    tailer.start();
    fs.writeFileSync(file, "whole\nfrag");
    await sleep(120);
    expect(lines).toEqual(["whole"]);

    tailer.drainForShutdown();

    expect(lines).toEqual(["whole"]);
    expect(tailer.consumedOffset).toBe(6);
  });

  it("drops a file holding only a partial line", async () => {
    const { lines, file, tailer } = (t = setupTailer("power-tailer-"));
    tailer.start();
    fs.writeFileSync(file, "half-written");
    await sleep(120);
    expect(lines).toEqual([]);

    tailer.drainForShutdown();

    expect(lines).toEqual([]);
  });

  it("still delivers complete lines pending at drain time", async () => {
    const { lines, file, tailer } = (t = setupTailer("power-tailer-"));
    tailer.start();
    fs.writeFileSync(file, "a\nb\n");
    await sleep(120);

    tailer.drainForShutdown();

    expect(lines).toEqual(["a", "b"]);
    expect(tailer.consumedOffset).toBe(4);
  });

  it("leaves normal flush emitting the leftover", async () => {
    const { lines, file, tailer } = (t = setupTailer("power-tailer-"));
    tailer.start();
    fs.writeFileSync(file, "whole\nfrag");
    await sleep(120);
    expect(lines).toEqual(["whole"]);

    tailer.flush();

    expect(lines).toEqual(["whole", "frag"]);
  });
});
