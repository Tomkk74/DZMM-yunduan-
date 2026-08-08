@echo off
chcp 65001 >nul
cd /d "%~dp0"
python lib\dzmm_preview_server.py %*
if errorlevel 1 pause
