"""Builds the mini-project report -> NMS_MiniProject_Report.docx"""
import re

import pandas as pd
from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor

metrics = open("outputs/metrics.txt", encoding="utf-8").read()
acc = re.search(r"Overall accuracy\s*:\s*([\d.]+)", metrics).group(1)
det = re.search(r"Fault detection\s*:\s*([\d.]+)", metrics).group(1)
fa = re.search(r"False alarm rate\s*:\s*([\d.]+)", metrics).group(1)
df = pd.read_csv("data/network_metrics.csv")
counts = df.condition.value_counts()

doc = Document()
style = doc.styles["Normal"]
style.font.name = "Calibri"
style.font.size = Pt(11)
for s in doc.sections:
    s.left_margin = s.right_margin = Inches(0.9)
    s.top_margin = s.bottom_margin = Inches(0.8)


def h(text, level=1):
    p = doc.add_heading(text, level=level)
    for r in p.runs:
        r.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)


def para(text, bold_prefix=None):
    p = doc.add_paragraph()
    if bold_prefix:
        p.add_run(bold_prefix).bold = True
    p.add_run(text)
    p.paragraph_format.space_after = Pt(6)
    return p


def bullets(items):
    for it in items:
        doc.add_paragraph(it, style="List Bullet")


def image(path, width, caption):
    doc.add_picture(path, width=Inches(width))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    c = doc.add_paragraph(caption)
    c.alignment = WD_ALIGN_PARAGRAPH.CENTER
    c.runs[0].italic = True
    c.runs[0].font.size = Pt(9)


def table(rows, header):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Light Grid Accent 1"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, x in enumerate(header):
        t.rows[0].cells[i].text = x
    for r in rows:
        cells = t.add_row().cells
        for i, x in enumerate(r):
            cells[i].text = str(x)
    doc.add_paragraph()


# ---------------- Title ----------------
t = doc.add_paragraph()
t.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = t.add_run("NETWORK MANAGEMENT SYSTEM - MINI-PROJECT REPORT")
r.bold = True
r.font.size = Pt(15)
t = doc.add_paragraph()
t.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = t.add_run("NetGuard AI: AI-Based Network Fault Prediction System")
r.bold = True
r.font.size = Pt(18)
r.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
t = doc.add_paragraph()
t.alignment = WD_ALIGN_PARAGRAPH.CENTER
t.add_run("Course Code: 22CSPW0   |   Topic 9\n"
          "Name: ____________________   Roll No.: ____________   Section: ______").font.size = Pt(10)

# ---------------- 1. Problem ----------------
h("1. Problem Statement")
para("Modern networks generate continuous telemetry (CPU load, link utilisation, packet loss and latency). "
     "Traditional Network Management Systems rely on static thresholds, which detect a fault only after it "
     "has already affected users and cannot tell what kind of fault is occurring. The goal of this project "
     "is to build an AI-based system that analyses historical network data, learns the patterns of abnormal "
     "conditions, classifies the current network condition of each device and generates early "
     "potential-fault warnings together with a probable cause and a recommended action.")
para("Objectives: ", None)
bullets([
    "Simulate realistic telemetry for routers, switches and servers, including faults that develop gradually.",
    "Train a machine-learning model to classify Normal, Congestion, Link Failure and CPU Overload conditions.",
    "Detect unknown anomalies that were not part of the training data.",
    "Generate graded alerts (OK / WARNING / FAULT) with severity and remediation advice.",
    "Visualise device status, performance trends, alerts and model accuracy on a dashboard.",
    "Maintain a device inventory (IP, MAC, vendor, model, OS, interfaces) and network topology.",
    "Monitor the real network of the host machine (latency, packet loss, throughput, LAN devices).",
    "Protect the management console with authenticated login.",
])

