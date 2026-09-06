import { detectBinary, runCommandWithTimeout } from "../helpers.js";
import type { AgentInstallation, StartOptions } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { ListModelsOptions, ModelInfo, ProviderModels } from "../../core/models.js";
import { createRuntimeHooks, SessionDriver } from "../session-driver.js";
import { parseOpencodeLine } from "./parser.js";

export class OpencodeDriver extends SessionDriver {
  readonly id = "opencode" as const;

  protected readonly hooks = createRuntimeHooks({
    parse: parseOpencodeLine,
    nativeKeys: ["sessionID", "sessionId", "session_id"],
    harness: "Opencode",
  });

  protected readonly resumeError = "No native session id for Opencode resume";

  protected buildArgs(options: StartOptions): string[] {
    const args: string[] = ["run", "--format", "json"];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--session", options.resumeSessionId);
    // opencode run --dir <cwd> is not standard; rely on spawn cwd.
    args.push(options.prompt);
    return args;
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
    const res = await detectBinary("opencode");
    if (!res.installed) return { installed: false, error: "opencode binary not found" };
    return { installed: true, path: res.path, version: res.version, details: "opencode run --format json" };
  }

  async listModels(options?: ListModelsOptions): Promise<ProviderModels[]> {
    const install = await this.detect();
    if (!install.installed || !install.path) return [];

    try {
      const args = options?.refresh ? ["models", "--refresh"] : ["models"];
      const stdout = await runCommandWithTimeout(install.path, args, { timeoutMs: 10000 });
      const lines = stdout.split("\n");

      const providerMap = new Map<string, ModelInfo[]>();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith("[") || line.startsWith("─")) continue;

        const match = line.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.:/-]+)$/);
        if (!match) continue;

        const provider = match[1];
        const modelName = match[2];

        if (!providerMap.has(provider)) {
          providerMap.set(provider, []);
        }

        providerMap.get(provider)!.push({
          id: line, // e.g. "opencode/gemini-3.8-flash"
          name: modelName,
          provider,
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

