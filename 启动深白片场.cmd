@echo off
chcp 65001 >nul
cd /d "%~dp0app"
"%~dp0app\python\python.exe" "%~dp0app\launch.py"
if errorlevel 1 pause
