import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { REASONING_EFFORTS } from "../src/core/driver.js";
import { ROLES, type Role } from "../src/core/roles.js";
import { AGENT_IDS } from "../src/core/session.js";
import type { BatchModelsResult } from "../src/core/models.js";
import { ORCHESTRATOR_PRESETS } from "../src/config/orchestrator-mode.js";
import type { RoleBinding } from "../src/config/config.js";
import {
  buildSetupSelection,
  createSetupPageController,
  SETUP_PAGE,
  SETUP_POLICY_AXES,
  SETUP_ROLE_ORDER,
  SETUP_SESSION_EXPIRED_MESSAGE,
  type SetupPageDocument,
  type SetupPageElement,
  type SetupPageFetchInit,
  type SetupPageFormValues,
  type SetupPageResponse,
  type SetupPageControllerOptions,
  type SetupPageTargetState,
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

type FakeElement = SetupPageElement & { attributes: Map<string, string> };

function fakeDocument(): {
  document: SetupPageDocument;
  elements: Map<string, FakeElement>;
  el(id: string): FakeElement;
} {
  const elements = new Map<string, FakeElement>();
  const document: SetupPageDocument = {
    getElementById(id) {
      let element = elements.get(id);
      if (!element) {
        const attributes = new Map<string, string>();
        element = {
          attributes,
          value: "",
          checked: false,
          disabled: false,
          hidden: false,
          textContent: "",
          innerHTML: "",
          className: "",
          style: {},
          setAttribute(name, value) {
            attributes.set(name, value);
          },
        };
        elements.set(id, element);
      }
      return element;
    },
  };
  return { document, elements, el: (id) => document.getElementById(id) as FakeElement };
}

const CATALOG: BatchModelsResult = {
  models: [
    {
      agent: "claude",
      available: true,
      providers: [{
        provider: "anthropic",
        models: [
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", reasoningEfforts: ["low", "medium", "high"] },
          { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
        ],
      }],
    },
    {
      agent: "codex",
      available: true,
      providers: [{ provider: "openai", models: [{ id: "gpt-known", name: "GPT Known", provider: "openai" }] }],
    },
    { agent: "opencode", available: true, providers: [{ provider: "x", models: [{ id: "qwen", name: "Qwen", provider: "x" }] }] },
    { agent: "omp", available: false, error: "not installed", providers: [] },
  ],
  status: "fresh",
  source: "cache",
  ageMs: 5 * 60_000,
  cacheWriteFailed: false,
};

const STATE: SetupPageTargetState = {
  config: { status: "ok", source: "global", path: "/home/me/.config/run-agent/config.json" },
  target: { kind: "global" },
  bindings: {
    orchestrator: { harness: "opencode", model: "qwen" },
    reviewer: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
  },
  efforts: { reviewer: "high" },
  orchestrator: { ...ORCHESTRATOR_PRESETS.balanced },
  sandbox: "workspace-write",
  autocompact: { enabled: false },
};

type Handler = (path: string, init?: SetupPageFetchInit) => SetupPageResponse | Promise<SetupPageResponse> | undefined;

function makeController(overrides: Partial<SetupPageControllerOptions> = {}, handler: Handler = () => undefined, state = STATE) {
  const fake = fakeDocument();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher: SetupPageControllerOptions["fetcher"] = async (path, init) => {
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(init.body ?? "{}") });
    const handled = await handler(path, init);
    if (handled) return handled;
    if (path === "/api/setup/state") return response(state);
    if (path === "/api/setup/catalog") return response(CATALOG);
    return response({ error: `unexpected ${path}` }, 500);
  };
  const controller = createSetupPageController({
    fetcher,
    buildSelection: (values, bindings) => build(values, bindings),
    roles: SETUP_ROLE_ORDER,
    presets: ORCHESTRATOR_PRESETS,
    efforts: REASONING_EFFORTS,
    harnesses: AGENT_IDS,
    axes: SETUP_POLICY_AXES,
    expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
    document: fake.document,
    ...overrides,
  });
  return { controller, posts, ...fake };
}

function dryRunEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    proposta: { agents: { ...STATE.bindings, reviewer: { harness: "claude", model: "claude-sonnet-5", effort: "low" } }, orchestrator: STATE.orchestrator, defaultSandbox: "workspace-write", autocompact: { enabled: false } },
    validacoes: {
      config: { status: "ok", message: null },
      catalogo: { status: "fresh", message: null },
      bindings: [{ role: "reviewer", harness: "claude", model: "claude-sonnet-5", status: "accepted", message: "" }],
    },
    mudancas: [{ path: "/agents/reviewer/effort", beforePresent: true, before: "high", afterPresent: true, after: "low" }],
    resultado: { status: "dry-run", code: 0, saved: false, message: "Dry run only, no changes were written." },
    ...overrides,
  };
}

describe("setup page markup", () => {
  it("renders the roster, the policy comparison, runtime controls, and the review drawer", () => {
    const order = SETUP_ROLE_ORDER.map((role) => SETUP_PAGE.indexOf(`id="role-row-${role}"`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(SETUP_ROLE_ORDER[0]).toBe("orchestrator");
    for (const role of ROLES) {
      expect(SETUP_PAGE).toContain(`id="binding-${role}" class="model-trigger"`);
      for (const effort of REASONING_EFFORTS) expect(SETUP_PAGE).toContain(`id="effort-${role}-${effort}"`);
    }
    for (const name of ["dispatcher", "balanced", "explorer", "custom"]) {
      expect(SETUP_PAGE).toContain(`id="policy-col-${name}"`);
    }
    for (const axis of SETUP_POLICY_AXES) {
      for (const option of axis.options) {
        expect(SETUP_PAGE).toContain(`id="policy-pick-${axis.key}-${option.value}"`);
        expect(SETUP_PAGE).toContain(`<use href="#i-${option.icon}"></use>`);
      }
    }
    for (const harness of AGENT_IDS) expect(SETUP_PAGE).toContain(`id="hi-${harness}"`);
    expect(SETUP_PAGE).toContain('id="sandbox-workspace-write"');
    expect(SETUP_PAGE).toContain('id="sandbox-danger-full-access"');
    expect(SETUP_PAGE).toContain('id="setup-autocompact" class="switch unset" type="button" role="switch"');
    expect(SETUP_PAGE).toContain('id="orchestrator-parallelism" class="num" type="number"');
    expect(SETUP_PAGE).toContain('id="setup-drawer" class="drawer" role="dialog"');
    expect(SETUP_PAGE).toContain('id="setup-apply" class="btn primary" type="button" data-act="apply" disabled>Save changes</button>');
    expect(SETUP_PAGE).toContain('id="setup-review" class="btn primary" type="button" data-act="review" disabled>Review and save</button>');
    expect(SETUP_PAGE).toContain("prefers-reduced-motion");
    expect(SETUP_PAGE).not.toContain("Custom mix");
    expect(SETUP_PAGE).not.toContain("confirm(");
  });

  it("keeps the standalone topbar pointing at setup only", () => {
    expect(SETUP_PAGE).toContain('href="data:image/svg+xml,');
    expect(SETUP_PAGE).toContain('aria-current="page" class="active">Setup</a>');
    expect(SETUP_PAGE).toContain('href="/setup" aria-label="CodeDeck home"');
    expect(SETUP_PAGE).not.toContain('href="/review"');
    expect(SETUP_PAGE).not.toContain('href="/usage"');
  });
});

describe("setup page controller", () => {
  it("renders the saved bindings, policy, and runtime settings after start", async () => {
    const { controller, el } = makeController();
    await controller.start();

    expect(el("setup-config-path").textContent).toBe(STATE.config!.path);
    expect(el("catalog-status").textContent).toBe("Catalog updated 5 min ago");
    expect(el("binding-reviewer").innerHTML).toContain('data-h="claude"');
    expect(el("binding-reviewer").innerHTML).toContain("claude-sonnet-5");
    expect(el("binding-general").innerHTML).toContain("Choose a model");
    expect(el("role-state-reviewer").innerHTML).toContain("Saved");
    expect(el("role-state-general").innerHTML).toContain("Not set");
    expect(el("effort-reviewer").className).toBe("meter lvl-3");
    expect(el("effort-label-reviewer").textContent).toBe("high");
    expect(el("effort-orchestrator").className).toContain("none");
    expect(el("effort-note-orchestrator").textContent).toBe("opencode sets its own effort");
    expect(el("effort-general").className).toContain("unbound");
    expect(el("effort-reviewer-xhigh").disabled).toBe(true);
    expect(el("effort-reviewer-medium").disabled).toBe(false);

    expect(el("policy-table").className).toBe("cmp col-1");
    expect(el("policy-col-balanced").attributes.get("aria-pressed")).toBe("true");
    expect(el("policy-caption").textContent).toBe("Balanced: reads code to plan, fixes trivial things itself, and can edit files.");
    expect(el("orchestrator-parallelism").disabled).toBe(false);
    expect(el("sandbox-control").className).toBe("seg-ctl at-0");
    expect(el("sandbox-copy").textContent).toBe("Codex workers write only inside their workspace, with no network.");
    expect(el("setup-autocompact").className).toBe("switch");
    expect(el("setup-autocompact").attributes.get("aria-checked")).toBe("false");
    expect(el("setup-action-status").textContent).toBe("All changes saved");
    expect(el("setup-review").disabled).toBe(true);
  });

  it("marks an unset policy, sandbox, and autocompact without inventing values", async () => {
    const { controller, el } = makeController({}, () => undefined, {
      target: { kind: "global" },
      bindings: {},
      efforts: {},
    });
    await controller.start();

    expect(el("policy-table").className).toBe("cmp col-none");
    expect(el("policy-caption").textContent).toBe("Not set. The orchestrator runs as Dispatcher until you choose.");
    expect(el("orchestrator-parallelism").disabled).toBe(true);
    expect(el("orchestrator-parallelism").attributes.get("placeholder")).toBe("Not set");
    expect(el("sandbox-control").className).toBe("seg-ctl at-none");
    expect(el("sandbox-copy").textContent).toBe("Not set. Codex runs with workspace write.");
    expect(el("setup-autocompact").className).toBe("switch unset");
    expect(el("autocompact-copy").textContent).toBe("Not set, so it stays off. CodeDeck leaves compaction to each harness.");
    expect(controller.readForm()).toMatchObject({ orchestrator: "skip", sandbox: "skip", autocompact: "skip" });
    expect(controller.buildSelection()).toEqual({ agents: {} });
  });

  it("tracks role edits in the draft and sends only changed roles", async () => {
    const { controller, el } = makeController();
    await controller.start();

    controller.setEffort("reviewer", "low");
    expect(controller.changeNames()).toEqual(["Reviewer"]);
    expect(el("effort-reviewer").className).toBe("meter lvl-1 changed");
    expect(el("role-state-reviewer").innerHTML).toContain("was <span class=\"mono\">high effort</span>");
    expect(el("setup-action-status").textContent).toBe("1 unsaved change");
    expect(el("setup-change-list").textContent).toBe("Reviewer");
    expect(el("setup-review").disabled).toBe(false);

    controller.selectBinding("general", "codex", "gpt-known");
    const values = controller.readForm();
    expect(values.roles.orchestrator?.skip).toBe(true);
    expect(values.roles.reviewer).toEqual({ skip: false, binding: "claude:claude-sonnet-5", effort: "low" });
    expect(values.roles.general).toEqual({ skip: false, binding: "codex:gpt-known", effort: "keep" });
    expect(controller.buildSelection()).toEqual({
      agents: {
        reviewer: { harness: "claude", model: "claude-sonnet-5", effort: "low" },
        general: { harness: "codex", model: "gpt-known" },
      },
    });

    controller.revertRole("general");
    expect(controller.changeNames()).toEqual(["Reviewer"]);
    controller.discard();
    expect(controller.changeNames()).toEqual([]);
    expect(el("setup-action-status").textContent).toBe("All changes saved");
  });

  it("clamps the carried effort to what the new model supports and restores the saved effort", async () => {
    const { controller } = makeController({}, () => undefined, {
      ...STATE,
      bindings: { ...STATE.bindings, general: { harness: "claude", model: "claude-opus-5-5", effort: "max" } },
      efforts: { ...STATE.efforts, general: "max" },
    });
    await controller.start();

    controller.selectBinding("general", "claude", "claude-sonnet-5");
    expect(controller.draft.agents.general?.effort).toBe("high");
    controller.selectBinding("general", "claude", "claude-opus-5-5");
    expect(controller.draft.agents.general?.effort).toBe("max");
    expect(controller.changeNames()).toEqual([]);
  });

  it("maps presets, custom picks, and parallelism to the orchestrator selection", async () => {
    const { controller, el } = makeController();
    await controller.start();

    controller.choosePreset("explorer");
    expect(el("policy-table").className).toBe("cmp col-2");
    expect(controller.readForm().orchestrator).toBe("explorer");
    expect(controller.buildSelection().orchestrator).toEqual({ ...ORCHESTRATOR_PRESETS.explorer });

    controller.setPolicyValue("tools", "read");
    expect(el("policy-table").className).toBe("cmp col-3");
    expect(el("policy-pick-tools").className).toBe("cmp-picks at-1");
    expect(el("policy-custom-label-tools").textContent).toBe("Read");
    expect(el("policy-fp-line").attributes.get("d")).toBe("M15 3 L15 9 L9 15");
    expect(controller.buildSelection().orchestrator).toEqual({ investigate: "free", selfWork: "small", tools: "read" });

    controller.choosePreset("balanced");
    expect(controller.changeNames()).toEqual([]);
    controller.setParallelism("3");
    expect(controller.changeNames()).toEqual(["Parallel workers"]);
    expect(controller.readForm().orchestrator).toBe("custom");
    expect(controller.buildSelection().orchestrator).toEqual({ ...ORCHESTRATOR_PRESETS.balanced, parallelism: 3 });

    controller.chooseCustom();
    expect(el("policy-table").className).toBe("cmp col-3");
    expect(el("policy-col-custom").attributes.get("aria-pressed")).toBe("true");
  });

  it("sends sandbox and autocompact only when they change", async () => {
    const { controller, el } = makeController();
    await controller.start();

    controller.setSandbox("workspace-write");
    controller.setAutocompact(false);
    expect(controller.readForm()).toMatchObject({ sandbox: "skip", autocompact: "skip" });

    controller.setSandbox("danger-full-access");
    controller.setAutocompact();
    expect(el("sandbox-control").className).toBe("seg-ctl at-1");
    expect(el("sandbox-copy").className).toMatch(/^rt-copy warn/);
    expect(el("setup-autocompact").attributes.get("aria-checked")).toBe("true");
    expect(controller.changeNames()).toEqual(["Sandbox", "Autocompact"]);
    expect(controller.buildSelection()).toEqual({ agents: {}, sandbox: "danger-full-access", autocompact: { enabled: true } });
  });

  it("filters the picker, offers a typed off-catalog entry, and picks with the keyboard", async () => {
    const { controller, el } = makeController();
    await controller.start();

    controller.openPicker("general");
    expect(el("setup-picker").className).toBe("picker open");
    expect(el("setup-picker-list").innerHTML).toContain("Unavailable: not installed");

    controller.setPickerQuery("opus");
    expect(el("setup-picker-list").innerHTML).toContain('data-model="claude-opus-5-5"');
    expect(el("setup-picker-list").innerHTML).not.toContain('data-model="claude-sonnet-5"');

    controller.setPickerQuery("codex:my-local<model>");
    const list = el("setup-picker-list").innerHTML;
    expect(list).toContain("pk-custom");
    expect(list).toContain("codex:my-local&lt;model&gt;");
    expect(list).not.toContain("<model>");

    controller.setPickerQuery("sonnet");
    controller.handleKey({ key: "Enter" });
    expect(el("setup-picker").className).toBe("picker");
    expect(controller.draft.agents.general).toEqual({ harness: "claude", model: "claude-sonnet-5", effort: "" });

    controller.openPicker("auditor");
    controller.handleKey({ key: "Escape" });
    expect(el("setup-picker").className).toBe("picker");
    expect(controller.draft.agents.auditor).toBeUndefined();
  });

  it("reviews the change in the drawer with a truthful diff, checks, and escaped messages", async () => {
    const envelope = dryRunEnvelope({
      proposta: { ...dryRunEnvelope().proposta, activeProfile: "legacy", profiles: { legacy: { secret: "legacy-config" } } },
      validacoes: {
        config: { status: "ok", message: null },
        catalogo: { status: "fresh", message: "<img src=x onerror=alert(1)>" },
        bindings: [{ role: "reviewer", harness: "claude", model: "claude-sonnet-5", status: "accepted", message: "" }],
      },
    });
    const { controller, el, posts } = makeController({}, (path) => path === "/api/setup/dry-run" ? response(envelope) : undefined);
    await controller.start();
    controller.setEffort("reviewer", "low");

    await controller.openReview();

    expect(posts).toEqual([{ path: "/api/setup/dry-run", body: { agents: { reviewer: { harness: "claude", model: "claude-sonnet-5", effort: "low" } } } }]);
    expect(el("setup-drawer").className).toBe("drawer open");
    const markup = el("setup-result").innerHTML;
    const visible = markup.split('<details class="raw-response">')[0]!;
    expect(visible).toContain("Not saved yet");
    expect(visible).toContain("Reviewer effort");
    expect(visible).toContain('<div class="dl minus">');
    expect(visible).toContain('<div class="dl plus">');
    expect(visible).toContain("config.json");
    expect(visible).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(visible).not.toContain("<img");
    expect(visible).not.toContain("profiles");
    expect(visible).not.toContain("activeProfile");
    expect(markup).toContain("legacy-config");
    expect(markup).not.toContain('<details class="raw-response" open>');
    expect(el("setup-apply").disabled).toBe(false);
  });

  it("gates saving an off-catalog model on the drawer confirmation, then reloads the saved state", async () => {
    let saved = false;
    const savedState: SetupPageTargetState = {
      ...STATE,
      bindings: { ...STATE.bindings, general: { harness: "codex", model: "my-local-model" } },
    };
    const { controller, el, posts } = makeController({}, (path) => {
      if (path === "/api/setup/state") return response(saved ? savedState : STATE);
      if (path === "/api/setup/dry-run") {
        return response(dryRunEnvelope({
          validacoes: { bindings: [{ role: "general", harness: "codex", model: "my-local-model", status: "unknown-model", message: "Not in the codex catalog." }] },
          resultado: { status: "error", code: 22, saved: false, message: "Unknown model." },
        }), 422);
      }
      if (path === "/api/setup/apply") {
        saved = true;
        return response({ mudancas: [], resultado: { status: "applied", code: 0, saved: true, message: "Configuration saved." } });
      }
    });
    await controller.start();
    controller.selectBinding("general", "codex", "my-local-model");
    expect(el("binding-general").innerHTML).toContain("not in catalog");

    await controller.openReview();
    expect(controller.state.error).toBeUndefined();
    expect(el("setup-confirmations").innerHTML).toContain('data-act="confirm-off" data-role="general"');
    expect(el("setup-result").innerHTML).toContain("Not saved yet");
    expect(el("setup-apply").disabled).toBe(true);

    await controller.apply();
    expect(controller.state.error).toBe("Confirm the off-catalog model for general before saving.");
    expect(posts.map((post) => post.path)).toEqual(["/api/setup/dry-run"]);

    controller.confirmOffCatalog("general", true);
    expect(el("setup-apply").disabled).toBe(false);
    await controller.apply();

    expect(posts[1]).toEqual({
      path: "/api/setup/apply",
      body: { agents: { general: { harness: "codex", model: "my-local-model" } }, offCatalogConfirmed: { general: true } },
    });
    expect(el("setup-drawer").className).toBe("drawer");
    expect(el("setup-toast").className).toBe("toast show");
    expect(el("setup-toast").innerHTML).toContain(`Saved to ${STATE.config!.path}`);
    expect(controller.changeNames()).toEqual([]);
    expect(el("role-state-general").innerHTML).toContain("Saved");
  });

  it("keeps Save disabled when the dry run fails for a reason the user cannot confirm", async () => {
    const { controller, el } = makeController({}, (path) => path === "/api/setup/dry-run"
      ? response(dryRunEnvelope({
        validacoes: { bindings: [{ role: "general", harness: "omp", model: "x", status: "harness-unavailable", message: "omp is not installed." }] },
        resultado: { status: "error", code: 22, saved: false, message: "Harness unavailable." },
      }), 422)
      : undefined);
    await controller.start();
    controller.selectBinding("general", "omp", "x");

    await controller.openReview();

    expect(controller.state.error).toBe("Harness unavailable.");
    expect(el("setup-result").innerHTML).toContain("Harness unavailable.");
    expect(el("setup-apply").disabled).toBe(true);
  });

  it("disables review and save until state loads and while a request runs", async () => {
    let finishState: ((value: SetupPageResponse) => void) | undefined;
    let finishDryRun: ((value: SetupPageResponse) => void) | undefined;
    const { controller, el } = makeController({}, (path) => {
      if (path === "/api/setup/state") return new Promise((resolve) => { finishState = resolve; });
      if (path === "/api/setup/dry-run") return new Promise((resolve) => { finishDryRun = resolve; });
    });

    const starting = controller.start();
    expect(el("setup-action-status").textContent).toBe("Loading setup");
    expect(el("binding-reviewer").disabled).toBe(true);
    finishState?.(response(STATE));
    await starting;
    expect(el("binding-reviewer").disabled).toBe(false);

    controller.setEffort("reviewer", "low");
    const review = controller.openReview();
    expect(el("setup-action-status").textContent).toBe("Checking changes");
    expect(el("setup-review").disabled).toBe(true);
    expect(el("setup-discard").disabled).toBe(true);
    expect(el("setup-apply").disabled).toBe(true);
    expect(el("setup-result").innerHTML).toContain("Checking your changes");
    finishDryRun?.(response(dryRunEnvelope()));
    await review;
    expect(el("setup-apply").disabled).toBe(false);
    expect(el("setup-review").disabled).toBe(false);
  });

  it("shows discovery while refreshing and retains the previous catalog when discovery is unavailable", async () => {
    let finishRefresh: ((value: SetupPageResponse) => void) | undefined;
    const requests: Array<[string, string]> = [];
    const { document, el } = fakeDocument();
    const controller = createSetupPageController({
      fetcher: async (path, init) => {
        requests.push([path, init?.method ?? "GET"]);
        return new Promise((resolve) => { finishRefresh = resolve; });
      },
      buildSelection: (values, bindings) => build(values, bindings),
      roles: SETUP_ROLE_ORDER,
      expiredMessage: SETUP_SESSION_EXPIRED_MESSAGE,
      document,
    });
    controller.state.catalog = CATALOG;

    const pending = controller.refreshCatalog();
    expect(controller.state.refreshing).toBe(true);
    expect(el("catalog-status").textContent).toBe("Refreshing catalog");
    expect(el("setup-refresh").disabled).toBe(true);
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
    expect(controller.state.catalog).toBe(CATALOG);
    expect(controller.state.discoveryError).toBe("network discovery failed");
    expect(controller.state.refreshing).toBe(false);
    expect(el("catalog-status").className).toMatch(/^catalog-text warn/);
  });

  it("shows the exact reload and restart message after a protected action returns 403", async () => {
    const { controller } = makeController({}, (_path, init) => init?.method === "POST" ? response({ error: "forbidden" }, 403) : undefined);
    await controller.start();

    await controller.apply(form());

    expect(controller.state.error).toBe(
      "This CodeDeck session has expired. Reload the page. If it still fails, restart the command and open its new URL.",
    );
  });
});

describe("setup page selection", () => {
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

  it("rejects a non-positive custom parallelism", () => {
    expect(() => build(form({ orchestrator: "custom", parallelism: "0" }), {})).toThrow("parallelism must be a positive finite number.");
  });
});

describe("setup page inline behavior", () => {
  it("runs the injected functions in a clean VM with only browser adapters stubbed", async () => {
    const script = SETUP_PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
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
      document,
    };

    runInNewContext(script!, context);
    await (context as typeof context & { setupPageReady: Promise<unknown> }).setupPageReady;
    const page = (context as typeof context & { setupPage: ReturnType<typeof createSetupPageController> }).setupPage;

    expect(calls).toEqual(["/api/setup/state", "/api/setup/catalog"]);
    expect(page.buildSelection(form()).agents).toEqual({});
    expect(page.state.target?.target.kind).toBe("global");

    page.choosePreset("balanced");
    expect(page.buildSelection().orchestrator).toEqual({ ...ORCHESTRATOR_PRESETS.balanced });

    await page.refreshCatalog();
    expect(calls).toEqual(["/api/setup/state", "/api/setup/catalog", "POST /api/setup/catalog/refresh"]);
  });
});
