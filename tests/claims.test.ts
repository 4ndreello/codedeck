import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/store/database.js";
import { ClaimNotFoundError, ClaimNotOwnedError, ClaimsStore } from "../src/store/claims.js";
import { SessionStore } from "../src/store/sessions.js";
import type { Session, SessionStatus } from "../src/core/session.js";

function withStore(fn: (store: ClaimsStore, sessions: SessionStore, db: Database, root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claims-store-"));
  const db = new Database(path.join(root, "test.db"));
  try {
    const handle = db.getHandle();
    fn(new ClaimsStore(handle), new SessionStore(handle), db, root);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeSession(id: string, root: string, status: SessionStatus = "working"): Session {
  const now = new Date();
  return {
    id,
    agent: "claude",
    status,
    cwd: path.join(root, "subdir"),
    repository: root,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ClaimsStore schema", () => {
  it("creates the claims table and active natural-key index", () => {
    withStore((_claims, _sessions, db) => {
      const columns = (db.getHandle().prepare("PRAGMA table_info(claims)").all() as any[]).map((row) => row.name);
      expect(columns).toEqual(["id", "session_id", "path_glob", "reason", "created_at", "active"]);

      const index = db.getHandle().prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_claims_active_session_path'`,
      ).get() as { sql: string };
      expect(index.sql).toMatch(/CREATE UNIQUE INDEX/i);
      expect(index.sql).toMatch(/WHERE active = 1/i);
    });
  });
});

describe("ClaimsStore add and release", () => {
  it("normalizes paths and re-claims without replacing id or creation time", () => {
    withStore((claims, sessions, _db, root) => {
      sessions.create(makeSession("owner", root));

      const first = claims.add("owner", ".\\src\\auth\\*", "refactor login flow");
      expect(first).toMatchObject({
        id: 1,
        sessionId: "owner",
        pathGlob: "src/auth/*",
        reason: "refactor login flow",
        active: true,
      });
      expect(first.createdAt).toBe(new Date(first.createdAt).toISOString());

      const reclaimed = claims.add("owner", "./src/auth/*", "update login tests");
      expect(reclaimed).toEqual({ ...first, reason: "update login tests" });
    });
  });

  it("mints a new id after release and enforces release ownership", () => {
    withStore((claims, sessions, db, root) => {
      sessions.create(makeSession("owner", root));
      sessions.create(makeSession("other", root));

      const claim = claims.add("owner", "src/auth/*", "refactor login flow");
      expect(() => claims.release("other", claim.id)).toThrowError(ClaimNotOwnedError);
      expect(claims.query("other")).toHaveLength(1);

      const released = claims.release("owner", claim.id);
      expect(released).toEqual({ ...claim, active: false });
      expect(() => claims.release("owner", claim.id)).toThrowError(ClaimNotFoundError);
      expect(claims.query("owner")).toEqual([]);

      const replacement = claims.add("owner", "src/auth/*", "fix login flow");
      expect(replacement.id).toBeGreaterThan(claim.id);
      expect(new Date(replacement.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(claim.createdAt).getTime());
      expect((db.getHandle().prepare("SELECT COUNT(*) AS count FROM claims").get() as { count: number }).count).toBe(2);
    });
  });
});

describe("ClaimsStore query", () => {
  it("validates list-all callers and preserves valid cross-session queries", () => {
    withStore((claims, sessions, _db, root) => {
      sessions.create(makeSession("owner", root));
      sessions.create(makeSession("reader", root));
      const claim = claims.add("owner", "src/auth/*", "auth files");

      expect(claims.query("reader")).toEqual([claim]);

      let error: unknown;
      try {
        claims.query("missing");
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "SESSION_NOT_FOUND" });
    });
  });

  it("matches concrete paths and glob overlap with minimatch semantics", () => {
    withStore((claims, sessions, _db, root) => {
      sessions.create(makeSession("owner", root));
      sessions.create(makeSession("reader", root));

      claims.add("owner", "src/auth/*", "auth files");
      claims.add("owner", "src/**", "all source files");
      claims.add("owner", "src/.config/*", "dotfiles");
      claims.add("owner", "src/{auth,api}/*", "literal braces");

      expect(claims.query("reader", "./src\\auth\\login.ts").map((claim) => claim.reason)).toEqual([
        "auth files",
        "all source files",
      ]);
      expect(claims.query("reader", "src/auth/*.ts").map((claim) => claim.reason)).toEqual([
        "auth files",
        "all source files",
      ]);
      expect(claims.query("reader", "src/auth/nested/login.ts").map((claim) => claim.reason)).toEqual(["all source files"]);
      expect(claims.query("reader", "src/.config/settings.json").map((claim) => claim.reason)).toEqual([
        "all source files",
        "dotfiles",
      ]);
      expect(claims.query("reader").map((claim) => claim.reason)).toEqual([
        "auth files",
        "all source files",
        "dotfiles",
        "literal braces",
      ]);
    });
  });

  it("keeps matching case-sensitive and disables brace and extglob expansion", () => {
    withStore((claims, sessions, _db, root) => {
      sessions.create(makeSession("owner", root));
      sessions.create(makeSession("reader", root));

      claims.add("owner", "src/{auth,api}/*", "brace pattern");
      claims.add("owner", "src/@(auth|api)/*", "extglob pattern");
      claims.add("owner", "src/Auth/*", "case-sensitive pattern");

      expect(claims.query("reader", "src/auth/login.ts")).toEqual([]);
      expect(claims.query("reader", "src/Auth/login.ts").map((claim) => claim.reason)).toEqual(["case-sensitive pattern"]);
    });
  });

  it("resolves absolute paths from the repository root and rejects escapes", () => {
    withStore((claims, sessions, _db, root) => {
      sessions.create(makeSession("owner", root));
      sessions.create(makeSession("reader", root));
      const claim = claims.add("owner", "src/auth/*", "auth files");

      expect(claim.pathGlob).toBe("src/auth/*");
      expect(claims.query("reader", path.join(root, "src", "auth", "login.ts"))).toHaveLength(1);
      expect(() => claims.add("owner", "../outside/*", "invalid")).toThrow(/escapes the session root/);
      expect(() => claims.query("reader", path.join(root, "..", "outside", "file.ts"))).toThrow(/escapes the session root/);
    });
  });
});

describe("ClaimsStore lazy cleanup", () => {
  it("releases terminal and missing-session claims while keeping idle claims active", () => {
    withStore((claims, sessions, db, root) => {
      sessions.create(makeSession("terminal", root));
      sessions.create(makeSession("idle", root, "idle"));
      sessions.create(makeSession("missing", root));
      sessions.create(makeSession("reader", root));

      const terminal = claims.add("terminal", "src/terminal.ts", "terminal work");
      const idle = claims.add("idle", "src/idle.ts", "waiting for input");
      const missing = claims.add("missing", "src/missing.ts", "missing session");
      sessions.setStatus("terminal", "completed");
      db.getHandle().prepare("DELETE FROM sessions WHERE id = ?").run("missing");

      expect(claims.query("reader").map((claim) => claim.id)).toEqual([idle.id]);
      expect((db.getHandle().prepare("SELECT active FROM claims WHERE id = ?").get(terminal.id) as { active: number }).active).toBe(0);
      expect((db.getHandle().prepare("SELECT active FROM claims WHERE id = ?").get(missing.id) as { active: number }).active).toBe(0);
    });
  });
});
