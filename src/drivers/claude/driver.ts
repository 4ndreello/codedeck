import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary } from "../helpers.js";
import type { AgentInstallation, StartOptions } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import { parseClaudeLine } from "./parser.js";
import { createRuntimeHooks, SessionDriver } from "../session-driver.js";

// Pure so the flag spellings are testable without spawning claude.
export function buildClaudeArgs(options: StartOptions): string[] {
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose"];
  // Bypass permissions for automation (as spec allows).
  args.push("--dangerously-skip-permissions");
  if (options.model) args.push("--model", options.model);
  // Claude spells effort as a first-class flag and accepts the same levels as
  // the others. It has NO service-tier equivalent, so `options.fast` is
  // deliberately dropped here rather than translated into an invalid flag.
  if (options.effort) args.push("--effort", options.effort);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  args.push(options.prompt);
  return args;
}

export class ClaudeDriver extends SessionDriver {
  readonly id = "claude" as const;

  protected readonly hooks = createRuntimeHooks({
    parse: parseClaudeLine,
    nativeKeys: ["session_id", "sessionId"],
    harness: "Claude",
  });

  protected readonly resumeError = "No native session id available for resume";

  protected buildArgs(options: StartOptions): string[] {
    return buildClaudeArgs(options);
  }

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      fork: true,
      approvals: true,
      usage: true,
      cost: true,
      modelSelection: true,
      nativeDiff: false,
      interrupt: true,
    };
  }

  async detect(): Promise<AgentInstallation> {
    const res = await detectBinary("claude");
    if (!res.installed) return { installed: false, error: "claude binary not found" };
    // Lightweight auth heuristic: a credentials file or an env token counts as
    // authenticated; otherwise unknown — driving decides.
    let authenticated: boolean | undefined;
    try {
      const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
      if (fs.existsSync(credPath)) authenticated = true;
      else if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) authenticated = true;
      else authenticated = undefined; // unknown, assume yes for driving
    } catch {
      authenticated = undefined;
    }
    return {
      installed: true,
      path: res.path,
      version: res.version,
      authenticated,
      details: "stream-json via claude -p",
    };
  }
}
