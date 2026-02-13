# RomM2SteamDeck Deployment Guide

This guide covers deploying RomM2SteamDeck as a background service on various platforms.

## Table of Contents

- [Linux / Steam Deck (systemd)](#linux--steam-deck-systemd)
- [Steam Deck Game Mode](#steam-deck-game-mode)
- [Windows Service](#windows-service)
- [macOS LaunchAgent](#macos-launchagent)
- [Troubleshooting](#troubleshooting)

## Linux / Steam Deck (systemd)

### Prerequisites

- Python 3.8+ installed
- Flask and dependencies installed (`pip install -r requirements.txt`)
- AppImage or source installation

### Installation Steps

1. **Copy the service file to systemd user directory:**

```bash
mkdir -p ~/.config/systemd/user
cp deployment/romm2steamdeck.service ~/.config/systemd/user/
```

2. **Edit the service file** to match your installation:

```bash
nano ~/.config/systemd/user/romm2steamdeck.service
```

Update the `ExecStart` line:
- **For source installation:** `ExecStart=/usr/bin/python3 /path/to/app.py`
- **For AppImage:** `ExecStart=/home/deck/RomM2SteamDeck-x86_64.AppImage`
- **For virtual environment:** `ExecStart=/path/to/venv/bin/python /path/to/app.py`

3. **Reload systemd and enable the service:**

```bash
systemctl --user daemon-reload
systemctl --user enable romm2steamdeck.service
systemctl --user start romm2steamdeck.service
```

4. **Check status:**

```bash
systemctl --user status romm2steamdeck.service
```

5. **View logs:**

```bash
journalctl --user -u romm2steamdeck.service -f
```

### Managing the Service

- **Start:** `systemctl --user start romm2steamdeck.service`
- **Stop:** `systemctl --user stop romm2steamdeck.service`
- **Restart:** `systemctl --user restart romm2steamdeck.service`
- **Disable auto-start:** `systemctl --user disable romm2steamdeck.service`
- **Enable auto-start:** `systemctl --user enable romm2steamdeck.service`

### Accessing the Web UI

Once the service is running, open your browser and navigate to:
- `http://localhost:5001` (local access)
- `http://<steam-deck-ip>:5001` (network access)

## Steam Deck Game Mode

Game Mode has limited access to system services, so use one of these approaches:

### Option A: Desktop Mode Service + Game Mode Browser (Recommended)

1. **Set up the systemd service in Desktop Mode** (see above)

2. **Add browser shortcut to Steam:**

   - Switch to Desktop Mode
   - Open Steam
   - Click "Add a Game" → "Add a Non-Steam Game"
   - Select your browser (e.g., Firefox, Chrome)
   - Right-click the browser in Steam → Properties
   - Set launch options: `http://localhost:5001`
   - Rename to "RomM2SteamDeck"

3. **Switch to Game Mode** and launch from Steam Library

The service will already be running in the background, and the browser will open directly to the app.

### Option B: Game Mode Launcher Script

1. **Make the launcher script executable:**

```bash
chmod +x deployment/gamemode-launcher.sh
```

2. **Edit the script** to match your setup (service name, paths)

3. **Add script to Steam as non-Steam game:**

   - In Desktop Mode, open Steam
   - Add the script as a non-Steam game
   - Configure launch options if needed

4. **Launch from Game Mode**

The script will:
- Check if the service is running
- Start it if needed
- Wait for the server to be ready
- Open the browser automatically

## Windows Service

### Option A: Using pywin32 (Python Service)

1. **Install pywin32:**

```cmd
pip install pywin32
```

2. **Edit `romm2steamdeck-windows-service.py`** to set correct paths:
   - `APP_DIR`: Path to your app directory
   - `PYTHON_EXE`: Path to Python executable
   - `APP_SCRIPT`: Path to app.py

3. **Install the service** (run as Administrator):

```cmd
python deployment\romm2steamdeck-windows-service.py install
```

4. **Start the service:**

```cmd
python deployment\romm2steamdeck-windows-service.py start
```

5. **Manage via Services:**

   - Open Services (`services.msc`)
   - Find "RomM2SteamDeck Service"
   - Right-click to start/stop/configure

### Option B: Using NSSM (Easier)

1. **Download NSSM** from https://nssm.cc/download

2. **Extract and run NSSM:**

```cmd
nssm install RomM2SteamDeck
```

3. **Configure in NSSM GUI:**
   - **Path:** `C:\Python\python.exe` (or your Python path)
   - **Startup directory:** Path to your app directory
   - **Arguments:** `app.py`
   - **Service name:** `RomM2SteamDeck`

4. **Start the service:**

```cmd
nssm start RomM2SteamDeck
```

### Option C: Task Scheduler (Simpler but less robust)

1. Open Task Scheduler (`taskschd.msc`)

2. Create Basic Task:
   - **Name:** RomM2SteamDeck
   - **Trigger:** At logon / At startup
   - **Action:** Start a program
   - **Program:** `python.exe`
   - **Arguments:** `C:\path\to\app.py`
   - **Start in:** `C:\path\to\app\directory`

3. Configure to run whether user is logged on or not

## macOS LaunchAgent

1. **Edit the plist file** (`com.romm2steamdeck.plist`):
   - Update Python path
   - Update app.py path
   - Adjust working directory if needed

2. **Copy to LaunchAgents directory:**

```bash
cp deployment/com.romm2steamdeck.plist ~/Library/LaunchAgents/
```

3. **Load the service:**

```bash
launchctl load ~/Library/LaunchAgents/com.romm2steamdeck.plist
```

4. **Start the service:**

```bash
launchctl start com.romm2steamdeck
```

### Managing the Service

- **Start:** `launchctl start com.romm2steamdeck`
- **Stop:** `launchctl stop com.romm2steamdeck`
- **Unload:** `launchctl unload ~/Library/LaunchAgents/com.romm2steamdeck.plist`
- **View logs:** Check `~/Library/Logs/romm2steamdeck/`

## Troubleshooting

### Service Won't Start

**Linux/Steam Deck:**
```bash
# Check service status
systemctl --user status romm2steamdeck.service

# View detailed logs
journalctl --user -u romm2steamdeck.service -n 50

# Check if port is already in use
netstat -tuln | grep 5001
```

**Windows:**
- Check Event Viewer for service errors
- Verify Python path is correct
- Check that port 5001 is not in use

**macOS:**
```bash
# Check service status
launchctl list | grep romm2steamdeck

# View logs
tail -f ~/Library/Logs/romm2steamdeck/stderr.log
```

### Port Already in Use

If port 5001 is already in use:

1. **Find what's using it:**

**Linux:**
```bash
sudo lsof -i :5001
```

**Windows:**
```cmd
netstat -ano | findstr :5001
```

2. **Change port in config.json:**

Edit `~/.config/romm2steamdeck/config.json` (or `%APPDATA%\romm2steamdeck\config.json` on Windows):

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 5002
  }
}
```

3. **Restart the service**

### Can't Access Web UI

1. **Check service is running**
2. **Verify firewall settings** (Windows Firewall, ufw, etc.)
3. **Try localhost vs IP address:**
   - `http://localhost:5001` (local)
   - `http://127.0.0.1:5001` (local)
   - `http://<your-ip>:5001` (network)

### Service Stops Unexpectedly

1. **Check logs** for error messages
2. **Verify dependencies** are installed
3. **Check disk space** and permissions
4. **Review restart policy** in service configuration

## Security Considerations

- The service runs on `0.0.0.0` by default, making it accessible on your local network
- Consider firewall rules to restrict access if needed
- For production use, consider adding authentication or running behind a reverse proxy
- User services (systemd) run with your user permissions, not root

## Next Steps

- Consider setting up a reverse proxy (nginx, Caddy) for HTTPS
- Add authentication if exposing to the network
- Set up log rotation for long-running services
- Configure automatic updates if using source installation
