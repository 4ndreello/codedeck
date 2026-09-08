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
<div class="hud" id="hint">arraste para organizar · scroll dá zoom</div>
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
  orphaned: "Interrompida", interrupted: "Interrompida" };
var STATUS_DOT = { working: "working", starting: "working", needs_input: "waiting", idle: "resting",
  completed: "done", failed: "failed", stopped: "done", orphaned: "waiting", interrupted: "waiting" };
var STATUS_COLOR = { working: "#30d158", starting: "#30d158", needs_input: "#ff9f0a", idle: "#636366",
  completed: "#3a3a3c", failed: "#ff453a", stopped: "#3a3a3c", orphaned: "#ff9f0a", interrupted: "#ff9f0a" };
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
  if (name === "bash" || name === "Bash") return "comandos no terminal";
  return name;
}
function ringSlot(wi) {
  var j = 0, start = 0;
  while (true) {
    var R = 300 + j * 260;
    var k = Math.max(6, Math.floor(2 * Math.PI * R / 300));
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
  if (s.status === "completed") return last ? "concluída, " + last : "concluída";
  if (s.status === "working" || s.status === "starting") return last || "processando...";
  if (last) return "por último: " + last;
  return "sem atividade recente";
}
function reconcile(sessions) {
  var groups = {};
  sessions.forEach(function (s) {
    var key = s.runId || ("solo:" + s.id);
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });
  var gkeys = Object.keys(groups);
  var maxWorkers = 1;
  gkeys.forEach(function (key) { maxWorkers = Math.max(maxWorkers, groups[key].length); });
  var spread = ringSlot(Math.max(0, maxWorkers - 1)).r;
  var gapX = spread * 2 + 460;
  var seen = {};
  gkeys.forEach(function (key, gi) {
    var list = groups[key];
    var orch = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === list[i].runId) { orch = list[i]; break; }
    }
    var cx = 420 + gi * gapX, cy = 330;
    var wi = 0;
    list.forEach(function (s) {
      var isOrch = !!orch && s.id === orch.id;
      var n = nodesById[s.id];
      if (!n) {
        // Aneis concentricos com lotacao pela circunferencia: cada no tem
        // ~235px de espaco no anel, entao N workers nunca se encostam.
        // (Filotaxia empacota demais para cards de 196px.)
        var slot = ringSlot(wi);
        n = { id: s.id, runId: key, isOrch: isOrch, agent: s.agent,
          x: isOrch ? cx : cx + Math.cos(slot.a) * slot.r,
          y: isOrch ? cy : cy + Math.sin(slot.a) * slot.r,
          liveUntil: 0 };
        if (!isOrch) wi++;
        nodesById[s.id] = n;
        nodes.push(n);
        makeNodeEl(n);
      }
      n.status = s.status;
      n.agent = s.agent;
      n.isOrch = isOrch;
      n.count = list.length;
      n.label = s.name || "";
      if (Date.now() > n.liveUntil) n.activity = baseActivity(s);
      paintNode(n);
      seen[s.id] = true;
    });
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
  var activeByRun = {};
  nodes.forEach(function (n) {
    if (isActive(n.status)) activeByRun[n.runId] = (activeByRun[n.runId] || 0) + 1;
  });
  var bestRun = null, bestCount = 0;
  for (var rk in activeByRun) {
    if (activeByRun[rk] > bestCount) { bestCount = activeByRun[rk]; bestRun = rk; }
  }
  return bestRun ? nodes.filter(function (n) { return n.runId === bestRun; }) : nodes;
}
function fitCamera(list) {
  if (!list.length) return;
  var xs = list.map(function (n) { return n.x; });
  var ys = list.map(function (n) { return n.y; });
  var bw = Math.max.apply(null, xs) - Math.min.apply(null, xs) + 700;
  var bh = Math.max.apply(null, ys) - Math.min.apply(null, ys) + 500;
  cam.x = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
  cam.y = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
  cam.zoom = Math.min(1, Math.max(0.4, Math.min(window.innerWidth / bw, window.innerHeight / bh)));
}
function isDone(s) { return s === "completed" || s === "failed" || s === "stopped"; }
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
    var name = (ev.tool && ev.tool.name) || "";
    spawnRing(n, "#0a84ff");
    spawnFlow(n, "#0a84ff", 1);
    touch(n, "usando " + toolHuman(name));
    feed(agentName(n.agent), "começou: " + toolHuman(name));
  } else if (ev.type === "tool.completed") {
    var bad = ev.tool && ev.tool.success === false;
    touch(n, toolHuman(ev.tool && ev.tool.name) + (bad ? " (com erro)" : " concluído"));
    if (bad) feed(agentName(n.agent), "ferramenta falhou");
  } else if (ev.type === "message") {
    if (ev.role === "assistant") {
      touch(n, "respondendo");
      feed(agentName(n.agent), String(ev.content || "").slice(0, 90));
    }
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
function frame() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  drawGrid();
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
  nodes.forEach(function (n) {
    var hidden = hideDone && isDone(n.status);
    n.el.style.display = hidden ? "none" : "";
    if (hidden) return;
    var p = w2s(n.x, n.y);
    var w = n.isOrch ? 228 : 196;
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
function startDragNode(ev, n) {
  dragNode = n;
  lastM = [ev.clientX, ev.clientY];
  ev.stopPropagation();
  ev.preventDefault();
}
canvas.addEventListener("mousedown", function (ev) { panning = true; lastM = [ev.clientX, ev.clientY]; });
window.addEventListener("mousemove", function (ev) {
  if (dragNode) {
    dragNode.x += (ev.clientX - lastM[0]) / cam.zoom;
    dragNode.y += (ev.clientY - lastM[1]) / cam.zoom;
    lastM = [ev.clientX, ev.clientY];
  } else if (panning) {
    cam.x -= (ev.clientX - lastM[0]) / cam.zoom;
    cam.y -= (ev.clientY - lastM[1]) / cam.zoom;
    lastM = [ev.clientX, ev.clientY];
  }
});
window.addEventListener("mouseup", function () { dragNode = null; panning = false; });
window.addEventListener("wheel", function (ev) {
  ev.preventDefault();
  var before = toWorld(ev.clientX, ev.clientY);
  cam.zoom = Math.min(2.2, Math.max(0.45, cam.zoom * (ev.deltaY < 0 ? 1.1 : 0.9)));
  var after = toWorld(ev.clientX, ev.clientY);
  cam.x += before[0] - after[0];
  cam.y += before[1] - after[1];
}, { passive: false });
document.getElementById("btnMotion").onclick = function (ev) {
  motion = !motion;
  // currentTarget, nunca target: o clique cai no SVG interno e a classe
  // precisa alternar no botao para o estado visual acompanhar.
  ev.currentTarget.classList.toggle("on", motion);
};
document.getElementById("btnReset").onclick = function () {
  // Volta para a acao (mesmo enquadramento da abertura), nunca um zoom
  // cego: com a frota espalhada, zoom 1 ou fit-geral cai no vazio entre runs.
  fitCamera(bestRunFocus());
};
var hideDone = false;
document.getElementById("btnHide").onclick = function (ev) {
  hideDone = !hideDone;
  ev.currentTarget.classList.toggle("on", hideDone);
  ev.currentTarget.title = hideDone ? "Mostrar concluídas" : "Ocultar concluídas";
  paintSummary();
};

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
