import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");

function readDocument(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("web host documentation", () => {
  it("documents web.host, the UI override, the child argument, and web.ensure in README", () => {
    const readme = readDocument("README.md");

    expect(readme).toContain("`web.host`");
    expect(readme).toContain("`codedeck ui --host <addr>`");
    expect(readme).toContain("`--host <addr>`");
    expect(readme).toContain("`web.ensure`");
    expect(readme).toContain("`host`");
  });

  it("documents the host parameter in Portuguese in the protocol section", () => {
    const protocol = readDocument("docs/protocol.md");

    expect(protocol).toContain("`host` (opcional)");
    expect(protocol).toContain("endereço IP");
    expect(protocol).toContain("`web.host`");
    expect(protocol).toContain("`--host <addr>`");
    expect(protocol).toContain("`127.0.0.1`");
  });
});
