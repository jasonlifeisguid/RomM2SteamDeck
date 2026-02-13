from flask import Flask, redirect, render_template, request, jsonify, url_for, Response
from classes.RommAPIHelper import RommAPIHelper
from classes.RomM2SteamDeckDatabase import RomM2SteamDeckDatabase
import json
import os
import sys
import logging
import threading
import time
import shutil
import zipfile
import subprocess
import traceback
import webbrowser
from datetime import datetime


# URL for browser launch
launch_url = "http://127.0.0.1:5001"

# Global dictionary to track download progress
download_progress = {}
download_progress_lock = threading.Lock()

# Per-ROM cancel signals: rom_id → threading.Event
download_cancel_events = {}

# Database singleton for better performance
_db_instance = None

def get_db():
    """Get singleton database instance."""
    global _db_instance
    if _db_instance is None:
        _db_instance = RomM2SteamDeckDatabase(get_db_path())
    return _db_instance

# Determine data directory - platform-specific locations
def get_data_dir():
    """Get the data directory for config and database files."""
    # If running from AppImage or installed location, use user config dir
    if os.environ.get('APPIMAGE') or not os.path.isfile('config.json'):
        if sys.platform == 'win32':
            # Windows: Use %APPDATA%\romm2steamdeck
            data_dir = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'romm2steamdeck')
        else:
            # Linux/macOS: Use ~/.config/romm2steamdeck
            data_dir = os.path.join(os.path.expanduser('~'), '.config', 'romm2steamdeck')
        os.makedirs(data_dir, exist_ok=True)
        return data_dir
    # Otherwise use current directory (development mode)
    return os.getcwd()

DATA_DIR = get_data_dir()

if getattr(sys, 'frozen', False):
    # Running as PyInstaller bundle - templates are in the temp extraction dir
    _bundle_dir = sys._MEIPASS
else:
    _bundle_dir = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, template_folder=os.path.join(_bundle_dir, 'templates'))

# Set up system logger
system_logger = logging.getLogger("system_logger")
system_logger.setLevel(logging.INFO)
log_file = os.path.join(DATA_DIR, "system.log")
system_handler = logging.FileHandler(log_file, encoding="utf-8")
system_formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
system_handler.setFormatter(system_formatter)
system_logger.addHandler(system_handler)

def get_db_path():
    """Get the full path to the database file."""
    return os.path.join(DATA_DIR, app_config.get("database", {}).get("name", "romm2steamdeck.db"))

def get_config_path():
    """Get the full path to the config file."""
    return os.path.join(DATA_DIR, "config.json")

def load_json_config():
    """Load configuration from JSON file, creating default if needed."""
    config_path = get_config_path()
    system_logger.info(f"Load Config from {config_path}")
    
    # Default configuration
    default_config = {
        "server": {
            "host": "0.0.0.0",
            "port": 5001
        },
        "database": {
            "name": "romm2steamdeck.db",
            "type": "sqlite"
        }
    }
    
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            return json.load(f)
    else:
        # Create default config
        with open(config_path, "w") as f:
            json.dump(default_config, f, indent=4)
        return default_config

