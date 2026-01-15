/* ═══════════════════════════════════════════════════════════════
   NoShitProxy - Application Logic
   ═══════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);

// Escape HTML entities
const esc = s => (s ?? "").toString()
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

// Clean binary/garbage from preview text
function cleanPreview(text) {
  if (!text) return "";
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "·");
}

function headerValue(headers, name) {
  if (!headers) return null;
  const n = name.toLowerCase();
  for (const [k, v] of headers) {
    if ((k || "").toLowerCase() === n) return v;
  }
  return null;
}

function prettyJson(text) {
  const cleaned = cleanPreview(text);
  return JSON.stringify(JSON.parse(cleaned), null, 2);
}

function serializeXmlNode(node, indent = 0) {
  const pad = "  ".repeat(indent);

  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent || "").replace(/\s+/g, " ").trim();
    return t ? pad + t : "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName;
  const attrs = Array.from(node.attributes || []).map(a => ` ${a.name}="${a.value}"`).join("");
  const open = `<${tag}${attrs}>`;
  const close = `</${tag}>`;

  const children = Array.from(node.childNodes || []).map(ch => serializeXmlNode(ch, indent + 1)).filter(Boolean);
  if (children.length === 0) return pad + open + close;

  return [pad + open, ...children, pad + close].join("\n");
}

function prettyXml(text) {
  const cleaned = cleanPreview(text);
  const doc = new DOMParser().parseFromString(cleaned, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("invalid xml");
  return serializeXmlNode(doc.documentElement, 0);
}

const VOID_HTML = new Set([
  "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"
]);

function serializeHtmlNode(node, indent = 0) {
  const pad = "  ".repeat(indent);

  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent || "").replace(/\s+/g, " ").trim();
    return t ? pad + t : "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  const attrs = Array.from(node.attributes || []).map(a => ` ${a.name}="${a.value}"`).join("");
  const open = `<${tag}${attrs}>`;

  if (VOID_HTML.has(tag)) return pad + open;

  const children = Array.from(node.childNodes || []).map(ch => serializeHtmlNode(ch, indent + 1)).filter(Boolean);
  if (children.length === 0) return pad + open + `</${tag}>`;

  return [pad + open, ...children, pad + `</${tag}>`].join("\n");
}

function prettyHtml(text) {
  const cleaned = cleanPreview(text);
  const doc = new DOMParser().parseFromString(cleaned, "text/html");
  const root = doc.documentElement;
  return "<!doctype html>\n" + serializeHtmlNode(root, 0);
}

function prettyBody(text, contentType) {
  const ct = (contentType || "").toLowerCase();
  const cleaned = cleanPreview(text);

  if (ct.includes("json")) return prettyJson(cleaned);
  if (ct.includes("xml") || cleaned.trim().startsWith("<?xml")) return prettyXml(cleaned);
  if (ct.includes("html") || cleaned.trim().toLowerCase().startsWith("<!doctype") || cleaned.trim().toLowerCase().startsWith("<html")) {
    return prettyHtml(cleaned);
  }
  return cleaned;
}

function safePrettyBody(text, contentType) {
  try {
    return prettyBody(text, contentType);
  } catch {
    return cleanPreview(text);
  }
}

function formatBytes(n) {
  const v = Number(n || 0);
  if (!v) return "—";
  if (v < 1024) return v + "B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + "KB";
  return (v / (1024 * 1024)).toFixed(1) + "MB";
}

// Format duration in seconds
function formatDuration(d) {
  if (d === null || d === undefined) return "—";
  if (d < 0.001) return "<1ms";
  if (d < 1) return (d * 1000).toFixed(0) + "ms";
  return d.toFixed(2) + "s";
}

const methodClass = m => `method-${(m || "get").toLowerCase()}`;
const statusClass = code => {
  if (!code) return "status-pending";
  if (code < 300) return "status-2xx";
  if (code < 400) return "status-3xx";
  if (code < 500) return "status-4xx";
  return "status-5xx";
};

// HTTP status reason phrases
const STATUS_TEXT = {
  200: "OK", 201: "Created", 204: "No Content",
  301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable"
};

/* ─────────────────────────────────────────────────────────────────
   Build Raw HTTP Request
   ───────────────────────────────────────────────────────────────── */
