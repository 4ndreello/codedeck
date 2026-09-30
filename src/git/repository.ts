import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitInfo {
  root: string;
  head: string | null;
  branch: string | null;
  isDirty: boolean;
  remoteUrl?: string;
}

export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const { stdout: root } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const repoRoot = root.trim();
    let head: string | null = null;
    let branch: string | null = null;
    let isDirty = false;

    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
      head = stdout.trim();
    } catch {
      head = null;
    }

    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
      const b = stdout.trim();
      branch = b === "HEAD" ? null : b;
    } catch {
      branch = null;
    }

    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
      isDirty = stdout.trim().length > 0;
    } catch {
      isDirty = false;
    }

    return { root: repoRoot, head, branch, isDirty };
  } catch {
    return null;
  }
}

export async function getBaseCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}
