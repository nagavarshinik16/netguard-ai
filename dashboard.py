"""
NetGuard AI - Intelligent Network Management System (web application).

Run:  streamlit run dashboard.py      ->  http://localhost:8501
Login: see auth.py (default account: admin)
"""
import os
import time

import altair as alt
import pandas as pd
import streamlit as st

import live_network as ln
from auth import verify
from fault_predictor import THRESHOLDS, FaultPredictor
from generate_data import DEVICES, generate
from inventory import INVENTORY, interface_table, inventory_table, topology_dot
from ui import (APP_NAME, APP_TAGLINE, CONDITION_COLORS, CONDITIONS, LOGIN_CSS, STATUS_COLOR,
                STATUS_ICON, apply_css, badge, info_card, kpi, line_chart, metric_chart,
                page_header)

os.chdir(os.path.dirname(os.path.abspath(__file__)))  # works when launched from any folder

st.set_page_config(page_title=f"{APP_NAME} | NMS", page_icon="🛡️", layout="wide",
                   initial_sidebar_state="expanded")

MAX_ATTEMPTS, LOCK_SECONDS = 5, 30
METRICS_SHORT = {"cpu": "CPU %", "bandwidth": "Bandwidth %", "packet_loss": "Packet loss %",
                 "latency": "Latency ms"}


@st.cache_resource
def load_predictor():
    return FaultPredictor()


@st.cache_data
def simulate(minutes, seed):
    return load_predictor().predict(generate(samples_per_device=minutes, seed=seed,
                                             start="2026-10-09 09:00"))


# =====================================================================================
# LOGIN
# =====================================================================================
def login_page():
    st.markdown(LOGIN_CSS, unsafe_allow_html=True)
    st.markdown(f'<div class="login-hero"><div class="logo">🛡️</div>'
                f'<h1>NetGuard <span>AI</span></h1><p>{APP_TAGLINE}</p></div>',
                unsafe_allow_html=True)
    _, mid, _ = st.columns([1.3, 1, 1.3])
    with mid:
        locked = time.time() < st.session_state.get("lock_until", 0)
        with st.form("login"):
            st.markdown("#### Sign in to the console")
            user = st.text_input("Username", placeholder="Enter username")
            pwd = st.text_input("Password", type="password", placeholder="Enter password")
            ok = st.form_submit_button("Sign in", type="primary", width="stretch")
        if locked:
            wait = int(st.session_state.lock_until - time.time())
            st.error(f"Too many failed attempts. Try again in {wait} s.")
        elif ok:
            account = verify(user, pwd)
            if account:
                st.session_state.user = account
                st.session_state.attempts = 0
                st.session_state.login_time = time.strftime("%d %b %Y, %H:%M")
                st.rerun()
            st.session_state.attempts = st.session_state.get("attempts", 0) + 1
            left = MAX_ATTEMPTS - st.session_state.attempts
            if left <= 0:
                st.session_state.lock_until = time.time() + LOCK_SECONDS
                st.session_state.attempts = 0
                st.error(f"Account locked for {LOCK_SECONDS} seconds.")
            else:
                st.error(f"Invalid username or password. {left} attempt(s) left.")
        st.markdown('<div class="login-foot">Authorised personnel only · Sessions are logged<br>'
                    'Course 22CSPW0 · Network Management System Mini-Project</div>',
                    unsafe_allow_html=True)


if "user" not in st.session_state:
    st.navigation([st.Page(login_page, title="Sign in", icon=":material/lock:")]).run()
    st.stop()

# =====================================================================================
# AUTHENTICATED APP
# =====================================================================================
apply_css()
predictor = load_predictor()


def current_view():
    """Simulated telemetry up to the current replay position."""
    data = simulate(st.session_state.get("minutes", 120), st.session_state.get("seed", 7))
    ts = sorted(data.timestamp.unique())
    if st.session_state.get("live_replay"):
        n = st.session_state.get("sim_step", 15)
        if n > len(ts):
            n = st.session_state.sim_step = 15
    else:
        n = len(ts)
    view = data[data.timestamp <= ts[n - 1]]
    latest = view[view.timestamp == view.timestamp.max()]
    return view, latest, n


