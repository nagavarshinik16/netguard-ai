// NetGuard AI - web console (static, runs entirely in the visitor's browser).
import { CONFIG } from "./config.js";
import { currentUser, login, logout } from "./auth.js";
import { FaultModel, THRESHOLDS } from "./model.js";
import * as probe from "./probe.js";
import { DEVICES, INVENTORY, LINKS, generate, interfaces, uptime } from "./sim.js";

// ------------------------------------------------------------------ constants & state
const COND = ["Normal", "Congestion", "Link Failure", "CPU Overload"];
const COND_C = { Normal: "#22c55e", Congestion: "#f97316", "Link Failure": "#ef4444", "CPU Overload": "#a855f7" };
const STATUS_C = { OK: "#22c55e", WARNING: "#eab308", FAULT: "#ef4444", UP: "#22c55e", DOWN: "#ef4444", "ADMIN-DOWN": "#64748b" };
const SEV_C = { CRITICAL: "#ef4444", MAJOR: "#f97316", WARNING: "#eab308" };
const METRIC = { cpu: "CPU (%)", bandwidth: "Bandwidth utilisation (%)", packet_loss: "Packet loss (%)", latency: "Latency (ms)" };

const state = {
  model: null, minutes: 120, seed: 7, replay: false, step: 15, cache: {}, charts: [], pageTimers: [],
  viewer: { device: null, net: null, probes: [], cpu: null, history: [], baseline: null, ai: null, speed: null, speedRunning: false },
  alarmFilter: { sev: new Set(["CRITICAL", "MAJOR", "WARNING"]), dev: new Set(Object.keys(DEVICES)), cond: new Set(COND) },
  perfDevice: "R1-Core", invDevice: "R2-Edge", verify: null,
};
const $ = (sel, el = document) => el.querySelector(sel);
const root = () => document.getElementById("root");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dateTime = (ts) => new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// ------------------------------------------------------------------ UI helpers
const badge = (t, c) => `<span class="badge" style="--c:${c || STATUS_C[t] || SEV_C[t] || "#64748b"}">${esc(t)}</span>`;
const kpi = (label, value, sub = "", c = "#38bdf8") =>
  `<div class="kpi" style="--c:${c}"><div class="label">${label}</div><div class="value" title="${esc(value)}">${value}</div><div class="sub">${sub}</div></div>`;
const rows = (obj) => `<div class="rows">${Object.entries(obj).map(([k, v]) => `<div class="row"><span>${k}</span><span>${v ?? "–"}</span></div>`).join("")}</div>`;
const card = (title, body, extra = "") => `<div class="card" ${extra}><h3>${title}</h3>${body}</div>`;
const bar = (pct, c = "#38bdf8") => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${c}"></i></div>`;
const head = (title, sub, meta = "") => `<div class="page-head"><div><h1>${title}</h1><div class="sub">${sub}</div></div><div class="meta">${meta}</div></div>`;

function chart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el || !window.Chart) return null;
  const c = new Chart(el, config);
  state.charts.push(c);
  return c;
}
function clearPage() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  state.pageTimers.forEach(clearInterval);
  state.pageTimers = [];
}
function setChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.color = "#94a3b8";
  Chart.defaults.borderColor = "#1e293b";
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.animation = false;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
}

// ------------------------------------------------------------------ simulated network data
function dataset() {
  const key = `${state.minutes}:${state.seed}`;
  if (!state.cache[key]) {
    const rows = generate(state.minutes, state.seed);
    rows.forEach((r) => { r.ai = state.model.predict(r); });
    state.cache = { [key]: rows };
  }
  return state.cache[key];
}
function view() {
  const all = dataset();
  const ts = [...new Set(all.map((r) => r.ts))];
  let n = ts.length;
  if (state.replay) { if (state.step > ts.length) state.step = 15; n = state.step; }
  const cut = ts[n - 1];
  const rows = all.filter((r) => r.ts <= cut);
  const latest = rows.filter((r) => r.ts === cut);
  return { rows, latest, n, now: cut };
}
const clock = (now) => `${state.replay ? '<span class="live-dot"></span>LIVE REPLAY' : '<span class="live-dot"></span>LIVE'} · ${dateTime(now)}<br>Polling interval 60 s · SNMP v2c/v3`;

// ------------------------------------------------------------------ viewer monitoring (runs all session)
let viewerStarted = false;
async function startViewerMonitoring() {
  if (viewerStarted) return;
  viewerStarted = true;
  const v = state.viewer;
  probe.deviceInfo().then((d) => { v.device = d; refreshLive(); });
  probe.networkIdentity().then((n) => { v.net = n; refreshLive(); });
  probe.cpuMonitor((c) => { v.cpu = c; });
  const cycle = async () => {
    if (document.hidden || v.speedRunning) return; // a speed test saturates the link on purpose - don't measure it as congestion
    const results = await probe.probeAll(3);
    v.probes = results;
    const ok = results.filter((r) => r.latency != null);
    const best = ok.length ? ok.reduce((a, b) => (b.latency < a.latency ? b : a)) : null; // best path = closest server
    const latency = best?.latency ?? null;
    const jitter = best?.jitter ?? null;
    const loss = results.reduce((s, r) => s + r.loss, 0) / results.length;
    if (latency != null) {
      v.recent = [...(v.recent || []), latency].slice(-10);
      v.baseline = Math.min(...v.recent); // rolling best-case RTT = path latency without queueing
    }
    const sample = probe.toModelSample({ cpu: v.cpu?.value, latency, loss, baseline: v.baseline });
    v.ai = state.model.predict(sample, { useAnomaly: false });
    v.sample = sample;
    v.history.push({ ts: Date.now(), latency, loss, jitter, cpu: sample.cpu, status: v.ai.status });
    if (v.history.length > 60) v.history.shift();
    refreshLive();
  };
  await cycle();
  setInterval(cycle, 6000);
}
function refreshLive() {
  const route = location.hash.slice(2) || "overview";
  if (route === "my-network") updateMyNetwork();
  const banner = document.getElementById("viewer-banner");
  if (banner) banner.innerHTML = viewerBannerHtml();
  const topo = document.getElementById("topo");
  if (topo) topo.innerHTML = topologySvg(view().latest);
  const side = document.getElementById("side-viewer");
  if (side) side.innerHTML = sideViewerHtml();
}

