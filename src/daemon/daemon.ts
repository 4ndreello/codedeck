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
import { isTerminalStatus, type AgentId } from "../core/session.js";
import type { DriverSession } from "../core/driver.js";
import { generateSessionId, generateBranchName } from "../core/session.js";
import { getGitInfo, getBaseCommit } from "../git/repository.js";
import { createWorktree } from "../git/worktree.js";
import { getDiff } from "../git/diff.js";
import { processAlive, processStartTime } from "../utils/process.js";
import { readSessionProcessMetadata } from "../drivers/session-runtime.js";
import type { AgentEvent } from "../core/events.js";
import { loadConfig } from "../config/config.js";
import { classifyFailure, type FailureInfo } from "../core/errors.js";

class Daemon {
  private db: Database;
  private sessions: SessionStore;
  private events: EventStore;
  private registry = getRegistry();
  private server?: net.Server;
  private subscribers = new Map<string, Set<net.Socket>>(); // sessionId -> sockets
  private startTime = Date.now();
  private sessionLocks = new Set<string>();

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

  // Sessions whose detached process outlived the daemon are RE-ATTACHED, not
  // orphaned: the process is independent (own process group, output in log
  // files), so a daemon restart is invisible to it. A live process keeps
  // streaming; a dead one is drained and classified from its log tail.
  private async recover(): Promise<void> {
    const paths = getPaths();
    const actives = this.sessions.listActive();
    for (const s of actives) {
      const driver = this.registry.get(s.agent);
      const metadata = readSessionProcessMetadata(s.id);
      const pid = metadata?.pid ?? s.pid;
      const recordedStart = metadata?.pidStartTime ?? s.pidStartTime;
      const processPresent = pid != null && processAlive(pid);
      const currentStart = pid != null ? processStartTime(pid) : undefined;
      const pidReused =
        processPresent &&
        recordedStart !== undefined &&
        currentStart !== undefined &&
        currentStart !== recordedStart;

      // Never attach to or signal a PID whose identity changed while the
      // daemon was away. The original harness is gone; the replacement is
      // somebody else's process.
      if (pidReused) {
        const failure: FailureInfo = {
          code: "HARNESS_CRASH",
          blame: "harness",
          retryable: true,
          reason: "pid_reused",
          detail: `PID ${pid} no longer identifies the launched harness`,
        };
        const detail = failure.detail ?? `PID ${pid} no longer identifies the launched harness`;
        const event: AgentEvent = {
          type: "session.failed",
          sessionId: s.id,
          timestamp: new Date().toISOString(),
          error: detail,
          failure,
          raw: { pid, expectedStartTime: recordedStart, currentStart },
        };
        this.events.append(s.id, event);
        this.sessions.setStatus(s.id, "failed", { lastEvent: detail, failure });
        continue;
      }

      const alive = processPresent;
      const stdoutPath = path.join(paths.logsDir, `${s.id}.ndjson`);
      const stderrPath = path.join(paths.logsDir, `${s.id}.stderr.log`);
      const hasDetachedLogs = fs.existsSync(stdoutPath) || fs.existsSync(stderrPath);
      // A live PID without a recorded identity is unsafe to attach: it may be
      // a recycled process. A dead PID is safe to drain from its own log.
      const identityVerified = !processPresent || (recordedStart !== undefined && currentStart === recordedStart);

      if (typeof driver.attach === "function" && pid != null && hasDetachedLogs && identityVerified) {
        try {
          await driver.attach({
            sessionId: s.id,
            pid,
            pidStartTime: recordedStart,
            nativeSessionId: s.nativeSessionId,
            logOffset: s.logOffset,
            stderrOffset: s.stderrOffset,
          });
        } catch (e) {
          // Corrupt log / fs failure: fall back to the legacy marking.
          this.sessions.setStatus(s.id, alive ? "orphaned" : "failed", {
            lastEvent: e instanceof Error ? e.message.slice(0, 200) : "reattach failed",
          });
          continue;
        }
        if (!s.pid || !s.pidStartTime) {
          this.sessions.update(s.id, { pid, pidStartTime: recordedStart ?? currentStart } as any);
        }
        const drvSession = {
          id: s.id,
          nativeSessionId: s.nativeSessionId,
          pid,
          pidStartTime: recordedStart,
          cwd: s.worktree || s.cwd,
          model: s.model,
        };
        if (alive) {
          this.sessions.setStatus(s.id, "working", { lastEvent: "reattached after daemon restart" });
        }
        void this.attachDriverEvents(s.id, driver, drvSession);
        continue;
      }

      // Sessions created before file transport have no reattachable log, and
      // live sessions without a PID identity are not safe to trust.
      if (pid) {
        this.sessions.setStatus(s.id, alive ? "orphaned" : "failed");
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
          sandbox: p.sandbox,
          dangerouslyBypassApprovalsAndSandbox: !!p.dangerouslyBypassApprovalsAndSandbox,
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
        const hidden = all ? 0 : Math.max(0, this.sessions.countTotal() - list.length);
        // Enrich with last event?
        send({ result: { sessions: list, hidden } });
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
        const p = params as { id: string; message: string };
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        const driver = this.registry.get(s.agent);
        // Do not start a second harness while the current one is still live:
        // both runtimes would tail the same per-session file and duplicate
        // every event from the follow-up turn.
        if (this.sessionLocks.has(s.id)) {
          send({ error: { code: "SESSION_BUSY", message: `Session ${s.id} has another lifecycle operation in progress` } });
          return;
        }
        const handle = driver.getHandle?.(s.id);
        const runtimeState = handle && typeof handle === "object"
          ? handle as { done?: boolean; drained?: boolean }
          : undefined;
        const runtimeDraining = handle !== undefined && (runtimeState?.done !== true || runtimeState?.drained !== true);
        if (s.status === "starting" || runtimeDraining || (s.status === "working" && s.pid != null && processAlive(s.pid))) {
          send({ error: { code: "SESSION_BUSY", message: `Session ${s.id} is still running` } });
          return;
        }
        if (!driver.capabilities().resume) {
          send({ error: { code: "CAPABILITY_NOT_SUPPORTED", message: `Agent ${s.agent} does not support resume` } }); return;
        }

        this.sessionLocks.add(s.id);
        try {
          this.sessions.setStatus(s.id, "working", { lastEvent: `send: ${p.message.slice(0, 80)}` });

          const turnEvent: AgentEvent = {
            type: "turn.started",
            sessionId: s.id,
            timestamp: new Date().toISOString(),
            prompt: p.message,
          };
          this.events.append(s.id, turnEvent);
          this.broadcast(s.id, turnEvent);

          const drvSession: DriverSession = {
            id: s.id,
            nativeSessionId: s.nativeSessionId,
            cwd: s.worktree || s.cwd,
            model: s.model,
            effort: s.effort,
            fast: s.fast,
            sandbox: s.sandbox,
            dangerouslyBypassApprovalsAndSandbox: s.dangerouslyBypassApprovalsAndSandbox,
            pid: s.pid,
            pidStartTime: s.pidStartTime,
          };
          await driver.send(drvSession, p.message);

          const handle = driver.getHandle?.(s.id);
          const handleNativeId =
            handle &&
            typeof handle === "object" &&
            "nativeSessionId" in handle &&
            typeof handle.nativeSessionId === "string"
              ? handle.nativeSessionId
              : undefined;
          const newNative = handleNativeId || drvSession.nativeSessionId;
          if (newNative && newNative !== s.nativeSessionId) {
            this.sessions.update(s.id, { nativeSessionId: newNative });
          }
          if (drvSession.pid) {
            this.sessions.update(s.id, {
              pid: drvSession.pid,
              pidStartTime: processStartTime(drvSession.pid),
            });
          }
          this.sessions.update(s.id, { status: "working" });

          // Attach event loop for new turn
          this.attachDriverEvents(s.id, driver, drvSession).catch(() => {});

          send({ result: { ok: true } });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          try { this.sessions.setStatus(s.id, "failed"); } catch {}
          send({ error: { code: "SEND_FAILED", message } });
        } finally {
          this.sessionLocks.delete(s.id);
        }
        break;
      }

      case "session.stop": {
        const p = params as { id: string };
        const s = this.sessions.get(p.id);
        if (!s) { send({ error: { code: "SESSION_NOT_FOUND", message: `Session ${p.id} not found` } }); return; }
        const driver = this.registry.get(s.agent);
        if (this.sessionLocks.has(s.id)) {
          send({ error: { code: "SESSION_BUSY", message: `Session ${s.id} has another lifecycle operation in progress` } });
          return;
        }
        const handle = driver.getHandle?.(s.id);
        const hasRuntime = handle !== undefined;
        const liveIdentity =
          s.pid != null &&
          s.pidStartTime != null &&
          processAlive(s.pid) &&
          processStartTime(s.pid) === s.pidStartTime;
        if (s.status === "stopped" || ((s.status === "completed" || s.status === "failed") && !hasRuntime && !liveIdentity)) {
          send({ error: { code: "SESSION_NOT_RUNNING", message: `Session ${s.id} is ${s.status}` } });
          return;
        }
        if (s.pid != null && !hasRuntime && !s.pidStartTime) {
          send({ error: { code: "STOP_UNSAFE", message: `Cannot safely stop session ${s.id}: PID identity is unavailable` } });
          return;
        }

        this.sessionLocks.add(s.id);
        const previousStatus = s.status;
        const hadTerminalStatus = s.status === "completed" || s.status === "failed";
        const eventsBeforeStop = this.events.count(s.id);
        try {
          // Mark active sessions first so an attached event loop that ends
          // during stop cannot synthesize a failure or overwrite the outcome.
          if (!hadTerminalStatus) this.sessions.setStatus(s.id, "stopped");
          await driver.stop({
            id: s.id,
            nativeSessionId: s.nativeSessionId,
            cwd: s.worktree || s.cwd,
            pid: s.pid,
            pidStartTime: s.pidStartTime,
          });

          const last = this.events.last(s.id);
          const terminalArrivedDuringStop =
            this.events.count(s.id) > eventsBeforeStop &&
            (last?.type === "session.completed" || last?.type === "session.failed");
          if (terminalArrivedDuringStop) {
            if (last.type === "session.completed") {
              this.sessions.setStatus(s.id, "completed", { lastEvent: last.reason || "completed" });
            } else {
              this.sessions.setStatus(s.id, "failed", { lastEvent: last.error.slice(0, 200), failure: last.failure });
            }
          } else if (!hadTerminalStatus) {
            const ev: AgentEvent = {
              type: "session.completed",
              sessionId: s.id,
              timestamp: new Date().toISOString(),
              reason: "stopped",
              exitCode: 130,
            };
            this.events.append(s.id, ev);
            this.broadcast(s.id, ev);
          }
          send({ result: { ok: true } });
        } catch (e) {
          try { this.sessions.setStatus(s.id, previousStatus); } catch {}
          send({ error: { code: "STOP_FAILED", message: e instanceof Error ? e.message : String(e) } });
        } finally {
          this.sessionLocks.delete(s.id);
        }
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

        // A late subscriber must not wait forever for a broadcast that already
        // happened. Replay the terminal event when available, then close the
        // stream just like a live terminal broadcast.
        if (isTerminalStatus(s.status)) {
          const last = this.events.last(s.id);
          if (last?.type === "session.completed" || last?.type === "session.failed") {
            try { socket.write(JSON.stringify({ type: "event", event: last, id: s.id }) + "\n"); } catch {}
          }
          try { socket.write(JSON.stringify({ type: "done", id: s.id }) + "\n"); } catch {}
          return;
        }

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
      sandbox: session.sandbox,
      dangerouslyBypassApprovalsAndSandbox: session.dangerouslyBypassApprovalsAndSandbox,
    });

    // Update pid and native id when available
    if (drvSession.pid) this.sessions.update(sessionId, { pid: drvSession.pid, pidStartTime: processStartTime(drvSession.pid) } as any);
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

    // Attach events
    await this.attachDriverEvents(sessionId, driver, drvSession);
  }

