#!/usr/bin/env bash
# One-shot: generate data -> train -> diagram -> CLI monitor -> dashboard
set -e
python generate_data.py
python train_model.py
python make_diagram.py
python monitor.py --minutes 30 --delay 0.1
streamlit run dashboard.py
