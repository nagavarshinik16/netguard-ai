"""
Step 5 - Export the trained models to compact JSON for in-browser inference (web edition).

Writes docs/assets/model.json containing:
  * the Random Forest (every tree as flat arrays: feature, threshold, children, leaf class probabilities)
  * the Isolation Forest (trees + the parameters needed for sklearn-identical scoring)
  * evaluation metrics and a test set used by tests/verify_web_model.mjs to check JS == Python

Usage:  python export_model.py
"""
import json
import os

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import confusion_matrix
from sklearn.model_selection import train_test_split

OUT = "docs/assets/model.json"
bundle = joblib.load("models/fault_model.joblib")
clf, iso, features = bundle["classifier"], bundle["anomaly"], bundle["features"]


def r(x, n=5):
    return [round(float(v), n) for v in x]


def export_rf_tree(est):
    t = est.tree_
    leaf = t.children_left == -1
    values = t.value[:, 0, :]
    probs = values / values.sum(axis=1, keepdims=True)
    return {
        "f": [int(v) if not lf else -1 for v, lf in zip(t.feature, leaf)],
        "t": np.where(leaf, 0, t.threshold).tolist(),  # exact: sklearn compares float32(x) <= t
        "l": t.children_left.tolist(),
        "r": t.children_right.tolist(),
        # class probabilities only for leaves, keyed by node index
        "p": {str(i): r(probs[i], 4) for i in np.where(leaf)[0]},
    }


def export_iso_tree(est, feats):
    t = est.tree_
    leaf = t.children_left == -1
    return {
        "f": [int(feats[v]) if not lf else -1 for v, lf in zip(t.feature, leaf)],
        "t": np.where(leaf, 0, t.threshold).tolist(),
        "l": t.children_left.tolist(),
        "r": t.children_right.tolist(),
        "n": t.n_node_samples.tolist(),
    }


df = pd.read_csv("data/network_metrics.csv")
X, y = df[features], df["condition"]
_, X_test, _, y_test = train_test_split(X, y, test_size=0.25, stratify=y, random_state=42)
sample = X_test.sample(600, random_state=1).round(4)

metrics_txt = open("outputs/metrics.txt", encoding="utf-8").read()


def grab(key):
    return float(metrics_txt.split(key)[1].split(":")[1].split("%")[0])


model = {
    "version": 1,
    "features": features,
    "classes": clf.classes_.tolist(),
    "rf": [export_rf_tree(e) for e in clf.estimators_],
    "iso": {
        "trees": [export_iso_tree(e, f) for e, f in zip(iso.estimators_, iso.estimators_features_)],
        "max_samples": int(iso.max_samples_),
        "offset": float(iso.offset_),
    },
    "metrics": {"accuracy": grab("Overall accuracy"), "detection": grab("Fault detection"),
                "false_alarm": grab("False alarm rate"), "train_size": int(len(df) * 0.75),
                "test_size": int(len(df) * 0.25), "dataset": int(len(df))},
    "confusion": confusion_matrix(y_test, clf.predict(X_test), labels=clf.classes_).tolist(),
    "importance": dict(zip(features, r(clf.feature_importances_, 4))),
    # reference predictions from scikit-learn, used to verify the JS port
    "test": {"X": sample.values.tolist(),
             "proba": [r(p, 4) for p in clf.predict_proba(sample)],
             "anomaly": (iso.predict(sample) == -1).tolist(),
             "score": r(iso.score_samples(sample), 6)},
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(model, f, separators=(",", ":"))
print(f"[+] Exported {len(model['rf'])} RF trees + {len(model['iso']['trees'])} isolation trees "
      f"-> {OUT} ({os.path.getsize(OUT) / 1e6:.2f} MB)")