function buildRawRequest(flow, pretty) {
  const lines = [];

  const path = flow.path || "/";
  lines.push(`${flow.method} ${path} HTTP/1.1`);

  if (flow.req_headers && flow.req_headers.length > 0) {
    for (const [key, value] of flow.req_headers) {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push("");

  if (flow.req_preview) {
    const ct = headerValue(flow.req_headers, "content-type");
    const body = pretty ? safePrettyBody(flow.req_preview, ct) : cleanPreview(flow.req_preview);
    lines.push(body);
  }

  return lines.join("\n");
}

/* ─────────────────────────────────────────────────────────────────
   Build Raw HTTP Response
   ───────────────────────────────────────────────────────────────── */
function buildRawResponse(flow, pretty) {
  const lines = [];

  const status = flow.status || 0;
  const reason = STATUS_TEXT[status] || "Unknown";
  lines.push(`HTTP/1.1 ${status} ${reason}`);

  if (flow.resp_headers && flow.resp_headers.length > 0) {
    for (const [key, value] of flow.resp_headers) {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push("");

  if (flow.resp_preview) {
    const ct = headerValue(flow.resp_headers, "content-type");
    const body = pretty ? safePrettyBody(flow.resp_preview, ct) : cleanPreview(flow.resp_preview);
    lines.push(body);
  }

  return lines.join("\n");
}

/* ─────────────────────────────────────────────────────────────────
   History List
   ───────────────────────────────────────────────────────────────── */
const historyState = {
  limit: 1000,
  offset: 0,
  hasMore: true,
  items: [],
  selectedId: null,
  sort: null,
  order: null,
  where: "",
  pendingCount: 0,
  totalCount: null,
  lastCountWhere: null,
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function isSortableCol(col) {
  return ["num", "method", "url", "status", "size", "time"].includes(col);
}

function cycleSort(col) {
  if (!isSortableCol(col)) return;

  if (historyState.sort !== col) {
    historyState.sort = col;
    historyState.order = "asc";
    return;
  }

  if (historyState.order === "asc") {
    historyState.order = "desc";
    return;
  }

  historyState.sort = null;
  historyState.order = null;
}

function updateSortIndicators() {
  document.querySelectorAll(".history-table thead th").forEach(th => {
    th.classList.remove("is-sort-asc", "is-sort-desc");
    const col = th.getAttribute("data-col");
    if (!col) return;

    if (historyState.sort && historyState.sort === col && historyState.order) {
      th.classList.add(historyState.order === "asc" ? "is-sort-asc" : "is-sort-desc");
    }
  });
}

function updateRefreshButton() {
  const btn = $("page_refresh");
  if (!btn) return;

  if (historyState.pendingCount > 0 && historyState.offset > 0) {
    btn.style.display = "inline-flex";
    btn.textContent = `Refresh (+${historyState.pendingCount})`;
  } else {
    btn.style.display = "none";
    btn.textContent = "Refresh";
  }
}

let whereError = "";

function updateHistoryControls() {
  $("page_size").value = String(historyState.limit);
  $("page_newer").disabled = historyState.offset === 0;
  $("page_older").disabled = !historyState.hasMore;

  const page = Math.floor(historyState.offset / historyState.limit) + 1;
  const sortText = historyState.sort ? ` • sort ${historyState.sort} ${historyState.order}` : "";
  const countText = (typeof historyState.totalCount === "number") ? ` • ${historyState.totalCount}` : "";
  const errText = whereError ? ` • ERROR: ${whereError}` : "";
  $("page_meta").textContent = `Page ${page}${sortText}${countText}${errText}`;

  updateSortIndicators();
  updateRefreshButton();
}

function _cmpStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function _cmpNum(a, b) {
  const av = Number(a);
  const bv = Number(b);
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

function compareFlows(a, b) {
  const sortKey = historyState.sort;
  const order = historyState.order;

  if (!sortKey) {
    return _cmpNum(b.ts, a.ts);
  }

  const dir = order === "asc" ? 1 : -1;

  if (sortKey === "num") {
    return _cmpNum(a.seq, b.seq) * dir;
  }

  if (sortKey === "method") {
    const c = _cmpStr(String(a.method || ""), String(b.method || "")) * dir;
    if (c) return c;
  }

  if (sortKey === "url") {
    const c = _cmpStr(String(a.url || ""), String(b.url || "")) * dir;
    if (c) return c;
  }

  if (sortKey === "size") {
    const c = _cmpNum(a.resp_size || 0, b.resp_size || 0) * dir;
    if (c) return c;
  }

  if (sortKey === "status") {
    const an = a.status;
    const bn = b.status;
    if (an == null && bn != null) return 1;
    if (bn == null && an != null) return -1;
    if (an != null && bn != null) {
      const c = _cmpNum(an, bn) * dir;
      if (c) return c;
    }
  }

  if (sortKey === "time") {
    const an = a.duration;
    const bn = b.duration;
    if (an == null && bn != null) return 1;
    if (bn == null && an != null) return -1;
    if (an != null && bn != null) {
      const c = _cmpNum(an, bn) * dir;
      if (c) return c;
    }
  }

  // server tie-breaker
  return _cmpNum(b.ts, a.ts);
}

function insertSorted(items, flow) {
  let lo = 0;
  let hi = items.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareFlows(flow, items[mid]) < 0) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  items.splice(lo, 0, flow);
}

function applyIncomingFlow(flow) {
  if (historyState.items.some(x => x.id === flow.id)) return;

  if (typeof historyState.totalCount === "number") {
    historyState.totalCount += 1;
  }

  if (historyState.offset > 0) {
    historyState.pendingCount += 1;
    updateHistoryControls();
    return;
  }

  if (historyState.sort) {
    insertSorted(historyState.items, flow);
  } else {
    historyState.items.unshift(flow);
  }

  if (historyState.items.length > historyState.limit) {
    historyState.items.pop();
  }

  renderHistoryTable();
  updateHistoryControls();
}

function addRow(flow) {
  const tr = document.createElement("tr");
  tr.dataset.id = flow.id;
  tr.dataset.url = flow.url;
  if (historyState.selectedId && flow.id === historyState.selectedId) {
    tr.classList.add("selected");
  }

  tr.innerHTML = `
    <td class="num-cell">${flow.seq ?? "—"}</td>
    <td><span class="method-badge ${methodClass(flow.method)}">${esc(flow.method)}</span></td>
    <td class="url-text">${esc(flow.url)}</td>
    <td><span class="status-badge ${statusClass(flow.status)}">${flow.status ?? "—"}</span></td>
    <td class="size-cell">${formatBytes(flow.resp_size)}</td>
    <td class="time-cell">${formatDuration(flow.duration)}</td>
  `;

  tr.onclick = () => loadDetail(flow.id);
  tr.addEventListener("contextmenu", e => {
    e.preventDefault();
    showHistoryMenu(e.clientX, e.clientY, flow.id, flow.url);
  });

  $("flows").appendChild(tr);
}

function renderHistoryTable() {
  const tbody = $("flows");
  tbody.innerHTML = "";

  for (let i = 0; i < historyState.items.length; i++) {
    addRow(historyState.items[i]);
  }
}

async function loadCountIfNeeded(where) {
  const w = where || "";
  if (historyState.lastCountWhere === w && typeof historyState.totalCount === "number") {
    return;
  }

  historyState.lastCountWhere = w;
  historyState.totalCount = null;
  updateHistoryControls();

  const url = new URL("/api/flows/count", location.origin);
  if (w) url.searchParams.set("where", w);

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      whereError = (data && data.detail) ? String(data.detail) : `HTTP ${res.status}`;
      historyState.totalCount = null;
    } else {
      whereError = "";
      if (data && typeof data.count === "number") {
        historyState.totalCount = data.count;
      }
    }
  } catch {
    whereError = "";
    historyState.totalCount = null;
  }

  updateHistoryControls();
}

async function loadList({ resetOffset } = {}) {
  if (resetOffset) historyState.offset = 0;

  const url = new URL("/api/flows", location.origin);
  url.searchParams.set("limit", String(historyState.limit));
  url.searchParams.set("offset", String(historyState.offset));

  if (historyState.sort && historyState.order) {
    url.searchParams.set("sort", historyState.sort);
    url.searchParams.set("order", historyState.order);
  }

  const w = effectiveWhere();
  if (w) url.searchParams.set("where", w);

  loadCountIfNeeded(w).catch(() => {});

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      whereError = (data && data.detail) ? String(data.detail) : `HTTP ${res.status}`;
      historyState.items = [];
      historyState.hasMore = false;
      updateHistoryControls();
      return;
    }

    whereError = "";
    historyState.items = Array.isArray(data) ? data : [];
    historyState.hasMore = historyState.items.length === historyState.limit;
    historyState.pendingCount = 0;
    renderHistoryTable();
    updateHistoryControls();
  } catch (e) {
    console.error("Failed to load flows:", e);
  }
}

/* ─────────────────────────────────────────────────────────────────
   Detail View
   ───────────────────────────────────────────────────────────────── */
let currentFlow = null;
let prettyRequest = false;
let prettyResponse = false;

function setPrettyButtons() {
  $("pretty-request")?.classList.toggle("is-active", prettyRequest);
  $("raw-request-btn")?.classList.toggle("is-active", !prettyRequest);
  $("pretty-response")?.classList.toggle("is-active", prettyResponse);
  $("raw-response-btn")?.classList.toggle("is-active", !prettyResponse);
}

function setFullResponseButton() {
  const btn = $("load-full-response");
  if (!btn) return;
  const loaded = Boolean(currentFlow && currentFlow._resp_full);
  btn.classList.toggle("is-active", loaded);
  btn.disabled = loaded || !currentFlow;
}

function setHistoryActionButtons() {
  $("history_to_repeater") && ($("history_to_repeater").disabled = !currentFlow);
  $("history_open") && ($("history_open").disabled = !currentFlow);
}

function renderDetail() {
  if (!currentFlow) return;
  $("raw-request").textContent = buildRawRequest(currentFlow, prettyRequest);
  $("raw-response").textContent = buildRawResponse(currentFlow, prettyResponse);
  setPrettyButtons();
  setFullResponseButton();
  setHistoryActionButtons();
}

async function loadDetail(id) {
  historyState.selectedId = id;
  const selected = document.querySelector(`.history-table tbody tr[data-id="${CSS.escape(id)}"]`);
  if (selected) {
    selected.scrollIntoView({ block: "nearest" });
  }

  document.querySelectorAll(".history-table tbody tr").forEach(r =>
    r.classList.toggle("selected", r.dataset.id === id)
  );

  try {
    const flow = await fetch(`/api/flows/${encodeURIComponent(id)}`).then(r => r.json());

    currentFlow = flow;
    currentFlow._resp_full = false;
    prettyRequest = false;
    prettyResponse = false;
    renderDetail();
  } catch (e) {
    console.error("Failed to load detail:", e);
    currentFlow = null;
    $("raw-request").textContent = "Error loading request";
    $("raw-response").textContent = "Error loading response";
  }
}

/* ─────────────────────────────────────────────────────────────────
   Context Menu
   ───────────────────────────────────────────────────────────────── */
function hideContextMenu() {
  const el = $("ctx-menu");
  el.style.display = "none";
  el.innerHTML = "";
}

function showContextMenu(x, y, items) {
  const el = $("ctx-menu");
  el.innerHTML = "";

  for (const item of items) {
    if (item === "sep") {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      el.appendChild(sep);
      continue;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-item";
    btn.textContent = item.label;
    btn.onclick = () => {
      hideContextMenu();
      item.onClick();
    };
    el.appendChild(btn);
  }

  el.style.display = "block";

  const pad = 6;
  const rect = el.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - pad);
  const top = Math.min(y, window.innerHeight - rect.height - pad);
  el.style.left = `${Math.max(pad, left)}px`;
  el.style.top = `${Math.max(pad, top)}px`;
}

function copyToClipboard(text) {
  const value = String(text || "");

  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }

  const el = document.createElement("textarea");
  el.value = value;
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
  return Promise.resolve();
}

