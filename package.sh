#!/bin/bash
# package.sh - Create a clean distribution ZIP for RomM2SteamDeck
# Usage: ./package.sh [version]
# Example: ./package.sh 2.0.0

VERSION="${1:-1.0.0}"
OUTPUT_NAME="RomM2SteamDeck-${VERSION}.zip"

# Change to script directory
cd "$(dirname "$0")"

echo "Creating ${OUTPUT_NAME}..."

# Create ZIP excluding development/user files
zip -r "${OUTPUT_NAME}" . \
  -x "*.db" \
  -x "*/__pycache__/*" \
  -x "*.pyc" \
  -x "*.pyo" \
  -x "*.log" \
  -x ".DS_Store" \
  -x "Thumbs.db" \
  -x "venv/*" \
  -x ".venv/*" \
  -x "env/*" \
  -x ".git/*" \
  -x ".gitignore" \
  -x "dist/*" \
  -x "build/*" \
  -x "output/*" \
  -x "*.spec" \
  -x "*.AppImage" \
  -x "*.AppDir/*" \
  -x "build_venv/*" \
  -x ".vscode/*" \
  -x ".idea/*" \
  -x "*.swp" \
  -x "*.swo" \
  -x "*.zip" \
  -x "package.sh" \
  -x ".env" \
  -x "test.py" \
  -x "tests/*" \
  -x "deployment/*"

echo ""
echo "Created: ${OUTPUT_NAME}"
echo "Size: $(du -h "${OUTPUT_NAME}" | cut -f1)"
echo ""
echo "Contents preview:"
unzip -l "${OUTPUT_NAME}" | head -20
echo "..."
