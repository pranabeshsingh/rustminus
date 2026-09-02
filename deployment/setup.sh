#!/usr/bin/env bash
set -e

echo "=== RustMinus Setup & Installation ==="

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Please install Node.js 18+ (e.g. via nodesource)."
    exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "Warning: Node.js version $NODE_VER detected. Recommended version is 18 or newer."
fi

# Install npm dependencies & apply patches
echo "Installing dependencies..."
npm install

# Ensure data directory exists
mkdir -p data/audio data/sessions

# Check configuration files
if [ ! -f "data/config.json" ]; then
    echo "Creating data/config.json from template..."
    cp data/config.example.json data/config.json
    echo "⚠️ Please edit data/config.json with your Matrix credentials and admin password hash!"
fi

if [ ! -f "data/servers.json" ]; then
    echo "Creating data/servers.json from template..."
    cp data/servers.example.json data/servers.json
    echo "⚠️ Please edit data/servers.json with your Rust server IP, port, and player credentials."
fi

echo "Setup complete! You can start the server with: npm start"
