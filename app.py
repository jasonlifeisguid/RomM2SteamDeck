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
import zlib
import traceback
import webbrowser


# then make a url variable
launch_url = "http://127.0.0.1:5001"
# Global dictionary to track download progress
download_progress = {}
download_progress_lock = threading.Lock()
webbrowser.open(launch_url)
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

app = Flask(__name__)

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
    
    # Add indexes for better query performance
    try:
        db.execute_query("CREATE INDEX IF NOT EXISTS idx_downloads_rom_id ON downloads(rom_id)")
        db.execute_query("CREATE INDEX IF NOT EXISTS idx_downloads_platform_id ON downloads(platform_id)")
        db.execute_query("CREATE INDEX IF NOT EXISTS idx_config_key ON config(config_key)")
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
        ('windows_download_path', default_downloads),
        ('windows_install_path', default_install_path),
        ('theme', 'oled-limited')  # Default theme
    ]
    
    for key, value in default_configs:
        db.execute_query(
            "INSERT OR IGNORE INTO config (config_key, config_value) VALUES (?, ?)",
            (key, value)
        )
    
    system_logger.info(f"Database initialized at {db_path}")

def get_romm_api():
    """Create and return a configured RomM API helper instance."""
    db = RomM2SteamDeckDatabase(get_db_path())
    config_result = db.select_as_dict("config")
    config_dict = {row['config_key']: row['config_value'] for row in config_result}
    
    romm = RommAPIHelper(config_dict.get('romm_api_base_url', ''))
    romm.login(config_dict.get('romm_username', ''), config_dict.get('romm_password', ''))
    return romm

def get_steamdeck_path():
    """Get the configured Steam Deck path."""
    db = RomM2SteamDeckDatabase(get_db_path())
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('steamdeck_retrodeck_path',))
    return result[0].get("config_value", "") if result else ""

def get_current_theme():
    """Get the current theme from config."""
    db = RomM2SteamDeckDatabase(get_db_path())
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('theme',))
    return result[0].get("config_value", "oled-limited") if result else "oled-limited"

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
    db = RomM2SteamDeckDatabase(get_db_path())
    db.execute_query("""
        INSERT OR REPLACE INTO downloads (rom_id, rom_name, filename, file_path, platform_id, file_size, downloaded_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    """, (rom_id, rom_name, filename, file_path, platform_id, file_size))
    system_logger.info(f"Recorded download: {rom_name} ({rom_id}) at {file_path}")

def get_downloaded_rom_ids():
    """Get set of ROM IDs that have been downloaded."""
    db = RomM2SteamDeckDatabase(get_db_path())
    results = db.select_as_dict("downloads", ['rom_id'])
    return {row['rom_id'] for row in results}

def get_download_info(rom_id):
    """Get download info for a specific ROM."""
    db = RomM2SteamDeckDatabase(get_db_path())
    results = db.select_as_dict("downloads", ['*'], "rom_id = ?", (rom_id,))
    return results[0] if results else None

def remove_download_record(rom_id):
    """Remove a download record from the database."""
    db = RomM2SteamDeckDatabase(get_db_path())
    db.execute_query("DELETE FROM downloads WHERE rom_id = ?", (rom_id,))

