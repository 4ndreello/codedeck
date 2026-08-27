import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiffResult {
  base: string | null;
  diff: string;
  stat: string;
  files: string[];
}

export async function getDiff(options: {
  cwd: string;
  worktree?: string;
  baseCommit?: string | null;
  repository?: string;
}): Promise<DiffResult> {
  const cwd = options.worktree || options.cwd;
  const repoRoot = options.repository || cwd;

  let base = options.baseCommit ?? null;
  if (!base) {
    try {
      const { stdout } = await execFileAsync("git", ["merge-base", "HEAD", "HEAD"], { cwd });
      base = stdout.trim();
    } catch {
      try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
        base = stdout.trim();
      } catch { base = null; }
    }
  }

  let diff = "";
  let stat = "";
  let files: string[] = [];

  // Try diff against baseCommit if available in original repo
  // In worktree case, diff against origin branch or HEAD of base?
  // Simplified: git diff baseCommit..HEAD or git diff HEAD
  try {
    if (base) {
      // diff between base and current worktree HEAD plus unstaged
      // For worktree, base is the commit at creation time, so diff base -> HEAD + working dir
      const { stdout } = await execFileAsync("git", ["diff", `${base}...HEAD`, "--patch"], { cwd });
      const { stdout: wd } = await execFileAsync("git", ["diff", "--patch"], { cwd });
      const { stdout: staged } = await execFileAsync("git", ["diff", "--cached", "--patch"], { cwd });
      const { stdout: untracked } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
      diff = [stdout, wd, staged].filter(Boolean).join("\n");
      // also include untracked files content via git diff --no-index? simpler list
      if (untracked.trim()) {
        // Append untracked info
        diff += `\n# Untracked files:\n# ${untracked.trim().split("\n").join("\n# ")}`;
      }
    } else {
      const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--patch"], { cwd });
      diff = stdout;
    }
  } catch (e) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
      diff = stdout ? `# git status:\n${stdout}` : "";
    } catch { diff = "No diff available"; }
  }

  try {
    if (base) {
      const { stdout } = await execFileAsync("git", ["diff", "--stat", `${base}...HEAD`], { cwd });
      const { stdout: wdStat } = await execFileAsync("git", ["diff", "--stat"], { cwd });
      stat = [stdout, wdStat].filter(Boolean).join("\n");
    } else {
      const { stdout } = await execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd });
      stat = stdout;
    }
  } catch { stat = ""; }

  try {
    if (base) {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd });
      const { stdout: wd } = await execFileAsync("git", ["diff", "--name-only"], { cwd });
      const all = new Set([...stdout.split("\n").filter(Boolean), ...wd.split("\n").filter(Boolean)]);
      files = [...all];
    } else {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd });
      files = stdout.split("\n").filter(Boolean);
    }
  } catch { files = []; }

  // Fallback: if diff empty, show untracked diff via git status
  if (!diff.trim() && files.length === 0) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd });
      if (stdout.trim()) {
        diff = `# Working tree status:\n${stdout}`;
        stat = stdout;
      }
    } catch {}
  }

  return { base, diff, stat, files };
}
