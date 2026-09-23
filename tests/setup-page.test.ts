import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { REASONING_EFFORTS } from "../src/core/driver.js";
import { ROLES, type Role } from "../src/core/roles.js";
import { ORCHESTRATOR_PRESETS } from "../src/config/orchestrator-mode.js";
import type { RoleBinding } from "../src/config/config.js";
import {
  buildSetupSelection,
  createSetupPageController,
  SETUP_PAGE,
  SETUP_SESSION_EXPIRED_MESSAGE,
  type SetupPageDocument,
  type SetupPageElement,
  type SetupPageFormValues,
  type SetupPageResponse,
} from "../src/web/setup-page.js";

function form(overrides: Partial<SetupPageFormValues> = {}): SetupPageFormValues {
  return {
    roles: Object.fromEntries(ROLES.map((role) => [role, { skip: true, binding: "", effort: "keep" }])),
    orchestrator: "skip",
    investigate: "none",
    selfWork: "none",
    tools: "dispatch",
    parallelism: "",
    sandbox: "skip",
    autocompact: "skip",
    ...overrides,
  };
}

function build(values: SetupPageFormValues, bindings: Partial<Record<Role, RoleBinding>>) {
  return buildSetupSelection(values, bindings, {
    roles: ROLES,
    efforts: REASONING_EFFORTS,
    presets: ORCHESTRATOR_PRESETS,
  });
}

function response(payload: unknown, status = 200): SetupPageResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function fakeDocument(): { document: SetupPageDocument; elements: Map<string, SetupPageElement> } {
  const elements = new Map<string, SetupPageElement>();
  return {
    elements,
    document: {
      getElementById(id) {
        let element = elements.get(id);
        if (!element) {
          element = { value: "", checked: false, disabled: false, hidden: false, textContent: "" };
          elements.set(id, element);
        }
        return element;
      },
    },
  };
}

