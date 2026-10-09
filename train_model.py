"""
Step 2 - Train the AI fault-prediction model.

* Random Forest classifier  -> predicts the network condition
  (Normal / Congestion / Link Failure / CPU Overload)
* Isolation Forest          -> trained on Normal data only, flags
  unseen / unknown anomalies the classifier was never taught

Outputs: models/fault_model.joblib, outputs/metrics.txt, outputs/*.png
"""
import os

import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import (ConfusionMatrixDisplay, accuracy_score,
                             classification_report, confusion_matrix)
from sklearn.model_selection import train_test_split

FEATURES = ["cpu", "bandwidth", "packet_loss", "latency", "throughput"]
CLASSES = ["Normal", "Congestion", "Link Failure", "CPU Overload"]

os.makedirs("models", exist_ok=True)
os.makedirs("outputs", exist_ok=True)

df = pd.read_csv("data/network_metrics.csv")
X, y = df[FEATURES], df["condition"]
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.25, stratify=y, random_state=42)

print(f"[+] Training on {len(X_train)} samples, testing on {len(X_test)} samples")

clf = RandomForestClassifier(n_estimators=150, max_depth=12, random_state=42, n_jobs=-1)
clf.fit(X_train, y_train)
pred = clf.predict(X_test)

iso = IsolationForest(n_estimators=150, contamination=0.02, random_state=42)
iso.fit(X_train[y_train == "Normal"])

acc = accuracy_score(y_test, pred)
report = classification_report(y_test, pred, labels=CLASSES, digits=3)
cm = confusion_matrix(y_test, pred, labels=CLASSES)

# Binary view: did we catch faults at all? (any non-Normal = fault)
fault_true, fault_pred = y_test != "Normal", pred != "Normal"
detection_rate = (fault_true & fault_pred).sum() / fault_true.sum()
false_alarm = (~fault_true & fault_pred).sum() / (~fault_true).sum()

summary = (
    "AI-Based Network Fault Prediction - Model Evaluation\n"
    "====================================================\n"
    f"Dataset size      : {len(df)} records, {df.device.nunique()} devices\n"
    f"Train / Test      : {len(X_train)} / {len(X_test)}\n"
    f"Model             : RandomForestClassifier(n_estimators=150, max_depth=12)\n"
    f"Overall accuracy  : {acc*100:.2f}%\n"
    f"Fault detection   : {detection_rate*100:.2f}%  (faults correctly flagged)\n"
    f"False alarm rate  : {false_alarm*100:.2f}%  (normal traffic flagged as fault)\n\n"
    f"Classification report:\n{report}\n"
    f"Confusion matrix (rows=actual, cols=predicted; order={CLASSES}):\n{cm}\n"
)
print(summary)
with open("outputs/metrics.txt", "w", encoding="utf-8") as f:
    f.write(summary)

# Confusion matrix plot
fig, ax = plt.subplots(figsize=(7, 6))
ConfusionMatrixDisplay(cm, display_labels=CLASSES).plot(ax=ax, cmap="Blues", colorbar=False)
ax.set_title(f"Confusion Matrix (accuracy {acc*100:.1f}%)")
plt.xticks(rotation=20)
plt.tight_layout()
plt.savefig("outputs/confusion_matrix.png", dpi=150)
plt.close()

# Feature importance plot
imp = pd.Series(clf.feature_importances_, index=FEATURES).sort_values()
fig, ax = plt.subplots(figsize=(7, 4))
imp.plot.barh(ax=ax, color="#2b6cb0")
ax.set_title("Feature Importance - which metrics predict faults")
ax.set_xlabel("Importance")
plt.tight_layout()
plt.savefig("outputs/feature_importance.png", dpi=150)
plt.close()

joblib.dump({"classifier": clf, "anomaly": iso, "features": FEATURES, "classes": CLASSES},
            "models/fault_model.joblib")
print("[+] Model saved -> models/fault_model.joblib")
print("[+] Plots saved -> outputs/confusion_matrix.png, outputs/feature_importance.png")
