"""
Step 3 - Real-time monitoring simulation (command line).

Streams fresh, unseen telemetry (different random seed than training),
classifies every sample with the trained model and prints fault warnings.
Alerts are also written to outputs/alerts.csv.

Usage:  python monitor.py [--minutes 30] [--delay 0.2]
"""
import argparse
import os
import time

from fault_predictor import FaultPredictor
from generate_data import generate

os.chdir(os.path.dirname(os.path.abspath(__file__)))
if os.name == "nt":
    os.system("")  # enable ANSI colours in the Windows console

COLOR = {"OK": "\033[92m", "WARNING": "\033[93m", "FAULT": "\033[91m"}
RESET = "\033[0m"

ap = argparse.ArgumentParser()
ap.add_argument("--minutes", type=int, default=30, help="minutes of traffic to simulate")
ap.add_argument("--delay", type=float, default=0.2, help="seconds between ticks")
ap.add_argument("--seed", type=int, default=7)
args = ap.parse_args()

predictor = FaultPredictor()
live = generate(samples_per_device=args.minutes, seed=args.seed, start="2026-10-09 09:00")
results = predictor.predict(live)

print("=" * 96)
print(" AI-BASED NETWORK FAULT PREDICTION - LIVE MONITOR".center(96))
print("=" * 96)
for ts, group in results.groupby("timestamp"):
    print(f"\n[{ts:%Y-%m-%d %H:%M}]")
    for _, r in group.iterrows():
        c = COLOR[r.status]
        line = (f"  {r.device:<11} CPU {r.cpu:5.1f}%  BW {r.bandwidth:5.1f}%  "
                f"Loss {r.packet_loss:5.2f}%  Lat {r.latency:6.1f}ms  -> "
                f"{c}{r.status:<7}{RESET} {r.predicted:<12} (p_fault={r.fault_probability:.2f})")
        print(line)
        if r.status != "OK":
            print(f"      {c}! [{r.severity}] {r.recommendation}{RESET}")
    time.sleep(args.delay)

alerts = results[results.status != "OK"]
alerts.to_csv("outputs/alerts.csv", index=False)

print("\n" + "=" * 96)
print(" SUMMARY".center(96))
print("=" * 96)
print(f" Samples analysed : {len(results)}")
print(f" OK / WARNING / FAULT : "
      f"{(results.status == 'OK').sum()} / {(results.status == 'WARNING').sum()} / {(results.status == 'FAULT').sum()}")
acc = (results.predicted == results.condition).mean() * 100
print(f" Accuracy on live (unseen) data : {acc:.1f}%")
print("\n Faults by device:")
print(alerts[alerts.status == "FAULT"].groupby(["device", "predicted"]).size().to_string())
print(f"\n[+] {len(alerts)} alerts written to outputs/alerts.csv")