// ------------------------------------------------------------------ shell
const NAV = [
  ["Monitoring", [["overview", "🏠", "Overview"], ["inventory", "🗄️", "Device Inventory"], ["performance", "📈", "Performance"], ["alarms", "🚨", "Alarms & Events"]]],
  ["Your connection", [["my-network", "📡", "My System & Network", "LIVE"]]],
  ["Intelligence", [["ai", "🧠", "AI Engine"]]],
  ["System", [["about", "ℹ️", "About"]]],
];
function sideViewerHtml() {
  const v = state.viewer;
  if (!v.ai) return `<span class="dim">Measuring your connection…</span>`;
  const loc = [v.net?.city, v.net?.countryCode].filter(Boolean).join(", ");
  return `<div style="display:flex;justify-content:space-between;align-items:center"><b class="name">Your connection</b>${badge(v.ai.status)}</div>
    <div class="dim" style="margin-top:4px">${esc(v.device?.os || "")} · ${esc(v.device?.browser || "")}${loc ? " · " + esc(loc) : ""}</div>`;
}
function shell(user) {
  root().innerHTML = `
  <div class="mobile-bar"><button class="btn ghost" id="menu-btn">☰</button><div class="brand">🛡️ NetGuard <span>AI</span></div><span></span></div>
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand">🛡️ NetGuard <span>AI</span></div>
      <div class="brand-sub">${esc(CONFIG.tagline)}</div>
      <nav class="nav">${NAV.map(([g, items]) => `<div class="nav-group">${g}</div>` + items.map(([id, ico, label, tag]) =>
        `<a href="#/${id}" data-route="${id}"><span class="ico">${ico}</span>${label}${tag ? `<span class="tag">${tag}</span>` : ""}</a>`).join("")).join("")}</nav>
      <div class="side-box" id="side-viewer">${sideViewerHtml()}</div>
      <div class="side-box">
        <label class="switch"><input type="checkbox" id="replay" ${state.replay ? "checked" : ""}><span class="t"></span>Live replay (simulated)</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
          <div><label>History</label><select id="minutes">${[60, 120, 180, 240].map((m) => `<option ${m === state.minutes ? "selected" : ""} value="${m}">${m} min</option>`).join("")}</select></div>
          <div><label>Scenario</label><input type="number" id="seed" value="${state.seed}" min="1"></div>
        </div>
        <div class="dim" id="replay-info" style="margin-top:8px;font-size:.75rem"></div>
      </div>
      <div class="side-box"><div class="name">👤 ${esc(user.name)}</div><div class="dim">${esc(user.role)}</div>
        <button class="btn ghost block" id="logout" style="margin-top:10px">Sign out</button></div>
      <div class="side-foot">${esc(CONFIG.appName)} · ${esc(CONFIG.authorRole)}<br>by ${esc(CONFIG.author)}</div>
    </aside>
    <main id="page"></main>
  </div>`;
  $("#logout").onclick = () => { logout(); location.hash = "#/login"; route(); };
  $("#menu-btn").onclick = () => $("#sidebar").classList.toggle("open");
  $("#replay").onchange = (e) => { state.replay = e.target.checked; state.step = 15; renderPage(); };
  $("#minutes").onchange = (e) => { state.minutes = +e.target.value; state.step = 15; renderPage(); };
  $("#seed").onchange = (e) => { state.seed = Math.max(1, +e.target.value || 1); state.step = 15; renderPage(); };
}

// ------------------------------------------------------------------ login page
function renderLogin() {
  clearPage();
  root().innerHTML = `
  <div class="login"><div class="login-card">
    <div class="login-hero"><div class="logo">🛡️</div><h1>NetGuard <span>AI</span></h1><p>${esc(CONFIG.tagline)}</p></div>
    <form id="login-form" autocomplete="off">
      <h3>Sign in to the console</h3>
      <div class="field"><label for="u">Username</label><input type="text" id="u" placeholder="Enter username" autofocus></div>
      <div class="field"><label for="p">Password</label><input type="password" id="p" placeholder="Enter password"></div>
      <button class="btn block" type="submit" id="login-btn">Sign in</button>
      <div class="err" id="err"></div>
      ${CONFIG.showDemoCredentials ? `<div class="demo">Demo access: <code>admin</code> / <code>adminnms</code></div>` : ""}
    </form>
    <div class="login-foot">Authorised personnel only · Sessions are logged<br>${esc(CONFIG.authorRole)} · ${esc(CONFIG.author)}</div>
  </div></div>`;
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#login-btn");
    btn.disabled = true;
    const r = await login($("#u").value, $("#p").value);
    btn.disabled = false;
    if (r.ok) { location.hash = "#/overview"; route(); } else $("#err").textContent = r.error;
  };
}

// ------------------------------------------------------------------ overview
function viewerBannerHtml() {
  const v = state.viewer, d = v.device, n = v.net;
  if (!d && !n) return `<span class="live-dot"></span><span class="grow">Detecting your device and connection…</span>`;
  const loc = [n?.city, n?.country].filter(Boolean).join(", ");
  return `<span style="font-size:1.4rem">${esc(n?.flag || "🌐")}</span>
    <div class="grow">You are connected${loc ? ` from <b>${esc(loc)}</b>` : ""}${n?.isp ? ` via <b>${esc(n.isp)}</b>` : ""}
      · <b>${esc(d?.os || "")} ${esc(d?.osVersion || "")}</b> · ${esc(d?.browser || "")} ${esc(d?.browserVersion || "")}
      ${v.history.length ? ` · latency <b>${fmt(v.history.at(-1).latency, 0)} ms</b>` : ""}</div>
    ${v.ai ? `<span>Your connection: ${badge(v.ai.status)}</span>` : ""}
    <a class="btn ghost" href="#/my-network">Diagnose my network →</a>`;
}

