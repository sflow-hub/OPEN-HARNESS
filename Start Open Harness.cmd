@echo off
rem Double-click launcher for Windows. Runs launchers\start.ps1 from this folder in
rem Windows PowerShell and keeps the window open so the result can be read.
rem See docs\LOCAL_BROWSER.md.
set "OPEN_HARNESS_LAUNCHER_PAUSE=1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launchers\start.ps1" %*
exit /b %ERRORLEVEL%
