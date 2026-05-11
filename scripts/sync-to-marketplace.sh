#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Resolve SOURCE_DIR relative to this script so it works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/../plugin/"
DEST_DIR="$HOME/.claude/plugins/marketplaces/thedotmack/plugin/"
CACHE_ROOT="$HOME/.claude/plugins/cache/thedotmack/claude-mem"

print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

if [ ! -d "$SOURCE_DIR" ]; then
    print_error "Source directory '$SOURCE_DIR' does not exist!"
    exit 1
fi

if [ ! -d "$DEST_DIR" ]; then
    print_warning "Destination directory '$DEST_DIR' does not exist. Creating it..."
    mkdir -p "$DEST_DIR"
fi

print_status "Syncing plugin folder to marketplace..."
print_status "Source: $SOURCE_DIR"
print_status "Destination: $DEST_DIR"

if [ "$1" = "--dry-run" ] || [ "$1" = "-n" ]; then
    print_status "Dry run — showing what would be synced to marketplace:"
    rsync -av --delete --dry-run "$SOURCE_DIR" "$DEST_DIR"
    PLUGIN_VERSION=$(node -p "require('$SOURCE_DIR/package.json').version" 2>/dev/null || echo "")
    if [ -n "$PLUGIN_VERSION" ] && [ -d "$CACHE_ROOT/$PLUGIN_VERSION" ]; then
        echo ""
        print_status "Dry run — showing what would be synced to cache ($PLUGIN_VERSION):"
        rsync -av --delete --dry-run "$SOURCE_DIR" "$CACHE_ROOT/$PLUGIN_VERSION/"
    fi
    exit 0
fi

if rsync -av --delete "$SOURCE_DIR" "$DEST_DIR"; then
    print_status "✅ Plugin folder synced to marketplace!"
else
    print_error "❌ Sync to marketplace failed!"
    exit 1
fi

# Hooks (see hooks.json) resolve the plugin path by `ls -dt $CACHE_ROOT/[0-9]*/`
# first, falling back to the marketplace. So syncing only to the marketplace
# leaves running sessions on stale code until claude-code repopulates the
# cache. Push into the cache slot matching the plugin's declared version too.
PLUGIN_VERSION=$(node -p "require('$SOURCE_DIR/package.json').version" 2>/dev/null || echo "")
if [ -n "$PLUGIN_VERSION" ] && [ -d "$CACHE_ROOT/$PLUGIN_VERSION" ]; then
    CACHE_DIR="$CACHE_ROOT/$PLUGIN_VERSION/"
    print_status "Syncing into cache slot: $CACHE_DIR"
    if rsync -av --delete "$SOURCE_DIR" "$CACHE_DIR"; then
        print_status "✅ Plugin folder synced to cache!"
    else
        print_warning "Sync to cache failed — sessions may run stale code until restart"
    fi
elif [ -n "$PLUGIN_VERSION" ]; then
    print_warning "No cache slot at $CACHE_ROOT/$PLUGIN_VERSION — skipping cache sync (this is fine if you haven't installed the plugin via Claude Code yet)"
fi

echo ""
print_status "Sync complete. Files are now synchronized."
print_status "You can run '$0 --dry-run' to preview changes before syncing."