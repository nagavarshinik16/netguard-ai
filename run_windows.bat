@echo off
REM NetGuard AI - double-click launcher for Windows.
REM Runs setup_and_run.ps1 (setup + LAN hosting). Extra options are passed through,
REM e.g.  run_windows.bat -Port 8600   or   run_windows.bat -Retrain
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_and_run.ps1" %*
if errorlevel 1 pause
