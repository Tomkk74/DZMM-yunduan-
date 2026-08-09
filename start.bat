@echo off
REM Keep this file ASCII-only so cmd.exe path handling stays stable.
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title DZMM Local Dev

echo.
echo ========================================
echo   DZMM Local Dev - One Click Start
echo ========================================
echo.

if not exist "start.py" (
  echo [FAIL] start.py not found next to this bat.
  pause
  exit /b 1
)

set "PY="

REM 1) Common real installs (skip WindowsApps / broken VS Code shims)
call :try_py "C:\Python314\python.exe"
call :try_py "C:\Python313\python.exe"
call :try_py "C:\Python312\python.exe"
call :try_py "C:\Python311\python.exe"
call :try_py "%LocalAppData%\Programs\Python\Python314\python.exe"
call :try_py "%LocalAppData%\Programs\Python\Python313\python.exe"
call :try_py "%LocalAppData%\Programs\Python\Python312\python.exe"
call :try_py "%LocalAppData%\Programs\Python\Python311\python.exe"
call :try_py "%LocalAppData%\Python\bin\python.exe"

REM 2) PATH python.exe — reject WindowsApps / Microsoft VS Code stubs
if not defined PY (
  for /f "delims=" %%P in ('where python 2^>nul') do (
    call :try_py_path "%%P"
    if defined PY goto :have_py
  )
)

REM 3) Last resort: py -3, but run relative start.py (CJK absolute paths break py)
if not defined PY (
  where py >nul 2>&1
  if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if not errorlevel 1 (
      echo [env] using: py -3
      py -3 -u start.py %*
      set "EC=!ERRORLEVEL!"
      goto :done
    )
  )
)

:have_py
if not defined PY (
  echo [FAIL] No working Python 3 found.
  echo        Install from https://www.python.org/downloads/
  echo        and check "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

echo [env] using: !PY!
REM Relative script path — avoids CJK absolute path bugs in some launchers
"!PY!" -u start.py %*
set "EC=!ERRORLEVEL!"

:done
if not "!EC!"=="0" (
  echo.
  echo [FAIL] exit code !EC!
  pause
)
exit /b !EC!

:try_py
if defined PY goto :eof
if not exist "%~1" goto :eof
"%~1" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
if errorlevel 1 goto :eof
set "PY=%~1"
goto :eof

:try_py_path
if defined PY goto :eof
set "_CAND=%~1"
echo %_CAND% | findstr /I /C:"\WindowsApps\" /C:"\Microsoft VS Code\Python\" /C:"\Microsoft\WindowsApps\" >nul
if not errorlevel 1 goto :eof
if not exist "%_CAND%" goto :eof
"%_CAND%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
if errorlevel 1 goto :eof
set "PY=%_CAND%"
goto :eof
