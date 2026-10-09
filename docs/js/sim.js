// Simulated enterprise network: telemetry generator (port of generate_data.py),
// device inventory, interfaces and topology (port of inventory.py).

export const DEVICES = {
  "R1-Core": "router", "R2-Edge": "router", "SW1-Access": "switch",
  "SW2-Dist": "switch", "SRV1-Web": "server", "SRV2-DB": "server",
};

const PROFILES = {
  Normal: { cpu: [35, 10], bandwidth: [40, 12], packet_loss: [0.2, 0.15], latency: [20, 6] },
  Congestion: { cpu: [55, 12], bandwidth: [90, 5], packet_loss: [2.5, 1.2], latency: [85, 25] },
  "Link Failure": { cpu: [30, 12], bandwidth: [12, 8], packet_loss: [14, 6], latency: [160, 50] },
  "CPU Overload": { cpu: [93, 4], bandwidth: [50, 15], packet_loss: [1.0, 0.7], latency: [55, 18] },
};
const LIMITS = { cpu: [0, 100], bandwidth: [0, 100], packet_loss: [0, 100], latency: [1, 1000] };
const EPISODES = [["Normal", 0.55], ["Congestion", 0.17], ["Link Failure", 0.13], ["CPU Overload", 0.15]];
const RAMP = 5; // minutes for a fault to fully develop

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (mu, sd) => {
    const u = 1 - next(), v = next();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo));
  const choice = () => {
    let x = next();
    for (const [name, w] of EPISODES) { if ((x -= w) < 0) return name; }
    return "Normal";
  };
  return { next, normal, int, choice };
}

const clip = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function sample(condition, r, severity) {
  const row = {};
  for (const [m, [mu, sd]] of Object.entries(PROFILES[condition])) {
    const [nmu, nsd] = PROFILES.Normal[m];
    row[m] = clip((1 - severity) * r.normal(nmu, nsd) + severity * r.normal(mu, sd), LIMITS[m]);
  }
  row.throughput = round(1000 * row.bandwidth / 100 * (1 - row.packet_loss / 100), 2);
  row.cpu = round(row.cpu, 2); row.bandwidth = round(row.bandwidth, 2);
  row.packet_loss = round(row.packet_loss, 3); row.latency = round(row.latency, 2);
  return row;
}

/** Generates `minutes` of per-minute telemetry for every device. */
export function generate(minutes = 120, seed = 7, start = Date.now() - minutes * 60000) {
  const r = rng(seed);
  const t0 = Math.floor(start / 60000) * 60000;
  const rows = [];
  for (const [device, type] of Object.entries(DEVICES)) {
    let i = 0;
    while (i < minutes) {
      const cond = r.choice();
      const len = cond === "Normal" ? r.int(15, 50) : r.int(6, 25);
      for (let k = 0; k < len && i + k < minutes; k++) {
        const severity = cond === "Normal" ? 1 : Math.min(1, (k + 1) / RAMP);
        rows.push({ ts: t0 + (i + k) * 60000, device, type, ...sample(cond, r, severity), condition: cond });
      }
      i += len;
    }
  }
  return rows.sort((a, b) => a.ts - b.ts || a.device.localeCompare(b.device));
}

