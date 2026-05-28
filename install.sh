#!/usr/bin/env bash
set -euo pipefail

PLIST_LABEL="com.feedback-tool"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_OUT="$LOG_DIR/feedback-tool.log"
LOG_ERR="$LOG_DIR/feedback-tool.error.log"
PORT="${PORT:-7777}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "Feedback Tool — Installer"
echo "========================="
echo ""

# 1. Resolve bun
if ! BUN_PATH="$(command -v bun 2>/dev/null)"; then
  echo "Error: bun is not installed or not in PATH."
  echo "Install bun: https://bun.sh"
  exit 1
fi
echo "✓ Found bun at: $BUN_PATH"

# 2. Verify index.ts exists in the script directory
if [ ! -f "$SCRIPT_DIR/index.ts" ]; then
  echo "Error: index.ts not found in $SCRIPT_DIR"
  exit 1
fi
echo "✓ Found entry point: $SCRIPT_DIR/index.ts"

# 3. Install dependencies if node_modules is missing
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$SCRIPT_DIR" && "$BUN_PATH" install)
fi

# 4. Create log directory if needed
mkdir -p "$LOG_DIR"

# 5. Remove existing installation if present
if launchctl list "$PLIST_LABEL" &>/dev/null; then
  echo "Removing existing installation..."
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || \
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# 6. Write the LaunchAgent plist
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${BUN_PATH}</string>
        <string>run</string>
        <string>${SCRIPT_DIR}/index.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>$(dirname "$BUN_PATH"):/usr/local/bin:/usr/bin:/bin</string>
        <key>PORT</key>
        <string>${PORT}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_OUT}</string>

    <key>StandardErrorPath</key>
    <string>${LOG_ERR}</string>
</dict>
</plist>
PLIST

echo "✓ LaunchAgent plist written to: $PLIST_PATH"

# 7. Load the LaunchAgent (macOS 13+ uses bootstrap, older uses load)
if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  echo "✓ LaunchAgent loaded (bootstrap)"
elif launchctl load "$PLIST_PATH" 2>/dev/null; then
  echo "✓ LaunchAgent loaded (legacy)"
else
  echo "Warning: could not load LaunchAgent automatically."
  echo "You can load it manually: launchctl load \"$PLIST_PATH\""
fi

echo ""
echo "========================="
echo "✓ Installation complete!"
echo ""
echo "  Dashboard: http://localhost:${PORT}"
echo "  Logs:      $LOG_OUT"
echo "  Config:    \$HOME/.config/feedback-tool/config.json"
echo ""
echo "The server will start automatically on every login."
echo "To uninstall: ./uninstall.sh"
echo ""

# 8. Open the dashboard in the default browser
if command -v open &>/dev/null; then
  sleep 1
  open "http://localhost:${PORT}" &
fi
