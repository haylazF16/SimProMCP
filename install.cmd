@echo off
REM Double-clickable installer for Goldman Simpro MCP.
REM This thin wrapper just launches install.ps1 in PowerShell with the
REM correct execution policy so non-technical users don't have to deal
REM with PowerShell's default script-blocking behaviour.

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%install.ps1"

if not exist "%PS_SCRIPT%" (
  echo ERROR: install.ps1 not found next to install.cmd.
  echo Make sure you copied the entire folder, not just install.cmd.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
pause
exit /b %EXIT_CODE%
