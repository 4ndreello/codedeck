/** Local staged/unstaged review UI served by `codedeck web` at `/review`.
 *
 * Self-contained page (no external requests besides `api/review`): file
 * tree on the left, unified diff on the right, per-line comment boxes
 * with a "copy markdown" export (`file:line` + quoted code + free text).
 * Drafts persist in localStorage; nothing is sent anywhere.
 */
export const REVIEW_PAGE: string = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeDeck review local</title>
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #08090c; color: #f5f5f7; }
  header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; background: rgba(10,12,16,.94); border-bottom: 1px solid rgba(255,255,255,.1);
    backdrop-filter: blur(10px); flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; }
  header h1 .live { display: inline-block; width: 8px; height: 8px; border-radius: 99px; background: #0a84ff; margin-right: 8px; }
  #meta { font-size: 12px; color: #98989f; }
  #meta b { color: #f5f5f7; }
  header .spacer { flex: 1; }
  header input[type="search"] { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
    border-radius: 8px; color: #f5f5f7; padding: 6px 10px; font-size: 12.5px; font-family: inherit; width: 200px; }
  header button { border: 1px solid rgba(255,255,255,.14); background: rgba(10,132,255,.25); color: #f5f5f7;
    border-radius: 8px; padding: 7px 12px; cursor: pointer; font-family: inherit; font-size: 12.5px; }
  header button.ghost { background: transparent; }
  header button:hover { border-color: rgba(255,255,255,.3); }
  #layout { display: flex; align-items: flex-start; }
  #files { position: sticky; top: 57px; width: 280px; max-height: calc(100vh - 57px); overflow-y: auto;
    border-right: 1px solid rgba(255,255,255,.08); padding: 12px; flex-shrink: 0; }
  #files h2 { font-size: 11px; letter-spacing: .06em; color: #98989f; margin: 0 0 8px; }
  #files ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  #files li a { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px; color: #c7c7cc;
    text-decoration: none; padding: 5px 8px; border-radius: 7px; word-break: break-all; }
  #files li a:hover { background: rgba(255,255,255,.06); }
  #files li a.hasComments { color: #f5f5f7; }
  .st { font-size: 10.5px; font-weight: 700; width: 14px; flex-shrink: 0; text-align: center; }
  .st.M { color: #ff9f0a; } .st.A { color: #30d158; } .st.D { color: #ff453a; } .st.R { color: #0a84ff; }
  .cnt { margin-left: auto; font-size: 10.5px; background: rgba(10,132,255,.3); border-radius: 99px;
    padding: 1px 7px; flex-shrink: 0; }
  #main { flex: 1; min-width: 0; padding: 16px 20px 60px; }
  .file { border: 1px solid rgba(255,255,255,.1); border-radius: 12px; margin-bottom: 18px; overflow: hidden; }
  .file > h3 { margin: 0; padding: 10px 14px; font-size: 13px; background: rgba(255,255,255,.04);
    display: flex; gap: 10px; align-items: baseline; word-break: break-all; }
  .file > h3 .old { color: #636366; font-weight: 400; font-size: 12px; }
  .hunkhead { padding: 4px 14px; font-size: 11.5px; color: #636366; background: rgba(255,255,255,.02);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table.diff { width: 100%; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.55; }
  table.diff td { padding: 0 10px; vertical-align: top; white-space: pre-wrap; word-break: break-word; }
  td.no { width: 44px; min-width: 44px; text-align: right; color: #636366; user-select: none; cursor: pointer; }
  td.no:hover { color: #f5f5f7; background: rgba(10,132,255,.25); }
  tr.add td.code { background: rgba(48,209,88,.10); }
  tr.del td.code { background: rgba(255,69,58,.10); }
  tr.add td.no.new { color: #30d158; } tr.del td.no.old { color: #ff453a; }
  tr.cbox td { padding: 8px 12px 10px 54px; background: rgba(10,132,255,.07); }
  .cbox textarea { width: 100%; min-height: 64px; background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.14); border-radius: 8px; color: #f5f5f7;
    padding: 8px 10px; font-size: 12.5px; font-family: inherit; resize: vertical; }
  .cbox .row { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
  .cbox button { border: 1px solid rgba(255,255,255,.14); background: rgba(10,132,255,.25); color: #f5f5f7;
    border-radius: 8px; padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: 12px; }
  .cbox button.ghost { background: transparent; }
  .cbox .ok { font-size: 11.5px; color: #30d158; }
  .hasNote td.no.new, .hasNote td.no.old { text-decoration: underline dotted; text-underline-offset: 3px; }
  tr.sel td.code { background: rgba(10,132,255,.20); }
  tr.sel td.no { background: rgba(10,132,255,.35); color: #fff; }
  tr.thread td { padding: 6px 12px 10px 54px; }
  .threadbox { border: 1px solid rgba(255,255,255,.12); border-radius: 10px; background: rgba(255,255,255,.03); overflow: hidden; }
  .threadbox .thead { padding: 7px 12px; font-size: 11.5px; color: #98989f; border-bottom: 1px solid rgba(255,255,255,.08); }
  .threadbox .tbody { padding: 9px 12px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  .threadbox .trow { display: flex; gap: 8px; padding: 0 12px 10px; }
  .threadbox button { border: 1px solid rgba(255,255,255,.14); background: transparent; color: #c7c7cc;
    border-radius: 7px; padding: 4px 10px; cursor: pointer; font-family: inherit; font-size: 11.5px; }
  .threadbox button:hover { color: #f5f5f7; border-color: rgba(255,255,255,.3); }
  #empty, #error { max-width: 640px; margin: 60px auto; text-align: center; color: #98989f; font-size: 14px; }
  #error { color: #ff453a; }
  #toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: #1c1e22;
    border: 1px solid rgba(255,255,255,.15); border-radius: 10px; padding: 8px 16px; font-size: 12.5px;
    display: none; z-index: 50; }
  @media (max-width: 800px) { #files { display: none; } }
</style>
</head>
<body>
<header>
  <h1><span class="live"></span>Review local</h1>
  <span id="meta">carregando…</span>
  <span class="spacer"></span>
  <input id="filter" type="search" placeholder="filtrar arquivos…" aria-label="Filtrar arquivos">
  <button id="copyAll" type="button" title="Copiar todos os comentários em markdown">Copiar todos (<span id="nComments">0</span>)</button>
  <a href="/" style="color:#98989f;font-size:12.5px">canvas</a>
</header>
<div id="layout">
  <nav id="files" aria-label="Arquivos"><h2>ARQUIVOS</h2><ul id="fileList"></ul></nav>
  <div id="main"></div>
</div>
<div id="toast" role="status"></div>
<script>
"use strict";
var main = document.getElementById("main");
var meta = document.getElementById("meta");
var fileList = document.getElementById("fileList");
var toastEl = document.getElementById("toast");
var toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.style.display = "none"; }, 2200);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function langOf(p) {
  var b = p.split("/").pop() || p;
  if (b === "Dockerfile" || b.indexOf("Dockerfile.") === 0) return "dockerfile";
  var i = b.lastIndexOf(".");
  if (i < 0) return "";
  var ext = b.slice(i + 1).toLowerCase();
  var map = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", mts: "ts", cts: "ts",
    py: "py", go: "go", rs: "rust", java: "java", rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
    cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp", css: "css", scss: "scss", html: "html",
    xml: "xml", json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "md", sh: "bash", sql: "sql" };
  return map[ext] || "";
}
/* Drafts: key codedeck-review:<file>:<line>[-<endLine>] -> { code, body, deleted } */
function draftKey(file, line, endLine) { return "codedeck-review:" + file + ":" + line + (endLine && endLine !== line ? "-" + endLine : ""); }
function loadDraft(file, line, endLine) {
  try {
    var raw = localStorage.getItem(draftKey(file, line, endLine));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveDraft(file, line, val, endLine) {
  try {
    if (!val || !val.body) localStorage.removeItem(draftKey(file, line, endLine));
    else localStorage.setItem(draftKey(file, line, endLine), JSON.stringify(val));
  } catch (e) {}
}
function allDrafts() {
  var out = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf("codedeck-review:") !== 0) continue;
      var v = JSON.parse(localStorage.getItem(k));
      if (v && v.body) {
        var rest = k.slice("codedeck-review:".length);
        var li = rest.lastIndexOf(":");
        var spec = rest.slice(li + 1).split("-");
        var d = { file: rest.slice(0, li), line: Number(spec[0]), code: v.code, body: v.body, deleted: !!v.deleted };
        if (spec[1]) d.endLine = Number(spec[1]);
        out.push(d);
      }
    }
  } catch (e) {}
  out.sort(function (a, b) { return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line; });
  return out;
}
function formatComment(c) {
  var lang = langOf(c.file);
  var quoted = String(c.code).replace(/\\n$/, "").split("\\n").map(function (l) { return "> " + l; }).join("\\n");
  var mark = c.deleted ? "> - (deleted line)\\n" : "";
  var anchor = c.endLine && c.endLine !== c.line ? c.file + ":" + c.line + "-" + c.endLine : c.file + ":" + c.line;
  return "\`" + anchor + "\`\\n" + mark + "> \`\`\`" + lang + "\\n" + quoted + "\\n> \`\`\`\\n" + String(c.body).trim();
}
function copyText(t, okMsg) {
  function done() { toast(okMsg || "markdown copiado"); refreshCounts(); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, function () { fallback(); });
  } else fallback();
  function fallback() {
    var ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("falha ao copiar"); }
    document.body.removeChild(ta);
  }
}
function refreshCounts() {
  var drafts = allDrafts();
  document.getElementById("nComments").textContent = String(drafts.length);
  var byFile = {};
  drafts.forEach(function (d) { byFile[d.file] = (byFile[d.file] || 0) + 1; });
  Array.prototype.forEach.call(fileList.children, function (li) {
    var a = li.firstChild;
    var f = a.getAttribute("data-file");
    var badge = a.querySelector(".cnt");
    if (byFile[f]) {
      a.classList.add("hasComments");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "cnt";
        a.appendChild(badge);
      }
      badge.textContent = String(byFile[f]);
    } else {
      a.classList.remove("hasComments");
      if (badge) badge.remove();
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll("tr[data-file]"), function (tr) {
    var f = tr.getAttribute("data-file"), ln = Number(tr.getAttribute("data-line"));
    var has = drafts.some(function (d) {
      if (d.file !== f) return false;
      if (d.endLine) return ln >= Math.min(d.line, d.endLine) && ln <= Math.max(d.line, d.endLine);
      return d.line === ln;
    });
    tr.classList.toggle("hasNote", has);
  });
}
/* Drag selection: mousedown on a gutter number starts it, mouseover extends,
 * mouseup opens the box (single line, or range when dragged). selAnchor lives
 * only between down and up; .sel paint stays while the box is open. */
var selAnchor = null;
function closeBoxes(root) {
  Array.prototype.forEach.call(root.querySelectorAll("tr.cbox"), function (b) { b.remove(); });
}
function clearSel(sec) {
  if (!sec) return;
  Array.prototype.forEach.call(sec.querySelectorAll("tr.sel"), function (r) { r.classList.remove("sel"); });
}
function rowsBetween(sec, file, tra, trb) {
  var rows = Array.prototype.filter.call(
    sec.querySelectorAll("tr[data-file]"),
    function (r) { return r.getAttribute("data-file") === file; },
  );
  var ia = rows.indexOf(tra), ib = rows.indexOf(trb);
  if (ia < 0 || ib < 0) return [];
  return rows.slice(Math.min(ia, ib), Math.max(ia, ib) + 1);
}
function openRange(file, a, b, onClose) {
  var sec = a.tr;
  while (sec && sec.className !== "file") sec = sec.parentNode;
  if (!sec) return;
  var slice = rowsBetween(sec, file, a.tr, b.tr);
  if (!slice.length) return;
  var nums = slice.map(function (r) { return Number(r.getAttribute("data-line")); });
  var start = Math.min.apply(null, nums), end = Math.max.apply(null, nums);
  var code = slice.map(function (r) { return r.getAttribute("data-code") || ""; }).join(String.fromCharCode(10));
  var deleted = slice.every(function (r) { return r.className.indexOf("del") >= 0; });
  removeThreads(sec, file, start, end);
  closeBoxes(sec);
  var box = commentRow(file, start, code, deleted, start === end ? undefined : end, onClose);
  var last = slice[slice.length - 1];
  last.parentNode.insertBefore(box, last.nextSibling);
  var ta = box.querySelector("textarea");
  if (ta) ta.focus();
}
/* Drag end (one listener for the whole page): the drop row decides single
 * vs range. Clicking the row that already owns a box closes it (toggle). */
document.addEventListener("mouseup", function (ev) {
  if (!selAnchor) return;
  var startTr = selAnchor.tr;
  selAnchor = null;
  var sec = startTr;
  while (sec && sec.className !== "file") sec = sec.parentNode;
  if (!sec) return;
  var file = startTr.getAttribute("data-file");
  var endTr = null;
  var t = ev.target;
  if (t && t.closest) {
    var cand = t.closest("tr[data-file]");
    if (cand && cand.getAttribute("data-file") === file) endTr = cand;
  }
  if (!endTr) {
    var painted = sec.querySelectorAll("tr.sel");
    endTr = painted.length ? painted[painted.length - 1] : startTr;
  }
  if (endTr === startTr) {
    var line = Number(startTr.getAttribute("data-line"));
    if (startTr.nextSibling && startTr.nextSibling.className === "cbox") {
      startTr.nextSibling.remove();
      clearSel(sec);
      return;
    }
    removeThreads(sec, file, line, line);
    closeBoxes(sec);
    var box = commentRow(file, line, startTr.getAttribute("data-code") || "", startTr.className.indexOf("del") >= 0, undefined, function () { clearSel(sec); });
    startTr.parentNode.insertBefore(box, startTr.nextSibling);
    var ta = box.querySelector("textarea");
    if (ta) ta.focus();
    return;
  }
  openRange(file, { tr: startTr }, { tr: endTr }, function () { clearSel(sec); });
});
function commentRow(file, line, code, deleted, endLine, onClose) {
  var tr = document.createElement("tr");
  tr.className = "cbox";
  var td = document.createElement("td");
  td.colSpan = 3;
  var spec = endLine && endLine !== line ? line + "-" + endLine : String(line);
  var ta = document.createElement("textarea");
  ta.placeholder = "comentar " + file + ":" + spec + "… (shift+enter envia)";
  ta.setAttribute("aria-label", "Comentário em " + file + ":" + spec);
  var prev = loadDraft(file, line, endLine);
  if (prev && prev.body) ta.value = prev.body;
  var row = document.createElement("div");
  row.className = "row";
  var btnSend = document.createElement("button");
  btnSend.type = "button";
  btnSend.textContent = "Enviar";
  btnSend.title = "salva e recolhe — exporte tudo em Copiar todos no topo";
  var btnClear = document.createElement("button");
  btnClear.type = "button";
  btnClear.className = "ghost";
  btnClear.textContent = "Limpar";
  var ok = document.createElement("span");
  ok.className = "ok";
  btnSend.addEventListener("click", function () {
    if (!ta.value.trim()) { toast("escreva o comentário antes de enviar"); return; }
    var saved = { file: file, line: line, endLine: endLine, code: code, body: ta.value, deleted: deleted };
    saveDraft(file, line, { code: code, body: ta.value, deleted: deleted }, endLine);
    refreshCounts();
    tr.remove();
    if (onClose) onClose();
    renderThread(saved);
    toast("salvo ✓ — Copiar todos no topo exporta tudo");
  });
  ta.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.shiftKey) {
      ev.preventDefault();
      btnSend.click();
    }
  });
  btnClear.addEventListener("click", function () {
    ta.value = "";
    saveDraft(file, line, null, endLine);
    refreshCounts();
    tr.remove();
    if (onClose) onClose();
  });
  ta.addEventListener("input", function () {
    saveDraft(file, line, ta.value.trim() ? { code: code, body: ta.value, deleted: deleted } : null, endLine);
    refreshCounts();
  });
  row.appendChild(btnSend);
  row.appendChild(btnClear);
  row.appendChild(ok);
  td.appendChild(ta);
  td.appendChild(row);
  tr.appendChild(td);
  return tr;
}
/* Saved drafts render as GitHub-like thread boxes under their lines. */
function removeThreads(sec, file, start, end) {
  Array.prototype.forEach.call(sec.querySelectorAll("tr.thread"), function (r) {
    if (r.getAttribute("data-file") !== file) return;
    var s = Number(r.getAttribute("data-start")), e = Number(r.getAttribute("data-end"));
    if (Math.min(e, end) >= Math.max(s, start)) r.remove();
  });
}
function specOf(d) {
  var end = d.endLine || d.line;
  return end !== d.line ? d.line + "-" + end : String(d.line);
}
function renderThread(d) {
  var end = d.endLine || d.line;
  var lo = Math.min(d.line, end), hi = Math.max(d.line, end);
  var rows = Array.prototype.filter.call(document.querySelectorAll("tr[data-file]"), function (r) {
    if (r.getAttribute("data-file") !== d.file) return false;
    var ln = Number(r.getAttribute("data-line"));
    return ln >= lo && ln <= hi;
  });
  if (!rows.length) return;
  var last = rows[rows.length - 1];
  var tr = document.createElement("tr");
  tr.className = "thread";
  tr.setAttribute("data-file", d.file);
  tr.setAttribute("data-start", String(lo));
  tr.setAttribute("data-end", String(hi));
  var td = document.createElement("td");
  td.colSpan = 3;
  var box = document.createElement("div");
  box.className = "threadbox";
  var head = document.createElement("div");
  head.className = "thead";
  head.textContent = lo === hi ? "Comentário na linha " + lo : "Comentário nas linhas " + lo + "-" + hi;
  var body = document.createElement("div");
  body.className = "tbody";
  body.textContent = d.body;
  var trow = document.createElement("div");
  trow.className = "trow";
  var bCopy = document.createElement("button");
  bCopy.type = "button";
  bCopy.textContent = "Copiar";
  bCopy.addEventListener("click", function () {
    copyText(formatComment({ file: d.file, line: d.line, endLine: d.endLine, code: d.code, body: d.body, deleted: d.deleted }), "comentário copiado");
  });
  var bEdit = document.createElement("button");
  bEdit.type = "button";
  bEdit.textContent = "Editar";
  bEdit.addEventListener("click", function () {
    tr.remove();
    var ed = commentRow(d.file, d.line, d.code, d.deleted, d.endLine, null);
    last.parentNode.insertBefore(ed, last.nextSibling);
    var ta = ed.querySelector("textarea");
    if (ta) ta.focus();
  });
  var bDel = document.createElement("button");
  bDel.type = "button";
  bDel.textContent = "Excluir";
  bDel.addEventListener("click", function () {
    saveDraft(d.file, d.line, null, d.endLine);
    refreshCounts();
    tr.remove();
    toast("comentário excluído");
  });
  trow.appendChild(bCopy);
  trow.appendChild(bEdit);
  trow.appendChild(bDel);
  box.appendChild(head);
  box.appendChild(body);
  box.appendChild(trow);
  td.appendChild(box);
  tr.appendChild(td);
  last.parentNode.insertBefore(tr, last.nextSibling);
}
function render(data) {
  main.innerHTML = "";
  fileList.innerHTML = "";
  var files = data.files || [];
  meta.innerHTML = "ref <b>" + esc(data.ref || "HEAD") + "</b> · <b>" + files.length + "</b> arquivos" +
    (data.truncated ? " · <b>truncado</b>" : "") +
    (data.base ? " · " + esc(String(data.base).slice(0, 8)) : "");
  if (!files.length) {
    main.innerHTML = '<div id="empty">Nada para revisar — working tree limpo contra ' + esc(data.ref || "HEAD") + ".</div>";
    refreshCounts();
    return;
  }
  files.forEach(function (f, idx) {
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.href = "#f" + idx;
    a.setAttribute("data-file", f.path);
    var st = document.createElement("span");
    st.className = "st " + f.status[0].toUpperCase();
    st.textContent = f.status[0].toUpperCase();
    var nm = document.createElement("span");
    nm.textContent = f.path;
    a.appendChild(st);
    a.appendChild(nm);
    li.appendChild(a);
    fileList.appendChild(li);

    var sec = document.createElement("section");
    sec.className = "file";
    sec.id = "f" + idx;
    var h = document.createElement("h3");
    var title = f.status === "renamed" ? f.oldPath + " → " + f.path : f.path;
    h.innerHTML = '<span class="st ' + f.status[0].toUpperCase() + '">' + f.status[0].toUpperCase() + "</span><span>" + esc(title) + "</span>" +
      (f.oldPath && f.oldPath !== f.path && f.status !== "renamed" ? '<span class="old">' + esc(f.oldPath) + "</span>" : "");
    sec.appendChild(h);
    if (f.binary) {
      var p = document.createElement("p");
      p.style.cssText = "padding:4px 14px 12px;color:#98989f;font-size:12.5px";
      p.textContent = "arquivo binário — sem diff textual.";
      sec.appendChild(p);
    } else if (f.tooLarge) {
      var q = document.createElement("p");
      q.style.cssText = "padding:4px 14px 12px;color:#98989f;font-size:12.5px";
      q.textContent = "arquivo grande demais para exibir — veja no git.";
      sec.appendChild(q);
    }
    (f.hunks || []).forEach(function (hu) {
      var hh = document.createElement("div");
      hh.className = "hunkhead";
      hh.textContent = hu.header;
      sec.appendChild(hh);
      var table = document.createElement("table");
      table.className = "diff";
      (hu.lines || []).forEach(function (ln) {
        var tr = document.createElement("tr");
        if (ln.type === "add") tr.className = "add";
        else if (ln.type === "del") tr.className = "del";
        var anchorLine = ln.newNo != null ? ln.newNo : ln.oldNo;
        tr.setAttribute("data-file", f.path);
        tr.setAttribute("data-line", String(anchorLine));
        tr.setAttribute("data-code", ln.text);
        var tdO = document.createElement("td");
        tdO.className = "no old";
        tdO.textContent = ln.oldNo != null ? String(ln.oldNo) : "";
        tdO.title = "arraste para selecionar · clique comenta a linha";
        var tdN = document.createElement("td");
        tdN.className = "no new";
        tdN.textContent = ln.newNo != null ? String(ln.newNo) : "";
        tdN.title = "arraste para selecionar · clique comenta a linha";
        var tdC = document.createElement("td");
        tdC.className = "code";
        tdC.textContent = (ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ") + ln.text;
        function dragStart(ev) {
          if (ev.button !== undefined && ev.button !== 0) return;
          ev.preventDefault();
          closeBoxes(sec);
          clearSel(sec);
          selAnchor = { tr: tr };
          tr.classList.add("sel");
        }
        function dragOver(ev) {
          if (!selAnchor || selAnchor.tr.getAttribute("data-file") !== f.path) return;
          if (ev.buttons !== undefined && !(ev.buttons & 1)) return;
          clearSel(sec);
          var slice = rowsBetween(sec, f.path, selAnchor.tr, tr);
          slice.forEach(function (r) { r.classList.add("sel"); });
        }
        tdO.addEventListener("mousedown", dragStart);
        tdN.addEventListener("mousedown", dragStart);
        tdO.addEventListener("mouseover", dragOver);
        tdN.addEventListener("mouseover", dragOver);
        tr.appendChild(tdO);
        tr.appendChild(tdN);
        tr.appendChild(tdC);
        table.appendChild(tr);
      });
      sec.appendChild(table);
    });
    main.appendChild(sec);
  });
  refreshCounts();
  allDrafts().forEach(function (d) { renderThread(d); });
}
function load() {
  var params = new URLSearchParams(location.search);
  var ref = params.get("ref") || "HEAD";
  fetch("api/review?ref=" + encodeURIComponent(ref))
    .then(function (res) {
      if (!res.ok) throw new Error("review indisponível (HTTP " + res.status + ")");
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      meta.textContent = "erro";
      main.innerHTML = '<div id="error">' + esc(err.message) + "</div>";
    });
}
document.getElementById("copyAll").addEventListener("click", function () {
  var drafts = allDrafts();
  if (!drafts.length) { toast("nenhum comentário ainda — clique num número de linha"); return; }
  copyText(drafts.map(formatComment).join("\\n\\n---\\n\\n"), drafts.length + " comentários copiados");
});
document.getElementById("filter").addEventListener("input", function (ev) {
  var q = ev.target.value.toLowerCase();
  Array.prototype.forEach.call(fileList.children, function (li) {
    var f = li.firstChild.getAttribute("data-file").toLowerCase();
    li.style.display = !q || f.indexOf(q) >= 0 ? "" : "none";
  });
  Array.prototype.forEach.call(main.children, function (sec) {
    if (sec.id && sec.id[0] === "f") {
      var idx = Number(sec.id.slice(1));
      var link = fileList.children[idx];
      sec.style.display = link && link.style.display === "none" ? "none" : "";
    }
  });
});
load();
</script>
</body>
</html>`;
