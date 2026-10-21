@echo off
rem Runs the monitor and brings it back if it ever stops.
rem Leave this window open: closing it is the one thing that ends the watch.
title NE ZAKRYVAJ - Termin monitor
cd /d "%~dp0"
:loop
call npm run monitor
echo.
echo === monitor stopped, restarting in 5s (close this window to stop for good) ===
timeout /t 5 /nobreak >nul
goto loop
