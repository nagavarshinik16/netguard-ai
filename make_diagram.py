"""Draws the system architecture / workflow diagram -> outputs/architecture.png"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

fig, ax = plt.subplots(figsize=(14, 7.2))
ax.set_xlim(0, 14)
ax.set_ylim(0, 7.2)
ax.axis("off")


def box(x, y, w, h, title, body, color):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.05,rounding_size=0.15",
                                fc=color, ec="#2d3748", lw=1.4))
    ax.text(x + w / 2, y + h - 0.32, title, ha="center", va="top", fontsize=11, weight="bold")
    ax.text(x + w / 2, y + h - 0.75, body, ha="center", va="top", fontsize=8.6, linespacing=1.45)


def arrow(x1, y1, x2, y2, label=""):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=18,
                                 lw=1.6, color="#2d3748"))
    if label:
        ax.text((x1 + x2) / 2, (y1 + y2) / 2 + 0.15, label, ha="center", fontsize=8, style="italic")


ax.text(7, 6.9, "AI-Based Network Fault Prediction System - Architecture",
        ha="center", fontsize=15, weight="bold")

# Top row: offline training pipeline
ax.text(0.2, 6.3, "OFFLINE TRAINING PIPELINE", fontsize=9, color="#4a5568", weight="bold")
box(0.2, 4.1, 3.0, 2.0, "1. Network Devices", "Routers  R1, R2\nSwitches  SW1, SW2\nServers  SRV1, SRV2\n(simulated)", "#e2e8f0")
box(3.8, 4.1, 3.0, 2.0, "2. Telemetry Generator", "generate_data.py\nCPU, bandwidth,\npacket loss, latency,\nthroughput + fault ramp", "#bee3f8")
box(7.4, 4.1, 3.0, 2.0, "3. Historical Dataset", "network_metrics.csv\n12,000 labelled records\nNormal / Congestion /\nLink Failure / CPU Overload", "#c6f6d5")
box(11.0, 4.1, 2.8, 2.0, "4. Model Training", "train_model.py\nRandom Forest (classify)\nIsolation Forest (anomaly)\n75/25 train-test split", "#fefcbf")
arrow(3.2, 5.1, 3.8, 5.1)
arrow(6.8, 5.1, 7.4, 5.1)
arrow(10.4, 5.1, 11.0, 5.1)

# Bottom row: online monitoring pipeline
ax.text(0.2, 3.55, "ONLINE MONITORING / PREDICTION", fontsize=9, color="#4a5568", weight="bold")
box(0.2, 1.3, 3.0, 2.0, "5. Live Telemetry", "Simulated devices (SNMP-style)\n+ REAL host: psutil CPU/RAM,\nICMP ping latency/loss,\nARP neighbour discovery", "#bee3f8")
box(3.8, 1.3, 3.0, 2.0, "6. Fault Predictor", "fault_predictor.py\nclass + fault probability\nanomaly score\nthreshold checks", "#fed7d7")
box(7.4, 1.3, 3.0, 2.0, "7. Alert Engine", "OK / WARNING / FAULT\nSeverity: MAJOR / CRITICAL\nRecommended action\nalerts.csv", "#fbd38d")
box(11.0, 1.3, 2.8, 2.0, "8. NetGuard AI Console", "Secure login (auth.py)\nOverview, Topology, Inventory\nPerformance, Alarms,\nLive Network, AI Engine", "#e9d8fd")
arrow(3.2, 2.3, 3.8, 2.3)
arrow(6.8, 2.3, 7.4, 2.3)
arrow(10.4, 2.3, 11.0, 2.3)
arrow(12.4, 4.1, 5.3, 3.3, "trained model (fault_model.joblib)")

ax.text(7, 0.55, "Decision rule:  FAULT if predicted class != Normal and P(fault) >= 0.6   |   "
        "WARNING if P(fault) >= 0.3, anomaly detected or a static threshold is breached",
        ha="center", fontsize=9, bbox=dict(fc="#f7fafc", ec="#a0aec0", boxstyle="round,pad=0.4"))

plt.tight_layout()
plt.savefig("outputs/architecture.png", dpi=160)
print("[+] Saved outputs/architecture.png")
