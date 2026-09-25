import { REASONING_EFFORTS } from "../core/driver.js";
import { ROLES, type Role } from "../core/roles.js";
import type { BatchModelsResult } from "../core/models.js";
import type { RoleBinding, RunAgentConfig } from "../config/config.js";
import { ORCHESTRATOR_PRESETS, type OrchestratorMode } from "../config/orchestrator-mode.js";
import type { SetupSelection } from "../config/setup.js";
import { BRAND_CSS, LOGO_FAVICON_HREF, renderTopBar, type WebPageLink } from "./brand.js";

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
  presets?: Record<string, OrchestratorMode>;
  document?: SetupPageDocument;
  confirm?: (message: string) => boolean;
  onChange?: (state: SetupPageClientState) => void;
}

export interface SetupPageOptions {
  pages?: WebPageLink[];
}

export interface SetupPageTargetState {
  target: { kind: "global" };
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
  let actionInFlight = false;
  let actionInFlightLabel = "";
  let lastRenderedEnvelope: unknown;
  let lastRenderedError: string | undefined;
  let hasRenderedPreview = false;
  const element = (id: string) => options.document?.getElementById(id) ?? null;

  function escapeHtml(value: unknown): string {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character] ?? character);
  }

  function formatCurrentOrchestrator(mode: OrchestratorMode | undefined): string {
    if (!mode) return "not set";
    const preset = Object.entries(options.presets ?? {}).find(([, value]) =>
      value.investigate === mode.investigate &&
      value.selfWork === mode.selfWork &&
      value.tools === mode.tools &&
      value.parallelism === mode.parallelism,
    );
    if (preset) return preset[0];

    const investigate: Record<OrchestratorMode["investigate"], string> = {
      none: "no investigation",
      read: "read only",
      free: "full access",
    };
    const selfWork: Record<OrchestratorMode["selfWork"], string> = {
      none: "off",
      trivial: "trivial tasks",
      small: "small tasks",
    };
    return [
      `custom · investigate: ${investigate[mode.investigate]}`,
      `self work: ${selfWork[mode.selfWork]}`,
      `tools: ${mode.tools}`,
      ...(mode.parallelism === undefined ? [] : [`parallelism: ${mode.parallelism}`]),
    ].join(" · ");
  }

  function formatPreviewPath(path: string): string {
    const parts = path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    const labels: Record<string, string> = {
      agents: "agents",
      harness: "harness",
      model: "model",
      effort: "effort",
      orchestrator: "orchestrator",
      investigate: "investigation",
      selfWork: "self work",
      tools: "tools",
      parallelism: "parallelism",
      defaultSandbox: "sandbox",
      autocompact: "autocompact",
      enabled: "enabled",
      cap: "cap",
    };
    if (parts[0] === "agents" && parts[1]) {
      return [parts[1], ...parts.slice(2).map((part) => labels[part] ?? part)].join(" · ");
    }
    return parts.map((part) => labels[part] ?? part).join(" · ") || "configuration";
  }

  function formatPreviewValue(value: unknown): string {
    if (value === null || value === undefined) return "none";
    if (typeof value === "boolean") return value ? "on" : "off";
    if (Array.isArray(value)) return value.map((item) => formatPreviewValue(item)).join(", ") || "none";
    if (typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${key}: ${formatPreviewValue(item)}`)
        .join(", ") || "none";
    }
    return String(value);
  }

  function renderPreview(envelope: unknown, fallbackError?: string): string {
    const body = typeof envelope === "object" && envelope !== null
      ? envelope as Record<string, unknown>
      : {};
    const result = typeof body.resultado === "object" && body.resultado !== null
      ? body.resultado as Record<string, unknown>
      : {};
    const resultStatus = typeof result.status === "string" ? result.status : "error";
    const statusLabels: Record<string, string> = {
      "dry-run": "Preview only, nothing written",
      applied: "Saved",
      unchanged: "Unchanged",
      aborted: "Cancelled",
      error: "Error",
    };
    const statusClass = ["dry-run", "applied", "unchanged", "aborted", "error"].includes(resultStatus)
      ? resultStatus
      : "error";
    const message = typeof result.message === "string"
      ? result.message
      : typeof body.error === "string"
        ? body.error
        : fallbackError ?? "";
    const changes = Array.isArray(body.mudancas) ? body.mudancas.filter((item) => {
      if (typeof item !== "object" || item === null) return false;
      const path = typeof (item as Record<string, unknown>).path === "string"
        ? (item as Record<string, unknown>).path as string
        : "";
      const parts = path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
      return !parts.includes("profiles") && !parts.includes("activeProfile");
    }) as Array<Record<string, unknown>> : [];
    const changeRows = changes.map((change) => {
      const path = typeof change.path === "string" ? change.path : "";
      const beforePresent = change.beforePresent !== false;
      const afterPresent = change.afterPresent !== false;
      const before = beforePresent ? escapeHtml(formatPreviewValue(change.before)) : '<span class="change-marker">Added</span>';
      const after = afterPresent ? escapeHtml(formatPreviewValue(change.after)) : '<span class="change-marker">Removed</span>';
      return `<div class="change-row"><strong class="change-path">${escapeHtml(formatPreviewPath(path))}</strong><span class="change-values"><span class="change-value">${before}</span><span class="change-arrow" aria-label="to">→</span><span class="change-value">${after}</span></span></div>`;
    }).join("");

    function validationRow(label: string, value: unknown): string {
      if (typeof value !== "object" || value === null) return "";
      const validation = value as Record<string, unknown>;
      const status = typeof validation.status === "string" ? validation.status : "not checked";
      const messageText = typeof validation.message === "string" ? validation.message.trim() : "";
      const ok = ["ok", "accepted", "fresh", "not-needed"].includes(status);
      return `<div class="validation-item"><span class="pill ${ok ? "pill-ok" : ""}">${escapeHtml(label)} · ${escapeHtml(status.replaceAll("-", " "))}</span>${messageText ? `<span class="validation-message">${escapeHtml(messageText)}</span>` : ""}</div>`;
    }

    const validations = typeof body.validacoes === "object" && body.validacoes !== null
      ? body.validacoes as Record<string, unknown>
      : {};
    const bindingRows = Array.isArray(validations.bindings) ? validations.bindings.map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const binding = item as Record<string, unknown>;
      const role = typeof binding.role === "string" ? binding.role : "binding";
      const status = typeof binding.status === "string" ? binding.status : "not checked";
      const identity = [binding.harness, binding.model].filter((part) => typeof part === "string").join(":");
      const label = `${role}${identity ? ` · ${identity}` : ""}`;
      const messageText = typeof binding.message === "string" ? binding.message.trim() : "";
      const ok = status === "accepted";
      return `<div class="validation-item"><span class="pill ${ok ? "pill-ok" : ""}">${escapeHtml(label)} · ${escapeHtml(status.replaceAll("-", " "))}</span>${messageText ? `<span class="validation-message">${escapeHtml(messageText)}</span>` : ""}</div>`;
    }).join("") : "";
    const validationRows = [
      validationRow("Config", validations.config),
      validationRow("Catalog", validations.catalogo),
      bindingRows,
    ].filter(Boolean).join("");
    const rawResponse = escapeHtml(JSON.stringify(envelope, null, 2) ?? String(envelope));
    const displayMessage = resultStatus === "dry-run" ? "" : message;

    return `<section class="result-status status-${statusClass}" role="status"><strong>${escapeHtml(statusLabels[resultStatus] ?? "Request failed")}</strong>${displayMessage ? `<span>${escapeHtml(displayMessage)}</span>` : ""}</section><section class="preview-section"><h3>Changes</h3><div class="change-list">${changeRows || '<p class="empty">No changes</p>'}</div></section><section class="preview-section"><h3>Checks</h3><div class="validation-list">${validationRows || '<p class="empty">No validation details</p>'}</div></section><details class="raw-response"><summary>Raw response</summary><pre>${rawResponse}</pre></details>`;
  }

  function update(): void {
    const status = element("setup-status");
    if (status) {
      status.textContent = state.error ?? (state.refreshing
        ? "Discovering models..."
        : state.loading
          ? "Loading setup..."
          : "Setup loaded.");
    }
    const actionStatus = element("setup-action-status");
    if (actionStatus) {
      if (state.error) {
        actionStatus.textContent = state.error;
      } else if (state.refreshing) {
        actionStatus.textContent = "Discovering models...";
      } else if (state.loading) {
        actionStatus.textContent = "Loading setup...";
      } else if (actionInFlight) {
        actionStatus.textContent = actionInFlightLabel;
      } else {
        const rolesChanging = options.roles.filter((role) => !element(`skip-${role}`)?.checked).length;
        const settingsChanging = ["orchestrator-mode", "setup-sandbox", "setup-autocompact"]
          .filter((id) => {
            const control = element(id);
            return Boolean(control?.value) && control?.value !== "skip";
          }).length;
        const parts = [
          rolesChanging === 0 ? "" : `${rolesChanging} ${rolesChanging === 1 ? "role" : "roles"}`,
          settingsChanging === 0 ? "" : `${settingsChanging} ${settingsChanging === 1 ? "setting" : "settings"}`,
        ].filter(Boolean);
        actionStatus.textContent = parts.length === 0
          ? "No changes selected"
          : `${parts.join(" and ")} set to change`;
      }
    }
    const targetLabel = element("setup-target");
    if (targetLabel && state.target) {
      targetLabel.textContent = "Global configuration";
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
    if (result && (!hasRenderedPreview || state.envelope !== lastRenderedEnvelope || state.error !== lastRenderedError)) {
      result.innerHTML = state.envelope === undefined ? "" : renderPreview(state.envelope, state.error);
      lastRenderedEnvelope = state.envelope;
      lastRenderedError = state.error;
      hasRenderedPreview = true;
    }
    const currentOrchestrator = element("current-orchestrator");
    if (currentOrchestrator && state.target) {
      currentOrchestrator.textContent = formatCurrentOrchestrator(state.target.orchestrator);
    }
    const currentSandbox = element("current-sandbox");
    if (currentSandbox && state.target) {
      currentSandbox.textContent = state.target.sandbox ?? "not set";
    }
    const currentAutocompact = element("current-autocompact");
    if (currentAutocompact && state.target) {
      currentAutocompact.textContent = state.target.autocompact === undefined
        ? "not set"
        : state.target.autocompact.enabled ? "on" : "off";
    }
    if (state.target) {
      for (const role of options.roles) {
        const current = element(`current-binding-${role}`);
        if (!current) continue;
        const binding = state.target.bindings[role];
        if (!binding) {
          current.innerHTML = '<span class="not-set">not set</span>';
          continue;
        }
        const effort = state.target.efforts?.[role] ?? binding.effort ?? "default";
        current.innerHTML = `<span class="pill harness-pill">${escapeHtml(binding.harness)}</span><code class="model-id">${escapeHtml(binding.model)}</code><span class="effort-value">${escapeHtml(effort)} effort</span>`;
      }
    }

    for (const role of options.roles) {
      const skip = element(`skip-${role}`);
      const binding = element(`binding-${role}`);
      const effort = element(`effort-${role}`);
      const fields = element(`role-fields-${role}`);
      const skipped = Boolean(skip?.checked);
      if (fields) fields.hidden = skipped;
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
    for (const id of ["setup-dry-run", "setup-apply"]) {
      const action = element(id);
      if (action) action.disabled = state.loading || state.refreshing || actionInFlight || !state.target;
    }
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
      if (skip) skip.checked = true;
      if (bindingInput) bindingInput.value = binding === undefined ? "" : `${binding.harness}:${binding.model}`;
      if (effort) effort.value = target.efforts?.[role] ?? binding?.effort ?? "keep";
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
      element(`effort-${role}`)?.addEventListener?.("change", update);
    }
    for (const id of ["orchestrator-mode", "orchestrator-investigate", "orchestrator-self-work", "orchestrator-tools", "setup-sandbox", "setup-autocompact"]) {
      element(id)?.addEventListener?.("change", update);
    }
    element("orchestrator-parallelism")?.addEventListener?.("input", update);
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
    update();
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
    actionInFlight = true;
    actionInFlightLabel = path.endsWith("/dry-run") ? "Preparing preview..." : "Saving setup...";
    update();
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
    } finally {
      actionInFlight = false;
      update();
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
      <section class="role-card">
        <header class="role-card-header"><h3 class="role-title">${role}</h3></header>
        <p class="current-line"><span class="muted">Current</span><span id="current-binding-${role}" class="current-binding"><span class="not-set">not set</span></span></p>
        <label class="role-mode" for="skip-${role}" aria-label="Keep current or change ${role} binding">
          <input id="skip-${role}" type="checkbox" checked>
          <span class="mode-option mode-keep">Keep current</span><span class="mode-option mode-change">Change</span>
        </label>
        <div id="role-fields-${role}" class="role-fields" hidden>
          <label class="field-label" for="binding-${role}">Harness and model</label>
          <input id="binding-${role}" type="text" list="catalog-models-${role}" placeholder="claude:sonnet" autocomplete="off">
          <datalist id="catalog-models-${role}"></datalist>
          <label class="field-label" for="effort-${role}">Reasoning effort</label>
          <select id="effort-${role}">
            <option value="keep">Keep current</option>
            ${REASONING_EFFORTS.map((effort) => `<option value="${effort}">${effort}</option>`).join("")}
          </select>
        </div>
      </section>`).join("");

export function renderSetupPage(options: SetupPageOptions = {}): string {
  const pages = options.pages ?? [{ label: "Setup", path: "/setup" }];
  const renderedTopbar = renderTopBar({ pages, activePath: "/setup", title: "Setup" });
  const topbar = pages.length === 1 && pages[0]?.path === "/setup"
    ? renderedTopbar.replace('class="brand" href="/"', 'class="brand" href="/setup"')
    : renderedTopbar;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CodeDeck setup</title>
  <link rel="icon" href="${LOGO_FAVICON_HREF}">
  <style>${BRAND_CSS}${SETUP_CSS}</style>
</head>
<body>
  ${topbar}
  <main class="setup-main">
    <header class="page-heading">
      <div><h1>Setup</h1><p class="intro">Choose model bindings and runtime defaults for this workspace.</p></div>
      <span id="setup-target" class="target-pill">Global configuration</span>
    </header>

    <section class="card load-card" aria-live="polite">
      <div class="load-copy"><strong>Setup state</strong><span id="setup-status" role="status">Loading setup...</span></div>
      <div class="catalog-copy"><span class="muted">Model catalog</span><span id="catalog-status">not loaded</span></div>
      <button id="setup-refresh" class="button secondary" type="button">Refresh catalog</button>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><h2>Role bindings</h2></div><p>Keep the current model or choose a new binding for each role.</p></div>
      <div class="roles">${roleControls}</div>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><h2>Orchestrator</h2></div><p>Choose a preset or describe a custom policy.</p></div>
      <section class="card settings-card">
        <p class="current-line"><span class="muted">Current</span><strong id="current-orchestrator" class="current-text">not set</strong></p>
        <label class="field-label" for="orchestrator-mode">Selection</label>
        <select id="orchestrator-mode">
          <option value="skip">Keep current</option>
          <option value="dispatcher">dispatcher</option>
          <option value="balanced">balanced</option>
          <option value="explorer">explorer</option>
          <option value="custom">custom</option>
        </select>
        <div id="orchestrator-custom" class="settings-grid" hidden>
          <div><label class="field-label" for="orchestrator-investigate">Investigate</label><select id="orchestrator-investigate"><option>none</option><option>read</option><option>free</option></select></div>
          <div><label class="field-label" for="orchestrator-self-work">Self work</label><select id="orchestrator-self-work"><option>none</option><option>trivial</option><option>small</option></select></div>
          <div><label class="field-label" for="orchestrator-tools">Tools</label><select id="orchestrator-tools"><option>dispatch</option><option>read</option><option>edit</option></select></div>
          <div><label class="field-label" for="orchestrator-parallelism">Parallelism (optional)</label><input id="orchestrator-parallelism" type="number" min="0.0000001" step="any" placeholder="No limit"></div>
        </div>
      </section>
    </section>

    <section class="section-block">
      <div class="section-heading"><div><h2>Other settings</h2></div></div>
      <div class="settings-grid">
        <section class="card setting-card"><p class="current-line"><span class="muted">Current sandbox</span><strong id="current-sandbox" class="current-text mono-value">not set</strong></p><label class="field-label" for="setup-sandbox">Sandbox</label><select id="setup-sandbox"><option value="skip">Keep current</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option></select></section>
        <section class="card setting-card"><p class="current-line"><span class="muted">Current autocompact</span><strong id="current-autocompact" class="current-text">not set</strong></p><label class="field-label" for="setup-autocompact">Autocompact</label><select id="setup-autocompact"><option value="skip">Keep current</option><option value="on">On</option><option value="off">Off</option></select></section>
      </div>
    </section>

    <section class="preview-panel section-block" aria-live="polite">
      <div class="section-heading"><div><h2>Preview</h2></div><p>Check each change before saving.</p></div>
      <div id="setup-result" class="result-content"></div>
    </section>
    <div class="actions" role="group" aria-label="Setup actions">
      <span id="setup-action-status" class="action-status" role="status" aria-live="polite">Loading setup...</span>
      <button id="setup-dry-run" class="button secondary" type="button" disabled>Preview changes</button>
      <button id="setup-apply" class="button primary" type="button" disabled>Apply setup</button>
    </div>
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
      presets: ${JSON.stringify(ORCHESTRATOR_PRESETS)},
      expiredMessage: ${JSON.stringify(SETUP_SESSION_EXPIRED_MESSAGE)},
      document,
      confirm: (message) => typeof globalThis.confirm === "function" ? globalThis.confirm(message) : false,
    });
    globalThis.setupPageReady = globalThis.setupPage.start().then(async (state) => {
      if (new URLSearchParams(location.search).get("refresh") === "1") await globalThis.setupPage.refreshCatalog();
      return state;
    });
  </script>
