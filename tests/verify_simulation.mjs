// Checks the JS simulator + JS model reproduce the Python results on fresh scenarios.
// Run:  node tests/verify_simulation.mjs
import { readFileSync } from "node:fs";
import { FaultModel } from "../docs/js/model.js";
import { generate } from "../docs/js/sim.js";

const model = new FaultModel(JSON.parse(readFileSync(new URL("../docs/assets/model.json", import.meta.url))));
let allOk = true;
for (const seed of [1, 7, 99, 2024, 31337]) {
  const rows = generate(200, seed);
  let correct = 0, faults = 0, caught = 0, normals = 0, falseAlarms = 0;
  const dist = {};
  for (const r of rows) {
    const ai = model.predict(r);
    dist[r.condition] = (dist[r.condition] || 0) + 1;
    if (ai.predicted === r.condition) correct++;
    if (r.condition !== "Normal") { faults++; if (ai.status !== "OK") caught++; }
    else { normals++; if (ai.status === "FAULT") falseAlarms++; }
  }
  const acc = (100 * correct) / rows.length;
  allOk &&= acc > 95;
  console.log(`seed ${String(seed).padStart(5)}: rows ${rows.length}  accuracy ${acc.toFixed(1)}%  ` +
    `faults caught ${(100 * caught / faults).toFixed(1)}%  false alarms ${(100 * falseAlarms / normals).toFixed(1)}%  ` +
    JSON.stringify(dist));
}
console.log(allOk ? "PASS" : "FAIL"); process.exit(allOk ? 0 : 1);
