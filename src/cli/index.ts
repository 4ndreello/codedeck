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
  .name("run-agent")
  .description("Run Agent — local runtime for coding agents\nManage Claude, Codex, OpenCode and OMP through a single session interface")
  .version(getVersion())
  .helpOption("-h, --help", "display help for command")
  .showHelpAfterError("(add --help for details)")
  .showSuggestionAfterError(true)
  .addHelpText("after", `
Examples:
  $ npx run-agent run "implement authentication" --agent claude --worktree
  $ npx run-agent run "fix the tests" --agent codex --detach
  $ npx run-agent ps
  $ npx run-agent ps --json
  $ npx run-agent show a83f
  $ npx run-agent logs a83f --follow
  $ npx run-agent logs a83f --json
  $ npx run-agent send a83f "add tests"
  $ npx run-agent stop a83f
  $ npx run-agent diff a83f --stat
  $ npx run-agent doctor

Run 'npx run-agent <command> --help' for command-specific options.
Docs: https://github.com/4ndreello/run-agent
`);

registerRunCommand(program);
registerPsCommand(program);
registerShowCommand(program);
registerLogsCommand(program);
registerSendCommand(program);
registerStopCommand(program);
registerDiffCommand(program);
registerDoctorCommand(program);

// Make `run-agent help` behave like `run-agent --help`
program.command("help", { hidden: true }).action(() => program.outputHelp());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