function topologySvg(latest) {
  const st = Object.fromEntries(latest.map((r) => [r.device, r]));
  const pos = { Internet: [80, 170], "R2-Edge": [250, 170], "R1-Core": [420, 170], "SW2-Dist": [590, 170],
    "SW1-Access": [790, 60], "SRV1-Web": [790, 170], "SRV2-DB": [790, 280] };
  const you = [80, 300];
  const v = state.viewer;
  const color = (d) => (st[d] ? STATUS_C[st[d].ai.status] : "#3b82f6");
  const links = LINKS.map(([a, b]) => {
    const bad = st[b]?.ai.status === "FAULT" && st[b]?.ai.predicted === "Link Failure";
    const [x1, y1] = pos[a], [x2, y2] = pos[b];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${bad ? "#ef4444" : "#475569"}" stroke-width="${bad ? 3 : 2}" ${bad ? 'stroke-dasharray="7 6"' : ""}/>
      ${bad ? "" : `<line class="flow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#38bdf8" stroke-width="2" stroke-dasharray="3 22"><animate attributeName="stroke-dashoffset" from="25" to="0" dur="1.2s" repeatCount="indefinite"/></line>`}`;
  }).join("");
  const node = (d) => {
    const [x, y] = pos[d], c = color(d), kind = DEVICES[d];
    const shape = d === "Internet" ? `<circle cx="${x}" cy="${y}" r="34" fill="#3b82f6"/>`
      : kind === "router" ? `<ellipse cx="${x}" cy="${y}" rx="62" ry="32" fill="${c}"/>`
      : `<rect x="${x - 58}" y="${y - 28}" width="116" height="56" rx="${kind === "switch" ? 10 : 4}" fill="${c}"/>`;
    const sub = d === "Internet" ? "" : `<text x="${x}" y="${y + 6}" class="t2">${INVENTORY[d].ip}</text><text x="${x}" y="${y + 19}" class="t2">${st[d]?.ai.predicted || ""}</text>`;
    return `<g>${shape}<text x="${x}" y="${d === "Internet" ? y + 4 : y - 8}" class="t1">${d}</text>${sub}</g>`;
  };
  const youLabel = v.device ? `${esc(v.device.os)} · ${esc(v.device.browser)}` : "detecting…";
  const youColor = v.ai ? STATUS_C[v.ai.status] : "#38bdf8";
  return `<svg viewBox="0 0 880 340" role="img" aria-label="Network topology">
    <style>.t1{font:600 12px Inter,sans-serif;fill:#fff;text-anchor:middle}.t2{font:10px Inter,sans-serif;fill:#f1f5f9;text-anchor:middle;opacity:.92}</style>
    ${links}
    <line x1="${pos.Internet[0]}" y1="${pos.Internet[1]}" x2="${you[0]}" y2="${you[1]}" stroke="${youColor}" stroke-width="2" stroke-dasharray="4 4"/>
    ${Object.keys(pos).map(node).join("")}
    <g><rect x="${you[0] - 70}" y="${you[1] - 22}" width="140" height="44" rx="10" fill="#0f172a" stroke="${youColor}" stroke-width="2"/>
      <text x="${you[0]}" y="${you[1] - 4}" class="t1">YOU (viewer)</text><text x="${you[0]}" y="${you[1] + 11}" class="t2">${youLabel}</text></g>
  </svg>`;
}

function timelineHtml(rows) {
  const devs = Object.keys(DEVICES);
  return `<div class="timeline">${devs.map((d) => {
    const cells = rows.filter((r) => r.device === d).map((r) => `<i style="background:${COND_C[r.ai.predicted]}" title="${time(r.ts)} · ${r.ai.predicted} (p=${fmt(r.ai.faultProbability, 2)})"></i>`).join("");
    return `<span class="dim">${d}</span><div class="cells">${cells}</div>`;
  }).join("")}</div>
  <div class="legend">${COND.map((c) => `<span><i style="background:${COND_C[c]}"></i>${c}</span>`).join("")}</div>`;
}

function renderOverview(el) {
  const { rows, latest, n, now } = view();
  const count = (s) => latest.filter((r) => r.ai.status === s).length;
  const avgLat = latest.reduce((s, r) => s + r.latency, 0) / latest.length;
  el.innerHTML = head("Network Overview", "Real-time health of the managed enterprise network", clock(now)) + `
    <div class="viewer-banner" id="viewer-banner">${viewerBannerHtml()}</div>
    <div class="grid g6">
      ${kpi("Managed devices", Object.keys(DEVICES).length, "2 routers · 2 switches · 2 servers")}
      ${kpi("Healthy", count("OK"), "operating normally", "#22c55e")}
      ${kpi("Warnings", count("WARNING"), "potential faults", "#eab308")}
      ${kpi("Active faults", count("FAULT"), "need attention", "#ef4444")}
      ${kpi("Avg latency", `${fmt(avgLat, 0)} ms`, "across all devices", "#a855f7")}
      ${kpi("Alerts", rows.filter((r) => r.ai.status !== "OK").length, `last ${n} minutes`, "#f97316")}
    </div>
    <div class="split" style="margin-top:18px">
      <div class="card topo"><h3>Network topology</h3><div class="dim" style="font-size:.8rem;margin:-4px 0 6px">Node colour = current AI status · dashed red link = predicted link failure · YOU = the device viewing this page</div><div id="topo">${topologySvg(latest)}</div></div>
      <div><div class="grid g2">${latest.map((r) => {
        const c = STATUS_C[r.ai.status];
        return `<div class="card dev-card" style="--c:${c}"><div class="top"><b>${r.device}</b>${badge(r.ai.status)}</div>
          <div class="ip">${INVENTORY[r.device].ip} · ${r.ai.predicted}</div>
          <div class="m"><span>CPU ${fmt(r.cpu, 0)}%</span><span>BW ${fmt(r.bandwidth, 0)}%</span><span>Loss ${fmt(r.packet_loss, 2)}%</span><span>Lat ${fmt(r.latency, 0)} ms</span></div></div>`;
      }).join("")}</div></div>
    </div>
    <h2>AI-predicted condition timeline</h2><div class="card">${timelineHtml(rows)}</div>`;
}

// ------------------------------------------------------------------ inventory
function renderInventory(el) {
  const { latest, n, now } = view();
  const st = Object.fromEntries(latest.map((r) => [r.device, r]));
  const dev = state.invDevice, info = INVENTORY[dev], s = st[dev];
  el.innerHTML = head("Device Inventory", "Discovered network elements, interfaces and live state", clock(now)) + `
    <div class="table-wrap"><table><thead><tr><th>Hostname</th><th>Mgmt IP</th><th>MAC</th><th>Vendor</th><th>Model</th><th>OS / Firmware</th><th>Role</th><th>Location</th><th>Uptime</th><th>Status</th></tr></thead>
    <tbody>${Object.entries(INVENTORY).map(([d, i]) => `<tr style="cursor:pointer" data-dev="${d}"><td><b>${d}</b></td><td class="mono">${i.ip}</td><td class="mono">${i.mac}</td><td>${i.vendor}</td><td>${i.model}</td><td>${i.os}</td><td>${i.role}</td><td>${i.location}</td><td>${uptime(d, n)}</td><td>${badge(st[d].ai.status)}</td></tr>`).join("")}</tbody></table></div>
    <h2>Device details</h2>
    <select id="inv-dev" style="max-width:320px;margin-bottom:14px">${Object.keys(INVENTORY).map((d) => `<option ${d === dev ? "selected" : ""}>${d}</option>`).join("")}</select>
    <div class="grid g3">
      ${card("🖥️ System", rows({ Hostname: dev, Role: info.role, "Mgmt IP": `<span class="mono">${info.ip}</span>`, "MAC address": `<span class="mono">${info.mac}</span>`, Location: info.location, Uptime: uptime(dev, n) }))}
      ${card("🔧 Hardware & software", rows({ Vendor: info.vendor, Model: info.model, "OS / Firmware": info.os, "Serial no.": `<span class="mono">${info.serial}</span>`, SNMP: info.snmp, Interfaces: info.interfaces.length }))}
      ${card("📊 Live status", rows({ "AI status": badge(s.ai.status), "Predicted condition": s.ai.predicted, "Fault probability": fmt(s.ai.faultProbability, 2), CPU: `${fmt(s.cpu)} %`, "Packet loss": `${fmt(s.packet_loss, 2)} %`, Latency: `${fmt(s.latency)} ms` }))}
    </div>
    <h2>Interfaces</h2>
    <div class="table-wrap"><table><thead><tr><th>Interface</th><th>Address / VLAN</th><th>Description</th><th>Speed</th><th>Oper status</th><th>Utilisation</th><th>In (Mbps)</th><th>Out (Mbps)</th><th>Errors/min</th></tr></thead>
    <tbody>${interfaces(dev, s).map((i) => `<tr><td class="mono">${i.name}</td><td class="mono">${i.addr}</td><td>${i.desc}</td><td>${i.speed}</td><td>${badge(i.oper)}</td><td><div style="display:flex;gap:8px;align-items:center">${bar(i.util, i.util > 85 ? "#ef4444" : "#38bdf8")}<span>${i.util}%</span></div></td><td>${i.inMbps}</td><td>${i.outMbps}</td><td>${i.errors}</td></tr>`).join("")}</tbody></table></div>
    ${s.ai.recommendation ? `<div class="alert warn"><b>${s.ai.severity}</b> — ${s.ai.recommendation}</div>` : ""}`;
  $("#inv-dev").onchange = (e) => { state.invDevice = e.target.value; renderPage(); };
  el.querySelectorAll("tr[data-dev]").forEach((tr) => { tr.onclick = () => { state.invDevice = tr.dataset.dev; renderPage(); }; });
}

// ------------------------------------------------------------------ performance
function lineConfig(rows, metric) {
  return {
    type: "line",
    data: { labels: rows.map((r) => time(r.ts)), datasets: [
      { label: METRIC[metric], data: rows.map((r) => r[metric]), borderColor: "#64748b", borderWidth: 1.3, tension: .25,
        pointRadius: 2.6, pointBackgroundColor: rows.map((r) => COND_C[r.ai.predicted]), pointBorderWidth: 0 },
      { label: `Threshold ${THRESHOLDS[metric]}`, data: rows.map(() => THRESHOLDS[metric]), borderColor: "#ef4444", borderDash: [6, 4], borderWidth: 1.2, pointRadius: 0 },
    ] },
    options: { plugins: { legend: { display: false }, title: { display: true, text: `${METRIC[metric]} — threshold ${THRESHOLDS[metric]}`, align: "start", color: "#e2e8f0" },
      tooltip: { callbacks: { afterLabel: (ctx) => ctx.datasetIndex === 0 ? `AI: ${rows[ctx.dataIndex].ai.predicted}` : "" } } },
      scales: { x: { ticks: { maxTicksLimit: 8 } } } },
  };
}
function renderPerformance(el) {
  const { rows, latest, now } = view();
  const d = rows.filter((r) => r.device === state.perfDevice);
  el.innerHTML = head("Performance Monitoring", "CPU, bandwidth, packet loss and latency trends with AI predictions", clock(now)) + `
    <select id="perf-dev" style="max-width:320px;margin-bottom:14px">${Object.keys(DEVICES).map((x) => `<option ${x === state.perfDevice ? "selected" : ""}>${x}</option>`).join("")}</select>
    <div class="legend" style="margin:0 0 12px">${COND.map((c) => `<span><i style="background:${COND_C[c]}"></i>${c}</span>`).join("")}<span><i style="background:#ef4444;height:2px"></i>Threshold</span></div>
    <div class="grid g2">${Object.keys(METRIC).map((m) => `<div class="card"><div class="chart-box"><canvas id="c-${m}"></canvas></div></div>`).join("")}</div>
    <h2>Current comparison across devices</h2>
    <div class="grid g4">${Object.keys(METRIC).map((m) => `<div class="card"><div class="chart-box sm"><canvas id="b-${m}"></canvas></div></div>`).join("")}</div>`;
  $("#perf-dev").onchange = (e) => { state.perfDevice = e.target.value; renderPage(); };
  Object.keys(METRIC).forEach((m) => {
    chart(`c-${m}`, lineConfig(d, m));
    chart(`b-${m}`, { type: "bar", data: { labels: latest.map((r) => r.device), datasets: [{ data: latest.map((r) => r[m]),
      backgroundColor: latest.map((r) => STATUS_C[r.ai.status]), borderRadius: 4 }] },
      options: { indexAxis: "y", scales: { y: { ticks: { autoSkip: false } } },
        plugins: { legend: { display: false }, title: { display: true, text: METRIC[m], align: "start", color: "#e2e8f0" } } } });
  });
}

// ------------------------------------------------------------------ alarms
function renderAlarms(el) {
  const { rows, now } = view();
  const f = state.alarmFilter;
  const alarms = rows.filter((r) => r.ai.status !== "OK" && f.sev.has(r.ai.severity) && f.dev.has(r.device) && f.cond.has(r.ai.predicted))
    .sort((a, b) => b.ts - a.ts);
  const chips = (set, values, key) => values.map((v) => `<button class="chip ${set.has(v) ? "on" : ""}" data-k="${key}" data-v="${v}">${v}</button>`).join("");
  const by = (s) => alarms.filter((a) => a.ai.severity === s).length;
  el.innerHTML = head("Alarms & Events", "AI-generated fault warnings with severity, probable cause and remediation", clock(now)) + `
    <div class="filters"><span class="dim" style="align-self:center;width:80px">Severity</span>${chips(f.sev, ["CRITICAL", "MAJOR", "WARNING"], "sev")}</div>
    <div class="filters"><span class="dim" style="align-self:center;width:80px">Device</span>${chips(f.dev, Object.keys(DEVICES), "dev")}</div>
    <div class="filters"><span class="dim" style="align-self:center;width:80px">Condition</span>${chips(f.cond, COND, "cond")}</div>
    <div class="grid g4">${kpi("Total alarms", alarms.length, "matching filters", "#f97316")}${kpi("Critical", by("CRITICAL"), "link failures", "#ef4444")}${kpi("Major", by("MAJOR"), "congestion / CPU", "#f97316")}${kpi("Warnings", by("WARNING"), "early indicators", "#eab308")}</div>
    <div class="card" style="margin-top:16px"><div class="chart-box" style="height:260px"><canvas id="alarm-bar"></canvas></div></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:18px 0 10px"><h2 style="margin:0">Event log</h2><button class="btn ghost" id="export">⬇ Export CSV</button></div>
    <div class="table-wrap scroll-y"><table><thead><tr><th>Time</th><th>Device</th><th>IP</th><th>Status</th><th>Severity</th><th>Condition</th><th>Fault prob.</th><th>Breaches</th><th>Recommended action</th></tr></thead>
    <tbody>${alarms.slice(0, 300).map((a) => `<tr><td>${dateTime(a.ts)}</td><td><b>${a.device}</b></td><td class="mono">${INVENTORY[a.device].ip}</td><td>${badge(a.ai.status)}</td><td>${badge(a.ai.severity)}</td><td><span style="color:${COND_C[a.ai.predicted]}">●</span> ${a.ai.predicted}</td><td><div style="display:flex;gap:8px;align-items:center">${bar(a.ai.faultProbability * 100)}<span>${fmt(a.ai.faultProbability, 2)}</span></div></td><td class="dim">${a.ai.breaches.join(", ")}</td><td>${a.ai.recommendation}</td></tr>`).join("") || `<tr><td colspan="9" class="dim">No alarms match the filters.</td></tr>`}</tbody></table></div>`;
  el.querySelectorAll(".chip").forEach((c) => { c.onclick = () => { const s = f[c.dataset.k]; s.has(c.dataset.v) ? s.delete(c.dataset.v) : s.add(c.dataset.v); renderPage(); }; });
  $("#export").onclick = () => {
    const lines = [["time", "device", "ip", "status", "severity", "condition", "fault_probability", "breaches", "recommendation"].join(",")]
      .concat(alarms.map((a) => [new Date(a.ts).toISOString(), a.device, INVENTORY[a.device].ip, a.ai.status, a.ai.severity, a.ai.predicted, a.ai.faultProbability.toFixed(3), `"${a.ai.breaches.join(" ")}"`, `"${a.ai.recommendation}"`].join(",")));
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: "netguard_alarms.csv" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const devs = Object.keys(DEVICES);
  chart("alarm-bar", { type: "bar", data: { labels: devs, datasets: COND.map((c) => ({ label: c, backgroundColor: COND_C[c], borderRadius: 3,
    data: devs.map((d) => alarms.filter((a) => a.device === d && a.ai.predicted === c).length) })) },
    options: { indexAxis: "y", scales: { x: { stacked: true }, y: { stacked: true, ticks: { autoSkip: false } } },
      plugins: { title: { display: true, text: "Alarms by device and condition", align: "start", color: "#e2e8f0" } } } });
}

// ------------------------------------------------------------------ my system & network (viewer)
function renderMyNetwork(el) {
  el.innerHTML = head("My System & Network", "Live diagnostics of <b>your own</b> device and internet connection — measured in your browser, nothing is stored",
    '<span class="live-dot"></span>LIVE · refreshes every 6 s') + `
    <div id="mn-ai"></div>
    <div class="grid g6" id="mn-kpis" style="margin-top:14px"></div>
    <div class="grid g2" style="margin-top:16px"><div id="mn-device"></div><div id="mn-net"></div></div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><div class="chart-box sm"><canvas id="mn-lat"></canvas></div></div>
      <div class="card"><div class="chart-box sm"><canvas id="mn-loss"></canvas></div></div>
    </div>
    <div class="grid g2" style="margin-top:16px"><div id="mn-probes"></div><div id="mn-speed"></div></div>
    <div class="alert info"><b>Privacy & limits.</b> All measurements run in your browser. Your public IP is looked up via ipwho.is / Cloudflare to show ISP and city; nothing is saved by this site.
      Browsers do not allow websites to read your MAC address, Wi-Fi neighbours or exact CPU %, so CPU is an estimate and LAN discovery is available only in the desktop edition (Python) of this project.</div>`;
  const mk = (id, label, color, max) => chart(id, { type: "line", data: { labels: [], datasets: [{ label, data: [], borderColor: color,
    backgroundColor: color + "22", fill: true, tension: .3, pointRadius: 2 }] },
    options: { plugins: { legend: { display: false }, title: { display: true, text: label, align: "start", color: "#e2e8f0" } },
      scales: { y: { beginAtZero: true, suggestedMax: max } } } });
  state.mnCharts = { lat: mk("mn-lat", "Latency to nearest server (ms)", "#22c55e", 60), loss: mk("mn-loss", "Packet loss (%)", "#ef4444", 5) };
  updateMyNetwork();
}

function updateMyNetwork() {
  const v = state.viewer, d = v.device, n = v.net, last = v.history.at(-1);
  const set = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
  if (!document.getElementById("mn-ai")) return;
  if (v.ai) {
    const c = STATUS_C[v.ai.status];
    set("mn-ai", `<div class="card" style="border-left:4px solid ${c}"><h3>🧠 AI assessment of your connection ${badge(v.ai.status)}</h3>
      <div>Predicted condition <b>${v.ai.predicted}</b> · fault probability <b>${fmt(v.ai.faultProbability, 2)}</b> ·
      ${v.ai.recommendation || "All metrics within normal operating range."}</div>
      <div class="dim" style="font-size:.8rem;margin-top:6px">Model input → CPU ${fmt(v.sample.cpu, 0)}% · est. link utilisation ${fmt(v.sample.bandwidth, 0)}% · loss ${fmt(v.sample.packet_loss, 1)}% · normalised latency ${fmt(v.sample.latency, 0)} ms
      (your ${fmt(v.history.at(-1)?.latency, 0)} ms RTT = ${fmt(v.baseline, 0)} ms distance baseline + ${fmt(Math.max(0, (v.history.at(-1)?.latency ?? 0) - v.baseline), 0)} ms queueing)</div></div>`);
  } else set("mn-ai", `<div class="card"><span class="live-dot"></span>Running first measurements…</div>`);

  set("mn-kpis", [
    kpi("Latency", last ? `${fmt(last.latency, 0)} ms` : "…", "nearest server", "#22c55e"),
    kpi("Jitter", last ? `${fmt(last.jitter, 1)} ms` : "…", "latency variation", "#38bdf8"),
    kpi("Packet loss", last ? `${fmt(last.loss, 1)}%` : "…", "probe failures", last?.loss ? "#ef4444" : "#22c55e"),
    kpi("Download", v.speed ? `${fmt(v.speed.download, 1)}` : "–", "Mbps", "#a855f7"),
    kpi("Upload", v.speed ? `${fmt(v.speed.upload, 1)}` : "–", "Mbps", "#f97316"),
    kpi("CPU load", v.cpu ? `${fmt(v.cpu.value, 0)}%` : "…", v.cpu ? esc(v.cpu.method) : "estimating", "#eab308"),
  ].join(""));

  if (d) set("mn-device", card("💻 Your device", rows({
    "Operating system": `${esc(d.os)} ${esc(d.osVersion)}`, Browser: `${esc(d.browser)} ${esc(d.browserVersion)}`,
    "Device type": esc(d.deviceType) + (d.model ? ` (${esc(d.model)})` : ""), "CPU cores": d.cores ?? "hidden by browser",
    Memory: d.memoryGB ? `≥ ${d.memoryGB} GB` : "hidden by browser", Architecture: esc(d.arch || "–"), GPU: esc(d.gpu),
    Screen: `${d.screen} @${d.dpr}x`, Battery: d.battery ? `${d.battery.level}% ${d.battery.charging ? "⚡ charging" : "on battery"}` : "–",
    "Time zone": esc(d.timezone), Language: esc(d.language),
  })));
  if (n) set("mn-net", card("🌐 Your network", rows({
    "Public IP": `<span class="mono">${esc(n.ip || "–")}</span>`, ISP: esc(n.isp || "–"), ASN: esc(n.asn || "–"),
    Location: `${esc(n.flag || "")} ${esc([n.city, n.region, n.country].filter(Boolean).join(", ") || "–")}`,
    "Connection type": esc(n.connType || "not exposed by browser"), "Effective type": esc(n.effectiveType ? n.effectiveType.toUpperCase() : "–"),
    "Browser speed hint": n.downlinkHint != null ? `${n.downlinkHint} Mbps · ${n.rttHint} ms RTT` : "–",
    "Nearest Cloudflare edge": esc(n.edge || "–"), "Online": navigator.onLine ? "Yes" : "No",
  })));

  set("mn-probes", card("📶 Reachability probes", `<div class="table-wrap"><table><thead><tr><th>Target</th><th>Latency</th><th>Jitter</th><th>Loss</th><th>Status</th></tr></thead>
    <tbody>${(v.probes || []).map((p) => `<tr><td>${p.name}</td><td>${p.latency != null ? fmt(p.latency, 0) + " ms" : "–"}</td><td>${fmt(p.jitter, 1)} ms</td><td>${fmt(p.loss, 0)}%</td><td>${badge(p.loss < 100 ? "UP" : "DOWN")}</td></tr>`).join("") || `<tr><td colspan="5" class="dim">Probing…</td></tr>`}</tbody></table></div>
    <div class="dim" style="font-size:.78rem;margin-top:8px">HTTP round-trip probes (browsers cannot send ICMP ping). Loss = probes that timed out.</div>`));

  const s = v.speed;
  set("mn-speed", card("🚀 Speed test", `${s ? rows({ Download: `<b>${fmt(s.download, 1)} Mbps</b>`, Upload: `<b>${fmt(s.upload, 1)} Mbps</b>`,
    "Idle latency": `${fmt(s.idleLatency, 0)} ms`, "Latency under load": `${fmt(s.loadedLatency, 0)} ms`,
    "Bufferbloat grade": `${badge(s.grade, /A/.test(s.grade) ? "#22c55e" : /B|C/.test(s.grade) ? "#eab308" : "#ef4444")} (+${fmt(Math.max(0, s.bufferbloat), 0)} ms under load)` })
    : `<div class="dim">Measures download/upload throughput against Cloudflare and how much your latency rises under load (bufferbloat = congestion).</div>`}
    <button class="btn" id="speed-btn" style="margin-top:12px" ${v.speedRunning ? "disabled" : ""}>${v.speedRunning ? esc(v.speedStage || "Running…") : s ? "Run again" : "Run speed test"}</button>
    <div class="dim" style="font-size:.75rem;margin-top:6px">Adapts to your speed; uses up to ~40 MB of data on fast links.</div>`));
  const btn = document.getElementById("speed-btn");
  if (btn) btn.onclick = runSpeedTest;

  const c = state.mnCharts;
  if (c?.lat && c.lat.canvas?.isConnected) {
    const labels = v.history.map((h) => new Date(h.ts).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }));
    c.lat.data.labels = labels; c.lat.data.datasets[0].data = v.history.map((h) => h.latency); c.lat.update();
    c.loss.data.labels = labels; c.loss.data.datasets[0].data = v.history.map((h) => h.loss); c.loss.update();
  }
}

async function runSpeedTest() {
  const v = state.viewer;
  if (v.speedRunning) return;
  v.speedRunning = true; updateMyNetwork();
  try {
    v.speed = await probe.speedTest((stage) => { v.speedStage = stage; updateMyNetwork(); });
  } catch { v.speedStage = "Speed test failed"; }
  v.speedRunning = false; updateMyNetwork();
}

// ------------------------------------------------------------------ AI engine
function verifyModel() {
  if (state.verify) return state.verify;
  const t = state.model.m.test;
  let agree = 0;
  t.X.forEach((row, i) => {
    const p = state.model.proba(row.map(Math.fround));
    if (p.indexOf(Math.max(...p)) === t.proba[i].indexOf(Math.max(...t.proba[i]))) agree++;
  });
  return (state.verify = { agree, total: t.X.length });
}
function renderAI(el) {
  const m = state.model.m, met = m.metrics, ver = verifyModel();
  el.innerHTML = head("AI Fault Prediction Engine", "Random Forest classifier + Isolation Forest anomaly detector, running in your browser",
    `Verified in your browser: <b style="color:#22c55e">${ver.agree}/${ver.total}</b> predictions identical to scikit-learn`) + `
    <div class="grid g4">${kpi("Test accuracy", `${met.accuracy}%`, `${met.test_size.toLocaleString()} held-out samples`, "#22c55e")}
      ${kpi("Fault detection", `${met.detection}%`, "faults correctly flagged", "#38bdf8")}${kpi("False alarms", `${met.false_alarm}%`, "normal flagged as fault", "#eab308")}
      ${kpi("Model", `${m.rf.length} trees`, `trained on ${met.train_size.toLocaleString()} samples`, "#a855f7")}</div>
    <h2>🔬 What-if fault simulator</h2>
    <div class="split"><div class="card">${[["cpu", "CPU utilisation (%)", 0, 100, 1, 40], ["bandwidth", "Bandwidth utilisation (%)", 0, 100, 1, 45],
      ["packet_loss", "Packet loss (%)", 0, 30, 0.1, 0.2], ["latency", "Latency (ms)", 1, 300, 1, 20]].map(([k, l, a, b, s, v]) =>
      `<div class="field"><label>${l}: <b id="v-${k}" style="color:#e2e8f0">${v}</b></label><input type="range" id="s-${k}" min="${a}" max="${b}" step="${s}" value="${v}"></div>`).join("")}
      <div class="filters" style="margin:4px 0 0">${[["Healthy", 40, 45, 0.2, 20], ["Congested link", 60, 92, 3, 95], ["Cable cut", 30, 10, 15, 170], ["DoS on router", 96, 50, 1, 55]]
        .map(([n, ...vals]) => `<button class="chip" data-preset="${vals.join(",")}">${n}</button>`).join("")}</div></div>
      <div class="card" id="whatif-out"></div></div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3>Confusion matrix (test set)</h3><div id="cm"></div></div>
      <div class="card"><div class="chart-box"><canvas id="imp"></canvas></div></div>
    </div>
    <h2>How the model works</h2>
    <div class="grid g3">${card("1 · Training data", "12,000 labelled minutes of telemetry from 6 simulated devices. Faults ramp up over 5 minutes, so the model learns to catch them <i>early</i>, not just at full failure.")}
      ${card("2 · Models", "Random Forest (150 trees, depth 12) classifies the condition; fault probability = 1 − P(Normal). Isolation Forest, trained only on normal traffic, flags unknown anomalies.")}
      ${card("3 · Alert rules", "FAULT if class ≠ Normal and P(fault) ≥ 0.6 · WARNING if P(fault) ≥ 0.3, anomaly, or static threshold breach · severity CRITICAL / MAJOR / WARNING with remediation advice.")}</div>`;
  const keys = ["cpu", "bandwidth", "packet_loss", "latency"];
  const update = () => {
    const s = Object.fromEntries(keys.map((k) => [k, +$(`#s-${k}`).value]));
    keys.forEach((k) => { $(`#v-${k}`).textContent = s[k]; });
    s.throughput = 1000 * s.bandwidth / 100 * (1 - s.packet_loss / 100);
    const r = state.model.predict(s);
    $("#whatif-out").innerHTML = `<h3>Prediction: ${r.predicted} ${badge(r.status)}</h3>
      <div class="muted" style="margin-bottom:12px">Fault probability <b style="color:#e2e8f0">${fmt(r.faultProbability, 2)}</b>${r.anomaly ? " · anomaly detected" : ""}<br>${r.recommendation || "No action required."}</div>
      ${COND.map((c) => `<div style="display:grid;grid-template-columns:110px 1fr 46px;gap:10px;align-items:center;margin:7px 0;font-size:.85rem"><span>${c}</span>${bar(r.probabilities[c] * 100, COND_C[c])}<span style="text-align:right">${fmt(r.probabilities[c] * 100, 0)}%</span></div>`).join("")}`;
  };
  keys.forEach((k) => { $(`#s-${k}`).oninput = update; });
  el.querySelectorAll("[data-preset]").forEach((b) => { b.onclick = () => { b.dataset.preset.split(",").forEach((v, i) => { $(`#s-${keys[i]}`).value = v; }); update(); }; });
  update();

  const order = COND.map((c) => m.classes.indexOf(c));
  const maxV = Math.max(...m.confusion.flat());
  $("#cm").innerHTML = `<div class="table-wrap" style="border:0"><table class="cm"><tr><th></th>${COND.map((c) => `<th>${c}</th>`).join("")}</tr>
    ${order.map((i, ri) => `<tr><th style="text-align:right">${COND[ri]}</th>${order.map((j) => { const v = m.confusion[i][j]; const a = 0.12 + 0.88 * Math.sqrt(v / maxV);
      return `<td style="background:rgba(56,189,248,${v ? a.toFixed(2) : 0.05})">${v}</td>`; }).join("")}</tr>`).join("")}</table></div>
    <div class="dim" style="font-size:.78rem">Rows = actual condition, columns = predicted.</div>`;
  const imp = Object.entries(m.importance).sort((a, b) => b[1] - a[1]);
  chart("imp", { type: "bar", data: { labels: imp.map((x) => x[0]), datasets: [{ data: imp.map((x) => x[1]), backgroundColor: "#38bdf8", borderRadius: 4 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, title: { display: true, text: "Feature importance", align: "start", color: "#e2e8f0" } } } });
}

// ------------------------------------------------------------------ about
function renderAbout(el) {
  const links = [CONFIG.repoUrl && `<a href="${esc(CONFIG.repoUrl)}" target="_blank" rel="noopener">Source code (GitHub)</a>`,
    CONFIG.linkedin && `<a href="${esc(CONFIG.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>`,
    CONFIG.email && `<a href="mailto:${esc(CONFIG.email)}">${esc(CONFIG.email)}</a>`].filter(Boolean).join(" · ");
  el.innerHTML = head("About NetGuard AI", "Architecture, how it adapts to each viewer, and technology") + `
    <div class="card"><img src="assets/architecture.png" alt="System architecture" style="width:100%;border-radius:10px;background:#fff"></div>
    <div class="grid g2" style="margin-top:16px">
      ${card("📘 Project", rows({ Title: "AI-Based Network Fault Prediction System", Product: esc(CONFIG.appName), Author: esc(CONFIG.author), Links: links || "–" }))}
      ${card("🧰 Technology", rows({ "ML training": "Python · scikit-learn · pandas", "In-browser inference": "JavaScript port of the trained forests (verified identical)",
        Frontend: "Vanilla JS modules · Chart.js · SVG topology", Hosting: "GitHub Pages (static, no server)", "Desktop edition": "Python Streamlit + psutil (LAN discovery, ICMP, ARP)" }))}
    </div>
    <h2>How it adapts to every viewer</h2>
    <div class="table-wrap"><table><thead><tr><th>What</th><th>How it is measured in your browser</th></tr></thead><tbody>
      ${[["Device, OS, browser, CPU cores, RAM, GPU, screen, battery", "User-Agent Client Hints, navigator APIs, WebGL, Battery API"],
        ["Public IP, ISP, ASN, city", "ipwho.is, with Cloudflare edge metadata as fallback"],
        ["Latency, jitter, loss", "Repeated timed HTTP probes to Cloudflare, Google, 1.1.1.1 and this site's CDN"],
        ["Download / upload / bufferbloat", "Timed transfers against Cloudflare's speed-test endpoints while measuring loaded latency"],
        ["CPU load", "Compute Pressure API, or event-loop lag estimate"],
        ["AI assessment", "Measurements mapped to the model's 5 features and classified by the same Random Forest"]]
        .map(([a, b]) => `<tr><td>${a}</td><td class="muted">${b}</td></tr>`).join("")}</tbody></table></div>`;
}

// ------------------------------------------------------------------ router
const PAGES = { overview: renderOverview, inventory: renderInventory, performance: renderPerformance, alarms: renderAlarms,
  "my-network": renderMyNetwork, ai: renderAI, about: renderAbout };
const SIM_PAGES = new Set(["overview", "inventory", "performance", "alarms"]);

function renderPage() {
  const id = location.hash.slice(2);
  const page = document.getElementById("page");
  if (!page) return;
  clearPage();
  const name = PAGES[id] ? id : "overview";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
  $("#sidebar")?.classList.remove("open");
  PAGES[name](page);
  document.title = `${document.querySelector(`.nav a[data-route="${name}"]`)?.textContent.replace(/LIVE$/, "").trim()} | NetGuard AI`;
}

function route() {
  const user = currentUser();
  if (!user) { if (location.hash !== "#/login") history.replaceState(null, "", "#/login"); renderLogin(); return; }
  if (location.hash === "#/login" || !location.hash) history.replaceState(null, "", "#/overview");
  if (!document.getElementById("page")) shell(user);
  startViewerMonitoring();
  renderPage();
  window.scrollTo(0, 0);
}

// live replay ticker (simulated network)
setInterval(() => {
  if (!state.replay || !currentUser()) return;
  state.step += 1;
  const info = document.getElementById("replay-info");
  if (info) info.textContent = `Streaming · minute ${state.step}`;
  const id = location.hash.slice(2);
  if (SIM_PAGES.has(id)) {
    const y = window.scrollY;
    renderPage();
    window.scrollTo(0, y);
  }
}, 2000);

window.addEventListener("hashchange", route);
(async function init() {
  try {
    state.model = await FaultModel.load();
  } catch (e) {
    root().innerHTML = `<div class="login"><div class="card">Could not load the AI model: ${esc(e.message)}</div></div>`;
    return;
  }
  if (!window.Chart) await new Promise((r) => window.addEventListener("load", r, { once: true }));
  setChartDefaults();
  route();
})();
