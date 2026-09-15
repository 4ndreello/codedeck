import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { detectBinary, runCommandWithTimeout } from "../helpers.js";
import type { AgentInstallation, DriverSession, ReattachRequest, StartOptions } from "../../core/driver.js";
import type { AgentCapabilities } from "../../core/capabilities.js";
import type { AgentEvent } from "../../core/events.js";
import type { ListModelsOptions, ModelInfo, ProviderModels } from "../../core/models.js";
import { createRuntimeHooks, SessionDriver } from "../session-driver.js";
import { sessionLogPaths } from "../session-runtime.js";
import { createAntigravityParser, type AntigravityParser } from "./parser.js";

const MAX_REPLAY_READ_BYTES = 64 * 1024;

export function alignAntigravityLogOffset(stdoutPath: string, logOffset: number): number {
  if (!Number.isSafeInteger(logOffset) || logOffset <= 0) return 0;

  let fd: number | undefined;
  try {
    fd = fs.openSync(stdoutPath, "r");
    const size = fs.fstatSync(fd).size;
    if (logOffset > size) return 0;
    let position = logOffset;
    const buffer = Buffer.allocUnsafe(MAX_REPLAY_READ_BYTES);
    while (position > 0) {
      const start = Math.max(0, position - MAX_REPLAY_READ_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, position - start, start);
      if (bytesRead === 0) return 0;
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      position = start;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function replayAntigravityOutput(
  stdoutPath: string,
  logOffset: number,
  parser: AntigravityParser,
  sessionId: string,
): void {
  if (!Number.isSafeInteger(logOffset) || logOffset <= 0) return;

  let fd: number | undefined;
  try {
    fd = fs.openSync(stdoutPath, "r");
    const buffer = Buffer.allocUnsafe(Math.min(MAX_REPLAY_READ_BYTES, logOffset));
    const decoder = new StringDecoder("utf8");
    let position = 0;
    let line = "";

    while (position < logOffset) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, logOffset - position),
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;

      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      for (let newline = chunk.indexOf("\n"); newline >= 0; newline = chunk.indexOf("\n", start)) {
        line += chunk.slice(start, newline);
        if (line) parser(line, sessionId);
        line = "";
        start = newline + 1;
      }
      line += chunk.slice(start);
    }

    // The persisted offset is the end of a complete line. Discard any
    // unterminated fragment so an invalid offset cannot turn log bytes into
    // assistant text or cause the live tailer to replay part of a line.
    decoder.end();
  } catch {
    // A missing or unreadable old log does not prevent the runtime from attaching.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

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

// Pure so the TAB-separated `agy models` table is testable without the binary.
export function parseAntigravityModelsList(stdout: string): ProviderModels[] {
  const lines = stdout.split("\n");
  const providerMap = new Map<string, ModelInfo[]>();

  for (const rawLine of lines) {
    // Strip spinner prefix if present (e.g. ⠋ Fetching available models...)
    const clean = rawLine.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+Fetching available models\.\.\./g, "").trim();
    if (!clean) continue;
    // Banner without spinner prefix is not a model row either.
    if (/^fetching available models\.\.\./i.test(clean)) continue;

    // `agy models` separates id and display name with a TAB; fall back to
    // column spacing for anything else.
    const tab = clean.indexOf("\t");
    const parts = tab >= 0 ? [clean.slice(0, tab), clean.slice(tab + 1)] : clean.split(/\s{2,}/);
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
}

export class AntigravityDriver extends SessionDriver {
  readonly id = "antigravity" as const;

  private readonly parser = createAntigravityParser();

  protected readonly hooks = createRuntimeHooks({
    parse: this.parser,
    nativeKeys: ["conversation_id"],
    harness: "Antigravity",
    plainTextFallback: true,
  });

  protected readonly resumeError = "No native conversation id available for Antigravity resume";

  private detectedPath?: string;

  override async start(options: StartOptions): Promise<DriverSession> {
    this.parser.reset(options.sessionId);
    return super.start(options);
  }

  override async attach(request: ReattachRequest): Promise<void> {
    this.parser.reset(request.sessionId);
    const logOffset = alignAntigravityLogOffset(
      sessionLogPaths(request.sessionId).stdoutPath,
      request.logOffset ?? 0,
    );
    this.replayConsumedOutput(request.sessionId, logOffset);
    await super.attach({ ...request, logOffset });
  }

  override async stop(session: DriverSession): Promise<void> {
    try {
      await super.stop(session);
    } finally {
      this.parser.reset(session.id);
    }
  }

  override async *events(session: DriverSession): AsyncIterable<AgentEvent> {
    for await (const event of super.events(session)) {
      if (event.type === "session.completed" || event.type === "session.failed") {
        this.parser.reset(session.id);
      }
      yield event;
    }
  }

  private replayConsumedOutput(sessionId: string, logOffset?: number): void {
    replayAntigravityOutput(sessionLogPaths(sessionId).stdoutPath, logOffset ?? 0, this.parser, sessionId);
  }

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
      return parseAntigravityModelsList(stdout);
    } catch {
      return [];
    }
  }
}
