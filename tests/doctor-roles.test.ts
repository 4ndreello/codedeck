import { describe, expect, it } from "vitest";
import { renderRolesSection, resolveRoleReadiness } from "../src/cli/commands/doctor.js";
import { ROLES } from "../src/core/roles.js";

const strip = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("doctor roles section", () => {
  it("reports every role, bound or not", () => {
    const rows = resolveRoleReadiness({
      defaultAgent: "claude",
      agents: { auditor: { harness: "opencode", model: "meta/muse" } },
    });

    expect(rows.map((row) => row.role)).toEqual([...ROLES]);
    expect(rows.find((row) => row.role === "auditor")).toEqual({
      role: "auditor",
      harness: "opencode",
      model: "meta/muse",
      fallback: "claude",
    });
    expect(rows.find((row) => row.role === "reviewer")).toEqual({
      role: "reviewer",
      fallback: "claude",
    });
  });

  // A half-written entry is already rejected by resolveRoleBinding, and doctor
  // has to agree with it: reporting a harness the run would not use is worse
  // than reporting none.
  it("treats a half-written binding as unbound, the way run does", () => {
    const rows = resolveRoleReadiness({
      agents: {
        general: { harness: "wat" as never, model: "m" },
        reviewer: { harness: "codex", model: "  " },
      },
    });

    expect(rows.find((row) => row.role === "general")?.harness).toBeUndefined();
    expect(rows.find((row) => row.role === "reviewer")?.harness).toBeUndefined();
  });

  it("falls back to claude when no default agent is configured", () => {
    expect(resolveRoleReadiness({}).every((row) => row.fallback === "claude")).toBe(true);
    expect(
      resolveRoleReadiness({ defaultAgent: "codex" }).every((row) => row.fallback === "codex"),
    ).toBe(true);
  });

  // The whole point of the section is that an unbound role is visibly a
  // problem: it is what let an auditor bound to opencode run on claude with
  // nothing on screen to say so.
  it("names where an unbound role actually lands", () => {
    const lines = strip(
      renderRolesSection(
        resolveRoleReadiness({
          defaultAgent: "claude",
          agents: { orchestrator: { harness: "claude", model: "claude-opus-4-8" } },
        }),
      ),
    ).split("\n");

    expect(lines[0]).toBe("Roles");
    expect(lines.find((line) => line.includes("orchestrator"))).toContain(
      "✓ claude / claude-opus-4-8",
    );
    expect(lines.find((line) => line.includes("auditor"))).toContain("✗ unbound, runs on claude");
  });
});
