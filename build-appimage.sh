#!/bin/bash
# Build script for RomM2SteamDeck AppImage
# Run this on a Linux x86_64 system (or in a container)

set -e

APP_NAME="RomM2SteamDeck"
APP_VERSION="1.0.0"

echo "=== Building $APP_NAME AppImage ==="

# Create virtual environment and install dependencies
echo "Setting up Python environment..."
python3 -m venv build_venv
source build_venv/bin/activate
pip install --upgrade pip
pip install pyinstaller flask requests

# Build with PyInstaller
echo "Building with PyInstaller..."
pyinstaller --noconfirm --onedir --name "$APP_NAME" \
    --add-data "templates:templates" \
    --add-data "config.json:." \
    --hidden-import=flask \
    --hidden-import=requests \
    app.py

# Create AppDir structure
echo "Creating AppDir structure..."
APPDIR="$APP_NAME.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"

# Copy PyInstaller output
cp -r "dist/$APP_NAME/"* "$APPDIR/usr/bin/"

# Create desktop entry
cat > "$APPDIR/$APP_NAME.desktop" << EOF
[Desktop Entry]
Type=Application
Name=RomM2SteamDeck
Comment=Download ROMs from RomM to Steam Deck
Exec=RomM2SteamDeck
Icon=romm2steamdeck
Categories=Game;Utility;
Terminal=false
EOF

cp "$APPDIR/$APP_NAME.desktop" "$APPDIR/usr/share/applications/"

# Create AppRun script
cat > "$APPDIR/AppRun" << 'EOF'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${LD_LIBRARY_PATH}"

# Create config directory in user's home if it doesn't exist
CONFIG_DIR="$HOME/.config/romm2steamdeck"
mkdir -p "$CONFIG_DIR"

# Copy default config if not exists
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    cp "${HERE}/usr/bin/config.json" "$CONFIG_DIR/config.json" 2>/dev/null || true
fi

# Copy database if not exists
if [ ! -f "$CONFIG_DIR/romm2steamdeck.db" ]; then
    cp "${HERE}/usr/bin/romm2steamdeck.db" "$CONFIG_DIR/romm2steamdeck.db" 2>/dev/null || true
fi

# Change to config directory so the app uses the right paths
cd "$CONFIG_DIR"

# Run the application
exec "${HERE}/usr/bin/RomM2SteamDeck" "$@"
EOF

chmod +x "$APPDIR/AppRun"

# Create a simple icon (placeholder - replace with actual icon)
# Using a simple SVG placeholder
cat > "$APPDIR/romm2steamdeck.svg" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <rect width="256" height="256" rx="32" fill="#1a1a2e"/>
  <circle cx="128" cy="100" r="50" fill="#FF6B00"/>
  <path d="M78 180 L128 220 L178 180 L178 200 L128 240 L78 200 Z" fill="#FF6B00"/>
</svg>
EOF

cp "$APPDIR/romm2steamdeck.svg" "$APPDIR/usr/share/icons/hicolor/256x256/apps/"

# Download appimagetool if not present
if [ ! -f "appimagetool-x86_64.AppImage" ]; then
    echo "Downloading appimagetool..."
    wget -q "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x appimagetool-x86_64.AppImage
fi

# Build AppImage
echo "Building AppImage..."
ARCH=x86_64 ./appimagetool-x86_64.AppImage "$APPDIR" "$APP_NAME-$APP_VERSION-x86_64.AppImage"

# Cleanup
deactivate
rm -rf build_venv dist build "$APP_NAME.spec" "$APPDIR"

echo "=== Build complete: $APP_NAME-$APP_VERSION-x86_64.AppImage ==="
