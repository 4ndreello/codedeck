/** Realtime runs canvas served by `codedeck web`.
 *
 * Single self-contained page (no external requests): the script polls
 * `api/sessions` and opens one `EventSource` per active session.
 * Promoted from spikes/web-top.mjs; keep the spike behavior in sync
 * only by re-running the Playwright check, never by importing it.
 */
export const CANVAS_PAGE: string = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeDeck canvas realtime</title>
<link rel="icon" href="data:,">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #08090c; color: #f5f5f7; overflow: hidden; }
  #scene { position: fixed; inset: 0; display: block; }
  #nodes { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
  .hud { position: fixed; z-index: 10; }
  #title, #feed, #legend, #hint { background: transparent; border: none; text-shadow: 0 1px 10px rgba(0,0,0,.8); }
  /* Sem reacao a mouse: sao texto flutuante, e os cliques precisam varar
     ate o canvas (pills de borda, pan e nos embaixo deles). */
  #title, #feed, #legend, #hint { pointer-events: none; }
  #title { top: 16px; left: 16px; }
  #title h1 { font-size: 15px; margin: 0 0 2px; }
  #title h1 .live { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: #30d158; margin-right: 8px; animation: breathe 2s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  #title p { margin: 0; color: #98989f; font-size: 12.5px; }
  #title p b { color: #f5f5f7; }
  #tools { top: 16px; right: 16px; display: flex; gap: 8px; }
  #tools button { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid rgba(255,255,255,.12); background: rgba(19,22,28,.6); color: #98989f;
    border-radius: 99px; cursor: pointer; font-family: inherit; }
  #tools button:hover { color: #f5f5f7; border-color: rgba(255,255,255,.25); }
  #tools button.on { color: #f5f5f7; border-color: rgba(255,255,255,.25); }
  #tools button svg { width: 17px; height: 17px; }
  #legend { left: 16px; bottom: 16px; display: flex; gap: 14px; font-size: 12px; color: #98989f; }
  #legend span { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 99px; }
  .dot.working { background: #30d158; box-shadow: 0 0 8px rgba(48,209,88,.8); }
  .dot.waiting { background: #ff9f0a; box-shadow: 0 0 8px rgba(255,159,10,.8); }
  .dot.resting { background: #636366; }
  .dot.done { background: #3a3a3c; }
  .dot.failed { background: #ff453a; box-shadow: 0 0 8px rgba(255,69,58,.8); }
  #feed { left: 16px; top: 112px; width: 300px; }
  #feed h2 { font-size: 11px; letter-spacing: .06em; color: #98989f; margin: 0 0 8px; }
  #feed ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  #feed li { font-size: 12.5px; color: #98989f; display: flex; gap: 8px; animation: feedIn .3s ease-out; }
  #feed li b { color: #f5f5f7; white-space: nowrap; }
  #feed li.fresh { color: #f5f5f7; }
  @keyframes feedIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; } }
  #hint { left: 50%; transform: translateX(-50%); bottom: 16px; font-size: 12px; color: #98989f; white-space: nowrap; }
  #detail { position: fixed; top: 0; right: 0; bottom: 0; width: min(360px, 92vw); z-index: 20;
    background: rgba(10, 12, 16, 0.92); border-left: 1px solid rgba(255,255,255,0.1);
    backdrop-filter: blur(14px); padding: 18px; overflow-y: auto; display: none; }
  #detail.open { display: block; }
  #detail h2 { font-size: 15px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
  #detail h2 .logo { width: 22px; height: 22px; display: inline-flex; }
  #detail h2 .logo svg { width: 22px; height: 22px; fill: #f5f5f7; }
  #detail .dsub { font-size: 12.5px; color: #98989f; margin-bottom: 12px; }
  #detail dl { margin: 0 0 12px; display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: 12.5px; }
  #detail dt { color: #98989f; }
  #detail dd { margin: 0; word-break: break-word; }
  #detail h3 { font-size: 11px; letter-spacing: 0.06em; color: #98989f; margin: 14px 0 8px; }
  #detail ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; font-size: 12.5px; color: #c7c7cc; }
  #detail ul li b { color: #f5f5f7; font-weight: 600; }
  #detail .ts { color: #636366; font-size: 11.5px; }
  #detailClose { position: absolute; top: 12px; right: 12px; width: 30px; height: 30px; border-radius: 99px;
    border: 1px solid rgba(255,255,255,0.12); background: transparent; color: #98989f;
    cursor: pointer; font-size: 14px; line-height: 1; font-family: inherit; }
  #detailClose:hover { color: #f5f5f7; border-color: rgba(255,255,255,0.25); }
  #dChat { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px; max-height: 34vh; overflow-y: auto; display: flex; flex-direction: column; gap: 9px; }
  #dChat .msg { font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; padding: 7px 9px; border-radius: 9px; }
  #dChat .msg .who { display: block; font-size: 10.5px; letter-spacing: 0.04em; color: #98989f; margin-bottom: 2px; }
  #dChat .msg.user { background: rgba(10,132,255,0.16); }
  #dChat .msg.assistant { background: rgba(255,255,255,0.05); }
  #dChat .evt { font-size: 11.5px; color: #636366; }
  #dChat .empty { color: #636366; font-size: 12px; }
  #dSend { display: flex; gap: 8px; margin-top: 10px; }
  #dSendText { flex: 1; min-width: 0; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; color: #f5f5f7; padding: 8px 10px; font-size: 12.5px; font-family: inherit; }
  #dSendText:focus { outline: none; border-color: rgba(255,255,255,0.3); }
  #dSendText:disabled { opacity: 0.4; }
  #dSendBtn { border: 1px solid rgba(255,255,255,0.14); background: rgba(10,132,255,0.25); color: #f5f5f7; border-radius: 10px; padding: 8px 12px; cursor: pointer; font-family: inherit; font-size: 12.5px; }
  #dSendBtn:disabled { opacity: 0.4; cursor: default; }
  #dSendMsg { font-size: 11.5px; color: #98989f; margin: 6px 0 0; min-height: 15px; }
  .node { position: absolute; width: 196px; background: #13161c; border: 1px solid rgba(255,255,255,.09);
    border-radius: 14px; padding: 11px 13px; pointer-events: auto; cursor: grab; user-select: none;
    box-shadow: 0 8px 28px rgba(0,0,0,.45); }
  .node:active { cursor: grabbing; }
  .node { transform-origin: 0 0; }
  .node.orch { width: 228px; border-color: rgba(255,255,255,.18); }
  .node .row { display: flex; align-items: center; gap: 8px; }
  .node .logo { width: 22px; height: 22px; display: inline-flex; flex-shrink: 0; }
  .node .logo svg { width: 22px; height: 22px; fill: #f5f5f7; }
  .node.orch .logo { width: 26px; height: 26px; }
  .node.orch .logo svg { width: 26px; height: 26px; }
  .node .name { font-size: 13.5px; font-weight: 650; }
  .node .sub { font-size: 12px; color: #98989f; margin-top: 3px; }
  .node .act { font-size: 12px; color: #98989f; margin-top: 5px; min-height: 15px; }
  .node .act b { color: #f5f5f7; }
  .node.alert { border-color: rgba(255,159,10,.65); animation: alertPulse 1.6s ease-in-out infinite; }
  @keyframes alertPulse { 0%,100% { border-color: rgba(255,159,10,.65); } 50% { border-color: rgba(255,159,10,1); } }
</style>
</head>
<body>
<canvas id="scene"></canvas>
<div id="nodes"></div>
<div class="hud" id="title"><h1><span class="live"></span>Canvas das runs</h1><p id="summary">conectando...</p></div>
<div class="hud" id="tools">
  <button id="btnMotion" class="on" type="button" title="Pausar movimento"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2.5-6 3.5 12 3-9 2 3H22"/></svg></button>
  <button id="btnReset" type="button" title="Recentralizar" aria-label="Recentralizar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
  <button id="btnHide" type="button" title="Ocultar concluídas" aria-label="Ocultar concluídas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-2.9 3.6M6.6 6.6C3.6 8.2 2 12 2 12s3 7 10 7c1.5 0 2.8-.3 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg></button>
</div>
<div class="hud" id="legend"><span><i class="dot working"></i>Trabalhando</span><span><i class="dot waiting"></i>Esperando você</span><span><i class="dot resting"></i>Em pausa</span><span><i class="dot done"></i>Concluída</span></div>
<div class="hud" id="feed"><h2>AGORA MESMO</h2><ul id="feedList"></ul></div>
<div class="hud" id="hint">arraste para organizar · scroll dá zoom · clique num agente para o detalhe</div>
<aside id="detail" aria-label="Detalhe da sessão">
  <button id="detailClose" type="button" aria-label="Fechar">×</button>
  <h2 id="dTitle"></h2>
  <p class="dsub" id="dSub"></p>
  <dl id="dRows"></dl>
  <h3>CONVERSA</h3>
  <div id="dChat"></div>
  <form id="dSend">
    <input id="dSendText" type="text" autocomplete="off" placeholder="mensagem para esta sessão">
    <button id="dSendBtn" type="submit">Enviar</button>
  </form>
  <p id="dSendMsg" role="status"></p>
</aside>
<script>
"use strict";
var LOGO_ANTHROPIC = '<svg viewBox="0 0 24 24"><path d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.369-3.553h7.005l1.37 3.553h3.744L10.536 3.541Zm-.371 10.223 2.291-5.945 2.292 5.945Z"/></svg>';
var LOGO_OPENAI = '<svg viewBox="0 0 24 24"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';
var LOGO_TERM = '<svg viewBox="0 0 24 24" fill="none" stroke="#f5f5f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="4"/><path d="M7 9.5l3 3-3 3M12.5 15.5H17"/></svg>';
var LOGO_ORCH = '<svg viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="2.4" fill="#0a84ff" stroke="none"/><circle cx="5" cy="19" r="2.4" fill="#0a84ff" stroke="none"/><circle cx="19" cy="19" r="2.4" fill="#0a84ff" stroke="none"/><path d="M12 7.5 5.8 16.7M12 7.5l6.2 9.2M7.4 19h9.2"/></svg>';
function logoFor(agent) {
  if (agent === "claude") return LOGO_ANTHROPIC;
  if (agent === "codex") return LOGO_OPENAI;
  if (agent === "opencode") return LOGO_ORCH;
  return LOGO_TERM;
}
var AGENT_NAME = { claude: "Claude", codex: "Codex", opencode: "OpenCode", omp: "OMP", antigravity: "Antigravity" };
function agentName(a) { return AGENT_NAME[a] || a || "?"; }
var STATUS_HUMAN = { working: "Trabalhando agora", starting: "Trabalhando agora", needs_input: "Esperando você",
  idle: "Em pausa", completed: "Concluída", failed: "Falhou", stopped: "Parada",
  orphaned: "Interrompida", interrupted: "Interrompida", dead: "Morreu" };
var STATUS_DOT = { working: "working", starting: "working", needs_input: "waiting", idle: "resting",
  completed: "done", failed: "failed", stopped: "done", orphaned: "waiting", interrupted: "waiting", dead: "done" };
var STATUS_COLOR = { working: "#30d158", starting: "#30d158", needs_input: "#ff9f0a", idle: "#636366",
  completed: "#3a3a3c", failed: "#ff453a", stopped: "#3a3a3c", orphaned: "#ff9f0a", interrupted: "#ff9f0a",
  dead: "#3a3a3c" };
function lastEventHuman(last) {
  if (!last) return "";
  if (last === "exit 0") return "terminou bem";
  if (last === "agent_end") return "terminou a resposta";
  if (last.indexOf("tool: ") === 0) {
    var tool = last.slice(6);
    if (tool === "bash") return "rodando comandos no terminal";
    return "usando " + tool;
  }
  if (last.indexOf("send: ") === 0) return "recebeu sua mensagem";
  return "";
}
function toolHuman(name) {
  if (!name) return "uma tarefa";
  if (name === "bash" || name === "Bash") return "terminal";
  return name;
}
/* Pedaco do input real da ferramenta: primeira string interessante, cortada.
   "terminal" sozinho nao diz nada; "podman ps" diz. */
function inputSnippet(input) {
  if (!input) return "";
  if (typeof input === "string") return clip(input);
  if (typeof input !== "object") return "";
  var keys = ["command", "cmd", "file", "path", "query", "pattern", "message", "text", "url"];
  for (var i = 0; i < keys.length; i++) {
    var v = input[keys[i]];
    if (typeof v === "string" && v.trim() !== "") return clip(v);
  }
  return "";
}
function clip(s) {
  var one = String(s).replace(/\s+/g, " ").trim();
  return one.length > 42 ? one.slice(0, 42) + "…" : one;
}
function toolLabel(tool) {
  var name = (tool && tool.name) || "";
  var snip = inputSnippet(tool && tool.input);
  if (!name) return snip || "uma tarefa";
  if (name === "bash" || name === "Bash") return snip ? '"' + snip + '"' : "terminal";
  return snip ? name + " " + snip : name;
}
function timeAgo(iso) {
  var t = new Date(iso).getTime();
  if (!t) return "";
  var m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "agora mesmo";
  if (m < 60) return "há " + m + " min";
  var h = Math.floor(m / 60);
  if (h < 24) return "há " + h + " h";
  return "há " + Math.floor(h / 24) + " dias";
}
function ringSlot(wi) {
  var j = 0, start = 0;
  while (true) {
    var R = 300 + j * 230;
    var k = Math.max(6, Math.floor(2 * Math.PI * R / 250));
    if (wi < start + k) {
      return { a: ((wi - start) + j * 0.5) / k * Math.PI * 2 - Math.PI / 2, r: R };
    }
    start += k;
    j++;
  }
}
function hexA(hex, a) {
  var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return "rgba(" + r + "," + g + "," + b + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
}

var nodesById = {};
var nodes = [];
var canvas = document.getElementById("scene");
var ctx = canvas.getContext("2d");
var cam = { x: 700, y: 330, zoom: 1 };
var motion = true;
function resize() {
  var dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();
function w2s(x, y) { return [(x - cam.x) * cam.zoom + window.innerWidth / 2, (y - cam.y) * cam.zoom + window.innerHeight / 2]; }
function edgeCurve(a, b) {
  var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  var dx = b.x - a.x, dy = b.y - a.y;
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var bow = Math.min(60, len * 0.15);
  return { ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: mx - dy / len * bow, cy: my + dx / len * bow };
}
function qpoint(e, t) {
  var u = 1 - t;
  return [u * u * e.ax + 2 * u * t * e.cx + t * t * e.bx, u * u * e.ay + 2 * u * t * e.cy + t * t * e.by];
}
var particles = [];
var rings = [];
function spawnFlow(from, color, n) {
  if (!from || from.runId === "solo") return;
  var to = null;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].runId === from.runId && nodes[i].isOrch) { to = nodes[i]; break; }
  }
  if (!to) return;
  for (var k = 0; k < (n || 2); k++) {
    particles.push({ from: from, to: to, t: -k * 0.12, speed: 0.008 + Math.random() * 0.008,
      color: color || STATUS_COLOR[from.status] || "#30d158", size: 2 + Math.random() * 1.5 });
  }
}
function spawnRing(n, color) {
  if (n) rings.push({ x: n.x, y: n.y, r: 20, maxR: 120, alpha: 0.5, color: color });
}

var nodesLayer = document.getElementById("nodes");
var feedList = document.getElementById("feedList");
function makeNodeEl(n) {
  var el = document.createElement("div");
  el.className = "node" + (n.isOrch ? " orch" : "");
  var row = document.createElement("div");
  row.className = "row";
  var logo = document.createElement("span");
  logo.className = "logo";
  logo.innerHTML = logoFor(n.agent);
  row.appendChild(logo);
  var dot = document.createElement("i");
  row.appendChild(dot);
  var name = document.createElement("span");
  name.className = "name";
  row.appendChild(name);
  el.appendChild(row);
  var sub = document.createElement("div");
  sub.className = "sub";
  el.appendChild(sub);
  var act = document.createElement("div");
  act.className = "act";
  el.appendChild(act);
  n.el = el; n.dotEl = dot; n.nameEl = name; n.subEl = sub; n.actEl = act;
  el.addEventListener("mousedown", function (ev) { startDragNode(ev, n); });
  nodesLayer.appendChild(el);
  paintNode(n);
}
function paintNode(n) {
  n.dotEl.className = "dot " + (STATUS_DOT[n.status] || "done");
  n.nameEl.textContent = n.isOrch ? "Orquestrador" : agentName(n.agent);
  if (n.isOrch) {
    n.subEl.style.display = "";
    n.subEl.textContent = n.count + (n.count === 1 ? " sessão" : " sessões");
  } else {
    n.subEl.style.display = "none";
    n.subEl.textContent = "";
  }
  n.actEl.innerHTML = "";
  var b = document.createElement("b");
  b.textContent = STATUS_HUMAN[n.status] || "Encerrada";
  n.actEl.appendChild(b);
  n.actEl.appendChild(document.createTextNode(" · " + n.activity));
  n.el.classList.toggle("orch", !!n.isOrch);
  n.el.classList.toggle("alert", n.status === "needs_input");
  n.el.title = "sessão " + n.id + (n.label ? " · " + n.label : "");
}
function feed(agent, text) {
  var li = document.createElement("li");
  li.className = "fresh";
  var b = document.createElement("b");
  b.textContent = agent;
  li.appendChild(b);
  li.appendChild(document.createTextNode(text));
  feedList.insertBefore(li, feedList.firstChild);
  while (feedList.children.length > 6) feedList.removeChild(feedList.lastChild);
  var items = feedList.children;
  for (var i = 0; i < items.length; i++) items[i].classList.toggle("fresh", i === 0);
}
function paintSummary() {
  var working = 0, waiting = 0, hidden = 0;
  nodes.forEach(function (n) {
    if (n.status === "working" || n.status === "starting") working++;
    if (n.status === "needs_input") waiting++;
    if (hideDone && isDone(n.status)) hidden++;
  });
  var el = document.getElementById("summary");
  el.innerHTML = "";
  el.appendChild(document.createTextNode(nodes.length + " sessões · "));
  var b1 = document.createElement("b"); b1.textContent = working + " trabalhando"; el.appendChild(b1);
  el.appendChild(document.createTextNode(" · "));
  var b2 = document.createElement("b"); b2.textContent = waiting + " esperando você"; el.appendChild(b2);
  if (hidden > 0) el.appendChild(document.createTextNode(" · " + hidden + " ocultas"));
}

/* Reconcilia o poll com os nos: preserva posicao arrastada, atualiza status. */
var streams = {};
function baseActivity(s) {
  if (s.status === "needs_input") return "quer sua aprovação para continuar";
  var last = lastEventHuman(s.lastEvent);
  if (s.status === "failed") return last ? "falhou quando estava " + last : "falhou, abra os logs para ver";
  if (s.status === "dead") return last ? "morreu quando estava " + last : "morreu, o processo sumiu";
  if (s.status === "completed") return last ? "concluída, " + last : "concluída";
  if (s.status === "working" || s.status === "starting") return last || "processando...";
  if (last) return "por último: " + last;
  return "sem atividade recente";
}
var lastSessions = [];
function visibleNodes() {
  return nodes.filter(function (n) { return !(hideDone && isDone(n.status)); });
}
/* Raio de conteudo de um grupo a partir dos nos visiveis: grupo de um no
   so vira um ponto compacto em vez de pagar o diametro do anel cheio. */
function groupRadius(list) {
  var workers = 0;
  for (var i = 0; i < list.length; i++) if (!list[i].isOrch) workers++;
  if (workers === 0) return 130;
  return ringSlot(workers - 1).r + 130;
}
/* Layout deterministico sobre o conjunto VISIVEL: esconder concluidas
   reempacota o resto lado a lado em vez de deixar buracos no mundo.
   O slot (wi) nasce na criacao em ordem de chegada, entao polls e
   chegadas novas nao embaralham ninguem; so o arraste fixa (pinned). */
function layoutVisible() {
  var groups = {};
  visibleNodes().forEach(function (n) {
    if (!groups[n.runId]) groups[n.runId] = [];
    groups[n.runId].push(n);
  });
  var gkeys = Object.keys(groups).sort();
  var radii = gkeys.map(function (k) { return groupRadius(groups[k]); });
  var total = 0;
  for (var i = 0; i < gkeys.length - 1; i++) total += radii[i] + radii[i + 1] + 260;
  var cx = -total / 2;
  gkeys.forEach(function (key, gi) {
    var list = groups[key];
    list.forEach(function (n) {
      // Aneis concentricos com lotacao pela circunferencia: cada no tem
      // ~235px de espaco no anel, entao N workers nunca se encostam.
      // (Filotaxia empacota demais para cards de 196px.)
      if (n.isOrch) { n.hx = cx; n.hy = 0; }
      else {
        var slot = ringSlot(Math.max(0, n.wi));
        n.hx = cx + Math.cos(slot.a) * slot.r;
        n.hy = Math.sin(slot.a) * slot.r;
      }
      if (!n.pinned) { n.x = n.hx; n.y = n.hy; }
    });
    if (gi < gkeys.length - 1) cx += radii[gi] + radii[gi + 1] + 260;
  });
}
function reconcile(sessions) {
  lastSessions = sessions;
  var totals = {};
  sessions.forEach(function (s) {
    var key = s.runId || ("solo:" + s.id);
    totals[key] = (totals[key] || 0) + 1;
  });
  var seen = {};
  sessions.forEach(function (s) {
    var key = s.runId || ("solo:" + s.id);
    var isOrch = s.id === s.runId;
    var n = nodesById[s.id];
    if (!n) {
      var wi = -1;
      if (!isOrch) {
        wi = 0;
        for (var k = 0; k < nodes.length; k++) {
          if (nodes[k].runId === key && !nodes[k].isOrch) wi = Math.max(wi, nodes[k].wi + 1);
        }
      }
      n = { id: s.id, runId: key, isOrch: isOrch, agent: s.agent,
        x: 0, y: 0, wi: wi, pinned: false, liveUntil: 0 };
      nodesById[s.id] = n;
      nodes.push(n);
      makeNodeEl(n);
    }
    n.status = s.status;
    n.agent = s.agent;
    n.isOrch = isOrch;
    n.repo = s.repository ? String(s.repository).split("/").pop() : "";
    n.count = totals[key];
    n.label = s.name || "";
    if (Date.now() > n.liveUntil) n.activity = baseActivity(s);
    paintNode(n);
    seen[s.id] = true;
    if (detailId === s.id) {
      detailStatus = s.status;
      detailOrigin = s.origin || null;
      paintSendState();
    }
  });
  for (var id in nodesById) {
    if (!seen[id]) {
      var n = nodesById[id];
      if (n.es) { try { n.es.close(); } catch (e) {} }
      if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
      delete nodesById[id];
      nodes.splice(nodes.indexOf(n), 1);
    }
  }
  layoutVisible();
  ensureStreams();
  paintSummary();
  if (!window.__fitted && nodes.length) {
    window.__fitted = true;
    // Enquadra o run mais ativo, nao a frota inteira: 100 nos fixos nunca
    // cabem legiveis numa viewport. O resto fica ao redor para o pan.
    fitCamera(bestRunFocus());
  }
}
function bestRunFocus() {
  // So o conjunto visivel participa: com hide ligado, no oculto nao
  // puxa a camera nem entra no enquadramento.
  var vis = visibleNodes();
  // Pouca gente visivel: enquadra todo mundo, nao so o run campeao.
  // (Com 5 nos, focar so o melhor corta o vizinho na borda.)
  if (vis.length <= 8) return vis;
  var activeByRun = {};
  vis.forEach(function (n) {
    if (isActive(n.status)) activeByRun[n.runId] = (activeByRun[n.runId] || 0) + 1;
  });
  var bestRun = null, bestCount = 0;
  for (var rk in activeByRun) {
    if (activeByRun[rk] > bestCount) { bestCount = activeByRun[rk]; bestRun = rk; }
  }
  return bestRun ? vis.filter(function (n) { return n.runId === bestRun; }) : vis;
}
/* Pills de borda para sessoes ativas fora da viewport: o resumo conta a
   frota inteira, entao quem trabalha longe aparece aqui com um atalho. */
var edgeMarkers = [];
function drawMarkers() {
  edgeMarkers = [];
  nodes.forEach(function (n) {
    if (!isActive(n.status)) return;
    var p = w2s(n.x, n.y);
    var m = 80;
    if (p[0] > -40 && p[0] < window.innerWidth + 40 && p[1] > -40 && p[1] < window.innerHeight + 40) return;
    var cx = Math.min(window.innerWidth - m, Math.max(m, p[0]));
    var cy = Math.min(window.innerHeight - m, Math.max(m, p[1]));
    var label = agentName(n.agent);
    ctx.font = "12px system-ui, sans-serif";
    var w = ctx.measureText(label).width + 36;
    var h = 26;
    var x = cx - w / 2, y = cy - h / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 13);
    else ctx.rect(x, y, w, h);
    ctx.fillStyle = "rgba(19,22,28,0.92)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 15, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_COLOR[n.status] || "#30d158";
    ctx.fill();
    ctx.fillStyle = "#f5f5f7";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + 25, cy + 1);
    edgeMarkers.push({ x: x, y: y, w: w, h: h, node: n });
  });
}
function fitCamera(list) {
  if (!list.length) return;
  var xs = list.map(function (n) { return n.x; });
  var ys = list.map(function (n) { return n.y; });
  var bw = Math.max.apply(null, xs) - Math.min.apply(null, xs) + 700;
  var bh = Math.max.apply(null, ys) - Math.min.apply(null, ys) + 500;
  cam.x = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
  cam.y = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
  cam.zoom = Math.min(1, Math.max(0.5, Math.min(window.innerWidth / bw, window.innerHeight / bh)));
}
function isDone(s) { return s === "completed" || s === "failed" || s === "stopped" || s === "dead"; }
function isActive(s) { return s === "working" || s === "starting" || s === "needs_input"; }
function ensureStreams() {
  var open = 0;
  nodes.forEach(function (n) {
    if (isActive(n.status) && !n.es && open < 12) {
      open++;
      var es = new EventSource("api/sessions/" + encodeURIComponent(n.id) + "/stream");
      n.es = es;
      es.onmessage = function (m) {
        try { onEvent(n, JSON.parse(m.data)); } catch (e) {}
      };
      es.addEventListener("error", function () {
        try { n.es.close(); } catch (e) {}
        n.es = null;
      });
    } else if (!isActive(n.status) && n.es) {
      try { n.es.close(); } catch (e) {}
      n.es = null;
    }
  });
}
function touch(n, activity) {
  n.activity = activity;
  n.liveUntil = Date.now() + 8000;
  paintNode(n);
}
function onEvent(n, ev) {
  if (!ev || !ev.type) return;
  if (ev.type === "text.delta") {
    spawnFlow(n, "#30d158", 1);
    touch(n, "escrevendo resposta");
  } else if (ev.type === "tool.started") {
    spawnRing(n, "#0a84ff");
    spawnFlow(n, "#0a84ff", 1);
    touch(n, toolLabel(ev.tool));
    feed(agentName(n.agent), "começou: " + toolLabel(ev.tool));
  } else if (ev.type === "tool.completed") {
    var bad = ev.tool && ev.tool.success === false;
    touch(n, toolLabel(ev.tool) + (bad ? " (com erro)" : " ✓"));
    if (bad) feed(agentName(n.agent), "ferramenta falhou");
  } else if (ev.type === "message") {
    if (ev.role === "assistant") {
      touch(n, "respondendo");
      feed(agentName(n.agent), String(ev.content || "").slice(0, 90));
    }
  } else if (ev.type === "message.queued") {
    touch(n, "mensagem na fila");
    feed(agentName(n.agent), "mensagem na fila");
    if (n.id && n.id === detailId) { detailPending = ev.prompt || true; paintSendState(); }
  } else if (ev.type === "turn.started") {
    if (n.id && n.id === detailId && detailPending) { detailPending = null; paintSendState(); }
  } else if (ev.type === "turn.completed") {
    feed(agentName(n.agent), "etapa concluída");
  } else if (ev.type === "file.changed") {
    feed(agentName(n.agent), "mudou " + (ev.path || "um arquivo"));
  } else if (ev.type === "permission.requested") {
    n.status = "needs_input";
    touch(n, "quer sua aprovação para continuar");
    paintSummary();
    spawnRing(n, "#ff9f0a");
    feed(agentName(n.agent), "pedindo sua aprovação");
  } else if (ev.type === "session.completed" || ev.type === "session.failed") {
    n.status = ev.type === "session.failed" ? "failed" : "completed";
    touch(n, ev.type === "session.failed" ? ("falhou: " + (ev.error || "")) : "concluída");
    paintSummary();
    feed(agentName(n.agent), ev.type === "session.failed" ? "falhou" : "concluída");
    // Stop/release cancels the queue server-side: drop a stale "na fila"
    // hint on the open detail, mirroring the turn.started branch.
    if (n.id && n.id === detailId && detailPending) { detailPending = null; paintSendState(); }
    if (n.es) { try { n.es.close(); } catch (e) {} n.es = null; }
  }
}

function drawGrid() {
  var gap = 34 * cam.zoom;
  if (gap < 14) return;
  ctx.fillStyle = "rgba(255,255,255,0.055)";
  var ox = (window.innerWidth / 2 - cam.x * cam.zoom) % gap;
  var oy = (window.innerHeight / 2 - cam.y * cam.zoom) % gap;
  if (ox < 0) ox += gap;
  if (oy < 0) oy += gap;
  for (var x = ox; x < window.innerWidth; x += gap)
    for (var y = oy; y < window.innerHeight; y += gap) ctx.fillRect(x, y, 1.4, 1.4);
}
/* Largura externa do card (CSS content-box + padding 13px/lado + borda):
   e o numero que centra o card no ponto e dimensiona o container. */
function nodeOuterW(n) { return (n.isOrch ? 228 : 196) + 28; }
/* Container por run: borda tracejada beeeem suave com o nome do repo,
   desenhado atras dos cards. A bbox e recalculada a cada frame a partir
   da posicao viva dos nos, entao acompanha arraste e polls. */
function drawGroupBoxes() {
  var groups = {};
  nodes.forEach(function (n) {
    if (hideDone && isDone(n.status)) return;
    if (!groups[n.runId]) groups[n.runId] = [];
    groups[n.runId].push(n);
  });
  ctx.save();
  ctx.setLineDash([5, 7]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  Object.keys(groups).forEach(function (key) {
    var list = groups[key];
    var x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12, repo = "";
    list.forEach(function (n) {
      var hw = nodeOuterW(n) / 2 + 28, hh = 44 + 28;
      if (n.x - hw < x0) x0 = n.x - hw;
      if (n.y - hh < y0) y0 = n.y - hh;
      if (n.x + hw > x1) x1 = n.x + hw;
      if (n.y + hh > y1) y1 = n.y + hh;
      if (n.isOrch && n.repo) repo = n.repo;
    });
    if (!repo) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].repo) { repo = list[i].repo; break; }
      }
    }
    var a = w2s(x0, y0), b = w2s(x1, y1);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(a[0], a[1], b[0] - a[0], b[1] - a[1], 18);
    else ctx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.stroke();
    if (repo) {
      ctx.fillStyle = "rgba(235,235,240,0.38)";
      ctx.fillText(repo, a[0] + 14, a[1] - 6);
    }
  });
  ctx.restore();
}
function frame() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawGrid();
  drawGroupBoxes();
  nodes.forEach(function (n) {
    if (n.isOrch || n.runId === "solo" || n.runId.indexOf("solo:") === 0) return;
    if (hideDone && isDone(n.status)) return;
    var o = null;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].runId === n.runId && nodes[i].isOrch) { o = nodes[i]; break; }
    }
    if (!o) return;
    var e = edgeCurve(n, o);
    var pa = w2s(e.ax, e.ay), pb = w2s(e.bx, e.by), pc = w2s(e.cx, e.cy);
    ctx.beginPath();
    ctx.moveTo(pa[0], pa[1]);
    ctx.quadraticCurveTo(pc[0], pc[1], pb[0], pb[1]);
    ctx.strokeStyle = n.status === "working" ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  });
  for (var i = particles.length - 1; i >= 0; i--) {
    var p = particles[i];
    if (hideDone && (isDone(p.from.status) || isDone(p.to.status))) {
      particles.splice(i, 1);
      continue;
    }
    p.t += motion ? p.speed : 0;
    if (p.t > 1.1) { particles.splice(i, 1); continue; }
    if (p.t < 0) continue;
    var q = qpoint(edgeCurve(p.from, p.to), Math.min(1, p.t));
    var s = w2s(q[0], q[1]);
    ctx.beginPath();
    ctx.arc(s[0], s[1], p.size * cam.zoom, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  for (var j = rings.length - 1; j >= 0; j--) {
    var r = rings[j];
    r.r += motion ? 2.2 : 0;
    r.alpha -= motion ? 0.011 : 0;
    if (r.alpha <= 0 || r.r > r.maxR) { rings.splice(j, 1); continue; }
    var c = w2s(r.x, r.y);
    var rad = Math.max(1, r.r * cam.zoom);
    var g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], rad);
    g.addColorStop(0, hexA(r.color, r.alpha * 0.55));
    g.addColorStop(0.55, hexA(r.color, r.alpha * 0.22));
    g.addColorStop(1, hexA(r.color, 0));
    ctx.beginPath();
    ctx.arc(c[0], c[1], rad, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
  }
  drawMarkers();
  nodes.forEach(function (n) {
    var hidden = hideDone && isDone(n.status);
    n.el.style.display = hidden ? "none" : "";
    if (hidden) return;
    var p = w2s(n.x, n.y);
    // Largura EXTERNA do card: o CSS usa content-box com padding 13px de
    // cada lado, entao o centro real fica 13px a direita do 196/228.
    var w = nodeOuterW(n);
    // O no escala junto com o zoom: sem isso o DOM fica gigante no mundo
    // e o layout que e limpo em coordenadas vira pilha na tela.
    n.el.style.transform = "translate(" + Math.round(p[0] - (w / 2) * cam.zoom) + "px," +
      Math.round(p[1] - 44 * cam.zoom) + "px) scale(" + cam.zoom + ")";
  });
  requestAnimationFrame(frame);
}