async function openHistoryFlowInRepeater(flowId) {
  const flow = await fetch(`/api/flows/${encodeURIComponent(flowId)}`).then(r => r.json());
  createRepeaterTabFromFlow(flow);
  $("tab-repeater").checked = true;
}

function flowBodyForReplay(flow) {
  const method = String(flow.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { body: "", body_b64: null };
  }

  if (flow.req_body_b64) {
    return { body: "", body_b64: flow.req_body_b64 };
  }

  return { body: flow.req_preview || "", body_b64: null };
}

async function openHistoryFlowInBrowser(flowId) {
  const flow = await fetch(`/api/flows/${encodeURIComponent(flowId)}`).then(r => r.json());

  const method = flow.method || "GET";
  const url = flow.url || "";
  const headers = flow.req_headers || [];
  const bodyPayload = flowBodyForReplay(flow);

  const res = await fetch("/api/replay/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, url, headers, ...bodyPayload })
  });

  const data = await res.json();
  const openUrl = data.browser_url || data.url;
  if (!openUrl) throw new Error("no replay url");
  window.open(openUrl, "_blank", "noopener,noreferrer");
}

async function clearHistory() {
  if (!confirm("Clear all captured flows?")) return;

  await fetch("/api/flows/clear", { method: "POST" });

  historyState.items = [];
  historyState.hasMore = false;
  historyState.pendingCount = 0;
  historyState.totalCount = 0;
  historyState.lastCountWhere = "";

  currentFlow = null;
  $("raw-request").textContent = "Select a request from the history above";
  $("raw-response").textContent = "Response will appear here";

  await loadList({ resetOffset: true });
}