def sync_downloads_with_filesystem(platform_id, roms):
    """
    Sync download records with actual files on disk.
    - Adds records for files that exist but aren't tracked
    - Removes records for files that no longer exist
    """
    db = RomM2SteamDeckDatabase(get_db_path())
    
    # Get platform folder
    platform_folder = get_platform_folder(platform_id)
    
    # For Windows, also check the install path
    windows_install_path = None
    if platform_id == 249:  # Windows
        config_result = db.select_as_dict("config")
        config_dict = {row['config_key']: row['config_value'] for row in config_result}
        windows_install_path = config_dict.get('windows_install_path', '')
    
    # Get currently tracked downloads for this platform
    tracked = db.select_as_dict("downloads", ['*'], "platform_id = ?", (platform_id,))
    tracked_by_rom_id = {row['rom_id']: row for row in tracked}
    
    # Build a map of ROM filenames to ROM data
    rom_by_filename = {}
    rom_by_name = {}  # For Windows games (folder name matching)
    for rom in roms:
        fs_name = rom.get('fs_name', '')
        if fs_name:
            rom_by_filename[fs_name] = rom
            # Also map without extension for flexibility
            base_name = os.path.splitext(fs_name)[0]
            rom_by_filename[base_name] = rom
        
        # For Windows, also map by sanitized name (folder names)
        rom_name = rom.get('name', '')
        if rom_name:
            safe_name = "".join(c for c in rom_name if c.isalnum() or c in (' ', '-', '_')).strip()
            rom_by_name[safe_name] = rom
    
    changes = {'added': 0, 'removed': 0}
    
    # Check for files that exist but aren't tracked
    if platform_folder and os.path.isdir(platform_folder):
        for item in os.listdir(platform_folder):
            item_path = os.path.join(platform_folder, item)
            
            # Try to match to a ROM
            rom = rom_by_filename.get(item)
            if not rom:
                # Try without extension
                base_name = os.path.splitext(item)[0]
                rom = rom_by_filename.get(base_name)
            
            if rom and rom['id'] not in tracked_by_rom_id:
                # Found a file that matches a ROM but isn't tracked
                file_size = os.path.getsize(item_path) if os.path.isfile(item_path) else 0
                record_download(rom['id'], rom.get('name', item), item, item_path, platform_id, file_size)
                changes['added'] += 1
                system_logger.info(f"Sync: Added existing file to tracking: {item}")
    
    # For Windows, also check install path for extracted game folders
    if windows_install_path and os.path.isdir(windows_install_path):
        for item in os.listdir(windows_install_path):
            item_path = os.path.join(windows_install_path, item)
            if os.path.isdir(item_path):
                # Try to match folder name to a ROM name
                rom = rom_by_name.get(item)
                if rom and rom['id'] not in tracked_by_rom_id:
                    record_download(rom['id'], rom.get('name', item), item, item_path, 249, 0)
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
    db = RomM2SteamDeckDatabase(get_db_path())
    result = db.select_as_dict("platforms_matching", ['steamdeck_platform_name'], 'romm_platform_id = ?', (platform_id,))
    return result[0].get("steamdeck_platform_name", "") if result else ""

def get_romm_base_url():
    """Get the configured RomM API base URL."""
    db = RomM2SteamDeckDatabase(get_db_path())
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('romm_api_base_url',))
    url = result[0].get("config_value", "") if result else ""
    # Remove /api suffix if present to get base URL
    return url.replace('/api', '') if url else ""

def get_default_platform_id():
    """Get the configured default platform ID."""
    db = RomM2SteamDeckDatabase(get_db_path())
    result = db.select_as_dict("config", ['config_value'], 'config_key = ?', ('default_platform_id',))
    return result[0].get("config_value", "249") if result else "249"

@app.route('/')
def browse():  
    system_logger.info("Browse Page")
    romm_base = get_romm_base_url()
    default_platform = get_default_platform_id()
    theme = get_current_theme()
    return render_template('browse.html', version="1.0.0", platform_id=None, platform_name=None, romm_base_url=romm_base, default_platform_id=default_platform, theme=theme)

@app.route('/platform/<int:platform_id>')
def browse_platform(platform_id):
    """Direct link to a specific platform's games."""
    system_logger.info(f"Browse Platform {platform_id}")
    romm_base = get_romm_base_url()
    default_platform = get_default_platform_id()
    theme = get_current_theme()
    # Get platform name from the database or API
    try:
        db = RomM2SteamDeckDatabase(get_db_path())
        result = db.select_as_dict("platforms_matching", ['romm_platform_name'], 'romm_platform_id = ?', (platform_id,))
        platform_name = result[0].get("romm_platform_name", f"Platform {platform_id}") if result else f"Platform {platform_id}"
    except:
        platform_name = f"Platform {platform_id}"
    return render_template('browse.html', version="1.0.0", platform_id=platform_id, platform_name=platform_name, romm_base_url=romm_base, default_platform_id=default_platform, theme=theme)

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
    
    db = RomM2SteamDeckDatabase(get_db_path())
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
                if progress.get('status') in ['complete', 'error', 'extracting', 'extracted']:
                    if progress.get('status') in ['complete', 'error', 'extracted']:
                        # Clean up after sending final status
                        time.sleep(0.5)
                        with download_progress_lock:
                            download_progress.pop(rom_id, None)
                        break
            
            time.sleep(0.3)  # Poll every 300ms
    
    return Response(generate(), mimetype='text/event-stream')

