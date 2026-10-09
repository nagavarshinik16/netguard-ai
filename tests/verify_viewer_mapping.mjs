// Checks the viewer-measurement -> model-feature mapping gives sensible verdicts.
// Run:  node tests/verify_viewer_mapping.mjs
import { readFileSync } from "node:fs";
import { FaultModel } from "../docs/js/model.js";

const src = readFileSync(new URL("../docs/js/probe.js", import.meta.url), "utf8");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toModelSample = new Function("clamp", src.slice(src.indexOf("export function toModelSample")).replace("export ", "") + "; return toModelSample;")(clamp);
const model = new FaultModel(JSON.parse(readFileSync(new URL("../docs/assets/model.json", import.meta.url))));

const cases = [
  ["Fibre, idle", { cpu: 20, latency: 10, loss: 0, baseline: 8 }, ["OK"]],
  ["Home Wi-Fi", { cpu: 30, latency: 45, loss: 0, baseline: 38 }, ["OK"]],
  ["Mobile 4G", { cpu: 35, latency: 80, loss: 0, baseline: 65 }, ["OK"]],
  ["Far server (US from India)", { cpu: 25, latency: 260, loss: 0, baseline: 250 }, ["OK", "WARNING"]],
  ["Satellite internet", { cpu: 25, latency: 640, loss: 0, baseline: 600 }, ["WARNING", "FAULT:Congestion", "FAULT:Link Failure"]],
  ["Busy CPU", { cpu: 95, latency: 20, loss: 0, baseline: 15 }, ["FAULT:CPU Overload"]],
  ["Congested link", { cpu: 45, latency: 140, loss: 2, baseline: 25 }, ["FAULT:Congestion"]],
  ["Failing link", { cpu: 30, latency: 220, loss: 25, baseline: 40 }, ["FAULT:Link Failure"]],
  ["Total outage", { cpu: 30, latency: null, loss: 100, baseline: 30 }, ["FAULT:Link Failure"]],
];
let pass = 0;
for (const [name, args, expect] of cases) {
  const s = toModelSample(args), r = model.predict(s, { useAnomaly: false });
  const got = r.status === "FAULT" ? `FAULT:${r.predicted}` : r.status;
  const ok = expect.includes(got); pass += ok;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(28)} util ${s.bandwidth.toFixed(0).padStart(3)}%  lat ${s.latency.toFixed(0).padStart(3)}ms  -> ${got.padEnd(20)} (expected ${expect.join(" / ")})`);
}
console.log(`${pass}/${cases.length} scenarios correct`); process.exit(pass === cases.length ? 0 : 1);
