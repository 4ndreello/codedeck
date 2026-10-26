import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentInstallation, StartOptions } from "../../core/driver.js";
import type { ListModelsOptions, ModelInfo, ProviderModels } from "../../core/models.js";
import { runCommandWithTimeout } from "../helpers.js";
import { createRuntimeHooks, SessionDriver } from "../session-driver.js";
import { parseGrokLine } from "./parser.js";

const execFileAsync = promisify(execFile);

// Pure so the flag spellings are testable without spawning grok.
// Measured against grok 1.0.70: headless `-p` writes Messages JSON when asked,
// `--always-approve` skips tool prompts, and `--verbatim` leaves the prompt
// alone. A prompt that starts with `-` has to be glued to `--single`, or clap
// reads it as another flag.
export function buildGrokArgs(options: StartOptions): string[] {
  const args = ["--output-format", "streaming-messages-json", "--always-approve", "--verbatim"];
  if (options.model) args.push("--model", options.model);
  // grok 1.0.70 rejects `max`. Its menu is low, medium, high, xhigh.
  if (options.effort) args.push("--reasoning-effort", options.effort === "max" ? "xhigh" : options.effort);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  if (options.fork && options.resumeSessionId) args.push("--fork-session");
  const prompt = options.prompt ?? "";
  if (prompt.startsWith("-")) args.push(`--single=${prompt}`);
  else args.push("--single", prompt);
  if (options.passthrough && options.passthrough.length > 0) args.push(...options.passthrough);
  return args;
}

// `grok --version` on a mise shim prints the installer banner before the
// version line. The version is the first line that starts with `grok `.
export function parseGrokVersion(stdout: string): string | undefined {
  for (const raw of stdout.split("\n")) {
    const match = raw.trim().match(/^grok\s+(\S+)/);
    if (match) return match[1];
  }
}

// `grok models` is a text list. The mise banner and the login line come first,
// then `Available models:` and one id per row. `*` plus `(default)`, or the
// earlier `Default model:` line, marks the default.
export function parseGrokModelsList(stdout: string): ProviderModels[] {
  const models: ModelInfo[] = [];
  let declaredDefault: string | undefined;
  let inList = false;

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const declared = line.match(/^default model:\s*(\S+)/i);
    if (declared) {
      declaredDefault = declared[1];
      continue;
    }
    if (/^available models:?$/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const row = line.match(/^[*\-•]\s+(\S+)/);
    if (!row) continue;
    const id = row[1];
    models.push({
      id,
      name: id,
      provider: "xai",
      isDefault: /\(default\)/i.test(line) || id === declaredDefault,
      supportsThinking: true,
    });
  }

  if (models.length === 0) return [];
  return [{ provider: "xai", displayName: "xAI", models }];
}

export class GrokDriver extends SessionDriver {
  readonly id = "grok" as const;

  protected readonly hooks = createRuntimeHooks({
    parse: parseGrokLine,
    nativeKeys: ["session_id", "sessionId"],
    harness: "Grok",
  });

  protected readonly resumeError = "No native session id available for Grok resume";

  protected buildArgs(options: StartOptions): string[] {
    return buildGrokArgs(options);
  }

  protected getEnv(): NodeJS.ProcessEnv {
    return { MISE_QUIET: "1", NO_COLOR: "1" };
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
    const bin = await findGrokBinary();
    if (!bin) return { installed: false, error: "grok binary not found" };

    // One version call. `detectBinary` keeps only the first stdout line, and a
    // mise shim prints its banner there, so the version would be thrown away
    // and read a second time.
    let version: string | undefined;
    try {
      version = parseGrokVersion(await runCommandWithTimeout(bin, ["--version"], { timeoutMs: 8000 }));
    } catch {
      version = undefined;
    }

    let authenticated: boolean | undefined;
    try {
      const authPath = path.join(os.homedir(), ".grok", "auth.json");
      if (fs.existsSync(authPath) || process.env.XAI_API_KEY) authenticated = true;
    } catch {
      authenticated = undefined;
    }

    return {
      installed: true,
      path: bin,
      version,
      authenticated,
      details: "streaming-messages-json via grok --single",
    };
  }

  async listModels(_options?: ListModelsOptions): Promise<ProviderModels[]> {
    const install = await this.detect();
    if (!install.installed) return [];
    try {
      const stdout = await runCommandWithTimeout(install.path ?? "grok", ["models"], { timeoutMs: 15000 });
      return parseGrokModelsList(stdout);
    } catch {
      return [];
    }
  }
}

async function findGrokBinary(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", ["grok"], { timeout: 3000 });
    const bin = stdout.trim().split("\n")[0];
    return bin.length > 0 ? bin : undefined;
  } catch {
    return undefined;
  }
}