function showHistoryMenu(x, y, flowId, url) {
  showContextMenu(x, y, [
    { label: "Open in Repeater (new tab)", onClick: () => openHistoryFlowInRepeater(flowId).catch(console.error) },
    "sep",
    { label: "Copy URL", onClick: () => copyToClipboard(url).catch(console.error) },
    { label: "Open in browser", onClick: () => openHistoryFlowInBrowser(flowId).catch(console.error) },
    "sep",
    { label: "Clear history", onClick: () => clearHistory().catch(console.error) },
  ]);
}

/* ─────────────────────────────────────────────────────────────────
   Repeater Tabs
   ───────────────────────────────────────────────────────────────── */
const REPEATER_STORAGE_KEY = "nsp.repeater.tabs";

const repeaterTabs = new Map();
let activeRepeaterTabId = null;

function persistRepeaterTabs() {
  saveActiveRepeaterTab();

  const tabs = Array.from(repeaterTabs.values()).map(t => ({
    id: t.id,
    title: t.title,
    modeRaw: Boolean(t.modeRaw),
    method: t.method || "GET",
    url: t.url || "",
    headersText: t.headersText || "",
    body: t.body || "",
    rawText: t.rawText || "",
  }));

  const payload = {
    activeId: activeRepeaterTabId,
    tabs,
  };

  localStorage.setItem(REPEATER_STORAGE_KEY, JSON.stringify(payload));
}

function restoreRepeaterTabs() {
  const raw = localStorage.getItem(REPEATER_STORAGE_KEY);
  if (!raw) return false;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!data || typeof data !== "object" || !Array.isArray(data.tabs)) return false;

  repeaterTabs.clear();

  for (const t of data.tabs) {
    if (!t || typeof t !== "object") continue;

    const id = typeof t.id === "string" && t.id ? t.id : newId();
    const tab = {
      id,
      title: typeof t.title === "string" && t.title ? t.title : "Restored",
      modeRaw: Boolean(t.modeRaw),
      method: typeof t.method === "string" && t.method ? t.method : "GET",
      url: typeof t.url === "string" ? t.url : "",
      headersText: typeof t.headersText === "string" ? t.headersText : "",
      body: typeof t.body === "string" ? t.body : "",
      rawText: typeof t.rawText === "string" ? t.rawText : "",
      lastResponse: null,
      prettyResponse: false,
    };

    repeaterTabs.set(id, tab);
  }

  if (repeaterTabs.size === 0) return false;

  const activeId = typeof data.activeId === "string" ? data.activeId : null;
  activeRepeaterTabId = (activeId && repeaterTabs.has(activeId)) ? activeId : Array.from(repeaterTabs.keys())[0];

  applyRepeaterTab(repeaterTabs.get(activeRepeaterTabId));
  renderRepeaterTabs();
  return true;
}

let _repeaterPersistTimer = null;
function scheduleRepeaterPersist() {
  if (_repeaterPersistTimer) clearTimeout(_repeaterPersistTimer);
  _repeaterPersistTimer = setTimeout(() => {
    _repeaterPersistTimer = null;
    persistRepeaterTabs();
  }, 250);
}

