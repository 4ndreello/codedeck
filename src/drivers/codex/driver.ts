import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary } from "../helpers.js";
import { parseCodexLine } from "./parser.js";
import type { AgentEvent } from "../../core/events.js";
import type { AgentInstallation, StartOptions } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import { createRuntimeHooks, SessionDriver } from "../session-driver.js";

// Arg building is a pure function so the flag spellings can be tested without
// spawning codex. Measured against codex-cli 0.150.1.
export function buildCodexArgs(options: StartOptions): string[] {
  // resume is a subcommand with its own option set. Keep only flags accepted
  // by `codex exec resume`; the process cwd already provides the working dir.
  const resumeSessionId = options.resumeSessionId;
  const isResume = resumeSessionId !== undefined;
  const args: string[] = resumeSessionId
    ? ["exec", "resume", resumeSessionId, "--json"]
    : ["exec", "--json"];

  if (options.model) args.push("-m", options.model);

  // `-s` is valid for `exec`, but not for `exec resume` in codex-cli 0.150.1.
  // A resumed thread keeps its existing sandbox policy.
  if (!isResume) args.push("-s", "workspace-write");

  // codex has no dedicated flags for these; both are config overrides whose
  // values are parsed as TOML, hence the embedded quotes.
  if (options.effort) args.push("-c", `model_reasoning_effort="${options.effort}"`);
  if (options.fast) args.push("-c", 'service_tier="priority"');

  args.push("--skip-git-repo-check");
  if (!isResume) args.push("-C", options.cwd);
  args.push(options.prompt);
  return args;
}

// Tool-level failures (sandbox denials, approval refusals) are logged to stderr
// by the Rust core and NEVER appear as JSON frames on stdout. Without this the
// only trace is an agent message saying it could not do the work, followed by a
// clean turn.completed.
export function parseCodexStderrLine(line: string, sessionId: string): AgentEvent | null {
  const match = /\bERROR\b\s+(.+)$/.exec(line);
  if (!match) return null;

  let message = match[1].trim();
  // Drop the `<rust::module::path>: error=` prefix; keep the human part.
  const marker = message.indexOf("error=");
  if (marker !== -1) message = message.slice(marker + "error=".length).trim();
  if (!message) return null;

  return {
    type: "error",
    sessionId,
    timestamp: new Date().toISOString(),
    error: message,
    raw: { stderr: line },
  } as AgentEvent;
}

export class CodexDriver extends SessionDriver {
  readonly id = "codex" as const;

  protected readonly hooks = createRuntimeHooks({
    parse: parseCodexLine,
    parseStderr: parseCodexStderrLine,
    nativeKeys: ["thread_id", "threadId"],
    harness: "Codex",
  });

  protected readonly resumeError = "No native session id for Codex resume";

  protected buildArgs(options: StartOptions): string[] {
    return buildCodexArgs(options);
  }

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      fork: true,
      approvals: true,
      usage: true,
      cost: false,
      modelSelection: true,
      nativeDiff: false,
      interrupt: true,
    };
  }

  async detect(): Promise<AgentInstallation> {
    const res = await detectBinary("codex");
    if (!res.installed) return { installed: false, error: "codex binary not found" };
    // Check auth maybe via codex login status?
    // Simplify: check CODEX env or config
    let authenticated: boolean | undefined;
    try {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      if (fs.existsSync(path.join(home, "auth.json")) || fs.existsSync(path.join(home, "config.toml"))) {
        // not definitive but assume authenticated if file exists
        authenticated = true;
      } else if (process.env.OPENAI_API_KEY) authenticated = true;
    } catch {}
    return { installed: true, path: res.path, version: res.version, authenticated, details: "codex exec --json" };
  }
}
