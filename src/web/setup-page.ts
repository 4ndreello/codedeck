import { REASONING_EFFORTS } from "../core/driver.js";
import { ROLES, type Role } from "../core/roles.js";
import { AGENT_IDS } from "../core/session.js";
import { CATALOG_DISCOVERY_TIMEOUT_MS, type BatchModelsResult } from "../core/models.js";
import type { RoleBinding, RunAgentConfig } from "../config/config.js";
import { ORCHESTRATOR_PRESETS, type OrchestratorMode } from "../config/orchestrator-mode.js";
import type { SetupSelection } from "../config/setup.js";
import { BRAND_CSS, LOGO_FAVICON_HREF, renderTopBar, type WebPageLink } from "./brand.js";
import { renderSetupSprite, type SetupIconName } from "./setup-icons.js";

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

export interface SetupPolicyOption {
  value: string;
  label: string;
  icon: SetupIconName;
  summary: string;
}

export interface SetupPolicyAxis {
  key: "investigate" | "selfWork" | "tools";
  label: string;
  options: SetupPolicyOption[];
}

export const SETUP_POLICY_AXES: readonly SetupPolicyAxis[] = [
  {
    key: "investigate",
    label: "Reads the code",
    options: [
      { value: "none", label: "Never", icon: "eye-off", summary: "never reads the code" },
      { value: "read", label: "Read only", icon: "eye", summary: "reads code to plan" },
      { value: "free", label: "Freely", icon: "telescope", summary: "explores the code freely" },
    ],
  },
  {
    key: "selfWork",
    label: "Does work itself",
    options: [
      { value: "none", label: "Never", icon: "hand", summary: "hands off every task" },
      { value: "trivial", label: "Trivial fixes", icon: "wrench", summary: "fixes trivial things itself" },
      { value: "small", label: "Small tasks", icon: "hammer", summary: "takes small tasks itself" },
    ],
  },
  {
    key: "tools",
    label: "Tools",
    options: [
      { value: "dispatch", label: "Dispatch only", icon: "split", summary: "only has dispatch tools" },
      { value: "read", label: "Read", icon: "book-open", summary: "has read-only tools" },
      { value: "edit", label: "Edit", icon: "pencil", summary: "can edit files" },
    ],
  },
];

// The orchestrator leads the roster because it is the role the others work for.
export const SETUP_ROLE_ORDER: readonly Role[] = [
  "orchestrator",
  ...ROLES.filter((role) => role !== "orchestrator"),
];

const ROLE_COPY: Record<Role, string> = {
  orchestrator: "Coordinates workers and tracks their state.",
  general: "Does the work directly in the workspace.",
  reviewer: "Inspects changes with evidence. Edits nothing.",
  auditor: "Fans out over large scopes, then proves findings.",
};

export interface SetupPageEvent {
  target?: unknown;
  key?: string;
  preventDefault?(): void;
}

export interface SetupPageElement {
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  textContent?: string | null;
  innerHTML?: string;
  className?: string;
  scrollTop?: number;
  style?: Record<string, string>;
  addEventListener?(name: string, callback: (event?: SetupPageEvent) => void): void;
  setAttribute?(name: string, value: string): void;
  focus?(): void;
  getBoundingClientRect?(): { left: number; top: number; bottom: number; width: number };
  scrollIntoView?(options?: { block?: string }): void;
}

export interface SetupPageDocument {
  getElementById(id: string): SetupPageElement | null;
  addEventListener?(name: string, callback: (event?: SetupPageEvent) => void, capture?: boolean): void;
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
  efforts?: readonly string[];
  harnesses?: readonly string[];
  axes?: readonly SetupPolicyAxis[];
  document?: SetupPageDocument;
  onChange?: (state: SetupPageClientState) => void;
}

export interface SetupPageOptions {
  pages?: WebPageLink[];
}

