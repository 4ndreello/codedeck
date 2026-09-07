import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { DISPATCHER_PRESET, type OrchestratorMode } from "../../config/orchestrator-mode.js";
import { detectBinary } from "../../drivers/helpers.js";
import { getRegistry } from "../../drivers/registry.js";
import { autocompactArgs } from "../../core/autocompact.js";
import { getCachedOrDiscoverModels, type HarnessModels } from "../../core/models.js";
import type { RunAgentConfig } from "../../config/config.js";
import type { Role } from "../../core/roles.js";
import { catalogWarning, judgeModelIn, readUltra, type ModelVerdict, type OpenFlags } from "../contract.js";
import { composeOrchestratorProse } from "../orchestrator-prose.js";
import {
  errorDetails,
  sanitizeEnv,
  shellQuote,
  spinnerTips,
  SPINNER_VERBS,
} from "../runtime.js";

export const DEFAULT_MODEL = "claude-opus-4-8";
export const DEFAULT_EFFORT = "xhigh";
const PLUGIN_NAME = "codedeck";
const THEME_REF = `custom:${PLUGIN_NAME}:codedeck-ultra`;

/**
 * There is no startup text slot worth using, and the two that exist were tried.
 *
 * `companyAnnouncements` renders our string, but Claude Code puts its own dim
 * "Message from <organization>:" above it whenever the account belongs to one,
 * with no way to suppress that from settings. On an account with an org it
 * therefore reads as a message from the employer, which is false.
 *
 * A SessionStart hook can print, but every hook message renders as
 * "<hook> says: <text>", so it cannot draw a clean line either.
 *
 * Nothing is lost by leaving both alone. Claude Code's own opening header
 * already names the model, the effort and the agent, and the footer already
 * says whether permissions are bypassed.
 */
export const CLAUDE_NOT_FOUND =
  "Claude Code was not found on PATH. Install Claude Code and ensure `claude` is available.";
const execFileAsync = promisify(execFile);

/**
 * The settings are built here, at launch, rather than shipped as a file, and
 * the reason is the status line.
 *
 * `${CLAUDE_PLUGIN_ROOT}` is expanded only for hooks declared in a plugin's
 * hooks/hooks.json. It is never expanded for statusLine.command: the runner
 * calls its executor with nine arguments where the plugin root sits in the
 * fourteenth, so the check reads undefined and throws "This variable is only
 * available in hooks defined in a plugin's hooks/hooks.json file". The runner
 * swallows that, so the shipped settings.json produced no status line and no
 * error, in any version. `open` knows the real directory, so it writes the
 * resolved path instead of a placeholder nothing will substitute.
 *
 * Building it here also means one definition rather than two: the file that
 * shipped alongside this code was never exercised by a launch, which is exactly
 * how a broken command sat in it unnoticed.
 */
export function buildSettings(pluginDir: string, flags: OpenFlags): Record<string, unknown> {
  const statusLine = {
    type: "command",
    command: `bash ${shellQuote(path.join(pluginDir, "statusline.sh"))}`,
    refreshInterval: 2,
  };

  // --no-theme means "do not restyle my session", so it drops the whole look,
  // renderer included, and not just the palette. The status line is the one
  // thing it keeps, because that is what the flag has always promised.
  if (flags.theme === false) return { statusLine };

  return {
    theme: THEME_REF,
    tui: "fullscreen",
    spinnerVerbs: { mode: "replace", verbs: SPINNER_VERBS },
    spinnerTipsOverride: { excludeDefault: true, label: "ULTRA", tips: spinnerTips() },
    statusLine,
  };
}

/**
 * The session name is what Claude shows on the ruler above the input, in
 * `/resume` and in the window title, so it carries the project folder along
 * with the role. With three terminals open on the same role, the role alone
 * leaves them indistinguishable. The role stays last because the status line
 * reads it off the tail of this same string.
 */
export function sessionName(role: Role, cwd?: string): string {
  const project = cwd?.split("/").filter(Boolean).at(-1)?.replace(/[\t\r\n]/g, " ").trim();
  if (!project) return `CodeDeck · ${role}`;
  return `CodeDeck · ${project} · ${role}`;
}