export const INVENTORY = {
  "R2-Edge": { ip: "10.10.0.1", mac: "00:1A:2B:3C:4D:01", vendor: "Cisco", model: "ISR 4331", os: "IOS-XE 17.9.4",
    serial: "FDO2318A1KQ", location: "Data Centre - Rack A1", role: "Internet edge router", uptimeH: 2134, snmp: "v3 (authPriv)",
    interfaces: [["Gi0/0/0", "203.0.113.10/30", 1000, "WAN - ISP uplink"], ["Gi0/0/1", "10.10.0.1/30", 1000, "to R1-Core"], ["Gi0/0/2", "-", 1000, "unused"]] },
  "R1-Core": { ip: "10.10.0.2", mac: "00:1A:2B:3C:4D:02", vendor: "Cisco", model: "ASR 1001-X", os: "IOS-XE 17.9.4",
    serial: "FXS2241Q0ZP", location: "Data Centre - Rack A2", role: "Core router", uptimeH: 4120, snmp: "v3 (authPriv)",
    interfaces: [["Te0/0/0", "10.10.0.2/30", 10000, "to R2-Edge"], ["Te0/0/1", "10.10.1.1/30", 10000, "to SW2-Dist"], ["Gi0/0/2", "10.10.9.1/24", 1000, "Mgmt"]] },
  "SW2-Dist": { ip: "10.10.1.2", mac: "00:1A:2B:3C:4D:03", vendor: "Cisco", model: "Catalyst 9300-48P", os: "IOS-XE 17.6.5",
    serial: "FOC2335X0LM", location: "Data Centre - Rack B1", role: "Distribution switch", uptimeH: 3388, snmp: "v2c",
    interfaces: [["Te1/1/1", "10.10.1.2/30", 10000, "to R1-Core"], ["Gi1/0/1", "trunk", 1000, "to SW1-Access"], ["Gi1/0/2", "VLAN 20", 1000, "to SRV1-Web"], ["Gi1/0/3", "VLAN 20", 1000, "to SRV2-DB"]] },
  "SW1-Access": { ip: "10.10.2.2", mac: "00:1A:2B:3C:4D:04", vendor: "HPE Aruba", model: "2930F-24G", os: "ArubaOS-Switch 16.11",
    serial: "CN09KP71XZ", location: "Floor 2 - IDF", role: "Access switch", uptimeH: 987, snmp: "v2c",
    interfaces: [["1/1", "trunk", 1000, "to SW2-Dist"], ["1/2-1/24", "VLAN 10", 1000, "User ports (23)"]] },
  "SRV1-Web": { ip: "10.10.20.11", mac: "00:50:56:A1:10:11", vendor: "Dell", model: "PowerEdge R650", os: "Ubuntu Server 24.04 LTS",
    serial: "7HXK2T3", location: "Data Centre - Rack C1", role: "Web server (nginx)", uptimeH: 512, snmp: "v3 (authPriv)",
    interfaces: [["ens192", "10.10.20.11/24", 1000, "to SW2-Dist"]] },
  "SRV2-DB": { ip: "10.10.20.12", mac: "00:50:56:A1:10:12", vendor: "Dell", model: "PowerEdge R750", os: "Rocky Linux 9.4",
    serial: "9JQL4V1", location: "Data Centre - Rack C2", role: "Database server (PostgreSQL)", uptimeH: 1460, snmp: "v3 (authPriv)",
    interfaces: [["ens192", "10.10.20.12/24", 1000, "to SW2-Dist"]] },
};

export const LINKS = [["Internet", "R2-Edge"], ["R2-Edge", "R1-Core"], ["R1-Core", "SW2-Dist"],
  ["SW2-Dist", "SW1-Access"], ["SW2-Dist", "SRV1-Web"], ["SW2-Dist", "SRV2-DB"]];

export function uptime(device, minutesElapsed) {
  const h = INVENTORY[device].uptimeH + minutesElapsed / 60;
  return `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h`;
}

/** Interface counters derived from the device's latest telemetry + AI prediction. */
export function interfaces(device, s) {
  return INVENTORY[device].interfaces.map(([name, addr, speed, desc], i) => {
    const uplink = i === 0;
    let util = uplink ? s.bandwidth : Math.max(1, s.bandwidth * 0.35);
    let oper = uplink && s.ai.predicted === "Link Failure" && s.packet_loss > 10 ? "DOWN" : "UP";
    if (desc === "unused") { oper = "ADMIN-DOWN"; util = 0; }
    const up = oper === "UP";
    return {
      name, addr, desc, speed: speed >= 1000 ? `${speed / 1000} Gbps` : `${speed} Mbps`, oper,
      util: round(util, 1), inMbps: up ? round(speed * util / 100 * 0.6, 1) : 0,
      outMbps: up ? round(speed * util / 100 * 0.4, 1) : 0, errors: uplink ? Math.round(s.packet_loss * 12) : 0,
    };
  });
}