function newId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function tabTitleFromRequest(method, url) {
  try {
    const u = new URL(url);
    const path = u.pathname || "/";
    return `${method.toUpperCase()} ${u.host}${path}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

function getActiveRepeaterTab() {
  if (!activeRepeaterTabId) return null;
  return repeaterTabs.get(activeRepeaterTabId) || null;
}

function saveActiveRepeaterTab() {
  const tab = getActiveRepeaterTab();
  if (!tab) return;

  tab.modeRaw = isRepeaterRawMode();
  tab.rawText = $("rep_raw").value;

  if (tab.modeRaw) {
    const raw = tab.rawText.replace(/\r\n/g, "\n");
    const lines = raw.split("\n");

    const first = (lines[0] || "").trim().split(/\s+/);
    if (first.length >= 2) {
      tab.method = first[0];
      tab.url = first[1];
    }

    const headerLines = [];
    let i = 1;
    for (; i < lines.length; i++) {
      if (lines[i] === "") { i += 1; break; }
      headerLines.push(lines[i]);
    }

    tab.headersText = headerLines.join("\n");
    tab.body = lines.slice(i).join("\n");
  } else {
    tab.method = $("rep_method").value;
    tab.url = $("rep_url").value;
    tab.headersText = $("rep_headers").value;
    tab.body = $("rep_body").value;
  }

  tab.lastResponse = lastRepeaterResponse;
  tab.prettyResponse = prettyRepeaterResponse;

  tab.title = tabTitleFromRequest(tab.method || "GET", tab.url || "");
  scheduleRepeaterPersist();
}

function applyRepeaterTab(tab) {
  $("rep_method").value = tab.method;
  $("rep_url").value = tab.url;
  $("rep_headers").value = tab.headersText;
  $("rep_body").value = tab.body;
  $("rep_raw").value = tab.rawText;

  setRepeaterMode(tab.modeRaw);

  lastRepeaterResponse = tab.lastResponse;
  prettyRepeaterResponse = tab.prettyResponse;

  if (lastRepeaterResponse) {
    renderRepeaterResponse();
  } else {
    $("rep_out").textContent = "Response will appear here...";
    $("rep-pretty")?.classList.toggle("is-active", false);
    $("rep-raw")?.classList.toggle("is-active", true);
  }
}

function renameRepeaterTab(id) {
  const tab = repeaterTabs.get(id);
  if (!tab) return;

  const next = prompt("Tab name", tab.title);
  if (!next) return;

  tab.title = next.trim() || tab.title;
  renderRepeaterTabs();
  persistRepeaterTabs();
}

function renderRepeaterTabs() {
  const container = $("rep-tabs");
  container.innerHTML = "";

  for (const [id, tab] of repeaterTabs.entries()) {
    const el = document.createElement("div");
    el.className = "rep-tab" + (id === activeRepeaterTabId ? " is-active" : "");

    const title = document.createElement("span");
    title.textContent = tab.title;
    title.ondblclick = e => {
      e.stopPropagation();
      renameRepeaterTab(id);
    };

    const close = document.createElement("button");
    close.type = "button";
    close.className = "rep-tab-close";
    close.textContent = "×";
    close.onclick = e => {
      e.stopPropagation();
      closeRepeaterTab(id);
    };

    el.appendChild(title);
    el.appendChild(close);
    el.onclick = () => activateRepeaterTab(id);

    container.appendChild(el);
  }
}

function activateRepeaterTab(id) {
  if (!repeaterTabs.has(id)) return;
  if (id === activeRepeaterTabId) return;

  saveActiveRepeaterTab();
  activeRepeaterTabId = id;
  applyRepeaterTab(repeaterTabs.get(id));
  renderRepeaterTabs();
  persistRepeaterTabs();
}

function closeRepeaterTab(id) {
  if (!repeaterTabs.has(id)) return;

  const ids = Array.from(repeaterTabs.keys());
  const idx = ids.indexOf(id);

  repeaterTabs.delete(id);

  if (repeaterTabs.size === 0) {
    createNewRepeaterTab();
    return;
  }

  if (activeRepeaterTabId === id) {
    const nextId = ids[idx - 1] || ids[idx + 1] || Array.from(repeaterTabs.keys())[0];
    activeRepeaterTabId = nextId;
    applyRepeaterTab(repeaterTabs.get(nextId));
  }

  renderRepeaterTabs();
  persistRepeaterTabs();
}

function createNewRepeaterTab(seed) {
  saveActiveRepeaterTab();

  const s = seed || {};

  const id = newId();
  const tab = {
    id,
    title: s.title || "New",
    modeRaw: Boolean(s.modeRaw),
    method: s.method || "GET",
    url: s.url || "",
    headersText: s.headersText || "",
    body: s.body || "",
    rawText: s.rawText || "",
    lastResponse: null,
    prettyResponse: false,
  };

  repeaterTabs.set(id, tab);
  activeRepeaterTabId = id;
  applyRepeaterTab(tab);
  renderRepeaterTabs();
  persistRepeaterTabs();
}

function isPristineRepeaterTab(tab) {
  return (
    tab.title === "New" &&
    tab.modeRaw === false &&
    String(tab.method || "GET").toUpperCase() === "GET" &&
    !tab.url &&
    !tab.headersText &&
    !tab.body &&
    !tab.rawText &&
    !tab.lastResponse
  );
}

function createRepeaterTabFromFlow(flow) {
  const headersText = (flow.req_headers || []).map(([k, v]) => `${k}: ${v}`).join("\n");

  let body = flow.req_preview || "";
  const ct = headerValue(flow.req_headers, "content-type") || "";
  if (
    flow.req_body_b64 &&
    (ct.includes("multipart/form-data") ||
      ct.includes("application/x-www-form-urlencoded") ||
      ct.includes("text/") ||
      ct.includes("json") ||
      ct.includes("xml"))
  ) {
    try {
      const bytes = b64ToBytes(flow.req_body_b64);
      body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      body = flow.req_preview || "";
    }
  }

  const seed = {
    method: flow.method || "GET",
    url: flow.url || "",
    headersText,
    body,
  };

  seed.title = tabTitleFromRequest(seed.method, seed.url);
  seed.rawText = (() => {
    const lines = [];
    lines.push(`${seed.method} ${seed.url} HTTP/1.1`);
    if (headersText) lines.push(headersText);
    lines.push("");
    if (body) lines.push(body);
    return lines.join("\n");
  })();

  const active = getActiveRepeaterTab();
  if (active && repeaterTabs.size === 1 && isPristineRepeaterTab(active)) {
    active.title = seed.title;
    active.modeRaw = false;
    active.method = seed.method;
    active.url = seed.url;
    active.headersText = seed.headersText;
    active.body = seed.body;
    active.rawText = seed.rawText;
    active.lastResponse = null;
    active.prettyResponse = false;

    applyRepeaterTab(active);
    renderRepeaterTabs();
    persistRepeaterTabs();
    return;
  }

  createNewRepeaterTab(seed);
}

/* ─────────────────────────────────────────────────────────────────
   Repeater
   ───────────────────────────────────────────────────────────────── */
function parseHeadersText(text) {
  const out = [];
  for (const rawLine of (text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    out.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return out;
}

function buildRepeaterRawFromStructured() {
  const method = ($("rep_method").value || "GET").trim().toUpperCase();
  const url = ($("rep_url").value || "").trim();
  const headers = parseHeadersText($("rep_headers").value);
  const body = $("rep_body").value || "";

  const lines = [];
  lines.push(`${method} ${url} HTTP/1.1`);
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  lines.push("");
  if (body) lines.push(body);
  return lines.join("\n");
}

function setRepeaterMode(rawMode) {
  $("rep-raw-wrap").style.display = rawMode ? "flex" : "none";
  $("rep-structured-wrap").style.display = rawMode ? "none" : "flex";

  $("rep-mode-structured").classList.toggle("is-active", !rawMode);
  $("rep-mode-raw").classList.toggle("is-active", rawMode);

  if (rawMode) {
    const existing = $("rep_raw").value;
    if (!existing.trim()) $("rep_raw").value = buildRepeaterRawFromStructured();
  }
}

function isRepeaterRawMode() {
  return $("rep-raw-wrap").style.display !== "none";
}

let lastRepeaterResponse = null;
let prettyRepeaterResponse = false;

function contentTypeFromHeaderText(headersText) {
  const text = (headersText || "").replace(/\r\n/g, "\n");
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    if (k === "content-type") return line.slice(idx + 1).trim();
  }
  return null;
}

function renderRepeaterResponse() {
  if (!lastRepeaterResponse) return;

  const out = $("rep_out");
  const { status, headers, preview } = lastRepeaterResponse;

  const lines = [];
  lines.push(`HTTP/1.1 ${status} ${STATUS_TEXT[status] || "Unknown"}`);
  if (headers) lines.push(headers);
  lines.push("");

  if (preview) {
    const ct = contentTypeFromHeaderText(headers);
    const body = prettyRepeaterResponse ? safePrettyBody(preview, ct) : cleanPreview(preview);
    lines.push(body);
  }

  out.textContent = lines.join("\n");
  $("rep-pretty")?.classList.toggle("is-active", prettyRepeaterResponse);
  $("rep-raw")?.classList.toggle("is-active", !prettyRepeaterResponse);
}

function parseRepeaterRequest() {
  const rawMode = isRepeaterRawMode();

  if (!rawMode) {
    return {
      method: $("rep_method").value,
      url: $("rep_url").value,
      headersText: $("rep_headers").value,
      body: $("rep_body").value
    };
  }

  const raw = $("rep_raw").value || "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const first = (lines[0] || "").trim().split(/\s+/);
  if (first.length < 2) throw new Error("invalid request line");

  const method = first[0];
  let url = first[1];

  const headerLines = [];
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === "") { i += 1; break; }
    headerLines.push(lines[i]);
  }

  const body = lines.slice(i).join("\n");

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    const base = ($("rep_url").value || "").trim();
    if (!base) throw new Error("base url required for relative path");
    const u = new URL(base);
    url = `${u.protocol}//${u.host}${url.startsWith("/") ? url : "/" + url}`;
  }

  return {
    method,
    url,
    headersText: headerLines.join("\n"),
    body
  };
}

