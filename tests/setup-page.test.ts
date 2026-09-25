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
  type SetupPageControllerOptions,
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

function fakeDocument(): {
  document: SetupPageDocument;
  elements: Map<string, SetupPageElement>;
  innerHtmlWrites: Map<string, number>;
  dispatch(id: string, event: string): void;
} {
  const elements = new Map<string, SetupPageElement>();
  const listeners = new Map<string, Map<string, () => void>>();
  const innerHtmlWrites = new Map<string, number>();
  return {
    elements,
    innerHtmlWrites,
    dispatch(id, event) {
      listeners.get(id)?.get(event)?.();
    },
    document: {
      getElementById(id) {
        let element = elements.get(id);
        if (!element) {
          let innerHTML = "";
          element = {
            value: "",
            checked: false,
            disabled: false,
            hidden: false,
            textContent: "",
            get innerHTML() {
              return innerHTML;
            },
            set innerHTML(value) {
              innerHTML = value;
              innerHtmlWrites.set(id, (innerHtmlWrites.get(id) ?? 0) + 1);
            },
            addEventListener(name, callback) {
              let elementListeners = listeners.get(id);
              if (!elementListeners) {
                elementListeners = new Map();
                listeners.set(id, elementListeners);
              }
              elementListeners.set(name, callback);
            },
          };
          elements.set(id, element);
        }
        return element;
      },
    },
  };
}