def init_database():
    """Initialize database with required tables and default config."""
    db_path = get_db_path()
    db = RomM2SteamDeckDatabase(db_path)
    
    # Create tables if they don't exist
    db.execute_query("""
        CREATE TABLE IF NOT EXISTS config (
            config_id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_key TEXT UNIQUE,
            config_value TEXT
        )
    """)
    
    db.execute_query("""
        CREATE TABLE IF NOT EXISTS platforms_matching (
            romm_platform_id INTEGER PRIMARY KEY,
            romm_platform_name TEXT,
            romm_fs_slug TEXT DEFAULT '',
            steamdeck_platform_name TEXT DEFAULT ''
        )
    """)
    
    # Track downloaded ROMs
    db.execute_query("""
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rom_id INTEGER UNIQUE,
            rom_name TEXT,
            filename TEXT,
            file_path TEXT,
            platform_id INTEGER,
            file_size INTEGER DEFAULT 0,
            downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Add romm_fs_slug column if it doesn't exist (for existing databases)
    try:
        db.execute_query("ALTER TABLE platforms_matching ADD COLUMN romm_fs_slug TEXT DEFAULT ''")
    except Exception:
        pass  # Column already exists

    # Add auto_extract column for per-platform extraction setting
    try:
        db.execute_query("ALTER TABLE platforms_matching ADD COLUMN auto_extract INTEGER DEFAULT 0")
    except Exception:
        pass  # Column already exists

    # Add install_paths column for per-platform install paths (JSON array)
    try:
        db.execute_query("ALTER TABLE platforms_matching ADD COLUMN install_paths TEXT DEFAULT '[]'")
    except Exception:
        pass  # Column already exists

    # Add indexes for better query performance
    try:
        db.execute_query("CREATE INDEX IF NOT EXISTS idx_downloads_rom_id ON downloads(rom_id)")
        db.execute_query("CREATE INDEX IF NOT EXISTS idx_downloads_platform_id ON downloads(platform_id)")
        db.execute_query("CREATE INDEX IF NOT EXISTS idx_config_key ON config(config_key)")
        db.execute_query("CREATE INDEX IF NOT EXISTS idx_platforms_matching_id ON platforms_matching(romm_platform_id)")
    except Exception:
        pass  # Indexes already exist
    
    # Insert default config values ONLY if they don't exist (using INSERT OR IGNORE)
    # Use platform-appropriate default paths
    if sys.platform == 'win32':
        default_roms_path = os.path.join(os.path.expanduser('~'), 'Games', 'ROMs')
        default_downloads = os.path.join(os.path.expanduser('~'), 'Downloads')
        default_install_path = os.path.join(os.path.expanduser('~'), 'Games', 'Windows')
    else:
        default_roms_path = os.path.expanduser('~/retrodeck/roms')
        default_downloads = os.path.expanduser('~/Downloads')
        default_install_path = ''
    
    default_configs = [
        ('romm_api_base_url', ''),
        ('romm_username', ''),
        ('romm_password', ''),
        ('steamdeck_retrodeck_path', default_roms_path),
        ('default_platform_id', '249'),  # Default to Windows
        ('download_staging_path', default_downloads),  # Staging path for auto_extract platforms
        ('windows_download_path', default_downloads),  # Legacy key (same as staging path)
        ('windows_install_path', default_install_path),
        ('theme', 'oled-limited'),  # Default theme
        ('open_browser_on_startup', '1')  # Enabled by default
    ]

    for key, value in default_configs:
        db.execute_query(
            "INSERT OR IGNORE INTO config (config_key, config_value) VALUES (?, ?)",
            (key, value)
        )

    # Migrate legacy install paths → windows_install_paths JSON array (one-time)
    try:
        row = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('windows_install_paths',))
        if not row:
            paths = []
            # Pull in legacy primary path
            old1 = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('windows_install_path',))
            if old1 and old1[0].get('config_value', '').strip():
                paths.append(old1[0]['config_value'].strip())
            # Pull in legacy secondary path (added in a previous session)
            old2 = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('windows_install_path_2',))
            if old2 and old2[0].get('config_value', '').strip():
                paths.append(old2[0]['config_value'].strip())
            db.execute_query(
                "INSERT INTO config (config_key, config_value) VALUES (?, ?)",
                ('windows_install_paths', json.dumps(paths))
            )
            system_logger.info(f"Migrated install paths to JSON array: {paths}")
    except Exception as e:
        system_logger.error(f"Error migrating install paths: {e}")

    # Migrate Windows config to per-platform settings (one-time)
    # Find Windows platform by fs_slug or name containing 'windows'
    try:
        windows_platforms = db.select_as_dict("platforms_matching",
            ['romm_platform_id', 'auto_extract', 'install_paths', 'romm_platform_name', 'romm_fs_slug'],
            "(LOWER(romm_fs_slug) LIKE '%windows%' OR LOWER(romm_platform_name) LIKE '%windows%')")

        for platform in windows_platforms:
            platform_id = platform.get('romm_platform_id')
            current_paths = platform.get('install_paths', '[]')

            # Only migrate if install_paths is empty/not configured
            try:
                parsed_paths = json.loads(current_paths or '[]')
            except:
                parsed_paths = []

            if not parsed_paths:
                # Get windows_install_paths from config
                config_row = db.select_as_dict("config", ['config_value'],
                                               'config_key = ?', ('windows_install_paths',))
                if config_row:
                    try:
                        windows_paths = json.loads(config_row[0].get('config_value', '[]') or '[]')
                    except:
                        windows_paths = []

                    if windows_paths:
                        # Copy paths and enable auto_extract for Windows platform
                        db.execute_query("""
                            UPDATE platforms_matching
                            SET install_paths = ?, auto_extract = 1
                            WHERE romm_platform_id = ?
                        """, (json.dumps(windows_paths), platform_id))
                        system_logger.info(f"Migrated Windows install paths to platform {platform_id}: {windows_paths}")
    except Exception as e:
        system_logger.error(f"Error migrating Windows platform settings: {e}")

    system_logger.info(f"Database initialized at {db_path}")

# RomM API caching
_romm_instance = None
_romm_timestamp = 0
_ROMM_CACHE_TTL = 300  # 5 minutes

def get_romm_api():
    """Get cached RomM API helper instance (refreshes every 5 minutes)."""
    global _romm_instance, _romm_timestamp

    current_time = time.time()
    if _romm_instance is None or (current_time - _romm_timestamp) > _ROMM_CACHE_TTL:
        db = get_db()
        config_result = db.select_as_dict("config")
        config_dict = {row['config_key']: row['config_value'] for row in config_result}

        _romm_instance = RommAPIHelper(config_dict.get('romm_api_base_url', ''))
        _romm_instance.login(config_dict.get('romm_username', ''), config_dict.get('romm_password', ''))
        _romm_timestamp = current_time

    return _romm_instance

def get_steamdeck_path():
    """Get the configured Steam Deck path."""
    db = get_db()
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('steamdeck_retrodeck_path',))
    return result[0].get("config_value", "") if result else ""

def get_current_theme():
    """Get the current theme from config."""
    db = get_db()
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('theme',))
    return result[0].get("config_value", "oled-limited") if result else "oled-limited"

def maybe_open_browser():
    """Open browser on startup if configured to do so."""
    try:
        db = get_db()
        result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('open_browser_on_startup',))
        should_open = result[0].get("config_value", "1") == "1" if result else True
        
        if should_open:
            webbrowser.open(launch_url)
            system_logger.info("Opened browser on startup")
        else:
            system_logger.info("Browser startup disabled in settings")
    except Exception as e:
        system_logger.error(f"Error checking browser startup setting: {e}")
        # Default to opening browser if we can't read the setting
        webbrowser.open(launch_url)

# Available themes
THEMES = [
    {'id': 'oled-limited', 'name': 'OLED Limited Edition', 'color': '#FF6B00', 'description': 'Orange - Steam Deck OLED LE'},
    {'id': 'oled-black', 'name': 'OLED Black', 'color': '#000000', 'description': 'Pure black for OLED screens'},
    {'id': 'classic-white', 'name': 'Classic White', 'color': '#ffffff', 'description': 'Clean white theme'},
    {'id': 'monochrome', 'name': 'Monochrome', 'color': '#333333', 'description': 'Black and white'},
    {'id': 'steam-blue', 'name': 'Steam Blue', 'color': '#1b2838', 'description': 'Classic Steam colors'},
    {'id': 'purple-haze', 'name': 'Purple Haze', 'color': '#7b2cbf', 'description': 'Deep purple vibes'},
    {'id': 'matrix-green', 'name': 'Matrix Green', 'color': '#00ff41', 'description': 'Retro hacker green'},
    {'id': 'crimson-red', 'name': 'Crimson Red', 'color': '#dc2626', 'description': 'Bold red theme'},
    {'id': 'ocean-teal', 'name': 'Ocean Teal', 'color': '#0d9488', 'description': 'Cool teal waters'},
    {'id': 'sunset-gold', 'name': 'Sunset Gold', 'color': '#f59e0b', 'description': 'Warm golden tones'},
]

def record_download(rom_id, rom_name, filename, file_path, platform_id, file_size=0):
    """Record a successful download in the database."""
    db = get_db()
    db.execute_query("""
        INSERT OR REPLACE INTO downloads (rom_id, rom_name, filename, file_path, platform_id, file_size, downloaded_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    """, (rom_id, rom_name, filename, file_path, platform_id, file_size))
    system_logger.info(f"Recorded download: {rom_name} ({rom_id}) at {file_path}")

def get_downloaded_rom_ids():
    """Get set of ROM IDs that have been downloaded."""
    db = get_db()
    results = db.select_as_dict("downloads", ['rom_id'])
    return {row['rom_id'] for row in results}

def get_download_info(rom_id):
    """Get download info for a specific ROM."""
    db = get_db()
    results = db.select_as_dict("downloads", ['*'], "rom_id = ?", (rom_id,))
    return results[0] if results else None

def remove_download_record(rom_id):
    """Remove a download record from the database."""
    db = get_db()
    db.execute_query("DELETE FROM downloads WHERE rom_id = ?", (rom_id,))

def sync_downloads_with_filesystem(platform_id, roms):
    """
    Sync download records with actual files on disk.
    - Adds records for files that exist but aren't tracked
    - Removes records for files that no longer exist
    """
    db = get_db()

    # Get platform config (includes auto_extract and install_paths)
    platform_config = get_platform_config(platform_id)
    platform_folder = platform_config['rom_folder']

    # For platforms with auto_extract, check install paths for extracted files
    install_paths = []
    if platform_config['auto_extract'] and platform_config['install_paths']:
        install_paths = platform_config['install_paths']
    
    # Get currently tracked downloads for this platform
    tracked = db.select_as_dict("downloads", ['*'], "platform_id = ?", (platform_id,))
    tracked_by_rom_id = {row['rom_id']: row for row in tracked}
    
    # Helper to sanitize names for matching (lowercase, alphanumeric + spaces)
    def sanitize_for_match(name):
        return "".join(c for c in name.lower() if c.isalnum() or c == ' ').strip()

    # Build a map of ROM filenames to ROM data
    rom_by_filename = {}
    rom_by_name = {}  # For extracted game folders (case-insensitive matching)
    for rom in roms:
        fs_name = rom.get('fs_name', '')
        if fs_name:
            rom_by_filename[fs_name] = rom
            rom_by_filename[fs_name.lower()] = rom  # Case-insensitive
            # Also map without extension for flexibility
            base_name = os.path.splitext(fs_name)[0]
            rom_by_filename[base_name] = rom
            rom_by_filename[base_name.lower()] = rom  # Case-insensitive
            # Map sanitized base name for folder matching
            rom_by_name[sanitize_for_match(base_name)] = rom

        # Also map by sanitized ROM name (folder names often match game name)
        rom_name = rom.get('name', '')
        if rom_name:
            rom_by_name[sanitize_for_match(rom_name)] = rom
    
    changes = {'added': 0, 'removed': 0}
    
    # Check for files that exist but aren't tracked (using scandir for better performance)
    if platform_folder and os.path.isdir(platform_folder):
        for entry in os.scandir(platform_folder):
            item = entry.name
            item_path = entry.path

            # Try to match to a ROM
            rom = rom_by_filename.get(item)
            if not rom:
                # Try without extension
                base_name = os.path.splitext(item)[0]
                rom = rom_by_filename.get(base_name)

            if rom and rom['id'] not in tracked_by_rom_id:
                # Found a file that matches a ROM but isn't tracked
                file_size = entry.stat().st_size if entry.is_file() else 0
                record_download(rom['id'], rom.get('name', item), item, item_path, platform_id, file_size)
                changes['added'] += 1
                system_logger.info(f"Sync: Added existing file to tracking: {item}")

    # For platforms with auto_extract, also check install paths for extracted game folders
    for extract_install_path in install_paths:
        if extract_install_path and os.path.isdir(extract_install_path):
            for entry in os.scandir(extract_install_path):
                if entry.is_dir():
                    item = entry.name
                    item_path = entry.path
                    # Try to match folder name to a ROM name (sanitized for better matching)
                    sanitized_item = sanitize_for_match(item)
                    rom = rom_by_name.get(sanitized_item)
                    if rom and rom['id'] not in tracked_by_rom_id:
                        record_download(rom['id'], rom.get('name', item), item, item_path, platform_id, 0)
                        changes['added'] += 1
                        system_logger.info(f"Sync: Added existing game folder to tracking: {item}")
    
    # Check tracked downloads - remove if file no longer exists
    for rom_id, download_info in tracked_by_rom_id.items():
        file_path = download_info.get('file_path', '')
        if file_path and not os.path.exists(file_path):
            remove_download_record(rom_id)
            changes['removed'] += 1
            system_logger.info(f"Sync: Removed missing file from tracking: {file_path}")
    
    return changes

def get_platform_folder(platform_id):
    """Get the Steam Deck folder name for a platform."""
    db = get_db()
    result = db.select_as_dict("platforms_matching", ['steamdeck_platform_name'], 'romm_platform_id = ?', (platform_id,))
    return result[0].get("steamdeck_platform_name", "") if result else ""

def get_platform_config(platform_id):
    """Get platform configuration including auto_extract and install_paths."""
    db = get_db()
    result = db.select_as_dict("platforms_matching",
        ['steamdeck_platform_name', 'auto_extract', 'install_paths'],
        'romm_platform_id = ?', (platform_id,))
    if result:
        row = result[0]
        try:
            install_paths = json.loads(row.get('install_paths', '[]') or '[]')
        except (json.JSONDecodeError, TypeError):
            install_paths = []
        return {
            'rom_folder': row.get('steamdeck_platform_name', ''),
            'auto_extract': bool(row.get('auto_extract', 0)),
            'install_paths': install_paths
        }
    return {'rom_folder': '', 'auto_extract': False, 'install_paths': []}

def get_platform_slug(platform_id):
    """Get the RomM fs_slug for a platform ID."""
    db = get_db()
    result = db.select_as_dict("platforms_matching", ['romm_fs_slug'],
                               'romm_platform_id = ?', (platform_id,))
    return result[0].get('romm_fs_slug', '') if result else ''

def get_romm_base_url():
    """Get the configured RomM API base URL."""
    db = get_db()
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('romm_api_base_url',))
    url = result[0].get("config_value", "") if result else ""
    # Remove /api suffix if present to get base URL
    return url.replace('/api', '') if url else ""

def get_default_platform_id():
    """Get the configured default platform ID."""
    db = get_db()
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('default_platform_id',))
    return result[0].get("config_value", "249") if result else "249"

@app.route('/')
def browse():  
    system_logger.info("Browse Page")
    
    # Ensure RomM connection settings are configured; otherwise send user to Settings
    db = get_db()
    config_rows = db.select_as_dict("config")
    config_dict = {row['config_key']: row['config_value'] for row in config_rows}
    romm_url = config_dict.get('romm_api_base_url', '').strip()
    romm_user = config_dict.get('romm_username', '').strip()
    romm_pass = config_dict.get('romm_password', '').strip()
    if not romm_url or not romm_user or not romm_pass:
        system_logger.info("RomM credentials missing; redirecting to Settings page")
        return redirect(url_for('settings'))

    romm_base = get_romm_base_url()
    default_platform = get_default_platform_id()
    theme = get_current_theme()
    try:
        windows_install_paths = json.loads(config_dict.get('windows_install_paths', '[]'))
    except (json.JSONDecodeError, TypeError):
        windows_install_paths = []
    if not windows_install_paths and config_dict.get('windows_install_path', ''):
        windows_install_paths = [config_dict['windows_install_path']]
    return render_template(
        'browse.html',
        version="1.0.0",
        platform_id=None,
        platform_name=None,
        romm_base_url=romm_base,
        default_platform_id=default_platform,
        theme=theme,
        windows_install_paths=windows_install_paths
    )

@app.route('/platform/<int:platform_id>')
def browse_platform(platform_id):
    """Direct link to a specific platform's games."""
    system_logger.info(f"Browse Platform {platform_id}")
    
    # Ensure RomM connection settings are configured; otherwise send user to Settings
    db = get_db()
    config_rows = db.select_as_dict("config")
    config_dict = {row['config_key']: row['config_value'] for row in config_rows}
    romm_url = config_dict.get('romm_api_base_url', '').strip()
    romm_user = config_dict.get('romm_username', '').strip()
    romm_pass = config_dict.get('romm_password', '').strip()
    if not romm_url or not romm_user or not romm_pass:
        system_logger.info("RomM credentials missing; redirecting to Settings page")
        return redirect(url_for('settings'))

    romm_base = get_romm_base_url()
    default_platform = get_default_platform_id()
    theme = get_current_theme()
    try:
        windows_install_paths = json.loads(config_dict.get('windows_install_paths', '[]'))
    except (json.JSONDecodeError, TypeError):
        windows_install_paths = []
    if not windows_install_paths and config_dict.get('windows_install_path', ''):
        windows_install_paths = [config_dict['windows_install_path']]
    # Get platform name from the database or API
    try:
        db = get_db()
        result = db.select_as_dict("platforms_matching", ['romm_platform_name'], 'romm_platform_id = ?', (platform_id,))
        platform_name = result[0].get("romm_platform_name", f"Platform {platform_id}") if result else f"Platform {platform_id}"
    except:
        platform_name = f"Platform {platform_id}"
    return render_template(
        'browse.html',
        version="1.0.0",
        platform_id=platform_id,
        platform_name=platform_name,
        romm_base_url=romm_base,
        default_platform_id=default_platform,
        theme=theme,
        windows_install_paths=windows_install_paths
    )


# API: Get all platforms from RomM
@app.route('/api/platforms')
def api_platforms():
    try:
        romm = get_romm_api()
        platforms = romm.getPlatforms()
        return jsonify({"success": True, "platforms": platforms})
    except Exception as e:
        system_logger.error(f"Error fetching platforms: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# API: Get ROMs for a specific platform
@app.route('/api/platform/<int:platform_id>/roms')
def api_platform_roms(platform_id):
    try:
        romm = get_romm_api()
        roms = romm.getRomsByPlatform(platform_id)
        system_logger.info(f"Fetched {len(roms) if roms else 0} ROMs for platform {platform_id}")
        if roms:
            system_logger.info(f"First ROM sample: {roms[0] if len(roms) > 0 else 'empty'}")
        return jsonify({"success": True, "roms": roms if roms else []})
    except Exception as e:
        system_logger.error(f"Error fetching ROMs for platform {platform_id}: {e}")
        system_logger.error(traceback.format_exc())
        return jsonify({"success": False, "error": str(e)}), 500

# API: Get platform configuration (auto_extract, install_paths)
@app.route('/api/platform/<int:platform_id>/config')
def api_platform_config(platform_id):
    """Get platform configuration for download handling."""
    try:
        config = get_platform_config(platform_id)
        return jsonify({
            "success": True,
            "platform_id": platform_id,
            "auto_extract": config['auto_extract'],
            "install_paths": config['install_paths'],
            "rom_folder": config['rom_folder']
        })
    except Exception as e:
        system_logger.error(f"Error fetching platform config for {platform_id}: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# API: Update platform configuration
@app.route('/api/platform/<int:platform_id>/config', methods=['POST'])
def api_update_platform_config(platform_id):
    """Update platform configuration (auto_extract, install_paths)."""
    try:
        data = request.get_json(silent=True) or {}
        db = get_db()

        # Get current values
        result = db.select_as_dict("platforms_matching",
            ['auto_extract', 'install_paths'],
            'romm_platform_id = ?', (platform_id,))

        if not result:
            return jsonify({"success": False, "error": "Platform not found"}), 404

        # Update only provided fields
        updates = []
        params = []

        if 'auto_extract' in data:
            updates.append("auto_extract = ?")
            params.append(1 if data['auto_extract'] else 0)

        if 'install_paths' in data:
            updates.append("install_paths = ?")
            paths = data['install_paths']
            if isinstance(paths, list):
                params.append(json.dumps(paths))
            else:
                params.append('[]')

        if updates:
            params.append(platform_id)
            db.execute_query(
                f"UPDATE platforms_matching SET {', '.join(updates)} WHERE romm_platform_id = ?",
                tuple(params)
            )

        return jsonify({"success": True})
    except Exception as e:
        system_logger.error(f"Error updating platform config for {platform_id}: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# API: Get single ROM details
@app.route('/api/rom/<int:rom_id>')
def api_rom_details(rom_id):
    """Get detailed information for a specific ROM."""
    try:
        romm = get_romm_api()
        rom = romm.getRomByID(rom_id)
        if rom:
            return jsonify({"success": True, "rom": rom})
        else:
            return jsonify({"success": False, "error": "ROM not found"}), 404
    except Exception as e:
        system_logger.error(f"Error fetching ROM {rom_id}: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# API: Get downloaded ROM IDs
@app.route('/api/downloads')
def api_downloads():
    """Get list of all downloaded ROM IDs."""
    try:
        downloaded_ids = list(get_downloaded_rom_ids())
        return jsonify({"success": True, "downloaded_ids": downloaded_ids})
    except Exception as e:
        system_logger.error(f"Error fetching downloads: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# API: Sync downloads with filesystem for a platform
@app.route('/api/downloads/sync/<int:platform_id>', methods=['POST'])
def api_sync_downloads(platform_id):
    """Sync download records with actual files on disk for a platform."""
    try:
        # Get ROMs for this platform to match files
        romm = get_romm_api()
        roms = romm.getRomsByPlatform(platform_id)
        
        if not roms:
            return jsonify({"success": True, "changes": {"added": 0, "removed": 0}, "message": "No ROMs found for platform"})
        
        changes = sync_downloads_with_filesystem(platform_id, roms)
        
        return jsonify({
            "success": True,
            "changes": changes,
            "message": f"Sync complete: {changes['added']} added, {changes['removed']} removed"
        })
    except Exception as e:
        system_logger.error(f"Error syncing downloads for platform {platform_id}: {e}")
        system_logger.error(traceback.format_exc())
        return jsonify({"success": False, "error": str(e)}), 500

# API: Get download info for a specific ROM
@app.route('/api/downloads/<int:rom_id>')
def api_download_info(rom_id):
    """Get download info for a specific ROM."""
    try:
        info = get_download_info(rom_id)
        if info:
            return jsonify({"success": True, "downloaded": True, "info": info})
        else:
            return jsonify({"success": True, "downloaded": False})
    except Exception as e:
        system_logger.error(f"Error fetching download info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

# API: Delete a downloaded ROM
@app.route('/api/downloads/<int:rom_id>', methods=['DELETE'])
def api_delete_download(rom_id):
    """Delete a downloaded ROM and its files."""
    try:
        info = get_download_info(rom_id)
        if not info:
            return jsonify({"success": False, "error": "ROM not found in downloads"}), 404
        
        file_path = info.get('file_path', '')
        deleted_files = []
        errors = []
        
        if file_path and os.path.exists(file_path):
            try:
                if os.path.isdir(file_path):
                    # For Windows games, delete the entire folder
                    shutil.rmtree(file_path)
                    deleted_files.append(file_path)
                else:
                    # For single files
                    os.remove(file_path)
                    deleted_files.append(file_path)
            except Exception as e:
                errors.append(f"Failed to delete {file_path}: {e}")
        
        # Remove from database
        remove_download_record(rom_id)
        
        system_logger.info(f"Deleted download {rom_id}: {info.get('rom_name', 'Unknown')}")
        
        return jsonify({
            "success": True,
            "message": f"Deleted {info.get('rom_name', 'ROM')}",
            "deleted_files": deleted_files,
            "errors": errors
        })
    except Exception as e:
        system_logger.error(f"Error deleting download {rom_id}: {e}")
        system_logger.error(traceback.format_exc())
        return jsonify({"success": False, "error": str(e)}), 500

# Debug: Test raw API response with multiple URL patterns
@app.route('/api/debug/platform/<int:platform_id>')
def api_debug_platform(platform_id):
    """Debug endpoint to test different RomM API URL patterns."""
    import requests
    from base64 import b64encode
    
    db = get_db()
    config_result = db.select_as_dict("config")
    config_dict = {row['config_key']: row['config_value'] for row in config_result}
    
    api_base_url = config_dict.get('romm_api_base_url', '')
    username = config_dict.get('romm_username', '')
    password = config_dict.get('romm_password', '')
    
    auth_string = f"{username}:{password}"
    auth_encoded = b64encode(auth_string.encode()).decode()
    
    headers = {
        "accept": "application/json",
        "Authorization": f"Basic {auth_encoded}"
    }
    
    # Test multiple URL patterns
    url_patterns = [
        f"{api_base_url}/roms?platform_ids={platform_id}&limit=5",  # Correct endpoint
        f"{api_base_url}/roms?platform_id={platform_id}&limit=5",
        f"{api_base_url}/platforms/{platform_id}/roms",
    ]
    
    results = []
    for url in url_patterns:
        try:
            response = requests.get(url, headers=headers, timeout=10)
            result = {
                "url": url,
                "status_code": response.status_code,
            }
            if response.status_code == 200:
                data = response.json()
                result["response_type"] = str(type(data).__name__)
                if isinstance(data, list):
                    result["count"] = len(data)
                    result["sample"] = data[0] if len(data) > 0 else None
                elif isinstance(data, dict):
                    result["keys"] = list(data.keys())
                    # Check for common pagination patterns
                    for key in ['items', 'roms', 'data', 'results']:
                        if key in data and isinstance(data[key], list):
                            result["count"] = len(data[key])
                            result["sample"] = data[key][0] if len(data[key]) > 0 else None
                            break
            else:
                result["error"] = response.text[:200]
            results.append(result)
        except Exception as e:
            results.append({"url": url, "error": str(e)})
    
    return jsonify({"platform_id": platform_id, "results": results})

# API: Get download progress
@app.route('/api/download/progress/<int:rom_id>')
def api_download_progress(rom_id):
    """SSE endpoint to stream download progress."""
    def generate():
        while True:
            with download_progress_lock:
                progress = download_progress.get(rom_id, {})
            
            if progress:
                data = json.dumps(progress)
                yield f"data: {data}\n\n"
                
                # If download is complete or errored, stop streaming
                if progress.get('status') in ['complete', 'error', 'extracting', 'extracted', 'cancelled']:
                    if progress.get('status') in ['complete', 'error', 'extracted', 'cancelled']:
                        # Clean up after sending final status
                        time.sleep(0.5)
                        with download_progress_lock:
                            download_progress.pop(rom_id, None)
                        break
            
            time.sleep(0.3)  # Poll every 300ms
    
    return Response(generate(), mimetype='text/event-stream')

# API: Cancel an in-progress download
@app.route('/api/download/cancel/<int:rom_id>', methods=['POST'])
def api_cancel_download(rom_id):
    cancel_event = download_cancel_events.get(rom_id)
    if cancel_event:
        cancel_event.set()
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "No active download"}), 404

# API: Start download (returns immediately, download happens in background)
@app.route('/api/download/<int:rom_id>', methods=['POST'])
def api_download_rom(rom_id):
    try:
        # Read optional install path for platforms with multiple paths configured
        data = request.get_json(silent=True) or {}
        selected_install_path = data.get('install_path', '')

        romm = get_romm_api()

        # Get ROM details
        rom = romm.getRomByID(rom_id)
        if not rom:
            return jsonify({"success": False, "error": "ROM not found"}), 404

        filename = rom.get('fs_name', '')
        platform_id = rom.get('platform_id')
        rom_name = rom.get('name', filename)
        file_size = rom.get('fs_size_bytes', 0)

        # Get platform configuration (auto_extract, install_paths, rom_folder)
        platform_config = get_platform_config(platform_id)

        # Validate paths based on platform config
        if platform_config['auto_extract']:
            # Platform uses extraction - needs install path(s) configured
            install_paths = platform_config['install_paths']
            if not install_paths:
                return jsonify({
                    "success": False,
                    "error": "Install paths not configured for this platform. Please set them in Settings."
                }), 400
            # Use selected path or first available
            install_path = selected_install_path if selected_install_path else install_paths[0]
        else:
            # Standard download - needs rom_folder configured
            if not platform_config['rom_folder'] or not platform_config['rom_folder'].strip():
                return jsonify({
                    "success": False,
                    "error": "Platform folder not configured. Please set it in Settings."
                }), 400

        # Initialize progress tracking
        with download_progress_lock:
            download_progress[rom_id] = {
                'status': 'starting',
                'progress': 0,
                'downloaded': 0,
                'total': file_size,
                'filename': filename,
                'rom_name': rom_name
            }

        # Create cancel event for this download
        cancel_event = threading.Event()
        download_cancel_events[rom_id] = cancel_event

        # Start download in background thread based on platform config
        if platform_config['auto_extract']:
            # Use unified extraction download - get global staging path from config
            db = get_db()
            config_result = db.select_as_dict("config")
            config_dict = {row['config_key']: row['config_value'] for row in config_result}
            staging_path = config_dict.get('download_staging_path', '') or config_dict.get('windows_download_path', '')
            thread = threading.Thread(target=download_with_extraction_async,
                                     args=(romm, rom_id, filename, platform_id, rom_name, file_size,
                                           install_path, staging_path, cancel_event))
        else:
            # Standard ROM download - no extraction
            thread = threading.Thread(target=download_standard_rom_async,
                                     args=(romm, rom_id, filename, platform_id, rom_name, file_size, cancel_event))
        thread.daemon = True
        thread.start()

        return jsonify({"success": True, "message": "Download started", "rom_id": rom_id})

    except Exception as e:
        system_logger.error(f"Error starting download for ROM {rom_id}: {e}")
        system_logger.error(traceback.format_exc())
        return jsonify({"success": False, "error": str(e)}), 500

def update_progress(rom_id, downloaded, total, percent):
    """Callback to update download progress."""
    with download_progress_lock:
        if rom_id in download_progress:
            download_progress[rom_id].update({
                'status': 'downloading',
                'progress': percent,
                'downloaded': downloaded,
                'total': total
            })

def download_standard_rom_async(romm, rom_id, filename, platform_id, rom_name, file_size, cancel_event=None):
    """Download ROM directly to platform folder without extraction (async version).

    For platforms with auto_extract enabled, use download_with_extraction_async instead.
    """
    try:
        platform_folder = get_platform_folder(platform_id)

        if not platform_folder:
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'error',
                    'error': 'Platform folder not configured'
                }
            download_cancel_events.pop(rom_id, None)
            return

        # Ensure directory exists
        os.makedirs(platform_folder, exist_ok=True)

        # Download the ROM with progress callback
        result = romm.downloadRom(rom_id, filename, platform_folder + "/",
                                  progress_callback=lambda d, t, p: update_progress(rom_id, d, t, p),
                                  cancel_event=cancel_event)

        # Cancelled — clean up and stop
        if result and result.get('cancelled'):
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'cancelled',
                    'progress': 0,
                    'message': 'Download cancelled'
                }
            download_cancel_events.pop(rom_id, None)
            return

        # Get the actual saved filename
        saved_filename = result.get('filename', filename) if result else filename
        file_path = os.path.join(platform_folder, saved_filename)

        # Record the download
        record_download(rom_id, rom_name, saved_filename, file_path, platform_id, file_size)

        system_logger.info(f"Downloaded ROM {rom_id} ({filename}) to {platform_folder}")

        with download_progress_lock:
            download_progress[rom_id] = {
                'status': 'complete',
                'progress': 100,
                'message': f"Downloaded {filename}",
                'path': platform_folder
            }
    except Exception as e:
        system_logger.error(f"Error in async download: {e}")
        with download_progress_lock:
            download_progress[rom_id] = {
                'status': 'error',
                'error': str(e)
            }
    finally:
        download_cancel_events.pop(rom_id, None)

def download_windows_game_async(romm, rom_id, filename, rom_name, file_size, selected_install_path='', cancel_event=None):
    """Download Windows game to staging path, then extract (async version)."""
    try:
        db = get_db()
        
        # Get Windows-specific paths
        config_result = db.select_as_dict("config")
        config_dict = {row['config_key']: row['config_value'] for row in config_result}
        
        download_path = config_dict.get('windows_download_path', '')
        # Use selected install path; fall back to first in the paths array, then legacy key
        if selected_install_path:
            install_path = selected_install_path
        else:
            try:
                paths = json.loads(config_dict.get('windows_install_paths', '[]'))
                install_path = paths[0] if paths else ''
            except (json.JSONDecodeError, TypeError):
                install_path = ''
            if not install_path:
                install_path = config_dict.get('windows_install_path', '')

        # Fall back to platform folder if install path not set
        if not install_path:
            install_path = get_platform_folder(249)  # Windows platform
        
        if not download_path:
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'error',
                    'error': 'Windows download staging path not configured'
                }
            return
        if not install_path:
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'error',
                    'error': 'Windows install path not configured'
                }
            return
        
        # Ensure directories exist
        os.makedirs(download_path, exist_ok=True)
        os.makedirs(install_path, exist_ok=True)
        
        # Download to staging path with progress
        dl_result = romm.downloadRom(rom_id, filename, download_path + "/",
                                  progress_callback=lambda d, t, p: update_progress(rom_id, d, t, p),
                                  cancel_event=cancel_event)

        # Cancelled — clean up and stop
        if dl_result and dl_result.get('cancelled'):
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'cancelled',
                    'progress': 0,
                    'message': 'Download cancelled'
                }
            download_cancel_events.pop(rom_id, None)
            return

        staging_file = os.path.join(download_path, dl_result.get('filename', filename) if dl_result else filename)
        system_logger.info(f"Downloaded Windows game {rom_id} ({filename}) to staging: {download_path}")
        
        # Update status to extracting
        with download_progress_lock:
            download_progress[rom_id].update({
                'status': 'extracting',
                'progress': 100,
                'message': 'Extracting...'
            })
        
        # Extract directly to install_path - let the archive's internal folder structure create the game folder
        # Track what's in install_path before extraction to find the new folder afterward
        existing_items = set(os.listdir(install_path)) if os.path.isdir(install_path) else set()
        
        # Extract the file
        extract_success = False
        extract_message = ""
        game_folder = install_path  # Default if we can't determine the extracted folder
        
        if filename.lower().endswith('.zip'):
            try:
                with zipfile.ZipFile(staging_file, 'r') as zip_ref:
                    file_list = zip_ref.namelist()
                    total_files = len(file_list)
                    for idx, file in enumerate(file_list):
                        zip_ref.extract(file, install_path)
                        # Update extraction progress
                        extract_percent = int((idx + 1) / total_files * 100)
                        with download_progress_lock:
                            download_progress[rom_id].update({
                                'status': 'extracting',
                                'progress': extract_percent,
                                'message': f'Extracting... {extract_percent}%'
                            })
                extract_success = True
                extract_message = f"Extracted to {install_path}"
            except Exception as e:
                extract_message = f"ZIP extraction failed: {e}"
        elif filename.lower().endswith('.7z'):
            # Try multiple 7z extraction methods
            extraction_commands = [
                ['7z', 'x', staging_file, f'-o{install_path}', '-y'],      # Standard 7z (Linux, SteamOS, Windows if in PATH)
                ['7zz', 'x', staging_file, f'-o{install_path}', '-y'],     # Newer 7-Zip
                ['unar', '-o', install_path, '-f', staging_file],          # unar (macOS)
            ]
            
            # Add Windows-specific 7-Zip paths
            if sys.platform == 'win32':
                win_7z_paths = [
                    os.path.join(os.environ.get('PROGRAMFILES', 'C:\\Program Files'), '7-Zip', '7z.exe'),
                    os.path.join(os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)'), '7-Zip', '7z.exe'),
                ]
                for win_7z in win_7z_paths:
                    extraction_commands.insert(0, [win_7z, 'x', staging_file, f'-o{install_path}', '-y'])
            
            for cmd in extraction_commands:
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True)
                    if result.returncode == 0:
                        extract_success = True
                        extract_message = f"Extracted to {install_path}"
                        break
                    else:
                        extract_message = f"Extraction failed: {result.stderr}"
                except FileNotFoundError:
                    continue  # Try next command
                except Exception as e:
                    extract_message = f"Extraction failed: {e}"
                    continue
            
            if not extract_success:
                extract_message = "7z not installed - file downloaded but not extracted. Install 7-Zip (Windows/Linux/SteamOS) or unar (macOS: brew install unar)"
        else:
            extract_message = f"Unknown archive format - file saved to {staging_file}"
        
        # Find the newly extracted folder for tracking
        if extract_success:
            new_items = set(os.listdir(install_path)) - existing_items
            if new_items:
                # Use the first new folder/file as the game folder for deletion tracking
                new_item = list(new_items)[0]
                game_folder = os.path.join(install_path, new_item)
                extract_message = f"Extracted to {game_folder}"
        
        system_logger.info(f"Windows game extraction: {extract_message}")
        
        # Exe file scanning removed: only used by Add to Steam feature
        if extract_success:
            # Delete the compressed file after successful extraction
            if os.path.exists(staging_file):
                try:
                    os.remove(staging_file)
                    system_logger.info(f"Deleted compressed file after extraction: {staging_file}")
                except Exception as e:
                    system_logger.warning(f"Failed to delete compressed file {staging_file}: {e}")

            # Scan for .exe files - Removed: only used by Add to Steam
            # if os.path.isdir(game_folder):
            #     for root, dirs, files in os.walk(game_folder):
            #         for file in files:
            #             if file.lower().endswith('.exe'):
            #                 exe_path = os.path.join(root, file)
            #                 exe_files.append({
            #                     'name': file,
            #                     'path': exe_path
            #                 })
            #     system_logger.info(f"Found {len(exe_files)} exe files in {game_folder}")
        
        # Record the download - use game_folder for extracted, staging for non-extracted
        final_path = game_folder if extract_success else staging_file
        record_download(rom_id, rom_name, filename, final_path, 249, file_size)
        
        with download_progress_lock:
            if extract_success:
                download_progress[rom_id] = {
                    'status': 'extracted',
                    'progress': 100,
                    'message': f"Downloaded and extracted {rom_name}",
                    'path': game_folder,
                    # 'exe_files': exe_files,  # Removed: only used by Add to Steam
                    # 'rom_name': rom_name      # Removed: only used by Add to Steam
                }
            else:
                download_progress[rom_id] = {
                    'status': 'complete',
                    'progress': 100,
                    'message': f"Downloaded {filename}. {extract_message}",
                    'path': download_path
                }
    except Exception as e:
        system_logger.error(f"Error in Windows game download: {e}")
        system_logger.error(traceback.format_exc())
        with download_progress_lock:
            download_progress[rom_id] = {
                'status': 'error',
                'error': str(e)
            }
    finally:
        download_cancel_events.pop(rom_id, None)

