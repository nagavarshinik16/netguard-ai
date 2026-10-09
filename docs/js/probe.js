// Viewer-side telemetry: everything here is measured inside the visitor's own browser,
// so the dashboard adapts to whoever opens the link (their device, ISP, location, latency, speed).
// Nothing is sent to or stored by this site.

const CF = "https://speed.cloudflare.com";
const now = () => performance.now();
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function timed(url, { timeout = 2500, mode = "cors", method = "GET", body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = now();
  try {
    const res = await fetch(url, { mode, method, body, cache: "no-store", signal: ctl.signal, credentials: "omit" });
    if (mode === "cors") await res.arrayBuffer();
    return { ok: true, ms: now() - t0, res };
  } catch {
    return { ok: false, ms: null };
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------ device
function parseUA(ua) {
  const first = (rules) => {
    for (const [re, name, group = 1] of rules) {
      const m = re.exec(ua);
      if (m) return [name, (m[group] || "").replace(/_/g, ".")];
    }
    return ["Unknown", ""];
  };
  const [browser, bv] = first([
    [/Edg\/([\d.]+)/, "Microsoft Edge"], [/OPR\/([\d.]+)/, "Opera"], [/Firefox\/([\d.]+)/, "Firefox"],
    [/SamsungBrowser\/([\d.]+)/, "Samsung Internet"], [/Chrome\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ]);
  const [os, ov] = first([
    [/Windows NT 10/, "Windows", 9], [/Windows NT ([\d.]+)/, "Windows"], [/Android ([\d.]+)/, "Android"],
    [/(iPhone|iPad).*OS ([\d_]+)/, "iOS", 2], [/Mac OS X ([\d_]+)/, "macOS"], [/CrOS/, "ChromeOS", 9],
    [/Linux/, "Linux", 9],
  ]);
  // macOS UA version is frozen at 10.15.7 by browsers, so it is not reliable
  const osVersion = os === "Windows" && !ov ? "10/11" : os === "macOS" && ov === "10.15.7" ? "" : ov;
  return { browser, browserVersion: bv.split(".")[0], os, osVersion };
}

function gpuName() {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    let r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : "";
    const m = /ANGLE \((?:[^,]+), ([^,(]+?)(?: \(|,|\))/.exec(r);
    if (m) r = m[1];
    return (r || "Unavailable").replace(/Direct3D.*|vs_.*|\(0x[0-9a-f]+\)/gi, "").trim();
  } catch { return "Unavailable"; }
}

export async function deviceInfo() {
  const ua = navigator.userAgent;
  const info = parseUA(ua);
  const uad = navigator.userAgentData;
  if (uad?.getHighEntropyValues) {
    try {
      const h = await uad.getHighEntropyValues(["platformVersion", "architecture", "bitness", "model", "fullVersionList"]);
      if (h.platform === "Windows") {
        info.osVersion = parseInt(h.platformVersion) >= 13 ? "11" : "10";
      } else if (h.platformVersion && info.os !== "Unknown") info.osVersion = h.platformVersion;
      info.arch = [h.architecture, h.bitness && `${h.bitness}-bit`].filter(Boolean).join(" ");
      if (h.model) info.model = h.model;
      const brand = (h.fullVersionList || []).find((x) => /Edge|Opera|Brave|Chrome/.test(x.brand) && !/Chromium/.test(x.brand));
      if (brand) { info.browser = brand.brand.replace("Google ", ""); info.browserVersion = brand.version.split(".")[0]; }
    } catch { /* optional */ }
  }
  if (navigator.brave) info.browser = "Brave";
  const mobile = uad?.mobile ?? /Mobi|Android|iPhone/.test(ua);
  const tablet = /iPad|Tablet/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  let battery = null;
  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      battery = { level: Math.round(b.level * 100), charging: b.charging };
    }
  } catch { /* optional */ }
  return {
    ...info,
    deviceType: tablet ? "Tablet" : mobile ? "Mobile" : "Desktop / Laptop",
    cores: navigator.hardwareConcurrency || null,
    memoryGB: navigator.deviceMemory || null,
    screen: `${screen.width} × ${screen.height}`, dpr: window.devicePixelRatio || 1,
    viewport: `${innerWidth} × ${innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language, gpu: gpuName(), touch: navigator.maxTouchPoints > 0,
    online: navigator.onLine, battery,
  };
}

// ------------------------------------------------------------------ network identity
// Cloudflare data-centre codes (IATA airport codes) for common locations
const COLOS = { MAA: "Chennai", BOM: "Mumbai", DEL: "New Delhi", BLR: "Bengaluru", HYD: "Hyderabad", CCU: "Kolkata",
  COK: "Kochi", AMD: "Ahmedabad", NAG: "Nagpur", SIN: "Singapore", HKG: "Hong Kong", NRT: "Tokyo", SYD: "Sydney",
  DXB: "Dubai", FRA: "Frankfurt", LHR: "London", AMS: "Amsterdam", CDG: "Paris", IAD: "Ashburn", EWR: "Newark",
  ORD: "Chicago", DFW: "Dallas", SJC: "San Jose", LAX: "Los Angeles", SEA: "Seattle", YYZ: "Toronto", GRU: "Sao Paulo" };
export async function networkIdentity() {
  const c = navigator.connection || {};
  const out = {
    connType: c.type || null, effectiveType: c.effectiveType || null,
    downlinkHint: c.downlink ?? null, rttHint: c.rtt ?? null, saveData: !!c.saveData,
  };
  // Public IP / ISP / location: ipwho.is, falling back to Cloudflare edge metadata
  try {
    const r = await fetch("https://ipwho.is/?fields=ip,success,type,city,region,country,country_code,flag,connection,timezone,latitude,longitude",
      { cache: "no-store" });
    const j = await r.json();
    if (j.success !== false && j.ip) {
      Object.assign(out, {
        ip: j.ip, ipVersion: j.type, city: j.city, region: j.region, country: j.country,
        countryCode: j.country_code, flag: j.flag?.emoji, isp: j.connection?.isp || j.connection?.org,
        asn: j.connection?.asn ? `AS${j.connection.asn}` : null, tz: j.timezone?.id,
        lat: j.latitude, lon: j.longitude, source: "ipwho.is",
      });
    }
  } catch { /* fall through */ }
  try {
    const trace = await (await fetch(`${CF}/cdn-cgi/trace?r=${Math.random()}`, { cache: "no-store" })).text();
    const colo = /colo=(\w+)/.exec(trace)?.[1];
    if (colo) out.edge = COLOS[colo] ? `${COLOS[colo]} (${colo})` : colo;
  } catch { /* optional */ }
  try {
    const r = await fetch(`${CF}/__down?bytes=0&r=${Math.random()}`, { cache: "no-store" });
    const h = (k) => r.headers.get(`cf-meta-${k}`);
    if (!out.ip) {
      Object.assign(out, { ip: h("ip"), city: h("city"), country: h("country"), countryCode: h("country"),
        asn: h("asn") ? `AS${h("asn")}` : null, isp: h("asn") ? `AS${h("asn")}` : null,
        lat: +h("latitude"), lon: +h("longitude"), tz: h("timezone"), source: "Cloudflare" });
    }
  } catch { /* offline */ }
  return out;
}

// ------------------------------------------------------------------ latency / loss / jitter
export const TARGETS = [
  { name: "Cloudflare edge", url: () => `${CF}/__down?bytes=0&r=${Math.random()}`, mode: "cors" },
  { name: "Google", url: () => `https://www.google.com/generate_204?r=${Math.random()}`, mode: "no-cors" },
  { name: "Cloudflare DNS 1.1.1.1", url: () => `https://1.1.1.1/cdn-cgi/trace?r=${Math.random()}`, mode: "no-cors" },
  { name: "This website (CDN)", url: () => `ping.txt?r=${Math.random()}`, mode: "cors" },
];

const warmed = new Set();
/** HTTP round-trip probes to one target. Returns {latency, jitter, loss, samples}. */
export async function probeTarget(target, count = 4) {
  if (!warmed.has(target.name)) { await timed(target.url(), { mode: target.mode }); warmed.add(target.name); } // DNS + TLS warm-up
  const samples = [];
  let lost = 0;
  for (let i = 0; i < count; i++) {
    const r = await timed(target.url(), { mode: target.mode });
    if (r.ok) samples.push(r.ms); else lost++;
  }
  const jit = samples.length > 1 ? mean(samples.slice(1).map((v, i) => Math.abs(v - samples[i]))) : 0;
  return { name: target.name, latency: median(samples), jitter: jit, loss: (100 * lost) / count, samples };
}

export async function probeAll(count = 4) {
  return Promise.all(TARGETS.map((t) => probeTarget(t, count)));
}

// ------------------------------------------------------------------ throughput (speed test)
async function download(bytes) {
  const t0 = now();
  const res = await fetch(`${CF}/__down?bytes=${bytes}&r=${Math.random()}`, { cache: "no-store" });
  const reader = res.body.getReader();
  let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; }
  return (got * 8) / ((now() - t0) / 1000) / 1e6;
}

async function upload(bytes) {
  const body = new Uint8Array(bytes);
  const t0 = now();
  await fetch(`${CF}/__up?r=${Math.random()}`, { method: "POST", body, cache: "no-store" });
  return (bytes * 8) / ((now() - t0) / 1000) / 1e6;
}

/** Download/upload Mbps plus latency under load (bufferbloat). onProgress(stage) for UI. */
export async function speedTest(onProgress = () => {}) {
  onProgress("Measuring idle latency…");
  const idle = await probeTarget(TARGETS[0], 5);

  onProgress("Testing download speed…");
  let dl = await download(1e6);                        // small first: adapt size to the link
  const size = dl > 50 ? 25e6 : dl > 10 ? 10e6 : 3e6;
  const loaded = [];
  let loading = true;
  const pinger = (async () => {
    while (loading) { const r = await timed(TARGETS[0].url()); if (r.ok) loaded.push(r.ms); }
  })();
  dl = Math.max(dl, await download(size));
  loading = false; await pinger;

  onProgress("Testing upload speed…");
  let ul = await upload(5e5);
  ul = Math.max(ul, await upload(ul > 20 ? 1e7 : 2e6));

  const loadedLatency = median(loaded) ?? idle.latency;
  const bloat = idle.latency ? loadedLatency - idle.latency : 0;
  const grade = bloat < 5 ? "A+" : bloat < 30 ? "A" : bloat < 60 ? "B" : bloat < 200 ? "C" : bloat < 400 ? "D" : "F";
  return { download: dl, upload: ul, idleLatency: idle.latency, loadedLatency, bufferbloat: bloat, grade };
}

// ------------------------------------------------------------------ CPU pressure
/** CPU load: Compute Pressure API when available, else event-loop lag estimate. */
export function cpuMonitor(onValue) {
  if ("PressureObserver" in window) {
    try {
      const map = { nominal: 20, fair: 50, serious: 80, critical: 95 };
      const obs = new PressureObserver((recs) => {
        const s = recs[recs.length - 1].state;
        onValue({ value: map[s] ?? 30, label: s, method: "Compute Pressure API" });
      });
      obs.observe("cpu", { sampleInterval: 2000 }).catch(() => lagMonitor(onValue));
      return () => obs.disconnect();
    } catch { /* fall back */ }
  }
  return lagMonitor(onValue);
}

function lagMonitor(onValue) {
  const lags = [];
  let last = now();
  const step = 50;
  const id = setInterval(() => {
    const t = now();
    if (!document.hidden) lags.push(Math.max(0, t - last - step));
    last = t;
    if (lags.length >= 40) {
      const lag = mean(lags.splice(0));
      const value = clamp(12 + lag * 6, 5, 100);
      onValue({ value, label: value < 40 ? "low" : value < 70 ? "moderate" : "high", method: "event-loop lag estimate" });
    }
  }, step);
  return () => clearInterval(id);
}

// ------------------------------------------------------------------ model features
/**
 * Converts browser measurements into the 5 features the AI model was trained on.
 * Link utilisation is estimated from latency inflation over the session's baseline RTT
 * (queueing delay grows as a link congests - the principle behind bufferbloat tests).
 */
export function toModelSample({ cpu, latency, loss, baseline }) {
  const ratio = baseline && latency ? latency / baseline : 1;
  const bandwidth = clamp(30 + (ratio - 1) * 35, 5, 100);
  return {
    cpu: clamp(cpu ?? 30, 0, 100), bandwidth, packet_loss: clamp(loss ?? 0, 0, 100),
    latency: clamp(latency ?? 999, 1, 1000),
    throughput: 1000 * bandwidth / 100 * (1 - clamp(loss ?? 0, 0, 100) / 100),
  };
}
