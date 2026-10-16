@echo off
cd /d "%~dp0"
"%~dp0python\python.exe" "%~dp0launch.py"
if errorlevel 1 pause