def download_with_extraction_async(romm, rom_id, filename, platform_id, rom_name, file_size, install_path, staging_path='', cancel_event=None):
    """Unified download with extraction for any platform with auto_extract enabled.

    Args:
        romm: RomM API instance
        rom_id: ROM ID to download
        filename: Original filename
        platform_id: Platform ID for recording
        rom_name: Display name of the ROM
        file_size: File size in bytes
        install_path: Destination folder for extracted files
        staging_path: Optional staging folder for download (if empty, uses install_path)
        cancel_event: Threading event for cancellation
    """
    try:
        # Use staging path if provided, otherwise download directly to install path
        download_dest = staging_path if staging_path else install_path

        if not download_dest:
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'error',
                    'error': 'Download path not configured'
                }
            return
        if not install_path:
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'error',
                    'error': 'Install path not configured for this platform'
                }
            return

        # Ensure directories exist
        os.makedirs(download_dest, exist_ok=True)
        if staging_path:
            os.makedirs(install_path, exist_ok=True)

        # Download to destination with progress
        dl_result = romm.downloadRom(rom_id, filename, download_dest + "/",
                                  progress_callback=lambda d, t, p: update_progress(rom_id, d, t, p),
                                  cancel_event=cancel_event)

        # Cancelled — clean up and stop
        if dl_result and dl_result.get('cancelled'):
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'cancelled',
                    'progress': 0,
                    'message': 'Download cancelled'
                }
            download_cancel_events.pop(rom_id, None)
            return

        saved_filename = dl_result.get('filename', filename) if dl_result else filename
        downloaded_file = os.path.join(download_dest, saved_filename)
        system_logger.info(f"Downloaded {rom_id} ({filename}) to: {download_dest}")

        # Update status to extracting
        with download_progress_lock:
            download_progress[rom_id].update({
                'status': 'extracting',
                'progress': 100,
                'message': 'Extracting...'
            })

        # Track what's in install_path before extraction
        existing_items = set(os.listdir(install_path)) if os.path.isdir(install_path) else set()

        # Extract the file
        extract_success = False
        extract_message = ""
        game_folder = install_path  # Default if we can't determine the extracted folder

        is_zip = saved_filename.lower().endswith('.zip')
        is_7z = saved_filename.lower().endswith('.7z')

        if is_zip:
            try:
                with zipfile.ZipFile(downloaded_file, 'r') as zip_ref:
                    file_list = zip_ref.namelist()
                    total_files = len(file_list)
                    for idx, file in enumerate(file_list):
                        zip_ref.extract(file, install_path)
                        # Update extraction progress
                        extract_percent = int((idx + 1) / total_files * 100)
                        with download_progress_lock:
                            download_progress[rom_id].update({
                                'status': 'extracting',
                                'progress': extract_percent,
                                'message': f'Extracting... {extract_percent}%'
                            })
                extract_success = True
                extract_message = f"Extracted to {install_path}"
            except Exception as e:
                extract_message = f"ZIP extraction failed: {e}"
        elif is_7z:
            # Try multiple 7z extraction methods
            extraction_commands = [
                ['7z', 'x', downloaded_file, f'-o{install_path}', '-y'],
                ['7zz', 'x', downloaded_file, f'-o{install_path}', '-y'],
                ['unar', '-o', install_path, '-f', downloaded_file],
            ]

            # Add Windows-specific 7-Zip paths
            if sys.platform == 'win32':
                win_7z_paths = [
                    os.path.join(os.environ.get('PROGRAMFILES', 'C:\\Program Files'), '7-Zip', '7z.exe'),
                    os.path.join(os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)'), '7-Zip', '7z.exe'),
                ]
                for win_7z in win_7z_paths:
                    extraction_commands.insert(0, [win_7z, 'x', downloaded_file, f'-o{install_path}', '-y'])

            for cmd in extraction_commands:
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True)
                    if result.returncode == 0:
                        extract_success = True
                        extract_message = f"Extracted to {install_path}"
                        break
                    else:
                        extract_message = f"Extraction failed: {result.stderr}"
                except FileNotFoundError:
                    continue  # Try next command
                except Exception as e:
                    extract_message = f"Extraction failed: {e}"
                    continue

            if not extract_success and not extract_message:
                extract_message = "7z not installed - file downloaded but not extracted"
        else:
            # Not an archive, just move to install path if different from download dest
            if staging_path and staging_path != install_path:
                try:
                    final_file = os.path.join(install_path, saved_filename)
                    shutil.move(downloaded_file, final_file)
                    downloaded_file = final_file
                    game_folder = final_file
                    extract_message = f"Moved to {install_path}"
                    extract_success = True
                except Exception as e:
                    extract_message = f"Failed to move file: {e}"
            else:
                extract_message = f"File saved to {downloaded_file}"
                game_folder = downloaded_file
                extract_success = True

        # Find the newly extracted folder for tracking
        if extract_success and (is_zip or is_7z):
            new_items = set(os.listdir(install_path)) - existing_items
            if new_items:
                new_item = list(new_items)[0]
                game_folder = os.path.join(install_path, new_item)
                extract_message = f"Extracted to {game_folder}"

            # Delete the archive after successful extraction
            if os.path.exists(downloaded_file):
                try:
                    os.remove(downloaded_file)
                    system_logger.info(f"Deleted archive after extraction: {downloaded_file}")
                except Exception as e:
                    system_logger.warning(f"Failed to delete archive {downloaded_file}: {e}")

        system_logger.info(f"Extraction result: {extract_message}")

        # Record the download
        final_path = game_folder if extract_success else downloaded_file
        record_download(rom_id, rom_name, saved_filename, final_path, platform_id, file_size)

        with download_progress_lock:
            if extract_success:
                download_progress[rom_id] = {
                    'status': 'extracted',
                    'progress': 100,
                    'message': f"Downloaded and extracted {rom_name}",
                    'path': game_folder
                }
            else:
                download_progress[rom_id] = {
                    'status': 'complete',
                    'progress': 100,
                    'message': f"Downloaded {filename}. {extract_message}",
                    'path': download_dest
                }
    except Exception as e:
        system_logger.error(f"Error in extraction download: {e}")
        system_logger.error(traceback.format_exc())
        with download_progress_lock:
            download_progress[rom_id] = {
                'status': 'error',
                'error': str(e)
            }
    finally:
        download_cancel_events.pop(rom_id, None)

