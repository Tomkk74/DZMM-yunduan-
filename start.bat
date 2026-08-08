@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo  DZMM 本地开发控制台
echo  http://127.0.0.1:8788/
echo ========================================
echo.
python console.py --port 8788
if errorlevel 1 (
  echo.
  echo [失败] 需要已安装 Python 3，并确认 8788 端口空闲
  pause
)
