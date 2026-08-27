import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getPaths } from "../config/paths.js";
import { WorktreeCreationFailedError } from "../core/errors.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommit: string | null;
}

function repoHash(repoRoot: string): string {
  return crypto.createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
}

function slugify(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30) || "task";
}

export async function createWorktree(options: {
  repoRoot: string;
  sessionId: string;
  prompt: string;
  name?: string;
}): Promise<WorktreeInfo> {
  const { repoRoot, sessionId, prompt, name } = options;
  const baseSlug = name ? slugify(name) : slugify(prompt);
  const branch = `ra/${baseSlug}-${sessionId}`;
  const hash = repoHash(repoRoot);
  const worktreePath = path.join(getPaths().worktreesDir, hash, sessionId);

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  let baseCommit: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    baseCommit = stdout.trim();
  } catch {
    baseCommit = null;
  }

  try {
    // Create worktree from HEAD
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot });
  } catch (err: unknown) {
    // If branch exists, try without -b
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      try {
        await execFileAsync("git", ["worktree", "add", worktreePath, branch], { cwd: repoRoot });
      } catch (e) {
        throw new WorktreeCreationFailedError(e);
      }
    } else {
      throw new WorktreeCreationFailedError(err);
    }
  }

  return { path: worktreePath, branch, baseCommit };
}

export async function removeWorktree(worktreePath: string, repoRoot?: string): Promise<void> {
  const cwd = repoRoot || path.dirname(worktreePath);
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
  } catch {
    // Fallback: remove dir
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      if (repoRoot) {
        // Prune
        try { await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot }); } catch {}
      }
    } catch {}
  }
}

export async function listWorktrees(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) paths.push(line.slice(9).trim());
    }
    return paths;
  } catch {
    return [];
  }
}
