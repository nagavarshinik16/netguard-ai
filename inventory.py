"""
Device inventory for the simulated enterprise network (what an NMS discovers via SNMP/LLDP):
management IP, MAC, vendor/model, OS, location, interfaces and topology links.
Interface state and counters are derived from the latest telemetry + AI prediction.
"""
import pandas as pd

INVENTORY = {
    "R2-Edge": {
        "ip": "10.10.0.1", "mac": "00:1A:2B:3C:4D:01", "vendor": "Cisco", "model": "ISR 4331",
        "os": "IOS-XE 17.9.4", "serial": "FDO2318A1KQ", "location": "Data Centre - Rack A1",
        "role": "Internet edge router", "base_uptime_h": 2134, "snmp": "v3 (authPriv)",
        "interfaces": [("Gi0/0/0", "203.0.113.10/30", 1000, "WAN - ISP uplink"),
                       ("Gi0/0/1", "10.10.0.1/30", 1000, "to R1-Core"),
                       ("Gi0/0/2", "-", 1000, "unused")],
    },
    "R1-Core": {
        "ip": "10.10.0.2", "mac": "00:1A:2B:3C:4D:02", "vendor": "Cisco", "model": "ASR 1001-X",
        "os": "IOS-XE 17.9.4", "serial": "FXS2241Q0ZP", "location": "Data Centre - Rack A2",
        "role": "Core router", "base_uptime_h": 4120, "snmp": "v3 (authPriv)",
        "interfaces": [("Te0/0/0", "10.10.0.2/30", 10000, "to R2-Edge"),
                       ("Te0/0/1", "10.10.1.1/30", 10000, "to SW2-Dist"),
                       ("Gi0/0/2", "10.10.9.1/24", 1000, "Mgmt")],
    },
    "SW2-Dist": {
        "ip": "10.10.1.2", "mac": "00:1A:2B:3C:4D:03", "vendor": "Cisco", "model": "Catalyst 9300-48P",
        "os": "IOS-XE 17.6.5", "serial": "FOC2335X0LM", "location": "Data Centre - Rack B1",
        "role": "Distribution switch", "base_uptime_h": 3388, "snmp": "v2c",
        "interfaces": [("Te1/1/1", "10.10.1.2/30", 10000, "to R1-Core"),
                       ("Gi1/0/1", "trunk", 1000, "to SW1-Access"),
                       ("Gi1/0/2", "VLAN 20", 1000, "to SRV1-Web"),
                       ("Gi1/0/3", "VLAN 20", 1000, "to SRV2-DB")],
    },
    "SW1-Access": {
        "ip": "10.10.2.2", "mac": "00:1A:2B:3C:4D:04", "vendor": "HPE Aruba", "model": "2930F-24G",
        "os": "ArubaOS-Switch 16.11", "serial": "CN09KP71XZ", "location": "Floor 2 - IDF",
        "role": "Access switch", "base_uptime_h": 987, "snmp": "v2c",
        "interfaces": [("1/1", "trunk", 1000, "to SW2-Dist"),
                       ("1/2-1/24", "VLAN 10", 1000, "User ports (23)")],
    },
    "SRV1-Web": {
        "ip": "10.10.20.11", "mac": "00:50:56:A1:10:11", "vendor": "Dell", "model": "PowerEdge R650",
        "os": "Ubuntu Server 24.04 LTS", "serial": "7HXK2T3", "location": "Data Centre - Rack C1",
        "role": "Web server (nginx)", "base_uptime_h": 512, "snmp": "v3 (authPriv)",
        "interfaces": [("ens192", "10.10.20.11/24", 1000, "to SW2-Dist")],
    },
    "SRV2-DB": {
        "ip": "10.10.20.12", "mac": "00:50:56:A1:10:12", "vendor": "Dell", "model": "PowerEdge R750",
        "os": "Rocky Linux 9.4", "serial": "9JQL4V1", "location": "Data Centre - Rack C2",
        "role": "Database server (PostgreSQL)", "base_uptime_h": 1460, "snmp": "v3 (authPriv)",
        "interfaces": [("ens192", "10.10.20.12/24", 1000, "to SW2-Dist")],
    },
}