# API: Start download (returns immediately, download happens in background)
@app.route('/api/download/<int:rom_id>', methods=['POST'])
def api_download_rom(rom_id):
    try:
        romm = get_romm_api()
        
        # Get ROM details
        rom = romm.getRomByID(rom_id)
        if not rom:
            return jsonify({"success": False, "error": "ROM not found"}), 404
        
        filename = rom.get('fs_name', '')
        platform_id = rom.get('platform_id')
        rom_name = rom.get('name', filename)
        file_size = rom.get('fs_size_bytes', 0)
        
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
        
        # Windows platform ID = 249
        WINDOWS_PLATFORM_ID = 249
        
        # Start download in background thread
        if platform_id == WINDOWS_PLATFORM_ID:
            thread = threading.Thread(target=download_windows_game_async, 
                                     args=(romm, rom_id, filename, rom_name, file_size))
        else:
            thread = threading.Thread(target=download_standard_rom_async,
                                     args=(romm, rom_id, filename, platform_id, rom_name, file_size))
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

def download_standard_rom_async(romm, rom_id, filename, platform_id, rom_name, file_size):
    """Download ROM directly to platform folder (async version)."""
    try:
        platform_folder = get_platform_folder(platform_id)
        
        if not platform_folder:
            with download_progress_lock:
                download_progress[rom_id] = {
                    'status': 'error',
                    'error': 'Platform folder not configured'
                }
            return
        
        # Ensure directory exists
        os.makedirs(platform_folder, exist_ok=True)
        
        # Download the ROM with progress callback
        result = romm.downloadRom(rom_id, filename, platform_folder + "/",
                                  progress_callback=lambda d, t, p: update_progress(rom_id, d, t, p))
        
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

def download_windows_game_async(romm, rom_id, filename, rom_name, file_size):
    """Download Windows game to staging path, then extract (async version)."""
    try:
        db = RomM2SteamDeckDatabase(get_db_path())
        
        # Get Windows-specific paths
        config_result = db.select_as_dict("config")
        config_dict = {row['config_key']: row['config_value'] for row in config_result}
        
        download_path = config_dict.get('windows_download_path', '')
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
                                  progress_callback=lambda d, t, p: update_progress(rom_id, d, t, p))
        
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
                    zip_ref.extractall(install_path)
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
        
        # Find exe files in the extracted folder
        exe_files = []
        if extract_success:
            # Delete the compressed file after successful extraction
            if os.path.exists(staging_file):
                try:
                    os.remove(staging_file)
                    system_logger.info(f"Deleted compressed file after extraction: {staging_file}")
                except Exception as e:
                    system_logger.warning(f"Failed to delete compressed file {staging_file}: {e}")
            
            # Scan for .exe files
            if os.path.isdir(game_folder):
                for root, dirs, files in os.walk(game_folder):
                    for file in files:
                        if file.lower().endswith('.exe'):
                            exe_path = os.path.join(root, file)
                            exe_files.append({
                                'name': file,
                                'path': exe_path
                            })
                system_logger.info(f"Found {len(exe_files)} exe files in {game_folder}")
        
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
                    'exe_files': exe_files,
                    'rom_name': rom_name
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

@app.route('/settings', methods=['GET', 'POST'])
def settings():
    db = RomM2SteamDeckDatabase(get_db_path())
    # Get Config    
    config_result = db.select("config")    
    config_dict = {row[1]: row[2] for row in config_result}
    
    # Get Platform Matching from database
    platform_matching = db.select_as_dict("platforms_matching")
    
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
    return render_template('settings.html', config=config_dict, platform_matching=platform_matching, platforms=platforms, theme=theme, themes=THEMES)

# Redirect old /config URL to /settings
@app.route('/config')
def config_redirect():
    return redirect(url_for('settings'))

# Update Romm API Settings
@app.route('/settings/romm_api', methods=['POST'])
def settings_romm_api():        
    db = RomM2SteamDeckDatabase(get_db_path())

    # Update Config in Database
    db.update("config", {"config_value": request.form.get("romm_api_base_url")}, "config_key = ?", ("romm_api_base_url",))
    db.update("config", {"config_value": request.form.get("romm_username")}, "config_key = ?", ("romm_username",))
    db.update("config", {"config_value": request.form.get("romm_password")}, "config_key = ?", ("romm_password",))
    
    return redirect(url_for('settings'))