def clock(view):
    t = pd.Timestamp(view.timestamp.max())
    live = '<span class="live-dot"></span>LIVE' if st.session_state.get("live_replay") else "Snapshot"
    return f"{live} · {t:%d %b %Y %H:%M}<br>Polling interval 60 s · SNMP v2c/v3"


# ------------------------------------------------------------------ Overview
def page_overview():
    view, latest, n = current_view()
    page_header("Network Overview", "Real-time health of the managed enterprise network", clock(view))

    c = st.columns(6)
    kpi(c[0], "Managed devices", len(INVENTORY), "2 routers · 2 switches · 2 servers")
    kpi(c[1], "Healthy", int((latest.status == "OK").sum()), "operating normally", "#22c55e")
    kpi(c[2], "Warnings", int((latest.status == "WARNING").sum()), "potential faults", "#eab308")
    kpi(c[3], "Active faults", int((latest.status == "FAULT").sum()), "need attention", "#ef4444")
    kpi(c[4], "Avg latency", f"{latest.latency.mean():.0f} ms", "across all devices", "#a855f7")
    kpi(c[5], "Alerts (session)", int((view.status != "OK").sum()), f"last {n} minutes", "#f97316")
    st.write("")

    left, right = st.columns([1.35, 1])
    with left:
        st.subheader("Network topology")
        st.caption("Node colour = current AI status · dashed red link = predicted link failure")
        st.graphviz_chart(topology_dot(latest), width="stretch")
    with right:
        st.subheader("Device health")
        cols = st.columns(2)
        for i, (_, r) in enumerate(latest.sort_values("device").iterrows()):
            color = STATUS_COLOR[r.status]
            cols[i % 2].markdown(
                f'<div class="card dev-card" style="--accent:{color}">'
                f'<div style="display:flex;justify-content:space-between"><b>{r.device}</b>'
                f'{badge(r.status)}</div><div class="ip">{INVENTORY[r.device]["ip"]} · '
                f'{r.predicted}</div><div class="metrics"><span>CPU {r.cpu:.0f}%</span>'
                f'<span>BW {r.bandwidth:.0f}%</span><span>Loss {r.packet_loss:.2f}%</span>'
                f'<span>Lat {r.latency:.0f} ms</span></div></div>', unsafe_allow_html=True)

    st.subheader("AI-predicted condition timeline")
    timeline = alt.Chart(view.assign(end=view.timestamp + pd.Timedelta(minutes=1))).mark_rect().encode(
        x=alt.X("timestamp:T", title=None), x2="end:T", y=alt.Y("device:N", title=None),
        color=alt.Color("predicted:N", scale=CONDITION_COLORS, title="Condition"),
        tooltip=["timestamp:T", "device:N", "predicted:N", "fault_probability:Q", "status:N"]
    ).properties(height=230)
    st.altair_chart(timeline, width="stretch")


# ------------------------------------------------------------------ Inventory
def page_inventory():
    view, latest, n = current_view()
    page_header("Device Inventory", "Discovered network elements, interfaces and live state",
                clock(view))
    inv = inventory_table(latest, n)
    inv["Status"] = inv.Status.map(STATUS_ICON)
    st.dataframe(inv, hide_index=True, width="stretch")

    st.subheader("Device details")
    dev = st.selectbox("Select device", list(INVENTORY), label_visibility="collapsed")
    info, s = INVENTORY[dev], latest.set_index("device").loc[dev]
    a, b, c = st.columns(3)
    with a:
        info_card("🖥️ System", {"Hostname": dev, "Role": info["role"], "Mgmt IP": info["ip"],
                               "MAC address": info["mac"], "Location": info["location"],
                               "Uptime": inv.set_index("Hostname").loc[dev, "Uptime"]})
    with b:
        info_card("🔧 Hardware & software", {"Vendor": info["vendor"], "Model": info["model"],
                                            "OS / Firmware": info["os"], "Serial no.": info["serial"],
                                            "SNMP": info["snmp"],
                                            "Interfaces": len(info["interfaces"])})
    with c:
        info_card("📊 Live status", {
            "AI status": badge(s.status), "Predicted condition": s.predicted,
            "Fault probability": f"{s.fault_probability:.2f}", "CPU": f"{s.cpu:.1f} %",
            "Packet loss": f"{s.packet_loss:.2f} %", "Latency": f"{s.latency:.1f} ms"})

    st.markdown("**Interfaces**")
    st.dataframe(interface_table(dev, s), hide_index=True, width="stretch",
                 column_config={"Utilisation %": st.column_config.ProgressColumn(
                     "Utilisation %", min_value=0, max_value=100, format="%.1f")})
    if s.recommendation:
        st.warning(f"**{s.severity}** — {s.recommendation}")