# ---------------- 2. Architecture ----------------
h("2. System Architecture and Workflow")
para("The system has two pipelines. The offline training pipeline generates a labelled historical dataset "
     "and trains the models. The online monitoring pipeline feeds telemetry into the trained model, applies "
     "the alert rules and displays the results in the NetGuard AI web console. Telemetry comes from two "
     "sources: a simulated six-device enterprise network, and the real host machine and its LAN.")
image("outputs/architecture.png", 6.6, "Figure 1: System architecture and workflow")
table([
    ["Language", "Python 3"],
    ["Data / ML", "pandas, NumPy, scikit-learn (RandomForestClassifier, IsolationForest)"],
    ["Visualisation", "Streamlit + Altair (web console), Graphviz (topology), Matplotlib (plots)"],
    ["Real telemetry", "psutil (CPU, memory, interfaces), ICMP ping (latency, loss), ARP table (LAN discovery)"],
    ["Security", "Salted SHA-256 password hashes, account lockout after 5 failed attempts"],
    ["Model storage", "joblib"],
], ["Component", "Technology"])

# ---------------- 3. Dataset ----------------
h("3. Dataset and Fault Simulation")
para(f"Since physical devices are not required, telemetry is simulated by generate_data.py for six devices "
     f"(R1-Core, R2-Edge, SW1-Access, SW2-Dist, SRV1-Web, SRV2-DB) at one-minute intervals. The dataset "
     f"contains {len(df):,} labelled records with five features: CPU (%), bandwidth utilisation (%), packet "
     f"loss (%), latency (ms) and throughput (Mbps, derived from utilisation and loss).")
para("Each device alternates between normal periods and fault episodes. To be realistic, a fault does not "
     "appear instantly: during the first five minutes of an episode the metrics drift gradually from the "
     "normal profile toward the fault profile. These early, partly degraded samples are exactly where "
     "prediction is valuable, and they make the classification task non-trivial.")
table([
    ["Normal", "35 ± 10", "40 ± 12", "0.2", "20", f"{counts.get('Normal', 0):,}"],
    ["Congestion", "55 ± 12", "90 ± 5", "2.5", "85", f"{counts.get('Congestion', 0):,}"],
    ["Link Failure", "30 ± 12", "12 ± 8", "14", "160", f"{counts.get('Link Failure', 0):,}"],
    ["CPU Overload", "93 ± 4", "50 ± 15", "1.0", "55", f"{counts.get('CPU Overload', 0):,}"],
], ["Condition", "CPU %", "Bandwidth %", "Loss %", "Latency ms", "Records"])

# ---------------- 4. Methodology ----------------
h("4. Methodology")
para("Random Forest Classifier: ", None).runs[0].bold = True
para("An ensemble of 150 decision trees (max depth 12) is trained on 75% of the data (stratified split) "
     "and evaluated on the remaining 25%. It outputs the predicted condition and a class probability. "
     "The fault probability is defined as 1 − P(Normal).")
para("Isolation Forest (anomaly detection): ", None).runs[0].bold = True
para("Trained only on Normal traffic, it flags samples that differ from normal behaviour even when the "
     "pattern does not match any known fault class, so it covers faults the classifier was never taught.")
para("Alert engine (fault_predictor.py): ", None).runs[0].bold = True
bullets([
    "FAULT: predicted class is not Normal and fault probability ≥ 0.6. Severity is CRITICAL for Link Failure and MAJOR for Congestion or CPU Overload.",
    "WARNING (potential fault): fault probability ≥ 0.3, an anomaly is detected, or a static threshold is "
    "breached (CPU > 85%, bandwidth > 85%, loss > 5%, latency > 100 ms).",
    "OK: none of the above. Each alert carries a recommended corrective action.",
])

