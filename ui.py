"""Shared look-and-feel: CSS, KPI cards, status badges, chart helpers."""
import altair as alt
import pandas as pd
import streamlit as st

from fault_predictor import THRESHOLDS

APP_NAME = "NetGuard AI"
APP_TAGLINE = "Intelligent Network Management System"

STATUS_COLOR = {"OK": "#22c55e", "WARNING": "#eab308", "FAULT": "#ef4444",
                "UP": "#22c55e", "DOWN": "#ef4444", "Reachable": "#22c55e", "Degraded": "#ef4444"}
STATUS_ICON = {"OK": "🟢 OK", "WARNING": "🟡 WARNING", "FAULT": "🔴 FAULT"}
CONDITIONS = ["Normal", "Congestion", "Link Failure", "CPU Overload"]
CONDITION_COLORS = alt.Scale(domain=CONDITIONS, range=["#22c55e", "#f97316", "#ef4444", "#a855f7"])
METRICS = {"cpu": "CPU (%)", "bandwidth": "Bandwidth utilisation (%)",
           "packet_loss": "Packet loss (%)", "latency": "Latency (ms)"}

CSS = """
<style>
#MainMenu, footer, [data-testid="stDecoration"] {visibility: hidden;}
.block-container {padding-top: 2.2rem; padding-bottom: 2rem; max-width: 1500px;}
[data-testid="stSidebar"] {background: linear-gradient(180deg,#0f172a 0%,#0b1220 100%);
  border-right: 1px solid #1e293b;}
h1, h2, h3 {letter-spacing: -0.01em;}

.page-head {display:flex; align-items:flex-end; justify-content:space-between;
  border-bottom:1px solid #1e293b; padding-bottom:.7rem; margin-bottom:1.2rem;}
.page-head h1 {font-size:1.75rem; margin:0; padding:0;}
.page-head .sub {color:#94a3b8; font-size:.92rem; margin-top:.2rem;}
.page-head .meta {color:#94a3b8; font-size:.85rem; text-align:right;}
.live-dot {display:inline-block; width:9px; height:9px; border-radius:50%; background:#22c55e;
  margin-right:6px; box-shadow:0 0 0 0 rgba(34,197,94,.7); animation:pulse 1.6s infinite;}
@keyframes pulse {0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)} 70%{box-shadow:0 0 0 9px rgba(34,197,94,0)}
  100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}

.kpi {background:#131c31; border:1px solid #1e293b; border-radius:14px; padding:16px 18px;
  border-left:4px solid var(--accent); height:100%;}
.kpi .label {color:#94a3b8; font-size:.78rem; text-transform:uppercase; letter-spacing:.06em;}
.kpi .value {color:#f8fafc; font-size:1.85rem; font-weight:700; line-height:1.2; margin-top:4px;}
.kpi .sub {color:#64748b; font-size:.8rem; margin-top:2px;}

.card {background:#131c31; border:1px solid #1e293b; border-radius:14px; padding:16px 18px;
  margin-bottom:12px;}
.card h4 {margin:0 0 6px 0; font-size:1rem;}
.card .row {display:flex; justify-content:space-between; color:#cbd5e1; font-size:.86rem;
  padding:3px 0; border-bottom:1px dashed #1e293b;}
.card .row span:first-child {color:#94a3b8;}
.dev-card {border-top:3px solid var(--accent);}
.dev-card .ip {color:#64748b; font-size:.8rem; font-family:monospace;}
.dev-card .metrics {display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; margin-top:8px;
  font-size:.82rem; color:#cbd5e1;}

.badge {display:inline-block; padding:2px 10px; border-radius:999px; font-size:.75rem;
  font-weight:600; color:#0b1220; background:var(--accent);}
.user-box {background:#131c31; border:1px solid #1e293b; border-radius:12px; padding:10px 12px;
  margin-bottom:6px;}
.user-box .name {font-weight:600; color:#f8fafc;}
.user-box .role {color:#94a3b8; font-size:.8rem;}
.brand {font-size:1.25rem; font-weight:800; color:#f8fafc;}
.brand span {color:#38bdf8;}
.brand-sub {color:#64748b; font-size:.78rem; margin-bottom:10px;}
</style>
"""

