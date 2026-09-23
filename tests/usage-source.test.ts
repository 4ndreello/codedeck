import { describe, expect, it } from "vitest";
import { openSourceKey, workerSourceKey } from "../src/core/usage-source.js";

describe("usage source keys", () => {
  it("keeps Claude processes distinct by ordinal", () => {
    const session = { id: "s1", agent: "claude" as const, nativeSessionId: "n" };

    expect(workerSourceKey(session, 1)).toBe("claude:n#1");
    expect(workerSourceKey(session, 2)).toBe("claude:n#2");
  });

  it("uses the session id when a native id is not available", () => {
    expect(workerSourceKey({ id: "s1", agent: "claude" }, 1)).toBe("claude:s1#1");
    expect(workerSourceKey({ id: "s2", agent: "codex" }, 3)).toBe("codex:s2");
  });

  it("uses a Codex native id and session keys for Antigravity and OMP", () => {
    expect(workerSourceKey({ id: "s1", agent: "codex", nativeSessionId: "thread" }, 1)).toBe(
      "codex:thread",
    );
    expect(workerSourceKey({ id: "s2", agent: "antigravity" }, 1)).toBe("session:s2");
    expect(workerSourceKey({ id: "s3", agent: "omp" }, 1)).toBe("session:s3");
  });

  it("does not assign opencode a source key", () => {
    expect(workerSourceKey({ id: "s1", agent: "opencode" }, 1)).toBeUndefined();
  });

  it("prefixes open session sources", () => {
    expect(openSourceKey("native-1")).toBe("claude-open:native-1");
  });
});
