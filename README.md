# RomM2SteamDeck

RomM2SteamDeck is a tool to download ROMs and Windows games from your [RomM](https://github.com/rommapp/romm) library directly to your Steam Deck, Windows PC, or Linux system. Browse your game collection by platform and download individual games on-demand.

## Features

- **Browse by Platform** - View your RomM library organized by platform with a dropdown selector
- **Download with Progress** - Download individual games with real-time progress bar
- **Windows Games Support** - Download and extract Windows games (7z/zip) automatically
- **Add to Steam** - Add downloaded Windows games to Steam as non-Steam games
- **Download Tracking** - Track downloaded games and delete them when no longer needed
- **Filesystem Sync** - Automatically detect games downloaded outside the app
- **Multiple Themes** - Choose from 10 different color themes including Steam Deck OLED Limited Edition orange
- **Platform Folder Mapping** - Auto-configure paths using RomM's folder structure
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
2. Run the build script:
   ```cmd
   pip install pyinstaller
   pyinstaller --onedir --name RomM2SteamDeck --add-data "templates;templates" --add-data "config.json;." app.py
   ```
3. The executable will be in the `dist/RomM2SteamDeck` folder

### macOS

1. Install Python 3.8+ (via Homebrew: `brew install python`)
2. Install unar for 7z extraction: `brew install unar`
3. Clone the repository and run:
   ```bash
   pip3 install -r requirements.txt
   python3 app.py
   ```

## Configuration

1. Launch the application
2. Open a browser and navigate to `http://localhost:5001`
3. Click on the **gear icon** (⚙️) in the navigation bar to open Settings

### Theme Selection

Choose from 10 color themes:
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

Windows games will be automatically extracted using 7z. After extraction, you'll be prompted to add the game to Steam.

### Platform Folder Mapping

1. Click **Refresh Platforms from RomM** to fetch your platforms
2. Set the **Base Path for ROMs** (e.g., `/home/deck/retrodeck/roms` or `C:\Games\ROMs`)
3. Click **Auto-Fill All Paths** to automatically set platform folders using RomM's folder names
4. Adjust individual platform paths as needed

## Usage

1. Select a platform from the dropdown in the navigation bar
2. Browse games - click on a game cover to see details
3. Click **Download** to download a game with progress tracking
4. For Windows games, after extraction you'll be prompted to select an .exe to add to Steam
5. Downloaded games show a **Delete** button to remove them

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

## API Endpoints

- `GET /api/platforms` - List all platforms
- `GET /api/platform/{id}/roms` - Get ROMs for a platform
- `GET /api/rom/{id}` - Get ROM details
- `POST /api/download/{id}` - Start download
- `GET /api/download/progress/{id}` - SSE progress stream
- `GET /api/downloads` - List downloaded ROMs
- `DELETE /api/downloads/{id}` - Delete downloaded ROM
- `POST /api/add_to_steam` - Add exe to Steam

## Acknowledgments

This project was inspired by and built upon the work of:

- **[DeckRommSync-Standalone](https://github.com/PeriBluGaming/DeckRommSync-Standalone)** by PeriBluGaming - The original project that provided the foundation for this tool. Thank you for the great idea and initial implementation!

- **[RomM](https://github.com/rommapp/romm)** - An amazing ROM management solution that makes organizing and serving game libraries a breeze. This project wouldn't exist without RomM's excellent API.

## License

See [LICENSE.md](LICENSE.md)
