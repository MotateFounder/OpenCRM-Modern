@echo off
REM Runs OpenCRM from source. For daily use you can also double-click dist\OpenCRM-*-portable.exe
REM or the Start-menu / desktop shortcut created by dist\OpenCRM-Setup-*.exe
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies - first run only...
  call npm install
  call node node_modules\electron\install.js
)
start "" "node_modules\electron\dist\electron.exe" .
