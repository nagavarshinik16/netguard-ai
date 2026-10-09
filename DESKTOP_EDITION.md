# 🖥️ NetGuard AI: Desktop / LAN Edition (Python)


> This guide covers the **Python edition** (Streamlit + psutil), which also discovers devices on your LAN.
> For the hosted **web edition**, see [README.md](README.md).

**Course:** Network Management System (22CSPW0), Mini-Project, Topic 9: *AI-Based Network Fault Prediction System*

NetGuard AI is an intelligent Network Management System (NMS). A machine-learning model analyses
**CPU, bandwidth, packet-loss and latency** telemetry and classifies every device as
**Normal / Congestion / Link Failure / CPU Overload**. It raises **potential-fault warnings** with a
severity, a probable cause and a recommended action.

It monitors two networks at once:
1. **A simulated enterprise network**: 2 routers, 2 switches and 2 servers with full inventory (IP, MAC, vendor, OS, interfaces).
2. **The real network of the computer it runs on**: real IP, gateway, CPU, RAM, throughput, ping latency and loss, and devices on your Wi-Fi/LAN.

Everything is served as a **secure, login-protected web console** that any device on the same network can open.

---

## Table of contents
1. [Quick start (TL;DR)](#1-quick-start-tldr)
2. [Features](#2-features)
3. [How it works](#3-how-it-works)
4. [Project structure](#4-project-structure)
5. [Requirements](#5-requirements)
6. [Run on Windows (automated)](#6-run-on-windows-automated)
7. [Run with bash: Git Bash, WSL, Linux, macOS](#7-run-with-bash-git-bash-wsl-linux-macos)
8. [Manual setup: every command step by step](#8-manual-setup-every-command-step-by-step)
9. [Hosting on your local network (LAN)](#9-hosting-on-your-local-network-lan)
10. [Using the web console](#10-using-the-web-console)
11. [Command-line tools](#11-command-line-tools)
12. [Results](#12-results)
13. [Troubleshooting](#13-troubleshooting)
14. [Stop, reset and uninstall](#14-stop-reset-and-uninstall)
15. [Security notes](#15-security-notes)
16. [Command reference (all commands)](#16-command-reference-all-commands)

---

## 1. Quick start (TL;DR)

| Platform | What to do |
|---|---|
| **Windows** | Install [Python 3.10+](https://www.python.org/downloads/) (tick **"Add python.exe to PATH"**), then **double-click `run_windows.bat`** |
| **Linux / macOS / Git Bash / WSL** | `chmod +x run.sh && ./run.sh` |

Then open **http://localhost:8501** and sign in:

| Username | Password |
|---|---|
| `admin` | `adminnms` |

Other devices on the same Wi-Fi can open the **"Other devices"** address printed by the script
(for example `http://192.168.0.15:8501`). The address is also saved in `ACCESS_URL.txt`.

---

## 2. Features

| Page | What it shows |
|---|---|
| 🔐 **Login** | Username/password sign-in. Passwords are stored only as salted SHA-256 hashes, and the account locks for 30 s after 5 failed attempts |
| 🏠 **Overview** | KPI cards, **live network topology map** coloured by AI status (a failed link is drawn as a dashed red line), device health cards, AI condition timeline |
| 🖧 **Device Inventory** | Hostname, management IP, MAC, vendor, model, OS/firmware, serial, location, uptime and SNMP version, plus a per-interface table (status, utilisation, traffic, errors) |
| 📈 **Performance** | CPU / bandwidth / packet-loss / latency trends with thresholds and AI-predicted conditions, plus a cross-device comparison |
| 🚨 **Alarms & Events** | Filterable alarms with severity (CRITICAL / MAJOR / WARNING), probable cause, recommended action, CSV export |
| 📡 **Live Network (real)** | **Real** data from this computer: IP, gateway, uptime, CPU, RAM, download/upload, ICMP latency and loss to the gateway, 8.8.8.8, 1.1.1.1 and google.com, **devices discovered on the LAN (ARP table)**, network interfaces, and the AI verdict on the real network. Refreshes every 3 s |
| 🧠 **AI Engine** | Accuracy / detection / false-alarm KPIs, an **interactive what-if simulator** (move the sliders and the model classifies the condition instantly), confusion matrix, feature importance |
| ℹ️ **About** | Architecture diagram, thresholds, technology stack, session info |
| ▶ **Live replay** | Sidebar toggle that streams the simulated network minute by minute |

---

## 3. How it works

### 3.1 Architecture

```
 OFFLINE TRAINING                                     ONLINE MONITORING
 ────────────────                                     ─────────────────
 generate_data.py ──► data/network_metrics.csv        Simulated devices ─┐
 (6 devices, 4 conditions,   (12,000 labelled rows)   Real host (psutil, ├─► fault_predictor.py ──► Alert engine ──► NetGuard AI console
  gradual fault onset)              │                 ping, ARP) ────────┘   (class + P(fault)     (OK/WARNING/FAULT,   (dashboard.py,
                                    ▼                                         + anomaly + thresholds) severity, advice)    login, 7 pages)
                             train_model.py ──► models/fault_model.joblib ──────────▲
                     (Random Forest + Isolation Forest)
```
The full diagram is in `outputs/architecture.png`.

### 3.2 Data: simulated telemetry (`generate_data.py`)
* Six devices (`R2-Edge`, `R1-Core`, `SW2-Dist`, `SW1-Access`, `SRV1-Web`, `SRV2-DB`) are sampled once per minute.
* Features: **CPU %**, **bandwidth utilisation %**, **packet loss %**, **latency (ms)** and **throughput (Mbps)**, where throughput is derived from bandwidth and loss.
* Each device alternates between *Normal* periods and fault episodes: **Congestion**, **Link Failure** or **CPU Overload**.
* **Faults build up gradually.** During the first 5 minutes of an episode the metrics drift from normal toward the fault profile. Catching these early, half-degraded samples is what makes it *prediction* rather than simple threshold detection.

| Condition | CPU % | Bandwidth % | Loss % | Latency ms |
|---|---|---|---|---|
| Normal | 35 ± 10 | 40 ± 12 | 0.2 | 20 |
| Congestion | 55 ± 12 | 90 ± 5 | 2.5 | 85 |
| Link Failure | 30 ± 12 | 12 ± 8 | 14 | 160 |
| CPU Overload | 93 ± 4 | 50 ± 15 | 1.0 | 55 |

### 3.3 AI model (`train_model.py`)
* **Random Forest classifier** (150 trees, depth 12). It is trained on 75% of the data with a stratified split and tested on the other 25%. Its output is the predicted condition plus class probabilities.
* **Fault probability** = 1 − P(Normal).
* **Isolation Forest** is trained on Normal traffic only. It flags *unknown* anomalies that do not match any known fault.

### 3.4 Alert engine (`fault_predictor.py`)
| Status | Rule | Severity |
|---|---|---|
| 🔴 **FAULT** | predicted ≠ Normal **and** P(fault) ≥ 0.6 | CRITICAL (Link Failure) / MAJOR (Congestion, CPU Overload) |
| 🟡 **WARNING** | P(fault) ≥ 0.3, **or** an anomaly is detected, **or** a static threshold is breached (CPU > 85%, BW > 85%, loss > 5%, latency > 100 ms) | WARNING |
| 🟢 **OK** | none of the above | - |

Every alert carries a recommended action. For example, Congestion gives *"apply QoS / load-balance traffic or upgrade link capacity"*.

### 3.5 Real network monitoring (`live_network.py`)
| Data | Source on Linux/macOS | Source on Windows |
|---|---|---|
| CPU, RAM, interfaces, throughput | `psutil` | `psutil` |
| Default gateway | `ip route` | `route print` |
| Latency and packet loss | `ping -c 4` | `ping -n 4` |
| LAN devices | `ip neigh` (ARP table) | `arp -a` |

The real measurements are converted into the same five features and passed to the same AI model.
The anomaly detector is switched off for the real host, because a home PC's idle traffic naturally
differs from the simulated enterprise baseline.

### 3.6 Web console (`dashboard.py`)
Built with **Streamlit** and **Altair** charts, with the topology drawn in Graphviz. `auth.py` checks the
login, `inventory.py` holds the device inventory and topology, and `ui.py` holds the theme and components.

---

## 4. Project structure

```
NMS_MiniProject/
├── run_windows.bat          # Windows: double-click to set up + host (calls setup_and_run.ps1)
├── setup_and_run.ps1        # Windows automation: Python check, venv, packages, training, firewall, LAN hosting
├── run.sh                   # bash automation for Git Bash / WSL / Linux / macOS
├── run_all.sh               # minimal pipeline script (generate -> train -> monitor -> dashboard)
├── requirements.txt         # Python dependencies
├── README.md                # this file
│
├── dashboard.py             # NetGuard AI web console (login + 7 pages)
├── auth.py                  # authentication (hashed passwords, lockout)
├── inventory.py             # device inventory, interfaces, topology
├── live_network.py          # REAL host/network telemetry (cross-platform)
├── ui.py                    # theme, CSS, KPI cards, chart helpers
├── fault_predictor.py       # prediction + alert logic
├── generate_data.py         # simulated telemetry generator
├── train_model.py           # model training + evaluation
├── monitor.py               # command-line live monitor
├── make_diagram.py          # draws outputs/architecture.png
├── make_report.py           # builds NMS_MiniProject_Report.docx
├── .streamlit/config.toml   # dark theme + server settings
│
├── data/network_metrics.csv         # dataset (12,000 labelled records)
├── models/fault_model.joblib        # trained model
├── outputs/                         # metrics.txt, confusion_matrix.png, feature_importance.png,
│                                    # architecture.png, alerts.csv
├── screenshots/                     # execution screenshots
└── NMS_MiniProject_Report.docx      # project report
```

---

## 5. Requirements

* **Python 3.10 or newer**. Windows users can let `setup_and_run.ps1` install it with `winget`.
* Internet access on the **first run only**, to download the packages.
* About 600 MB of disk space for the virtual environment.
* Python packages (installed automatically): `numpy`, `pandas`, `scikit-learn`, `matplotlib`, `joblib`, `streamlit`, `altair`, `python-docx`, `psutil`.

---

## 6. Run on Windows (automated)

### Option A: double-click (easiest)
1. Install Python 3.10+ from https://www.python.org/downloads/ and tick **"Add python.exe to PATH"**.
2. Extract the project folder.
3. Double-click **`run_windows.bat`**.

### Option B: from PowerShell (with options)
```powershell
cd C:\path\to\NMS_MiniProject
powershell -ExecutionPolicy Bypass -File .\setup_and_run.ps1
```

### What the script does automatically
| Step | Action |
|---|---|
| 1 | Finds Python 3.10+ (`py -3`, `python` or `python3`). If none is found, offers to install Python 3.12 with **winget** |
| 2 | Creates `venv\` and installs `requirements.txt`. Later runs skip this step unless `requirements.txt` changes |
| 3 | Generates the dataset and **trains the AI model on this PC**, so it always matches the installed library versions |
| 4 | Detects the PC's **LAN IP**, the network type (Private/Public) and a **free port**. If 8501 is busy it tries 8502, 8503 and so on |
| 5 | Offers to add a **Windows Firewall inbound rule** for the port (Private/Domain networks, UAC prompt). If the Wi-Fi is marked *Public*, it offers to mark it *Private* |
| 6 | Starts the server on `0.0.0.0:<port>`, prints the URLs, saves them to `ACCESS_URL.txt` and opens the browser |

### PowerShell options
| Option | Meaning |
|---|---|
| `-Port 8600` | Host on a different port |
| `-Retrain` | Regenerate the dataset and retrain the model |
| `-Reinstall` | Delete and recreate the virtual environment |
| `-LocalOnly` | Host on this PC only (`127.0.0.1`); other devices cannot connect |
| `-SkipFirewall` | Do not touch Windows Firewall |
| `-NoBrowser` | Do not open the browser automatically |
| `-RemoveFirewallRule` | Remove the firewall rule created by the script, then exit |

The same options work with the batch file, for example `run_windows.bat -Port 8600 -Retrain`.

> If PowerShell says *"running scripts is disabled on this system"*, use `run_windows.bat`
> (it already uses `-ExecutionPolicy Bypass`), or run:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

---

## 7. Run with bash: Git Bash, WSL, Linux, macOS

```bash
cd NMS_MiniProject
chmod +x run.sh
./run.sh                    # setup + host on the LAN at port 8501
```

| Option | Meaning |
|---|---|
| `--port 8600` | Use another port (the next free one is picked automatically if busy) |
| `--retrain` | Regenerate the dataset and retrain the model |
| `--reinstall` | Recreate the virtual environment |
| `--local-only` | Host on this machine only (`127.0.0.1`) |
| `--no-browser` | Do not open the browser |
| `--help` | Show the usage |

Platform notes:
* **Git Bash on Windows:** works directly. Firewall rules need admin rights; the script prints the exact `netsh` command to run. `run_windows.bat` adds the rule for you.
* **WSL2:** WSL runs behind NAT, so other devices cannot reach it directly. The script prints the `netsh portproxy` commands that forward the port. Running `run_windows.bat` natively is simpler.
* **Linux:** if `ufw` is active, the script offers to run `sudo ufw allow <port>/tcp`. On Debian, Ubuntu or Kali you may first need `sudo apt install python3-venv`.
* **macOS:** click **Allow** when macOS asks about incoming connections for Python.

---

## 8. Manual setup: every command step by step

Use these if you prefer not to use the automation scripts.

### Windows (Command Prompt or PowerShell)
```powershell
cd C:\path\to\NMS_MiniProject
python -m venv venv
venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt

python generate_data.py                    # 1. create the dataset
python train_model.py                      # 2. train + evaluate the AI model
python make_diagram.py                     # 3. (optional) architecture diagram
python monitor.py --minutes 30             # 4. (optional) CLI live monitor
streamlit run dashboard.py --server.address 0.0.0.0 --server.port 8501   # 5. web console on the LAN
```

### Linux / macOS / Git Bash
```bash
cd NMS_MiniProject
python3 -m venv venv
source venv/bin/activate                   # Git Bash: source venv/Scripts/activate
python -m pip install --upgrade pip
pip install -r requirements.txt

python generate_data.py
python train_model.py
python make_diagram.py
python monitor.py --minutes 30
streamlit run dashboard.py --server.address 0.0.0.0 --server.port 8501
```

Open http://localhost:8501 and log in with `admin` / `adminnms`.

---

## 9. Hosting on your local network (LAN)

1. Start the app with an automation script, or with `--server.address 0.0.0.0` when running it manually.
2. Find this computer's IP address. The scripts print it, or you can look it up:
   * Windows: `ipconfig` and look for the **IPv4 Address** of your Wi-Fi/Ethernet adapter
   * Linux: `ip -4 addr` or `hostname -I`
   * macOS: `ipconfig getifaddr en0`
3. On a phone or laptop **connected to the same Wi-Fi**, open `http://<that-IP>:8501`.
4. If it does not load, the firewall is blocking it:
   * **Windows** (Administrator PowerShell):
     ```powershell
     New-NetFirewallRule -DisplayName "NetGuard AI NMS (TCP)" -Direction Inbound -Protocol TCP -LocalPort 8501 -Action Allow -Profile Private,Domain
     # if your Wi-Fi is marked "Public", either mark it Private:
     Get-NetConnectionProfile
     Set-NetConnectionProfile -InterfaceIndex <index> -NetworkCategory Private
     ```
     or with `netsh` (Administrator Command Prompt):
     ```bat
     netsh advfirewall firewall add rule name="NetGuard AI NMS (TCP)" dir=in action=allow protocol=TCP localport=8501 profile=private,domain
     ```
   * **Linux (ufw):** `sudo ufw allow 8501/tcp`
   * **Linux (firewalld):** `sudo firewall-cmd --add-port=8501/tcp`
5. Some college or office Wi-Fi networks use **client isolation**, which blocks device-to-device traffic. In that case use a phone hotspot that both devices join.

> The app is only reachable inside your local network. It is **not** published to the internet,
> because your router does not forward the port.

---

## 10. Using the web console

1. **Sign in** with `admin` / `adminnms`.
2. **Overview:** check the KPIs and the topology map. A red node is a device with an active fault; a dashed red link is a predicted link failure.
3. **Device Inventory:** pick a device to see its system, hardware and live status, and its interfaces.
4. **Performance:** choose a device to see its four metric trends. The red dashed line is the threshold, and the dot colour is the AI prediction.
5. **Alarms & Events:** filter by severity, device or condition, then click **Export alerts (CSV)**.
6. **Live Network:** the real data from this PC. **Demo tip:** turn Wi-Fi off for a few seconds. Packet loss jumps and the AI raises a fault, then it recovers when you reconnect.
7. **AI Engine:** use the **what-if simulator** sliders. For example, set CPU to 95% and the prediction becomes CPU Overload; set latency to 180 ms and loss to 15% and it becomes Link Failure.
8. **Sidebar:**
   * **Live replay** streams the simulated network minute by minute.
   * **Simulation controls** set the history length and the scenario seed; a different seed gives a different network scenario.
   * **Sign out** ends the session.

---

## 11. Command-line tools

```bash
python generate_data.py                       # default: 2000 samples/device, seed 42
python generate_data.py --samples 5000 --seed 7 --out data/network_metrics.csv

python train_model.py                         # writes models/ + outputs/metrics.txt + plots

python monitor.py                             # 30 simulated minutes, 0.2 s per tick
python monitor.py --minutes 60 --delay 0.5 --seed 99
                                              # alerts are saved to outputs/alerts.csv

python make_diagram.py                        # outputs/architecture.png
python make_report.py                         # NMS_MiniProject_Report.docx

python -c "import auth; print(auth.hash_password('NewPassword'))"   # hash for a new user/password
```
To add a user or change the password, put the new hash in the `USERS` dictionary in `auth.py`.

---

## 12. Results
| Metric | Value |
|---|---|
| Test accuracy | **98.2 %** |
| Fault detection rate | **96.0 %** |
| False alarm rate | **0.5 %** |
| Accuracy on 5 unseen scenarios | 98.3 – 99.2 % |

Latency and packet loss are the most important features, followed by CPU (`outputs/feature_importance.png`).

---

## 13. Troubleshooting

| Problem | Fix |
|---|---|
| `python` is not recognised / opens the Microsoft Store | Install Python from python.org with **"Add to PATH"** ticked, or let `setup_and_run.ps1` install it with winget. You can also disable the Store aliases: *Settings → Apps → Advanced app settings → App execution aliases* |
| "running scripts is disabled" | Use `run_windows.bat`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `pip install` fails | Check your internet connection or proxy, then run `run_windows.bat -Reinstall` / `./run.sh --reinstall` |
| Port already in use | The scripts pick the next free port automatically. Manually, add `--server.port 8600` |
| Other devices cannot connect | Use the same Wi-Fi, allow the firewall (section 9), mark the network *Private*, and check for client isolation |
| Model or version error (`InconsistentVersionWarning`) | Retrain: `run_windows.bat -Retrain`, `./run.sh --retrain` or `python train_model.py` |
| Live Network shows the gateway as "-" | Non-English Windows labels its output differently. Ping and LAN data still work |
| Browser shows a blank page | Refresh with Ctrl+F5, and wait a few seconds on the first load |
| `ensurepip is not available` (Debian/Kali) | `sudo apt install python3-venv` |

---

## 14. Stop, reset and uninstall

```bash
# Stop the server:   press Ctrl+C in the terminal (or close the window)

# Windows - stop a server left running in the background
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object CommandLine -match 'streamlit' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
# Linux/macOS
pkill -f "streamlit run dashboard.py"

# Retrain from scratch
run_windows.bat -Retrain            # Windows
./run.sh --retrain                  # bash

# Remove the Windows firewall rule
run_windows.bat -RemoveFirewallRule
# or (Administrator):  netsh advfirewall firewall delete rule name="NetGuard AI NMS (TCP)"

# Uninstall: delete the virtual environment (or the whole folder)
rmdir /s /q venv                    # Windows
rm -rf venv                         # Linux/macOS
```

---

## 15. Security notes
* Passwords are stored as **salted SHA-256 hashes** (`auth.py`), never in plain text. Five failed logins lock the console for 30 s.
* The login is suitable for a **lab or college demo**. Before any real deployment, use HTTPS, per-user salts or bcrypt, and a proper session timeout.
* The firewall rule applies only to **Private/Domain** networks and only to the chosen TCP port.
* Use `-LocalOnly` / `--local-only` when you do not want other devices to connect.

---

## 16. Command reference (all commands)

| Purpose | Windows | Linux / macOS / Git Bash |
|---|---|---|
| One-click setup + LAN hosting | `run_windows.bat` | `./run.sh` |
| Same, other port | `run_windows.bat -Port 8600` | `./run.sh --port 8600` |
| Retrain model | `run_windows.bat -Retrain` | `./run.sh --retrain` |
| Reinstall packages | `run_windows.bat -Reinstall` | `./run.sh --reinstall` |
| This computer only | `run_windows.bat -LocalOnly` | `./run.sh --local-only` |
| No auto browser | `run_windows.bat -NoBrowser` | `./run.sh --no-browser` |
| Skip firewall | `run_windows.bat -SkipFirewall` | (firewall is only suggested) |
| Remove firewall rule | `run_windows.bat -RemoveFirewallRule` | `sudo ufw delete allow 8501/tcp` |
| Create venv | `python -m venv venv` | `python3 -m venv venv` |
| Activate venv | `venv\Scripts\activate` | `source venv/bin/activate` |
| Install packages | `pip install -r requirements.txt` | `pip install -r requirements.txt` |
| Generate dataset | `python generate_data.py` | `python generate_data.py` |
| Train model | `python train_model.py` | `python train_model.py` |
| CLI monitor | `python monitor.py --minutes 30` | `python monitor.py --minutes 30` |
| Web console (LAN) | `streamlit run dashboard.py --server.address 0.0.0.0 --server.port 8501` | same |
| Architecture diagram | `python make_diagram.py` | `python make_diagram.py` |
| Build report | `python make_report.py` | `python make_report.py` |
| Find your IP | `ipconfig` | `ip -4 addr` / `ipconfig getifaddr en0` |
| Open firewall port | `netsh advfirewall firewall add rule name="NetGuard AI NMS (TCP)" dir=in action=allow protocol=TCP localport=8501 profile=private,domain` | `sudo ufw allow 8501/tcp` |
| Stop server | `Ctrl+C` (or close the window) | `Ctrl+C` / `pkill -f "streamlit run dashboard.py"` |