# ---------------- 5. Web console ----------------
h("5. NetGuard AI Web Console")
para("The management console is a secure, multi-page web application. Its features are:")
bullets([
    "Login: username/password authentication. Passwords are stored only as salted SHA-256 hashes, and the "
    "account locks for 30 seconds after 5 failed attempts.",
    "Network Overview: KPI cards, a live network topology map coloured by AI status (failed links are drawn "
    "as dashed red lines), device health cards and a timeline of predicted conditions.",
    "Device Inventory: hostname, management IP, MAC, vendor, model, OS, serial number, location, uptime "
    "and SNMP version for every device, plus per-interface status, utilisation, traffic and errors.",
    "Performance: CPU, bandwidth, packet loss and latency trends with thresholds and AI-predicted conditions.",
    "Alarms & Events: filterable alarm list with severity, probable cause, recommended action and CSV export.",
    "Live Network (real): the host's actual IP, gateway, CPU, memory, throughput, ICMP latency and packet "
    "loss to the gateway and internet, LAN devices discovered from the ARP table, and the AI assessment of "
    "this real network, refreshed every 3 seconds.",
    "AI Engine: model metrics and an interactive what-if simulator that classifies any combination of metrics.",
])

# ---------------- 6. Results ----------------
h("6. Results")
table([
    ["Overall accuracy (test set)", f"{acc}%"],
    ["Fault detection rate", f"{det}%"],
    ["False alarm rate", f"{fa}%"],
    ["Test samples", "3,000"],
], ["Metric", "Value"])
image("outputs/confusion_matrix.png", 4.0, "Figure 2: Confusion matrix on the test set")
para("Most errors come from the first minute or two of CPU Overload and Congestion episodes, when the "
     "metrics are still close to normal. This is expected because those samples overlap with normal "
     "behaviour. Link Failure is detected almost perfectly because of its strong packet-loss and latency "
     "signature.")
image("outputs/feature_importance.png", 4.6, "Figure 3: Feature importance")
para("Latency and packet loss are the most informative features, followed by CPU. This matches networking "
     "intuition: congestion and link problems show up first as delay and loss.")

# ---------------- 6. Screenshots ----------------
h("7. Execution Screenshots")
shots = [
    ("01_generate_data.png", "Dataset generation"),
    ("02_train_model.png", "Model training and evaluation"),
    ("03_login.png", "Secure login page"),
    ("04_overview.png", "Network overview: KPIs, topology and device health"),
    ("04b_overview_live_replay.png", "Live replay: a link failure on SW2-Dist shown on the topology"),
    ("05_device_inventory.png", "Device inventory and interface details"),
    ("06_performance.png", "Performance trends with thresholds and AI predictions"),
    ("07_alarms_events.png", "Alarms and events with severity and recommendations"),
    ("08_live_network_real.png", "Live monitoring of the real host network"),
    ("09_ai_engine.png", "AI engine: what-if simulator and model evaluation"),
    ("11_cli_monitor_live.png", "Command-line live monitor raising fault warnings"),
]
for i, (f, cap) in enumerate(shots, 4):
    image(f"screenshots/{f}", 6.3, f"Figure {i}: {cap}")

# ---------------- 7. Conclusion ----------------
h("8. Conclusion and Future Scope")
para(f"The project shows that a basic machine-learning model can turn raw network telemetry into actionable "
     f"fault warnings. The Random Forest classifier reached {acc}% accuracy with a {det}% fault detection "
     f"rate and only {fa}% false alarms. It also identifies the type of fault, which a static threshold "
     f"cannot do. The Isolation Forest adds protection against unknown anomalies. The NetGuard AI console "
     f"gives operators one secure place for topology, inventory, performance, alarms and live monitoring "
     f"of the real network.")
para("Future scope: ", None).runs[0].bold = True
bullets([
    "Poll real routers and switches through SNMP or streaming telemetry, alongside the host monitoring.",
    "Use time-series models such as LSTM to forecast faults several minutes ahead.",
    "Correlate alarms across connected devices to locate the root cause.",
    "Integrate notifications (email, Slack) and automatic remediation through SDN or REST APIs.",
])

doc.save("NMS_MiniProject_Report.docx")
print("[+] Saved NMS_MiniProject_Report.docx")
