@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Run npm.cmd install first.
  pause
  exit /b 1
)
if exist tools\ollama\ollama.exe (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-ollama.ps1
)
if not exist dist\index.html call npm.cmd run build
if errorlevel 1 exit /b 1
call npm.cmd start
pause
