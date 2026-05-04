@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%update.ps1"

if not exist "%PS_SCRIPT%" (
  echo ERROR: update.ps1 not found next to update.cmd.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
echo.
pause
exit /b %ERRORLEVEL%
