import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type ReviewLineType = "context" | "add" | "del";

export interface ReviewLine {
  type: ReviewLineType;
  /** 1-based old-file number; null on added lines. */
  oldNo: number | null;
  /** 1-based new-file number; null on deleted lines. */
  newNo: number | null;
  text: string;
}

export interface ReviewHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ReviewLine[];
}

export type ReviewFileStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFile {
  path: string;
  oldPath: string;
  status: ReviewFileStatus;
  hunks: ReviewHunk[];
  binary: boolean;
  tooLarge: boolean;
}

export interface ReviewResult {
  root: string;
  ref: string;
  base: string | null;
  files: ReviewFile[];
  truncated: boolean;
}

export const REVIEW_MAX_FILES = 500;
export const REVIEW_MAX_FILE_BYTES = 200 * 1024;
export const REVIEW_PATCH_MAX_BYTES = 2 * 1024 * 1024;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function unquoteGitPath(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Split `diff --git a/x b/y` into its two raw paths (quote-aware). */
function splitDiffGitArgs(rest: string): [string, string] | null {
  // Walk two tokens manually so quoted paths with spaces survive; anything
  // that does not yield exactly two tokens is not a file header we parse.
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length && tokens.length < 2) {
    while (i < rest.length && rest[i] === " ") i++;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      let j = i + 1;
      while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
      tokens.push(rest.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < rest.length && rest[j] !== " ") j++;
      tokens.push(rest.slice(i, j));
      i = j;
    }
  }
  if (tokens.length !== 2) return null;
  return [tokens[0], tokens[1]];
}

/**
 * Parse a unified diff into per-file hunks with old/new line numbers.
 * Pure: no git, no fs. Unknown preamble lines are skipped.
 */
export function parseUnifiedDiff(patch: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  let cur: ReviewFile | null = null;
  let hunk: ReviewHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldName: string | null = null;
  let newName: string | null = null;

  const flushFile = () => {
    if (cur) {
      // Status refinement from ---/+++ when no name-status map is available.
      if (oldName === "/dev/null" && newName !== "/dev/null") cur.status = "added";
      else if (newName === "/dev/null" && oldName !== "/dev/null") cur.status = "deleted";
      files.push(cur);
    }
    cur = null;
    hunk = null;
    oldName = null;
    newName = null;
  };

  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      flushFile();
      const args = splitDiffGitArgs(line.slice("diff --git ".length));
      const a = args ? stripPrefix(unquoteGitPath(args[0])) : "unknown";
      const b = args ? stripPrefix(unquoteGitPath(args[1])) : "unknown";
      cur = { path: b, oldPath: a, status: "modified", hunks: [], binary: false, tooLarge: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("Binary files ")) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldName = stripPrefix(unquoteGitPath(line.slice(4).split("\t")[0]));
      continue;
    }
    if (line.startsWith("+++ ")) {
      newName = stripPrefix(unquoteGitPath(line.slice(4).split("\t")[0]));
      if (oldName !== null && newName !== null) {
        if (oldName !== "/dev/null" && newName !== "/dev/null" && oldName !== newName) {
          cur.oldPath = oldName;
          cur.path = newName;
          cur.status = "renamed";
        } else if (newName !== "/dev/null") {
          cur.path = newName;
        }
      }
      continue;
    }
    const hm = HUNK_RE.exec(line);
    if (hm) {
      const oldStart = Number(hm[1]);
      const oldCount = hm[2] === undefined ? 1 : Number(hm[2]);
      const newStart = Number(hm[3]);
      const newCount = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = { header: line, oldStart, oldCount, newStart, newCount, lines: [] };
      cur.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") {
      hunk.lines.push({ type: "context", oldNo, newNo, text });
      oldNo++;
      newNo++;
    } else if (marker === "+") {
      hunk.lines.push({ type: "add", oldNo: null, newNo, text });
      newNo++;
    } else if (marker === "-") {
      hunk.lines.push({ type: "del", oldNo, newNo: null, text });
      oldNo++;
    }
    // Anything else inside a hunk body is ignored (defensive, not a guess:
    // malformed hunks simply yield fewer lines rather than wrong numbers).
  }
  flushFile();
  return files;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  py: "py",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  cs: "csharp",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "md",
  sh: "bash",
  sql: "sql",
};

export function languageForPath(p: string): string {
  const base = p.split("/").pop() ?? p;
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return "dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return LANG_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? "";
}

/**
 * One copyable block per line comment: `file:line` anchor, quoted code,
 * free text. The line anchor uses the new-file number (what the reader
 * sees in the working tree); deleted lines fall back to the old number
 * and are marked with a `-` in the quote. A multi-line selection anchors
 * as `file:start-end` with the selected lines quoted in order.
 */