@app.route('/settings', methods=['GET', 'POST'])
def settings():
    db = get_db()
    # Get Config
    config_result = db.select_as_dict("config")
    config_dict = {row['config_key']: row['config_value'] for row in config_result}
    
    # Get Platform Matching from database (sorted alphabetically by platform name)
    platform_matching = db.select_as_dict("platforms_matching", order_by="romm_platform_name ASC")
    
    # Get platforms for default selection dropdown
    platforms = []
    platforms_with_games_ids = set()
    try:
        romm = get_romm_api()
        all_platforms = romm.getPlatforms()
        # Filter to only platforms with games and sort
        platforms = sorted([p for p in all_platforms if (p.get('rom_count') or 0) >= 1], key=lambda x: x.get('name', ''))
        platforms_with_games_ids = {p.get('id') for p in platforms}
    except Exception as e:
        system_logger.error(f"Error fetching platforms for settings: {e}")
    
    # Filter platform_matching to only show platforms with games
    if platforms_with_games_ids:
        platform_matching = [p for p in platform_matching if p.get('romm_platform_id') in platforms_with_games_ids]

    theme = get_current_theme()
    try:
        windows_install_paths = json.loads(config_dict.get('windows_install_paths', '[]'))
    except (json.JSONDecodeError, TypeError):
        windows_install_paths = []
    if not windows_install_paths and config_dict.get('windows_install_path', ''):
        windows_install_paths = [config_dict['windows_install_path']]
    return render_template('settings.html', config=config_dict, platform_matching=platform_matching, platforms=platforms, theme=theme, themes=THEMES, windows_install_paths=windows_install_paths)