# ------------------------------------------------------------------ Performance
def page_performance():
    view, latest, _ = current_view()
    page_header("Performance Monitoring", "CPU, bandwidth, packet loss and latency trends",
                clock(view))
    dev = st.selectbox("Device", list(DEVICES))
    d = view[view.device == dev]
    a, b = st.columns(2)
    a.altair_chart(metric_chart(d, "cpu"), width="stretch")
    b.altair_chart(metric_chart(d, "bandwidth"), width="stretch")
    a.altair_chart(metric_chart(d, "packet_loss"), width="stretch")
    b.altair_chart(metric_chart(d, "latency"), width="stretch")

    st.subheader("Current comparison across devices")
    cols = st.columns(4)
    for col, metric in zip(cols, ["cpu", "bandwidth", "packet_loss", "latency"]):
        bars = alt.Chart(latest).mark_bar(cornerRadiusEnd=4).encode(
            x=alt.X(f"{metric}:Q", title=None), y=alt.Y("device:N", title=None),
            color=alt.Color("status:N", scale=alt.Scale(
                domain=["OK", "WARNING", "FAULT"], range=["#22c55e", "#eab308", "#ef4444"]),
                legend=None),
            tooltip=["device", f"{metric}:Q", "predicted", "status"])
        rule = alt.Chart(pd.DataFrame({"t": [THRESHOLDS[metric]]})).mark_rule(
            color="#ef4444", strokeDash=[5, 4]).encode(x="t:Q")
        col.altair_chart((bars + rule).properties(height=220, title=METRICS_SHORT[metric]),
                         width="stretch")


# ------------------------------------------------------------------ Alerts
def page_alerts():
    view, _, _ = current_view()
    page_header("Alarms & Events", "AI-generated fault warnings with severity and remediation",
                clock(view))
    alerts = view[view.status != "OK"].sort_values("timestamp", ascending=False)
    f1, f2, f3 = st.columns(3)
    sev = f1.multiselect("Severity", ["CRITICAL", "MAJOR", "WARNING"],
                         default=["CRITICAL", "MAJOR", "WARNING"])
    devs = f2.multiselect("Device", list(DEVICES), default=list(DEVICES))
    kinds = f3.multiselect("Condition", CONDITIONS, default=CONDITIONS)
    alerts = alerts[alerts.severity.isin(sev) & alerts.device.isin(devs) & alerts.predicted.isin(kinds)]

    c = st.columns(4)
    kpi(c[0], "Total alerts", len(alerts), "matching filters", "#f97316")
    kpi(c[1], "Critical", int((alerts.severity == "CRITICAL").sum()), "link failures", "#ef4444")
    kpi(c[2], "Major", int((alerts.severity == "MAJOR").sum()), "congestion / CPU", "#f97316")
    kpi(c[3], "Warnings", int((alerts.severity == "WARNING").sum()), "early indicators", "#eab308")
    st.write("")

    if len(alerts):
        cnt = alerts.groupby(["device", "predicted"]).size().reset_index(name="count")
        st.altair_chart(alt.Chart(cnt).mark_bar(cornerRadiusEnd=3).encode(
            x=alt.X("count:Q", title="alerts"), y=alt.Y("device:N", title=None),
            color=alt.Color("predicted:N", scale=CONDITION_COLORS, title="Condition"),
            tooltip=["device", "predicted", "count"]
        ).properties(height=45 * cnt.device.nunique() + 40, title="Alerts by device and condition"),
            width="stretch")
    table = alerts.assign(status=alerts.status.map(STATUS_ICON),
                          ip=alerts.device.map(lambda d: INVENTORY[d]["ip"]))
    cols = ["timestamp", "device", "ip", "status", "severity", "predicted", "fault_probability",
            "threshold_breaches", "recommendation"]
    st.dataframe(table[cols], hide_index=True, width="stretch", height=420,
                 column_config={"fault_probability": st.column_config.ProgressColumn(
                     "Fault prob.", min_value=0, max_value=1, format="%.2f")})
    st.download_button("⬇️ Export alerts (CSV)", table[cols].to_csv(index=False),
                       "netguard_alerts.csv", "text/csv")


