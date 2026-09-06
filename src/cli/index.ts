#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { registerRunCommand } from "./commands/run.js";
import { registerPsCommand } from "./commands/ps.js";
import { registerShowCommand } from "./commands/show.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerWaitCommand } from "./commands/wait.js";
import { registerSendCommand } from "./commands/send.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerModelsCommand } from "./commands/models.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerSetupCommand } from "./commands/setup.js";
import { getCliInvocation, getCliName } from "./cli-name.js";

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

// CODEDECK_CLI_NAME renames the tool (for example a `codedeck-dev`
// alias), so the help below shows that name instead of `npx codedeck`.
const cliName = getCliName();
const cli = getCliInvocation();

program
  .name(cliName)
  .description("CodeDeck — local runtime for coding agents\nManage Claude, Codex, OpenCode and OMP through a single session interface")
  .version(getVersion())
  .helpOption("-h, --help", "display help for command")
  .showHelpAfterError("(add --help for details)")
  .showSuggestionAfterError(true)
  .addHelpText("after", `
Examples:
  $ ${cli} run "implement authentication" --agent claude --worktree
  $ ${cli} run "fix the tests" --agent codex --bg
  $ ${cli} wait a83f
  $ ${cli} ps
  $ ${cli} ps --json
  $ ${cli} show a83f
  $ ${cli} logs a83f --follow
  $ ${cli} logs a83f --json
  $ ${cli} send a83f "add tests"
  $ ${cli} stop a83f
  $ ${cli} diff a83f --stat
  $ ${cli} doctor
  $ ${cli} models
  $ ${cli} models codex
  $ ${cli} models --search sonnet

Recommended flow:
  $ ${cli} run "task"                 # blocks and follows logs
  $ ${cli} run "task" --bg --json     # starts in background
  $ ${cli} wait <id>                  # waits without ps/show loop
  $ ${cli} logs <id> --follow         # inspect progress

Run '${cli} <command> --help' for command-specific options.
Docs: https://github.com/4ndreello/run-agent
`);

registerRunCommand(program);
registerPsCommand(program);
registerShowCommand(program);
registerLogsCommand(program);
registerWaitCommand(program);
registerSendCommand(program);
registerStopCommand(program);
registerDiffCommand(program);
registerDoctorCommand(program);
registerModelsCommand(program);
registerOpenCommand(program);
registerSetupCommand(program);

// Make `codedeck help` behave like `codedeck --help`
program.command("help", { hidden: true }).action(() => program.outputHelp());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
