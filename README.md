# RomM2SteamDeck

RomM2SteamDeck is a tool to download ROMs and Windows games from your [RomM](https://github.com/rommapp/romm) library directly to your Steam Deck, Windows PC, or Linux system. Browse your game collection by platform and download individual games on-demand.

## Features

- **Browse by Platform** - Slide-out drawer to switch platforms and sort order — works with touch and controller on Steam Deck
- **Download with Progress** - Download individual games with real-time progress bar and cancel support
- **Windows Games Support** - Download and extract Windows games (7z/zip) automatically
- **Desktop Shortcut Creation** - Create a desktop shortcut for any Windows game after extraction; on Steam Deck, right-click the shortcut → **Add to Steam** to add it to your library without wiping existing non-Steam games
- **Download Tracking** - Track downloaded games and delete them with a confirmation dialog
- **Filesystem Sync** - Automatically detect games downloaded outside the app
- **Multiple Themes** - Choose from 10 color themes including Steam Deck OLED Limited Edition orange
- **Platform Folder Mapping** - Auto-configure paths using RomM's folder structure
- **Quit Button** - Stop the app cleanly from the navbar — no terminal required
- **Responsive UI** - Works on Steam Deck screen, tablets, and phones
- **Cross-Platform** - Runs on Steam Deck, Linux, Windows, and macOS

## Installation

### Steam Deck / Linux

#### Option 1: Download Pre-built AppImage

1. Download the latest `RomM2SteamDeck-x86_64.AppImage` from the Releases page
2. Make it executable:
   ```bash
   chmod +x RomM2SteamDeck-x86_64.AppImage
   ```
3. Run it:
   ```bash
   ./RomM2SteamDeck-x86_64.AppImage
   ```
   The app starts a local web server and opens your default browser (e.g. Librewolf) automatically.

#### Option 2: Build AppImage Yourself

Requirements: A Linux x86_64 system with Python 3.8+ and pip

1. Clone the repository:
   ```bash
   git clone https://github.com/jasonlifeisguid/RomM2SteamDeck.git
   cd RomM2SteamDeck
   ```

2. Run the build script:
   ```bash
   chmod +x build-appimage.sh
   ./build-appimage.sh
   ```

3. Copy the resulting AppImage to your Steam Deck

### Windows

#### Option 1: Run from Source

1. Install [Python 3.8+](https://www.python.org/downloads/) (check "Add Python to PATH" during install)
2. Install [7-Zip](https://www.7-zip.org/) (required for extracting .7z game files)
3. Clone or download the repository
4. Open Command Prompt or PowerShell in the project folder:
   ```cmd
   pip install -r requirements.txt
   python app.py
   ```
5. Open `http://localhost:5001` in your browser

#### Option 2: Build Standalone Executable

1. Install Python 3.8+ and clone the repository
2. Run the included build script:
   ```cmd
   build_windows.bat
   ```
   This uses [PyInstaller](https://pyinstaller.org/) to bundle the app into a single `.exe`. Python will be installed automatically if missing.
3. The standalone `RomM2SteamDeck.exe` will be in the `dist` folder — no additional files or folders needed

> **Windows Defender note:** PyInstaller executables may occasionally be flagged as a false positive. If this happens, add an exclusion for the `dist\` folder in Windows Security settings, or [submit the file to Microsoft for analysis](https://www.microsoft.com/en-us/wdsi/filesubmission) to get it whitelisted.

### macOS

1. Install Python 3.8+ (via Homebrew: `brew install python`)
2. Install unar for 7z extraction: `brew install unar`
3. Clone the repository and run:
   ```bash
   pip3 install -r requirements.txt
   python3 app.py
   ```

## Configuration

1. Launch the application — it will open your default browser automatically
2. Click the **gear icon** (⚙️) in the navigation bar to open Settings

### Theme Selection

Choose from 10 color themes via the **palette icon** in the navbar:
- OLED Limited Edition (default orange)
- OLED Black, Classic White, Monochrome
- Steam Blue, Purple Haze, Matrix Green
- Crimson Red, Ocean Teal, Sunset Gold

### RomM API Settings

- **RomM API URL:** Your RomM API endpoint (e.g., `http://192.168.1.100:8080/api`)
- **Username:** Your RomM username
- **Password:** Your RomM password

### Default Platform

Select which platform loads by default when opening the app. Defaults to Windows (PC).

### Windows Games Download

For Windows games:
- **Download Staging Path:** Where compressed files are downloaded before extraction
- **Windows Games Install Path:** Where games are extracted

Default paths:
- **Steam Deck/Linux:** `/home/deck/Games/Windows` or as configured
- **Windows:** `C:\Users\{username}\Games\Windows`

Windows games will be automatically extracted using 7z. After extraction, a **Create Shortcut** button appears on the game card.

### Platform Folder Mapping

1. Click **Refresh Platforms from RomM** to fetch your platforms
2. Set the **Base Path for ROMs** (e.g., `/home/deck/retrodeck/roms` or `C:\Games\ROMs`)
3. Click **Auto-Fill All Paths** to automatically set platform folders using RomM's folder names
4. Adjust individual platform paths as needed

## Usage

1. Click the **☰ menu** in the navigation bar to open the Platforms & Sort drawer
2. Select a platform from the list — the game grid updates immediately
3. Use the Sort By pills at the top of the drawer to change sort order
4. Click on a game cover to see details
5. Click **Download** to download a game with real-time progress tracking
6. For Windows games, after extraction click the **desktop icon** on the game card to open the shortcut dialog:
   - Select the `.exe` file to use for the shortcut
   - Click **Create Shortcut** — a desktop shortcut is created
   - **Steam Deck:** right-click the shortcut on the desktop → **Add to Steam** to add it to your Steam library
7. Downloaded games show a **Delete** button to remove the local files
8. Click the **power icon** in the navbar to stop the app (no terminal needed)

## Requirements

- **RomM instance** with API access enabled
- **7-Zip** for Windows game extraction:
  - Steam Deck/SteamOS: Pre-installed
  - Linux: `sudo apt install p7zip-full` or equivalent
  - Windows: Download from [7-zip.org](https://www.7-zip.org/)
  - macOS: `brew install unar`
- **RetroDeck, EmuDeck, or similar** emulator setup (optional, for automatic folder organization)

## Data Storage

Configuration and database are stored in:

**Linux/Steam Deck/macOS:**
- `~/.config/romm2steamdeck/config.json`
- `~/.config/romm2steamdeck/romm2steamdeck.db`
- `~/.config/romm2steamdeck/system.log`

**Windows:**
- `%APPDATA%\romm2steamdeck\config.json`
- `%APPDATA%\romm2steamdeck\romm2steamdeck.db`
- `%APPDATA%\romm2steamdeck\system.log`

## Development

To run in development mode:

**Linux/macOS:**
```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the app
python3 app.py
```

**Windows:**
```cmd
# Create virtual environment
python -m venv venv
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the app
python app.py
```

The app will run on `http://localhost:5001` by default.

## Running as a Service

RomM2SteamDeck can be run as a background service on all supported platforms, allowing it to start automatically and run continuously.

### Quick Start

**Linux / Steam Deck:**
```bash
# Copy service file
mkdir -p ~/.config/systemd/user
cp deployment/romm2steamdeck.service ~/.config/systemd/user/

# Edit paths in service file, then:
systemctl --user daemon-reload
systemctl --user enable romm2steamdeck.service
systemctl --user start romm2steamdeck.service
```

**Windows:**
- Use NSSM (recommended) or pywin32 service wrapper
- See `deployment/README.md` for detailed instructions
- **Alternative:** Simply run `RomM2SteamDeck.exe` directly — it will automatically open your system's default browser to the app

**macOS:**
```bash
cp deployment/com.romm2steamdeck.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.romm2steamdeck.plist
```

### Steam Deck Game Mode

**Option 1: Using the systemd service**
1. Set up the systemd service in Desktop Mode (see above)
2. Add your browser to Steam as a non-Steam game
3. Set browser launch options to: `http://localhost:5001`
4. Launch from Game Mode - the service runs in the background

**Option 2: Run the AppImage directly in Game Mode**

AppImages don't run in Game Mode by default — you need [AppImageLauncher Lite](https://github.com/TheAssassin/AppImageLauncher) to make them compatible:

1. In Desktop Mode, download **AppImageLauncher Lite** from [GitHub](https://github.com/TheAssassin/AppImageLauncher)
2. Open Konsole and install it:
   ```bash
   chmod +x appimagelauncher-lite-*.AppImage
   ./appimagelauncher-lite-*.AppImage install
   ```
3. Move `RomM2SteamDeck-x86_64.AppImage` into your `~/Applications` folder (create it if it doesn't exist) — AppImageLauncher will automatically convert it
4. In Steam (Desktop Mode), go to **Library → Add a Game → Add a Non-Steam Game** and select the converted AppImage from the Applications folder
5. Switch to Game Mode — the app will now be available under your non-Steam games

For more details, see [How to Install AppImages on Steam Deck for Game Mode](https://www.gamesinhand.com/post/how-to-install-appimages-on-steam-deck-for-game-mode)

For detailed deployment instructions, see [`deployment/README.md`](deployment/README.md).

## API Endpoints

- `GET /api/platforms` - List all platforms
- `GET /api/platform/{id}/roms` - Get ROMs for a platform
- `GET /api/rom/{id}` - Get ROM details
- `POST /api/download/{id}` - Start download
- `GET /api/download/progress/{id}` - SSE progress stream
- `GET /api/downloads` - List downloaded ROMs
- `DELETE /api/downloads/{id}` - Delete downloaded ROM
- `POST /api/quit` - Gracefully stop the application

## Changelog

### v1.0.4
- Fixed 500-game limit per platform — the RomM API is now paginated with `offset` until all games are fetched
- Made the SQLite layer thread-safe (shared connection now guarded by a lock; write errors no longer silently swallowed)
- Added connect/read timeouts to game downloads so a stalled connection errors out instead of hanging forever
- Fixed a PowerShell command injection risk in Windows shortcut creation (paths now passed via environment variables)
- Delete now refuses to remove a configured platform/install root folder, even if a bad download record points at one
- Extraction tracking now prefers the extracted top-level folder and never records the install root as the game path
- Download progress stream now times out cleanly when no download is active
- Removed ~200 lines of dead legacy Windows download code
- Centralized the version string (`APP_VERSION` in `app.py`)

### v1.0.3
- Replaced platform/sort dropdowns with a slide-out drawer (fixes touch/click issues on Steam Deck)
- Added Quit button to the navbar — stops the app without needing a terminal
- Fixed browser launch on Linux to use `xdg-open` (respects default browser, e.g. Librewolf)
- Fixed delete confirmation dialog (native `confirm()` was blocked by Librewolf on Steam Deck)
- Added Steam Deck tip in the shortcut dialog: right-click shortcut → Add to Steam
- Fixed cursor repositioning issue caused by `window.scrollTo()` in Gamescope
- AppImage: explicitly exclude pywebview to prevent crash when GTK/Qt is unavailable
- AppImage: version number now auto-read from `app.py`
- Shortened navbar brand to "R2SD" to save space

### v1.0.2
- Switched Windows build script from Nuitka to PyInstaller
- Added Python auto-install to `build_windows.bat`
- Fixed exe scan modal (wrong keyword argument in database query)
- Fixed exe selection in shortcut modal (HTML attribute quoting issue)
- Fixed extracting progress indicator layout
- Added shortcut button overlay for already-downloaded Windows games
- Suppressed 7-Zip console window on Windows using `CREATE_NO_WINDOW`
- Added pywebview support for native window experience (optional, Python ≤ 3.12)
- Removed bundled OpenSSL from AppImage to fix libcurl conflict on Steam Deck

### v1.0.1
- Added sort dropdown (Name, Date, Genre, Size)
- README improvements

### v1.0.0
- Initial release

## Acknowledgments

This project was inspired by and built upon the work of:

- **[DeckRommSync-Standalone](https://github.com/PeriBluGaming/DeckRommSync-Standalone)** by PeriBluGaming - The original project that provided the foundation for this tool. Thank you for the great idea and initial implementation!

- **[RomM](https://github.com/rommapp/romm)** - An amazing ROM management solution that makes organizing and serving game libraries a breeze. This project wouldn't exist without RomM's excellent API.

## License

See [LICENSE.md](LICENSE.md)