export interface SetupPageTargetState {
  config?: { status?: string; source?: string; path?: string };
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

export interface SetupDraftBinding {
  harness: string;
  model: string;
  effort: string;
}

export interface SetupDraftPolicy {
  investigate: string;
  selfWork: string;
  tools: string;
}

export interface SetupDraft {
  agents: Partial<Record<Role, SetupDraftBinding>>;
  policy?: SetupDraftPolicy;
  custom: boolean;
  parallelism: string;
  sandbox?: string;
  autocompact?: boolean;
}

export function createSetupPageController(options: SetupPageControllerOptions) {
  const state: SetupPageClientState = { refreshing: false, loading: true };
  const roles = options.roles;
  const efforts = options.efforts ?? [];
  const harnesses = options.harnesses ?? [];
  const presets = options.presets ?? {};
  const presetNames = Object.keys(presets);
  const columns = [...presetNames, "custom"];
  const axes = options.axes ?? [];
  const ui = {
    drawer: false,
    pickerRole: undefined as Role | undefined,
    pickerQuery: "",
    pickerIndex: 0,
    confirmOff: {} as Partial<Record<Role, boolean>>,
    reviewOk: false,
    bound: false,
    rendered: false,
    catalogDone: false,
  };
  let draft: SetupDraft = { agents: {}, custom: false, parallelism: "" };
  let refreshInFlight: Promise<unknown> | undefined;
  let actionInFlight = false;
  let actionInFlightLabel = "";
  let toastTimer: unknown;
  const htmlCache = new Map<string, string>();
  const swapFlip = new Map<string, boolean>();
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

  function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function icon(name: string, className = ""): string {
    return `<svg class="ico${className ? ` ${className}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
  }

  function chip(harness: string): string {
    return `<span class="hchip" data-h="${escapeHtml(harness)}"><span class="hmark"><svg aria-hidden="true" focusable="false"><use href="#hi-${escapeHtml(harness)}"></use></svg></span><span class="hname">${escapeHtml(harness)}</span></span>`;
  }

  function setHtml(id: string, html: string): boolean {
    const target = element(id);
    if (!target || htmlCache.get(id) === html) return false;
    htmlCache.set(id, html);
    target.innerHTML = html;
    return true;
  }

  function setClass(id: string, className: string): void {
    const target = element(id);
    if (target && target.className !== className) target.className = className;
  }

  function setAttr(id: string, name: string, value: string): void {
    element(id)?.setAttribute?.(name, value);
  }

  function setDisabled(id: string, disabled: boolean): void {
    const target = element(id);
    if (target && target.disabled !== disabled) target.disabled = disabled;
  }

  // Swapping between two identical keyframe names restarts the entrance
  // animation every time the text changes, without touching layout.
  function swapText(id: string, base: string, text: string): void {
    const target = element(id);
    if (!target) return;
    if (target.textContent === text) {
      if ((target.className ?? "").replace(/ swap-[ab]$/, "") !== base) target.className = base;
      return;
    }
    target.textContent = text;
    // The first ready render replaces skeleton text, so it fades in too.
    if (state.loading || !state.target) {
      target.className = base;
      return;
    }
    const flip = !swapFlip.get(id);
    swapFlip.set(id, flip);
    target.className = `${base} ${flip ? "swap-a" : "swap-b"}`;
  }

  function cloneDraft(value: SetupDraft): SetupDraft {
    return JSON.parse(JSON.stringify(value)) as SetupDraft;
  }

  function presetFor(policy: SetupDraftPolicy | undefined): string | undefined {
    if (!policy) return undefined;
    return presetNames.find((name) =>
      presets[name]?.investigate === policy.investigate &&
      presets[name]?.selfWork === policy.selfWork &&
      presets[name]?.tools === policy.tools,
    );
  }

  function samePolicy(left: SetupDraftPolicy | undefined, right: SetupDraftPolicy | undefined): boolean {
    if (!left || !right) return left === right;
    return left.investigate === right.investigate && left.selfWork === right.selfWork && left.tools === right.tools;
  }

  function baselinePolicy(): SetupDraftPolicy {
    const preset = presets.balanced ?? presets[presetNames[0] ?? ""];
    return {
      investigate: preset?.investigate ?? axes[0]?.options[0]?.value ?? "none",
      selfWork: preset?.selfWork ?? axes[1]?.options[0]?.value ?? "none",
      tools: preset?.tools ?? axes[2]?.options[0]?.value ?? "dispatch",
    };
  }

  function savedDraft(): SetupDraft {
    const target = state.target;
    const agents: SetupDraft["agents"] = {};
    for (const role of roles) {
      const binding = target?.bindings?.[role];
      if (binding) {
        agents[role] = {
          harness: binding.harness,
          model: binding.model,
          effort: target?.efforts?.[role] ?? binding.effort ?? "",
        };
      }
    }
    const mode = target?.orchestrator;
    const policy = mode ? { investigate: mode.investigate, selfWork: mode.selfWork, tools: mode.tools } : undefined;
    return {
      agents,
      ...(policy ? { policy } : {}),
      custom: Boolean(policy) && !presetFor(policy),
      parallelism: mode?.parallelism === undefined ? "" : String(mode.parallelism),
      ...(target?.sandbox === undefined ? {} : { sandbox: target.sandbox }),
      ...(target?.autocompact === undefined ? {} : { autocompact: target.autocompact.enabled !== false }),
    };
  }

  function policyMode(value: SetupDraft = draft): string {
    if (!value.policy) return "none";
    if (value.custom) return "custom";
    return presetFor(value.policy) ?? "custom";
  }

  function effortOf(binding: SetupDraftBinding | undefined): string {
    return !binding || binding.harness === "opencode" ? "" : binding.effort;
  }

  function modelChanged(role: Role, saved: SetupDraft): boolean {
    const current = draft.agents[role];
    const previous = saved.agents[role];
    return Boolean(current) && (!previous || previous.harness !== current?.harness || previous.model !== current?.model);
  }

  function effortChanged(role: Role, saved: SetupDraft): boolean {
    const current = draft.agents[role];
    const previous = saved.agents[role];
    return Boolean(current && previous) && effortOf(current) !== effortOf(previous);
  }

  function roleChanged(role: Role, saved: SetupDraft): boolean {
    return modelChanged(role, saved) || effortChanged(role, saved);
  }

  function policyChanged(saved: SetupDraft): boolean {
    return Boolean(draft.policy) && !samePolicy(draft.policy, saved.policy);
  }

  function parallelismChanged(saved: SetupDraft): boolean {
    return Boolean(draft.policy) && draft.parallelism.trim() !== saved.parallelism;
  }

  function sandboxChanged(saved: SetupDraft): boolean {
    return draft.sandbox !== undefined && draft.sandbox !== saved.sandbox;
  }

  function autocompactChanged(saved: SetupDraft): boolean {
    return draft.autocompact !== undefined && draft.autocompact !== saved.autocompact;
  }

  function changeNames(saved: SetupDraft = savedDraft()): string[] {
    return [
      ...roles.filter((role) => roleChanged(role, saved)).map((role) => capitalize(role)),
      ...(policyChanged(saved) ? ["Orchestrator policy"] : []),
      ...(parallelismChanged(saved) ? ["Parallel workers"] : []),
      ...(sandboxChanged(saved) ? ["Sandbox"] : []),
      ...(autocompactChanged(saved) ? ["Autocompact"] : []),
    ];
  }

  function harnessEntry(harness: string) {
    return state.catalog?.models?.find((entry) => entry.agent === harness);
  }

  function catalogModels(harness: string) {
    const seen = new Set<string>();
    return (harnessEntry(harness)?.providers ?? []).flatMap((provider) => provider.models).filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }

  function catalogModel(harness: string, model: string) {
    return catalogModels(harness).find((candidate) => candidate.id === model || candidate.aliases?.includes(model));
  }

  function supportedEfforts(harness: string, model: string): string[] | undefined {
    const listed = catalogModel(harness, model)?.reasoningEfforts?.filter((effort) => efforts.includes(effort));
    return listed && listed.length > 0 ? listed : undefined;
  }

  // The catalog name reads better than the id, but the id is what the harness
  // receives, so it stays visible next to the name.
  function modelText(harness: string, model: string, titleClass: string, idClass: string): string {
    const name = catalogModel(harness, model)?.name;
    if (!name || name === model) return `<span class="${titleClass} mono">${escapeHtml(model)}</span>`;
    return `<span class="${titleClass}">${escapeHtml(name)}</span><span class="${idClass} mono">${escapeHtml(model)}</span>`;
  }

  function isOffCatalog(harness: string, model: string): boolean {
    const entry = harnessEntry(harness);
    return Boolean(entry?.available) && !catalogModel(harness, model);
  }

  function offCatalogRoles(saved: SetupDraft = savedDraft()): Role[] {
    return roles.filter((role) => {
      const current = draft.agents[role];
      return Boolean(current) && modelChanged(role, saved) && isOffCatalog(current!.harness, current!.model);
    });
  }

  function readForm(): SetupPageFormValues {
    const saved = savedDraft();
    const roleValues: SetupPageFormValues["roles"] = {};
    for (const role of roles) {
      const current = draft.agents[role];
      roleValues[role] = {
        skip: !roleChanged(role, saved),
        binding: current ? `${current.harness}:${current.model}` : "",
        effort: current?.effort || "keep",
      };
    }
    const policy = draft.policy;
    let orchestrator = "skip";
    if (policy && (policyChanged(saved) || parallelismChanged(saved))) {
      const preset = !draft.custom && draft.parallelism.trim() === "" ? presetFor(policy) : undefined;
      orchestrator = preset ?? "custom";
    }
    return {
      roles: roleValues,
      orchestrator,
      investigate: policy?.investigate ?? "none",
      selfWork: policy?.selfWork ?? "none",
      tools: policy?.tools ?? "dispatch",
      parallelism: draft.parallelism,
      sandbox: sandboxChanged(saved) ? draft.sandbox ?? "skip" : "skip",
      autocompact: autocompactChanged(saved) ? (draft.autocompact ? "on" : "off") : "skip",
    };
  }

  function formatAge(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
  }

  function refreshErrorText(error: string): string {
    const timeout = error.match(/timed out after (\d+) ?ms/);
    if (timeout) return `Refresh timed out after ${Math.round(Number(timeout[1]) / 1000)} s.`;
    return `Refresh failed: ${error.replace(/\.$/, "")}.`;
  }

  function catalogText(): string {
    if (state.refreshing) return "Refreshing catalog";
    const catalog = state.catalog;
    const error = state.discoveryError ? refreshErrorText(state.discoveryError) : "";
    if (!catalog) {
      if (error) return `Catalog unavailable. ${error}`;
      return state.loading ? "Loading catalog" : "Catalog not loaded";
    }
    const age = typeof catalog.ageMs === "number" ? formatAge(catalog.ageMs) : "";
    if (error) return age ? `${error} Showing models from ${age}.` : error;
    if (catalog.status === "fresh") return `Catalog updated ${age}`.trim();
    if (catalog.status === "offline") return `Catalog offline, cached ${age}`.trim();
    return "Catalog unavailable";
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
      parallelism: "parallel workers",
      defaultSandbox: "sandbox",
      autocompact: "autocompact",
      enabled: "enabled",
      cap: "cap",
    };
    if (parts[0] === "agents" && parts[1]) {
      return [capitalize(parts[1]), ...parts.slice(2).map((part) => labels[part] ?? part)].join(" ");
    }
    return capitalize(parts.map((part) => labels[part] ?? part).join(" ") || "configuration");
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

  function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => sortKeys(item));
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort((a, b) => a.localeCompare(b)).map((key) => [key, sortKeys(record[key])]));
    }
    return value;
  }

  // Only the keys Setup writes, so the diff shows what saving changes and
  // never echoes unrelated or legacy keys from the file.
  function managedLines(source: Record<string, unknown>): string[] {
    const managed: Record<string, unknown> = {};
    for (const key of ["agents", "orchestrator", "defaultSandbox", "autocompact"]) {
      if (source[key] !== undefined) managed[key] = sortKeys(source[key]);
    }
    return JSON.stringify(managed, null, 2).split("\n");
  }

  function diffLines(before: string[], after: string[]) {
    const rows = before.length;
    const cols = after.length;
    const lengths = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        lengths[i]![j] = before[i] === after[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
      }
    }
    const output: Array<{ kind: " " | "+" | "-"; text: string; old?: number; next?: number }> = [];
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (before[i] === after[j]) {
        output.push({ kind: " ", text: before[i]!, old: i + 1, next: j + 1 });
        i++;
        j++;
      } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
        output.push({ kind: "-", text: before[i]!, old: i + 1 });
        i++;
      } else {
        output.push({ kind: "+", text: after[j]!, next: j + 1 });
        j++;
      }
    }
    while (i < rows) output.push({ kind: "-", text: before[i]!, old: ++i });
    while (j < cols) output.push({ kind: "+", text: after[j]!, next: ++j });
    return output;
  }

  function renderDiff(proposal: Record<string, unknown>): string {
    const target = state.target;
    const before = managedLines({
      agents: target?.bindings,
      orchestrator: target?.orchestrator,
      defaultSandbox: target?.sandbox,
      autocompact: target?.autocompact,
    });
    const lines = diffLines(before, managedLines(proposal));
    const added = lines.filter((line) => line.kind === "+").length;
    const removed = lines.filter((line) => line.kind === "-").length;
    if (added + removed === 0) return "";
    const near = lines.map((_, index) =>
      lines.slice(Math.max(0, index - 2), index + 3).some((line) => line.kind !== " "),
    );
    const rows: string[] = [];
    let hidden = 0;
    const flush = () => {
      if (hidden > 0) rows.push(`<div class="fold">${hidden} unchanged ${hidden === 1 ? "line" : "lines"}</div>`);
      hidden = 0;
    };
    lines.forEach((line, index) => {
      if (line.kind === " " && !near[index]) {
        hidden++;
        return;
      }
      flush();
      const text = escapeHtml(line.text)
        .replace(/^(\s*)(&quot;.*?&quot;)(:)/, '$1<span class="k">$2</span>$3')
        .replace(/(:\s)(&quot;.*?&quot;)/, '$1<span class="s">$2</span>');
      const kind = line.kind === "+" ? " plus" : line.kind === "-" ? " minus" : "";
      rows.push(`<div class="dl${kind}"><span class="no">${line.old ?? ""}</span><span class="no">${line.next ?? ""}</span><span class="mk">${line.kind === " " ? "" : line.kind}</span><span class="tx">${text}</span></div>`);
    });
    flush();
    const path = target?.config?.path ?? "config.json";
    const file = path.split("/").pop() || path;
    return `<section class="dr-section"><h3 class="dr-label"><span>${escapeHtml(file)}</span><span class="counts"><span class="add">+${added}</span><span class="del">-${removed}</span></span></h3><div class="diff">${rows.join("")}</div><p class="dr-note">Only the keys Setup manages are shown. The rest of the file stays as it is.</p></section>`;
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
      "dry-run": "Not saved yet",
      applied: "Saved",
      unchanged: "Nothing to save",
      aborted: "Cancelled",
      error: "Error",
    };
    const statusClass = ["dry-run", "applied", "unchanged", "aborted", "error"].includes(resultStatus)
      ? resultStatus
      : "error";
    const message = fallbackError
      ?? (typeof result.message === "string"
        ? result.message
        : typeof body.error === "string"
          ? body.error
          : "");
    const displayMessage = resultStatus === "dry-run" && !fallbackError
      ? "Check the changes below, then save."
      : message;
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
      const before = beforePresent ? `<span class="before">${escapeHtml(formatPreviewValue(change.before))}</span>` : '<span class="marker">Added</span>';
      const after = afterPresent ? `<span class="after">${escapeHtml(formatPreviewValue(change.after))}</span>` : '<span class="marker">Removed</span>';
      return `<div class="ch"><span class="ch-name">${escapeHtml(formatPreviewPath(path))}</span><span class="ch-vals">${before}<span class="ch-to">to</span>${after}</span></div>`;
    }).join("");

    function check(label: string, status: string, messageText: string, ok: boolean): string {
      return `<div class="check ${ok ? "ok" : "warn"}">${icon(ok ? "check" : "triangle-alert")}<span><strong>${escapeHtml(label)}</strong> ${escapeHtml(status.replaceAll("-", " "))}${messageText ? `<span class="check-msg">${escapeHtml(messageText)}</span>` : ""}</span></div>`;
    }

    function validationRow(label: string, value: unknown): string {
      if (typeof value !== "object" || value === null) return "";
      const validation = value as Record<string, unknown>;
      const status = typeof validation.status === "string" ? validation.status : "not checked";
      const messageText = typeof validation.message === "string" ? validation.message.trim() : "";
      return check(label, status, messageText, ["ok", "accepted", "fresh", "not-needed"].includes(status));
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
      const messageText = typeof binding.message === "string" ? binding.message.trim() : "";
      return check(`${capitalize(role)}${identity ? ` ${identity}` : ""}`, status, messageText, status === "accepted");
    }).join("") : "";
    const validationRows = [
      validationRow("Config", validations.config),
      validationRow("Catalog", validations.catalogo),
      bindingRows,
    ].filter(Boolean).join("");
    const proposal = typeof body.proposta === "object" && body.proposta !== null
      ? renderDiff(body.proposta as Record<string, unknown>)
      : "";
    const rawResponse = escapeHtml(JSON.stringify(envelope, null, 2) ?? String(envelope));
    const statusIcon = statusClass === "applied" || statusClass === "unchanged"
      ? "check"
      : statusClass === "dry-run" ? "eye" : "triangle-alert";

    return `<section class="dr-section result-status status-${statusClass}" role="status">${icon(statusIcon)}<span><strong>${escapeHtml(statusLabels[resultStatus] ?? "Request failed")}</strong>${displayMessage ? `<span class="result-msg">${escapeHtml(displayMessage)}</span>` : ""}</span></section>`
      + `<section class="dr-section"><h3 class="dr-label">${changes.length} ${changes.length === 1 ? "change" : "changes"}</h3><div class="ch-list">${changeRows || '<p class="empty">No changes</p>'}</div></section>`
      + proposal
      + `<section class="dr-section"><h3 class="dr-label">Checks</h3><div class="checks">${validationRows || '<p class="empty">No validation details</p>'}</div></section>`
      + `<details class="raw-response"><summary>Raw response</summary><pre>${rawResponse}</pre></details>`;
  }

  function renderReview(): string {
    if (actionInFlight && actionInFlightLabel === "Checking changes") {
      return '<div class="dr-loading" role="status"><span>Checking your changes</span><span class="sk"></span><span class="sk short"></span><span class="sk"></span></div>';
    }
    if (state.envelope !== undefined) {
      if (ui.reviewOk && !state.error) {
        const body = state.envelope as Record<string, unknown>;
        return renderPreview({ ...body, resultado: { status: "dry-run" } });
      }
      return renderPreview(state.envelope, state.error);
    }
    if (state.error) {
      return `<section class="dr-section result-status status-error" role="status">${icon("triangle-alert")}<span><strong>Error</strong><span class="result-msg">${escapeHtml(state.error)}</span></span></section>`;
    }
    return "";
  }

  function bindingHtml(role: Role): string {
    if (state.loading || !state.target) return `<span class="model-sk"><span class="sr-only">Loading</span></span>${icon("chevron-down", "chev")}`;
    const current = draft.agents[role];
    if (!current) return `<span class="model-body"><span class="model-empty">Choose a model</span></span>${icon("chevron-down", "chev")}`;
    const off = modelChanged(role, savedDraft()) && isOffCatalog(current.harness, current.model);
    return `<span class="model-body">${chip(current.harness)}<span class="model-text">${modelText(current.harness, current.model, "model-title", "model-id")}</span>${off ? '<span class="tag warn">not in catalog</span>' : ""}</span>${icon("chevron-down", "chev")}`;
  }

  function roleStateHtml(role: Role, saved: SetupDraft): string {
    if (state.loading || !state.target) return "";
    const current = draft.agents[role];
    const previous = saved.agents[role];
    if (!current) return '<span class="state-note">Not set</span>';
    if (!roleChanged(role, saved)) return `<span class="state-note">${icon("check")}Saved</span>`;
    const was = !previous
      ? "not set"
      : modelChanged(role, saved)
        ? catalogModel(previous.harness, previous.model)?.name || previous.model
        : `${previous.effort || "default"} effort`;
    return `<span class="was">was <span class="was-value">${escapeHtml(was)}</span></span><button type="button" class="link-btn" data-act="revert" data-role="${role}">${icon("undo-2")}Undo</button>`;
  }

  function pickerEntries() {
    const role = ui.pickerRole;
    const query = ui.pickerQuery.trim().toLowerCase();
    const current = role ? draft.agents[role] : undefined;
    const saved = role ? savedDraft().agents[role] : undefined;
    const groups: Array<{ harness: string; note: string; off: boolean; items: Array<{ harness: string; model: string; saved: boolean; selected: boolean; custom: boolean }> }> = [];
    for (const harness of harnesses) {
      const entry = harnessEntry(harness);
      if (!entry || !entry.available) {
        if (query && !harness.includes(query)) continue;
        const note = !state.catalog
          ? "Catalog not loaded"
          : !entry
            ? "Not in the catalog"
            : entry.error ? `Unavailable: ${entry.error}` : "Unavailable. Run codedeck doctor.";
        groups.push({ harness, note, off: true, items: [] });
        continue;
      }
      const models = catalogModels(harness);
      const matching = models.filter((model) => !query || [`${harness}:${model.id}`, model.name ?? "", ...(model.aliases ?? [])]
        .some((value) => value.toLowerCase().includes(query)));
      if (query && matching.length === 0) continue;
      groups.push({
        harness,
        note: models.length === 0
          ? "No models listed"
          : harness === "opencode"
            ? `${models.length} models, sets its own effort`
            : `${models.length} ${models.length === 1 ? "model" : "models"}`,
        off: false,
        items: matching.map((model) => ({
          harness,
          model: model.id,
          saved: saved?.harness === harness && saved.model === model.id,
          selected: current?.harness === harness && current.model === model.id,
          custom: false,
        })),
      });
    }
    const typed = ui.pickerQuery.trim().match(/^([a-z]+):(.+)$/);
    if (typed && harnesses.includes(typed[1]!) && !catalogModel(typed[1]!, typed[2]!.trim())) {
      groups.push({
        harness: typed[1]!,
        note: "",
        off: false,
        items: [{ harness: typed[1]!, model: typed[2]!.trim(), saved: false, selected: false, custom: true }],
      });
    }
    return { groups, items: groups.flatMap((group) => group.items) };
  }

  function pickerHtml(): string {
    const { groups, items } = pickerEntries();
    if (items.length === 0 && groups.every((group) => group.off)) {
      const offGroups = groups.map((group) => `<div class="pk-group"><div class="pk-head off">${chip(group.harness)}<span class="pk-note">${escapeHtml(group.note)}</span></div></div>`).join("");
      return `${offGroups}<p class="pk-empty">No model matches. Type harness:model to use one outside the catalog.</p>`;
    }
    let index = 0;
    return groups.map((group) => {
      if (group.items[0]?.custom) {
        const item = group.items[0];
        const id = index++;
        return `<div class="pk-group"><button type="button" id="picker-opt-${id}" class="pk-item pk-custom${id === ui.pickerIndex ? " kbd" : ""}" role="option" aria-selected="false" data-act="pick" data-harness="${escapeHtml(item.harness)}" data-model="${escapeHtml(item.model)}"><span>Use <span class="mono">${escapeHtml(`${item.harness}:${item.model}`)}</span></span><span class="tag warn">not in catalog</span></button></div>`;
      }
      const head = `<div class="pk-head${group.off ? " off" : ""}">${chip(group.harness)}<span class="pk-note">${escapeHtml(group.note)}</span></div>`;
      const options = group.items.map((item) => {
        const id = index++;
        return `<button type="button" id="picker-opt-${id}" class="pk-item${item.selected ? " sel" : ""}${id === ui.pickerIndex ? " kbd" : ""}" role="option" aria-selected="${item.selected}" data-act="pick" data-harness="${escapeHtml(item.harness)}" data-model="${escapeHtml(item.model)}">${modelText(item.harness, item.model, "pk-title", "pk-id")}${item.saved ? '<span class="tag">saved</span>' : ""}${item.selected ? icon("check", "pk-check") : ""}</button>`;
      }).join("");
      return `<div class="pk-group">${head}${options}</div>`;
    }).join("");
  }

  function policyCaption(mode: string): string {
    if (mode === "none") {
      return `Not set. The orchestrator runs as ${capitalize(presetNames[0] ?? "dispatcher")} until you choose.`;
    }
    const policy = draft.policy ?? baselinePolicy();
    const parts = axes.map((axis) => axis.options.find((option) => option.value === policy[axis.key])?.summary ?? "");
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}` : parts.join("");
    return `${capitalize(mode)}: ${list}.`;
  }

  function fingerprintPoints(policy: SetupDraftPolicy): Array<[number, number]> {
    return axes.map((axis, row) => {
      const level = Math.max(0, axis.options.findIndex((option) => option.value === policy[axis.key]));
      return [3 + level * 6, 3 + row * 6];
    });
  }

  function update(): void {
    const saved = savedDraft();
    const ready = !state.loading && Boolean(state.target);
    const busy = actionInFlight || state.refreshing;
    const settled = (element("setup-root")?.className ?? "").includes("settled");
    setClass("setup-root", `setup-root${ready ? " ready" : ""}${state.loading ? " loading" : ""}${settled ? " settled" : ""}`);

    const configPath = element("setup-config-path");
    if (configPath && state.target?.config?.path) configPath.textContent = state.target.config.path;
    swapText("catalog-status", `catalog-text${state.discoveryError ? " warn" : ""}`, catalogText());
    setClass("setup-refresh", `icon-btn${state.refreshing ? " spinning" : ""}`);
    setClass("setup-catalog", `catalog${state.refreshing ? " refreshing" : ui.catalogDone ? " done" : ""}`);
    setDisabled("setup-refresh", state.refreshing);
    const loadError = !state.target && !state.loading ? state.error ?? "Could not load setup state." : "";
    const errorBanner = element("setup-error");
    if (errorBanner) {
      errorBanner.hidden = !loadError;
      errorBanner.textContent = loadError;
    }

    for (const role of roles) {
      const current = draft.agents[role];
      const changed = ready && roleChanged(role, saved);
      setClass(`role-row-${role}`, `r-row${changed ? " changed" : ""}${ready && !current ? " unbound" : ""}`);
      setHtml(`binding-${role}`, bindingHtml(role));
      setDisabled(`binding-${role}`, !ready);
      setAttr(`binding-${role}`, "aria-expanded", String(ui.pickerRole === role));

      const noEffort = current?.harness === "opencode";
      const supported = current ? supportedEfforts(current.harness, current.model) : undefined;
      const level = current && !noEffort ? efforts.indexOf(current.effort) + 1 : 0;
      const effortMark = ready && (effortChanged(role, saved) || (modelChanged(role, saved) && effortOf(current) !== effortOf(saved.agents[role])));
      setClass(`effort-${role}`, `meter lvl-${level}${effortMark ? " changed" : ""}${noEffort ? " none" : ""}${ready && !current ? " unbound" : ""}`);
      for (const effort of efforts) {
        setDisabled(`effort-${role}-${effort}`, !ready || !current || noEffort || Boolean(supported && !supported.includes(effort)));
        setAttr(`effort-${role}-${effort}`, "aria-checked", String(current?.effort === effort));
      }
      swapText(`effort-label-${role}`, "meter-label", !ready || !current || noEffort ? "" : current.effort || "default");
      swapText(`effort-note-${role}`, "meter-note", !ready ? "" : !current ? "No model yet" : noEffort ? "opencode sets its own effort" : "");
      setHtml(`role-state-${role}`, roleStateHtml(role, saved));
    }

    const mode = policyMode();
    const column = mode === "none" ? "none" : String(Math.max(0, columns.indexOf(mode)));
    setClass("policy-section", `sec${ready && (policyChanged(saved) || parallelismChanged(saved)) ? " changed" : ""}`);
    setClass("policy-table", `cmp col-${column}`);
    for (const name of columns) {
      setAttr(`policy-col-${name}`, "aria-pressed", String(mode === name));
      setDisabled(`policy-col-${name}`, !ready);
    }
    const customPolicy = draft.policy ?? baselinePolicy();
    for (const axis of axes) {
      const index = Math.max(0, axis.options.findIndex((option) => option.value === customPolicy[axis.key]));
      setClass(`policy-pick-${axis.key}`, `cmp-picks at-${index}`);
      for (const option of axis.options) {
        setAttr(`policy-pick-${axis.key}-${option.value}`, "aria-checked", String(option.value === customPolicy[axis.key]));
        setDisabled(`policy-pick-${axis.key}-${option.value}`, !ready);
      }
      swapText(`policy-custom-label-${axis.key}`, "cmp-custom-label", axis.options[index]?.label ?? "");
    }
    const points = fingerprintPoints(customPolicy);
    setAttr("policy-fp-line", "d", points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" "));
    points.forEach(([x], index) => setAttr(`policy-fp-dot-${index}`, "cx", String(x)));
    swapText("policy-caption", "policy-caption", ready ? policyCaption(mode) : "Loading policy");
    setDisabled("orchestrator-parallelism", !ready || !draft.policy);
    setAttr("orchestrator-parallelism", "placeholder", draft.policy ? "No limit" : "Not set");

    const sandboxAt = draft.sandbox === "workspace-write" ? "0" : draft.sandbox === "danger-full-access" ? "1" : "none";
    setClass("sandbox-row", `rt-row${ready && sandboxChanged(saved) ? " changed" : ""}`);
    setClass("sandbox-control", `seg-ctl at-${sandboxAt}`);
    for (const value of ["workspace-write", "danger-full-access"]) {
      setAttr(`sandbox-${value}`, "aria-checked", String(draft.sandbox === value));
      setDisabled(`sandbox-${value}`, !ready);
    }
    const sandboxCopy = !ready
      ? ""
      : draft.sandbox === "danger-full-access"
        ? "No sandbox for Codex workers. They can reach the network and anything your user can."
        : draft.sandbox === "workspace-write"
          ? "Codex workers write only inside their workspace, with no network."
          : "Not set. Codex runs with workspace write.";
    swapText("sandbox-copy", `rt-copy${draft.sandbox === "danger-full-access" ? " warn" : ""}`, sandboxCopy);

    setClass("autocompact-row", `rt-row${ready && autocompactChanged(saved) ? " changed" : ""}`);
    setClass("setup-autocompact", `switch${draft.autocompact === undefined ? " unset" : ""}`);
    setAttr("setup-autocompact", "aria-checked", String(draft.autocompact === true));
    setDisabled("setup-autocompact", !ready);
    const autocompactCopy = !ready
      ? ""
      : draft.autocompact === true
        ? "Claude and OpenCode sessions compact their context before it fills up."
        : draft.autocompact === false
          ? "Off. CodeDeck leaves context compaction to each harness."
          : "Not set, so it stays off. CodeDeck leaves compaction to each harness.";
    swapText("autocompact-copy", "rt-copy", autocompactCopy);

    const names = ready ? changeNames(saved) : [];
    const barError = state.error && !ui.drawer && state.target ? state.error : "";
    setClass("setup-bar", `savebar${names.length > 0 ? " dirty" : ""}${barError ? " has-error" : ""}`);
    const status = barError
      || (state.loading
        ? "Loading setup"
        : !state.target
          ? "Setup not loaded"
          : actionInFlight
            ? actionInFlightLabel
            : names.length === 0
              ? "All changes saved"
              : `${names.length} unsaved ${names.length === 1 ? "change" : "changes"}`);
    swapText("setup-action-status", "sb-status", status);
    swapText("setup-change-list", "sb-list", barError ? "" : names.join(", "));
    setDisabled("setup-discard", names.length === 0 || busy || !ready);
    setDisabled("setup-review", names.length === 0 || busy || !ready);

    setClass("setup-scrim", `scrim${ui.drawer ? " open" : ""}`);
    setClass("setup-drawer", `drawer${ui.drawer ? " open" : ""}`);
    setAttr("setup-drawer", "aria-hidden", String(!ui.drawer));
    const drawerPath = element("setup-drawer-path");
    if (drawerPath && state.target?.config?.path) drawerPath.textContent = state.target.config.path;
    setHtml("setup-result", renderReview());
    const offRoles = offCatalogRoles(saved);
    const confirmHtml = offRoles.map((role) => {
      const current = draft.agents[role]!;
      return `<label class="confirm"><input type="checkbox" data-act="confirm-off" data-role="${role}"><span>Save <span class="mono">${escapeHtml(current.model)}</span> for ${escapeHtml(role)} even though the ${escapeHtml(current.harness)} catalog does not list it.</span></label>`;
    }).join("");
    if (setHtml("setup-confirmations", confirmHtml)) ui.confirmOff = {};
    const pending = offRoles.filter((role) => !ui.confirmOff[role]);
    setDisabled("setup-apply", actionInFlight || !ui.reviewOk || pending.length > 0);

    setClass("setup-picker", `picker${ui.pickerRole ? " open" : ""}`);
    setAttr("setup-picker", "aria-hidden", String(!ui.pickerRole));
    if (ui.pickerRole) {
      setHtml("setup-picker-list", pickerHtml());
      setAttr("setup-picker-search", "aria-activedescendant", `picker-opt-${ui.pickerIndex}`);
    }

    if (ready) ui.rendered = true;
    options.onChange?.(state);
  }

  function placePicker(): void {
    const role = ui.pickerRole;
    const picker = element("setup-picker");
    const rect = role ? element(`binding-${role}`)?.getBoundingClientRect?.() : undefined;
    if (!picker?.style || !rect) return;
    const view = globalThis as { innerWidth?: number; innerHeight?: number };
    const width = Math.min(Math.max(rect.width, 380), (view.innerWidth ?? 1024) - 32);
    const left = Math.min(Math.max(16, rect.left), (view.innerWidth ?? 1024) - width - 16);
    const below = (view.innerHeight ?? 768) - rect.bottom - 22;
    const above = rect.top - 22;
    const up = below < 260 && above > below;
    const height = Math.min(420, up ? above : below);
    picker.style.left = `${left}px`;
    picker.style.width = `${width}px`;
    picker.style.maxHeight = `${Math.max(160, height)}px`;
    picker.style.top = up ? `${rect.top - 6 - Math.max(160, height)}px` : `${rect.bottom + 6}px`;
    picker.style.transformOrigin = up ? "bottom left" : "top left";
  }

  function openPicker(role: Role): void {
    if (!state.target || state.loading) return;
    ui.pickerRole = role;
    ui.pickerQuery = "";
    const search = element("setup-picker-search");
    if (search) search.value = "";
    const selected = pickerEntries().items.findIndex((item) => item.selected);
    ui.pickerIndex = Math.max(0, selected);
    placePicker();
    update();
    search?.focus?.();
    element(`picker-opt-${ui.pickerIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }

  function closePicker(restoreFocus = true): void {
    const role = ui.pickerRole;
    if (!role) return;
    ui.pickerRole = undefined;
    update();
    if (restoreFocus) element(`binding-${role}`)?.focus?.();
  }

  function setPickerQuery(value: string): void {
    ui.pickerQuery = value;
    ui.pickerIndex = 0;
    update();
    const list = element("setup-picker-list");
    if (list) list.scrollTop = 0;
  }

  function movePicker(step: number): void {
    const count = pickerEntries().items.length;
    if (count === 0) return;
    ui.pickerIndex = (ui.pickerIndex + step + count) % count;
    update();
    element(`picker-opt-${ui.pickerIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }

  function selectBinding(role: Role, harness: string, model: string): void {
    const previous = draft.agents[role];
    const saved = savedDraft().agents[role];
    let effort = previous?.effort ?? "";
    if (saved && saved.harness === harness && saved.model === model) {
      effort = saved.effort;
    } else {
      const supported = supportedEfforts(harness, model);
      if (effort && supported && !supported.includes(effort)) {
        const wanted = efforts.indexOf(effort);
        effort = [...supported].reverse().find((level) => efforts.indexOf(level) <= wanted) ?? supported[0] ?? "";
      }
    }
    draft.agents[role] = { harness, model, effort };
    delete ui.confirmOff[role];
    if (ui.pickerRole === role) closePicker(true);
    else update();
  }

  function handleKey(event?: SetupPageEvent): void {
    const key = event?.key;
    if (ui.pickerRole) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        event?.preventDefault?.();
        movePicker(key === "ArrowDown" ? 1 : -1);
      } else if (key === "Enter") {
        event?.preventDefault?.();
        const item = pickerEntries().items[ui.pickerIndex];
        if (item) selectBinding(ui.pickerRole, item.harness, item.model);
      } else if (key === "Escape") {
        event?.preventDefault?.();
        closePicker(true);
      }
      return;
    }
    if (key === "Escape" && ui.drawer) closeReview();
  }

  function setEffort(role: Role, effort: string): void {
    const current = draft.agents[role];
    if (!current || !efforts.includes(effort)) return;
    current.effort = effort;
    update();
  }

  function revertRole(role: Role): void {
    const saved = savedDraft().agents[role];
    if (saved) draft.agents[role] = saved;
    else delete draft.agents[role];
    delete ui.confirmOff[role];
    update();
  }

  function choosePreset(name: string): void {
    const preset = presets[name];
    if (!preset) return;
    draft.policy = { investigate: preset.investigate, selfWork: preset.selfWork, tools: preset.tools };
    draft.custom = false;
    update();
  }

  function chooseCustom(): void {
    draft.policy = draft.policy ?? baselinePolicy();
    draft.custom = true;
    update();
  }

  function setPolicyValue(key: string, value: string): void {
    const axis = axes.find((candidate) => candidate.key === key);
    if (!axis?.options.some((option) => option.value === value)) return;
    draft.policy = { ...(draft.policy ?? baselinePolicy()), [key]: value } as SetupDraftPolicy;
    draft.custom = true;
    update();
  }

  function syncParallelism(): void {
    const input = element("orchestrator-parallelism");
    if (input) input.value = draft.parallelism;
  }

  function setParallelism(value: string): void {
    draft.parallelism = value;
    if (state.error) state.error = undefined;
    update();
  }

  function setSandbox(value: string): void {
    if (value !== "workspace-write" && value !== "danger-full-access") return;
    draft.sandbox = value;
    update();
  }

  function setAutocompact(value?: boolean): void {
    draft.autocompact = value ?? !draft.autocompact;
    update();
  }

  function resetDraft(): void {
    draft = cloneDraft(savedDraft());
    ui.confirmOff = {};
    syncParallelism();
  }

  function discard(): void {
    resetDraft();
    state.error = undefined;
    update();
  }

  function confirmOffCatalog(role: Role, checked: boolean): void {
    ui.confirmOff[role] = checked;
    update();
  }

  async function openReview(): Promise<{ ok: boolean; status: number; payload: unknown } | undefined> {
    if (changeNames().length === 0 || actionInFlight) return;
    try {
      buildSelection();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      update();
      return;
    }
    closePicker(false);
    ui.drawer = true;
    ui.reviewOk = false;
    state.error = undefined;
    state.envelope = undefined;
    update();
    element("setup-drawer-close")?.focus?.();
    return await dryRun();
  }

  function closeReview(): void {
    if (!ui.drawer) return;
    ui.drawer = false;
    if (state.error && state.envelope !== undefined) state.error = undefined;
    update();
    element("setup-review")?.focus?.();
  }

  function showToast(text: string): void {
    const toast = element("setup-toast");
    if (!toast) return;
    toast.innerHTML = `${icon("check")}<span>${escapeHtml(text)}</span>`;
    toast.className = "toast show";
    clearTimeout(toastTimer as ReturnType<typeof setTimeout>);
    toastTimer = setTimeout(() => { toast.className = "toast"; }, 2800);
  }

  function onClick(event?: SetupPageEvent): void {
    type Actor = { getAttribute(name: string): string | null; checked?: boolean };
    const target = event?.target as { closest?(selector: string): Actor | null } | undefined;
    const actor = target?.closest?.("[data-act]") ?? null;
    const act = actor?.getAttribute("data-act");
    if (ui.pickerRole && !target?.closest?.("#setup-picker") && act !== "open-picker") closePicker(false);
    if (!actor || !act) return;
    const role = actor.getAttribute("data-role") as Role | null;
    const value = actor.getAttribute("data-value") ?? "";
    if (act === "open-picker" && role) {
      if (ui.pickerRole === role) closePicker(true);
      else openPicker(role);
    } else if (act === "pick" && ui.pickerRole) {
      selectBinding(ui.pickerRole, actor.getAttribute("data-harness") ?? "", actor.getAttribute("data-model") ?? "");
    } else if (act === "effort" && role) setEffort(role, value);
    else if (act === "revert" && role) revertRole(role);
    else if (act === "preset") choosePreset(value);
    else if (act === "custom") chooseCustom();
    else if (act === "policy-value") setPolicyValue(actor.getAttribute("data-key") ?? "", value);
    else if (act === "sandbox") setSandbox(value);
    else if (act === "autocompact") setAutocompact();
    else if (act === "discard") discard();
    else if (act === "review") void openReview();
    else if (act === "close-review") closeReview();
    else if (act === "apply") void apply();
    else if (act === "refresh") void refreshCatalog();
    else if (act === "confirm-off" && role) confirmOffCatalog(role, Boolean(actor.checked));
  }

  function bindEvents(): void {
    if (ui.bound) return;
    ui.bound = true;
    const doc = options.document;
    doc?.addEventListener?.("click", onClick);
    doc?.addEventListener?.("keydown", handleKey);
    doc?.addEventListener?.("scroll", () => { if (ui.pickerRole) placePicker(); }, true);
    (globalThis as { addEventListener?(name: string, callback: () => void): void })
      .addEventListener?.("resize", () => { if (ui.pickerRole) placePicker(); });
    element("setup-picker-search")?.addEventListener?.("input", () => setPickerQuery(element("setup-picker-search")?.value ?? ""));
    element("orchestrator-parallelism")?.addEventListener?.("input", () => setParallelism(element("orchestrator-parallelism")?.value ?? ""));
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

  async function loadState(): Promise<boolean> {
    const { response, payload } = await loadJson("/api/setup/state");
    if (!response.ok) {
      state.error = typeof payload.error === "string" ? payload.error : "Could not load setup state.";
      return false;
    }
    state.target = payload as unknown as SetupPageTargetState;
    resetDraft();
    return true;
  }

  async function start(): Promise<SetupPageClientState> {
    bindEvents();
    update();
    try {
      if (await loadState()) {
        const catalog = await loadJson("/api/setup/catalog");
        if (catalog.response.ok) {
          state.catalog = catalog.payload as unknown as BatchModelsResult;
          state.discoveryError = typeof catalog.payload.discoveryError === "string" ? catalog.payload.discoveryError : undefined;
        } else {
          state.discoveryError = typeof catalog.payload.error === "string" ? catalog.payload.error : "Could not load model catalog.";
        }
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    state.loading = false;
    update();
    // Class changes made by the first render should land without sliding.
    setTimeout(() => setClass("setup-root", `${element("setup-root")?.className ?? "setup-root"} settled`), 60);
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
        return { ok: true, status: response.status, payload };
      } catch (error) {
        state.discoveryError = error instanceof Error ? error.message : String(error);
        return { ok: false, status: 500, payload: { error: state.discoveryError } };
      } finally {
        state.refreshing = false;
        refreshInFlight = undefined;
        // Let the progress bar finish its sweep before it fades out.
        ui.catalogDone = true;
        update();
        setTimeout(() => {
          ui.catalogDone = false;
          update();
        }, 450);
      }
    })();
    return refreshInFlight;
  }

  function buildSelection(values: SetupPageFormValues = readForm()): ReturnType<typeof buildSetupSelection> {
    if (!state.target) throw new Error("Setup state is not loaded.");
    return options.buildSelection(values, state.target.bindings);
  }

  // The dry-run route never accepts an off-catalog model, since only apply
  // takes offCatalogConfirmed. A 422 whose only failures are models the user
  // can confirm in the drawer is still a reviewable plan.
  function onlyOffCatalogFailures(body: Record<string, unknown>): boolean {
    const validations = typeof body.validacoes === "object" && body.validacoes !== null
      ? body.validacoes as Record<string, unknown>
      : {};
    const entries = Array.isArray(validations.bindings) ? validations.bindings as Array<Record<string, unknown>> : [];
    const failed = entries.filter((entry) => entry.status !== "accepted");
    const confirmable = offCatalogRoles();
    return failed.length > 0 && failed.every((entry) =>
      (entry.status === "unknown-model" || entry.status === "unverified") &&
      confirmable.includes(entry.role as Role),
    );
  }

  async function postAction(
    path: string,
    selection: ReturnType<typeof buildSetupSelection>,
  ): Promise<{ ok: boolean; status: number; payload: unknown }> {
    const isDryRun = path.endsWith("/dry-run");
    state.error = undefined;
    actionInFlight = true;
    actionInFlightLabel = isDryRun ? "Checking changes" : "Saving";
    if (isDryRun) {
      state.envelope = undefined;
      ui.reviewOk = false;
    }
    update();
    try {
      const response = await options.fetcher(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selection),
      });
      const payload = await response.json();
      const body = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
      const result = typeof body.resultado === "object" && body.resultado !== null
        ? body.resultado as Record<string, unknown>
        : {};
      if (response.status === 403) {
        state.error = options.expiredMessage;
      } else if (!response.ok) {
        state.error = typeof result.message === "string"
          ? result.message
          : typeof body.error === "string"
            ? body.error
            : "Setup request failed.";
      }
      if (isDryRun) {
        const confirmable = response.status === 422 && onlyOffCatalogFailures(body);
        if (confirmable) state.error = undefined;
        ui.reviewOk = (response.ok && result.status === "dry-run") || confirmable;
      }
      state.envelope = payload;
      return { ok: response.ok, status: response.status, payload };
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
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
    for (const role of roles) {
      const binding = selection.agents[role];
      const previous = state.target?.bindings[role];
      if (!binding || (previous?.harness === binding.harness && previous.model === binding.model)) continue;
      if (!isOffCatalog(binding.harness, binding.model)) continue;
      if (!ui.confirmOff[role]) {
        state.error = `Confirm the off-catalog model for ${role} before saving.`;
        update();
        return;
      }
      confirmed[role] = true;
    }
    if (Object.keys(confirmed).length > 0) selection.offCatalogConfirmed = confirmed;
    const result = await postAction("/api/setup/apply", selection);
    const body = typeof result.payload === "object" && result.payload !== null ? result.payload as Record<string, unknown> : {};
    const status = typeof body.resultado === "object" && body.resultado !== null
      ? (body.resultado as Record<string, unknown>).status
      : undefined;
    if (result.ok && status === "applied") {
      ui.drawer = false;
      ui.reviewOk = false;
      showToast(`Saved to ${state.target?.config?.path ?? "config.json"}`);
      try {
        await loadState();
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      }
      update();
      element("setup-review")?.focus?.();
    }
    return result;
  }

  return {
    state,
    get draft() {
      return draft;
    },
    start,
    refreshCatalog,
    buildSelection,
    readForm,
    dryRun,
    apply,
    changeNames: () => changeNames(),
    openPicker,
    closePicker,
    setPickerQuery,
    handleKey,
    selectBinding,
    setEffort,
    revertRole,
    choosePreset,
    chooseCustom,
    setPolicyValue,
    setParallelism,
    setSandbox,
    setAutocompact,
    discard,
    openReview,
    closeReview,
    confirmOffCatalog,
  };
}

function icon(name: SetupIconName, className = ""): string {
  return `<svg class="ico${className ? ` ${className}` : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderFingerprint(mode: OrchestratorMode, live = false): string {
  const points = SETUP_POLICY_AXES.map((axis, row) => {
    const level = Math.max(0, axis.options.findIndex((option) => option.value === mode[axis.key]));
    return [3 + level * 6, 3 + row * 6] as const;
  });
  const grid = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) =>
    `<circle cx="${3 + col * 6}" cy="${3 + row * 6}" r="1" class="fp-dot"></circle>`)).join("");
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const dots = points.map(([x, y], index) =>
    `<circle${live ? ` id="policy-fp-dot-${index}"` : ""} class="fp-pt" cx="${x}" cy="${y}" r="1.9"></circle>`).join("");
  return `<svg class="fp" viewBox="0 0 18 18" aria-hidden="true" focusable="false">${grid}<path${live ? ' id="policy-fp-line"' : ""} class="fp-line" d="${line}"></path>${dots}</svg>`;
}