LOGIN_CSS = """
<style>
[data-testid="stSidebar"], [data-testid="stSidebarCollapsedControl"], header {display:none;}
.stApp {background: radial-gradient(circle at 20% 20%, #10264a 0%, #0b1220 45%),
  radial-gradient(circle at 80% 80%, #0d3b4f 0%, transparent 40%);}
.login-hero {text-align:center; margin-top:4vh;}
.login-hero .logo {font-size:3.2rem;}
.login-hero h1 {font-size:2.1rem; margin:.2rem 0 0 0;}
.login-hero h1 span {color:#38bdf8;}
.login-hero p {color:#94a3b8; margin-top:.3rem;}
[data-testid="stForm"] {background:rgba(19,28,49,.85); border:1px solid #1e293b;
  border-radius:16px; padding:26px 26px 18px 26px; backdrop-filter: blur(6px);}
.login-foot {text-align:center; color:#475569; font-size:.78rem; margin-top:14px;}
</style>
"""


def apply_css():
    st.markdown(CSS, unsafe_allow_html=True)


def page_header(title, subtitle, meta=""):
    st.markdown(f'<div class="page-head"><div><h1>{title}</h1><div class="sub">{subtitle}</div>'
                f'</div><div class="meta">{meta}</div></div>', unsafe_allow_html=True)


def kpi(col, label, value, sub="", accent="#38bdf8"):
    col.markdown(f'<div class="kpi" style="--accent:{accent}"><div class="label">{label}</div>'
                 f'<div class="value">{value}</div><div class="sub">{sub}</div></div>',
                 unsafe_allow_html=True)


def badge(text, color=None):
    color = color or STATUS_COLOR.get(text, "#64748b")
    return f'<span class="badge" style="--accent:{color}">{text}</span>'


def info_card(title, rows: dict):
    body = "".join(f'<div class="row"><span>{k}</span><span>{v}</span></div>' for k, v in rows.items())
    st.markdown(f'<div class="card"><h4>{title}</h4>{body}</div>', unsafe_allow_html=True)


def metric_chart(df, metric, height=240):
    """Metric over time; dots coloured by AI-predicted condition; red dashed threshold."""
    line = alt.Chart(df).mark_line(color="#64748b", strokeWidth=1.3).encode(
        x=alt.X("timestamp:T", title=None), y=alt.Y(f"{metric}:Q", title=METRICS[metric]))
    dots = alt.Chart(df).mark_circle(size=30).encode(
        x="timestamp:T", y=f"{metric}:Q",
        color=alt.Color("predicted:N", scale=CONDITION_COLORS, title="AI prediction"),
        tooltip=["timestamp:T", f"{metric}:Q", "predicted:N", "fault_probability:Q", "status:N"])
    rule = alt.Chart(pd.DataFrame({"y": [THRESHOLDS[metric]]})).mark_rule(
        color="#ef4444", strokeDash=[6, 4]).encode(y="y:Q")
    return (line + dots + rule).properties(
        height=height, title=f"{METRICS[metric]} — threshold {THRESHOLDS[metric]}")


def line_chart(df, x, y, title, color="#38bdf8", height=220, threshold=None):
    chart = alt.Chart(df).mark_area(
        line={"color": color}, color=alt.Gradient(
            gradient="linear", x1=1, x2=1, y1=1, y2=0,
            stops=[alt.GradientStop(color="rgba(56,189,248,0.02)", offset=0),
                   alt.GradientStop(color=color, offset=1)]), opacity=0.35
    ).encode(x=alt.X(f"{x}:N", title=None, axis=alt.Axis(labelAngle=0, labelOverlap=True)),
             y=alt.Y(f"{y}:Q", title=None), tooltip=[x, y])
    if threshold is not None:
        chart += alt.Chart(pd.DataFrame({"t": [threshold]})).mark_rule(
            color="#ef4444", strokeDash=[6, 4]).encode(y="t:Q")
    return chart.properties(height=height, title=title)
