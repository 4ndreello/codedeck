#!/usr/bin/env node
/**
 * Roda DENTRO do pty criado pelo `script`, entre ele e o harness.
 *
 * Existe por causa de dois buracos que o processo pai não consegue tapar de
 * fora:
 *
 * - `script` só dimensiona o pty quando o stdin dele é um terminal. No nosso
 *   desenho o stdin do `script` é um pipe (é por ali que a injeção do
 *   `/rename` entra), então o pty nasce 0x0 e qualquer TUI fullscreen desenha
 *   errado.
 * - Node não expõe ioctl, então TIOCSWINSZ só é alcançável por um binário que
 *   faça a chamada: `stty`, que herda o slave do pty no fd 0.
 */
import net from "node:net";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

// The command comes from `codedeck open`, one argv entry per argument, and is
// run without a shell. The guard is there so a value that could only have been
// mangled on the way in — a control character, an empty binary — stops here
// rather than becoming a process.
const SAFE_BINARY = /^[^\u0000-\u001f]+$/;
const target = process.argv.slice(2);
if (target.length === 0 || !SAFE_BINARY.test(target[0])) {
  process.stderr.write("pty-shim: missing or unusable target command\n");
  process.exit(64);
}

// Applying the size on the slave is also what makes the kernel raise SIGWINCH
// on the session's foreground group, so the TUI redraws without ever knowing
// this shim exists.
function applySize(rows, cols) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) return false;
  const done = spawnSync("stty", ["rows", String(rows), "cols", String(cols)], {
    stdio: ["inherit", "ignore", "ignore"],
  });
  return done.status === 0;
}

applySize(Number(process.env.CODEDECK_PTY_ROWS), Number(process.env.CODEDECK_PTY_COLS));

const [binary, ...args] = target;
const child = spawn(binary, args, { stdio: "inherit", shell: false });

// Ctrl+C typed by the user reaches the whole foreground group, this shim
// included. The harness owns that key (Claude Code draws its own interrupt),
// so the shim stays alive and lets the child decide when to die.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

let server;
const control = process.env.CODEDECK_PTY_CONTROL;
if (control) {
  server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.type === "resize") applySize(Number(message.rows), Number(message.cols));
      }
    });
    conn.on("error", () => {});
  });
  server.on("error", () => {});
  server.listen(control);
}

const closeServer = () => {
  try {
    server?.close();
  } catch {}
};

child.on("error", (error) => {
  closeServer();
  process.stderr.write(`pty-shim: ${error.message}\n`);
  process.exit(126);
});

// The exit status has to survive both layers so `codedeck open` still reports
// what the harness actually did.
child.on("exit", (code, signal) => {
  closeServer();
  if (signal) process.exit(128 + (os.constants.signals[signal] ?? 0));
  process.exit(code ?? 0);
});