async function sendRequest() {
  const out = $("rep_out");
  out.textContent = "Sending...";

  try {
    const req = parseRepeaterRequest();
    const res = await fetch("/api/repeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headersText,
        body: req.body
      })
    });

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(rawText || `HTTP ${res.status}`);
    }

    if (!res.ok) {
      const msg = data && data.detail ? data.detail : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    if (!data || typeof data !== "object" || typeof data.status !== "number") {
      throw new Error(rawText || `HTTP ${res.status}`);
    }

    lastRepeaterResponse = data;
    prettyRepeaterResponse = false;

    const tab = getActiveRepeaterTab();
    if (tab) {
      tab.lastResponse = data;
      tab.prettyResponse = false;
    }

    renderRepeaterResponse();
  } catch (e) {
    lastRepeaterResponse = null;
    out.textContent = "Error: " + (e && e.message ? e.message : String(e));
  }
}

async function openInBrowser() {
  const req = parseRepeaterRequest();

  const method = req.method;
  const url = req.url;
  const headers = parseHeadersText(req.headersText);
  const body = req.body;

  const res = await fetch("/api/replay/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, url, headers, body, body_b64: null })
  });

  const data = await res.json();
  const openUrl = data.browser_url || data.url;
  if (!openUrl) throw new Error("no replay url");
  window.open(openUrl, "_blank", "noopener,noreferrer");
}

/* ─────────────────────────────────────────────────────────────────
   Event Listeners & Init
   ───────────────────────────────────────────────────────────────── */
// `WHERE` filter
function readWhereFromUi() {
  historyState.where = ($("where")?.value || "").trim();
  localStorage.setItem("nsp.where", historyState.where);
}

function clearWhereUi() {
  $("where").value = "";
  readWhereFromUi();
}

const STATIC_EXTENSIONS = [
  "css","js","map",
  "png","jpg","jpeg","gif","svg","webp","ico",
  "woff","woff2","ttf","eot",
  "mp4","mp3","m4a",
];

function staticClause() {
  const parts = STATIC_EXTENSIONS.map(ext => `url LIKE '%.${ext}%'`);
  return `NOT (${parts.join(" OR ")})`;
}

function readHideStaticFromUi() {
  const v = Boolean($("hide_static")?.checked);
  localStorage.setItem("nsp.hide_static", v ? "1" : "0");
  return v;
}

function hideStaticEnabled() {
  const el = $("hide_static");
  if (!el) return false;
  return Boolean(el.checked);
}

let scopeWhere = "";