# Redirect old /config URL to /settings
@app.route('/config')
def config_redirect():
    return redirect(url_for('settings'))

# Update Romm API Settings
@app.route('/settings/romm_api', methods=['POST'])
def settings_romm_api():        
    db = get_db()

    # Update Config in Database
    db.update("config", {"config_value": request.form.get("romm_api_base_url")}, "config_key = ?", ("romm_api_base_url",))
    db.update("config", {"config_value": request.form.get("romm_username")}, "config_key = ?", ("romm_username",))
    db.update("config", {"config_value": request.form.get("romm_password")}, "config_key = ?", ("romm_password",))
    
    return redirect(url_for('settings'))

# Update Theme
@app.route('/settings/theme', methods=['POST'])
def settings_theme():
    db = get_db()
    theme_id = request.form.get("theme", "oled-limited")
    
    # Validate theme exists
    valid_themes = [t['id'] for t in THEMES]
    if theme_id not in valid_themes:
        theme_id = "oled-limited"
    
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)", 
                     ("theme", theme_id))
    
    system_logger.info(f"Theme changed to: {theme_id}")
    return redirect(url_for('settings'))

@app.route('/settings/browser', methods=['POST'])
def settings_browser():
    """Toggle opening browser on startup."""
    db = get_db()
    enabled = request.form.get("open_browser_on_startup") == "on"
    db.execute_query(
        "INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)",
        ("open_browser_on_startup", "1" if enabled else "0")
    )
    system_logger.info(f"Open browser on startup set to: {enabled}")
    return redirect(url_for('settings'))

