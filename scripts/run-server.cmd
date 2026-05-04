@echo off
REM Manual server launcher (foreground). Use this to test the server in a console.
REM For unattended/auto-start, use scripts\install-as-service.ps1 instead.
REM
REM Edit the values below or set them as system env vars before running.

setlocal
cd /d "%~dp0\.."

if "%SIMPRO_TRANSPORT%"=="" set "SIMPRO_TRANSPORT=http"
if "%SIMPRO_HTTP_HOST%"=="" set "SIMPRO_HTTP_HOST=0.0.0.0"
if "%SIMPRO_HTTP_PORT%"=="" set "SIMPRO_HTTP_PORT=3001"
if "%SIMPRO_BASE_URL%"=="" set "SIMPRO_BASE_URL=https://goldmanplumbingservices.simprosuite.com"
if "%SIMPRO_COMPANY_ID%"=="" set "SIMPRO_COMPANY_ID=4"
if "%SIMPRO_TOKENS_FILE%"=="" set "SIMPRO_TOKENS_FILE=%~dp0..\tokens.json"
if "%SIMPRO_AUDIT_FILE%"=="" set "SIMPRO_AUDIT_FILE=%~dp0..\audit.log"
REM SIMPRO_API_KEY is intentionally LEFT EMPTY in HTTP mode; per-user keys come from tokens.json.

echo Starting Simpro MCP server (HTTP transport).
echo   Bind: %SIMPRO_HTTP_HOST%:%SIMPRO_HTTP_PORT%
echo   Tokens: %SIMPRO_TOKENS_FILE%
echo   Audit:  %SIMPRO_AUDIT_FILE%
echo Press Ctrl+C to stop.
echo.

node dist\index.js
