import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import vm from "node:vm";
import { describe, expect, it, afterEach } from "vitest";
import {
  formatReviewComment,
  getLocalReview,
  languageForPath,
  parseUnifiedDiff,
} from "../src/git/review.js";
import { REVIEW_PAGE } from "../src/web/review-page.js";
import { createReviewHandler } from "../src/cli/commands/review.js";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-review-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  execSync("git add .", { cwd: dir });
  execSync("git commit -qm init", { cwd: dir });
  return dir;
}

const SAMPLE = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,4 +1,4 @@",
  " ctx1",
  "-old",
  "+new",
  " ctx2",
  "\\ No newline at end of file",
  " ctx3",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("numbers context, deleted and added lines", () => {
    const [file] = parseUnifiedDiff(SAMPLE);
    expect(file.path).toBe("src/foo.ts");
    expect(file.status).toBe("modified");
    expect(file.hunks).toHaveLength(1);
    const kinds = file.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo, l.text]);
    expect(kinds).toEqual([
      ["context", 1, 1, "ctx1"],
      ["del", 2, null, "old"],
      ["add", null, 2, "new"],
      ["context", 3, 3, "ctx2"],
      ["context", 4, 4, "ctx3"],
    ]);
  });

  it("marks added and deleted files from /dev/null", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-x",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["new.txt", "added"],
      ["gone.txt", "deleted"],
    ]);
    expect(files[0].hunks[0].lines[0]).toMatchObject({ type: "add", oldNo: null, newNo: 1 });
  });

  it("flags binary files and parses quoted paths with spaces", () => {
    const patch = [
      "diff --git a/bin/logo.png b/bin/logo.png",
      "Binary files a/bin/logo.png and b/bin/logo.png differ",
      'diff --git "a/my file.txt" "b/my file.txt"',
      "--- \"a/my file.txt\"",
      "+++ \"b/my file.txt\"",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files[0].binary).toBe(true);
    expect(files[0].hunks).toHaveLength(0);
    expect(files[1].path).toBe("my file.txt");
    expect(files[1].hunks[0].lines).toHaveLength(2);
  });

  it("detects renames from differing ---/+++ names", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
    ].join("\n");
    const [file] = parseUnifiedDiff(patch);
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("old.ts");
    expect(file.path).toBe("new.ts");
  });
});

describe("formatReviewComment", () => {
  it("emits file:line anchor, quoted code and trimmed body", () => {
    expect(
      formatReviewComment({ file: "src/foo.ts", line: 12, code: "const x = 1;", body: "  extrai isso\n" }),
    ).toBe("`src/foo.ts:12`\n> ```ts\n> const x = 1;\n> ```\nextrai isso");
  });

  it("marks deleted lines so the anchor cannot mislead", () => {
    const out = formatReviewComment({ file: "a.txt", line: 3, code: "gone", body: "por quê?", deleted: true });
    expect(out).toContain("> - (deleted line)");
    expect(out).toContain("`a.txt:3`");
  });

  it("anchors multi-line selections as file:start-end with lines in order", () => {
    const out = formatReviewComment({ file: "src/foo.ts", line: 12, endLine: 14, code: "a\nb\nc", body: "olha isso" });
    expect(out).toContain("`src/foo.ts:12-14`");
    expect(out).toContain("> a\n> b\n> c");
  });
});

describe("languageForPath", () => {
  it("maps common extensions and Dockerfile", () => {
    expect(languageForPath("src/a.ts")).toBe("ts");
    expect(languageForPath("run.py")).toBe("py");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("noext")).toBe("");
  });
});

describe("getLocalReview", () => {
  it("returns no files on a clean tree", async () => {
    const dir = makeRepo();
    const review = await getLocalReview(dir);
    expect(review.files).toHaveLength(0);
    expect(review.base).toMatch(/^[0-9a-f]{40}$/);
  });

  it("covers unstaged edits, staged additions and untracked files", async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
    fs.writeFileSync(path.join(dir, "staged.txt"), "s\n");
    execSync("git add staged.txt", { cwd: dir });
    fs.writeFileSync(path.join(dir, "notes.txt"), "untracked\n");
    const review = await getLocalReview(dir);
    const byPath = Object.fromEntries(review.files.map((f) => [f.path, f]));
    expect(byPath["a.txt"].status).toBe("modified");
    expect(byPath["a.txt"].hunks[0].lines.some((l) => l.type === "add" && l.text === "TWO")).toBe(true);
    expect(byPath["staged.txt"].status).toBe("added");
    expect(byPath["notes.txt"].status).toBe("added");
    expect(byPath["notes.txt"].hunks[0].lines[0]).toMatchObject({ type: "add", newNo: 1 });
  });

  it("rejects flag-like refs and non-repos", async () => {
    const dir = makeRepo();
    await expect(getLocalReview(dir, { ref: "--stat" })).rejects.toThrow(/invalid ref/);
    await expect(getLocalReview(os.tmpdir() + "/ra-review-nope-" + Date.now())).rejects.toThrow();
  });
});

