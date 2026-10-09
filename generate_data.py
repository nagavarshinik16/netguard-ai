"""
Step 1 - Synthetic network telemetry generator.

Simulates time-series metrics for a small network (routers, switches, servers)
and injects four kinds of network condition:
    Normal, Congestion, Link Failure, CPU Overload

Output: data/network_metrics.csv
"""
import argparse
import os

import numpy as np
import pandas as pd

DEVICES = {
    "R1-Core": "router",
    "R2-Edge": "router",
    "SW1-Access": "switch",
    "SW2-Dist": "switch",
    "SRV1-Web": "server",
    "SRV2-DB": "server",
}

# Mean / std of each metric per condition:
# cpu (%), bandwidth utilisation (%), packet loss (%), latency (ms)
PROFILES = {
    "Normal":       {"cpu": (35, 10), "bandwidth": (40, 12), "packet_loss": (0.2, 0.15), "latency": (20, 6)},
    "Congestion":   {"cpu": (55, 12), "bandwidth": (90, 5),  "packet_loss": (2.5, 1.2),  "latency": (85, 25)},
    "Link Failure": {"cpu": (30, 12), "bandwidth": (12, 8),  "packet_loss": (14, 6),     "latency": (160, 50)},
    "CPU Overload": {"cpu": (93, 4),  "bandwidth": (50, 15), "packet_loss": (1.0, 0.7),  "latency": (55, 18)},
}
LIMITS = {"cpu": (0, 100), "bandwidth": (0, 100), "packet_loss": (0, 100), "latency": (1, 1000)}

# Probability that a new "episode" is each condition (Normal dominates, like real networks)
EPISODE_WEIGHTS = {"Normal": 0.55, "Congestion": 0.17, "Link Failure": 0.13, "CPU Overload": 0.15}

# Faults do not appear instantly: metrics degrade over the first RAMP minutes of an
# episode. These early, partly-degraded samples are what the model must catch early.
RAMP = 5


def sample(condition, rng, severity=1.0):
    """severity in (0,1]: how far the metrics have drifted from Normal to the fault profile."""
    row = {}
    for metric, (mu, sd) in PROFILES[condition].items():
        lo, hi = LIMITS[metric]
        n_mu, n_sd = PROFILES["Normal"][metric]
        value = (1 - severity) * rng.normal(n_mu, n_sd) + severity * rng.normal(mu, sd)
        row[metric] = float(np.clip(value, lo, hi))
    # Throughput is derived: high utilisation helps, packet loss hurts (link = 1000 Mbps)
    row["throughput"] = round(1000 * row["bandwidth"] / 100 * (1 - row["packet_loss"] / 100), 2)
    return row


def generate(samples_per_device=2000, seed=42, start="2026-10-01 00:00"):
    rng = np.random.default_rng(seed)
    rows = []
    times = pd.date_range(start, periods=samples_per_device, freq="1min")
    names, weights = list(EPISODE_WEIGHTS), list(EPISODE_WEIGHTS.values())
    for device, dtype in DEVICES.items():
        i = 0
        while i < samples_per_device:
            condition = rng.choice(names, p=weights)
            length = int(rng.integers(15, 50) if condition == "Normal" else rng.integers(6, 25))
            for k, t in enumerate(times[i:i + length]):
                severity = 1.0 if condition == "Normal" else min(1.0, (k + 1) / RAMP)
                rows.append({"timestamp": t, "device": device, "device_type": dtype,
                             **sample(condition, rng, severity), "condition": condition})
            i += length
    df = pd.DataFrame(rows).sort_values(["timestamp", "device"]).reset_index(drop=True)
    return df.round({"cpu": 2, "bandwidth": 2, "packet_loss": 3, "latency": 2})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=2000, help="samples per device")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="data/network_metrics.csv")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    df = generate(args.samples, args.seed)
    df.to_csv(args.out, index=False)
    print(f"[+] Generated {len(df)} records for {df.device.nunique()} devices -> {args.out}")
    print("\nCondition distribution:")
    print(df.condition.value_counts().to_string())
    print("\nSample rows:")
    print(df.head(8).to_string(index=False))