describe("setup page selection", () => {
  it("offers every role, free-text binding fields, effort choices, and all setup fields", () => {
    for (const role of ROLES) {
      expect(SETUP_PAGE).toContain(`id="binding-${role}" type="text"`);
      expect(SETUP_PAGE).toContain(`id="effort-${role}"`);
      expect(SETUP_PAGE).toContain(`id="skip-${role}" type="checkbox"`);
      for (const effort of REASONING_EFFORTS) expect(SETUP_PAGE).toContain(`<option value="${effort}">${effort}</option>`);
    }
    expect(SETUP_PAGE).toContain('option value="dispatcher"');
    expect(SETUP_PAGE).toContain('option value="balanced"');
    expect(SETUP_PAGE).toContain('option value="explorer"');
    expect(SETUP_PAGE).toContain('id="orchestrator-investigate"');
    expect(SETUP_PAGE).toContain('id="orchestrator-self-work"');
    expect(SETUP_PAGE).toContain('id="orchestrator-tools"');
    expect(SETUP_PAGE).toContain("danger-full-access");
    expect(SETUP_PAGE).toContain('value="workspace-write"');
    expect(SETUP_PAGE).toContain('value="on"');
    expect(SETUP_PAGE).toContain('value="off"');
    expect(SETUP_PAGE).toContain('value="custom"');
    expect(SETUP_PAGE).toContain('id="orchestrator-parallelism" type="number"');
  });

  it("preserves skipped bindings and unchanged effort, and leaves an omitted orchestrator untouched", () => {
    const values = form({
      roles: {
        general: { skip: true, binding: "", effort: "keep" },
        reviewer: { skip: false, binding: "codex:typed-model", effort: "keep" },
        auditor: { skip: false, binding: "opencode:code-model", effort: "high" },
      },
    });
    const selection = build(values, {
      general: { harness: "claude", model: "legacy", effort: "medium" },
      reviewer: { harness: "codex", model: "typed-model", effort: "high" },
      auditor: { harness: "opencode", model: "code-model", effort: "low" },
    });

    expect(selection.agents).toEqual({
      reviewer: { harness: "codex", model: "typed-model", effort: "high" },
      auditor: { harness: "opencode", model: "code-model", effort: "low" },
    });
    expect(Object.hasOwn(selection, "orchestrator")).toBe(false);
  });

  it("keeps the empty agents sentinel when every first-run role is skipped", () => {
    expect(build(form(), {})).toEqual({ agents: {} });
  });

  it("stores custom parallelism as a positive finite number and maps the other controls", () => {
    const selection = build(form({
      orchestrator: "custom",
      investigate: "free",
      selfWork: "small",
      tools: "edit",
      parallelism: "3.5",
      sandbox: "danger-full-access",
      autocompact: "off",
    }), {});

    expect(selection.orchestrator).toEqual({ investigate: "free", selfWork: "small", tools: "edit", parallelism: 3.5 });
    expect(selection.sandbox).toBe("danger-full-access");
    expect(selection.autocompact).toEqual({ enabled: false });
  });

  it("does not expose an effort control for an opencode binding", async () => {
    const { document, elements } = fakeDocument();
    const controller = createSetupPageController({
      fetcher: async (path) => path === "/api/setup/state"
        ? response({ target: { kind: "global" }, bindings: { general: { harness: "opencode", model: "code-model" } } })
        : response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false }),
      buildSelection: (values, bindings) => buildSetupSelection(values, bindings, {
        roles: ROLES,
        efforts: REASONING_EFFORTS,
        presets: ORCHESTRATOR_PRESETS,
      }),
      roles: ROLES,
      expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
      document,
    });

    await controller.start();

    expect(elements.get("effort-general")?.hidden).toBe(true);
    expect(elements.get("effort-general")?.disabled).toBe(true);
  });

  it("shows discovery while refreshing and retains the previous catalog when discovery is unavailable", async () => {
    const { document, elements } = fakeDocument();
    let finishRefresh: ((value: SetupPageResponse) => void) | undefined;
    const previousCatalog = {
      models: [{ agent: "codex", available: true, providers: [{ provider: "openai", models: [] }] }],
      status: "fresh" as const,
      source: "cache" as const,
      ageMs: 50,
      cacheWriteFailed: false,
    };
    const controller = createSetupPageController({
      fetcher: async () => new Promise((resolve) => { finishRefresh = resolve; }),
      buildSelection: (values, bindings) => buildSetupSelection(values, bindings, {
        roles: ROLES,
        efforts: REASONING_EFFORTS,
        presets: ORCHESTRATOR_PRESETS,
      }),
      roles: ROLES,
      expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
      document,
    });
    controller.state.catalog = previousCatalog;

    const pending = controller.refreshCatalog();
    expect(controller.state.refreshing).toBe(true);
    expect(elements.get("setup-status")?.textContent).toBe("Discovering models...");
    finishRefresh?.(response({
      models: [],
      status: "unavailable",
      source: "none",
      ageMs: null,
      cacheWriteFailed: false,
      discoveryError: "network discovery failed",
    }));
    await pending;

    expect(controller.state.catalog).toBe(previousCatalog);
    expect(controller.state.discoveryError).toBe("network discovery failed");
    expect(controller.state.refreshing).toBe(false);
  });

  it("asks per role before sending an off-catalog changed model in apply", async () => {
    const { document } = fakeDocument();
    const posted: unknown[] = [];
    const confirm = vi.fn(() => true);
    const controller = createSetupPageController({
      fetcher: async (_path, init) => {
        if (init?.method === "POST") posted.push(JSON.parse(init.body ?? "{}"));
        return response({ resultado: { status: "applied", saved: true } });
      },
      buildSelection: (values, bindings) => buildSetupSelection(values, bindings, {
        roles: ROLES,
        efforts: REASONING_EFFORTS,
        presets: ORCHESTRATOR_PRESETS,
      }),
      roles: ROLES,
      expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
      document,
      confirm,
    });
    controller.state.target = { target: { kind: "global" }, bindings: {}, efforts: {} };
    controller.state.catalog = {
      models: [{
        agent: "codex",
        available: true,
        providers: [{ provider: "openai", models: [{ id: "known", name: "Known", provider: "openai" }] }],
      }],
      status: "fresh",
      source: "cache",
      ageMs: 0,
      cacheWriteFailed: false,
    };

    await controller.apply(form({
      roles: { ...form().roles, reviewer: { skip: false, binding: "codex:typed-model", effort: "keep" } },
    }));

    expect(confirm).toHaveBeenCalledWith('Model "typed-model" is not in the codex catalog for reviewer. Apply it anyway?');
    expect((posted[0] as { offCatalogConfirmed: unknown }).offCatalogConfirmed).toEqual({ reviewer: true });
  });

  it("does not send an off-catalog apply when the per-role confirmation is declined", async () => {
    const { document } = fakeDocument();
    const fetcher = vi.fn(async () => response({ resultado: { status: "applied", saved: true } }));
    const controller = createSetupPageController({
      fetcher,
      buildSelection: (values, bindings) => buildSetupSelection(values, bindings, {
        roles: ROLES,
        efforts: REASONING_EFFORTS,
        presets: ORCHESTRATOR_PRESETS,
      }),
      roles: ROLES,
      expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
      document,
      confirm: () => false,
    });
    controller.state.target = { target: { kind: "global" }, bindings: {}, efforts: {} };
    controller.state.catalog = {
      models: [{ agent: "codex", available: true, providers: [{ provider: "openai", models: [] }] }],
      status: "fresh",
      source: "cache",
      ageMs: 0,
      cacheWriteFailed: false,
    };

    await controller.apply(form({
      roles: { ...form().roles, reviewer: { skip: false, binding: "codex:typed-model", effort: "keep" } },
    }));

    expect(fetcher).not.toHaveBeenCalled();
    expect(controller.state.error).toBe("Apply cancelled for the off-catalog model selected for reviewer.");
  });

  it("shows the exact reload and restart message after a protected action returns 403", async () => {
    const { document } = fakeDocument();
    const controller = createSetupPageController({
      fetcher: async (_path, init) => init?.method === "POST"
        ? response({ error: "forbidden" }, 403)
        : response({}),
      buildSelection: (values, bindings) => buildSetupSelection(values, bindings, {
        roles: ROLES,
        efforts: REASONING_EFFORTS,
        presets: ORCHESTRATOR_PRESETS,
      }),
      roles: ROLES,
      expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
      document,
    });
    controller.state.target = { target: { kind: "global" }, bindings: {}, efforts: {} };

    await controller.apply(form());

    expect(controller.state.error).toBe(
      "This CodeDeck session has expired. Reload the page. If it still fails, restart the command and open its new URL.",
    );
  });
});

describe("setup page inline behavior", () => {
  it("runs the injected functions in a clean VM with only browser adapters stubbed", async () => {
    const script = SETUP_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const { document } = fakeDocument();
    const calls: string[] = [];
    const context = {
      fetch: async (path: string) => {
        calls.push(path);
        return path === "/api/setup/state"
          ? response({ target: { kind: "global" }, bindings: {}, efforts: {} })
          : response({ models: [], status: "fresh", source: "cache", ageMs: 10, cacheWriteFailed: false });
      },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      document,
    };

    runInNewContext(script!, context);
    await (context as typeof context & { setupPageReady: Promise<unknown> }).setupPageReady;
    const page = (context as typeof context & { setupPage: ReturnType<typeof createSetupPageController> }).setupPage;
    const selected = page.buildSelection(form());

    expect(calls).toEqual(["/api/setup/state", "/api/setup/catalog"]);
    expect(selected.agents).toEqual({});
    expect(page.state.target?.target.kind).toBe("global");
  });
});