describe("review HTTP routes", () => {
  let servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return `http://127.0.0.1:${address.port}`;
  }

  it("serves the review page at the root", async () => {
    const base = await listen(createReviewHandler());
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Review local");
    expect(REVIEW_PAGE).toContain("api/review");
  });

  it("keeps /review as an alias for the root page", async () => {
    const base = await listen(createReviewHandler());
    const res = await fetch(`${base}/review`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Review local");
  });

  it("does not expose the removed session canvas API", async () => {
    const base = await listen(createReviewHandler());
    const res = await fetch(`${base}/api/sessions`);
    expect(res.status).toBe(404);
  });

  it("proxies /api/review query to the loader", async () => {
    const seen: Array<{ root: string; ref: string; file?: string }> = [];
    const base = await listen(
      createReviewHandler({
        loadReview: async (root, ref, file) => {
          seen.push({ root, ref, file });
          return { root, ref, files: [] };
        },
      }),
    );
    const res = await fetch(`${base}/api/review?ref=HEAD&file=a.txt&repo=%2Frepo`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ root: "/repo", ref: "HEAD", files: [] });
    expect(seen).toEqual([{ root: "/repo", ref: "HEAD", file: "a.txt" }]);
  });

  it("maps a non-repo loader failure to 404", async () => {
    const base = await listen(
      createReviewHandler({
        loadReview: async () => {
          throw new Error("not a git repository: /tmp/x");
        },
      }),
    );
    const res = await fetch(`${base}/api/review?repo=%2Ftmp%2Fx`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not a git repository: /tmp/x" });
  });

  it("rejects a request without a repo parameter", async () => {
    const base = await listen(createReviewHandler({ loadReview: async () => ({}) }));
    const res = await fetch(`${base}/api/review?ref=HEAD`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo query parameter is required" });
  });

  it("rejects a relative repo path", async () => {
    const base = await listen(createReviewHandler({ loadReview: async () => ({}) }));
    const res = await fetch(`${base}/api/review?repo=relative%2Frepo`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo must be an absolute path" });
  });
});

describe("review page script", () => {
  function fakeElement() {
    return {
      innerHTML: "",
      textContent: "",
      style: {},
      children: [],
      addEventListener: () => {},
      appendChild: () => {},
      querySelectorAll: () => [],
    };
  }

  function runPage(search: string, stored: Record<string, string> = {}) {
    const elements = new Map<string, ReturnType<typeof fakeElement>>();
    const fetched: string[] = [];
    const store = new Map(Object.entries(stored));
    const localStorage = {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    const context = vm.createContext({
      location: { search },
      URLSearchParams,
      localStorage,
      setTimeout,
      fetch: (url: string) => { fetched.push(url); return new Promise(() => {}); },
      document: {
        getElementById: (id: string) => {
          if (!elements.has(id)) elements.set(id, fakeElement());
          return elements.get(id);
        },
        addEventListener: () => {},
        querySelectorAll: () => [],
      },
    });
    const script = /<script>([\s\S]*)<\/script>/.exec(REVIEW_PAGE)?.[1];
    if (!script) throw new Error("review page has no script");
    vm.runInContext(script, context);
    return { context, elements, fetched, store };
  }

  it("sends the repo from the page query on the review request", () => {
    const page = runPage("?repo=%2Ftmp%2Fx&ref=HEAD");
    expect(page.fetched).toHaveLength(1);
    const url = new URL(page.fetched[0], "http://127.0.0.1/");
    expect(url.pathname).toBe("/api/review");
    expect(url.searchParams.get("repo")).toBe("/tmp/x");
    expect(url.searchParams.get("ref")).toBe("HEAD");
  });

  it("shows the no-repo message and fetches nothing without a repo", () => {
    const page = runPage("?ref=HEAD");
    expect(page.fetched).toEqual([]);
    expect(page.elements.get("main")?.innerHTML).toContain("Open this page with codedeck review inside a repository.");
  });

  it("keys drafts by repo and ignores drafts from another repo", () => {
    const draft = JSON.stringify({ code: "two", body: "other repo note" });
    const page = runPage("?repo=%2Ftmp%2Fx", { "codedeck-review:/tmp/other:a.txt:2": draft });

    vm.runInContext('saveDraft("a.txt", 3, { code: "three", body: "note" })', page.context);

    expect([...page.store.keys()]).toContain("codedeck-review:/tmp/x:a.txt:3");
    const drafts = vm.runInContext("allDrafts()", page.context) as Array<{ file: string; line: number; body: string }>;
    expect(drafts.map((d) => ({ file: d.file, line: d.line, body: d.body }))).toEqual([{ file: "a.txt", line: 3, body: "note" }]);
  });
});
