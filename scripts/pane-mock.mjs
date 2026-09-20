// Mock of the right-side agents pane: the web canvas, drawn as ASCII.
// Throwaway, exists to settle the shape before any engine work.
// Run: node scripts/pane-mock.mjs [runId] [width]

import { execFileSync } from "node:child_process";

const runId = process.argv[2] ?? process.env.CODEDECK_RUN_ID ?? "f5fd";
const W = Number(process.argv[3] ?? 40);

const all = JSON.parse(
  execFileSync("codedeck", ["ps", "--all", "--json"], { encoding: "utf8", maxBuffer: 33554432 }),
);
const mine = all.filter((r) => r && r.runId === runId);
const boss = mine.find((r) => r.origin === "open");
const kids = mine
  .filter((r) => r.origin !== "open")
  .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0));

const LIVE = new Set(["working", "starting"]);
const WAIT = new Set(["needs_input"]);
const count = {
  live: kids.filter((k) => LIVE.has(k.status)).length,
  wait: kids.filter((k) => WAIT.has(k.status)).length,
  done: kids.filter((k) => !LIVE.has(k.status) && !WAIT.has(k.status)).length,
};

const dot = (s) => (LIVE.has(s) ? "●" : WAIT.has(s) ? "◉" : "○");
const word = (s) =>
  ({
    working: "Trabalhando agora",
    starting: "Subindo",
    needs_input: "Esperando voce",
    completed: "Concluida",
    stopped: "Em pausa",
    failed: "Falhou",
  })[s] ?? s;
const glyph = (a) => ({ claude: "▲", opencode: "■", codex: "◆", omp: "⬟" })[a] ?? "□";
const nameOf = (a) => ({ claude: "Claude", opencode: "OpenCode", codex: "Codex", omp: "OMP" })[a] ?? a;

function age(iso) {
  const ms = Date.now() - Date.parse(iso ?? 0);
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  return m < 1 ? "agora" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}
const clip = (s, n) => (String(s).length <= n ? String(s) : String(s).slice(0, n - 1) + "…");
const pad = (s, n) => clip(s, n).padEnd(n);

// Outer frame helpers. Everything inside is exactly W-2 wide.
const IN = W - 2;
const out = [];
const frameTop = (label) => out.push("┌" + ("─ " + label + " ").padEnd(IN, "─") + "┐");
const frameRow = (s) => out.push("│" + pad(s, IN) + "│");
const frameSep = () => out.push("├" + "─".repeat(IN) + "┤");
const frameBot = () => out.push("└" + "─".repeat(IN) + "┘");

// A node card, indented inside the frame, with an optional stem below it.
const CARD = IN - 4; // two spaces of margin each side
const cardTop = () => frameRow("  ┌" + "─".repeat(CARD - 2) + "┐");
const cardRow = (s) => frameRow("  │" + pad(s, CARD - 2) + "│");
const cardBotStem = () => {
  const left = Math.floor((CARD - 2) / 2);
  frameRow("  └" + "─".repeat(left) + "┬" + "─".repeat(CARD - 3 - left) + "┘");
};
const cardBotPlain = () => frameRow("  └" + "─".repeat(CARD - 2) + "┘");
const stem = () => {
  const left = Math.floor((CARD - 2) / 2);
  frameRow("  " + " ".repeat(left + 1) + "│");
};

frameTop("Canvas do run " + runId);
frameRow(` ${mine.length} sessoes · ${count.live} trabalhando`);
frameRow(` ${count.wait} esperando voce · ${count.done} prontas`);
frameSep();
frameRow("");

// orchestrator
cardTop();
cardRow(` ${glyph(boss?.agent ?? "claude")} ● Orquestrador`);
cardRow(`   ${nameOf(boss?.agent ?? "claude")} · ${kids.length} agentes`);
cardBotStem();

const SHOW = 5;
kids.slice(0, SHOW).forEach((k, i) => {
  stem();
  cardTop();
  cardRow(` ${glyph(k.agent)} ${dot(k.status)} ${k.id}  ${nameOf(k.agent)}`);
  cardRow(`   ${clip(k.name ?? "-", CARD - 5)}`);
  cardRow(`   ${word(k.status)} · ${age(k.updatedAt)}`);
  const last = i === Math.min(SHOW, kids.length) - 1;
  if (last && kids.length <= SHOW) cardBotPlain();
  else cardBotStem();
});
if (kids.length > SHOW) {
  stem();
  frameRow(`  +${kids.length - SHOW} agentes ocultos`);
}
frameRow("");
frameSep();
frameRow(" ● trabalha  ◉ te espera  ○ pronta");
frameBot();

console.log("");
for (const l of out) console.log("  " + l);
console.log("");