var dragNode = null, panning = false, lastM = null;
function toWorld(cx, cy) {
  return [(cx - window.innerWidth / 2) / cam.zoom + cam.x, (cy - window.innerHeight / 2) / cam.zoom + cam.y];
}
var dragMoved = false;
function startDragNode(ev, n) {
  dragNode = n;
  dragMoved = false;
  lastM = [ev.clientX, ev.clientY];
  ev.stopPropagation();
  ev.preventDefault();
}
/* Hit-test recalculado na hora a partir dos nos: nao depende do array
   desenhado no ultimo frame, entao nunca diverge dele. */
function markerAt(cx, cy) {
  var found = null;
  nodes.forEach(function (n) {
    if (found || !isActive(n.status)) return;
    var p = w2s(n.x, n.y);
    var m = 80;
    if (p[0] > -40 && p[0] < window.innerWidth + 40 && p[1] > -40 && p[1] < window.innerHeight + 40) return;
    var px = Math.min(window.innerWidth - m, Math.max(m, p[0]));
    var py = Math.min(window.innerHeight - m, Math.max(m, p[1]));
    var label = agentName(n.agent);
    ctx.font = "12px system-ui, sans-serif";
    var w = ctx.measureText(label).width + 36;
    var x = px - w / 2, y = py - 13;
    if (cx >= x && cx <= x + w && cy >= y && cy <= y + 26) found = n;
  });
  return found;
}
canvas.addEventListener("mousedown", function (ev) {
  var hit = markerAt(ev.clientX, ev.clientY);
  if (hit) {
    cam.x = hit.x;
    cam.y = hit.y;
    if (cam.zoom < 0.7) cam.zoom = 0.7;
    return;
  }
  panning = true;
  lastM = [ev.clientX, ev.clientY];
});
window.addEventListener("mousemove", function (ev) {
  if (dragNode) {
    if (Math.abs(ev.clientX - lastM[0]) + Math.abs(ev.clientY - lastM[1]) > 4) {
      dragMoved = true;
      // Posicao manual sobrevive aos polls: o layout so move no solto.
      dragNode.pinned = true;
    }
    dragNode.x += (ev.clientX - lastM[0]) / cam.zoom;
    dragNode.y += (ev.clientY - lastM[1]) / cam.zoom;
    lastM = [ev.clientX, ev.clientY];
  } else if (panning) {
    cam.x -= (ev.clientX - lastM[0]) / cam.zoom;
    cam.y -= (ev.clientY - lastM[1]) / cam.zoom;
    lastM = [ev.clientX, ev.clientY];
  }
});
window.addEventListener("mouseup", function () {
  if (dragNode && !dragMoved) selectSession(dragNode.id);
  dragNode = null;
  panning = false;
});
window.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") closeDetail();
});
window.addEventListener("wheel", function (ev) {
  ev.preventDefault();
  var before = toWorld(ev.clientX, ev.clientY);
  cam.zoom = Math.min(2.2, Math.max(0.45, cam.zoom * (ev.deltaY < 0 ? 1.1 : 0.9)));
  var after = toWorld(ev.clientX, ev.clientY);
  cam.x += before[0] - after[0];
  cam.y += before[1] - after[1];
}, { passive: false });
function syncUrl() {
  try {
    var qp = new URLSearchParams(window.location.search);
    // Padrão é esconder concluídas: a URL limpa É o estado escondido, e
    // quem quiser ver tudo marca hide=0 explicitamente.
    if (hideDone) qp.delete("hide"); else qp.set("hide", "0");
    if (!motion) qp.set("motion", "0"); else qp.delete("motion");
    var qs = qp.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
  } catch (e) {}
}
// Filtros sobrevivem ao F5: o estado mora na query string (?hide=0&motion=0).
// hideDone nasce true: concluídas ficam fora até alguém pedir hide=0.
var urlHide = true, urlMotion = true;
try {
  var qp0 = new URLSearchParams(window.location.search);
  urlHide = qp0.get("hide") !== "0";
  urlMotion = qp0.get("motion") !== "0";
} catch (e) {}
motion = urlMotion;
document.getElementById("btnMotion").onclick = function (ev) {
  motion = !motion;
  // currentTarget, nunca target: o clique cai no SVG interno e a classe
  // precisa alternar no botao para o estado visual acompanhar.
  ev.currentTarget.classList.toggle("on", motion);
  syncUrl();
};
document.getElementById("btnReset").onclick = function () {
  // Solta os arrastes manuais, reempacota e volta para a acao (mesmo
  // enquadramento da abertura), nunca um zoom cego.
  nodes.forEach(function (n) { n.pinned = false; });
  layoutVisible();
  fitCamera(bestRunFocus());
};
var hideDone = urlHide;
document.getElementById("btnHide").onclick = function (ev) {
  hideDone = !hideDone;
  ev.currentTarget.classList.toggle("on", hideDone);
  ev.currentTarget.title = hideDone ? "Mostrar concluídas" : "Ocultar concluídas";
  // Trocar o filtro reempacota o mundo e reenquadra: sem isso os nos
  // visiveis ficam presos nos slots antigos, a um oceano de distancia.
  layoutVisible();
  fitCamera(bestRunFocus());
  paintSummary();
  syncUrl();
};
document.getElementById("btnMotion").classList.toggle("on", motion);
document.getElementById("btnHide").classList.toggle("on", hideDone);
document.getElementById("btnHide").title = hideDone ? "Mostrar concluídas" : "Ocultar concluídas";