export function buildOpenArgs(
  role: Role,
  flags: OpenFlags,
  pluginDir: string,
  passthrough: string[],
  cwd?: string,
  mode: OrchestratorMode = DISPATCHER_PRESET,
  config: RunAgentConfig = {},
): string[] {
  const orchestratorProse = role === "orchestrator" ? composeOrchestratorProse(mode) : "";
  const agent = role !== "orchestrator"
    ? `${PLUGIN_NAME}:${role}`
    : `${PLUGIN_NAME}:orchestrator${mode.tools === "dispatch" ? "" : `-${mode.tools}`}`;
  const autocompact = flags.autocompact ?? (config.autocompact === undefined ? false : undefined);

  const args = [
    "--model",
    flags.model ?? DEFAULT_MODEL,
    "--effort",
    flags.effort ?? DEFAULT_EFFORT,
    // Remote Control is interactive-only. It requires a subscribed Claude
    // account and a prior workspace-trust dialog.
    ...(flags.remoteControl !== false ? ["--remote-control"] : []),
    ...(flags.bypass !== false ? ["--dangerously-skip-permissions"] : []),
    "--plugin-dir",
    pluginDir,
    ...appendSystemPromptArgs(pluginDir, orchestratorProse),
    "--settings",
    JSON.stringify(buildSettings(pluginDir, flags)),
    // `--agent` layers on top of Claude's own system prompt rather than
    // replacing it, and an agent file with no `tools:` key inherits the whole
    // toolset. So `general` carries its contract the same way the others do,
    // with nothing taken away.
    "--agent",
    agent,
    "-n",
    sessionName(role, cwd),
    ...(flags.resume ? ["--resume", flags.resume] : []),
    ...(flags.worktree ? ["-w"] : []),
    ...autocompactArgs({ config, explicit: autocompact, passthrough }),
    ...passthrough,
  ];

  return args;
}

/**
 * Ultra ships as a file, but Claude Code refuses --append-system-prompt-file
 * together with --append-system-prompt, and an orchestrator preset needs its
 * dynamic prose appended too. With prose the two are merged and handed over
 * inline as the single source Claude allows; without it the file keeps the
 * original, cheaper contract.
 */
function appendSystemPromptArgs(pluginDir: string, prose: string): string[] {
  if (!prose) return ["--append-system-prompt-file", path.join(pluginDir, "ultra.md")];
  return ["--append-system-prompt", `${readUltra(pluginDir).trimEnd()}\n\n${prose}`];
}

/**
 * The claude half of the split: find this harness's catalog, judge it with
 * the shared pure verdict. Kept while the suite pins this shape.
 */
export function judgeModel(
  model: string,
  catalogs: HarnessModels[] | undefined,
  fromConfig: boolean,
): ModelVerdict {
  return judgeModelIn(
    catalogs?.find((item) => item.agent === "claude"),
    model,
    fromConfig,
    "Claude",
  );
}

export async function preflightModel(model: string, fromConfig: boolean): Promise<void> {
  let catalogs: HarnessModels[] | undefined;
  try {
    catalogs = await getCachedOrDiscoverModels(getRegistry(), { agent: "claude" });
  } catch (error) {
    // A catalog that cannot be reached is not evidence against the model, so
    // this warns and lets the launch decide.
    const details = errorDetails(error);
    console.warn(catalogWarning("Claude", model, `unavailable (${details.text})`));
    return;
  }

  const verdict = judgeModel(model, catalogs, fromConfig);
  if (verdict.kind === "ok") return;
  if (verdict.kind === "unknown-catalog") {
    console.warn(verdict.warning);
    return;
  }
  throw new Error(verdict.error);
}

/**
 * Returns the resolved path rather than a boolean so everything downstream
 * launches the exact binary that was checked, instead of asking PATH again and
 * hoping it answers the same way.
 */
export async function resolveBinary(): Promise<string> {
  // detectBinary reports failure in its result and never rejects, so there is
  // nothing here to catch.
  const installation = await detectBinary("claude");
  if (!installation.installed || !installation.path) {
    throw new Error(CLAUDE_NOT_FOUND);
  }
  return installation.path;
}

export async function assertSupport(claudeBin: string, cwd: string): Promise<void> {
  try {
    await execFileAsync(claudeBin, ["--append-system-prompt-file"], {
      cwd,
      env: sanitizeEnv(process.env),
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const details = errorDetails(error);
    if (details.code === "ENOENT") {
      throw new Error(CLAUDE_NOT_FOUND);
    }

    if (/unknown option|unknown argument|unrecognized option|invalid option/i.test(details.text)) {
      throw new Error(
        "This Claude Code version does not support --append-system-prompt-file. Upgrade Claude Code and retry.",
      );
    }

    // A supported Commander option reports a missing argument for this probe.
    // Other probe failures are left to the real launch, which can provide the
    // harness-specific diagnostic without blocking a valid installation.
  }
}

/**
 * The catalog knows which models exist, not which ones this account may use, so
 * an entitlement problem can only be read off the launch itself. Claude Code
 * reports it as a tagged error rather than a distinct exit code.
 */
export function entitlementError(model: string, output: string): string | undefined {
  const tag = /\[claude-code:unrecognized_model\]\s*(\{.*\})?/i.exec(output);
  if (!tag) return undefined;

  // The passthrough can carry its own --model, which wins over the one CodeDeck
  // resolved, so the name in the payload is the one that was actually rejected.
  let rejected = model;
  if (tag[1]) {
    try {
      const payload = JSON.parse(tag[1]) as { model?: unknown };
      if (typeof payload.model === "string" && payload.model) rejected = payload.model;
    } catch {}
  }

  return `Claude Code rejected model "${rejected}" because this account is not entitled to it. Check the Claude plan or model access for the account.`;
}
