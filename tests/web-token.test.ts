import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWebToken } from "../src/web/web-token.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "0123456789abcdef".repeat(4);
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-web-token-"));
  dirs.push(dir);
  return dir;
}

const tokenFile = (dir: string) => path.join(dir, "web-token");
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveWebToken", () => {
  it.each([
    ["without a trailing newline", TOKEN_A],
    ["with a trailing newline", `${TOKEN_A}\n`],
  ])("returns a valid stored token %s unchanged", (_label, content) => {
    const dir = tempDir();
    fs.writeFileSync(tokenFile(dir), content, { mode: 0o600 });

    expect(resolveWebToken({ dir })).toBe(TOKEN_A);
    expect(fs.readFileSync(tokenFile(dir), "utf8")).toBe(content);
  });

  it("creates a 64-character hex token with mode 0600 when the file is missing, leaving no temp file", () => {
    const dir = tempDir();

    const token = resolveWebToken({ dir });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(tokenFile(dir), "utf8").trim()).toBe(token);
    expect(modeOf(tokenFile(dir))).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["web-token"]);
    expect(resolveWebToken({ dir })).toBe(token);
  });

  it.each([
    ["too short", "abc123"],
    ["uppercase", "A".repeat(64)],
    ["extra text", `${TOKEN_A} extra`],
    ["empty", ""],
  ])("replaces a malformed file (%s) and returns the token the file holds", (_label, content) => {
    const dir = tempDir();
    fs.writeFileSync(tokenFile(dir), content, { mode: 0o600 });

    const token = resolveWebToken({ dir });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(tokenFile(dir), "utf8").trim()).toBe(token);
    expect(modeOf(tokenFile(dir))).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["web-token"]);
  });

  it("serves the token another process published between its temp write and its link", () => {
    const dir = tempDir();
    const link = (existing: string, target: string) => {
      fs.writeFileSync(target, `${TOKEN_B}\n`, { mode: 0o600 });
      fs.linkSync(existing, target);
    };

    const token = resolveWebToken({ dir, link });

    expect(token).toBe(TOKEN_B);
    expect(fs.readFileSync(tokenFile(dir), "utf8").trim()).toBe(TOKEN_B);
    expect(fs.readdirSync(dir)).toEqual(["web-token"]);
  });

  it("tightens a group- or world-readable token file to 0600 and keeps the token", () => {
    const dir = tempDir();
    fs.writeFileSync(tokenFile(dir), TOKEN_A);
    fs.chmodSync(tokenFile(dir), 0o644);

    expect(resolveWebToken({ dir })).toBe(TOKEN_A);
    expect(modeOf(tokenFile(dir))).toBe(0o600);
  });
});
