import { describe, it, expect } from "vitest";
import { getRegistry } from "../src/drivers/registry.js";

describe("capabilities", () => {
  it("each driver declares streaming and interrupt", async () => {
    const reg = getRegistry();
    for (const d of reg.list()) {
      const caps = d.capabilities();
      expect(typeof caps.streaming).toBe("boolean");
      expect(typeof caps.resume).toBe("boolean");
      expect(typeof caps.interrupt).toBe("boolean");
      expect(typeof caps.modelSelection).toBe("boolean");
    }
  });

  it("detectAll returns 4 agents", async () => {
    const reg = getRegistry();
    const all = await reg.detectAll();
    expect(Object.keys(all)).toContain("claude");
    expect(Object.keys(all)).toContain("codex");
    expect(Object.keys(all)).toContain("opencode");
    expect(Object.keys(all)).toContain("omp");
    for (const v of Object.values(all)) {
      expect(typeof v.installed).toBe("boolean");
    }
  });

  it("claude supports resume and cost", () => {
    const reg = getRegistry();
    const c = reg.get("claude").capabilities();
    expect(c.resume).toBe(true);
    expect(c.cost).toBe(true);
    expect(c.streaming).toBe(true);
  });
});
