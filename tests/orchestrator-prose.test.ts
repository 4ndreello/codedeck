import { describe, expect, it } from "vitest";

import { composeOrchestratorProse } from "../src/open/orchestrator-prose.js";
import type { OrchestratorMode } from "../src/config/orchestrator-mode.js";

const mode = (overrides: Partial<OrchestratorMode> = {}): OrchestratorMode => ({
  investigate: "none",
  selfWork: "none",
  tools: "dispatch",
  ...overrides,
});

describe("composeOrchestratorProse", () => {
  it("returns no prose for the dispatcher mode", () => {
    expect(composeOrchestratorProse(mode())).toBe("");
  });

  it("states the resolved investigation and self-work allowances", () => {
    const prose = composeOrchestratorProse(
      mode({ investigate: "read", selfWork: "trivial", tools: "edit" }),
    );

    expect(prose).toMatch(/investigation.*read/i);
    expect(prose).toMatch(/self-work.*trivial/i);
  });

  it("states none for the remaining allowance when only one is enabled", () => {
    const prose = composeOrchestratorProse(mode({ investigate: "free" }));

    expect(prose).toMatch(/investigation.*free/i);
    expect(prose).toMatch(/self-work.*none/i);
  });

  it("returns only the advisory cap for a parallelism-only mode", () => {
    const lines = composeOrchestratorProse(mode({ parallelism: 3 })).split("\n");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/run at most 3 workers concurrently/i);
  });

  it("appends the cap after both allowance statements", () => {
    const lines = composeOrchestratorProse(
      mode({ investigate: "read", selfWork: "trivial", parallelism: 2 }),
    ).split("\n");

    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/run at most 2 workers concurrently/i);
  });
});