# Update Theme
@app.route('/settings/theme', methods=['POST'])
def settings_theme():
    db = RomM2SteamDeckDatabase(get_db_path())
    theme_id = request.form.get("theme", "oled-limited")
    
    # Validate theme exists
    valid_themes = [t['id'] for t in THEMES]
    if theme_id not in valid_themes:
        theme_id = "oled-limited"
    
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)", 
                     ("theme", theme_id))
    
    system_logger.info(f"Theme changed to: {theme_id}")
    return redirect(url_for('settings'))

# Update Platform Matching
@app.route('/settings/platform_matching', methods=['POST'])
def settings_platform_matching():    
    db = RomM2SteamDeckDatabase(get_db_path())

    # Update both fs_slug and local folder name
    platform_id = request.form.get("romm_platform_id")
    fs_slug = request.form.get("romm_fs_slug", "")
    local_folder = request.form.get("steamdeck_platform_name", "")
    
    db.execute_query("""
        UPDATE platforms_matching 
        SET romm_fs_slug = ?, steamdeck_platform_name = ? 
        WHERE romm_platform_id = ?
    """, (fs_slug, local_folder, platform_id))
    
    return redirect(url_for('settings'))

# Update Steamdeck Platform Path (legacy, kept for compatibility)
@app.route('/settings/steamdeck_path', methods=['POST'])
def settings_steamdeck_path():    
    db = RomM2SteamDeckDatabase(get_db_path())
    db.update("config", {"config_value": request.form.get("steamdeck_path")}, "config_key = ?", ("steamdeck_retrodeck_path",))
    return redirect(url_for('settings'))

# Update Windows download/install paths
@app.route('/settings/windows_paths', methods=['POST'])
def settings_windows_paths():    
    db = RomM2SteamDeckDatabase(get_db_path())
    
    download_path = request.form.get("windows_download_path", "")
    install_path = request.form.get("windows_install_path", "")
    
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)", 
                     ("windows_download_path", download_path))
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)", 
                     ("windows_install_path", install_path))
    
    return redirect(url_for('settings'))

# API: Add game to Steam as non-Steam game
@app.route('/api/add_to_steam', methods=['POST'])
def api_add_to_steam():
    """Add an exe to Steam as a non-Steam game."""
    try:
        data = request.get_json()
        exe_path = data.get('exe_path', '')
        game_name = data.get('game_name', '')
        
        system_logger.info(f"Add to Steam request: {game_name} - {exe_path}")
        
        if not exe_path or not os.path.exists(exe_path):
            return jsonify({"success": False, "error": f"Invalid exe path: {exe_path}"}), 400
        
        if not game_name:
            game_name = os.path.splitext(os.path.basename(exe_path))[0]
        
        # Find Steam userdata directory
        steam_paths = [
            os.path.expanduser('~/.steam/steam/userdata'),           # Linux/SteamOS
            os.path.expanduser('~/.local/share/Steam/userdata'),     # Linux alternative
            os.path.expanduser('~/Library/Application Support/Steam/userdata'),  # macOS
            os.path.join(os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)'), 'Steam', 'userdata'),  # Windows
            os.path.join(os.environ.get('PROGRAMFILES', 'C:\\Program Files'), 'Steam', 'userdata'),  # Windows alternative
        ]
        
        userdata_path = None
        for path in steam_paths:
            system_logger.info(f"Checking Steam path: {path}")
            if os.path.isdir(path):
                userdata_path = path
                system_logger.info(f"Found Steam userdata at: {path}")
                break
        
        if not userdata_path:
            return jsonify({"success": False, "error": "Steam userdata directory not found. Is Steam installed?"}), 400
        
        # Find user directories (could be multiple users)
        user_dirs = [d for d in os.listdir(userdata_path) if d.isdigit()]
        system_logger.info(f"Found Steam users: {user_dirs}")
        
        if not user_dirs:
            return jsonify({"success": False, "error": "No Steam user found"}), 400
        
        # Use the first user (or could let user select)
        user_id = user_dirs[0]
        shortcuts_path = os.path.join(userdata_path, user_id, 'config', 'shortcuts.vdf')
        system_logger.info(f"Shortcuts path: {shortcuts_path}")
        
        # Parse or create shortcuts.vdf
        shortcuts = parse_shortcuts_vdf(shortcuts_path)
        system_logger.info(f"Existing shortcuts count: {len(shortcuts)}")
        
        # Generate unique app ID using CRC of exe path (consistent for same game)
        app_id = zlib.crc32(exe_path.encode()) & 0xffffffff
        # Make it negative as Steam uses signed int32
        if app_id > 0x7fffffff:
            app_id = app_id - 0x100000000
        
        # Get working directory from exe path
        start_dir = os.path.dirname(exe_path)
        
        # Add new shortcut
        new_shortcut = {
            'appid': app_id,
            'AppName': game_name,
            'Exe': f'"{exe_path}"',
            'StartDir': f'"{start_dir}"',
            'icon': '',
            'ShortcutPath': '',
            'LaunchOptions': '',
            'IsHidden': 0,
            'AllowDesktopConfig': 1,
            'AllowOverlay': 1,
            'OpenVR': 0,
            'Devkit': 0,
            'DevkitGameID': '',
            'DevkitOverrideAppID': 0,
            'LastPlayTime': 0,
            'FlatpakAppID': '',
            'tags': {}
        }
        
        shortcuts[str(len(shortcuts))] = new_shortcut
        
        # Write back to file
        write_shortcuts_vdf(shortcuts_path, shortcuts)
        
        system_logger.info(f"Added '{game_name}' to Steam shortcuts: {exe_path} (appid: {app_id})")
        system_logger.info(f"NOTE: Steam must be restarted for changes to appear. Close Steam completely and reopen.")
        
        return jsonify({
            "success": True, 
            "message": f"Added '{game_name}' to Steam. Restart Steam to see the game.",
            "app_id": app_id,
            "shortcuts_path": shortcuts_path
        })
        
    except Exception as e:
        system_logger.error(f"Error adding to Steam: {e}")
        system_logger.error(traceback.format_exc())
        return jsonify({"success": False, "error": str(e)}), 500