function sqlQuote(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

function hasWildcard(pattern) {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function clauseForPattern(pattern) {
  if (hasWildcard(pattern)) {
    return `url GLOB ${sqlQuote(pattern)}`;
  }
  return `url LIKE ${sqlQuote("%" + pattern + "%")}`;
}

function computeScopeWhere(include, exclude) {
  const inc = Array.isArray(include) ? include.filter(Boolean) : [];
  const exc = Array.isArray(exclude) ? exclude.filter(Boolean) : [];

  const includeClause = (inc.length ? inc : ["*"]).map(clauseForPattern).join(" OR ");
  const excludeClause = exc.length ? exc.map(clauseForPattern).join(" OR ") : "";

  const out = [`(${includeClause})`];
  if (excludeClause) out.push(`NOT (${excludeClause})`);
  return out.join(" AND ");
}

function updateScopeWhereFromConfig(cfg) {
  const include = Array.isArray(cfg.include) ? cfg.include : ["*"];
  const exclude = Array.isArray(cfg.exclude) ? cfg.exclude : [];

  const isDefault = include.length === 1 && include[0] === "*" && exclude.length === 0;
  scopeWhere = isDefault ? "" : computeScopeWhere(include, exclude);
}

function effectiveWhere() {
  const user = (historyState.where || "").trim();
  const hideStatic = hideStaticEnabled();
  const staticW = hideStatic ? staticClause() : "";

  const parts = [];
  if (user) parts.push(`(${user})`);
  if (scopeWhere) parts.push(`(${scopeWhere})`);
  if (staticW) parts.push(`(${staticW})`);

  return parts.join(" AND ");
}

function hasWhere() {
  return Boolean(effectiveWhere());
}

$("where")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    readWhereFromUi();
    historyState.pendingCount = 0;
    loadList({ resetOffset: true });
  }
});

$("where_apply")?.addEventListener("click", () => {
  readWhereFromUi();
  historyState.pendingCount = 0;
  loadList({ resetOffset: true });
});

$("where_clear")?.addEventListener("click", () => {
  clearWhereUi();
  historyState.pendingCount = 0;
  loadList({ resetOffset: true });
});

// Scope modal
function showScopeModal() {
  $("scope-modal").style.display = "flex";
}

function hideScopeModal() {
  $("scope-modal").style.display = "none";
}

async function loadScopeIntoUi() {
  const res = await fetch("/api/scope");
  const data = await res.json();
  const include = Array.isArray(data.include) ? data.include : ["*"];
  const exclude = Array.isArray(data.exclude) ? data.exclude : [];
  $("scope-include").value = include.join("\n");
  $("scope-exclude").value = exclude.join("\n");
  $("scope-drop").checked = Boolean(data.drop);

  updateScopeWhereFromConfig(data);
}

async function saveScopeFromUi() {
  const include = ($("scope-include").value || "")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const exclude = ($("scope-exclude").value || "")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const drop = $("scope-drop").checked;

  const res = await fetch("/api/scope", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ include, exclude, drop })
  });

  const data = await res.json();
  updateScopeWhereFromConfig(data);

  historyState.pendingCount = 0;
  await loadList({ resetOffset: true });
}

$("scope_btn")?.addEventListener("click", () => {
  loadScopeIntoUi().catch(console.error);
  showScopeModal();
});

$("scope-close")?.addEventListener("click", () => hideScopeModal());
$("scope-backdrop")?.addEventListener("click", () => hideScopeModal());

function showHelpModal() {
  $("help-modal").style.display = "flex";
}

function hideHelpModal() {
  $("help-modal").style.display = "none";
}

$("help-close")?.addEventListener("click", () => hideHelpModal());
$("help-backdrop")?.addEventListener("click", () => hideHelpModal());
$("where_help")?.addEventListener("click", () => showHelpModal());

$("scope-save")?.addEventListener("click", () => {
  $("scope-save").textContent = "Saving...";
  saveScopeFromUi().catch(console.error).finally(() => {
    $("scope-save").textContent = "Save";
    hideScopeModal();
  });
});

$("send").onclick = sendRequest;
$("rep-pretty")?.addEventListener("click", () => {
  if (!lastRepeaterResponse) return;
  prettyRepeaterResponse = true;
  const tab = getActiveRepeaterTab();
  if (tab) tab.prettyResponse = true;
  renderRepeaterResponse();
});
$("rep-raw")?.addEventListener("click", () => {
  if (!lastRepeaterResponse) return;
  prettyRepeaterResponse = false;
  const tab = getActiveRepeaterTab();
  if (tab) tab.prettyResponse = false;
  renderRepeaterResponse();
});

$("open").onclick = () => openInBrowser().catch(e => {
  console.error(e);
  $("rep_out").textContent = "Open error: " + (e && e.message ? e.message : String(e));
});

$("rep-mode-structured")?.addEventListener("click", () => {
  setRepeaterMode(false);
  saveActiveRepeaterTab();
  renderRepeaterTabs();
});
$("rep-mode-raw")?.addEventListener("click", () => {
  setRepeaterMode(true);
  saveActiveRepeaterTab();
  renderRepeaterTabs();
});

$("pretty-request")?.addEventListener("click", () => {
  if (!currentFlow) return;
  prettyRequest = true;
  renderDetail();
});

$("raw-request-btn")?.addEventListener("click", () => {
  if (!currentFlow) return;
  prettyRequest = false;
  renderDetail();
});

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function charsetFromContentType(ct) {
  const m = /charset=([^;]+)/i.exec(ct || "");
  return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "utf-8";
}

async function loadFullResponseBody() {
  if (!currentFlow) return;
  const res = await fetch(`/api/flows/${encodeURIComponent(currentFlow.id)}/response/body`);
  if (!res.ok) throw new Error("not stored");
  const data = await res.json();

  const bytes = b64ToBytes(data.body_b64);
  const charset = charsetFromContentType(data.content_type);

  let text;
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  currentFlow.resp_preview = text;
  currentFlow._resp_full = true;
  renderDetail();
}

$("pretty-response")?.addEventListener("click", () => {
  if (!currentFlow) return;
  prettyResponse = true;
  renderDetail();
});

$("raw-response-btn")?.addEventListener("click", () => {
  if (!currentFlow) return;
  prettyResponse = false;
  renderDetail();
});

$("load-full-response")?.addEventListener("click", () => {
  $("load-full-response").textContent = "Loading...";
  loadFullResponseBody()
    .catch(e => {
      console.error(e);
    })
    .finally(() => {
      $("load-full-response").textContent = "Full";
    });
});

$("history_to_repeater")?.addEventListener("click", () => {
  if (!currentFlow) return;
  createRepeaterTabFromFlow(currentFlow);
  $("tab-repeater").checked = true;
});