function renderRoleRow(role: Role): string {
  const segments = REASONING_EFFORTS.map((effort) =>
    `<button id="effort-${role}-${effort}" class="seg" type="button" role="radio" aria-checked="false" aria-label="${effort}" title="${effort}" data-act="effort" data-role="${role}" data-value="${effort}" disabled></button>`).join("");
  return `<div id="role-row-${role}" class="r-row" role="row">
        <div class="r-role" role="cell"><span class="r-dot" aria-hidden="true"></span><div><div class="r-name">${capitalize(role)}</div><div class="r-desc">${ROLE_COPY[role]}</div></div></div>
        <div class="r-model" role="cell"><button id="binding-${role}" class="model-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" data-act="open-picker" data-role="${role}" disabled><span class="model-sk"><span class="sr-only">Loading</span></span>${icon("chevron-down", "chev")}</button></div>
        <div class="r-effort" role="cell"><div id="effort-${role}" class="meter lvl-0" role="radiogroup" aria-label="Reasoning effort for ${role}"><span class="meter-segs">${segments}</span><span id="effort-label-${role}" class="meter-label"></span><span id="effort-note-${role}" class="meter-note"></span></div></div>
        <div id="role-state-${role}" class="r-state" role="cell"></div>
      </div>`;
}

function renderPolicyTable(): string {
  const presetNames = Object.keys(ORCHESTRATOR_PRESETS) as Array<keyof typeof ORCHESTRATOR_PRESETS>;
  const columns = [...presetNames, "custom"] as const;
  const heads = columns.map((name, index) => {
    const mode = name === "custom" ? ORCHESTRATOR_PRESETS.balanced : ORCHESTRATOR_PRESETS[name];
    return `<button id="policy-col-${name}" class="cmp-head c${index}" type="button" aria-pressed="false" data-act="${name === "custom" ? "custom" : "preset"}" data-value="${name}" disabled>${renderFingerprint(mode, name === "custom")}<span>${capitalize(name)}</span></button>`;
  }).join("");
  const rows = SETUP_POLICY_AXES.map((axis, row) => {
    const last = row === SETUP_POLICY_AXES.length - 1 ? " last" : "";
    const presetCells = presetNames.map((name, index) => {
      const option = axis.options.find((candidate) => candidate.value === ORCHESTRATOR_PRESETS[name][axis.key])!;
      return `<div class="cmp-cell c${index}${last}">${icon(option.icon)}<span>${option.label}</span></div>`;
    }).join("");
    const start = axis.options.findIndex((option) => option.value === ORCHESTRATOR_PRESETS.balanced[axis.key]);
    const picks = axis.options.map((option) =>
      `<button id="policy-pick-${axis.key}-${option.value}" class="cmp-pick" type="button" role="radio" aria-checked="false" aria-label="${option.label}" title="${option.label}" data-act="policy-value" data-key="${axis.key}" data-value="${option.value}" disabled>${icon(option.icon)}</button>`).join("");
    const custom = `<div class="cmp-cell custom c${presetNames.length}${last}"><div id="policy-pick-${axis.key}" class="cmp-picks at-${start}" role="radiogroup" aria-label="Custom: ${axis.label}"><span class="pick-thumb" aria-hidden="true"></span>${picks}</div><span id="policy-custom-label-${axis.key}" class="cmp-custom-label">${axis.options[start]!.label}</span></div>`;
    return `<div class="cmp-label${last}">${axis.label}</div>${presetCells}${custom}`;
  }).join("");
  return `<div class="cmp-wrap"><div id="policy-table" class="cmp col-none" role="group" aria-label="Orchestrator policy"><span class="cmp-hl" aria-hidden="true"></span><div class="cmp-corner"></div>${heads}${rows}</div></div>`;
}

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
  ${renderSetupSprite()}
  ${topbar}
  <div id="setup-root" class="setup-root loading">
  <main class="setup-main">
    <header class="page-head">
      <div><h1>Setup</h1><p class="lede">Pick the harness and model each role runs on. Saving writes <code id="setup-config-path" class="mono">config.json</code>.</p></div>
      <div id="setup-catalog" class="catalog" style="--refresh-ms:${CATALOG_DISCOVERY_TIMEOUT_MS}ms"><div class="cat-main"><span id="catalog-status" class="catalog-text" role="status">Loading catalog</span><span class="cat-bar" aria-hidden="true"><span></span></span></div><button id="setup-refresh" class="icon-btn" type="button" data-act="refresh" aria-label="Refresh model catalog" title="Refresh model catalog">${icon("rotate-cw", "i-idle")}${icon("loader", "i-spin")}</button></div>
    </header>
    <p id="setup-error" class="load-error" role="alert" hidden></p>

    <section class="sec" aria-labelledby="roles-title">
      <div class="sec-head"><h2 id="roles-title">Roles</h2><p>Click a model to change it. Nothing is written until you save.</p></div>
      <div class="roster" role="table" aria-labelledby="roles-title">
        <div class="r-row r-head" role="row"><span role="columnheader">Role</span><span role="columnheader">Harness and model</span><span role="columnheader">Reasoning effort</span><span role="columnheader"><span class="sr-only">State</span></span></div>
        ${SETUP_ROLE_ORDER.map((role) => renderRoleRow(role)).join("")}
      </div>
    </section>

    <div class="bottom">
      <section id="policy-section" class="sec" aria-labelledby="policy-title">
        <div class="sec-head"><h2 id="policy-title"><span class="sec-dot" aria-hidden="true"></span>Orchestrator policy</h2><p>How much the orchestrator does itself before it hands work off.</p></div>
        ${renderPolicyTable()}
        <p id="policy-caption" class="policy-caption">Loading policy</p>
        <div class="pf"><label for="orchestrator-parallelism"><span class="pf-label">Parallel workers</span><span class="pf-copy">The most workers it runs at once. It goes into the orchestrator's prompt as guidance. Leave blank for no limit.</span></label><input id="orchestrator-parallelism" class="num" type="number" min="1" step="1" inputmode="numeric" placeholder="No limit" disabled></div>
      </section>

      <section class="sec" aria-labelledby="runtime-title">
        <div class="sec-head"><h2 id="runtime-title">Runtime</h2><p>Defaults for new sessions.</p></div>
        <div class="rt">
          <div id="sandbox-row" class="rt-row">
            <div class="rt-text"><div class="rt-label"><span class="sec-dot" aria-hidden="true"></span>Sandbox <span class="tag">Codex</span></div><p id="sandbox-copy" class="rt-copy"></p></div>
            <div id="sandbox-control" class="seg-ctl at-none" role="radiogroup" aria-label="Codex sandbox"><span class="seg-thumb" aria-hidden="true"></span><button id="sandbox-workspace-write" type="button" role="radio" aria-checked="false" data-act="sandbox" data-value="workspace-write" disabled>${icon("shield-check")}Workspace write</button><button id="sandbox-danger-full-access" type="button" role="radio" aria-checked="false" data-act="sandbox" data-value="danger-full-access" disabled>${icon("shield-alert")}Full access</button></div>
          </div>
          <div id="autocompact-row" class="rt-row">
            <div class="rt-text"><div class="rt-label"><span class="sec-dot" aria-hidden="true"></span>Autocompact <span class="tag">Claude, OpenCode</span></div><p id="autocompact-copy" class="rt-copy"></p></div>
            <button id="setup-autocompact" class="switch unset" type="button" role="switch" aria-checked="false" aria-label="Autocompact" data-act="autocompact" disabled></button>
          </div>
        </div>
      </section>
    </div>

    <div id="setup-bar" class="savebar" role="region" aria-label="Unsaved changes">
      <div class="sb-left"><span class="sb-dot" aria-hidden="true"></span><strong id="setup-action-status" class="sb-status" role="status" aria-live="polite">Loading setup</strong><span id="setup-change-list" class="sb-list"></span></div>
      <button id="setup-discard" class="btn ghost" type="button" data-act="discard" disabled>Discard</button>
      <button id="setup-review" class="btn primary" type="button" data-act="review" disabled>Review and save</button>
    </div>
  </main>

  <div id="setup-scrim" class="scrim" data-act="close-review"></div>
  <aside id="setup-drawer" class="drawer" role="dialog" aria-modal="true" aria-labelledby="setup-drawer-title" aria-hidden="true">
    <header class="dr-head"><div><h2 id="setup-drawer-title">Review changes</h2><p id="setup-drawer-path" class="dr-path mono">config.json</p></div><button id="setup-drawer-close" class="icon-btn" type="button" data-act="close-review" aria-label="Close review">${icon("x")}</button></header>
    <div class="dr-body"><div id="setup-confirmations" class="confirmations"></div><div id="setup-result" class="result-content" aria-live="polite"></div></div>
    <footer class="dr-foot"><button class="btn ghost" type="button" data-act="close-review">Keep editing</button><button id="setup-apply" class="btn primary" type="button" data-act="apply" disabled>Save changes</button></footer>
  </aside>

  <div id="setup-picker" class="picker" aria-hidden="true">
    <input id="setup-picker-search" class="search" type="text" role="combobox" aria-expanded="true" aria-controls="setup-picker-list" aria-autocomplete="list" aria-label="Search models" placeholder="Search models or type harness:model" autocomplete="off" spellcheck="false">
    <div id="setup-picker-list" class="pk-list" role="listbox" aria-label="Models"></div>
  </div>
  <div id="setup-toast" class="toast" role="status" aria-live="polite"></div>
  </div>
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
      roles: ${JSON.stringify(SETUP_ROLE_ORDER)},
      presets: ${JSON.stringify(ORCHESTRATOR_PRESETS)},
      efforts: ${JSON.stringify(REASONING_EFFORTS)},
      harnesses: ${JSON.stringify(AGENT_IDS)},
      axes: ${JSON.stringify(SETUP_POLICY_AXES)},
      expiredMessage: ${JSON.stringify(SETUP_SESSION_EXPIRED_MESSAGE)},
      document,
    });
    globalThis.setupPageReady = globalThis.setupPage.start();
  </script>