</body>
</html>`;
}

export const SETUP_CSS = `
.topbar{height:52px;display:flex;align-items:center;gap:24px;padding:0 28px;border-bottom:1px solid var(--border);background:var(--bg)}
.brand{display:flex;align-items:center;gap:8px;color:var(--text);text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-.3px}.brand svg{display:block}
.topbar-title{font-size:13px;color:var(--text-muted);border-left:1px solid var(--border-strong);padding-left:18px}.topbar nav{display:flex;gap:20px;margin-left:auto}.topbar nav a{color:var(--text-faint);font-size:12px;text-decoration:none}.topbar nav a:hover,.topbar nav a.active{color:var(--text)}
.setup-main{width:min(100%,1320px);margin:0 auto;padding:30px 28px 20px}h1,h2,h3,p{margin-top:0}h1{margin-bottom:7px;font-size:30px;line-height:1.15;letter-spacing:-.7px}h2{margin-bottom:0;font-size:19px;line-height:1.25;letter-spacing:-.3px}h3{margin-bottom:12px;font-size:14px}
.page-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px}.intro{margin-bottom:0;color:var(--text-muted);font-size:13px}
.target-pill,.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-strong);border-radius:999px;background:var(--surface-raised);padding:5px 9px;color:var(--text-muted);font-size:11px;white-space:nowrap}
.card,.role-card,.preview-panel{min-width:0;border:1px solid var(--border);border-radius:9px;background:var(--surface);padding:16px}.load-card{display:flex;align-items:center;gap:24px;margin-bottom:29px}.load-copy,.catalog-copy{display:grid;gap:3px;min-width:0}.load-copy{flex:1}.load-copy strong{font-size:12px}.load-copy span,.catalog-copy span:last-child{color:var(--text-muted);font-size:12px;overflow-wrap:anywhere}.catalog-copy{min-width:160px}.muted{color:var(--text-faint);font-size:11px}
.section-block{margin-top:28px}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:12px}.section-heading>p{margin:0;color:var(--text-faint);font-size:11px}.roles{display:grid;align-items:start;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.role-card{margin:0;padding:14px}.role-card-header{margin-bottom:10px}.role-title{margin:0;color:var(--text);font-size:13px;font-weight:650;text-transform:capitalize}.role-fields[hidden]{display:none}.current-line{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 13px}.current-binding{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;min-width:0;text-align:right}.harness-pill{padding:3px 7px;color:var(--text)}.model-id{min-width:0;color:var(--text);font:11px var(--font-mono);overflow-wrap:anywhere}.effort-value{color:var(--text-faint);font-size:10px;white-space:nowrap}.not-set,.current-text{color:var(--text-muted);font-size:11px}.mono-value{font-family:var(--font-mono)}
.role-mode{position:relative;display:flex;align-items:center;gap:3px;margin:0 0 14px;padding:3px;border:1px solid var(--border);border-radius:6px;background:#000;color:var(--text-faint);cursor:pointer}.role-mode input{position:absolute;width:1px;height:1px;opacity:0}.role-mode:focus-within{outline:2px solid var(--blue);outline-offset:2px}.mode-option{flex:1;padding:5px 6px;border-radius:4px;text-align:center;font-size:10px}.role-mode input:checked~.mode-keep,.role-mode input:not(:checked)~.mode-change{background:var(--surface-raised);color:var(--text)}
.field-label{display:block;margin:11px 0 5px;color:var(--text-muted);font-size:11px}input[type="text"],input[type="number"],select{display:block;width:100%;min-width:0;min-height:36px;border:1px solid var(--border-strong);border-radius:6px;background:#050505;color:var(--text);padding:8px 9px;font:12px var(--font-sans);color-scheme:dark}input[type="number"]{font-family:var(--font-mono)}input::placeholder{color:var(--text-faint)}input:focus,select:focus{outline:2px solid var(--blue);outline-offset:1px}input:disabled,select:disabled{opacity:.48}select option{background:#0a0a0a;color:var(--text)}
.settings-card{max-width:none}.settings-card>.field-label,.settings-card>select{max-width:390px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.settings-card .settings-grid{margin-top:15px}.settings-card .settings-grid[hidden]{display:none}.setting-card{min-width:0}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:1px solid var(--border-strong);border-radius:6px;padding:8px 13px;background:var(--surface);color:var(--text);font:600 12px var(--font-sans);cursor:pointer}.button:hover:not(:disabled){background:var(--surface-hover)}.button.primary{border-color:var(--blue);background:var(--blue);color:#fff}.button.primary:hover:not(:disabled){background:#0063d9}.button:disabled{cursor:not-allowed;opacity:.45}
.actions{position:sticky;bottom:0;z-index:20;display:flex;align-items:center;gap:8px;margin:24px 0 0;padding:11px 14px;border:0;border-top:1px solid var(--border);border-radius:0;background:rgba(10,10,10,.96);backdrop-filter:blur(12px)}.action-status{min-width:0;margin-right:auto;color:var(--text-muted);font-size:11px;overflow-wrap:anywhere}
.preview-panel{padding:16px}.preview-panel .section-heading{margin-bottom:16px}.result-content:empty{display:none}.result-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:15px;padding:11px 13px;border:1px solid var(--border-strong);border-radius:7px;background:#080808;font-size:12px}.result-status strong{color:var(--text)}.result-status span{color:var(--text-muted);overflow-wrap:anywhere}.result-status.status-applied{border-color:rgba(16,185,129,.45)}.result-status.status-error{border-color:rgba(229,72,77,.55)}.result-status.status-dry-run{border-color:rgba(0,112,243,.5)}.preview-section{margin-top:15px}.preview-section h3{margin-bottom:8px;color:var(--text-muted);font-size:11px;font-weight:600}
.change-list{display:grid;gap:5px}.change-row{display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:6px 14px;min-width:0;padding:9px 10px;border:1px solid var(--border);border-radius:6px;background:#050505}.change-path{color:var(--text);font-size:11px;overflow-wrap:anywhere}.change-values{display:flex;align-items:center;gap:8px;min-width:0}.change-value{min-width:0;color:var(--text-muted);font:11px var(--font-mono);overflow-wrap:anywhere}.change-arrow{flex:none;color:var(--text-faint)}.change-marker{color:var(--blue-chart);font:600 10px var(--font-sans);text-transform:uppercase}
.validation-list{display:flex;align-items:center;flex-wrap:wrap;gap:7px 12px}.validation-item{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-width:0}.validation-message{color:var(--text-faint);font-size:11px;overflow-wrap:anywhere}.pill-ok{border-color:rgba(16,185,129,.4);color:#8fe0bc}.empty{margin:8px 0;color:var(--text-faint);font-size:12px}.raw-response{margin-top:14px;border-top:1px solid var(--border);padding-top:10px;color:var(--text-muted);font-size:11px}.raw-response summary{cursor:pointer}.raw-response pre{max-height:380px;overflow:auto;margin:10px 0 0;padding:12px;border:1px solid var(--border);border-radius:6px;background:#050505;color:var(--text-muted);font:10px/1.5 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}
@media(max-width:900px){.setup-main{padding:24px 20px 20px}.roles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.topbar{height:auto;min-height:52px;gap:8px;padding:9px 12px;flex-wrap:wrap}.topbar-title{padding-left:9px;font-size:11px}.topbar nav{gap:9px}.topbar nav a{font-size:10px}.setup-main{padding:20px 12px 12px}.page-heading{align-items:flex-start;flex-direction:column;gap:10px}.load-card{align-items:stretch;flex-wrap:wrap;gap:12px}.load-copy{flex-basis:100%}.catalog-copy{flex:1;min-width:120px}.roles,.settings-grid{grid-template-columns:minmax(0,1fr)}.section-heading{align-items:flex-start;flex-direction:column;gap:5px}.actions{padding:10px 8px}.action-status{font-size:10px}.actions .button{flex:1;padding:8px 7px}.current-line{align-items:flex-start}}
`;

export const SETUP_PAGE = renderSetupPage();
