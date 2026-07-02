@echo off
rem Launch RomM2SteamDeck (Electron) using the portable Node.js install.
rem No system PATH changes needed — this script is self-contained.
set "PATH=C:\Users\Jason\Documents\Claude\tools\nodejs;%PATH%"
cd /d "%~dp0"
call npm start
