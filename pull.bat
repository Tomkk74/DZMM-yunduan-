@echo off
chcp 65001 >nul
cd /d "%~dp0"
python lib\pull_container.py %*
if errorlevel 1 pause
