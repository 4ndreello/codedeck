import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatchModelsOptions, BatchModelsResult, HarnessModels } from "../src/core/models.js";
import type { Role } from "../src/core/roles.js";
import type { RunAgentConfig, SetupConfigRead } from "../src/config/config.js";
import { serializeConfig } from "../src/config/config.js";
import { createSetupRoutes } from "../src/web/setup-routes.js";
import { startWebServer, type WebServerHandle } from "../src/web/server.js";

interface ResponseValue {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const handles: WebServerHandle[] = [];

function readConfig(config: RunAgentConfig, status: SetupConfigRead["status"] = "ok"): SetupConfigRead {
  return {
    status,
    source: status === "missing" ? "none" : "canonical",
    path: "/tmp/codedeck-config.json",
    config: structuredClone(config),
    raw: status === "missing" ? null : serializeConfig(config),
    message: null,
  };
}

function modelCatalog(models: HarnessModels[] = []): BatchModelsResult {
  return {
    models,
    status: "fresh",
    source: "cache",
    ageMs: 50,
    cacheWriteFailed: false,
  };
}

function codexCatalog(modelIds: string[] = ["gpt-known"]): BatchModelsResult {
  return modelCatalog([{
    agent: "codex",
    available: true,
    providers: [{
      provider: "openai",
      models: modelIds.map((id) => ({ id, name: id, provider: "openai" })),
    }],
  }]);
}

async function makeServer(
  dependencies: Parameters<typeof createSetupRoutes>[0] = {},
): Promise<WebServerHandle> {
  const handle = await startWebServer({
    routes: createSetupRoutes(dependencies),
    port: 0,
    initialPath: "/setup",
    open: false,
    log: () => undefined,
    signalTarget: new EventEmitter(),
    exit: () => undefined,
  });
  handles.push(handle);
  return handle;
}

function request(
  handle: WebServerHandle,
  options: { path: string; method?: string; body?: string; host?: string; auth?: boolean },
): Promise<ResponseValue> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? "GET";
    const host = options.host ?? `127.0.0.1:${handle.port}`;
    const headers: Record<string, string> = { host, cookie: `codedeck_ui_token_${handle.port}=${handle.security.token}` };
    if (options.auth) headers.origin = `http://${host}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const req = http.request({
      hostname: "127.0.0.1",
      port: handle.port,
      path: options.path,
      method,
      setHost: false,
      headers,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

function post(handle: WebServerHandle, path: string, body: unknown): Promise<ResponseValue> {
  return request(handle, { path, method: "POST", body: JSON.stringify(body), auth: true });
}

function json(response: ResponseValue): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function resultOf(response: ResponseValue): Record<string, unknown> {
  return json(response).resultado as Record<string, unknown>;
}

const emptySelection = { agents: {} };

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("setup page and state route", () => {
  it("serves the setup page and resolves top-level values with legacy data present", async () => {
    const pointerKey = "activeProfile";
    const savedSetsKey = "profiles";
    const legacySets = {
      staging: {
        agents: { reviewer: { harness: "codex", model: "gpt-known", effort: "high" } },
        orchestrator: { investigate: "read", selfWork: "small", tools: "edit", parallelism: 4 },
        defaultSandbox: "danger-full-access",
        autocompact: { enabled: true, cap: 300_000 },
      },
    };
    const config = {
      [pointerKey]: "staging",
      agents: { general: { harness: "claude", model: "top-level" } },
      orchestrator: { investigate: "none", selfWork: "none", tools: "dispatch" },
      defaultSandbox: "workspace-write",
      autocompact: { enabled: false },
      [savedSetsKey]: legacySets,
    } as RunAgentConfig;
    const handle = await makeServer({ readConfig: () => readConfig(config) });

    const page = await request(handle, { path: "/setup" });
    const state = await request(handle, { path: "/api/setup/state" });
    const payload = json(state);

    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(page.body).toContain('href="/setup" aria-label="CodeDeck home"');
    expect(page.body).toContain('href="/setup" aria-current="page" class="active">Setup</a>');
    expect(page.body).not.toContain('href="/review"');
    expect(page.body).not.toContain('href="/usage"');
    expect(page.body).not.toContain('href="/"');
    expect(payload.target).toEqual({ kind: "global" });
    expect(payload.bindings).toEqual({ general: { harness: "claude", model: "top-level" } });
    expect(payload.efforts).toEqual({});
    expect(payload.orchestrator).toEqual({ investigate: "none", selfWork: "none", tools: "dispatch" });
    expect(payload.sandbox).toBe("workspace-write");
    expect(payload.autocompact).toEqual({ enabled: false });
    expect(page.body).not.toContain("Profile:");
  });

  it("identifies the top-level configuration as the setup target", async () => {
    const handle = await makeServer({ readConfig: () => readConfig({ agents: {} }) });

    const state = json(await request(handle, { path: "/api/setup/state" }));

    expect(state.target).toEqual({ kind: "global" });
    expect(state.bindings).toEqual({});
  });

  it("saves web setup fields at top level and preserves legacy values", async () => {
    const pointerKey = "activeProfile";
    const savedSetsKey = "profiles";
    const legacySets = { x: { agents: { reviewer: { harness: "omp", model: "old" } } } };
    const config = {
      [pointerKey]: "x",
      agents: { general: { harness: "claude", model: "global" } },
      [savedSetsKey]: legacySets,
    } as RunAgentConfig;
    const saved: RunAgentConfig[] = [];
    const handle = await makeServer({
      readConfig: () => readConfig(config),
      saveConfig: (value) => { saved.push(value); return true; },
      getBatchModels: async () => codexCatalog(),
    });

    const state = json(await request(handle, { path: "/api/setup/state" }));
    const applied = await post(handle, "/api/setup/apply", {
      agents: { reviewer: { harness: "codex", model: "gpt-known" } },
    });

    expect(state.target).toEqual({ kind: "global" });
    expect(state.bindings).toEqual({ general: { harness: "claude", model: "global" } });
    expect(resultOf(applied)).toMatchObject({ status: "applied", saved: true, code: 0 });
    const written = saved[0] as RunAgentConfig & Record<string, unknown>;
    expect(written.agents).toEqual({
      general: { harness: "claude", model: "global" },
      reviewer: { harness: "codex", model: "gpt-known" },
    });
    expect(written[pointerKey]).toBe("x");
    expect(written[savedSetsKey]).toEqual(legacySets);
  });
});

describe("setup catalog routes", () => {
  it("reads only the cached catalog and returns all helper fields", async () => {
    const catalog: BatchModelsResult = {
      ...codexCatalog(),
      status: "offline",
      source: "stale-cache",
      ageMs: 999,
      discoveryError: "refresh unavailable",
      cacheWriteFailed: true,
    };
    const getBatchModels = vi.fn(async (_options: BatchModelsOptions) => catalog);
    const handle = await makeServer({ getBatchModels });

    const response = await request(handle, { path: "/api/setup/catalog" });

    expect(response.status).toBe(200);
    expect(json(response)).toEqual(catalog);
    expect(getBatchModels).toHaveBeenCalledTimes(1);
    expect(getBatchModels).toHaveBeenLastCalledWith({ allowNetwork: false });
  });

  it("uses the refresh fallback and shares one in-flight discovery across concurrent requests", async () => {
    let resolveRefresh: ((result: BatchModelsResult) => void) | undefined;
    const fallback: BatchModelsResult = {
      models: [{ agent: "codex", available: true, providers: [{ provider: "openai", models: [{ id: "cached", name: "cached", provider: "openai" }] }] }],
      status: "offline",
      source: "stale-cache",
      ageMs: 500,
      discoveryError: "model discovery returned an incomplete catalog",
      cacheWriteFailed: false,
    };
    const getBatchModels = vi.fn(async (options: BatchModelsOptions) => {
      expect(options).toEqual({ refresh: true, allowNetwork: true, timeoutMs: 25_000 });
      return await new Promise<BatchModelsResult>((resolve) => { resolveRefresh = resolve; });
    });
    const handle = await makeServer({ getBatchModels });

    const first = request(handle, { path: "/api/setup/catalog/refresh", method: "POST", auth: true });
    const second = request(handle, { path: "/api/setup/catalog/refresh", method: "POST", auth: true });
    await vi.waitFor(() => expect(getBatchModels).toHaveBeenCalledTimes(1));
    resolveRefresh?.(fallback);
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(json(firstResponse)).toEqual(fallback);
    expect(json(secondResponse)).toEqual(fallback);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(getBatchModels).toHaveBeenCalledTimes(1);
  });

  it("returns an unavailable refresh result without inventing partial network models", async () => {
    const fallback: BatchModelsResult = {
      models: [],
      status: "unavailable",
      source: "none",
      ageMs: null,
      discoveryError: "network discovery failed",
      cacheWriteFailed: false,
    };
    const getBatchModels = vi.fn(async () => fallback);
    const handle = await makeServer({ getBatchModels });

    const response = await request(handle, { path: "/api/setup/catalog/refresh", method: "POST", auth: true });

    expect(json(response)).toEqual(fallback);
    expect((json(response).models as unknown[])).toEqual([]);
  });
});

describe("setup dry-run and apply routes", () => {
  it("answers 500 when the mutation route rejects instead of leaving the promise unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const handle = await makeServer({
        readConfig: () => { throw new Error("read boom"); },
        configPath: () => { throw new Error("path boom"); },
      });

      const response = await post(handle, "/api/setup/apply", emptySelection);

      expect(response.status).toBe(500);
      expect(json(response)).toEqual({ error: "path boom" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("returns the exact dry-run envelope and never writes config", async () => {
    const config: RunAgentConfig = { agents: { general: { harness: "claude", model: "sonnet" } } };
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({
      readConfig: () => readConfig(config),
      saveConfig,
    });

    const response = await post(handle, "/api/setup/dry-run", {
      agents: {},
      sandbox: "danger-full-access",
    });
    const envelope = json(response);

    expect(response.status).toBe(200);
    expect(Object.keys(envelope).sort()).toEqual(["mudancas", "proposta", "resultado", "validacoes"]);
    expect(envelope.proposta).toMatchObject({ defaultSandbox: "danger-full-access" });
    expect(resultOf(response)).toEqual({ status: "dry-run", code: 0, saved: false, message: "Dry run; configuration not written." });
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("keeps a free-text off-catalog model in the dry-run proposal", async () => {
    const config: RunAgentConfig = { agents: { general: { harness: "claude", model: "old" } } };
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({
      readConfig: () => readConfig(config),
      saveConfig,
      getBatchModels: async () => codexCatalog(["gpt-known"]),
    });

    const response = await post(handle, "/api/setup/dry-run", {
      agents: { general: { harness: "codex", model: "user-entered-model" } },
    });
    const envelope = json(response);

    expect(response.status).toBe(422);
    expect((envelope.proposta as RunAgentConfig).agents?.general).toEqual({ harness: "codex", model: "user-entered-model" });
    expect(resultOf(response)).toMatchObject({ code: 12, saved: false });
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("validates changed harness:model bindings offline and applies a confirmed catalog match", async () => {
    const config: RunAgentConfig = { agents: { general: { harness: "claude", model: "old" } } };
    const saveConfig = vi.fn(() => true);
    const getBatchModels = vi.fn(async (_options: BatchModelsOptions) => codexCatalog(["gpt-known"]));
    const handle = await makeServer({ readConfig: () => readConfig(config), saveConfig, getBatchModels });

    const response = await post(handle, "/api/setup/apply", {
      agents: { general: { harness: "codex", model: "gpt-known" } },
    });
    const envelope = json(response);

    expect(response.status).toBe(200);
    expect(resultOf(response)).toEqual({ status: "applied", code: 0, saved: true, message: "Configuration saved." });
    expect((envelope.validacoes as { bindings: unknown[] }).bindings).toEqual([
      { role: "general", harness: "codex", model: "gpt-known", status: "accepted", message: "" },
    ]);
    expect(getBatchModels).toHaveBeenCalledTimes(1);
    expect(getBatchModels).toHaveBeenLastCalledWith({ agents: ["codex"], allowNetwork: false });
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0][0].agents?.general).toEqual({ harness: "codex", model: "gpt-known" });
  });

  it("rejects a changed off-catalog binding without per-role confirmation", async () => {
    const config: RunAgentConfig = { agents: { general: { harness: "claude", model: "old" } } };
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({
      readConfig: () => readConfig(config),
      saveConfig,
      getBatchModels: async () => codexCatalog(["gpt-known"]),
    });

    const response = await post(handle, "/api/setup/apply", {
      agents: { general: { harness: "codex", model: "typed-model" } },
    });

    expect(response.status).toBe(422);
    expect(resultOf(response)).toMatchObject({ status: "error", code: 12, saved: false });
    expect((json(response).validacoes as { bindings: Array<{ status: string }> }).bindings[0].status).toBe("unknown-model");
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("applies a changed off-catalog binding after confirmation for that role", async () => {
    const config: RunAgentConfig = { agents: { general: { harness: "claude", model: "old" } } };
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({
      readConfig: () => readConfig(config),
      saveConfig,
      getBatchModels: async () => codexCatalog(["gpt-known"]),
    });

    const response = await post(handle, "/api/setup/apply", {
      agents: { general: { harness: "codex", model: "typed-model" } },
      offCatalogConfirmed: { general: true },
    });

    expect(response.status).toBe(200);
    expect(resultOf(response)).toMatchObject({ status: "applied", code: 0, saved: true });
    expect((json(response).validacoes as { bindings: Array<{ status: string }> }).bindings[0].status).toBe("accepted");
    expect(saveConfig.mock.calls[0][0].agents?.general).toEqual({ harness: "codex", model: "typed-model" });
  });

  it("does not validate unchanged off-catalog bindings or effort-only changes", async () => {
    const config: RunAgentConfig = { agents: { general: { harness: "claude", model: "legacy", effort: "low" } } };
    const getBatchModels = vi.fn(async () => codexCatalog());
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({ readConfig: () => readConfig(config), getBatchModels, saveConfig });

    const response = await post(handle, "/api/setup/apply", {
      agents: { general: { harness: "claude", model: "legacy", effort: "high" } },
      sandbox: "danger-full-access",
    });

    expect(response.status).toBe(200);
    expect(resultOf(response)).toMatchObject({ status: "applied", saved: true });
    expect((json(response).validacoes as { bindings: unknown[] }).bindings).toEqual([]);
    expect(getBatchModels).not.toHaveBeenCalled();
    expect(saveConfig.mock.calls[0][0].agents?.general).toEqual({ harness: "claude", model: "legacy", effort: "high" });
  });

  it("returns unchanged without writing an empty proposal", async () => {
    const config: RunAgentConfig = { agents: { general: { harness: "claude", model: "sonnet" } } };
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({ readConfig: () => readConfig(config), saveConfig });

    const response = await post(handle, "/api/setup/apply", emptySelection);

    expect(response.status).toBe(200);
    expect(resultOf(response)).toEqual({ status: "unchanged", code: 0, saved: false, message: "Configuration unchanged." });
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("writes an empty agents object when every first-run role is skipped", async () => {
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({
      readConfig: () => readConfig({ defaultAgent: "claude" }, "missing"),
      saveConfig,
    });

    const response = await post(handle, "/api/setup/apply", emptySelection);

    expect(resultOf(response)).toMatchObject({ status: "applied", saved: true });
    expect(saveConfig.mock.calls[0][0].agents).toEqual({});
  });

  it("returns 400 for malformed, oversized, and invalid-shape bodies without saving", async () => {
    const saveConfig = vi.fn(() => true);
    const handle = await makeServer({ readConfig: () => readConfig({}), saveConfig });
    const malformed = await request(handle, { path: "/api/setup/dry-run", method: "POST", body: "{", auth: true });
    const oversized = await request(handle, {
      path: "/api/setup/apply",
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
      auth: true,
    });
    const invalidShape = await post(handle, "/api/setup/apply", { unknown: "wrong-place", agents: {} });
    const exactLimitBody = `${JSON.stringify(emptySelection)}${" ".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(emptySelection)))}`;
    const exactLimit = await request(handle, {
      path: "/api/setup/dry-run",
      method: "POST",
      body: exactLimitBody,
      auth: true,
    });

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(invalidShape.status).toBe(400);
    expect(Buffer.byteLength(exactLimitBody)).toBe(64 * 1024);
    expect(exactLimit.status).toBe(200);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("returns code 14 for invalid JSON and code 15 for config read errors on state and dry-run", async () => {
    const invalidRead: SetupConfigRead = {
      status: "invalid",
      source: "canonical",
      path: "/tmp/codedeck-config.json",
      config: null,
      raw: "{",
      message: 'Config file "/tmp/codedeck-config.json" contains invalid JSON; no changes were written. Repair or move it and retry.',
    };
    const failedRead: SetupConfigRead = {
      ...invalidRead,
      message: "permission denied",
      readError: new Error("permission denied"),
    };
    const saveConfig = vi.fn(() => true);
    const invalidServer = await makeServer({ readConfig: () => invalidRead, saveConfig });
    const failedServer = await makeServer({ readConfig: () => failedRead, saveConfig });

    const invalidState = await request(invalidServer, { path: "/api/setup/state" });
    const invalidDryRun = await post(invalidServer, "/api/setup/dry-run", emptySelection);
    const invalidApply = await post(invalidServer, "/api/setup/apply", emptySelection);
    const failedState = await request(failedServer, { path: "/api/setup/state" });
    const failedDryRun = await post(failedServer, "/api/setup/dry-run", emptySelection);
    const failedApply = await post(failedServer, "/api/setup/apply", emptySelection);

    expect(json(invalidState).code).toBe(14);
    expect(resultOf(invalidDryRun)).toMatchObject({ code: 14, saved: false });
    expect(resultOf(invalidApply)).toMatchObject({ code: 14, saved: false });
    expect(json(failedState).code).toBe(15);
    expect(resultOf(failedDryRun)).toMatchObject({ code: 15, saved: false });
    expect(resultOf(failedApply)).toMatchObject({ code: 15, saved: false });
    expect(Object.keys(json(invalidDryRun)).sort()).toEqual(["mudancas", "proposta", "resultado", "validacoes"]);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("maps config save failures to HTTP 500 and preserves the error message", async () => {
    const handle = await makeServer({
      readConfig: () => readConfig({}),
      saveConfig: () => { throw new Error("disk full"); },
    });

    const response = await post(handle, "/api/setup/apply", { agents: {}, sandbox: "danger-full-access" });

    expect(response.status).toBe(500);
    expect(resultOf(response)).toMatchObject({ status: "error", code: 15, saved: false });
    expect((resultOf(response).message as string)).toContain("disk full");
  });
});
