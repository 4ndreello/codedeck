import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { detectBinary } from "../../drivers/helpers.js";
import { getRegistry } from "../../drivers/registry.js";
import { getCachedOrDiscoverModels, type HarnessModels } from "../../core/models.js";
import type { Role } from "../../core/roles.js";
import { catalogWarning, judgeModelIn, type ModelVerdict, type OpenFlags } from "../contract.js";
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

export function buildOpenArgs(
  role: Role,
  flags: OpenFlags,
  pluginDir: string,
  passthrough: string[],
): string[] {
  const args = [
    "--model",
    flags.model ?? DEFAULT_MODEL,
    "--effort",
    flags.effort ?? DEFAULT_EFFORT,
    ...(flags.bypass !== false ? ["--dangerously-skip-permissions"] : []),
    "--plugin-dir",
    pluginDir,
    "--append-system-prompt-file",
    path.join(pluginDir, "ultra.md"),
    "--settings",
    JSON.stringify(buildSettings(pluginDir, flags)),
    // `--agent` layers on top of Claude's own system prompt rather than
    // replacing it, and an agent file with no `tools:` key inherits the whole
    // toolset. So `general` carries its contract the same way the others do,
    // with nothing taken away.
    "--agent",
    `${PLUGIN_NAME}:${role}`,
    "-n",
    `CodeDeck · ${role}`,
    ...(flags.resume ? ["--resume", flags.resume] : []),
    ...(flags.worktree ? ["-w"] : []),
    ...passthrough,
  ];

  return args;
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
