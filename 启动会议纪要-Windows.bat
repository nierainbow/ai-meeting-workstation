@echo off
rem Windows launcher wrapper. Keep this file ASCII-only; the real logic lives in scripts\windows\start.ps1.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
