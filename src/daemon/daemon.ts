#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { Database, getDatabase } from "../store/database.js";
import { SessionStore } from "../store/sessions.js";
import { EventStore } from "../store/events.js";
import { getPaths, ensureDirs } from "../config/paths.js";
import { createIpcServer } from "./ipc.js";
import type { IpcRequest, IpcResponse } from "./protocol.js";
import { getRegistry } from "../drivers/registry.js";
import type { AgentId } from "../core/session.js";
import { generateSessionId, generateBranchName } from "../core/session.js";
import { getGitInfo, getBaseCommit } from "../git/repository.js";
import { createWorktree } from "../git/worktree.js";
import { getDiff } from "../git/diff.js";
import { ProcessManager } from "./process-manager.js";
import type { AgentEvent } from "../core/events.js";
import { loadConfig } from "../config/config.js";
import { classifyFailure, type FailureInfo } from "../core/errors.js";

class Daemon {
  private db: Database;
  private sessions: SessionStore;
  private events: EventStore;
  private registry = getRegistry();
  private pm = new ProcessManager();
  private server?: net.Server;
  private subscribers = new Map<string, Set<net.Socket>>(); // sessionId -> sockets
  private startTime = Date.now();

  constructor() {
    ensureDirs();
    this.db = new Database();
    const handle = this.db.getHandle();
    this.sessions = new SessionStore(handle);
    this.events = new EventStore(handle);
  }

