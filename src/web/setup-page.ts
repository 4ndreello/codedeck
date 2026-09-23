import { REASONING_EFFORTS } from "../core/driver.js";
import { ROLES, type Role } from "../core/roles.js";
import type { BatchModelsResult } from "../core/models.js";
import type { RoleBinding, RunAgentConfig } from "../config/config.js";
import { ORCHESTRATOR_PRESETS, type OrchestratorMode } from "../config/orchestrator-mode.js";
import type { SetupSelection } from "../config/setup.js";

export const SETUP_SESSION_EXPIRED_MESSAGE =
  "This CodeDeck session has expired. Reload the page. If it still fails, restart the command and open its new URL.";

export interface SetupRoleFormValue {
  skip: boolean;
  binding: string;
  effort: string;
}

export interface SetupPageFormValues {
  roles: Partial<Record<Role, SetupRoleFormValue>>;
  orchestrator: string;
  investigate: string;
  selfWork: string;
  tools: string;
  parallelism: string;
  sandbox: string;
  autocompact: string;
}

export interface SetupPageSelectionOptions {
  roles: readonly Role[];
  efforts: readonly string[];
  presets: Record<string, OrchestratorMode>;
}

export function buildSetupSelection(
  values: SetupPageFormValues,
  currentBindings: Partial<Record<Role, RoleBinding>>,
  options: SetupPageSelectionOptions,
): SetupSelection {
  const agents: Partial<Record<Role, RoleBinding>> = {};

  for (const role of options.roles) {
    const selected = values.roles[role];
    if (!selected || selected.skip) continue;

    const separator = selected.binding.indexOf(":");
    const harness = separator < 0 ? "" : selected.binding.slice(0, separator).trim();
    const model = separator < 0 ? "" : selected.binding.slice(separator + 1).trim();
    if (!harness || !model) throw new Error(`Enter a harness:model value for ${role}.`);

    const previous = currentBindings[role];
    const sameBinding = previous?.harness === harness && previous.model === model;
    let effort: string | undefined;
    const effortValue = selected.effort.trim();
    if (harness === "opencode") {
      if (sameBinding) effort = previous?.effort;
    } else if (effortValue === "" || effortValue === "keep") {
      if (sameBinding) effort = previous?.effort;
    } else if (options.efforts.includes(effortValue)) {
      effort = effortValue;
    } else {
      throw new Error(`Choose a supported effort value for ${role}.`);
    }

    agents[role] = {
      harness: harness as RoleBinding["harness"],
      model,
      ...(effort === undefined ? {} : { effort: effort as RoleBinding["effort"] }),
    };
  }

  let orchestrator: OrchestratorMode | undefined;
  if (values.orchestrator !== "skip") {
    const preset = options.presets[values.orchestrator];
    if (preset) {
      orchestrator = { ...preset };
    } else if (values.orchestrator === "custom") {
      if (
        !["none", "read", "free"].includes(values.investigate) ||
        !["none", "trivial", "small"].includes(values.selfWork) ||
        !["dispatch", "read", "edit"].includes(values.tools)
      ) {
        throw new Error("Choose valid custom orchestrator parameters.");
      }
      const parallelismValue = values.parallelism.trim();
      const parallelism = parallelismValue === "" ? undefined : Number(parallelismValue);
      if (parallelism !== undefined && (!Number.isFinite(parallelism) || parallelism <= 0)) {
        throw new Error("parallelism must be a positive finite number.");
      }
      orchestrator = {
        investigate: values.investigate as OrchestratorMode["investigate"],
        selfWork: values.selfWork as OrchestratorMode["selfWork"],
        tools: values.tools as OrchestratorMode["tools"],
        ...(parallelism === undefined ? {} : { parallelism }),
      };
    } else {
      throw new Error("Choose an orchestrator preset or custom mode.");
    }
  }

  let sandbox: SetupSelection["sandbox"];
  if (values.sandbox === "workspace-write" || values.sandbox === "danger-full-access") {
    sandbox = values.sandbox;
  } else if (values.sandbox !== "skip") {
    throw new Error("Choose a supported sandbox value.");
  }

  let autocompact: SetupSelection["autocompact"];
  if (values.autocompact === "on") autocompact = { enabled: true };
  else if (values.autocompact === "off") autocompact = { enabled: false };
  else if (values.autocompact !== "skip") throw new Error("Choose on or off for autocompact.");

  return {
    agents,
    ...(orchestrator === undefined ? {} : { orchestrator }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(autocompact === undefined ? {} : { autocompact }),
  };
}

export interface SetupPageElement {
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  textContent?: string | null;
  innerHTML?: string;
  addEventListener?(name: string, callback: () => void): void;
}

export interface SetupPageDocument {
  getElementById(id: string): SetupPageElement | null;
}

export interface SetupPageResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface SetupPageFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface SetupPageControllerOptions {
  fetcher: (url: string, init?: SetupPageFetchInit) => Promise<SetupPageResponse>;
  buildSelection: (
    values: SetupPageFormValues,
    currentBindings: Partial<Record<Role, RoleBinding>>,
  ) => ReturnType<typeof buildSetupSelection>;
  roles: readonly Role[];
  expiredMessage: string;
  document?: SetupPageDocument;
  confirm?: (message: string) => boolean;
  onChange?: (state: SetupPageClientState) => void;
}

export interface SetupPageTargetState {
  target: { kind: "global" | "profile"; profile?: string };
  bindings: Partial<Record<Role, RoleBinding>>;
  efforts: Partial<Record<Role, string>>;
  orchestrator?: OrchestratorMode;
  sandbox?: RunAgentConfig["defaultSandbox"];
  autocompact?: RunAgentConfig["autocompact"];
}

export interface SetupPageClientState {
  target?: SetupPageTargetState;
  catalog?: BatchModelsResult;
  discoveryError?: string;
  refreshing: boolean;
  loading: boolean;
  error?: string;
  envelope?: unknown;
}

export function createSetupPageController(options: SetupPageControllerOptions) {
  const state: SetupPageClientState = { refreshing: false, loading: true };
  let refreshInFlight: Promise<unknown> | undefined;
  const element = (id: string) => options.document?.getElementById(id) ?? null;

  function update(): void {
    const status = element("setup-status");
    if (status) {
      status.textContent = state.error ?? (state.refreshing
        ? "Discovering models..."
        : state.loading
          ? "Loading setup..."
          : "Setup loaded.");
    }
    const targetLabel = element("setup-target");
    if (targetLabel && state.target) {
      targetLabel.textContent = state.target.target.kind === "profile"
        ? `Profile: ${state.target.target.profile ?? ""}`
        : "Global configuration";
    }
    const catalogLabel = element("catalog-status");
    if (catalogLabel) {
      const catalogStatus = state.catalog?.status ?? "not loaded";
      catalogLabel.textContent = state.discoveryError
        ? `${catalogStatus}: ${state.discoveryError}`
        : catalogStatus;
    }
    const refreshButton = element("setup-refresh");
    if (refreshButton) refreshButton.disabled = state.refreshing;
    const result = element("setup-result");
    if (result) result.textContent = state.envelope === undefined ? "" : JSON.stringify(state.envelope, null, 2);
    const currentOrchestrator = element("current-orchestrator");
    if (currentOrchestrator && state.target) {
      currentOrchestrator.textContent = state.target.orchestrator === undefined
        ? "not set"
        : JSON.stringify(state.target.orchestrator);
    }
    const currentSandbox = element("current-sandbox");
    if (currentSandbox && state.target) currentSandbox.textContent = state.target.sandbox ?? "not set";
    const currentAutocompact = element("current-autocompact");
    if (currentAutocompact && state.target) {
      currentAutocompact.textContent = state.target.autocompact === undefined
        ? "not set"
        : JSON.stringify(state.target.autocompact);
    }

    for (const role of options.roles) {
      const skip = element(`skip-${role}`);
      const binding = element(`binding-${role}`);
      const effort = element(`effort-${role}`);
      const skipped = Boolean(skip?.checked);
      if (binding) binding.disabled = skipped;
      const harness = (binding?.value ?? "").split(":", 1)[0].trim();
      const noEffort = harness === "opencode";
      if (effort) {
        effort.disabled = skipped || noEffort;
        effort.hidden = noEffort;
      }
    }

    const custom = element("orchestrator-custom");
    if (custom) custom.hidden = element("orchestrator-mode")?.value !== "custom";
    options.onChange?.(state);
  }

  function fillCatalogChoices(): void {
    const catalog = state.catalog;
    for (const role of options.roles) {
      const list = element(`catalog-models-${role}`);
      if (!list) continue;
      const choices = (catalog?.models ?? []).flatMap((harness) =>
        harness.providers.flatMap((provider) => provider.models.flatMap((model) => {
          const values = [model.id, ...(model.aliases ?? [])].filter((value) => value.trim() !== "");
          return values.map((value) => `${harness.agent}:${value}`);
        })),
      );
      list.innerHTML = [...new Set(choices)]
        .map((value) => `<option value="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"></option>`)
        .join("");
    }
  }

  function prefillTarget(): void {
    const target = state.target;
    if (!target) return;
    for (const role of options.roles) {
      const binding = target.bindings[role];
      const skip = element(`skip-${role}`);
      const bindingInput = element(`binding-${role}`);
      const effort = element(`effort-${role}`);
      if (skip) skip.checked = binding === undefined;
      if (bindingInput) bindingInput.value = binding === undefined ? "" : `${binding.harness}:${binding.model}`;
      if (effort) effort.value = "keep";
    }
    update();
  }

  function readForm(): SetupPageFormValues {
    const roles: SetupPageFormValues["roles"] = {};
    for (const role of options.roles) {
      roles[role] = {
        skip: Boolean(element(`skip-${role}`)?.checked),
        binding: element(`binding-${role}`)?.value ?? "",
        effort: element(`effort-${role}`)?.value ?? "keep",
      };
    }
    return {
      roles,
      orchestrator: element("orchestrator-mode")?.value ?? "skip",
      investigate: element("orchestrator-investigate")?.value ?? "none",
      selfWork: element("orchestrator-self-work")?.value ?? "none",
      tools: element("orchestrator-tools")?.value ?? "dispatch",
      parallelism: element("orchestrator-parallelism")?.value ?? "",
      sandbox: element("setup-sandbox")?.value ?? "skip",
      autocompact: element("setup-autocompact")?.value ?? "skip",
    };
  }

  function bindEvents(): void {
    for (const role of options.roles) {
      element(`skip-${role}`)?.addEventListener?.("change", update);
      element(`binding-${role}`)?.addEventListener?.("input", update);
    }
    element("orchestrator-mode")?.addEventListener?.("change", update);
    element("setup-refresh")?.addEventListener?.("click", () => { void refreshCatalog(); });
    element("setup-dry-run")?.addEventListener?.("click", () => { void dryRun(); });
    element("setup-apply")?.addEventListener?.("click", () => { void apply(); });
  }

  async function loadJson(
    path: string,
    init?: SetupPageFetchInit,
  ): Promise<{ response: SetupPageResponse; payload: Record<string, unknown> }> {
    const response = await options.fetcher(path, init);
    const payload = await response.json();
    return {
      response,
      payload: typeof payload === "object" && payload !== null
        ? payload as Record<string, unknown>
        : {},
    };
  }

  async function start(): Promise<SetupPageClientState> {
    bindEvents();
    try {
      const { response, payload } = await loadJson("/api/setup/state");
      if (!response.ok) {
        state.error = typeof payload.error === "string" ? payload.error : "Could not load setup state.";
        state.loading = false;
        update();
        return state;
      }
      state.target = payload as unknown as SetupPageTargetState;
      prefillTarget();
      const catalog = await loadJson("/api/setup/catalog");
      if (catalog.response.ok) {
        state.catalog = catalog.payload as unknown as BatchModelsResult;
        state.discoveryError = typeof catalog.payload.discoveryError === "string" ? catalog.payload.discoveryError : undefined;
        fillCatalogChoices();
      } else {
        state.discoveryError = typeof catalog.payload.error === "string" ? catalog.payload.error : "Could not load model catalog.";
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    state.loading = false;
    update();
    return state;
  }

  function refreshCatalog(): Promise<unknown> {
    if (refreshInFlight) return refreshInFlight;
    state.error = undefined;
    state.discoveryError = undefined;
    state.refreshing = true;
    update();
    refreshInFlight = (async () => {
      try {
        const { response, payload } = await loadJson("/api/setup/catalog/refresh", { method: "POST" });
        if (response.status === 403) {
          state.error = options.expiredMessage;
          return { ok: false, status: 403, payload };
        }
        if (!response.ok) {
          state.discoveryError = typeof payload.error === "string" ? payload.error : "Catalog refresh failed.";
          return { ok: false, status: response.status, payload };
        }
        if (payload.status === "unavailable") {
          state.discoveryError = typeof payload.discoveryError === "string" ? payload.discoveryError : "Catalog unavailable.";
          return { ok: true, status: response.status, payload };
        }
        state.catalog = payload as unknown as BatchModelsResult;
        state.discoveryError = typeof payload.discoveryError === "string" ? payload.discoveryError : undefined;
        fillCatalogChoices();
        return { ok: true, status: response.status, payload };
      } catch (error) {
        state.discoveryError = error instanceof Error ? error.message : String(error);
        return { ok: false, status: 500, payload: { error: state.discoveryError } };
      } finally {
        state.refreshing = false;
        refreshInFlight = undefined;
        update();
      }
    })();
    return refreshInFlight;
  }

  function buildSelection(values: SetupPageFormValues = readForm()): ReturnType<typeof buildSetupSelection> {
    if (!state.target) throw new Error("Setup state is not loaded.");
    return options.buildSelection(values, state.target.bindings);
  }

  async function postAction(
    path: string,
    selection: ReturnType<typeof buildSetupSelection>,
  ): Promise<{ ok: boolean; status: number; payload: unknown }> {
    state.error = undefined;
    try {
      const response = await options.fetcher(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selection),
      });
      const payload = await response.json();
      if (response.status === 403) {
        state.error = options.expiredMessage;
      } else if (!response.ok) {
        const body = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
        const result = typeof body.resultado === "object" && body.resultado !== null
          ? body.resultado as Record<string, unknown>
          : {};
        state.error = typeof result.message === "string"
          ? result.message
          : typeof body.error === "string"
            ? body.error
            : "Setup request failed.";
      }
      state.envelope = payload;
      update();
      return { ok: response.ok, status: response.status, payload };
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      update();
      return { ok: false, status: 500, payload: { error: state.error } };
    }
  }

  async function dryRun(values: SetupPageFormValues = readForm()): Promise<{ ok: boolean; status: number; payload: unknown } | undefined> {
    try {
      return await postAction("/api/setup/dry-run", buildSelection(values));
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      update();
    }
  }

  async function apply(values: SetupPageFormValues = readForm()): Promise<{ ok: boolean; status: number; payload: unknown } | undefined> {
    let selection: ReturnType<typeof buildSetupSelection>;
    try {
      selection = buildSelection(values);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      update();
      return;
    }

    const confirmed: Partial<Record<Role, boolean>> = {};
    for (const role of options.roles) {
      const binding = selection.agents[role];
      const previous = state.target?.bindings[role];
      if (!binding || (previous?.harness === binding.harness && previous.model === binding.model)) continue;
      const harness = state.catalog?.models.find((candidate) => candidate.agent === binding.harness);
      if (!harness?.available) continue;
      const listed = harness.providers.some((provider) => provider.models.some((model) =>
        model.id === binding.model || model.aliases?.includes(binding.model),
      ));
      if (listed) continue;
      const accept = options.confirm?.(
        `Model "${binding.model}" is not in the ${binding.harness} catalog for ${role}. Apply it anyway?`,
      ) ?? false;
      if (!accept) {
        state.error = `Apply cancelled for the off-catalog model selected for ${role}.`;
        update();
        return;
      }
      confirmed[role] = true;
    }
    if (Object.keys(confirmed).length > 0) selection.offCatalogConfirmed = confirmed;
    return await postAction("/api/setup/apply", selection);
  }

  return { state, start, refreshCatalog, buildSelection, dryRun, apply };
}

const roleControls = ROLES.map((role) => `
      <fieldset class="role-card">
        <legend>${role}</legend>
        <label class="skip-label"><input id="skip-${role}" type="checkbox"> Skip this role</label>
        <label for="binding-${role}">Harness:model</label>
        <input id="binding-${role}" type="text" list="catalog-models-${role}" placeholder="claude:sonnet" autocomplete="off">
        <datalist id="catalog-models-${role}"></datalist>
        <label for="effort-${role}">Reasoning effort</label>
        <select id="effort-${role}">
          <option value="keep">Keep current</option>
          ${REASONING_EFFORTS.map((effort) => `<option value="${effort}">${effort}</option>`).join("")}
        </select>
      </fieldset>`).join("");

export const SETUP_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CodeDeck setup</title>
  <style>
    :root { color-scheme: dark; font: 15px/1.5 system-ui, sans-serif; background: #111318; color: #e7e9ee; }
    * { box-sizing: border-box; }
    body { margin: 0 auto; max-width: 1080px; padding: 32px 20px 64px; }
    h1, h2 { margin: 0 0 12px; line-height: 1.2; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.2rem; margin-top: 28px; }
    p { color: #b7bdc9; }
    .panel, .role-card { border: 1px solid #343944; border-radius: 10px; background: #191d24; padding: 16px; }
    .roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
    .role-card { min-width: 0; }
    legend { font-weight: 700; padding: 0 6px; }
    label { display: block; margin: 12px 0 5px; color: #d2d7e0; }
    .skip-label { margin: 0 0 10px; }
    input[type="text"], input[type="number"], select { width: 100%; border: 1px solid #454c59; border-radius: 6px; background: #101319; color: inherit; padding: 9px 10px; }
    input:disabled, select:disabled { opacity: .55; }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0; }
    button { border: 1px solid #5c6c8b; border-radius: 6px; background: #27334a; color: #fff; padding: 9px 14px; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .6; }
    #setup-status { min-height: 1.5em; color: #d6deef; }
    #setup-result { overflow: auto; max-height: 430px; border: 1px solid #343944; border-radius: 8px; background: #0d1015; padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .muted { color: #9da6b5; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <h1>CodeDeck setup</h1>
    <p>Review the current target, prepare a proposal, then apply it.</p>
    <section class="panel" aria-live="polite">
      <strong id="setup-target">Loading target...</strong>
      <p id="setup-status">Loading setup...</p>
      <p>Model catalog: <span id="catalog-status">not loaded</span></p>
      <button id="setup-refresh" type="button">Refresh model catalog</button>
    </section>

    <h2>Role bindings</h2>
    <section class="roles">${roleControls}
    </section>

    <h2>Orchestrator</h2>
    <section class="panel">
      <p class="muted">Current: <span id="current-orchestrator">unchanged</span></p>
      <label for="orchestrator-mode">Selection</label>
      <select id="orchestrator-mode">
        <option value="skip">Keep current</option>
        <option value="dispatcher">dispatcher</option>
        <option value="balanced">balanced</option>
        <option value="explorer">explorer</option>
        <option value="custom">custom</option>
      </select>
      <div id="orchestrator-custom" class="row" hidden>
        <div><label for="orchestrator-investigate">Investigate</label><select id="orchestrator-investigate"><option>none</option><option>read</option><option>free</option></select></div>
        <div><label for="orchestrator-self-work">Self work</label><select id="orchestrator-self-work"><option>none</option><option>trivial</option><option>small</option></select></div>
        <div><label for="orchestrator-tools">Tools</label><select id="orchestrator-tools"><option>dispatch</option><option>read</option><option>edit</option></select></div>
        <div><label for="orchestrator-parallelism">Parallelism (optional)</label><input id="orchestrator-parallelism" type="number" min="0.0000001" step="any" placeholder="No limit"></div>
      </div>
    </section>

    <h2>Other settings</h2>
    <section class="panel row">
      <div><p class="muted">Current sandbox: <span id="current-sandbox">not set</span></p><label for="setup-sandbox">Sandbox</label><select id="setup-sandbox"><option value="skip">Keep current</option><option value="workspace-write">workspace-write</option><option value="danger-full-access">danger-full-access</option></select></div>
      <div><p class="muted">Current autocompact: <span id="current-autocompact">not set</span></p><label for="setup-autocompact">Autocompact</label><select id="setup-autocompact"><option value="skip">Keep current</option><option value="on">On</option><option value="off">Off</option></select></div>
    </section>

    <div class="actions">
      <button id="setup-dry-run" type="button">Preview changes</button>
      <button id="setup-apply" type="button">Apply setup</button>
    </div>
    <h2>Proposal</h2>
    <pre id="setup-result"></pre>
  </main>
  <script>
    ${buildSetupSelection.toString()}
    ${createSetupPageController.toString()}
    globalThis.setupPage = createSetupPageController({
      fetcher: (url, init) => fetch(url, init),
      buildSelection: (values, bindings) => buildSetupSelection(values, bindings, {
        roles: ${JSON.stringify(ROLES)},
        efforts: ${JSON.stringify(REASONING_EFFORTS)},
        presets: ${JSON.stringify(ORCHESTRATOR_PRESETS)},
      }),
      roles: ${JSON.stringify(ROLES)},
      expiredMessage: ${JSON.stringify(SETUP_SESSION_EXPIRED_MESSAGE)},
      document,
      confirm: (message) => typeof globalThis.confirm === "function" ? globalThis.confirm(message) : false,
    });
    globalThis.setupPageReady = globalThis.setupPage.start();
  </script>
</body>
</html>`;
