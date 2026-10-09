<#
.SYNOPSIS
    NetGuard AI - automated setup and LAN hosting for Windows.

.DESCRIPTION
    1. Finds Python 3.10+ (offers to install it with winget if missing)
    2. Creates a virtual environment and installs the dependencies
    3. Generates the dataset and trains the AI model on this PC
    4. Detects this PC's LAN IP address and a free port
    5. Opens the port in Windows Firewall (Private network) so other devices on the
       same Wi-Fi / LAN can reach the dashboard
    6. Starts the NetGuard AI web console on 0.0.0.0 and opens the browser

.EXAMPLE
    .\setup_and_run.ps1
    .\setup_and_run.ps1 -Port 8600
    .\setup_and_run.ps1 -Retrain
    .\setup_and_run.ps1 -LocalOnly
    .\setup_and_run.ps1 -RemoveFirewallRule
#>
param(
    [int]$Port = 8501,          # port to host on (next free port is used if busy)
    [switch]$Retrain,           # regenerate the dataset and retrain the model
    [switch]$Reinstall,         # delete and recreate the virtual environment
    [switch]$SkipFirewall,      # do not touch Windows Firewall
    [switch]$LocalOnly,         # host on this PC only (127.0.0.1), not on the LAN
    [switch]$NoBrowser,         # do not open the browser automatically
    [switch]$RemoveFirewallRule # remove the firewall rule created by this script and exit
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "NetGuard AI - Network Management System"
$RuleName = "NetGuard AI NMS (TCP)"
$VenvPy = Join-Path $PSScriptRoot "venv\Scripts\python.exe"

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Fail($msg) {
    Write-Host "`n    ERROR: $msg" -ForegroundColor Red
    Read-Host "`nPress Enter to exit"
    exit 1
}
function Ask($question, $default = "y") {
    $hint = if ($default -eq "y") { "[Y/n]" } else { "[y/N]" }
    $a = Read-Host "    $question $hint"
    if ([string]::IsNullOrWhiteSpace($a)) { $a = $default }
    return $a.Trim().ToLower().StartsWith("y")
}
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Invoke-Elevated($command) {
    # Runs one PowerShell command as Administrator (shows the UAC prompt)
    if (Test-Admin) { Invoke-Expression $command; return $true }
    try {
        $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
            -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command $command"
        return ($p.ExitCode -eq 0)
    } catch { return $false }
}

Write-Host ""
Write-Host "  =====================================================" -ForegroundColor DarkCyan
Write-Host "     NetGuard AI  -  Intelligent Network Management     " -ForegroundColor White
Write-Host "     Automated setup and LAN hosting (Windows)          " -ForegroundColor Gray
Write-Host "  =====================================================" -ForegroundColor DarkCyan

# ---------------------------------------------------------------- remove rule mode
if ($RemoveFirewallRule) {
    if (Invoke-Elevated "Remove-NetFirewallRule -DisplayName '$RuleName' -ErrorAction SilentlyContinue") {
        Ok "Firewall rule '$RuleName' removed."
    } else { Warn "Could not remove the rule (administrator rights needed)." }
    exit 0
}

# ---------------------------------------------------------------- 1. Python
Step 1 "Checking Python 3.10+"
function Find-Python {
    foreach ($cand in @(@("py", "-3"), @("python"), @("python3"))) {
        $exe = $cand[0]; $pre = @($cand | Select-Object -Skip 1)
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        try {
            $v = & $exe @pre -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
            if ($LASTEXITCODE -eq 0 -and $v -match '^(\d+)\.(\d+)$') {
                if ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 10) {
                    return @{ Exe = $exe; Pre = $pre; Version = $v.Trim() }
                }
            }
        } catch { }
    }
    return $null
}
$py = Find-Python
if (-not $py) {
    Warn "Python 3.10 or newer was not found."
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask "Install Python 3.12 now using winget?")) {
        winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [Environment]::GetEnvironmentVariable("Path", "User")
        $py = Find-Python
    }
    if (-not $py) {
        Fail ("Install Python 3.10+ from https://www.python.org/downloads/ and tick " +
              "'Add python.exe to PATH', then run this script again.")
    }
}
Ok "Python $($py.Version) ($($py.Exe))"

# ---------------------------------------------------------------- 2. venv + packages
Step 2 "Preparing virtual environment and packages"
if ($Reinstall -and (Test-Path "venv")) { Remove-Item -Recurse -Force "venv"; Ok "Old venv removed" }
if (-not (Test-Path $VenvPy)) {
    & $py.Exe @($py.Pre + @("-m", "venv", "venv"))
    if ($LASTEXITCODE -ne 0) { Fail "Could not create the virtual environment." }
    Ok "Virtual environment created"
}
$reqHash = (Get-FileHash "requirements.txt" -Algorithm SHA256).Hash
$stamp = "venv\.requirements.sha256"
if ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $reqHash)) {
    Ok "Packages already installed"
} else {
    Write-Host "    Installing packages (first run takes a few minutes)..." -ForegroundColor Gray
    & $VenvPy -m pip install --upgrade pip --quiet --disable-pip-version-check
    & $VenvPy -m pip install -r requirements.txt --quiet --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { Fail "Package installation failed (check your internet connection)." }
    Set-Content -Path $stamp -Value $reqHash
    Ok "Packages installed"
}

