import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBinary } from "../helpers.js";
import type { AgentInstallation, StartOptions } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { ListModelsOptions, ModelInfo, ProviderModels } from "../../core/models.js";
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

  async listModels(_options?: ListModelsOptions): Promise<ProviderModels[]> {
    const install = await this.detect();
    if (!install.installed) return [];

    const modelsMap = new Map<string, ModelInfo>();

    // 1. Dynamic pull from models.dev (live catalog used by compozy and opencode)
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch("https://models.dev/api.json", { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as any;
        const anthropic = data?.anthropic?.models || {};
        for (const [id, m] of Object.entries<any>(anthropic)) {
          const effortObj = m.reasoning_options?.find((o: any) => o.type === "effort");
          const efforts: string[] | undefined = Array.isArray(effortObj?.values)
            ? effortObj.values
            : undefined;

          modelsMap.set(id, {
            id,
            name: m.name || id,
            provider: "anthropic",
            description: m.description,
            contextWindow: typeof m.limit?.context === "number" ? m.limit.context : undefined,
            maxOutputTokens: typeof m.limit?.output === "number" ? m.limit.output : undefined,
            reasoningEfforts: efforts,
            supportsThinking: Boolean(m.reasoning || (efforts && efforts.length > 0)),
            cost:
              m.cost && typeof m.cost.input === "number" && typeof m.cost.output === "number"
                ? { input: m.cost.input, output: m.cost.output }
                : undefined,
          });
        }
      }
    } catch {}

    // 2. Local Claude Code cache (~/.claude.json)
    try {
      const claudeJsonPath = path.join(os.homedir(), ".claude.json");
      if (fs.existsSync(claudeJsonPath)) {
        const cjson = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
        if (Array.isArray(cjson.additionalModelOptionsCache)) {
          for (const opt of cjson.additionalModelOptionsCache) {
            const val = typeof opt.value === "string" ? opt.value.replace(/\[.*\]$/, "") : undefined;
            if (val && !modelsMap.has(val)) {
              modelsMap.set(val, {
                id: val,
                name: opt.label || val,
                provider: "anthropic",
                description: opt.description,
                supportsThinking: true,
              });
            }
          }
        }
      }
    } catch {}

    // 3. Local Claude Code settings (~/.claude/settings.json)
    let configuredDefaultModel: string | undefined;
    try {
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        if (typeof settings.model === "string") {
          configuredDefaultModel = settings.model.replace(/\[.*\]$/, "").trim();
        }
        if (settings.modelSettings && typeof settings.modelSettings === "object") {
          for (const [mId, s] of Object.entries<any>(settings.modelSettings)) {
            const cleanId = mId.replace(/\[.*\]$/, "").trim();
            if (!modelsMap.has(cleanId)) {
              modelsMap.set(cleanId, {
                id: cleanId,
                name: cleanId,
                provider: "anthropic",
                supportsThinking: true,
              });
            }
          }
        }
      }
    } catch {}

    // 4. Anthropic Models API (if ANTHROPIC_API_KEY is available)
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
          if (Array.isArray(json.data)) {
            for (const item of json.data) {
              if (item.id && !modelsMap.has(item.id)) {
                modelsMap.set(item.id, {
                  id: item.id,
                  name: item.display_name || item.id,
                  provider: "anthropic",
                });
              }
            }
          }
        }
      } catch {}
    }

    // Dynamic alias resolution: attach short aliases (sonnet, opus, fable, haiku)
    // to their corresponding model families with fallback for standard Anthropic API IDs
    const aliasRules = [
      { alias: "sonnet", prefixes: ["claude-sonnet-5", "claude-sonnet", "claude-3-7-sonnet", "claude-3-5-sonnet"] },
      { alias: "opus", prefixes: ["claude-opus-5", "claude-opus", "claude-3-opus"] },
      { alias: "fable", prefixes: ["claude-fable-5", "claude-fable"] },
      { alias: "haiku", prefixes: ["claude-haiku-4-5", "claude-haiku", "claude-3-5-haiku", "claude-3-haiku"] },
    ];

    for (const { alias, prefixes } of aliasRules) {
      for (const prefix of prefixes) {
        let matched = false;
        for (const [id, m] of modelsMap.entries()) {
          if (id.startsWith(prefix)) {
            m.aliases = m.aliases || [];
            if (!m.aliases.includes(alias)) m.aliases.unshift(alias);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }

    // Mark default model
    if (configuredDefaultModel) {
      for (const [id, m] of modelsMap.entries()) {
        if (id === configuredDefaultModel || m.aliases?.includes(configuredDefaultModel)) {
          m.isDefault = true;
          break;
        }
      }
    } else {
      const sonnet = [...modelsMap.values()].find((m) => m.aliases?.includes("sonnet"));
      if (sonnet) sonnet.isDefault = true;
    }

    return [
      {
        provider: "anthropic",
        displayName: "Anthropic",
        models: [...modelsMap.values()],
      },
    ];
  }
}


