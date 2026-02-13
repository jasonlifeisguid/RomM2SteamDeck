#!/bin/bash
# Steam Deck Game Mode Launcher for RomM2SteamDeck
# This script checks if the service is running and opens the browser

SERVICE_NAME="romm2steamdeck.service"
APP_URL="http://127.0.0.1:5001"
BROWSER="xdg-open"

# Check if service is running
if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
    echo "Service not running, attempting to start..."
    systemctl --user start "$SERVICE_NAME"
    
    # Wait a moment for service to start
    sleep 2
    
    # Check if it started successfully
    if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
        echo "Failed to start service. Please check logs:"
        echo "journalctl --user -u $SERVICE_NAME"
        exit 1
    fi
fi

# Wait for the web server to be ready
echo "Waiting for server to be ready..."
for i in {1..30}; do
    if curl -s "$APP_URL" > /dev/null 2>&1; then
        echo "Server is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "Server did not become ready. Check logs:"
        echo "journalctl --user -u $SERVICE_NAME"
        exit 1
    fi
    sleep 1
done

# Open browser
echo "Opening browser..."
$BROWSER "$APP_URL"