# ------------------------------------------------------------------ Live real network
def page_live():
    host = ln.host_info()
    page_header("Live Network (Real)", "Actual telemetry from this host and its network — "
                "no simulation", f'<span class="live-dot"></span>LIVE · {host["hostname"]}')
    a, b, c, d = st.columns(4)
    kpi(a, "Host", host["hostname"], host["os"])
    kpi(b, "IP address", host["ip"], f'interface {host["interface"]}', "#22c55e")
    kpi(c, "Default gateway", host["gateway"], "first hop router", "#a855f7")
    kpi(d, "System uptime", host["uptime"], f'{host["cpus"]} logical CPUs', "#f97316")
    st.write("")
    auto = st.toggle("Auto-refresh every 3 seconds", value=True)

    @st.fragment(run_every=3 if auto else None)
    def panel():
        if "meter" not in st.session_state:
            st.session_state.meter = ln.ThroughputMeter()
            time.sleep(0.5)
        snap, pings = ln.snapshot(st.session_state.meter)
        r = predictor.predict(pd.DataFrame([snap]), use_anomaly=False).iloc[0]
        hist = st.session_state.setdefault("live_hist", [])
        hist.append({**snap, "status": r.status})
        del hist[:-60]
        h = pd.DataFrame(hist)

        k = st.columns(6)
        kpi(k[0], "CPU", f'{snap["cpu"]:.0f}%', "processor load", "#38bdf8")
        kpi(k[1], "Memory", f'{snap["memory"]:.0f}%', "RAM in use", "#a855f7")
        kpi(k[2], "Latency", f'{snap["latency"]:.1f} ms', "avg to internet", "#22c55e")
        kpi(k[3], "Packet loss", f'{snap["packet_loss"]:.1f}%', "ICMP probes",
            "#ef4444" if snap["packet_loss"] > 0 else "#22c55e")
        kpi(k[4], "Download", f'{snap["rx_mbps"]:.2f}', "Mbps (RX)", "#38bdf8")
        kpi(k[5], "Upload", f'{snap["tx_mbps"]:.2f}', "Mbps (TX)", "#f97316")
        st.write("")

        color = STATUS_COLOR[r.status]
        advice = r.recommendation or "All metrics within normal operating range."
        st.markdown(f'<div class="card" style="border-left:4px solid {color}"><h4>🧠 AI assessment '
                    f'of this network: {badge(r.status)}</h4><div style="color:#cbd5e1">'
                    f'Predicted condition <b>{r.predicted}</b> · fault probability '
                    f'<b>{r.fault_probability:.2f}</b> · {advice}</div></div>',
                    unsafe_allow_html=True)

        g1, g2, g3 = st.columns(3)
        g1.altair_chart(line_chart(h, "timestamp", "latency", "Latency (ms)", "#22c55e",
                                   threshold=THRESHOLDS["latency"]), width="stretch")
        h["throughput_mbps"] = h.rx_mbps + h.tx_mbps
        g2.altair_chart(line_chart(h, "timestamp", "throughput_mbps", "Throughput (Mbps)"),
                        width="stretch")
        g3.altair_chart(line_chart(h, "timestamp", "cpu", "CPU (%)", "#a855f7",
                                   threshold=THRESHOLDS["cpu"]), width="stretch")

        t1, t2 = st.columns([1, 1.2])
        with t1:
            st.markdown("**Reachability (ICMP ping)**")
            p = pd.DataFrame(pings)
            p["Status"] = p.Status.map({"UP": "🟢 UP", "DOWN": "🔴 DOWN"})
            st.dataframe(p, hide_index=True, width="stretch")
        with t2:
            st.markdown("**Devices discovered on the LAN (ARP table)**")
            nb = pd.DataFrame(ln.neighbours())
            if len(nb):
                nb["State"] = nb.State.map(
                    lambda s: f"🟢 {s}" if s in ("REACHABLE", "DYNAMIC", "DELAY") else f"⚪ {s}")
                nb["Role"] = nb["IP address"].map(
                    lambda ip: "Gateway / router" if ip == host["gateway"] else "Host")
            st.dataframe(nb, hide_index=True, width="stretch")
        st.markdown("**Network interfaces on this host**")
        ifs = pd.DataFrame(ln.interfaces())
        ifs["Status"] = ifs.Status.map({"UP": "🟢 UP", "DOWN": "🔴 DOWN"})
        st.dataframe(ifs, hide_index=True, width="stretch")
        st.caption(f"Last updated {snap['timestamp']} · {len(hist)} samples collected this session")

    panel()