def parse_shortcuts_vdf(filepath):
    """Parse Steam's shortcuts.vdf binary format."""
    shortcuts = {}
    
    if not os.path.exists(filepath):
        return shortcuts
    
    try:
        with open(filepath, 'rb') as f:
            data = f.read()
        
        # Simple binary VDF parser
        # Format: \x00shortcuts\x00 followed by entries
        # Each entry: \x00<index>\x00 followed by key-value pairs
        
        if len(data) < 12:
            return shortcuts
        
        # Skip header "shortcuts"
        pos = 0
        if data[pos:pos+1] == b'\x00':
            pos += 1
        
        # Find "shortcuts"
        end = data.find(b'\x00', pos)
        if end == -1:
            return shortcuts
        pos = end + 1
        
        current_shortcut = {}
        current_index = None
        
        while pos < len(data) - 1:
            type_byte = data[pos]
            pos += 1
            
            if type_byte == 0x08 or type_byte == 0x08:  # End marker
                if current_index is not None and current_shortcut:
                    shortcuts[current_index] = current_shortcut
                    current_shortcut = {}
                    current_index = None
                if data[pos:pos+1] == b'\x08':
                    break
                continue
            
            if type_byte == 0x00:  # New section/shortcut
                if current_index is not None and current_shortcut:
                    shortcuts[current_index] = current_shortcut
                    current_shortcut = {}
                
                end = data.find(b'\x00', pos)
                if end == -1:
                    break
                current_index = data[pos:end].decode('utf-8', errors='ignore')
                pos = end + 1
                continue
            
            # Read key name
            end = data.find(b'\x00', pos)
            if end == -1:
                break
            key = data[pos:end].decode('utf-8', errors='ignore')
            pos = end + 1
            
            if type_byte == 0x01:  # String
                end = data.find(b'\x00', pos)
                if end == -1:
                    break
                value = data[pos:end].decode('utf-8', errors='ignore')
                pos = end + 1
                current_shortcut[key] = value
            elif type_byte == 0x02:  # Int32
                if pos + 4 <= len(data):
                    value = int.from_bytes(data[pos:pos+4], 'little', signed=True)
                    pos += 4
                    current_shortcut[key] = value
        
        if current_index is not None and current_shortcut:
            shortcuts[current_index] = current_shortcut
            
    except Exception as e:
        system_logger.error(f"Error parsing shortcuts.vdf: {e}")
    
    return shortcuts