# Update Platform Matching
@app.route('/settings/platform_matching', methods=['POST'])
def settings_platform_matching():
    db = get_db()

    # Update fs_slug, local folder name, and auto_extract setting
    platform_id = request.form.get("romm_platform_id")
    fs_slug = request.form.get("romm_fs_slug", "")
    local_folder = request.form.get("steamdeck_platform_name", "")
    auto_extract = 1 if request.form.get("auto_extract") else 0

    db.execute_query("""
        UPDATE platforms_matching
        SET romm_fs_slug = ?, steamdeck_platform_name = ?, auto_extract = ?
        WHERE romm_platform_id = ?
    """, (fs_slug, local_folder, auto_extract, platform_id))

    return redirect(url_for('settings'))

# Update Steamdeck Platform Path (legacy, kept for compatibility)
@app.route('/settings/steamdeck_path', methods=['POST'])
def settings_steamdeck_path():    
    db = get_db()
    db.update("config", {"config_value": request.form.get("steamdeck_path")}, "config_key = ?", ("steamdeck_retrodeck_path",))
    return redirect(url_for('settings'))

# Update Windows download/install paths (legacy, kept for backward compatibility)
@app.route('/settings/windows_paths', methods=['POST'])
def settings_windows_paths():
    db = get_db()

    download_path = request.form.get("windows_download_path", "")
    install_paths = [p.strip() for p in request.form.getlist("windows_install_paths[]") if p.strip()]

    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)",
                     ("windows_download_path", download_path))
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)",
                     ("windows_install_paths", json.dumps(install_paths)))

    return redirect(url_for('settings'))

