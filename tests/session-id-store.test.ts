import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";
import { AmbiguousSessionIdError, SessionStore } from "../src/store/sessions.js";
import { shortSessionId, type Session } from "../src/core/session.js";

const databases: Database[] = [];
const directories: string[] = [];

function createStore(): SessionStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-store-"));
  directories.push(directory);
  const database = new Database(path.join(directory, "test.db"));
  databases.push(database);
  return new SessionStore(database.getHandle());
}

function makeSession(id: string): Session {
  const now = new Date("2026-09-27T00:00:00.000Z");
  return { id, agent: "claude", status: "completed", cwd: "/tmp", createdAt: now, updatedAt: now };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SessionStore ID resolution", () => {
  it("prefers an exact legacy ID even when a longer ID starts with it", () => {
    const store = createStore();
    store.create(makeSession("beef"));
    store.create(makeSession("beef123456789abc"));

    expect(store.get("beef")?.id).toBe("beef");
    expect(store.get("beef123456789abc")?.id).toBe("beef123456789abc");
  });

  it("uses an eight-character display prefix that cannot select a legacy ID", () => {
    const store = createStore();
    const legacyId = "a83f";
    const newId = "a83f0123456789ab";
    store.create(makeSession(legacyId));
    store.create(makeSession(newId));

    const displayedId = shortSessionId(newId);

    expect(store.get(displayedId)?.id).toBe(newId);
    expect(displayedId).toBe("a83f0123");
    expect(store.get(legacyId)?.id).toBe(legacyId);
  });

  it("normalizes uppercase input in prefix and exact lookups", () => {
    const store = createStore();
    const id = "a83f0123456789ab";
    store.create(makeSession(id));

    expect(store.get("A83F")?.id).toBe(id);
    expect(store.getExact(id.toUpperCase())?.id).toBe(id);
  });

  it("resolves a unique prefix of any nonzero length", () => {
    const store = createStore();
    store.create(makeSession("abcdef0123456789"));

    expect(store.get("a")?.id).toBe("abcdef0123456789");
    expect(store.get("abcdef0")?.id).toBe("abcdef0123456789");
  });

  it("throws with all sorted candidate IDs for an ambiguous prefix", () => {
    const store = createStore();
    store.create(makeSession("abcd000000000001"));
    store.create(makeSession("abcd000000000002"));

    expect(() => store.get("abcd")).toThrow(AmbiguousSessionIdError);
    try {
      store.get("abcd");
      throw new Error("expected ambiguous lookup to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "SESSION_AMBIGUOUS",
        prefix: "abcd",
        candidates: ["abcd000000000001", "abcd000000000002"],
        message: 'Ambiguous session ID "abcd". Matches: abcd000000000001, abcd000000000002',
      });
    }
  });

  it("does not resolve an empty prefix", () => {
    const store = createStore();
    store.create(makeSession("abcdef0123456789"));

    expect(store.get("")).toBeNull();
  });

  it("checks allocator collisions by exact ID", () => {
    const store = createStore();
    store.create(makeSession("beef"));

    expect(store.getExact("beef123456789abc")).toBeNull();
    expect(store.getExact("beef")?.id).toBe("beef");
  });
});
