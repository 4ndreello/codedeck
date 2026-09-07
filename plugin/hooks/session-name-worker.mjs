import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  buildHaikuPrompt,
  chooseName,
  cleanTitle,
  slugFromPrompt,
} from "./session-name-lib.mjs";

const TIMEOUT_MS = 30_000;

// The only argv is a temp directory. Resolving it and demanding it sit under the
// OS temp root turns a tampered argument into a no-op instead of a read of an
// arbitrary path.
function jobDirFromArgv() {
  const raw = process.argv[2];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const dir = resolve(raw);
  const base = resolve(tmpdir()) + sep;
  return dir.startsWith(base) ? dir : undefined;
}

// An absolute path so the spawn never searches PATH for the command; a writable
// PATH entry can no longer decide which `claude` runs.
function resolveExecutable(name) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

// `claude -p` loads the same plugins, so stripping every CODEDECK_ var keeps the
// nested UserPromptSubmit hook inert and prevents this hook from recursing.
function childEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CODEDECK_")),
  );
}

function runHaiku(prompt) {
  return new Promise((settle) => {
    const bin = resolveExecutable("claude");
    if (bin === undefined) {
      settle(undefined);
      return;
    }

    let output = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      settle(value);
    };

    let child;
    try {
      child = spawn(bin, ["-p", buildHaikuPrompt(prompt), "--model", "haiku"], {
        env: { ...childEnvironment(), MISE_QUIET: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(undefined);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => finish(code === 0 ? output : undefined));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, TIMEOUT_MS);
    timer.unref();
  });
}

const jobDir = jobDirFromArgv();
if (jobDir === undefined) process.exit(0);

let sidecar;
let prompt = "";
try {
  const job = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
  if (job && typeof job === "object" && typeof job.sidecar === "string" && job.sidecar.endsWith(".name")) {
    sidecar = job.sidecar;
    prompt = typeof job.prompt === "string" ? job.prompt : "";
  }
} catch {}

// The sidecar path comes from job.json, not from argv, so writing it is not an
// argument-driven file access.
function writeName(name) {
  if (typeof sidecar !== "string") return;
  try {
    writeFileSync(sidecar, name, { encoding: "utf8", flag: "wx" });
  } catch {}
}

try {
  if (sidecar !== undefined) {
    const rawOutput = await runHaiku(prompt);
    const title = rawOutput === undefined ? undefined : cleanTitle(rawOutput);
    writeName(chooseName(title, prompt));
  }
} catch {
  writeName(slugFromPrompt(prompt));
} finally {
  try {
    rmSync(jobDir, { recursive: true, force: true });
  } catch {}
}
