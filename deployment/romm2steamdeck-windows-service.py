#!/usr/bin/env python3
"""
Windows Service Wrapper for RomM2SteamDeck
Requires: pip install pywin32

Installation:
1. Install pywin32: pip install pywin32
2. Run as administrator: python romm2steamdeck-windows-service.py install
3. Start service: python romm2steamdeck-windows-service.py start

Or use NSSM (Non-Sucking Service Manager) for easier management:
1. Download NSSM from https://nssm.cc/download
2. Run: nssm install RomM2SteamDeck "C:\Python\python.exe" "C:\path\to\app.py"
3. Configure service in NSSM GUI
"""

import sys
import os
import time
import subprocess
import win32serviceutil
import win32service
import win32event
import servicemanager

# Adjust these paths to match your installation
APP_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_EXE = sys.executable
APP_SCRIPT = os.path.join(APP_DIR, "..", "app.py")


class RomM2SteamDeckService(win32serviceutil.ServiceFramework):
    _svc_name_ = "RomM2SteamDeck"
    _svc_display_name_ = "RomM2SteamDeck Service"
    _svc_description_ = "Download ROMs from RomM to Steam Deck - Web Service"

    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self.process = None

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.stop_event)
        if self.process:
            self.process.terminate()

    def SvcDoRun(self):
        servicemanager.LogMsg(
            servicemanager.EVENTLOG_INFORMATION_TYPE,
            servicemanager.PYS_SERVICE_STARTED,
            (self._svc_name_, '')
        )
        self.main()

    def main(self):
        # Change to app directory
        os.chdir(APP_DIR)
        
        # Start Flask app
        self.process = subprocess.Popen(
            [PYTHON_EXE, APP_SCRIPT],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=APP_DIR
        )
        
        # Wait for stop event
        win32event.WaitForSingleObject(self.stop_event, win32event.INFINITE)
        
        # Cleanup
        if self.process:
            self.process.terminate()
            self.process.wait()


if __name__ == '__main__':
    if len(sys.argv) == 1:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(RomM2SteamDeckService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        win32serviceutil.HandleCommandLine(RomM2SteamDeckService)
