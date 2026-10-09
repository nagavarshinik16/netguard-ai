"""
Shared prediction + alerting logic used by monitor.py and dashboard.py.
"""
import joblib
import pandas as pd

# Static thresholds (classic NMS rule-based alerts, shown alongside the AI prediction)
THRESHOLDS = {"cpu": 85, "bandwidth": 85, "packet_loss": 5, "latency": 100}

SEVERITY = {"Normal": "OK", "CPU Overload": "MAJOR", "Congestion": "MAJOR", "Link Failure": "CRITICAL"}

ADVICE = {
    "Congestion": "Link saturated - apply QoS / load-balance traffic or upgrade link capacity",
    "Link Failure": "High loss and latency - check physical link, interface errors, failover path",
    "CPU Overload": "Device CPU exhausted - check routing process, ACL load, possible DoS",
    "Anomaly": "Unusual pattern not seen in training - investigate manually",
}


class FaultPredictor:
    def __init__(self, path="models/fault_model.joblib"):
        bundle = joblib.load(path)
        self.clf = bundle["classifier"]
        self.iso = bundle["anomaly"]
        self.features = bundle["features"]

    def predict(self, df: pd.DataFrame, use_anomaly=True) -> pd.DataFrame:
        """use_anomaly=False for real hosts, whose idle traffic profile differs from the
        simulated enterprise baseline the Isolation Forest was trained on."""
        X = df[self.features]
        out = df.copy()
        proba = self.clf.predict_proba(X)
        out["predicted"] = self.clf.classes_[proba.argmax(axis=1)]
        out["confidence"] = proba.max(axis=1).round(3)
        normal_idx = list(self.clf.classes_).index("Normal")
        out["fault_probability"] = (1 - proba[:, normal_idx]).round(3)
        out["anomaly"] = (self.iso.predict(X) == -1) if use_anomaly else False
        out["threshold_breaches"] = df.apply(
            lambda r: ", ".join(f"{m}>{t}" for m, t in THRESHOLDS.items() if r[m] > t), axis=1)
        out["status"] = out.apply(self._status, axis=1)
        out["severity"] = out.apply(
            lambda r: SEVERITY.get(r.predicted, "OK") if r.status == "FAULT"
            else ("WARNING" if r.status == "WARNING" else "OK"), axis=1)
        out["recommendation"] = out.apply(self._advice, axis=1)
        return out

    @staticmethod
    def _status(r):
        if r.predicted != "Normal" and r.fault_probability >= 0.6:
            return "FAULT"
        if r.fault_probability >= 0.3 or r.anomaly or r.threshold_breaches:
            return "WARNING"  # potential fault - early warning
        return "OK"

    @staticmethod
    def _advice(r):
        if r.status == "OK":
            return ""
        if r.predicted != "Normal":
            return ADVICE[r.predicted]
        return ADVICE["Anomaly"]
