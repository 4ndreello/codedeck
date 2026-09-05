import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { FileTailer } from "../src/drivers/tailer.js";
import { sleep } from "../src/utils/process.js";
import { destroyTailer, setupTailer, type TailerHarness } from "./helpers/tailer-harness.js";

let t: TailerHarness | undefined;

afterEach(() => {
  destroyTailer(t?.dir, t?.tailer);
});

describe("FileTailer", () => {
  it("delivers lines appended after start, advancing the offset", async () => {
    let { lines, file, tailer } = (t = setupTailer("tailer-"));
    fs.writeFileSync(file, "a\nb\n");
    tailer.start();
    await sleep(150);
    expect(lines).toEqual(["a", "b"]);
    expect(tailer.consumedOffset).toBe(4); // 2 + 2 bytes
  });

  it("starts from a persisted offset and does not replay consumed bytes", async () => {
    let { file, tailer } = (t = setupTailer("tailer-"));
    fs.writeFileSync(file, "old\n");
    const size = fs.statSync(file).size;
    const consumed: string[] = [];
    tailer = new FileTailer(file, { startOffset: size, pollMs: 20, onLine: (l) => consumed.push(l) });
    tailer.start();
    fs.appendFileSync(file, "new\n");
    await sleep(150);
    expect(consumed).toEqual(["new"]);
    expect(tailer.consumedOffset).toBe(size + 4);
  });

  it("holds a partial line back until the newline arrives", async () => {
    let { lines, file, tailer } = (t = setupTailer("tailer-"));
    tailer.start();
    fs.writeFileSync(file, "par");
    await sleep(120);
    expect(lines).toEqual([]);
    fs.appendFileSync(file, "tial\nnext\n");
    await sleep(120);
    expect(lines).toEqual(["partial", "next"]);
    expect(tailer.consumedOffset).toBe(13); // "partial\n" + "next\n"
  });

  it("flush emits the trailing partial line when the writer is gone", async () => {
    let { lines, file, tailer } = (t = setupTailer("tailer-"));
    tailer.start();
    fs.writeFileSync(file, "whole\nfrag");
    await sleep(120);
    expect(lines).toEqual(["whole"]);
    tailer.flush();
    expect(lines).toEqual(["whole", "frag"]);
    expect(tailer.consumedOffset).toBe(10);
  });
  it("resets when the file is truncated below the offset", async () => {
    let { lines, file, tailer } = (t = setupTailer("tailer-"));
    tailer.start();
    fs.writeFileSync(file, "first\n");
    await sleep(120);
    expect(lines).toEqual(["first"]);
    // Rewrite SHORTER than before — a true truncation (size < readOffset).
    fs.writeFileSync(file, "2\n");
    await sleep(120);
    expect(lines).toEqual(["first", "2"]);
    expect(tailer.consumedOffset).toBe(2);
  });

  it("tolerates a file that does not exist yet", async () => {
    let { lines, file, tailer } = (t = setupTailer("tailer-"));
    tailer.start(); // no file yet — must not throw
    await sleep(60);
    fs.writeFileSync(file, "late\n");
    await sleep(120);
    expect(lines).toEqual(["late"]);
  });
});
