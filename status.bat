@echo off
chcp 65001 >nul
cd /d "%~dp0"
python lib\dzmm_studio.py status %*
if errorlevel 1 pause
