import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";
import { NativeLinkStore } from "../src/store/native-links.js";
import { SessionStore } from "../src/store/sessions.js";
import type { Session } from "../src/core/session.js";

function withLinks(fn: (store: NativeLinkStore, sessions: SessionStore) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-links-"));
  const db = new Database(path.join(dir, "test.db"));
  try {
    const handle = db.getHandle();
    fn(new NativeLinkStore(handle), new SessionStore(handle));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeSession(
  id: string,
  status: Session["status"],
  origin: Session["origin"] = "open",
): Session {
  const now = new Date("2026-09-22T12:00:00.000Z");
  return {
    id,
    agent: "claude",
    status,
    origin,
    cwd: "/tmp",
    createdAt: now,
    updatedAt: now,
  };
}

describe("NativeLinkStore", () => {
  it("keeps multiple native ids and reports only other unreconciled links", () => {
    withLinks((store, sessions) => {
      sessions.create(makeSession("run-a", "working"));

      expect(store.link("run-a", "native-a")).toEqual({ created: true, previous: [] });
      expect(store.link("run-a", "native-b")).toEqual({
        created: true,
        previous: ["native-a"],
      });
      expect(store.link("run-a", "native-b")).toEqual({
        created: false,
        previous: ["native-a"],
      });
      expect(store.unreconciled("run-a").map((link) => link.nativeId)).toEqual([
        "native-a",
        "native-b",
      ]);
      expect(store.linksFor(["run-a", "missing"])).toMatchObject([
        { sessionId: "run-a", nativeId: "native-a", state: null, reconciledAt: null },
        { sessionId: "run-a", nativeId: "native-b", state: null, reconciledAt: null },
      ]);

      store.markReconciled("run-a", "native-a", "cost-state");
      expect(store.unreconciled("run-a").map((link) => link.nativeId)).toEqual(["native-b"]);
      expect(store.linksFor(["run-a"])[0]).toMatchObject({
        nativeId: "native-a",
        state: "cost-state",
      });
      expect(store.linksFor(["run-a"])[0].reconciledAt).toBeTruthy();
      expect(store.link("run-a", "native-c")).toEqual({
        created: true,
        previous: ["native-b"],
      });
    });
  });

  it("returns only interrupted or dead working open rows with unreconciled links", () => {
    withLinks((store, sessions) => {
      const fixtures: Session[] = [
        makeSession("interrupted-open", "interrupted"),
        makeSession("working-dead", "working"),
        makeSession("working-alive", "working"),
        makeSession("completed-open", "completed"),
        makeSession("unlinked-open", "interrupted"),
        makeSession("interrupted-run", "interrupted", "run"),
      ];
      for (const session of fixtures) sessions.create(session);
      for (const id of [
        "interrupted-open",
        "working-dead",
        "working-alive",
        "completed-open",
        "interrupted-run",
      ]) {
        store.link(id, `native-${id}`);
      }

      const checked: string[] = [];
      const stale = store.staleOpenRows((session) => {
        checked.push(session.id);
        return session.id === "working-dead";
      });

      expect(stale.map((session) => session.id)).toEqual([
        "interrupted-open",
        "working-dead",
      ]);
      expect(checked).toEqual(["working-alive", "working-dead"]);
    });
  });
});
