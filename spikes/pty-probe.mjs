#!/usr/bin/env node
/**
 * Alvo do self-test: um "TUI" mínimo que reporta exatamente aquilo que só um
 * pty de verdade entrega — tamanho, resize, bytes crus e Ctrl+C. Fica em raw
 * mode porque é assim que o Claude Code roda, e é essa a fidelidade que o
 * wrapper precisa preservar.
 */
const say = (line) => process.stdout.write(`${line}\n`);
const size = () => `${process.stdout.columns}x${process.stdout.rows}`;

say(`TTY=${process.stdin.isTTY === true}`);
say(`SIZE=${size()}`);

process.stdout.on("resize", () => say(`RESIZE=${size()}`));
process.on("SIGINT", () => say("SIGINT"));

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();

let buffer = "";
process.stdin.on("data", (chunk) => {
  let text = chunk;
  if (text.includes("\u0003")) {
    say("CTRL-C-BYTE");
    text = text.replaceAll("\u0003", "");
  }
  buffer += text;
  let index;
  while ((index = buffer.search(/[\r\n]/)) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line === "quit") {
      say("BYE");
      process.exit(7);
    }
    say(`LINE=${line}`);
  }
});