def write_shortcuts_vdf(filepath, shortcuts):
    """Write Steam's shortcuts.vdf binary format."""
    # Ensure directory exists
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    
    data = bytearray()
    
    # Header
    data.append(0x00)
    data.extend(b'shortcuts')
    data.append(0x00)
    
    for index, shortcut in shortcuts.items():
        # Entry start
        data.append(0x00)
        data.extend(str(index).encode('utf-8'))
        data.append(0x00)
        
        for key, value in shortcut.items():
            if key == 'tags':
                # Tags is a nested structure
                data.append(0x00)
                data.extend(b'tags')
                data.append(0x00)
                if isinstance(value, dict):
                    for tag_idx, tag_val in value.items():
                        data.append(0x01)
                        data.extend(str(tag_idx).encode('utf-8'))
                        data.append(0x00)
                        data.extend(str(tag_val).encode('utf-8'))
                        data.append(0x00)
                data.append(0x08)
            elif isinstance(value, int):
                data.append(0x02)
                data.extend(key.encode('utf-8'))
                data.append(0x00)
                data.extend(value.to_bytes(4, 'little', signed=True))
            else:
                data.append(0x01)
                data.extend(key.encode('utf-8'))
                data.append(0x00)
                data.extend(str(value).encode('utf-8'))
                data.append(0x00)
        
        # Entry end
        data.append(0x08)
    
    # File end
    data.append(0x08)
    
    with open(filepath, 'wb') as f:
        f.write(data)

# Update Base Path for ROMs
@app.route('/settings/base_path', methods=['POST'])
def settings_base_path():
    db = RomM2SteamDeckDatabase(get_db_path())
    base_path = request.form.get("base_path", "")
    
    db.execute_query("INSERT OR REPLACE INTO config (config_key, config_value) VALUES (?, ?)", 
                     ("steamdeck_retrodeck_path", base_path))
    
    system_logger.info(f"Base path saved: {base_path}")
    return jsonify({"success": True})

# Update Default Platform
@app.route('/settings/default_platform', methods=['POST'])
def settings_default_platform():    
    db = RomM2SteamDeckDatabase(get_db_path())

    # Update Config in Database
    db.update("config", {"config_value": request.form.get("default_platform")}, "config_key = ?", ("default_platform_id",))
    
    return redirect(url_for('settings'))

# API: List directories for folder browser
@app.route('/api/browse_folders')
def api_browse_folders():
    """List directories in a given path for folder selection."""
    path = request.args.get('path', os.path.expanduser('~'))
    
    try:
        # Normalize and validate path
        path = os.path.abspath(os.path.expanduser(path))
        
        if not os.path.exists(path):
            path = os.path.expanduser('~')
        
        if not os.path.isdir(path):
            path = os.path.dirname(path)
        
        # Get parent directory
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
        db = RomM2SteamDeckDatabase(get_db_path())
        
        platforms = romm.getPlatforms()
        for platform in platforms:
            # Store platform with fs_slug for folder name reference
            db.execute_query("""
                INSERT OR REPLACE INTO platforms_matching 
                (romm_platform_id, romm_platform_name, romm_fs_slug, steamdeck_platform_name) 
                VALUES (?, ?, ?, COALESCE((SELECT steamdeck_platform_name FROM platforms_matching WHERE romm_platform_id = ?), ?))
            """, (platform['id'], platform['name'], platform.get('fs_slug', ''), platform['id'], platform.get('fs_slug', '')))
        
        return redirect(url_for('settings'))
    except Exception as e:
        system_logger.error(f"Error refreshing platforms: {e}")
        return redirect(url_for('settings'))

# Auto-fill platform folders from RomM fs_slug with base path
@app.route('/settings/autofill_platform_folders', methods=['POST'])
def autofill_platform_folders():
    try:
        db = RomM2SteamDeckDatabase(get_db_path())
        base_path = request.form.get('base_path', '').rstrip('/')
        
        if base_path:
            # Update all platform folders to use base_path + fs_slug
            db.execute_query("""
                UPDATE platforms_matching 
                SET steamdeck_platform_name = ? || '/' || romm_fs_slug 
                WHERE romm_fs_slug IS NOT NULL AND romm_fs_slug != ''
            """, (base_path,))
        else:
            # Just use the fs_slug without base path
            db.execute_query("""
                UPDATE platforms_matching 
                SET steamdeck_platform_name = romm_fs_slug 
                WHERE romm_fs_slug IS NOT NULL AND romm_fs_slug != ''
            """)
        
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

    # Run Flask app
    app.run(
        debug=False, 
        use_reloader=False, 
        host=app_config["server"].get("host", "0.0.0.0"), 
        port=app_config["server"].get("port", 5000)
    )
