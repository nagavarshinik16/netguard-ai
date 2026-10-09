#!/usr/bin/env bash
# =============================================================================
#  NetGuard AI - automated setup and LAN hosting (bash)
#  Works in: Git Bash / WSL on Windows, Linux, macOS
#
#  Usage:  ./run.sh [--port N] [--retrain] [--reinstall] [--local-only]
#                   [--no-browser] [--help]
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PORT=8501; RETRAIN=0; REINSTALL=0; LOCAL_ONLY=0; NO_BROWSER=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port) PORT="$2"; shift 2 ;;
        --retrain) RETRAIN=1; shift ;;
        --reinstall) REINSTALL=1; shift ;;
        --local-only) LOCAL_ONLY=1; shift ;;
        --no-browser) NO_BROWSER=1; shift ;;
        -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
    esac
done

C='\033[36m'; G='\033[32m'; Y='\033[33m'; R='\033[31m'; W='\033[1m'; N='\033[0m'
step() { echo -e "\n${C}[$1] $2${N}"; }
ok()   { echo -e "    ${G}OK${N}  $1"; }
warn() { echo -e "    ${Y}!!${N}  $1"; }
die()  { echo -e "\n    ${R}ERROR:${N} $1"; exit 1; }

# ------------------------------------------------------------ platform
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
    Darwin*) OS="macos" ;;
    *) OS="linux"; grep -qi microsoft /proc/version 2>/dev/null && OS="wsl" ;;
esac
if [[ "$OS" == "windows" ]]; then VPY="venv/Scripts/python.exe"; else VPY="venv/bin/python"; fi

echo -e "${C}  =====================================================${N}"
echo -e "${W}     NetGuard AI  -  Intelligent Network Management${N}"
echo -e "     Automated setup and LAN hosting  (platform: $OS)"
echo -e "${C}  =====================================================${N}"