function makeController(
  document: SetupPageDocument,
  fetcher: SetupPageControllerOptions["fetcher"],
  overrides: Partial<SetupPageControllerOptions> = {},
) {
  return createSetupPageController({
    fetcher,
    buildSelection: (values, bindings) => buildSetupSelection(values, bindings, {
      roles: ROLES,
      efforts: REASONING_EFFORTS,
      presets: ORCHESTRATOR_PRESETS,
    }),
    roles: ROLES,
    presets: ORCHESTRATOR_PRESETS,
    expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
    document,
    ...overrides,
  });
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
    expect(SETUP_PAGE).toContain('href="data:image/svg+xml,');
    expect(SETUP_PAGE).toContain('aria-current="page" class="active">Setup</a>');
    expect(SETUP_PAGE).toContain('href="/setup" aria-label="CodeDeck home"');
    expect(SETUP_PAGE).not.toContain('href="/review"');
    expect(SETUP_PAGE).not.toContain('href="/usage"');
    expect(SETUP_PAGE).toContain('<span class="mode-option mode-keep">Keep current</span>');
    expect(SETUP_PAGE).toContain('<span class="mode-option mode-change">Change</span>');
    expect(SETUP_PAGE).toContain('class="roles"');
    expect(SETUP_PAGE).toContain('<h3 class="role-title">reviewer</h3>');
    expect(SETUP_PAGE).toContain('id="role-fields-reviewer" class="role-fields" hidden>');
    expect(SETUP_PAGE).not.toContain("<fieldset");
    expect(SETUP_PAGE).toContain('class="button primary" type="button" disabled>Apply setup</button>');
    expect(SETUP_PAGE).not.toContain("Skip this role");
    expect(SETUP_PAGE).not.toContain('<pre id="setup-result">');
  });

  it("renders the current bindings and runtime settings as readable values", async () => {
    const { document, elements } = fakeDocument();
    const controller = makeController(document, async (path) => path === "/api/setup/state"
      ? response({
        target: { kind: "global" },
        bindings: { reviewer: { harness: "codex", model: "model<one>", effort: "high" } },
        efforts: { reviewer: "high" },
        orchestrator: { ...ORCHESTRATOR_PRESETS.balanced },
        sandbox: "workspace-write",
        autocompact: { enabled: false },
      })
      : response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false }));
    await controller.start();

    expect(elements.get("current-binding-reviewer")?.innerHTML).toContain('<span class="pill harness-pill">codex</span>');
    expect(elements.get("current-binding-reviewer")?.innerHTML).toContain("model&lt;one&gt;");
    expect(elements.get("current-binding-reviewer")?.innerHTML).toContain("high effort");
    expect(elements.get("current-binding-general")?.innerHTML).toContain("not set");
    expect(elements.get("current-orchestrator")?.textContent).toBe("balanced");
    expect(elements.get("current-sandbox")?.textContent).toBe("workspace-write");
    expect(SETUP_PAGE).toContain('id="current-sandbox" class="current-text mono-value"');
    expect(elements.get("current-autocompact")?.textContent).toBe("off");
    expect(elements.get("current-orchestrator")?.textContent).not.toContain("{");
    expect(elements.get("current-autocompact")?.textContent).not.toContain("{");
  });

  it("keeps every role unchanged by default and prefills the current binding and effort", async () => {
    const { document, elements, dispatch } = fakeDocument();
    const controller = makeController(document, async (path) => path === "/api/setup/state"
      ? response({
        target: { kind: "global" },
        bindings: {
          general: { harness: "claude", model: "gpt-no-effort" },
          reviewer: { harness: "codex", model: "gpt-current", effort: "low" },
        },
        efforts: { reviewer: "low" },
      })
      : response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false }));
    for (const id of ["orchestrator-mode", "setup-sandbox", "setup-autocompact"]) {
      elements.set(id, { value: "skip" });
    }

    await controller.start();

    expect(elements.get("skip-reviewer")?.checked).toBe(true);
    expect(elements.get("role-fields-reviewer")?.hidden).toBe(true);
    expect(elements.get("binding-reviewer")?.value).toBe("codex:gpt-current");
    expect(elements.get("binding-reviewer")?.disabled).toBe(true);
    expect(elements.get("effort-reviewer")?.value).toBe("low");
    expect(elements.get("skip-general")?.checked).toBe(true);
    expect(elements.get("binding-general")?.value).toBe("claude:gpt-no-effort");
    expect(elements.get("effort-general")?.value).toBe("keep");
    expect(elements.get("skip-auditor")?.checked).toBe(true);
    expect(elements.get("role-fields-auditor")?.hidden).toBe(true);
    expect(elements.get("binding-auditor")?.value).toBe("");
    expect(elements.get("effort-auditor")?.value).toBe("keep");
    expect(elements.get("setup-action-status")?.textContent).toBe("No changes selected");

    elements.get("skip-reviewer")!.checked = false;
    dispatch("skip-reviewer", "change");
    expect(elements.get("role-fields-reviewer")?.hidden).toBe(false);
    expect(elements.get("binding-reviewer")?.disabled).toBe(false);
    expect(elements.get("setup-action-status")?.textContent).toBe("1 role set to change");

    elements.get("effort-reviewer")!.value = "high";
    const selected = controller.buildSelection();
    expect(selected).toEqual({ agents: { reviewer: { harness: "codex", model: "gpt-current", effort: "high" } } });
  });

  it("describes an unmatched orchestrator as custom with readable fields", async () => {
    const { document, elements } = fakeDocument();
    const controller = makeController(document, async (path) => path === "/api/setup/state"
      ? response({
        target: { kind: "global" },
        bindings: {},
        orchestrator: { investigate: "read", selfWork: "trivial", tools: "edit", parallelism: 3 },
      })
      : response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false }));

    await controller.start();

    expect(elements.get("current-orchestrator")?.textContent).toBe(
      "custom · investigate: read only · self work: trivial tasks · tools: edit · parallelism: 3",
    );
  });

  it("renders change rows, status, validations, escaped messages, and collapsed raw data", async () => {
    const { document, elements } = fakeDocument();
    const payload = {
      proposta: { activeProfile: "legacy", profiles: { legacy: { secret: "legacy-config" } } },
      validacoes: {
        config: { status: "ok", message: null },
        catalogo: { status: "fresh", message: "<img src=x onerror=alert(1)>" },
        bindings: [{ role: "reviewer", harness: "codex", model: "known", status: "accepted", message: "Model recognized" }],
      },
      mudancas: [
        { path: "/agents/reviewer/effort", beforePresent: true, before: "low", afterPresent: true, after: "high" },
        { path: "/agents/reviewer/model", beforePresent: false, before: null, afterPresent: true, after: "<script>bad()</script>" },
        { path: "/agents/auditor/model", beforePresent: true, before: "old-model", afterPresent: false, after: null },
      ],
      resultado: { status: "dry-run", code: 0, saved: false, message: "Dry run only, no changes were written." },
    };
    const controller = makeController(document, async (path) => path === "/api/setup/state"
      ? response({ target: { kind: "global" }, bindings: {}, efforts: {} })
      : path === "/api/setup/catalog"
        ? response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false })
        : response(payload));

    await controller.start();
    await controller.dryRun(form());

    const markup = elements.get("setup-result")?.innerHTML ?? "";
    const visiblePreview = markup.split('<details class="raw-response">')[0];
    expect(visiblePreview).toContain("Preview only, nothing written");
    expect(visiblePreview).toContain("reviewer · effort");
    expect(visiblePreview).toContain("low");
    expect(visiblePreview).toContain("→");
    expect(visiblePreview).toContain("high");
    expect(visiblePreview).toContain("Added");
    expect(visiblePreview).toContain("Removed");
    expect(visiblePreview).toContain("Config · ok");
    expect(visiblePreview).toContain("Catalog · fresh");
    expect(visiblePreview).toContain("reviewer · codex:known · accepted");
    expect(visiblePreview).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(visiblePreview).not.toContain("<img");
    expect(visiblePreview).not.toContain("<script>");
    expect(visiblePreview).not.toContain("proposta");
    expect(visiblePreview).not.toContain("profiles");
    expect(visiblePreview).not.toContain("activeProfile");
    expect(markup).toContain("legacy-config");
    expect(markup).toContain("<details class=\"raw-response\">");
    expect(markup).not.toContain("<details class=\"raw-response\" open>");
  });

  it("preserves the rendered raw preview on form updates and refreshes it for a new response", async () => {
    const { document, elements, innerHtmlWrites, dispatch } = fakeDocument();
    const envelopes = [
      { mudancas: [], resultado: { status: "dry-run", code: 0, saved: false, message: "First preview" } },
      { mudancas: [], resultado: { status: "dry-run", code: 0, saved: false, message: "Second preview" } },
    ];
    let actionIndex = 0;
    const controller = makeController(document, async (path) => path === "/api/setup/state"
      ? response({ target: { kind: "global" }, bindings: {}, efforts: {} })
      : path === "/api/setup/catalog"
        ? response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false })
        : response(envelopes[actionIndex++]!));

    await controller.start();
    await controller.dryRun(form());
    const writesAfterPreview = innerHtmlWrites.get("setup-result");
    expect(elements.get("setup-result")?.innerHTML).toContain("First preview");

    elements.get("binding-reviewer")!.value = "codex:model";
    dispatch("binding-reviewer", "input");
    expect(innerHtmlWrites.get("setup-result")).toBe(writesAfterPreview);

    await controller.dryRun(form());
    expect(elements.get("setup-result")?.innerHTML).toContain("Second preview");
    expect(innerHtmlWrites.get("setup-result")).toBe((writesAfterPreview ?? 0) + 1);
  });

  it("renders saved, unchanged, error, and no-change result states", async () => {
    const { document, elements } = fakeDocument();
    let payload: Record<string, unknown> = {
      mudancas: [],
      resultado: { status: "applied", code: 0, saved: true, message: "Configuration saved." },
    };
    const controller = makeController(document, async (path) => path === "/api/setup/state"
      ? response({ target: { kind: "global" }, bindings: {}, efforts: {} })
      : path === "/api/setup/catalog"
        ? response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false })
        : response(payload));

    await controller.start();
    await controller.apply(form());
    expect(elements.get("setup-result")?.innerHTML).toContain("Saved");
    expect(elements.get("setup-result")?.innerHTML).toContain("No changes");

    payload = { mudancas: [], resultado: { status: "unchanged", code: 0, saved: false, message: "Configuration unchanged." } };
    await controller.dryRun(form());
    expect(elements.get("setup-result")?.innerHTML).toContain("Unchanged");
    expect(elements.get("setup-result")?.innerHTML).toContain("Configuration unchanged.");

    payload = { mudancas: [], resultado: { status: "error", code: 15, saved: false, message: "Config write failed." } };
    await controller.apply(form());
    expect(elements.get("setup-result")?.innerHTML).toContain("Error");
    expect(elements.get("setup-result")?.innerHTML).toContain("Config write failed.");
  });

  it("keeps Preview and Apply disabled until loaded and during a request", async () => {
    const { document, elements } = fakeDocument();
    let finishState: ((value: SetupPageResponse) => void) | undefined;
    let finishDryRun: ((value: SetupPageResponse) => void) | undefined;
    let finishApply: ((value: SetupPageResponse) => void) | undefined;
    const controller = makeController(document, async (path) => {
      if (path === "/api/setup/state") return await new Promise((resolve) => { finishState = resolve; });
      if (path === "/api/setup/catalog") return response({ models: [], status: "fresh", source: "cache", ageMs: 0, cacheWriteFailed: false });
      return await new Promise((resolve) => {
        if (path.endsWith("/dry-run")) finishDryRun = resolve;
        else finishApply = resolve;
      });
    });

    const starting = controller.start();
    expect(elements.get("setup-dry-run")?.disabled).toBe(true);
    expect(elements.get("setup-apply")?.disabled).toBe(true);

    finishState?.(response({ target: { kind: "global" }, bindings: {}, efforts: {} }));
    await starting;
    expect(elements.get("setup-dry-run")?.disabled).toBe(false);
    expect(elements.get("setup-apply")?.disabled).toBe(false);

    const preview = controller.dryRun(form());
    expect(elements.get("setup-dry-run")?.disabled).toBe(true);
    expect(elements.get("setup-apply")?.disabled).toBe(true);
    expect(elements.get("setup-action-status")?.textContent).toBe("Preparing preview...");
    finishDryRun?.(response({ mudancas: [], resultado: { status: "dry-run", code: 0, saved: false, message: "" } }));
    await preview;
    expect(elements.get("setup-dry-run")?.disabled).toBe(false);
    expect(elements.get("setup-apply")?.disabled).toBe(false);

    const apply = controller.apply(form());
    expect(elements.get("setup-dry-run")?.disabled).toBe(true);
    expect(elements.get("setup-apply")?.disabled).toBe(true);
    expect(elements.get("setup-action-status")?.textContent).toBe("Saving setup...");
    finishApply?.(response({ mudancas: [], resultado: { status: "applied", code: 0, saved: true, message: "" } }));
    await apply;
    expect(elements.get("setup-dry-run")?.disabled).toBe(false);
    expect(elements.get("setup-apply")?.disabled).toBe(false);
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
    const requests: Array<[string, string]> = [];
    const previousCatalog = {
      models: [{ agent: "codex", available: true, providers: [{ provider: "openai", models: [] }] }],
      status: "fresh" as const,
      source: "cache" as const,
      ageMs: 50,
      cacheWriteFailed: false,
    };
    const controller = createSetupPageController({
      fetcher: async (path, init) => {
        requests.push([path, init?.method ?? "GET"]);
        return new Promise((resolve) => { finishRefresh = resolve; });
      },
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

    expect(requests).toEqual([["/api/setup/catalog/refresh", "POST"]]);
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
  function pageContext(search: string) {
    const { document } = fakeDocument();
    const calls: string[] = [];
    const context = {
      fetch: async (path: string, init?: { method?: string }) => {
        calls.push(init?.method ? `${init.method} ${path}` : path);
        return path === "/api/setup/state"
          ? response({ target: { kind: "global" }, bindings: {}, efforts: {} })
          : response({ models: [], status: "fresh", source: "cache", ageMs: 10, cacheWriteFailed: false });
      },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      location: { search },
      URLSearchParams,
      document,
    };
    return { calls, context };
  }

  it.each([
    ["with refresh=1", "?refresh=1", ["/api/setup/state", "/api/setup/catalog", "POST /api/setup/catalog/refresh"]],
    ["without refresh", "", ["/api/setup/state", "/api/setup/catalog"]],
  ])("refreshes the catalog once after the initial load only %s", async (_label, search, expected) => {
    const script = SETUP_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const { calls, context } = pageContext(search);

    runInNewContext(script!, context);
    await (context as typeof context & { setupPageReady: Promise<unknown> }).setupPageReady;
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual(expected);
  });

  it("runs the injected functions in a clean VM with only browser adapters stubbed", async () => {
    const script = SETUP_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const { calls, context } = pageContext("");

    runInNewContext(script!, context);
    await (context as typeof context & { setupPageReady: Promise<unknown> }).setupPageReady;
    const page = (context as typeof context & { setupPage: ReturnType<typeof createSetupPageController> }).setupPage;
    const selected = page.buildSelection(form());

    expect(calls).toEqual(["/api/setup/state", "/api/setup/catalog"]);
    expect(selected.agents).toEqual({});
    expect(page.state.target?.target.kind).toBe("global");

    await page.refreshCatalog();
    expect(calls).toEqual(["/api/setup/state", "/api/setup/catalog", "POST /api/setup/catalog/refresh"]);
  });
});
