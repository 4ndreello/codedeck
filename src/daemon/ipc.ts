import net from "node:net";
import fs from "node:fs";
import { getPaths } from "../config/paths.js";
import type { IpcRequest, IpcResponse } from "./protocol.js";

export function getSocketPath(): string {
  return getPaths().daemonSock;
}

export async function isDaemonRunning(): Promise<boolean> {
  const sock = getSocketPath();
  if (!fs.existsSync(sock)) return false;
  return new Promise((resolve) => {
    let done = false;
    const c = net.createConnection(sock, () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { c.end(); } catch {}
      // Destroy quickly to not keep loop alive
      setTimeout(() => { try { c.destroy(); } catch {} }, 50).unref?.();
      resolve(true);
    });
    c.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(false);
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { c.destroy(); } catch {}
      resolve(false);
    }, 1000);
    if ((timer as any).unref) (timer as any).unref();
  });
}

export class IpcClient {
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || getSocketPath();
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2, 10);
      const req: IpcRequest = { id, method: method as any, params };
      const client = net.createConnection(this.socketPath, () => {
        client.write(JSON.stringify(req) + "\n");
      });

      let buf = "";
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { client.destroy(); } catch {}
          reject(new Error("IPC request timeout"));
        }
      }, 15000);
      // Don't keep process alive just for this timeout if already resolved
      if ((timeout as any).unref) (timeout as any).unref();

      const cleanup = () => {
        clearTimeout(timeout);
        try { client.removeAllListeners(); } catch {}
      };

      client.on("data", (chunk) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const res = JSON.parse(line) as IpcResponse;
            if (res.id !== id) continue; // ignore other ids (streaming)
            if (res.error) {
              if (!resolved) {
                resolved = true;
                cleanup();
                try { client.end(); } catch {}
                // Destroy shortly after end to free socket quickly
                setTimeout(() => { try { client.destroy(); } catch {} }, 50).unref?.();
                reject(new Error(res.error.message));
              }
            } else {
              if (!resolved) {
                resolved = true;
                cleanup();
                try { client.end(); } catch {}
                setTimeout(() => { try { client.destroy(); } catch {} }, 50).unref?.();
                resolve(res.result as T);
              }
            }
          } catch (e) {
            if (!resolved) {
              resolved = true;
              cleanup();
              try { client.end(); } catch {}
              setTimeout(() => { try { client.destroy(); } catch {} }, 50).unref?.();
              reject(e as Error);
            }
          }
        }
      });

      client.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(err);
        }
      });

      client.on("close", () => {
        if (!resolved && buf.trim()) {
          try {
            const res = JSON.parse(buf.trim()) as IpcResponse;
            if (res.error) reject(new Error(res.error.message));
            else resolve(res.result as T);
            resolved = true;
            cleanup();
          } catch {}
        }
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error("Connection closed without response"));
        } else {
          cleanup();
        }
      });
    });
  }

  // Subscribe to live events for a session; onEvent called for each event, returns unsubscribe
  subscribe(sessionId: string, onEvent: (event: any) => void, onDone?: () => void, onError?: (e: Error) => void): () => void {
    const id = Math.random().toString(36).slice(2, 10);
    const req: IpcRequest = { id, method: "session.subscribe" as any, params: { id: sessionId } };
    const client = net.createConnection(this.socketPath, () => {
      client.write(JSON.stringify(req) + "\n");
    });

    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          // Responses with events have type field or event field, or are terminal
          if (msg.type === "event" && msg.event) {
            onEvent(msg.event);
          } else if (msg.type === "done") {
            onDone?.();
            client.end();
          } else if (msg.error) {
            onError?.(new Error(msg.error.message));
            client.end();
          } else if (msg.event) {
            onEvent(msg.event);
          } else if (msg.type && msg.sessionId) {
            // Normal event direct
            onEvent(msg);
          }
        } catch (e) {
          // ignore
        }
      }
    });

    client.on("error", (err) => onError?.(err));
    client.on("close", () => onDone?.());

    return () => {
      try { client.end(); } catch {}
      try { client.destroy(); } catch {}
    };
  }

  async ensureDaemonStarted(): Promise<void> {
    if (await isDaemonRunning()) return;
    // Spawn daemon
    const { spawn } = await import("node:child_process");
    const { getPaths } = await import("../config/paths.js");
    const paths = getPaths();
    // Build daemon entry
    const daemonScript = new URL("./daemon.js", import.meta.url).pathname;
    // Use current node to run daemon
    const child = spawn(process.execPath, [daemonScript, "--daemon"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });
    child.unref();

    // Wait for socket to appear
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await isDaemonRunning()) return;
    }
    throw new Error("Failed to start daemon");
  }
}

export function createIpcServer(
  handler: (req: IpcRequest, socket: net.Socket) => Promise<void>,
): net.Server {
  const sockPath = getSocketPath();
  // Remove stale socket
  try {
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
  } catch {}

  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const req = JSON.parse(line) as IpcRequest;
          await handler(req, socket);
        } catch (e) {
          const errRes: IpcResponse = { id: "unknown", error: { code: "PROTOCOL_ERROR", message: e instanceof Error ? e.message : String(e) } };
          try { socket.write(JSON.stringify(errRes) + "\n"); } catch {}
        }
      }
    });
    socket.on("error", () => {});
  });

  return server;
}
