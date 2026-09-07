import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { slugFromPrompt } from "./session-name-lib.mjs";

const worker = fileURLToPath(new URL("./session-name-worker.mjs", import.meta.url));

function writeFallback(sidecar, prompt) {
  try {
    writeFileSync(sidecar, slugFromPrompt(prompt), { encoding: "utf8", flag: "wx" });
  } catch {}
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

if (
  payload === null ||
  typeof payload !== "object" ||
  Array.isArray(payload) ||
  typeof process.env.CODEDECK_SESSION_FILE !== "string" ||
  process.env.CODEDECK_SESSION_FILE.length === 0 ||
  typeof payload.session_id !== "string" ||
  !/^[0-9a-fA-F-]{8,}$/.test(payload.session_id)
) process.exit(0);

const sessionFile = process.env.CODEDECK_SESSION_FILE;
const sessionId = payload.session_id;
const sidecar = `${sessionFile}.${sessionId}.name`;
if (existsSync(sidecar)) process.exit(0);

const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
// The worker gets one temp directory it can validate; the sidecar path and the
// prompt travel inside job.json rather than on argv, so the worker never opens a
// path handed to it as a command-line argument.
let jobDir;
try {
  jobDir = mkdtempSync(join(tmpdir(), "codedeck-session-name-"));
  writeFileSync(join(jobDir, "job.json"), JSON.stringify({ sidecar, prompt }), {
    encoding: "utf8",
    flag: "wx",
  });

  const child = spawn(process.execPath, [worker, jobDir], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
} catch {
  if (jobDir) rmSync(jobDir, { recursive: true, force: true });
  writeFallback(sidecar, prompt);
}
