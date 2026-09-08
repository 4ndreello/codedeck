import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary, runCommandWithTimeout } from "../helpers.js";
import type { AgentInstallation, StartOptions } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { ListModelsOptions, ModelInfo, ProviderModels } from "../../core/models.js";
import { createRuntimeHooks, SessionDriver } from "../session-driver.js";
import { parseAntigravityLine } from "./parser.js";

// Pure so the flag spellings and effort clamping are testable without spawning agy.
export function buildAntigravityArgs(options: StartOptions): string[] {
  const args: string[] = ["--output-format", "stream-json", "--dangerously-skip-permissions"];

  if (options.resumeSessionId) {
    args.push("--conversation", options.resumeSessionId);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.effort) {
    // Antigravity validates strictly: (low|medium|high). Clamp xhigh and max to high.
    const clampedEffort =
      options.effort === "xhigh" || options.effort === "max" ? "high" : options.effort;
    args.push("--effort", clampedEffort);
  }

  // -p/--print takes the prompt as its value, so a bare -p up front swallows
  // the next flag as the prompt ("-p took --output-format as its prompt").
  // Attach with `=` so the prompt is unambiguous anywhere on the line, even
  // when it starts with a dash.
  args.push(`-p=${options.prompt}`);
  return args;
}

export class AntigravityDriver extends SessionDriver {
  readonly id = "antigravity" as const;

  protected readonly hooks = createRuntimeHooks({
    parse: parseAntigravityLine,
    nativeKeys: ["conversation_id"],
    harness: "Antigravity",
    plainTextFallback: true,
  });

  protected readonly resumeError = "No native conversation id available for Antigravity resume";

  private detectedPath?: string;

  protected override getCommand(): string {
    if (this.detectedPath) return this.detectedPath;
    const localBin = path.join(os.homedir(), ".local", "bin", "agy");
    if (fs.existsSync(localBin)) return localBin;
    return "agy";
  }

  protected override getEnv(_options: StartOptions): NodeJS.ProcessEnv {
    return {
      PYTHONUNBUFFERED: "1",
      NO_COLOR: "1",
      CI: "1",
    };
  }

  protected buildArgs(options: StartOptions): string[] {
    return buildAntigravityArgs(options);
  }

  capabilities(): AgentCapabilities {
    return {
      streaming: true,
      resume: true,
      fork: false,
      approvals: true,
      usage: true,
      cost: false,
      modelSelection: true,
      nativeDiff: false,
      interrupt: true,
    };
  }

  async detect(): Promise<AgentInstallation> {
    let res = await detectBinary("agy");
    if (!res.installed) {
      // Check default install target ~/.local/bin/agy if not in PATH
      const localBin = path.join(os.homedir(), ".local", "bin", "agy");
      if (fs.existsSync(localBin)) {
        res = await detectBinary(localBin);
      }
    }
    if (!res.installed) {
      // Also try antigravity binary, but verify it's the CLI and not the Electron GUI
      const res2 = await detectBinary("antigravity");
      if (res2.installed && res2.path) {
        try {
          const help = await runCommandWithTimeout(res2.path, ["--help"], { timeoutMs: 3000 });
          if (help.includes("output-format") || help.includes("Usage of antigravity")) {
            res = res2;
          }
        } catch {}
      }
    }

    if (!res.installed || !res.path) {
      this.detectedPath = undefined;
      return { installed: false, error: "agy binary not found" };
    }

    this.detectedPath = res.path;

    let authenticated: boolean | undefined;
    try {
      const settingsPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
      if (fs.existsSync(settingsPath) || process.env.GEMINI_API_KEY) {
        authenticated = true;
      }
    } catch {
      authenticated = undefined;
    }

    return {
      installed: true,
      path: res.path,
      version: res.version,
      authenticated,
      details: "agy -p --output-format stream-json",
    };
  }

  async listModels(_options?: ListModelsOptions): Promise<ProviderModels[]> {
    const install = await this.detect();
    if (!install.installed || !install.path) return [];

    try {
      const stdout = await runCommandWithTimeout(install.path, ["models"], { timeoutMs: 10000 });
      const lines = stdout.split("\n");
      const providerMap = new Map<string, ModelInfo[]>();

      for (const rawLine of lines) {
        // Strip spinner prefix if present (e.g. ⠋ Fetching available models...)
        const clean = rawLine.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+Fetching available models\.\.\./g, "").trim();
        if (!clean) continue;

        const parts = clean.split(/\s{2,}/);
        const id = parts[0]?.trim();
        const name = parts[1]?.trim() || id;
        if (!id || id.startsWith("#") || id.startsWith("Usage")) continue;

        let provider = "google";
        if (id.startsWith("claude-")) provider = "anthropic";
        else if (id.startsWith("gpt-")) provider = "openai";

        if (!providerMap.has(provider)) {
          providerMap.set(provider, []);
        }

        providerMap.get(provider)!.push({
          id,
          name,
          provider,
          supportsThinking: id.includes("thinking") || id.includes("high") || id.includes("medium"),
        });
      }

      const result: ProviderModels[] = [];
      for (const [provider, models] of providerMap.entries()) {
        result.push({
          provider,
          displayName: provider.charAt(0).toUpperCase() + provider.slice(1),
          models,
        });
      }

      return result;
    } catch {
      return [];
    }
  }
}
