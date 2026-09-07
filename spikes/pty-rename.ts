#!/usr/bin/env node --experimental-strip-types
/**
 * Spike: PTY wrapper para renomear a sessão nativa do Claude Code pelo
 * primeiro prompt.
 *
 * Por que existe: `/rename` é comando de TUI e não tem equivalente no CLI. O
 * control request `rename_session` só entra por stdin em modo SDK ou pelo
 * bridge do Remote Control com assinatura de dispositivo, e o registro de
 * título no transcript só é relido em re-stamp (start/resume/compactação).
 * Sobra digitar `/rename` pelo usuário — o que exige que o `codedeck open`
 * seja dono do pty.
 *
 * Prova:
 * 1. alocar um pty sem dependência nativa (`script`)
 * 2. o harness enxergar um terminal de verdade (isTTY)
 * 3. o pty nascer com o tamanho do terminal real (`script` deixa 0x0)
 * 4. resize do terminal chegar no harness durante a sessão
 * 5. injetar texto como se tivesse sido digitado (o `/rename`)
 * 6. disparar essa injeção a partir do sidecar que o hook do 1º prompt grava
 * 7. Ctrl+C chegar ao harness com a mesma fidelidade de um terminal direto
 * 8. exit code do harness sobreviver às duas camadas (script + shim)
 *
 * Rodar (precisa de um pty de verdade, que o Node não aloca sozinho):
 *
 *   python3 spikes/pty-harness.py
 *
 * Uso como wrapper, num terminal:
 *
 *   node --experimental-strip-types spikes/pty-rename.ts -- claude -n "…"
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHIM = fileURLToPath(new URL("../plugin/pty-shim.mjs", import.meta.url));
const PROBE = fileURLToPath(new URL("./pty-probe.mjs", import.meta.url));

export interface PtyTarget {
  cmd: string;
  args: string[];
}

export interface PtyOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // The real wrapper inherits stdout so the TUI paints straight on the
  // terminal. The self-test needs to read what the child printed, so it
  // captures instead.
  onOutput?: (chunk: string) => void;
}

export interface PtySession {
  child: ChildProcess;
  inject: (text: string) => void;
  dispose: () => void;
  exit: Promise<number>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * `script` is the only pty allocator guaranteed to be on the box without a
 * native dependency. BSD and util-linux disagree on the spelling, and only
 * util-linux propagates the child's exit status (`-e`).
 */
export function buildScriptInvocation(inner: string): { bin: string; args: string[] } {
  if (process.platform === "darwin") return { bin: "script", args: ["-q", "/dev/null", "/bin/sh", "-c", inner] };
  return { bin: "script", args: ["-qefc", inner, "/dev/null"] };
}

export function buildInnerCommand(target: PtyTarget): string {
  const parts = [process.execPath, SHIM, target.cmd, ...target.args].map(shellQuote);
  // `exec` keeps the pty's session leader as the shim, so there is no extra
  // shell sitting between the terminal and the harness.
  return `exec ${parts.join(" ")}`;
}

export function spawnUnderPty(target: PtyTarget, options: PtyOptions = {}): PtySession {
  const control = path.join(os.tmpdir(), `codedeck-pty-${process.pid}-${Date.now().toString(36)}.sock`);
  const rows = process.stdout.rows ?? 24;
  const columns = process.stdout.columns ?? 80;

  const invocation = buildScriptInvocation(buildInnerCommand(target));
  const child = spawn(invocation.bin, invocation.args, {
    cwd: options.cwd,
    env: {
      ...(options.env ?? process.env),
      CODEDECK_PTY_CONTROL: control,
      CODEDECK_PTY_ROWS: String(rows),
      CODEDECK_PTY_COLS: String(columns),
    },
    stdio: ["pipe", options.onOutput ? "pipe" : "inherit", "inherit"],
  });

  if (options.onOutput) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", options.onOutput);
  }

  // Raw mode is what makes the parent a transparent wire: every keystroke,
  // Ctrl+C included, becomes a byte the pty's line discipline interprets
  // exactly as a real terminal would.
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  const forward = (chunk: Buffer) => child.stdin?.write(chunk);
  stdin.on("data", forward);
  stdin.resume();

  // The shim needs a moment to bind, and losing the socket must never take
  // the session down: a missed resize is a redraw, not a crash.
  let conn: net.Socket | undefined;
  let connecting = true;
  const connect = (attempt = 0) => {
    if (!connecting) return;
    const socket = net.connect(control);
    socket.on("connect", () => {
      conn = socket;
      connecting = false;
    });
    socket.on("error", () => {
      socket.destroy();
      if (attempt < 60) setTimeout(() => connect(attempt + 1), 50);
    });
  };
  connect();

  const sendResize = () => {
    conn?.write(`${JSON.stringify({ type: "resize", rows: process.stdout.rows, cols: process.stdout.columns })}\n`);
  };
  process.stdout.on("resize", sendResize);

  const dispose = () => {
    connecting = false;
    process.stdout.off("resize", sendResize);
    stdin.off("data", forward);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
    conn?.destroy();
    try {
      fs.rmSync(control, { force: true });
    } catch {}
  };

  const exit = new Promise<number>((resolve) => {
    child.on("close", (code, signal) => {
      dispose();
      resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0));
    });
  });

  return {
    child,
    inject: (text: string) => {
      child.stdin?.write(text);
    },
    dispose,
    exit,
  };
}

