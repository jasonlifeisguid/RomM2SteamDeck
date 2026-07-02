@echo off
setlocal EnableDelayedExpansion
title RomM2SteamDeck - Windows Build

echo ================================================
echo  RomM2SteamDeck Windows Builder (PyInstaller)
echo  Compiles to a standalone single-file exe
echo ================================================
echo.
echo  No manual setup required.
echo  Python will be installed automatically if missing.
echo.

:: ── Check / install Python ────────────────────────────────────────────────────

python --version >nul 2>&1
if errorlevel 1 (
    echo [INFO] Python not found. Attempting automatic installation...
    echo.

    winget --version >nul 2>&1
    if not errorlevel 1 (
        echo       Installing Python 3.11 via winget...
        winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
        echo.
    ) else (
        echo       winget not available. Downloading Python 3.11 installer...
        set "PY_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
        set "PY_INSTALLER=%TEMP%\python-3.11.9-installer.exe"
        powershell -Command "Invoke-WebRequest -Uri '%PY_URL%' -OutFile '%PY_INSTALLER%'" >nul 2>&1
        if errorlevel 1 (
            echo [ERROR] Failed to download Python installer.
            echo         Please install Python manually from https://www.python.org/
            echo         then re-run this script.
            pause & exit /b 1
        )
        echo       Running installer silently...
        "%PY_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0
        del "%PY_INSTALLER%" >nul 2>&1
    )

    echo.
    echo [INFO] Python installed. Restarting script to apply updated PATH...
    echo.
    cmd /c "%~f0"
    exit /b
)

pip --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] pip not found. Re-install Python and ensure pip is included.
    pause & exit /b 1
)

:: ── Setup paths ───────────────────────────────────────────────────────────────

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "DIST_DIR=%SCRIPT_DIR%\dist"
set "OUTPUT_EXE=%DIST_DIR%\RomM2SteamDeck.exe"

cd /d "%SCRIPT_DIR%"

:: ── Install dependencies ─────────────────────────────────────────────────────

echo [1/4] Installing app dependencies...
pip install -q -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies from requirements.txt.
    pause & exit /b 1
)

:: Try to install pywebview for native window support (requires Python 3.12 or earlier)
set "WEBVIEW_HIDDEN_IMPORT="
pip install -q pywebview >nul 2>&1
if not errorlevel 1 (
    echo       pywebview installed - exe will open as a native window.
    set "WEBVIEW_HIDDEN_IMPORT=--hidden-import pywebview.platforms.winforms"
) else (
    echo       pywebview unavailable ^(needs Python 3.12 or earlier^) - exe will open in browser.
)

:: ── Install PyInstaller ───────────────────────────────────────────────────────

echo [2/4] Installing / updating PyInstaller...
pip install -q --upgrade pyinstaller
if errorlevel 1 (
    echo [ERROR] Failed to install PyInstaller.
    pause & exit /b 1
)

:: ── Build the exe ─────────────────────────────────────────────────────────────

echo [3/4] Building RomM2SteamDeck.exe with PyInstaller...
echo.

if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"
if exist "%OUTPUT_EXE%" del /f "%OUTPUT_EXE%"

python -m PyInstaller ^
    --onefile ^
    --name RomM2SteamDeck ^
    --distpath dist ^
    --add-data "templates;templates" ^
    --add-data "config.json;." ^
    %WEBVIEW_HIDDEN_IMPORT% ^
    --noconsole ^
    --clean ^
    app.py

if errorlevel 1 (
    echo.
    echo [ERROR] PyInstaller build failed. See output above for details.
    pause & exit /b 1
)

:: ── Cleanup ───────────────────────────────────────────────────────────────────

echo.
echo [4/4] Cleaning up intermediate build files...
if exist "%SCRIPT_DIR%\build" rmdir /s /q "%SCRIPT_DIR%\build"
if exist "%SCRIPT_DIR%\RomM2SteamDeck.spec" del /f "%SCRIPT_DIR%\RomM2SteamDeck.spec"

:: ── Done ──────────────────────────────────────────────────────────────────────

echo.
echo ================================================
echo  Build complete!
echo  Output: dist\RomM2SteamDeck.exe
echo.
echo  NOTE: Windows Defender may flag the exe as a
echo  false positive due to PyInstaller's bootloader.
echo  If this happens, add an exclusion in Windows
echo  Security for the dist\ folder, or submit the
echo  file to Microsoft for analysis:
echo  aka.ms/wdsi-filesubmission
echo ================================================
echo.

pause