export function formatReviewComment(input: {
  file: string;
  line: number;
  /** Last line of a multi-line selection; omit for single-line comments. */
  endLine?: number;
  code: string;
  body: string;
  deleted?: boolean;
}): string {
  const lang = languageForPath(input.file);
  const quoted = input.code
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const span = input.endLine !== undefined && input.endLine !== input.line ? `${input.line}-${input.endLine}` : `${input.line}`;
  const head = `\`${input.file}:${span}\``;
  const fence = `\`\`\`${lang}`.replace(/\s+$/, "");
  const mark = input.deleted ? "> - (deleted line)\n" : "";
  const body = input.body.trim();
  return `${head}\n${mark}> ${fence}\n${quoted}\n> \`\`\`\n${body}`;
}

async function sh(file: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** `git diff --name-status -z` → status map (new path → entry). */
async function readStatusMap(root: string, ref: string): Promise<Map<string, { status: ReviewFileStatus; oldPath: string }>> {
  const map = new Map<string, { status: ReviewFileStatus; oldPath: string }>();
  let out: string;
  try {
    out = await sh("git", ["diff", "--name-status", "-z", ref, "--"], root);
  } catch {
    return map;
  }
  const parts = out.split("\0").filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (code.startsWith("R")) {
      const oldPath = parts[i + 1] ?? "";
      const newPath = parts[i + 2] ?? "";
      map.set(newPath, { status: "renamed", oldPath });
      i += 2;
    } else {
      const p = parts[i + 1] ?? "";
      const status: ReviewFileStatus =
        code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
      map.set(p, { status, oldPath: p });
      i += 1;
    }
  }
  return map;
}

function synthesizeUntracked(root: string, rel: string): ReviewFile | null {
  const abs = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > REVIEW_MAX_FILE_BYTES) {
    return { path: rel, oldPath: rel, status: "added", hunks: [], binary: false, tooLarge: true };
  }
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return { path: rel, oldPath: rel, status: "added", hunks: [], binary: true, tooLarge: false };
  }
  if (content.includes("\0")) {
    return { path: rel, oldPath: rel, status: "added", hunks: [], binary: true, tooLarge: false };
  }
  const items = content.replace(/\n$/, "").split("\n");
  const lines: ReviewLine[] = items.map((text, idx) => ({ type: "add" as const, oldNo: null, newNo: idx + 1, text }));
  return {
    path: rel,
    oldPath: rel,
    status: "added",
    hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines }],
    binary: false,
    tooLarge: false,
  };
}

/**
 * Local review source of truth: `git diff <ref>` (working tree vs ref,
 * which already covers staged + unstaged) plus untracked files.
 * Throws when cwd is not inside a git repo.
 */
export async function getLocalReview(
  cwd: string,
  opts: { ref?: string; file?: string } = {},
): Promise<ReviewResult> {
  const ref = (opts.ref ?? "HEAD").trim() || "HEAD";
  if (ref.startsWith("-") || ref.length > 128 || /[\0\n]/.test(ref)) {
    throw new Error(`invalid ref: ${ref}`);
  }
  let root: string;
  try {
    root = (await sh("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    throw new Error(`not a git repository: ${cwd}`);
  }
  let base: string | null = null;
  try {
    base = (await sh("git", ["rev-parse", "--verify", `${ref}^{commit}`], root)).trim();
  } catch {
    base = null;
  }

  const fileArgs = opts.file ? ["--", opts.file] : ["--"];
  let patch = "";
  try {
    // Forced prefixes: user-level diff.srcPrefix/dstPrefix/noprefix config
    // must not leak into the parse (seen in the wild as c//w/ prefixes).
    patch = await sh("git", ["-c", "diff.noprefix=false", "diff", "--no-color", "--no-ext-diff", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/", ref, ...fileArgs], root);
  } catch {
    patch = "";
  }
  if (patch.length > REVIEW_PATCH_MAX_BYTES) {
    return { root, ref, base, files: [], truncated: true };
  }

  const statusMap = opts.file ? new Map() : await readStatusMap(root, ref);
  let files = parseUnifiedDiff(patch);
  for (const f of files) {
    const entry = statusMap.get(f.path);
    if (entry) {
      f.status = entry.status;
      f.oldPath = entry.oldPath;
    }
  }

  if (!opts.file) {
    try {
      const out = await sh("git", ["ls-files", "--others", "--exclude-standard", "-z"], root);
      const untracked = out.split("\0").filter(Boolean);
      for (const rel of untracked) {
        if (files.some((f) => f.path === rel)) continue;
        const synth = synthesizeUntracked(root, rel);
        if (synth) files.push(synth);
      }
    } catch {
      // Untracked listing is best-effort; tracked diff above still stands.
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let truncated = false;
  if (files.length > REVIEW_MAX_FILES) {
    files = files.slice(0, REVIEW_MAX_FILES);
    truncated = true;
  }
  return { root, ref, base, files, truncated };
}