/* Transcrição da sessão: a mensagem do usuário mora em turn.started.prompt
   (o daemon anexa no turno inicial e a cada send), a resposta em
   message(role=assistant) com content completo. Ferramentas viram linhas
   compactas para a conversa continuar legível. */
var detailId = null, detailStatus = null, detailOrigin = null, detailPending = null;
var sendInFlight = false, sendBlockedNote = false;
function chatMsg(who, text, cls) {
  var d = document.createElement("div");
  d.className = "msg " + cls;
  var w = document.createElement("span");
  w.className = "who";
  w.textContent = who;
  d.appendChild(w);
  d.appendChild(document.createTextNode(text));
  return d;
}
function chatEvt(text) {
  var d = document.createElement("div");
  d.className = "evt";
  d.textContent = text;
  return d;
}
/* Input e botão seguem o estado do daemon: ocupada trava, origin=open
   (TUI interativa) trava sempre. Mensagem de sucesso não é apagada aqui. */
function paintSendState() {
  var input = document.getElementById("dSendText");
  var btn = document.getElementById("dSendBtn");
  var msg = document.getElementById("dSendMsg");
  if (!detailId) return;
  // origin=open (TUI interativa) trava sempre; working/starting entra na
  // fila em vez de travar. Mensagem de sucesso não é apagada aqui.
  var reason = "";
  if (detailOrigin === "open") reason = "sessão interativa não aceita mensagens";
  input.disabled = sendInFlight || reason !== "";
  btn.disabled = sendInFlight || reason !== "";
  if (reason) { msg.textContent = reason; sendBlockedNote = true; }
  else if (detailPending) { msg.textContent = "1 mensagem na fila — envia quando o turno terminar"; sendBlockedNote = true; }
  else if (sendBlockedNote) { msg.textContent = ""; sendBlockedNote = false; }
}
function row(dt, dd) {
  var d = document.createElement("dt");
  d.textContent = dt;
  var v = document.createElement("dd");
  v.textContent = dd;
  return [d, v];
}
function closeDetail() {
  detailId = null;
  detailStatus = null;
  detailOrigin = null;
  detailPending = null;
  document.getElementById("detail").classList.remove("open");
}
document.getElementById("detailClose").onclick = closeDetail;
function selectSession(id) {
  // /logs traz até 1000 eventos; /get limitaria a transcrição aos 10 últimos.
  fetch("api/sessions/" + encodeURIComponent(id) + "/logs").then(function (r) { return r.json(); }).then(function (j) {
    var s = j.session || j;
    if (!s || !s.id) return;
    detailId = s.id;
    detailStatus = s.status;
    detailOrigin = s.origin || null;
    detailPending = s.pendingMessage || null;
    var title = document.getElementById("dTitle");
    title.innerHTML = "";
    var logo = document.createElement("span");
    logo.className = "logo";
    logo.innerHTML = logoFor(s.agent);
    title.appendChild(logo);
    title.appendChild(document.createTextNode(agentName(s.agent) + " · " + (s.name || s.id)));
    document.getElementById("dSub").textContent = (STATUS_HUMAN[s.status] || s.status) +
      (s.createdAt ? " · começou " + timeAgo(s.createdAt) : "");
    var rows = document.getElementById("dRows");
    rows.innerHTML = "";
    var repo = s.repository ? String(s.repository).split("/").pop() : "";
    var items = [
      ["Modelo", s.model || "—"],
      // effort so existe quando a sessao nasceu com --effort; ausente = padrao.
      ["Esforço", s.effort || "padrão"],
      ["Repo", repo || "—"],
      ["Atividade", s.lastEvent ? (lastEventHuman(s.lastEvent) || s.lastEvent) : "—"],
    ];
    if (s.pid) items.push(["PID", String(s.pid)]);
    if (s.updatedAt) items.push(["Atualizado", timeAgo(s.updatedAt)]);
    var events = j.events || [];
    var tools = 0, msgs = 0;
    events.forEach(function (ev) {
      if (!ev) return;
      if (ev.type === "tool.completed") tools++;
      if (ev.type === "message" && ev.role === "assistant") msgs++;
    });
    items.push(["Ferramentas", String(tools)]);
    items.push(["Respostas", String(msgs)]);
    items.forEach(function (kv) {
      row(kv[0], kv[1]).forEach(function (el) { rows.appendChild(el); });
    });
    var chat = document.getElementById("dChat");
    chat.innerHTML = "";
    // Últimos 200 eventos bastam: render além disso só pesa o DOM.
    var start = Math.max(0, events.length - 200);
    for (var i = start; i < events.length; i++) {
      var ev = events[i];
      if (!ev || !ev.type) continue;
      if (ev.type === "turn.started" && ev.prompt) {
        chat.appendChild(chatMsg("você", String(ev.prompt), "user"));
      } else if (ev.type === "message.queued" && ev.prompt) {
        chat.appendChild(chatMsg("você", String(ev.prompt) + " (na fila)", "user"));
      } else if (ev.type === "message" && ev.role === "assistant" && ev.content) {
        chat.appendChild(chatMsg(agentName(s.agent), String(ev.content), "assistant"));
      } else if (ev.type === "tool.started") {
        chat.appendChild(chatEvt("começou: " + toolLabel(ev.tool)));
      } else if (ev.type === "tool.completed") {
        var bad = ev.tool && ev.tool.success === false;
        chat.appendChild(chatEvt("terminou: " + toolLabel(ev.tool) + (bad ? " (com erro)" : "")));
      } else if (ev.type === "permission.requested") {
        chat.appendChild(chatEvt("pediu aprovação: " + (ev.tool || "uma ação")));
      } else if (ev.type === "file.changed") {
        chat.appendChild(chatEvt("mudou " + (ev.path || "um arquivo")));
      }
    }
    if (!chat.children.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Sem mensagens ainda.";
      chat.appendChild(empty);
    }
    chat.scrollTop = chat.scrollHeight;
    document.getElementById("detail").classList.add("open");
    paintSendState();
  }).catch(function () {});
}
document.getElementById("dSend").addEventListener("submit", function (ev) {
  ev.preventDefault();
  if (!detailId || sendInFlight) return;
  var input = document.getElementById("dSendText");
  var text = input.value.trim();
  if (!text) return;
  var msg = document.getElementById("dSendMsg");
  var btn = document.getElementById("dSendBtn");
  sendInFlight = true;
  input.disabled = true;
  btn.disabled = true;
  msg.textContent = "enviando...";
  fetch("api/sessions/" + encodeURIComponent(detailId) + "/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: text })
  }).then(function (r) {
    return r.json().then(function (j) { return { ok: r.ok, body: j }; });
  }).then(function (out) {
    if (out.ok) {
      input.value = "";
      if (out.body && out.body.queued) {
        detailPending = text;
        msg.textContent = "mensagem na fila — envia quando o turno terminar";
      } else {
        detailPending = null;
        msg.textContent = "mensagem enviada — nova etapa começou";
      }
      poll();
    } else {
      msg.textContent = (out.body && out.body.error) || "não deu para enviar";
    }
  }).catch(function () {
    msg.textContent = "daemon fora do ar?";
  }).then(function () {
    sendInFlight = false;
    paintSendState();
  });
});

function poll() {
  fetch("api/sessions").then(function (r) { return r.json(); }).then(function (j) {
    reconcile(j.sessions || []);
  }).catch(function () {
    document.getElementById("summary").textContent = "daemon fora do ar?";
  });
}
poll();
setInterval(poll, 2000);
frame();
</script>
</body>
</html>`;