# Update download staging path (used by all platforms with auto_extract enabled)
@app.route('/settings/staging_path', methods=['POST'])
def settings_staging_path():
    db = get_db()
    staging_path = request.form.get("download_staging_path", "")

    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)",
                     ("download_staging_path", staging_path))
    # Also update legacy key for backward compatibility
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)",
                     ("windows_download_path", staging_path))

    return redirect(url_for('settings'))

# Update Base Path for ROMs
@app.route('/settings/base_path', methods=['POST'])
def settings_base_path():
    db = get_db()
    base_path = request.form.get("base_path", "")
    
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)", 
                     ("steamdeck_retrodeck_path", base_path))
    
    system_logger.info(f"Base path saved: {base_path}")
    return jsonify({"success": True})

# Update Default Platform
@app.route('/settings/default_platform', methods=['POST'])
def settings_default_platform():    
    db = get_db()

    # Update Config in Database
    db.update("config", {"config_value": request.form.get("default_platform")}, "config_key = ?", ("default_platform_id",))
    
    return redirect(url_for('settings'))

# API: List directories for folder browser
@app.route('/api/browse_folders')
def api_browse_folders():
    """List directories in a given path for folder selection."""
    path = request.args.get('path', os.path.expanduser('~'))

    try:
        # Handle special "drives" path for Windows drive selection
        if sys.platform == 'win32' and path.lower() == 'drives':
            # List available Windows drives
            import string
            drives = []
            for letter in string.ascii_uppercase:
                drive_path = f"{letter}:\\"
                if os.path.exists(drive_path):
                    drives.append({
                        'name': f"{letter}:",
                        'path': drive_path
                    })
            return jsonify({
                'success': True,
                'current_path': 'Computer',
                'parent_path': None,
                'directories': drives,
                'is_drives_list': True
            })

        # Normalize and validate path
        path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(path):
            path = os.path.expanduser('~')

        if not os.path.isdir(path):
            path = os.path.dirname(path)

        # Get parent directory - handle Windows drive roots
        parent = None
        if sys.platform == 'win32':
            # On Windows, check if we're at a drive root (e.g., C:\)
            if len(path) == 3 and path[1:] == ':\\':
                # At drive root, parent goes to drive list
                parent = 'drives'
            else:
                parent = os.path.dirname(path)
                # If parent is just "C:", add backslash
                if len(parent) == 2 and parent[1] == ':':
                    parent = parent + '\\'
        else:
            # Unix/Mac
            parent = os.path.dirname(path) if path != '/' else None

        # List only directories
        directories = []
        try:
            for item in sorted(os.listdir(path)):
                item_path = os.path.join(path, item)
                if os.path.isdir(item_path) and not item.startswith('.'):
                    directories.append({
                        'name': item,
                        'path': item_path
                    })
        except PermissionError:
            pass

        return jsonify({
            'success': True,
            'current_path': path,
            'parent_path': parent,
            'directories': directories
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# Refresh platforms from RomM API
@app.route('/settings/refresh_platforms', methods=['POST'])
def refresh_platforms():
    try:
        romm = get_romm_api()
        db = get_db()

        platforms = romm.getPlatforms()
        for platform in platforms:
            # Store platform with fs_slug for folder name reference
            # Preserve existing steamdeck_platform_name, auto_extract, and install_paths
            db.execute_query("""
                INSERT OR REPLACE INTO platforms_matching
                (romm_platform_id, romm_platform_name, romm_fs_slug, steamdeck_platform_name, auto_extract, install_paths)
                VALUES (?, ?, ?,
                    COALESCE((SELECT steamdeck_platform_name FROM platforms_matching WHERE romm_platform_id = ?), ?),
                    COALESCE((SELECT auto_extract FROM platforms_matching WHERE romm_platform_id = ?), 0),
                    COALESCE((SELECT install_paths FROM platforms_matching WHERE romm_platform_id = ?), '[]'))
            """, (platform['id'], platform['name'], platform.get('fs_slug', ''),
                  platform['id'], platform.get('fs_slug', ''),
                  platform['id'],
                  platform['id']))

        return redirect(url_for('settings'))
    except Exception as e:
        system_logger.error(f"Error refreshing platforms: {e}")
        return redirect(url_for('settings'))

# Auto-fill platform folders from RomM fs_slug with base path
@app.route('/settings/autofill_platform_folders', methods=['POST'])
def autofill_platform_folders():
    try:
        db = get_db()
        base_path = request.form.get('base_path', '').rstrip('/\\')

        # Get all platforms with fs_slug
        platforms = db.select_as_dict("platforms_matching",
            ['romm_platform_id', 'romm_fs_slug'],
            "romm_fs_slug IS NOT NULL AND romm_fs_slug != ''")

        for platform in platforms:
            platform_id = platform['romm_platform_id']
            fs_slug = platform['romm_fs_slug']

            if base_path:
                # Use os.path.join for correct path separator on all OS
                full_path = os.path.join(base_path, fs_slug)
            else:
                full_path = fs_slug

            db.execute_query("""
                UPDATE platforms_matching
                SET steamdeck_platform_name = ?
                WHERE romm_platform_id = ?
            """, (full_path, platform_id))

        return redirect(url_for('settings'))
    except Exception as e:
        system_logger.error(f"Error auto-filling platform folders: {e}")
        return redirect(url_for('settings'))

if __name__ == '__main__':    
    # Load config
    global app_config
    app_config = load_json_config()
    
    system_logger.info(f"Flask-App started... Data dir: {DATA_DIR}")
    
    # Initialize database
    init_database()

    # Open browser on startup if configured
    maybe_open_browser()

    # Run Flask app
    app.run(
        debug=False, 
        use_reloader=False, 
        host=app_config["server"].get("host", "0.0.0.0"), 
        port=app_config["server"].get("port", 5000)
    )