</body>
</html>`;
}

const LEVEL_RULES = [1, 2, 3, 4, 5].map((level) =>
  `.meter.lvl-${level} .seg:nth-child(-n+${level})::before{background:var(--text)}.meter.changed.lvl-${level} .seg:nth-child(-n+${level})::before{background:var(--blue)}`).join("");
const SEGMENT_DELAYS = [2, 3, 4, 5].map((n) => `.seg:nth-child(${n})::before{transition-delay:${(n - 1) * 28}ms}`).join("");
const COLUMN_RULES = [0, 1, 2, 3].map((column) =>
  `.cmp.col-${column} .cmp-hl{transform:translateX(${column * 100}%)}.cmp.col-${column} .c${column}{color:var(--text)}.cmp.col-${column} .cmp-cell.c${column}:not(.custom) .ico,.cmp.col-${column} .cmp-head.c${column} .fp{color:var(--blue-text)}`).join("");
const PICK_RULES = [0, 1, 2].map((index) =>
  `.cmp-picks.at-${index} .pick-thumb{transform:translateX(${index * 28}px)}.cmp-picks.at-${index} .cmp-pick:nth-of-type(${index + 1}){color:var(--text)}.cmp.col-3 .cmp-picks.at-${index} .cmp-pick:nth-of-type(${index + 1}){color:var(--blue-text)}`).join("");

export const SETUP_CSS = `
:root{--blue-text:#60a5fa;--blue-soft:rgba(0,112,243,.1);--blue-line:rgba(0,112,243,.55);--warn:#f5a524;--warn-text:#f7c56b;--ok-text:#8fe0bc;--err-text:#ff9592;--ease:cubic-bezier(.2,.8,.2,1)}
body{font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
button{cursor:pointer;color:inherit}button:disabled{cursor:not-allowed}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
h1,h2,h3,p{margin:0}h1,h2{text-wrap:balance}
[hidden]{display:none!important}
.mono{font-family:var(--font-mono)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sprite{position:absolute;width:0;height:0;overflow:hidden}
.ico{display:block;flex:none;width:16px;height:16px}
.topbar{height:52px;display:flex;align-items:center;gap:24px;padding:0 28px;border-bottom:1px solid var(--border);background:var(--bg)}
.brand{display:flex;align-items:center;gap:8px;color:var(--text);text-decoration:none;font-weight:600;font-size:15px;letter-spacing:-.3px}.brand svg{display:block}
.topbar-title{font-size:13px;color:var(--text-muted);border-left:1px solid var(--border-strong);padding-left:18px}.topbar nav{display:flex;gap:20px;margin-left:auto}.topbar nav a{color:var(--text-faint);font-size:12px;text-decoration:none}.topbar nav a:hover,.topbar nav a.active{color:var(--text)}
.setup-main{width:min(100%,1240px);margin:0 auto;padding:28px 28px 0}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:8px}
.page-head h1{margin-bottom:6px;font-size:24px;font-weight:600;letter-spacing:-.6px}
.lede{max-width:72ch;color:var(--text-muted)}.lede code{color:var(--text);font-size:12px;overflow-wrap:anywhere}
.catalog{display:flex;align-items:center;gap:8px;min-width:0;color:var(--text-faint);font-size:12px}.catalog-text{display:inline-block}.catalog-text.warn{color:var(--warn-text)}
.cat-main{position:relative;min-width:0}
.cat-bar{position:absolute;left:0;right:0;bottom:-7px;height:2px;overflow:hidden;border-radius:2px;background:var(--border);opacity:0;transition:opacity .3s ease}
.cat-bar>span{display:block;height:100%;border-radius:inherit;background:var(--blue);transform:scaleX(0);transform-origin:left;transition:transform 0s .3s}
.catalog.refreshing .cat-bar,.catalog.done .cat-bar{opacity:1;transition:opacity .15s ease}
.catalog.refreshing .cat-bar>span{transform:scaleX(.95);transition:transform var(--refresh-ms,12s) cubic-bezier(.3,.55,.45,1)}
.catalog.done .cat-bar>span{transform:scaleX(1);transition:transform .25s var(--ease)}
.icon-btn{display:inline-grid;place-items:center;flex:none;width:30px;height:30px;padding:0;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text-muted);transition:color .15s,background-color .15s}
.icon-btn .ico{width:14px;height:14px}.icon-btn:hover:not(:disabled){color:var(--text);background:var(--surface-raised)}
.icon-btn .i-spin,.icon-btn.spinning .i-idle{display:none}
.icon-btn.spinning .i-spin{display:block;color:var(--blue-text);transform-origin:50% 50%;animation:cd-spin .75s linear infinite}
.load-error{margin-top:16px;padding:10px 12px;border:1px solid rgba(229,72,77,.5);border-radius:7px;color:var(--err-text);font-size:12px}
.sec{margin-top:32px}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:6px 12px;flex-wrap:wrap;margin-bottom:12px}
.sec-head h2{display:flex;align-items:center;font-size:14px;font-weight:600;letter-spacing:-.1px}.sec-head p{color:var(--text-faint);font-size:12px}
.sec-dot{display:inline-block;flex:none;width:0;height:7px;border-radius:50%;background:var(--blue);transform:scale(0);transition:transform .25s var(--ease),width .25s var(--ease),margin-right .25s var(--ease)}
.sec.changed .sec-head .sec-dot,.rt-row.changed .sec-dot{width:7px;margin-right:8px;transform:scale(1)}
.tag{display:inline-flex;align-items:center;border:1px solid var(--border-strong);border-radius:999px;padding:1px 7px;color:var(--text-muted);font-size:10.5px;font-weight:400;white-space:nowrap}
.tag.warn{border-color:rgba(245,165,36,.45);color:var(--warn-text)}
.hchip{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted);font-size:12px;white-space:nowrap}
.hmark{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border-radius:6px;background:var(--surface-raised)}
.hmark svg{display:block;width:14px;height:14px}.hchip[data-h="omp"] .hmark svg{width:17px;height:13px}.hchip[data-h="opencode"] .hmark svg{color:var(--text)}
.roster{border-top:1px solid var(--border)}
.r-row{display:grid;grid-template-columns:minmax(190px,1fr) minmax(0,1.35fr) 236px 170px;align-items:center;gap:20px;padding:13px 12px;border-bottom:1px solid var(--border);transition:background-color .25s ease}
.r-head{padding-block:8px;color:var(--text-faint);font-size:11.5px}
.r-row.changed{background:var(--blue-soft)}
.r-role{display:flex;align-items:flex-start;gap:10px;min-width:0}
.r-dot{flex:none;width:7px;height:7px;margin-top:6px;border-radius:50%;background:var(--blue);transform:scale(0);transition:transform .25s var(--ease)}
.r-row.changed .r-dot{transform:scale(1)}
.r-name{font-size:13px;font-weight:600}.r-desc{color:var(--text-faint);font-size:12px}
.model-trigger{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface);text-align:left;transition:border-color .15s,background-color .15s}
.model-trigger:hover:not(:disabled){border-color:#3a3a3a;background:#101010}
.model-trigger[aria-expanded="true"]{border-color:var(--blue)}
.model-trigger:disabled{opacity:.6}
.model-body{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.model-text{display:flex;align-items:baseline;gap:8px;flex:1;min-width:0}
.model-title{flex:none;max-width:100%;overflow:hidden;color:var(--text);font-size:12.5px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.model-title.mono{flex:0 1 auto;font-size:12px;font-weight:400;white-space:normal;overflow-wrap:anywhere}
.model-id{flex:0 1 auto;min-width:0;overflow:hidden;color:var(--text-faint);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.model-sk{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.model-sk::before{content:"";flex:none;width:22px;height:22px;border-radius:6px}.model-sk::after{content:"";width:min(46%,220px);height:10px;border-radius:4px}
.model-empty{flex:1;color:var(--text-faint);font-size:12px}
.chev{width:14px;height:14px;color:var(--text-faint);transition:transform .2s var(--ease)}.model-trigger[aria-expanded="true"] .chev{transform:rotate(180deg)}
.ready .model-body,.ready .r-state>*{animation:cd-in-a .26s var(--ease)}
.meter{display:flex;align-items:center;gap:3px;min-height:24px}
.meter-segs{display:flex;gap:3px}
.seg{display:grid;place-items:center;width:22px;height:20px;padding:0;border:0;background:none}
.seg::before{content:"";display:block;width:100%;height:8px;border-radius:2px;background:var(--border-strong);transition:background-color .18s ease}
${SEGMENT_DELAYS}
${LEVEL_RULES}
.seg:not(:disabled):hover::before{filter:brightness(1.7)}
.seg:disabled::before{opacity:.35}
.meter-label{display:inline-block;min-width:48px;margin-left:8px;color:var(--text-muted);font-size:12px}
.meter-note{display:none;color:var(--text-faint);font-size:12px}
.meter.none .meter-segs,.meter.none .meter-label,.meter.unbound .meter-label{display:none}
.meter.none .meter-note,.meter.unbound .meter-note{display:inline-block}
.meter.unbound .meter-note{margin-left:8px}
.r-state{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;font-size:12px}
.state-note{display:inline-flex;align-items:center;gap:5px;color:var(--text-faint)}.state-note .ico{width:13px;height:13px}
.was{color:var(--text-faint);overflow-wrap:anywhere}.was-value{color:var(--text-muted);text-decoration:line-through;text-decoration-color:var(--text-faint)}
.link-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 4px;margin-left:-4px;border:0;border-radius:4px;background:none;color:var(--text-muted);font-size:12px}
.link-btn .ico{width:13px;height:13px}.link-btn:hover{color:var(--text)}
.bottom{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:48px}
.cmp-wrap{overflow-x:auto;margin-inline:-4px;padding:0 4px 2px}
.cmp{position:relative;display:grid;grid-template-columns:minmax(118px,.9fr) repeat(4,minmax(112px,1fr));grid-template-rows:repeat(4,auto);min-width:590px}
.cmp>*{position:relative;z-index:1}
.cmp .cmp-hl{position:absolute;inset:0;z-index:0;grid-column:2/3;grid-row:1/-1;border:1px dashed transparent;border-radius:9px;background:var(--blue-soft);box-shadow:inset 0 2px 0 var(--blue);transition:transform .38s var(--ease),background-color .25s,box-shadow .25s,border-color .25s}
.cmp.col-none .cmp-hl{background:transparent;box-shadow:none;border-color:var(--border-strong)}
.cmp-corner,.cmp-head,.cmp-label,.cmp-cell{border-bottom:1px solid var(--border)}
.cmp-head{display:flex;align-items:center;gap:8px;padding:11px 12px;border-top:0;border-inline:0;background:none;color:var(--text-muted);font-size:12.5px;font-weight:600;text-align:left;transition:color .2s}
.cmp-head:hover:not(:disabled){color:var(--text)}
.fp{flex:none;width:18px;height:18px;color:var(--text-faint);transition:color .25s}
.fp-dot{fill:var(--border-strong)}.fp-pt{fill:currentColor;transition:cx .32s var(--ease)}
.fp-line{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;transition:d .32s var(--ease)}
.cmp-label{display:flex;align-items:center;padding:10px 12px 10px 0;color:var(--text-muted);font-size:12px}
.cmp-cell{display:flex;align-items:center;gap:8px;padding:10px 12px;color:var(--text-faint);font-size:12px;transition:color .25s}
.cmp-cell .ico{width:14px;height:14px;transition:color .25s}
.cmp-cell.last,.cmp-label.last{border-bottom-color:transparent}
.cmp-cell.custom{flex-direction:column;align-items:flex-start;gap:5px;padding-block:8px}
${COLUMN_RULES}
.cmp-picks{position:relative;display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:6px;background:var(--bg)}
.pick-thumb{position:absolute;top:2px;left:2px;width:26px;height:22px;border-radius:4px;background:var(--surface-raised);transition:transform .3s var(--ease)}
.cmp-pick{position:relative;display:grid;place-items:center;width:26px;height:22px;padding:0;border:0;border-radius:4px;background:none;color:var(--text-faint);transition:color .2s}
.cmp-pick:hover:not(:disabled){color:var(--text)}
${PICK_RULES}
.cmp-custom-label{display:inline-block;font-size:11.5px}
.policy-caption{display:block;margin-top:12px;color:var(--text-muted);font-size:12px}
.pf{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}
.pf label{display:grid;gap:2px}.pf-label{font-size:12.5px;font-weight:600}.pf-copy{max-width:52ch;color:var(--text-muted);font-size:12px}
.num{flex:none;width:112px;min-height:34px;padding:6px 9px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text);font:12px var(--font-mono)}
.num::placeholder{color:var(--text-faint)}.num:focus{outline:2px solid var(--blue);outline-offset:1px}.num:disabled{opacity:.5}
.rt{display:grid}
.rt-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:12px;border-top:1px solid var(--border)}
.rt-row:first-child{padding-top:0;border-top:0}
.rt-label{display:flex;align-items:center;margin-bottom:2px;font-size:12.5px;font-weight:600}.rt-label .tag{margin-left:8px}
.rt-copy{display:block;max-width:46ch;min-height:1.45em;color:var(--text-muted);font-size:12px;transition:color .2s}.rt-copy.warn{color:var(--warn-text)}
.seg-ctl{position:relative;display:grid;flex:none;grid-template-columns:1fr 1fr;gap:3px;padding:3px;border:1px solid var(--border);border-radius:7px;background:var(--bg)}
.seg-thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 9px) / 2);border-radius:4px;background:var(--surface-raised);transition:transform .32s var(--ease),opacity .2s}
.seg-ctl.at-1 .seg-thumb{transform:translateX(calc(100% + 3px))}.seg-ctl.at-none .seg-thumb{opacity:0}
.seg-ctl button{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 10px;border:0;border-radius:4px;background:none;color:var(--text-faint);font-size:11.5px;white-space:nowrap;transition:color .2s}
.seg-ctl button .ico{width:14px;height:14px;transition:color .2s}
.seg-ctl button:hover:not(:disabled){color:var(--text)}
.seg-ctl.at-0 #sandbox-workspace-write,.seg-ctl.at-1 #sandbox-danger-full-access{color:var(--text)}
.seg-ctl.at-0 #sandbox-workspace-write .ico{color:var(--success)}.seg-ctl.at-1 #sandbox-danger-full-access .ico{color:var(--warn)}
.switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:1px solid var(--border-strong);border-radius:999px;background:var(--surface-raised);transition:background-color .2s,border-color .2s}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--text-muted);transition:transform .25s var(--ease),background-color .2s}
.switch.unset{border-style:dashed}
.switch[aria-checked="true"]{border-color:var(--blue);background:var(--blue)}.switch[aria-checked="true"]::after{background:#fff;transform:translateX(16px)}
.switch:disabled{opacity:.5}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:7px 13px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);font-size:12px;font-weight:600;white-space:nowrap;transition:background-color .15s,opacity .2s}
.btn:hover:not(:disabled){background:var(--surface-raised)}
.btn.primary{border-color:var(--blue);background:var(--blue);color:#fff}.btn.primary:hover:not(:disabled){background:#0063d9}
.btn.ghost{border-color:transparent;background:none;color:var(--text-muted)}.btn.ghost:hover:not(:disabled){color:var(--text);background:var(--surface-raised)}
.btn:disabled{opacity:.4}
.savebar{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:8px;margin:36px -28px 0;padding:12px 28px;border-top:1px solid var(--border);background:rgba(0,0,0,.88);backdrop-filter:blur(10px)}
.sb-left{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;flex:1;min-width:0}
.sb-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--blue);align-self:center;transform:scale(0);margin-right:-10px;transition:transform .25s var(--ease),margin .25s var(--ease)}
.savebar.dirty .sb-dot{transform:scale(1);margin-right:0}
.sb-status{display:inline-block;font-size:12.5px}.savebar.has-error .sb-status{color:var(--err-text);font-weight:500}
.sb-list{display:inline-block;color:var(--text-muted);font-size:12px;overflow-wrap:anywhere}
.scrim{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.6);opacity:0;visibility:hidden;transition:opacity .3s ease,visibility 0s .3s}
.scrim.open{opacity:1;visibility:visible;transition:opacity .3s ease}
.drawer{position:fixed;top:0;right:0;bottom:0;z-index:21;display:flex;flex-direction:column;width:min(460px,100%);border-left:1px solid var(--border-strong);background:var(--surface);box-shadow:-24px 0 60px rgba(0,0,0,.5);transform:translateX(100%);visibility:hidden;transition:transform .36s var(--ease),visibility 0s .36s}
.drawer.open{transform:none;visibility:visible;transition:transform .36s var(--ease)}
.dr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border)}
.dr-head h2{font-size:15px;font-weight:600}.dr-path{margin-top:2px;color:var(--text-faint);font-size:11.5px;overflow-wrap:anywhere}
.dr-body{flex:1;display:grid;align-content:start;gap:18px;padding:18px 20px;overflow:auto}
.result-content{display:grid;gap:22px}.result-content:empty{display:none}
.dr-section{animation:cd-in-a .32s var(--ease) both}
.dr-section:nth-child(2){animation-delay:.05s}.dr-section:nth-child(3){animation-delay:.1s}.dr-section:nth-child(4){animation-delay:.15s}
.dr-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border)}
.dr-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;color:var(--text-faint);font-size:11.5px;font-weight:400}
.result-status{display:flex;align-items:flex-start;gap:10px;padding:11px 12px;border:1px solid var(--border-strong);border-radius:7px;background:var(--bg);font-size:12px}
.result-status .ico{width:15px;height:15px;margin-top:1px}.result-status>span{display:grid;gap:2px}
.result-msg{color:var(--text-muted);overflow-wrap:anywhere}
.status-dry-run{border-color:var(--blue-line)}.status-dry-run .ico{color:var(--blue-text)}
.status-applied,.status-unchanged{border-color:rgba(16,185,129,.45)}.status-applied .ico,.status-unchanged .ico{color:var(--success)}
.status-error,.status-aborted{border-color:rgba(229,72,77,.55)}.status-error .ico,.status-aborted .ico{color:var(--error)}
.ch-list{display:grid;gap:6px}
.ch{display:grid;gap:4px;padding:10px 12px;border:1px solid var(--border);border-radius:7px;background:var(--bg)}
.ch-name{font-size:12px;font-weight:600}
.ch-vals{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;color:var(--text-muted);font:11.5px var(--font-mono)}
.ch-vals .before{color:var(--text-faint);text-decoration:line-through;text-decoration-color:var(--text-faint);overflow-wrap:anywhere}
.ch-vals .after{color:var(--text);overflow-wrap:anywhere}.ch-to{color:var(--text-faint);font-family:var(--font-sans)}
.marker{color:var(--blue-text);font:500 10.5px var(--font-sans)}
.counts{display:flex;gap:8px;font:11.5px var(--font-mono)}.add{color:var(--ok-text)}.del{color:var(--err-text)}
.diff{max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:7px;background:var(--bg);font:11px/1.7 var(--font-mono)}
.dl{display:grid;grid-template-columns:30px 30px 14px minmax(max-content,1fr);white-space:pre}
.dl>span{padding-right:6px}.dl .no{color:#3d3d3d;text-align:right;user-select:none}.dl .mk{color:var(--text-faint);user-select:none}
.dl.plus{background:rgba(16,185,129,.09)}.dl.plus .mk{color:var(--ok-text)}
.dl.minus{background:rgba(229,72,77,.09)}.dl.minus .mk{color:var(--err-text)}
.dl .k{color:#8c8c8c}.dl .s{color:#cfcfcf}.dl.plus .s{color:#bff0da}.dl.minus .s{color:#ffc6c4}
.fold{padding:2px 0 2px 76px;border-block:1px solid var(--border);background:#0d0d0d;color:var(--text-faint);font:10.5px var(--font-sans)}
.dr-note{margin-top:6px;color:var(--text-faint);font-size:11px}
.checks{display:grid;gap:7px}
.check{display:flex;align-items:flex-start;gap:8px;color:var(--text-muted);font-size:12px}
.check .ico{width:14px;height:14px;margin-top:1px}.check.ok .ico{color:var(--success)}.check.warn .ico{color:var(--warn)}
.check strong{color:var(--text);font-weight:500}.check-msg{display:block;color:var(--text-faint);overflow-wrap:anywhere}
.empty{margin:0;color:var(--text-faint);font-size:12px}
.confirmations{display:grid;gap:8px}.confirmations:empty{display:none}
.confirm{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid rgba(245,165,36,.4);border-radius:7px;color:var(--warn-text);font-size:12px;animation:cd-in-a .3s var(--ease) both}
.confirm input{margin-top:2px;accent-color:var(--warn)}.confirm .mono{overflow-wrap:anywhere}
.dr-loading{display:grid;gap:10px;color:var(--text-faint);font-size:12px}
.sk{display:block;height:34px;border-radius:7px;background:linear-gradient(90deg,#111 0%,#1c1c1c 50%,#111 100%);background-size:200% 100%;animation:cd-shimmer 1.2s linear infinite}.sk.short{width:62%}
.raw-response{color:var(--text-faint);font-size:11.5px}.raw-response summary{cursor:pointer}
.raw-response pre{max-height:320px;overflow:auto;margin:8px 0 0;padding:10px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text-muted);font:10.5px/1.5 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.picker{position:fixed;top:0;left:0;z-index:30;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);box-shadow:0 18px 40px rgba(0,0,0,.6);opacity:0;visibility:hidden;transform:translateY(-4px) scale(.98);transform-origin:top left;transition:opacity .16s ease,transform .18s var(--ease),visibility 0s .18s}
.picker.open{opacity:1;visibility:visible;transform:none;transition:opacity .16s ease,transform .18s var(--ease)}
.search{display:block;width:100%;padding:11px 12px;border:0;border-bottom:1px solid var(--border);background:none;color:var(--text);font-size:12.5px;outline:none}
.search::placeholder{color:var(--text-faint)}
.pk-list{flex:1;min-height:0;padding:6px;overflow:auto}
.pk-group+.pk-group{margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
.pk-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 6px}
.pk-head.off .hchip{opacity:.5}
.pk-note{min-width:0;color:var(--text-faint);font-size:11px;text-align:right;overflow-wrap:anywhere}
.pk-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px 7px 34px;border:0;border-radius:5px;background:none;color:var(--text-muted);font-size:12px;text-align:left}
.pk-item:hover,.pk-item.kbd{background:var(--surface-raised);color:var(--text)}
.pk-title{flex:none;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pk-title.mono{flex:0 1 auto;max-width:none;white-space:normal;overflow-wrap:anywhere}
.pk-id{flex:1;min-width:40px;overflow:hidden;color:var(--text-faint);font-size:11px;text-align:right;text-overflow:ellipsis;white-space:nowrap}
.pk-item .tag{margin-left:auto}.pk-id+.tag{margin-left:0}
.pk-item.sel{color:var(--text)}.pk-check{width:14px;height:14px;color:var(--blue-text)}
.pk-custom{justify-content:space-between;padding-left:8px}
.pk-empty{margin:0;padding:12px;color:var(--text-faint);font-size:12px}
.toast{position:fixed;left:50%;bottom:24px;z-index:40;display:flex;align-items:center;gap:8px;max-width:calc(100% - 32px);padding:10px 14px;border:1px solid rgba(16,185,129,.45);border-radius:8px;background:var(--surface);box-shadow:0 10px 30px rgba(0,0,0,.5);font-size:12px;opacity:0;visibility:hidden;transform:translate(-50%,10px);transition:opacity .2s ease,transform .3s var(--ease),visibility 0s .3s}
.toast.show{opacity:1;visibility:visible;transform:translate(-50%,0);transition:opacity .2s ease,transform .3s var(--ease)}
.toast .ico{width:14px;height:14px;color:var(--success)}.toast span{overflow-wrap:anywhere}
.swap-a{animation:cd-in-a .26s var(--ease)}.swap-b{animation:cd-in-b .26s var(--ease)}
@keyframes cd-in-a{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes cd-in-b{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes cd-spin{to{transform:rotate(360deg)}}
@keyframes cd-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.loading .model-sk::before,.loading .model-sk::after,.loading .seg::before,.loading .r-state::before,.loading .rt-copy::before,.loading .rt-copy::after,.loading .switch,.loading .num,.loading #setup-config-path,.loading .catalog-text,.loading .policy-caption,.loading .cmp-custom-label,.loading .sb-status{color:transparent!important;background:linear-gradient(90deg,#141414 0%,#232323 50%,#141414 100%);background-size:200% 100%;animation:cd-shimmer 1.4s linear infinite;user-select:none}
.loading #setup-config-path,.loading .catalog-text,.loading .policy-caption,.loading .cmp-custom-label,.loading .sb-status{border-radius:4px}
.loading .policy-caption{width:min(100%,420px)}
.loading .seg:disabled::before,.loading .switch:disabled,.loading .num:disabled{opacity:1}
.loading .r-state::before{content:"";width:52px;height:10px;border-radius:4px}
.loading .rt-copy::before,.loading .rt-copy::after{content:"";display:block;width:min(100%,300px);height:10px;margin-top:5px;border-radius:4px}.loading .rt-copy::after{width:min(70%,190px)}
.loading .switch,.loading .num{border-color:transparent}.loading .switch::after{opacity:0}.loading .num::placeholder{color:transparent}
.loading .cmp-hl,.loading .pick-thumb{opacity:0}.loading .cmp-picks .cmp-pick{color:var(--border-strong)!important}.loading .cmp-custom-label{min-width:60px}
.ready .meter-segs,.ready .switch,.ready .num,.ready .seg-ctl,.ready .cmp-picks,.ready .cmp-hl{animation:cd-fade .3s var(--ease)}
@keyframes cd-fade{from{opacity:0}to{opacity:1}}
.setup-root:not(.settled) *,.setup-root:not(.settled) *::before,.setup-root:not(.settled) *::after{transition:none!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition-duration:0s!important;transition-delay:0s!important}}
@media (max-width:1080px){
  .r-row{grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:10px 20px}
  .r-head{display:none}
  .r-state{flex-direction:row;align-items:center;flex-wrap:wrap;gap:10px}
  .bottom{grid-template-columns:minmax(0,1fr);gap:0}
}
@media (max-width:640px){
  .topbar{height:auto;min-height:52px;flex-wrap:wrap;gap:8px 12px;padding:9px 16px}
  .topbar-title{padding-left:10px;font-size:12px}.topbar nav{gap:12px}
  .setup-main{padding:20px 16px 0}
  .r-row{grid-template-columns:minmax(0,1fr);padding-inline:4px}
  .pf,#sandbox-row{flex-direction:column;align-items:flex-start}
  .seg-ctl{width:100%}
  .savebar{margin-inline:-16px;padding:10px 16px}
  .sb-list{display:none}
}
`;

export const SETUP_PAGE = renderSetupPage();