# ------------------------------------------------------------------ AI model
def page_ai():
    page_header("AI Fault Prediction Engine", "Random Forest classifier + Isolation Forest "
                "anomaly detector", "Model: models/fault_model.joblib")
    m = open("outputs/metrics.txt", encoding="utf-8").read()

    def grab(key):
        return m.split(key)[1].split(":")[1].split("%")[0].strip()

    c = st.columns(4)
    kpi(c[0], "Test accuracy", f"{grab('Overall accuracy')}%", "3,000 held-out samples", "#22c55e")
    kpi(c[1], "Fault detection", f"{grab('Fault detection')}%", "faults correctly flagged", "#38bdf8")
    kpi(c[2], "False alarms", f"{grab('False alarm rate')}%", "normal flagged as fault", "#eab308")
    kpi(c[3], "Training data", "12,000", "labelled telemetry records", "#a855f7")
    st.write("")

    st.subheader("🔬 What-if fault simulator")
    st.caption("Move the sliders to describe a network condition — the model classifies it instantly.")
    s1, s2 = st.columns([1, 1.3])
    with s1:
        cpu = st.slider("CPU utilisation (%)", 0, 100, 40)
        bw = st.slider("Bandwidth utilisation (%)", 0, 100, 45)
        loss = st.slider("Packet loss (%)", 0.0, 30.0, 0.2, 0.1)
        lat = st.slider("Latency (ms)", 1, 300, 20)
    sample = pd.DataFrame([{"cpu": cpu, "bandwidth": bw, "packet_loss": loss, "latency": lat,
                            "throughput": 1000 * bw / 100 * (1 - loss / 100)}])
    r = predictor.predict(sample).iloc[0]
    proba = pd.DataFrame({"condition": predictor.clf.classes_,
                          "probability": predictor.clf.predict_proba(sample[predictor.features])[0]})
    with s2:
        color = STATUS_COLOR[r.status]
        st.markdown(f'<div class="card" style="border-left:4px solid {color}"><h4>Prediction: '
                    f'{r.predicted} {badge(r.status)}</h4><div style="color:#cbd5e1">'
                    f'Fault probability <b>{r.fault_probability:.2f}</b>'
                    f'{" · anomaly detected" if r.anomaly else ""}<br>'
                    f'{r.recommendation or "No action required."}</div></div>',
                    unsafe_allow_html=True)
        st.altair_chart(alt.Chart(proba).mark_bar(cornerRadiusEnd=4).encode(
            x=alt.X("probability:Q", scale=alt.Scale(domain=[0, 1]), title="probability"),
            y=alt.Y("condition:N", sort=CONDITIONS, title=None),
            color=alt.Color("condition:N", scale=CONDITION_COLORS, legend=None),
            tooltip=["condition", alt.Tooltip("probability:Q", format=".2f")]
        ).properties(height=170), width="stretch")

    st.subheader("Model evaluation")
    a, b = st.columns(2)
    a.image("outputs/confusion_matrix.png", caption="Confusion matrix (test set)")
    b.image("outputs/feature_importance.png", caption="Feature importance")
    with st.expander("Full classification report"):
        st.code(m)


