// Verifies the JavaScript port (docs/js/model.js) reproduces scikit-learn exactly.
// Run:  node tests/verify_web_model.mjs
import { readFileSync } from "node:fs";
import { FaultModel } from "../docs/js/model.js";

const json = JSON.parse(readFileSync(new URL("../docs/assets/model.json", import.meta.url)));
const model = new FaultModel(json);
const { X, proba, anomaly, score } = json.test;

let classMatch = 0, maxProbErr = 0, anomMatch = 0, maxScoreErr = 0;
X.forEach((row, i) => {
  const x = row.map(Math.fround);
  const p = model.proba(x);
  const argmax = (a) => a.indexOf(Math.max(...a));
  if (argmax(p) === argmax(proba[i])) classMatch++;
  p.forEach((v, k) => { maxProbErr = Math.max(maxProbErr, Math.abs(v - proba[i][k])); });
  const s = model.anomalyScore(x);
  maxScoreErr = Math.max(maxScoreErr, Math.abs(s - score[i]));
  if ((s < json.iso.offset) === anomaly[i]) anomMatch++;
});

const n = X.length;
console.log(`Random Forest class agreement : ${classMatch}/${n}`);
console.log(`Max probability difference    : ${maxProbErr.toExponential(2)}`);
console.log(`Isolation Forest agreement    : ${anomMatch}/${n}`);
console.log(`Max anomaly-score difference  : ${maxScoreErr.toExponential(2)}`);
const ok = classMatch === n && anomMatch === n && maxProbErr < 1e-3 && maxScoreErr < 1e-5;
console.log(ok ? "PASS - JS model matches scikit-learn" : "FAIL");
process.exit(ok ? 0 : 1);
