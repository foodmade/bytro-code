@echo off
REM ============================================================
REM capture-windows-logs.bat
REM
REM Double-click entry point. Launches capture-windows-logs.ps1
REM next to this file.
REM   - Double-click             -> PowerShell will pop a file picker
REM   - Drag bytro-community.exe onto this -> Passed as -ExePath, skip picker
REM
REM -NoExit keeps the PowerShell window open so the user can read
REM the desktop log paths after capture completes.
REM -ExecutionPolicy Bypass only affects this process; it does NOT
REM modify the system-wide policy.
REM ============================================================

setlocal
chcp 65001 >nul 2>&1
title Bytro Community Edition Log Capture

set "PS1=%~dp0capture-windows-logs.ps1"

if not exist "%PS1%" (
  echo [error] Script not found: %PS1%
  pause
  exit /b 1
)

if "%~1"=="" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%PS1%"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%PS1%" -ExePath "%~1"
)

endlocal
