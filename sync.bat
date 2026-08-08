@echo off
chcp 65001 >nul
cd /d "%~dp0"
python lib\dzmm_studio.py sync %*
if errorlevel 1 pause
