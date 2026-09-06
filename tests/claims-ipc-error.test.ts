import { Command } from "commander";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcClient } from "../src/daemon/ipc.js";
import { registerClaimsCommand } from "../src/cli/commands/claims.js";

const originalRunAgentDir = process.env.RUN_AGENT_DIR;
const originalExitCode = process.exitCode;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedeck-claims-ipc-"));
const socketPath = path.join(testDir, "daemon.sock");

type ResponseMode = "line" | "close";

function errorResponse(id: string) {
  return {
    id,
    error: {
      code: "CLAIM_NOT_OWNED",
      message: "Claim 7 is owned by another session",
      details: { claimId: 7 },
    },
  };
}

async function startErrorServer(mode: ResponseMode = "line"): Promise<{
  server: net.Server;
  requests: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        const response = JSON.stringify(errorResponse(String(request.id)));
        socket.end(mode === "line" ? `${response}\n` : response);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  return { server, requests };
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function runClaims(argv: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClaimsCommand(program);
  return program.parseAsync(["node", "codedeck", "claims", ...argv], { from: "node" });
}

let logs: string[];
let errors: string[];

beforeEach(() => {
  process.env.RUN_AGENT_DIR = testDir;
  process.exitCode = undefined;
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  if (originalRunAgentDir === undefined) delete process.env.RUN_AGENT_DIR;
  else process.env.RUN_AGENT_DIR = originalRunAgentDir;
  try { fs.unlinkSync(socketPath); } catch {}
});

describe("IpcClient daemon errors", () => {
  it("preserves code and details from a daemon error response", async () => {
    const { server } = await startErrorServer();
    try {
      const client = new IpcClient(socketPath);
      await expect(client.request("claims.release", { sessionId: "session-b", claimId: 7 }))
        .rejects.toMatchObject({
          code: "CLAIM_NOT_OWNED",
          details: { claimId: 7 },
          message: "Claim 7 is owned by another session",
        });
    } finally {
      await closeServer(server);
    }
  });

  it("preserves code when the response arrives without a trailing newline", async () => {
    const { server } = await startErrorServer("close");
    try {
      const client = new IpcClient(socketPath);
      await expect(client.request("claims.release", { sessionId: "session-b", claimId: 7 }))
        .rejects.toMatchObject({ code: "CLAIM_NOT_OWNED" });
    } finally {
      await closeServer(server);
    }
  });

  it("preserves code for subscription errors", async () => {
    const { server } = await startErrorServer();
    try {
      const client = new IpcClient(socketPath);
      const error = await new Promise<Error>((resolve) => {
        client.subscribe("session-b", () => {}, undefined, resolve);
      });

      expect(error).toMatchObject({
        code: "CLAIM_NOT_OWNED",
        details: { claimId: 7 },
        message: "Claim 7 is owned by another session",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("carries the real daemon code into the claims JSON error envelope", async () => {
    const { server, requests } = await startErrorServer();
    try {
      await runClaims(["release", "7", "--session", "session-b", "--json"]);

      expect(requests).toContainEqual(expect.objectContaining({
        method: "claims.release",
        params: { sessionId: "session-b", claimId: 7 },
      }));
      expect(errors).toEqual([
        JSON.stringify({
          error: {
            code: "CLAIM_NOT_OWNED",
            message: "Claim 7 is owned by another session",
          },
        }),
      ]);
      expect(logs).toEqual([]);
      expect(process.exitCode).toBe(1);
    } finally {
      await closeServer(server);
    }
  });
});