# ------------------------------------------------------------ 1. python
step 1 "Checking Python 3.10+"
PY=""
for cand in python3 python "py -3"; do
    if command -v ${cand%% *} >/dev/null 2>&1; then
        v=$($cand -c 'import sys; print("%d %d" % sys.version_info[:2])' 2>/dev/null || true)
        if [[ -n "$v" ]] && (( ${v% *} == 3 && ${v#* } >= 10 )); then PY="$cand"; break; fi
    fi
done
[[ -n "$PY" ]] || die "Python 3.10+ not found. Install it (python.org / 'sudo apt install python3 python3-venv' / 'brew install python')."
ok "Python $($PY --version 2>&1 | cut -d' ' -f2) ($PY)"

# ------------------------------------------------------------ 2. venv + packages
step 2 "Preparing virtual environment and packages"
[[ $REINSTALL == 1 && -d venv ]] && rm -rf venv && ok "Old venv removed"
if [[ ! -x "$VPY" ]]; then
    $PY -m venv venv || die "Could not create venv (Debian/Ubuntu/Kali: sudo apt install python3-venv)."
    ok "Virtual environment created"
fi
HASH=$("$VPY" -c 'import hashlib; print(hashlib.sha256(open("requirements.txt","rb").read()).hexdigest())')
if [[ -f venv/.requirements.sha256 && "$(cat venv/.requirements.sha256)" == "$HASH" ]]; then
    ok "Packages already installed"
else
    echo "    Installing packages (first run takes a few minutes)..."
    "$VPY" -m pip install --upgrade pip --quiet --disable-pip-version-check
    "$VPY" -m pip install -r requirements.txt --quiet --disable-pip-version-check \
        || die "Package installation failed (check your internet connection)."
    echo "$HASH" > venv/.requirements.sha256
    ok "Packages installed"
fi

# ------------------------------------------------------------ 3. dataset + model
step 3 "Preparing dataset and AI model"
if [[ $RETRAIN == 1 || ! -f models/.trained_on_this_pc || ! -f models/fault_model.joblib ]]; then
    out=$("$VPY" generate_data.py) || die "Dataset generation failed."
    echo "    ${out%%$'\n'*}"
    out=$("$VPY" train_model.py) || die "Model training failed."
    grep -E "Overall accuracy|Fault detection|False alarm" <<< "$out" | sed 's/^/    /'
    "$VPY" make_diagram.py >/dev/null
    date > models/.trained_on_this_pc
    ok "Model trained on this machine"
else
    ok "Trained model found (use --retrain to rebuild)"
fi

# ------------------------------------------------------------ 4. network
step 4 "Detecting network"
LAN_IP=$("$VPY" -c 'import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("8.8.8.8", 80)); print(s.getsockname()[0])' 2>/dev/null || echo "127.0.0.1")
[[ "$LAN_IP" == "127.0.0.1" ]] && warn "No network connection - hosting on this machine only" || ok "LAN IP address: $LAN_IP"

port_free() { "$VPY" -c "import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); sys.exit(s.connect_ex(('127.0.0.1', $1)) == 0)"; }
WANT=$PORT
for ((p=PORT; p<=PORT+20; p++)); do if port_free $p; then PORT=$p; break; fi; done
port_free $PORT || die "No free port between $WANT and $((WANT+20))."
[[ $PORT != "$WANT" ]] && warn "Port $WANT is busy - using $PORT"
ok "Port: $PORT"

# ------------------------------------------------------------ 5. firewall hints
step 5 "Firewall"
if [[ $LOCAL_ONLY == 1 ]]; then
    ok "Local-only mode - firewall unchanged"
else
    case "$OS" in
        linux)
            if command -v ufw >/dev/null && sudo -n ufw status 2>/dev/null | grep -q "Status: active"; then
                read -rp "    ufw is active. Allow TCP $PORT from the LAN? [Y/n] " a
                [[ "${a:-y}" =~ ^[Yy] ]] && sudo ufw allow "$PORT"/tcp && ok "ufw rule added"
            else ok "No active ufw firewall detected"; fi ;;
        windows)
            warn "Windows Firewall may block other devices. Run once in an *Administrator* terminal:"
            echo "      netsh advfirewall firewall add rule name=\"NetGuard AI NMS (TCP)\" dir=in action=allow protocol=TCP localport=$PORT profile=private,domain"
            echo "      (or simply use run_windows.bat, which does this automatically)" ;;
        wsl)
            warn "WSL2 is behind NAT: other devices cannot reach it directly."
            echo "      In an *Administrator* PowerShell on Windows run:"
            echo "      netsh interface portproxy add v4tov4 listenport=$PORT listenaddress=0.0.0.0 connectport=$PORT connectaddress=$LAN_IP"
            echo "      netsh advfirewall firewall add rule name=\"NetGuard AI NMS (TCP)\" dir=in action=allow protocol=TCP localport=$PORT"
            echo "      Then use the Windows PC's IP address. (Easier: run run_windows.bat directly on Windows.)" ;;
        macos) ok "macOS may ask to allow incoming connections for Python - click Allow" ;;
    esac
fi

# ------------------------------------------------------------ 6. start
ADDRESS="0.0.0.0"; [[ $LOCAL_ONLY == 1 ]] && ADDRESS="127.0.0.1"
HEADLESS="false"; [[ $NO_BROWSER == 1 || "$OS" == "wsl" ]] && HEADLESS="true"
step 6 "Starting NetGuard AI"
echo -e "\n${C}  -----------------------------------------------------${N}"
echo -e "   This machine  :  ${W}http://localhost:$PORT${N}"
[[ $LOCAL_ONLY == 0 && "$LAN_IP" != "127.0.0.1" ]] && echo -e "   Other devices :  ${W}http://$LAN_IP:$PORT${N}   (same Wi-Fi / LAN)"
echo -e "   Login         :  ${W}admin  /  adminnms${N}"
echo -e "   Stop server   :  press Ctrl+C"
echo -e "${C}  -----------------------------------------------------${N}\n"
printf "NetGuard AI is hosted at:\n  This machine  : http://localhost:%s\n  Other devices : http://%s:%s\n  Login         : admin / adminnms\nStarted: %s\n" \
    "$PORT" "$LAN_IP" "$PORT" "$(date)" > ACCESS_URL.txt

exec "$VPY" -m streamlit run dashboard.py --server.address "$ADDRESS" --server.port "$PORT" \
    --server.headless "$HEADLESS" --browser.serverAddress localhost
