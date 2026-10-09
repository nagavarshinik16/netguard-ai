// In-browser AI engine: exact port of the scikit-learn models exported by export_model.py.
//  * Random Forest   -> condition probabilities (Normal / Congestion / Link Failure / CPU Overload)
//  * Isolation Forest -> anomaly flag (identical scoring to sklearn's score_samples)
//  * Alert rules      -> OK / WARNING / FAULT, severity, recommendation  (same as fault_predictor.py)

export const THRESHOLDS = { cpu: 85, bandwidth: 85, packet_loss: 5, latency: 100 };
const SEVERITY = { Normal: "OK", "CPU Overload": "MAJOR", Congestion: "MAJOR", "Link Failure": "CRITICAL" };
export const ADVICE = {
  Congestion: "Link saturated - apply QoS / load-balance traffic or upgrade link capacity",
  "Link Failure": "High loss and latency - check physical link, interface errors, failover path",
  "CPU Overload": "Device CPU exhausted - check routing process, ACL load, possible DoS",
  Anomaly: "Unusual pattern not seen in training - investigate manually",
};

const EULER = 0.5772156649015329;
const f32 = Math.fround; // sklearn trees compare float32(x) <= threshold

function avgPathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

export class FaultModel {
  constructor(json) {
    this.m = json;
    this.features = json.features;
    this.classes = json.classes;
    this.normalIdx = this.classes.indexOf("Normal");
    this.isoDenominator = avgPathLength(json.iso.max_samples);
  }

  static async load(url = "assets/model.json") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Model download failed (${res.status})`);
    return new FaultModel(await res.json());
  }

  vector(sample) {
    return this.features.map((f) => f32(Number(sample[f])));
  }

  proba(x) {
    const out = new Array(this.classes.length).fill(0);
    for (const t of this.m.rf) {
      let n = 0;
      while (t.l[n] !== -1) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
      const p = t.p[n];
      for (let k = 0; k < out.length; k++) out[k] += p[k];
    }
    return out.map((v) => v / this.m.rf.length);
  }

  anomalyScore(x) {
    // equals sklearn IsolationForest.score_samples
    let depth = 0;
    for (const t of this.m.iso.trees) {
      let n = 0, d = 0;
      while (t.l[n] !== -1) { n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n]; d++; }
      depth += d + avgPathLength(t.n[n]);
    }
    return -Math.pow(2, -depth / (this.m.iso.trees.length * this.isoDenominator));
  }

  /** Full assessment of one telemetry sample {cpu, bandwidth, packet_loss, latency, throughput}. */
  predict(sample, { useAnomaly = true } = {}) {
    const x = this.vector(sample);
    const p = this.proba(x);
    let best = 0;
    p.forEach((v, i) => { if (v > p[best]) best = i; });
    const predicted = this.classes[best];
    const faultProbability = 1 - p[this.normalIdx];
    const anomaly = useAnomaly ? this.anomalyScore(x) < this.m.iso.offset : false;
    const breaches = Object.entries(THRESHOLDS).filter(([k, t]) => sample[k] > t).map(([k, t]) => `${k}>${t}`);

    let status = "OK";
    if (predicted !== "Normal" && faultProbability >= 0.6) status = "FAULT";
    else if (faultProbability >= 0.3 || anomaly || breaches.length) status = "WARNING";

    const severity = status === "FAULT" ? SEVERITY[predicted] : status === "WARNING" ? "WARNING" : "OK";
    const recommendation = status === "OK" ? "" : (predicted !== "Normal" ? ADVICE[predicted] : ADVICE.Anomaly);
    return {
      predicted, probabilities: Object.fromEntries(this.classes.map((c, i) => [c, p[i]])),
      faultProbability, confidence: p[best], anomaly, breaches, status, severity, recommendation,
    };
  }
}