# ---------------------------------------------------------------- 3. dataset + model
Step 3 "Preparing dataset and AI model"
$trained = "models\.trained_on_this_pc"
if ($Retrain -or -not (Test-Path $trained) -or -not (Test-Path "models\fault_model.joblib")) {
    $out = & $VenvPy generate_data.py
    if ($LASTEXITCODE -ne 0) { Fail "Dataset generation failed." }
    Write-Host "    $($out | Select-Object -First 1)"
    $out = & $VenvPy train_model.py
    if ($LASTEXITCODE -ne 0) { Fail "Model training failed." }
    $out | Select-String "Overall accuracy|Fault detection|False alarm" | ForEach-Object { Write-Host "    $_" }
    & $VenvPy make_diagram.py | Out-Null
    Set-Content -Path $trained -Value (Get-Date -Format s)
    Ok "Model trained on this PC"
} else { Ok "Trained model found (use -Retrain to rebuild)" }

# ---------------------------------------------------------------- 4. network
Step 4 "Detecting network"
$lanIp = $null
try {
    $lanIp = & $VenvPy -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); print(s.getsockname()[0])" 2>$null
    if ($LASTEXITCODE -ne 0) { $lanIp = $null }
} catch { $lanIp = $null }
if (-not $lanIp) {
    $cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1
    if ($cfg) { $lanIp = $cfg.IPv4Address.IPAddress }
}
if (-not $lanIp) { $lanIp = "127.0.0.1"; Warn "No network connection detected - hosting on this PC only." }
else { Ok "LAN IP address: $lanIp" }

$netProfile = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object -First 1
if ($netProfile) { Ok "Network '$($netProfile.Name)' is $($netProfile.NetworkCategory)" }

$freePort = $null
foreach ($p in $Port..($Port + 20)) {
    if (-not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { $freePort = $p; break }
}
if (-not $freePort) { Fail "No free port found between $Port and $($Port + 20)." }
if ($freePort -ne $Port) { Warn "Port $Port is busy - using $freePort" }
$Port = $freePort
Ok "Port: $Port"

# ---------------------------------------------------------------- 5. firewall
Step 5 "Windows Firewall"
if ($LocalOnly) {
    Ok "Local-only mode - firewall unchanged"
} elseif ($SkipFirewall) {
    Warn "Skipped (-SkipFirewall). Other devices may be blocked."
} else {
    $rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    $portOk = $false
    if ($rule) {
        $ports = ($rule | Get-NetFirewallPortFilter).LocalPort
        $portOk = $ports -contains "$Port"
    }
    if ($portOk) {
        Ok "Inbound rule for TCP $Port already exists"
    } elseif (Ask "Allow other devices on your Private network to open the dashboard (adds a firewall rule, needs admin)?") {
        $cmd = "Remove-NetFirewallRule -DisplayName '$RuleName' -ErrorAction SilentlyContinue; " +
               "New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Protocol TCP " +
               "-LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null"
        if (Invoke-Elevated $cmd) { Ok "Firewall rule added: TCP $Port (Private/Domain networks)" }
        else { Warn "Firewall rule not added (UAC declined). Other devices may be blocked." }
    } else { Warn "Firewall unchanged. Other devices may be blocked." }

    if ($netProfile -and $netProfile.NetworkCategory -eq "Public") {
        Warn "This network is marked PUBLIC, so the Private rule does not apply."
        if (Ask "Mark '$($netProfile.Name)' as a Private (trusted home/college) network?" "n") {
            if (Invoke-Elevated "Set-NetConnectionProfile -InterfaceIndex $($netProfile.InterfaceIndex) -NetworkCategory Private") {
                Ok "Network set to Private"
            } else { Warn "Could not change the network category." }
        }
    }
}

# ---------------------------------------------------------------- 6. start
$address = if ($LocalOnly) { "127.0.0.1" } else { "0.0.0.0" }
$headless = if ($NoBrowser) { "true" } else { "false" }
Step 6 "Starting NetGuard AI"
Write-Host ""
Write-Host "  -----------------------------------------------------" -ForegroundColor DarkCyan
Write-Host "   This PC       :  http://localhost:$Port" -ForegroundColor White
if (-not $LocalOnly -and $lanIp -ne "127.0.0.1") {
    Write-Host "   Other devices :  http://${lanIp}:$Port   (same Wi-Fi / LAN)" -ForegroundColor White
}
Write-Host "   Login         :  admin  /  adminnms" -ForegroundColor White
Write-Host "   Stop server   :  press Ctrl+C or close this window" -ForegroundColor Gray
Write-Host "  -----------------------------------------------------" -ForegroundColor DarkCyan
Write-Host ""
Set-Content -Path "ACCESS_URL.txt" -Value @(
    "NetGuard AI is hosted at:",
    "  This PC       : http://localhost:$Port",
    "  Other devices : http://${lanIp}:$Port",
    "  Login         : admin / adminnms",
    "Started: $(Get-Date)")

& $VenvPy -m streamlit run dashboard.py --server.address $address --server.port $Port `
    --server.headless $headless --browser.serverAddress localhost
