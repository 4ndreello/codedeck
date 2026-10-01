import type { Command } from "commander";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { powerServicePath } from "./doctor.js";

const SERVICE_NAME = "codedeck.service";

function escapeSystemdString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

function renderExecArgument(value: string): string {
  return `"${escapeSystemdString(value).replaceAll("$", "$$")}"`;
}

export interface ServiceUnitOptions {
  nodePath: string;
  daemonScript: string;
  path: string;
}

export function renderServiceUnit({ nodePath, daemonScript, path: processPath }: ServiceUnitOptions): string {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(daemonScript)) {
    throw new Error("Node and daemon script paths must be absolute");
  }
  return [
    "[Unit]",
    "Description=CodeDeck daemon",
    "",
    "[Service]",
    `ExecStart=${renderExecArgument(nodePath)} ${renderExecArgument(daemonScript)} --daemon`,
    `Environment="PATH=${escapeSystemdString(processPath)}"`,
    "KillMode=process",
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface SystemctlResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

export interface ServiceCommandDependencies {
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  systemctlPath?: string | null;
  daemonScript?: string;
  nodePath?: string;
  existsSync?: (filePath: string) => boolean;
  runSystemctl?: (args: string[]) => Promise<SystemctlResult>;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function findSystemctl(pathEnv: string): string | undefined {
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "systemctl");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
}

function executeSystemctl(systemctlPath: string, args: string[]): Promise<SystemctlResult> {
  return new Promise((resolve) => {
    const child = spawn(systemctlPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function reportSystemctl(
  args: string[],
  result: SystemctlResult,
  log: (message: string) => void,
  error: (message: string) => void,
): boolean {
  const command = `systemctl ${args.join(" ")}`;
  log(`${command}: ${result.code === 0 ? "succeeded" : `failed (exit ${result.code})`}`);
  if (result.stdout?.trim()) log(result.stdout.trim());
  if (result.stderr?.trim()) error(result.stderr.trim());
  return result.code === 0;
}

export async function runServiceCommand(
  action: "install" | "uninstall",
  dependencies: ServiceCommandDependencies = {},
): Promise<number> {
  const log = dependencies.log ?? console.log;
  const error = dependencies.error ?? console.error;
  if ((dependencies.platform ?? process.platform) !== "linux") {
    error("codedeck service requires Linux with systemd user services.");
    return 1;
  }

  const pathEnv = dependencies.pathEnv ?? process.env.PATH ?? "";
  const systemctlPath = dependencies.systemctlPath === undefined
    ? findSystemctl(pathEnv)
    : dependencies.systemctlPath;
  if (!systemctlPath) {
    error("systemctl was not found on PATH. Install systemd to manage user services.");
    return 1;
  }

  const homeDir = dependencies.homeDir ?? os.homedir();
  const unitPath = powerServicePath(homeDir);
  const runSystemctl = dependencies.runSystemctl ?? ((args) => executeSystemctl(systemctlPath, args));
  const showResult = async (args: string[]): Promise<boolean> =>
    reportSystemctl(args, await runSystemctl(args), log, error);

  if (action === "install") {
    const daemonScript = dependencies.daemonScript ?? path.resolve(
      fileURLToPath(new URL("../../daemon/daemon.js", import.meta.url)),
    );
    const existsSync = dependencies.existsSync ?? fs.existsSync;
    if (!existsSync(daemonScript)) {
      error(`Daemon entry point was not found: ${daemonScript}`);
      return 1;
    }
    const unit = renderServiceUnit({
      nodePath: path.resolve(dependencies.nodePath ?? process.execPath),
      daemonScript: path.resolve(daemonScript),
      path: pathEnv,
    });
    try {
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, unit, "utf8");
      log(`Wrote ${unitPath}`);
    } catch (cause) {
      error(`Could not write service unit: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }

    const reloaded = await showResult(["--user", "daemon-reload"]);
    const enabled = await showResult(["--user", "enable", SERVICE_NAME]);
    if (reloaded && enabled) log("The service will start at your next login.");
    return reloaded && enabled ? 0 : 1;
  }

  const disabled = await showResult(["--user", "disable", SERVICE_NAME]);
  try {
    if (fs.existsSync(unitPath)) {
      fs.unlinkSync(unitPath);
      log(`Removed ${unitPath}`);
    } else {
      log(`Service unit not found at ${unitPath}`);
    }
  } catch (cause) {
    error(`Could not remove service unit: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  const reloaded = await showResult(["--user", "daemon-reload"]);
  return disabled && reloaded ? 0 : 1;
}

export function registerServiceCommand(program: Command, dependencies: ServiceCommandDependencies = {}): void {
  const service = program.command("service").description("Manage the user login service");
  service
    .command("install")
    .description("Start the CodeDeck daemon at login")
    .action(async () => { process.exitCode = await runServiceCommand("install", dependencies); });
  service
    .command("uninstall")
    .description("Remove the CodeDeck login service")
    .action(async () => { process.exitCode = await runServiceCommand("uninstall", dependencies); });
}