  private async attachDriverEvents(sessionId: string, driver: any, drvSession: any): Promise<void> {
    try {
      for await (const ev of driver.events(drvSession)) {
        // A stop operation owns the terminal outcome. A terminal frame already
        // buffered by the harness must not race it into the event log.
        if (this.sessionLocks.has(sessionId) && (ev.type === "session.completed" || ev.type === "session.failed")) {
          continue;
        }
        const db = this.db.getHandle();
        db.exec("BEGIN");
        let inserted = 0;
        try {
          inserted = this.events.append(sessionId, ev, (ev as any).raw);
          const offsets = driver.getOffsets?.(sessionId);
          if (offsets) {
            this.sessions.update(sessionId, { logOffset: offsets.log, stderrOffset: offsets.stderr });
          }
          if (inserted !== 0) {
            // Update session status based on event.
            this.updateSessionFromEvent(sessionId, ev);
          }
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch {}
          throw error;
        }
        // Broadcast only after the durable event+cursor commit, and never
        // broadcast a replay that was already in the event store.
        if (inserted !== 0) this.broadcast(sessionId, ev);
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
  }

  private updateSessionFromEvent(sessionId: string, ev: AgentEvent): void {
    try {
      const current = this.sessions.get(sessionId);
      if (current?.status === "stopped" && (ev.type === "session.completed" || ev.type === "session.failed")) {
        return;
      }
      if (ev.type === "session.started") {
        if (ev.nativeSessionId) this.sessions.update(sessionId, { nativeSessionId: ev.nativeSessionId });
      } else if (ev.type === "session.completed") {
        this.sessions.setStatus(sessionId, "completed", { lastEvent: ev.reason || "completed" });
      } else if (ev.type === "session.failed") {
        this.sessions.setStatus(sessionId, "failed", { lastEvent: ev.error.slice(0, 200), failure: ev.failure });
      } else if (ev.type === "tool.started") {
        this.sessions.update(sessionId, { lastEvent: `tool: ${ev.tool.name}` });
      } else if (ev.type === "message") {
        this.sessions.update(sessionId, { lastEvent: ev.content.slice(0, 80) });
      } else if (ev.type === "usage.updated") {
        const sess = this.sessions.get(sessionId);
        if (sess) {
          this.sessions.update(sessionId, { usage: { ...(sess.usage || {}), ...ev.usage } });
        }
      }
      this.sessions.update(sessionId, { updatedAt: new Date() });
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
