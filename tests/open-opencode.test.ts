import { describe, expect, it } from "vitest";

import { rolePermission } from "../src/open/launchers/opencode.js";

describe("rolePermission", () => {
  it("leaves general unrestricted", () => {
    expect(rolePermission("general")).toEqual({ "*": "allow" });
  });

  it("gives orchestrator bash and nothing else", () => {
    expect(rolePermission("orchestrator")).toEqual({
      read: "deny",
      edit: "deny",
      write: "deny",
      task: "deny",
      bash: "allow",
    });
  });

  it("denies reviewer edits and dispatch but keeps bash", () => {
    expect(rolePermission("reviewer")).toEqual({
      edit: "deny",
      write: "deny",
      task: "deny",
      bash: "allow",
    });
  });

  it("lets auditor dispatch but not edit", () => {
    expect(rolePermission("auditor")).toEqual({
      edit: "deny",
      write: "deny",
      task: "allow",
      bash: "allow",
    });
  });
});
