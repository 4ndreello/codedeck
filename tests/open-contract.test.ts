import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  effectiveModel,
  resolveOpenModel,
  resolveRoleContract,
} from "../src/open/contract.js";
import { resolvePluginDir } from "../src/core/roles.js";

const pluginDir = resolvePluginDir();

describe("resolveRoleContract", () => {
  it("returns the agent body without frontmatter plus the ultra text", () => {
    const { agentBody, ultra } = resolveRoleContract(pluginDir, "reviewer");

    expect(agentBody).toContain("CodeDeck reviewer");
    expect(agentBody).not.toContain("tools:");
    expect(ultra).toContain("Never round failure to success");
  });

  it("fails loud when the agent file is missing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-contract-"));
    try {
      expect(() => resolveRoleContract(empty, "reviewer")).toThrow(/no agent file/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails loud when ultra.md is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-contract-"));
    try {
      fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
      fs.copyFileSync(
        path.join(pluginDir, "agents", "reviewer.md"),
        path.join(dir, "agents", "reviewer.md"),
      );
      expect(() => resolveRoleContract(dir, "reviewer")).toThrow(/ultra prompt not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOpenModel", () => {
  it("lets an explicit flag win over the binding", () => {
    const config = { agents: { reviewer: { harness: "opencode", model: "prov/bound" } } } as any;

    expect(resolveOpenModel("reviewer", { model: "prov/flag" }, config)).toEqual({
      model: "prov/flag",
      fromConfig: false,
    });
  });

  it("uses the binding model and marks it from config", () => {
    const config = { agents: { reviewer: { harness: "opencode", model: "prov/bound" } } } as any;

    expect(resolveOpenModel("reviewer", {}, config)).toEqual({
      model: "prov/bound",
      fromConfig: true,
    });
  });

  it("falls back to the harness config model", () => {
    const config = { models: { claude: "claude-sonnet" } } as any;

    expect(resolveOpenModel("general", {}, config)).toEqual({
      model: "claude-sonnet",
      fromConfig: true,
    });
  });

  it("leaves the model undefined for the launcher default", () => {
    expect(resolveOpenModel("general", {}, {})).toEqual({ model: undefined, fromConfig: false });
  });
});

describe("effectiveModel", () => {
  it("reads the last --model when both spellings are present", () => {
    expect(effectiveModel(["--model", "bad", "--model=good"])).toBe("good");
  });

  it("returns undefined when the passthrough carries no model", () => {
    expect(effectiveModel(["--add-dir", "other"])).toBeUndefined();
  });
});