# ------------------------------------------------------------------ About
def page_about():
    page_header("About the System", "Architecture, configuration and project details")
    st.image("outputs/architecture.png", caption="System architecture")
    a, b = st.columns(2)
    with a:
        info_card("📘 Project", {"Title": "AI-Based Network Fault Prediction System",
                                "Course": "22CSPW0 — Network Management System",
                                "Type": "Mini-project (Topic 9)", "Product name": APP_NAME})
        info_card("⚙️ Alert thresholds", {k.replace("_", " ").title(): v
                                          for k, v in THRESHOLDS.items()})
    with b:
        info_card("🧰 Technology stack", {"Language": "Python 3", "ML": "scikit-learn",
                                         "Web UI": "Streamlit + Altair", "Telemetry": "psutil, ICMP, ARP",
                                         "Auth": "Salted SHA-256, lockout after 5 failures"})
        info_card("👤 Session", {"User": st.session_state.user["username"],
                                "Role": st.session_state.user["role"],
                                "Signed in": st.session_state.login_time})


# =====================================================================================
# NAVIGATION + SIDEBAR
# =====================================================================================
pg = st.navigation({
    "Monitoring": [st.Page(page_overview, title="Overview", icon=":material/dashboard:", default=True),
                   st.Page(page_inventory, title="Device Inventory", icon=":material/dns:"),
                   st.Page(page_performance, title="Performance", icon=":material/monitoring:"),
                   st.Page(page_alerts, title="Alarms & Events", icon=":material/notifications_active:")],
    "Real network": [st.Page(page_live, title="Live Network", icon=":material/wifi:")],
    "Intelligence": [st.Page(page_ai, title="AI Engine", icon=":material/psychology:")],
    "System": [st.Page(page_about, title="About", icon=":material/info:")],
})

with st.sidebar:
    st.markdown(f'<div class="brand">🛡️ NetGuard <span>AI</span></div>'
                f'<div class="brand-sub">{APP_TAGLINE}</div>', unsafe_allow_html=True)
    u = st.session_state.user
    st.markdown(f'<div class="user-box"><div class="name">👤 {u["name"]}</div>'
                f'<div class="role">{u["role"]} · since {st.session_state.login_time}</div></div>',
                unsafe_allow_html=True)
    if st.button("Sign out", width="stretch"):
        for k in ["user", "live_hist", "meter"]:
            st.session_state.pop(k, None)
        st.rerun()

    with st.expander("⚙️ Simulation controls", expanded=False):
        st.slider("Minutes of history", 30, 240, 120, step=10, key="minutes")
        st.number_input("Scenario seed", value=7, step=1, key="seed",
                        help="Change to load a different network scenario")
    replay = st.toggle("▶ Live replay (simulated network)", key="live_replay",
                       help="Stream the simulated network minute by minute")
    if pg.title not in ("Live Network", "About"):
        if replay:
            st.session_state.setdefault("sim_step", 15)

            @st.fragment(run_every=2)
            def ticker():
                last = st.session_state.get("last_tick", 0)
                if time.time() - last >= 1.8:
                    st.session_state.last_tick = time.time()
                    if last:  # skip the first call so the page renders before streaming starts
                        st.session_state.sim_step += 1
                        st.rerun()
                st.caption(f"Streaming · minute {st.session_state.sim_step}")

            ticker()
        else:
            st.session_state.pop("sim_step", None)
            st.session_state.pop("last_tick", None)

pg.run()
