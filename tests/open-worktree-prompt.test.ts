import { Command } from "commander";
import * as readline from "node:readline";
import { describe, expect, it, vi } from "vitest";

import { IpcClient } from "../src/daemon/ipc.js";
import * as repository from "../src/git/repository.js";
import * as worktree from "../src/git/worktree.js";
import * as runtime from "../src/open/runtime.js";
import * as setupCommands from "../src/cli/commands/setup.js";
import {
  askWorktree,
  registerOpenCommand,
  resolveOpenWorktree,
  scanOptions,
} from "../src/cli/commands/open.js";
import { setupOpenHarness } from "./helpers/open-harness.js";

const { createInterfaceMock } = vi.hoisted(() => ({ createInterfaceMock: vi.fn() }));

vi.mock("node:readline", () => ({ createInterface: createInterfaceMock }));

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, execFileSync: vi.fn() };
});

const { runOpen } = setupOpenHarness({ prefix: "codedeck-worktree-prompt-", restoreCwd: true });

interface FakeReadline {
  instance: {
    question: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  prompts: string[];
}

function mockReadline(...answerSets: Array<Array<string | "close">>): FakeReadline[] {
  let nextAnswerSet = 0;
  const fakes: FakeReadline[] = answerSets.map((answers) => {
    let closeHandler: (() => void) | undefined;
    const prompts: string[] = [];
    return {
      prompts,
      instance: {
        question: vi.fn((prompt: string, callback: (answer: string) => void) => {
          prompts.push(prompt);
          const answer = answers.shift();
          if (answer === "close") {
            closeHandler?.();
            return;
          }
          if (answer === undefined) throw new Error("Unexpected readline question");
          callback(answer);
        }),
        once: vi.fn((event: string, callback: () => void) => {
          if (event === "close") closeHandler = callback;
        }),
        close: vi.fn(),
      },
    };
  });

  createInterfaceMock.mockClear();
  createInterfaceMock.mockImplementation(() => {
    const fake = fakes[nextAnswerSet];
    if (!fake) throw new Error("Unexpected readline interface");
    nextAnswerSet += 1;
    return fake.instance as unknown as readline.Interface;
  });
  return fakes;
}

describe("open worktree prompt", () => {
  it("OWP-01 asks once for an interactive launch in a git repository", async () => {
    vi.spyOn(repository, "getGitInfo").mockResolvedValue({
      root: "/repo",
      head: "abc",
      branch: "main",
      isDirty: false,
    });
    const ask = vi.fn().mockResolvedValue(false);

    await expect(
      resolveOpenWorktree(undefined, { interactive: true, cwd: "/repo" }, ask),
    ).resolves.toBe(false);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(repository.getGitInfo).toHaveBeenCalledWith("/repo");
  });

  it("OWP-02 treats y and trimmed uppercase YES as yes and launches in the created worktree", async () => {
    const choices = mockReadline(["y"], ["  YES  "]);
    await expect(askWorktree()).resolves.toBe(true);
    expect(choices[0].prompts).toEqual(["Open in a worktree? [y/N]: "]);

    vi.spyOn(setupCommands, "isInteractiveTerminal").mockReturnValue(true);
    vi.spyOn(repository, "getGitInfo").mockResolvedValue({
      root: "/repo",
      head: "abc",
      branch: "main",
      isDirty: false,
    });
    const create = vi
      .spyOn(worktree, "createWorktree")
      .mockResolvedValue({ path: "/wt/yes", branch: "ra/reviewer-yes", baseCommit: "abc" });

    await runOpen(["reviewer", "--no-theme"]);

    expect(choices[1].prompts).toEqual(["Open in a worktree? [y/N]: "]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/repo", name: "reviewer" }));
    const [, , spawnOptions] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(spawnOptions.cwd).toBe("/wt/yes");
    expect(choices[1].instance.question.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(IpcClient.prototype.ensureDaemonStarted).mock.invocationCallOrder[0],
    );
  });

  it("OWP-03 treats an empty answer, n, and no as no", async () => {
    const choices = mockReadline([""], ["n"], [" no "]);

    await expect(askWorktree()).resolves.toBe(false);
    await expect(askWorktree()).resolves.toBe(false);
    await expect(askWorktree()).resolves.toBe(false);

    expect(choices.map((choice) => choice.prompts)).toEqual([
      ["Open in a worktree? [y/N]: "],
      ["Open in a worktree? [y/N]: "],
      ["Open in a worktree? [y/N]: "],
    ]);
  });

  it("OWP-04 reports invalid answers to stderr and asks again", async () => {
    const [choice] = mockReadline(["maybe", "YeS"]);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(askWorktree()).resolves.toBe(true);

    expect(choice.prompts).toEqual([
      "Open in a worktree? [y/N]: ",
      "Open in a worktree? [y/N]: ",
    ]);
    expect(stderrWrite).toHaveBeenCalledWith("Answer y or n.\n");
  });

  it("OWP-05 rejects on EOF before starting the daemon or adopting a session", async () => {
    mockReadline(["close"]);
    vi.spyOn(setupCommands, "isInteractiveTerminal").mockReturnValue(true);
    vi.spyOn(repository, "getGitInfo").mockResolvedValue({
      root: "/repo",
      head: "abc",
      branch: "main",
      isDirty: false,
    });

    await expect(runOpen(["reviewer", "--no-theme"])).rejects.toThrow(
      "Worktree selection was interrupted; nothing was launched.",
    );
    expect(IpcClient.prototype.ensureDaemonStarted).not.toHaveBeenCalled();
    expect(IpcClient.prototype.request).not.toHaveBeenCalled();
  });

  it("OWP-06 skips the question and enables an explicit worktree flag", async () => {
    vi.spyOn(repository, "getGitInfo");
    const ask = vi.fn();

    await expect(
      resolveOpenWorktree(true, { interactive: true, cwd: "/repo" }, ask),
    ).resolves.toBe(true);

    expect(ask).not.toHaveBeenCalled();
    expect(repository.getGitInfo).not.toHaveBeenCalled();
  });

  it("OWP-07 accepts --no-worktree and skips the question", async () => {
    const program = new Command();
    program.exitOverride();
    registerOpenCommand(program);
    const command = program.commands.find((candidate) => candidate.name() === "open");
    if (!command) throw new Error("open command was not registered");
    expect(scanOptions(["--no-worktree"], command)).toEqual([]);

    vi.spyOn(setupCommands, "isInteractiveTerminal").mockReturnValue(true);
    createInterfaceMock.mockClear();
    const create = vi.spyOn(worktree, "createWorktree");
    const cwd = process.cwd();

    await runOpen(["reviewer", "--no-theme", "--no-worktree"]);

    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const [, , spawnOptions] = vi.mocked(runtime.spawnHarness).mock.calls[0];
    expect(spawnOptions.cwd).toBe(cwd);
  });

  it("OWP-08 skips the question without a TTY or for a print launch", async () => {
    const choices = mockReadline();
    const terminal = vi.spyOn(setupCommands, "isInteractiveTerminal").mockReturnValue(false);
    const create = vi.spyOn(worktree, "createWorktree").mockResolvedValue({ path: "/wt" });
    await runOpen(["reviewer", "--no-theme"]);
    expect(createInterfaceMock).not.toHaveBeenCalled();

    terminal.mockReturnValue(true);
    await runOpen(["reviewer", "--no-theme", "--", "--print"]);

    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect(choices).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("OWP-09 skips the question outside a git repository", async () => {
    vi.spyOn(repository, "getGitInfo").mockResolvedValue(null);
    const ask = vi.fn();

    await expect(
      resolveOpenWorktree(undefined, { interactive: true, cwd: "/outside" }, ask),
    ).resolves.toBe(false);

    expect(repository.getGitInfo).toHaveBeenCalledWith("/outside");
    expect(ask).not.toHaveBeenCalled();
  });

  it("OWP-10 skips the question for a resumed session without a worktree flag", async () => {
    vi.spyOn(repository, "getGitInfo").mockResolvedValue({
      root: "/repo",
      head: "abc",
      branch: "main",
      isDirty: false,
    });
    const ask = vi.fn().mockResolvedValue(true);

    await expect(
      resolveOpenWorktree(undefined, {
        interactive: true,
        resume: "native-session-id",
        cwd: "/repo",
      }, ask),
    ).resolves.toBe(false);

    expect(ask).not.toHaveBeenCalled();
    expect(repository.getGitInfo).not.toHaveBeenCalled();
  });
});