$("history_open")?.addEventListener("click", () => {
  if (!currentFlow) return;

  const method = currentFlow.method || "GET";
  const url = currentFlow.url || "";
  const headers = currentFlow.req_headers || [];
  const bodyPayload = flowBodyForReplay(currentFlow);

  fetch("/api/replay/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, url, headers, ...bodyPayload })
  })
    .then(r => r.json())
    .then(data => {
      const openUrl = data.browser_url || data.url;
      if (!openUrl) throw new Error("no replay url");
      window.open(openUrl, "_blank", "noopener,noreferrer");
    })
    .catch(console.error);
});

// Initial load
if (!restoreRepeaterTabs()) {
  createNewRepeaterTab();
}

$("rep-new")?.addEventListener("click", () => {
  createNewRepeaterTab();
});

const repeaterInputs = ["rep_method", "rep_url", "rep_headers", "rep_body", "rep_raw"];
for (const id of repeaterInputs) {
  $(id)?.addEventListener("input", () => {
    saveActiveRepeaterTab();
    renderRepeaterTabs();
  });
}

document.addEventListener("click", () => hideContextMenu());
document.addEventListener("scroll", () => hideContextMenu(), true);
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  hideContextMenu();
  hideScopeModal();
  hideHelpModal();
});

const savedPageSize = localStorage.getItem("nsp.page_size");
historyState.limit = clampInt(savedPageSize, 50, 2000, 1000);
updateHistoryControls();

// init WHERE from localStorage (done earlier if exists)

const savedHideStatic = localStorage.getItem("nsp.hide_static");
if (savedHideStatic !== null) {
  $("hide_static").checked = savedHideStatic === "1";
}

const savedWhere = localStorage.getItem("nsp.where");
if (savedWhere) {
  $("where").value = savedWhere;
  historyState.where = savedWhere;
}

$("hide_static")?.addEventListener("change", () => {
  readHideStaticFromUi();
  historyState.pendingCount = 0;
  loadList({ resetOffset: true });
});

$("page_size")?.addEventListener("change", () => {
  historyState.limit = clampInt($("page_size").value, 50, 2000, historyState.limit);
  localStorage.setItem("nsp.page_size", String(historyState.limit));
  loadList({ resetOffset: true });
});

$("page_older")?.addEventListener("click", () => {
  historyState.offset += historyState.limit;
  historyState.pendingCount = 0;
  loadList();
});

$("page_newer")?.addEventListener("click", () => {
  historyState.offset = Math.max(0, historyState.offset - historyState.limit);
  historyState.pendingCount = 0;
  loadList();
});

$("page_refresh")?.addEventListener("click", () => {
  historyState.pendingCount = 0;
  loadList();
});

loadList({ resetOffset: true });

// Real-time updates via SSE
const pendingWhere = new Map();
let whereQueue = [];
let whereTimer = null;

function enqueueWhereMatch(flow) {
  if (!flow || !flow.id) return;

  pendingWhere.set(flow.id, flow);
  whereQueue.push(flow.id);

  if (whereTimer) return;

  whereTimer = setTimeout(() => {
    const ids = Array.from(new Set(whereQueue));
    whereQueue = [];
    whereTimer = null;

    const where = effectiveWhere();
    if (!where) return;

    fetch("/api/flows/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ where, ids })
    })
      .then(r => r.json())
      .then(data => {
        const matches = (data && data.matches) || [];
        const matchSet = new Set(matches);

        for (const id of ids) {
          const f = pendingWhere.get(id);
          pendingWhere.delete(id);

          if (matchSet.has(id) && f) {
            applyIncomingFlow(f);
          }
        }
      })
      .catch(() => {});
  }, 120);
}

const es = new EventSource("/api/events");
es.onmessage = ev => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "flow" || !msg.data) return;

    if (historyState.offset > 0) {
      if (hasWhere()) {
        enqueueWhereMatch(msg.data);
      } else {
        historyState.pendingCount += 1;
        updateHistoryControls();
      }
      return;
    }

    if (!hasWhere()) {
      applyIncomingFlow(msg.data);
      return;
    }

    enqueueWhereMatch(msg.data);
  } catch {}
};


/* ─────────────────────────────────────────────────────────────────
   Resizable Columns
   ───────────────────────────────────────────────────────────────── */
(function initSortableHeaders() {
  const thead = document.querySelector(".history-table thead");
  if (!thead) return;

  thead.querySelectorAll("th[data-col]").forEach(th => {
    const col = th.getAttribute("data-col");
    if (!col || !isSortableCol(col)) return;

    th.classList.add("is-sortable");

    th.addEventListener("click", e => {
      if (e.target && e.target.classList && e.target.classList.contains("resize-handle")) {
        return;
      }

      cycleSort(col);
      historyState.pendingCount = 0;
      loadList({ resetOffset: true });
    });
  });
})();

(function initResizableColumns() {
  const table = $("history-table");
  if (!table) return;
  
  let activeHandle = null;
  let startX = 0;
  let startWidth = 0;
  let th = null;

  table.querySelectorAll(".resize-handle").forEach(handle => {
    handle.addEventListener("mousedown", e => {
      e.preventDefault();
      activeHandle = handle;
      th = handle.parentElement;
      startX = e.pageX;
      startWidth = th.offsetWidth;
      handle.classList.add("active");
      table.classList.add("resizing");
    });
  });

  document.addEventListener("mousemove", e => {
    if (!activeHandle) return;
    const diff = e.pageX - startX;
    const newWidth = Math.max(40, startWidth + diff);
    th.style.width = newWidth + "px";
  });

  document.addEventListener("mouseup", () => {
    if (activeHandle) {
      activeHandle.classList.remove("active");
      table.classList.remove("resizing");
      activeHandle = null;
      th = null;
    }
  });
})();