/**
 * The trigger the product would use: `plugin/hooks/session-name.sh` already
 * writes the first prompt's slug into `<sessionFile>.<id>.name`. Watching that
 * file keeps the wrapper ignorant of Claude Code internals — it types what the
 * hook decided, once.
 */
export function watchNameSidecar(sessionFile: string, onName: (name: string) => void): () => void {
  const dir = path.dirname(sessionFile);
  const prefix = `${path.basename(sessionFile)}.`;
  const seen = new Set<string>();

  const read = (file: string) => {
    if (!file.startsWith(prefix) || !file.endsWith(".name") || seen.has(file)) return;
    let name: string;
    try {
      name = fs.readFileSync(path.join(dir, file), "utf8").replaceAll(/\s+/g, " ").trim();
    } catch {
      return;
    }
    if (name.length === 0) return;
    seen.add(file);
    onName(name);
  };

  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) read(file);
  const watcher = fs.watch(dir, (_event, file) => {
    if (typeof file === "string") read(file);
  });
  return () => watcher.close();
}

// ---------------------------------------------------------------- self-test

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function selfTest(): Promise<number> {
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    process.stdout.write(`${ok ? "PASS" : "SPIKE:FAIL"} ${name} — ${detail}\n`);
  };

  let output = "";
  const waiters: { pattern: RegExp; resolve: (match: RegExpMatchArray) => void }[] = [];
  const pump = (chunk: string) => {
    output += chunk;
    for (const waiter of [...waiters]) {
      const match = output.match(waiter.pattern);
      if (!match) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(match);
    }
  };
  const expect = (pattern: RegExp, timeoutMs = 8000): Promise<RegExpMatchArray | null> =>
    new Promise((resolve) => {
      const existing = output.match(pattern);
      if (existing) return resolve(existing);
      const waiter = { pattern, resolve: (match: RegExpMatchArray) => resolve(match) };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs).unref();
    });

  const sessionFile = path.join(os.tmpdir(), `codedeck-spike-${Date.now().toString(36)}`, "session");
  const bootRows = process.stdout.rows;
  const bootCols = process.stdout.columns;

  const session = spawnUnderPty({ cmd: process.execPath, args: [PROBE] }, { onOutput: pump });

  const stopWatching = watchNameSidecar(sessionFile, (name) => session.inject(`/rename ${name}\r`));

  const tty = await expect(/TTY=(true|false)/);
  record("2. harness vê um terminal", tty?.[1] === "true", `TTY=${tty?.[1] ?? "sem resposta"}`);

  const size = await expect(/SIZE=(\d+)x(\d+)/);
  const sizeOk = size !== null && Number(size[1]) === bootCols && Number(size[2]) === bootRows;
  record("3. pty nasce com o tamanho real", sizeOk, `esperado ${bootCols}x${bootRows}, veio ${size?.[0] ?? "nada"}`);

  process.stdout.write("SPIKE:awaiting-resize\n");
  const resize = await expect(/RESIZE=(\d+)x(\d+)/, 15000);
  const resizeOk =
    resize !== null && Number(resize[1]) === process.stdout.columns && Number(resize[2]) === process.stdout.rows;
  record(
    "4. resize chega no harness",
    resizeOk,
    `terminal ${process.stdout.columns}x${process.stdout.rows}, harness ${resize?.[0] ?? "nada"}`,
  );

  session.inject("/rename direto\r");
  const injected = await expect(/LINE=\/rename direto/);
  record("5. injeção chega como digitação", injected !== null, injected?.[0] ?? "sem eco da linha");

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(`${sessionFile}.11111111-2222-3333-4444-555555555555.name`, "corrigir-auth-do-login\n", "utf8");
  const fromSidecar = await expect(/LINE=\/rename corrigir-auth-do-login/);
  record("6. sidecar do 1º prompt dispara a injeção", fromSidecar !== null, fromSidecar?.[0] ?? "nada veio do sidecar");

  session.inject("\u0003");
  const ctrlC = await expect(/CTRL-C-BYTE/);
  record("7. Ctrl+C chega cru no harness", ctrlC !== null, ctrlC?.[0] ?? "byte não chegou");

  session.inject("quit\r");
  const code = await session.exit;
  record("8. exit code sobrevive às duas camadas", code === 7, `esperado 7, veio ${code}`);

  stopWatching();
  try {
    fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });
  } catch {}

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`SPIKE:done ${checks.length - failed.length}/${checks.length} ok\n`);
  return failed.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--self-test") {
    process.exitCode = await selfTest();
    return;
  }

  const separator = argv.indexOf("--");
  const target = separator >= 0 ? argv.slice(separator + 1) : argv;
  if (target.length === 0) {
    process.stderr.write("uso: pty-rename.ts --self-test | -- <comando> [args...]\n");
    process.exitCode = 64;
    return;
  }

  const session = spawnUnderPty({ cmd: target[0]!, args: target.slice(1) });
  const sessionFile = process.env.CODEDECK_SESSION_FILE;
  const stopWatching = sessionFile
    ? watchNameSidecar(sessionFile, (name) => session.inject(`/rename ${name}\r`))
    : () => {};
  process.exitCode = await session.exit;
  stopWatching();
}

await main();