  async start(): Promise<void> {
    const paths = getPaths();
    // Recover orphaned sessions
    await this.recover();

    this.server = createIpcServer(async (req, socket) => {
      try {
        await this.handleRequest(req, socket);
      } catch (e) {
        const res: IpcResponse = { id: req.id, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
        try { socket.write(JSON.stringify(res) + "\n"); } catch {}
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(paths.daemonSock, () => resolve());
      this.server!.on("error", reject);
    });

    // Write pid file
    try { fs.writeFileSync(paths.daemonPid, String(process.pid), "utf-8"); } catch {}

    // Handle shutdown
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    process.on("exit", () => this.shutdown());

    console.log(`[daemon] listening on ${paths.daemonSock} pid=${process.pid}`);

    // Keep alive
    // Write log
    try {
      fs.appendFileSync(paths.daemonLog, `[${new Date().toISOString()}] daemon started pid=${process.pid}\n`);
    } catch {}
  }

  private async recover(): Promise<void> {
    // Mark active sessions as orphaned if process not alive
    const actives = this.sessions.listActive();
    for (const s of actives) {
      if (s.pid) {
        try {
          process.kill(s.pid, 0);
          // still alive externally but not managed by us; treat as orphaned
          this.sessions.setStatus(s.id, "orphaned");
        } catch {
          // not alive
          this.sessions.setStatus(s.id, "failed");
        }
      } else {
        this.sessions.setStatus(s.id, "failed");
      }
    }
  }

  private async handleRequest(req: IpcRequest, socket: net.Socket): Promise<void> {
    const { id, method, params } = req;
    const send = (res: Omit<IpcResponse, "id">) => {
      try { socket.write(JSON.stringify({ id, ...res }) + "\n"); } catch {}
    };

    switch (method) {
      case "session.create": {
        const p = params as any;
        const prompt: string = p.prompt;
        if (!prompt) { send({ error: { code: "INVALID", message: "prompt required" } }); return; }
        const cwdIn = p.cwd || process.cwd();
        const cfg = loadConfig();
        let agent: AgentId = p.agent || cfg.defaultAgent || "claude";
        if (!this.registry.has(agent)) { send({ error: { code: "AGENT_NOT_FOUND", message: `Unknown agent ${agent}` } }); return; }

        const sessionId = generateSessionId();
        let cwd = path.resolve(cwdIn);
        let worktree: string | undefined;
        let branch: string | undefined;
        let repository: string | undefined;
        let baseCommit: string | null | undefined;

        const gitInfo = await getGitInfo(cwd);
        if (gitInfo) repository = gitInfo.root;

        const wantsWorktree = p.worktree === true || (p.worktree === undefined && cfg.worktree === true);
        const wantsNoWorktree = p.noWorktree === true || p.worktree === false;

        if (wantsWorktree && gitInfo) {
          try {
            const wt = await createWorktree({ repoRoot: gitInfo.root, sessionId, prompt, name: p.name });
            worktree = wt.path;
            branch = wt.branch;
            baseCommit = wt.baseCommit;
            cwd = worktree;
          } catch (e) {
            send({ error: { code: "WORKTREE_FAILED", message: e instanceof Error ? e.message : String(e) } });
            return;
          }
        } else if (gitInfo) {
          baseCommit = gitInfo.head;
        }

        const now = new Date();
        const session: any = {
          id: sessionId,
          name: p.name,
          agent,
          model: p.model,
          effort: p.effort,
          fast: !!p.fast,
          status: "starting",
          repository,
          cwd,
          worktree,
          branch,
          baseCommit: baseCommit || undefined,
          pid: undefined,
          createdAt: now,
          updatedAt: now,
        };

        this.sessions.create(session);

        // Start driver async (don't block response too long)
        // But we need to start before returning? Return quickly then start
        send({ result: { session } });

        // Now start driver in background
        this.startDriverForSession(sessionId, prompt, p.model).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          const failure = classifyFailure(msg);
          const failEv: AgentEvent = {
            type: "session.failed",
            sessionId,
            timestamp: new Date().toISOString(),
            error: msg,
            failure,
            raw: e,
          };
          try { this.sessions.setStatus(sessionId, "failed", { lastEvent: msg.slice(0, 200), failure }); } catch {}
          this.broadcast(sessionId, failEv);
        });

        break;
      }

      case "session.list": {
        const p = params as any;
        const all = p?.all;
        const list = this.sessions.list(100, all);
        // Enrich with last event?
        send({ result: { sessions: list } });
        break;
      }

      case "session.get": {
        const p = params as any;
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        const evCount = this.events.count(s.id);
        const recent = this.events.list(s.id, 10);
        send({ result: { session: s, events: recent, eventCount: evCount } });
        break;
      }

      case "session.send": {
        const p = params as any;
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        const driver = this.registry.get(s.agent);
        // Check capabilities resume
        if (!driver.capabilities().resume) {
          send({ error: { code: "CAPABILITY_NOT_SUPPORTED", message: `Agent ${s.agent} does not support resume` } }); return;
        }
        // Update status to working
        this.sessions.setStatus(s.id, "working", { lastEvent: `send: ${p.message.slice(0, 80)}` });

        // Emit turn.started
        const turnEvent: AgentEvent = { type: "turn.started", sessionId: s.id, timestamp: new Date().toISOString(), prompt: p.message } as any;
        this.events.append(s.id, turnEvent);
        this.broadcast(s.id, turnEvent);

        try {
          // driver.send will spawn new process
          // Need to get current handle session object
          const nativeId = s.nativeSessionId;
          // Create a ephemeral DriverSession for send
          const drvSession: any = { id: s.id, nativeSessionId: nativeId, cwd: s.worktree || s.cwd, model: s.model, pid: s.pid };
          await driver.send(drvSession, p.message);
          // Update nativeSessionId if driver discovered new one
          const handle: any = (driver as any).getHandle?.(s.id);
          const newNative = handle?.nativeSessionId || drvSession.nativeSessionId;
          if (newNative && newNative !== s.nativeSessionId) {
            this.sessions.update(s.id, { nativeSessionId: newNative } as any);
          }
          if (drvSession.pid) this.sessions.update(s.id, { pid: drvSession.pid } as any);
          this.sessions.update(s.id, { status: "working" } as any);

          // Attach event loop for new turn
          this.attachDriverEvents(s.id, driver, drvSession).catch(() => {});

          send({ result: { ok: true } });
        } catch (e) {
          this.sessions.setStatus(s.id, "failed");
          send({ error: { code: "SEND_FAILED", message: e instanceof Error ? e.message : String(e) } });
        }
        break;
      }

      case "session.stop": {
        const p = params as any;
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        const driver = this.registry.get(s.agent);
        try {
          await driver.stop({ id: s.id, nativeSessionId: s.nativeSessionId, cwd: s.worktree || s.cwd, pid: s.pid } as any);
        } catch {}
        // Also try process manager
        try { await this.pm.stop(s.id); } catch {}
        this.sessions.setStatus(s.id, "stopped");
        const ev: AgentEvent = { type: "session.completed", sessionId: s.id, timestamp: new Date().toISOString(), reason: "stopped", exitCode: 130 } as any;
        this.events.append(s.id, ev);
        this.broadcast(s.id, ev);
        send({ result: { ok: true } });
        break;
      }

      case "session.logs": {
        const p = params as any;
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        if (p.follow) {
          // For follow, we upgrade to subscribe behavior? But spec says logs --follow streams
          // We'll handle by keeping socket open and streaming
          // Send existing events as result then keep streaming live
          const all = this.events.list(s.id, 1000);
          send({ result: { session: s, events: all } });
          // Then subscribe
          this.addSubscriber(s.id, socket);
          // Don't close socket
          return;
        } else {
          const all = this.events.list(s.id, 1000);
          send({ result: { session: s, events: all } });
        }
        break;
      }

      case "session.subscribe": {
        const p = params as any;
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        // Send buffered events first?
        // Then keep streaming
        this.addSubscriber(s.id, socket);
        // Send ack? keep open
        // Optionally send done when session terminal? We'll handle via broadcast.
        // Don't send immediate response; just keep socket open for events
        // But we should send an initial ack to confirm subscription?
        // Use a separate message to indicate subscription started
        // Let's not send anything; client will just wait for events
        // Keep socket open
        return;
      }

      case "session.diff": {
        const p = params as any;
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        const diff = await getDiff({ cwd: s.cwd, worktree: s.worktree, baseCommit: s.baseCommit, repository: s.repository });
        send({ result: diff });
        break;
      }

      case "daemon.status": {
        const paths = getPaths();
        let uptime = Date.now() - this.startTime;
        send({ result: { running: true, pid: process.pid, uptime, db: paths.db } });
        break;
      }

      case "doctor": {
        const nodeVersion = process.version;
        let gitInstalled = false;
        let gitVersion: string | undefined;
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          const { stdout } = await execFileAsync("git", ["--version"], { timeout: 3000 });
          gitInstalled = true;
          gitVersion = stdout.trim();
        } catch { gitInstalled = false; }
        const agents = await this.registry.detectAll();
        const caps: Record<string, any> = {};
        for (const [k, drv] of (this.registry as any).drivers.entries()) {
          caps[k] = drv.capabilities();
        }
        const agentsWithCaps: Record<string, any> = {};
        for (const [k, v] of Object.entries(agents)) {
          agentsWithCaps[k] = { ...v, capabilities: caps[k] };
        }
        const paths = getPaths();
        const dbExists = fs.existsSync(paths.db);
        send({
          result: {
            node: { version: nodeVersion },
            git: { installed: gitInstalled, version: gitVersion },
            agents: agentsWithCaps,
            daemon: { running: true, pid: process.pid, uptime: Date.now() - this.startTime },
            database: { path: paths.db, exists: dbExists },
          },
        });
        break;
      }

      default:
        send({ error: { code: "UNKNOWN_METHOD", message: `Unknown method ${method}` } });
    }
  }

  private addSubscriber(sessionId: string, socket: net.Socket): void {
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId)!.add(socket);
    socket.on("close", () => {
      this.subscribers.get(sessionId)?.delete(socket);
    });
    socket.on("error", () => {
      this.subscribers.get(sessionId)?.delete(socket);
    });
  }

  private broadcast(sessionId: string, event: AgentEvent): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;
    const msg = JSON.stringify({ type: "event", event, id: sessionId }) + "\n";
    for (const s of subs) {
      try { s.write(msg); } catch {}
    }
    // If terminal, also send done
    if (event.type === "session.completed" || event.type === "session.failed") {
      const doneMsg = JSON.stringify({ type: "done", id: sessionId }) + "\n";
      for (const s of subs) {
        try { s.write(doneMsg); } catch {}
        // keep socket open a moment then?
      }
    }
  }

  private async startDriverForSession(sessionId: string, prompt: string, model?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found for driver start");

    const driver = this.registry.get(session.agent);
    this.sessions.update(sessionId, { status: "working" } as any);

    const turnEvent: AgentEvent = { type: "turn.started", sessionId, timestamp: new Date().toISOString(), prompt } as any;
    this.events.append(sessionId, turnEvent);
    this.broadcast(sessionId, turnEvent);

    const drvSession = await driver.start({
      sessionId,
      prompt,
      cwd: session.worktree || session.cwd,
      model: model || session.model,
      // Read back from the session rather than the request so a follow-up turn
      // from send() runs with the same effort/tier the session was started with.
      effort: session.effort,
      fast: session.fast,
    });

    // Update pid and native id when available
    if (drvSession.pid) this.sessions.update(sessionId, { pid: drvSession.pid } as any);
    // Poll native id shortly
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const h: any = (driver as any).getHandle?.(sessionId);
      if (h?.nativeSessionId && h.nativeSessionId !== session.nativeSessionId) {
        this.sessions.update(sessionId, { nativeSessionId: h.nativeSessionId } as any);
        session.nativeSessionId = h.nativeSessionId;
        break;
      }
      if (drvSession.nativeSessionId) {
        this.sessions.update(sessionId, { nativeSessionId: drvSession.nativeSessionId } as any);
        break;
      }
    }

    // Store proc for manager if handle has proc
    const handle: any = drvSession.handle;
    if (handle?.proc) {
      this.pm.register(sessionId, handle.proc);
    }

    // Attach events
    await this.attachDriverEvents(sessionId, driver, drvSession);
  }

  private async attachDriverEvents(sessionId: string, driver: any, drvSession: any): Promise<void> {
    try {
      for await (const ev of driver.events(drvSession)) {
        // Persist
        this.events.append(sessionId, ev, (ev as any).raw);
        // Update session status based on event
        this.updateSessionFromEvent(sessionId, ev);
        // Broadcast
        this.broadcast(sessionId, ev);
      }
    } catch (e) {
      // A driver exception mid-stream is a harness/pipe failure, not task
      // output — classify so agents can retry instead of blaming the work.
      const msg = e instanceof Error ? e.message : String(e);
      const failure = classifyFailure(msg);
      const errEv: AgentEvent = {
        type: "session.failed",
        sessionId,
        timestamp: new Date().toISOString(),
        error: msg,
        failure,
        raw: e,
      };
      this.events.append(sessionId, errEv);
      this.broadcast(sessionId, errEv);
      this.sessions.setStatus(sessionId, "failed", { lastEvent: msg.slice(0, 200), failure });
      return;
    }

    // When events done, ensure terminal status if not already
    const sess = this.sessions.get(sessionId);
    if (sess && !["completed", "failed", "stopped", "orphaned"].includes(sess.status)) {
      // Check last event
      const last = this.events.last(sessionId);
      if (last?.type === "session.completed") {
        this.sessions.setStatus(sessionId, "completed", { lastEvent: (last as any).reason || "completed" });
      } else if (last?.type === "session.failed") {
        this.sessions.setStatus(sessionId, "failed", { lastEvent: last.error?.slice(0, 200), failure: last.failure });
      } else {
        // Stream ended with NO terminal event: the harness died without
        // reporting (the EPIPE class of crash). A false "completed" makes a
        // polling agent proceed on missing work; "failed" is the honest
        // default and matches what the dead process implies.
        const failure: FailureInfo = {
          code: "HARNESS_CRASH",
          blame: "harness",
          retryable: true,
          detail: "event stream ended without a terminal event",
        };
        const error = sess.lastEvent || "event stream ended without a terminal event";
        const errEv: AgentEvent = { type: "session.failed", sessionId, timestamp: new Date().toISOString(), error, failure } as AgentEvent;
        this.events.append(sessionId, errEv);
        this.broadcast(sessionId, errEv);
        this.sessions.setStatus(sessionId, "failed", { lastEvent: error.slice(0, 200), failure });
      }
    }
    // Unregister process
    this.pm.unregister(sessionId);
  }

  private updateSessionFromEvent(sessionId: string, ev: AgentEvent): void {
    try {
      if (ev.type === "session.completed") {
        this.sessions.setStatus(sessionId, "completed", { lastEvent: (ev as any).reason || "completed" });
      } else if (ev.type === "session.failed") {
        this.sessions.setStatus(sessionId, "failed", { lastEvent: (ev as any).error?.slice(0, 200), failure: (ev as any).failure });
      } else if (ev.type === "tool.started") {
        this.sessions.update(sessionId, { lastEvent: `tool: ${(ev as any).tool.name}` } as any);
      } else if (ev.type === "message") {
        const content = (ev as any).content || "";
        this.sessions.update(sessionId, { lastEvent: content.slice(0, 80) } as any);
      } else if (ev.type === "text.delta") {
        // Don't spam updatedAt too much? Just lastEvent
      } else if (ev.type === "usage.updated") {
        const u = (ev as any).usage;
        const sess = this.sessions.get(sessionId);
        if (sess) {
          const usage = { ...(sess.usage || {}), ...u };
          this.sessions.update(sessionId, { usage } as any);
        }
      }
      // Also update updatedAt
      this.sessions.update(sessionId, { updatedAt: new Date() } as any);
    } catch {}
  }

  shutdown(): void {
    try {
      const paths = getPaths();
      try { fs.unlinkSync(paths.daemonSock); } catch {}
      try { fs.unlinkSync(paths.daemonPid); } catch {}
      try { this.server?.close(); } catch {}
      try { this.db.close(); } catch {}
    } catch {}
    process.exit(0);
  }
}

// Entry
if (process.argv.includes("--daemon")) {
  const d = new Daemon();
  d.start().catch((e) => {
    console.error("[daemon] failed to start", e);
    process.exit(1);
  });
}

export { Daemon };
