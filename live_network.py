"""
REAL network monitoring of the machine the NMS runs on (no simulation):
host info, interfaces, CPU/memory, interface throughput, ICMP reachability
(latency + packet loss) to the gateway and internet hosts, and LAN neighbours (ARP table).

The live metrics are fed into the same trained AI model as the simulated devices.
"""
import platform
import re
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

import psutil

IS_WINDOWS = platform.system() == "Windows"
IPV4 = r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"


def _run(cmd, timeout):
    """Run a system command and return its stdout ('' on any failure). No console window on Windows."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                              errors="replace",
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def _iface_for_ip(ip):
    for name, addrs in psutil.net_if_addrs().items():
        if any(a.family == socket.AF_INET and a.address == ip for a in addrs):
            return name
    return None


def parse_route_linux(out):
    m = re.search(r"default via (\S+) dev (\S+)", out)
    return (m.group(1), m.group(2)) if m else (None, None)


def parse_route_windows(out):
    """`route print -4 0.0.0.0` -> (gateway, local interface IP), lowest metric first."""
    routes = re.findall(rf"^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+({IPV4})\s+({IPV4})\s+(\d+)", out, re.M)
    if not routes:
        return None, None
    gw, local_ip, _ = min(routes, key=lambda r: int(r[2]))
    return gw, local_ip


def default_gateway():
    if IS_WINDOWS:
        gw, local_ip = parse_route_windows(_run(["route", "print", "-4", "0.0.0.0"], 5))
        return gw, (_iface_for_ip(local_ip) if local_ip else None)
    return parse_route_linux(_run(["ip", "route", "show", "default"], 2))


def host_info():
    gw, iface = default_gateway()
    ip = "-"
    for a in psutil.net_if_addrs().get(iface or "", []):
        if a.family == socket.AF_INET:
            ip = a.address
    boot = psutil.boot_time()
    up = time.time() - boot
    return {"hostname": socket.gethostname(), "os": f"{platform.system()} {platform.release()}",
            "ip": ip, "gateway": gw or "-", "interface": iface or "-",
            "uptime": f"{int(up // 86400)}d {int(up % 86400 // 3600)}h {int(up % 3600 // 60)}m",
            "cpus": psutil.cpu_count()}


def interfaces():
    stats, addrs = psutil.net_if_stats(), psutil.net_if_addrs()
    io = psutil.net_io_counters(pernic=True)
    rows = []
    for name, st in stats.items():
        ipv4 = next((a.address for a in addrs.get(name, []) if a.family == socket.AF_INET), "-")
        mac = next((a.address for a in addrs.get(name, []) if a.family == psutil.AF_LINK), "-")
        c = io.get(name)
        rows.append({"Interface": name, "IPv4": ipv4, "MAC": mac,
                     "Status": "UP" if st.isup else "DOWN",
                     "Speed": f"{st.speed} Mbps" if st.speed else "n/a", "MTU": st.mtu,
                     "RX (MB)": round(c.bytes_recv / 1e6, 1) if c else 0,
                     "TX (MB)": round(c.bytes_sent / 1e6, 1) if c else 0,
                     "Errors": (c.errin + c.errout) if c else 0,
                     "Drops": (c.dropin + c.dropout) if c else 0})
    return rows


def parse_ping(out, count):
    """Works for Linux and Windows ping output.
    Latency = mean of per-reply times ('time=10.5 ms', 'time=11ms', 'time<1ms');
    loss = reported loss %, or computed from the number of replies."""
    times = [float(t) for t in re.findall(r"time[=<]\s*([\d.]+)\s*ms", out, re.I)]
    loss = re.search(r"([\d.]+)%\s*(?:packet\s*)?loss", out, re.I)
    loss_pct = float(loss.group(1)) if loss else round(100 * (1 - len(times) / count), 1)
    return (sum(times) / len(times) if times else None), (loss_pct if times else 100.0)


def ping(target, count=4):
    """ICMP ping -> (latency_ms, packet_loss_pct). Unreachable -> (None, 100)."""
    if IS_WINDOWS:
        cmd = ["ping", "-n", str(count), "-w", "1000", target]
        timeout = count * 2 + 3
    else:
        cmd = ["ping", "-c", str(count), "-i", "0.2", "-W", "1", target]
        timeout = count + 3
    return parse_ping(_run(cmd, timeout), count)


def ping_targets():
    gw, _ = default_gateway()
    targets = {"Default gateway": gw or "192.168.0.1", "Google DNS": "8.8.8.8",
               "Cloudflare DNS": "1.1.1.1", "google.com": "google.com"}
    with ThreadPoolExecutor(len(targets)) as ex:
        results = dict(zip(targets, ex.map(ping, targets.values())))
    return [{"Target": k, "Address": targets[k],
             "Latency (ms)": None if v[0] is None else round(v[0], 1),
             "Packet loss %": v[1],
             "Status": "UP" if v[1] < 100 else "DOWN"} for k, v in results.items()]


def parse_neigh_linux(out):
    rows = []
    for line in out.splitlines():
        m = re.match(r"(\S+) dev (\S+)(?: lladdr (\S+))?.*?(\S+)$", line.strip())
        if m:
            rows.append({"IP address": m.group(1), "Interface": m.group(2),
                         "MAC": m.group(3) or "-", "State": m.group(4)})
    return rows


def parse_arp_windows(out, iface_lookup=lambda ip: ip):
    """`arp -a` output; skips broadcast and multicast entries."""
    rows, iface = [], "-"
    for line in out.splitlines():
        head = re.match(rf"\s*\S+:\s*({IPV4})\s+---", line)  # "Interface: 192.168.0.15 --- 0xb"
        if head:
            iface = iface_lookup(head.group(1)) or head.group(1)
            continue
        m = re.match(rf"\s*({IPV4})\s+([0-9a-fA-F]{{2}}(?:-[0-9a-fA-F]{{2}}){{5}})\s+(\w+)", line)
        if not m:
            continue
        ip, mac, kind = m.groups()
        first = int(ip.split(".")[0])
        if ip.endswith(".255") or 224 <= first <= 239 or mac.lower() == "ff-ff-ff-ff-ff-ff":
            continue
        rows.append({"IP address": ip, "Interface": iface, "MAC": mac.replace("-", ":").lower(),
                     "State": kind.upper()})
    return rows


def neighbours():
    """Devices seen on the LAN (ARP / neighbour table) - real network discovery."""
    if IS_WINDOWS:
        rows = parse_arp_windows(_run(["arp", "-a"], 5), _iface_for_ip)
    else:
        rows = parse_neigh_linux(_run(["ip", "-4", "neigh"], 2))
    return sorted(rows, key=lambda r: tuple(int(x) for x in r["IP address"].split(".")))


class ThroughputMeter:
    """Computes interface throughput between successive calls."""

    def __init__(self):
        self.last = psutil.net_io_counters()
        self.t = time.time()

    def read(self):
        now, c = time.time(), psutil.net_io_counters()
        dt = max(now - self.t, 1e-3)
        rx = (c.bytes_recv - self.last.bytes_recv) * 8 / dt / 1e6
        tx = (c.bytes_sent - self.last.bytes_sent) * 8 / dt / 1e6
        self.last, self.t = c, now
        return round(rx, 3), round(tx, 3)


def snapshot(meter, link_mbps=100):
    """One real telemetry sample in the same format the AI model was trained on."""
    rx, tx = meter.read()
    pings = ping_targets()
    internet = [p for p in pings if p["Target"] != "Default gateway"]
    lat = [p["Latency (ms)"] for p in internet if p["Latency (ms)"] is not None]
    loss = sum(p["Packet loss %"] for p in internet) / len(internet)
    bandwidth = min(100.0, (rx + tx) / link_mbps * 100)
    latency = sum(lat) / len(lat) if lat else 999.0
    return {
        "timestamp": time.strftime("%H:%M:%S"),
        "cpu": psutil.cpu_percent(interval=None), "memory": psutil.virtual_memory().percent,
        "bandwidth": round(bandwidth, 2), "packet_loss": round(loss, 2), "latency": round(latency, 2),
        "throughput": round(link_mbps * bandwidth / 100 * (1 - loss / 100), 2),
        "rx_mbps": rx, "tx_mbps": tx,
    }, pings