# Physical topology (parent -> child)
LINKS = [("Internet", "R2-Edge"), ("R2-Edge", "R1-Core"), ("R1-Core", "SW2-Dist"),
         ("SW2-Dist", "SW1-Access"), ("SW2-Dist", "SRV1-Web"), ("SW2-Dist", "SRV2-DB")]


def inventory_table(latest: pd.DataFrame, minutes_elapsed: int) -> pd.DataFrame:
    """One row per device: static inventory + live status from the latest prediction."""
    status = latest.set_index("device")
    rows = []
    for dev, info in INVENTORY.items():
        s = status.loc[dev] if dev in status.index else None
        up = s is None or s.predicted != "Link Failure" or s.packet_loss < 20
        hours = info["base_uptime_h"] + minutes_elapsed / 60
        rows.append({
            "Hostname": dev, "Mgmt IP": info["ip"], "MAC": info["mac"], "Vendor": info["vendor"],
            "Model": info["model"], "OS / Firmware": info["os"], "Role": info["role"],
            "Location": info["location"],
            "Uptime": f"{int(hours // 24)}d {int(hours % 24)}h",
            "Reachability": "Reachable" if up else "Degraded",
            "Status": s.status if s is not None else "OK",
        })
    return pd.DataFrame(rows)


def interface_table(device: str, sample) -> pd.DataFrame:
    """Simulated interface counters for one device, derived from its latest telemetry."""
    rows = []
    for i, (name, addr, speed, desc) in enumerate(INVENTORY[device]["interfaces"]):
        uplink = i == 0
        util = sample.bandwidth if uplink else max(1.0, sample.bandwidth * 0.35)
        down = uplink and sample.predicted == "Link Failure" and sample.packet_loss > 10
        if desc == "unused":
            oper, util = "admin-down", 0
        else:
            oper = "DOWN" if down else "UP"
        in_mbps = round(speed * util / 100 * 0.6, 1)
        out_mbps = round(speed * util / 100 * 0.4, 1)
        rows.append({
            "Interface": name, "Address / VLAN": addr, "Description": desc,
            "Speed": f"{speed // 1000} Gbps" if speed >= 1000 else f"{speed} Mbps",
            "Oper status": oper, "Utilisation %": round(util, 1),
            "In (Mbps)": 0 if oper != "UP" else in_mbps,
            "Out (Mbps)": 0 if oper != "UP" else out_mbps,
            "Errors/min": int(sample.packet_loss * 12) if uplink else 0,
        })
    return pd.DataFrame(rows)


def topology_dot(latest: pd.DataFrame) -> str:
    """Graphviz DOT of the network, nodes coloured by current AI status."""
    colors = {"OK": "#22c55e", "WARNING": "#eab308", "FAULT": "#ef4444"}
    status = latest.set_index("device")["status"].to_dict()
    pred = latest.set_index("device")["predicted"].to_dict()
    shape = {"router": "ellipse", "switch": "box", "server": "box3d"}
    lines = ['digraph G { rankdir=LR; bgcolor="transparent"; '
             'node [style="filled,rounded", fontname="Helvetica", fontsize=11, fontcolor="white", '
             'penwidth=0]; edge [color="#64748b", penwidth=2, arrowhead=none];',
             '"Internet" [shape=doublecircle, fillcolor="#3b82f6", label="Internet"];']
    for dev, info in INVENTORY.items():
        kind = "router" if dev.startswith("R") else "switch" if dev.startswith("SW") else "server"
        st = status.get(dev, "OK")
        label = f"{dev}\\n{info['ip']}\\n{pred.get(dev, 'Normal')}"
        lines.append(f'"{dev}" [shape={shape[kind]}, fillcolor="{colors[st]}", label="{label}"];')
    for a, b in LINKS:
        bad = status.get(b) == "FAULT" and pred.get(b) == "Link Failure"
        style = ' [color="#ef4444", style=dashed, penwidth=3]' if bad else ""
        lines.append(f'"{a}" -> "{b}"{style};')
    lines.append("}")
    return "\n".join(lines)
