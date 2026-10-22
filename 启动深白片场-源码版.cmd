@echo off
rem Source checkout launcher: uses the repository .venv (python -m venv .venv; pip install -r requirements.lock.txt).
chcp 65001 >nul
cd /d "%~dp0app"
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo 未找到 .venv。请在仓库根目录执行：python -m venv .venv ^&^& .venv\Scripts\python.exe -m pip install -r requirements.lock.txt
  pause
  exit /b 1
)
start "" http://127.0.0.1:3848/
"%~dp0.venv\Scripts\python.exe" -B "%~dp0app\studio_server.py"
if errorlevel 1 pause
