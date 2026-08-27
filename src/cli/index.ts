#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { registerRunCommand } from "./commands/run.js";
import { registerPsCommand } from "./commands/ps.js";
import { registerShowCommand } from "./commands/show.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerSendCommand } from "./commands/send.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerDoctorCommand } from "./commands/doctor.js";

function getVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

const program = new Command();

program
  .name("ra")
  .description("Run Agent — local runtime for coding agents")
  .version(getVersion())
  .helpOption("-h, --help", "display help for command");

registerRunCommand(program);
registerPsCommand(program);
registerShowCommand(program);
registerLogsCommand(program);
registerSendCommand(program);
registerStopCommand(program);
registerDiffCommand(program);
registerDoctorCommand(program);

// alias run-agent
program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
