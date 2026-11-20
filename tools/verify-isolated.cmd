@echo off
rem Wrapper: bypass the PowerShell execution policy (unsigned .ps1 files are blocked).
rem Prefer pwsh (PowerShell 7) when present; fall back to Windows PowerShell.
rem Pure ASCII on purpose: cmd.exe decodes this file with the OEM code page.
rem Usage: verify-isolated.cmd [-HttpOnly] [-KeepTemp] [extra args forwarded]
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-isolated.ps1" %*
exit /b %errorlevel%
