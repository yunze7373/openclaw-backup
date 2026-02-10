#!/bin/bash

# Installation script for ClawBackup

set -e

INSTALL_DIR="$HOME/.claw-backup"
BIN_DIR="$HOME/bin"

# Create directories if they don't already exist
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# Copy all files to the installation directory
cp -r . "$INSTALL_DIR"

# Create symlink in bin directory
ln -sf "$INSTALL_DIR/src/index.js" "$BIN_DIR/claw-backup"
chmod +x "$BIN_DIR/claw-backup"

echo "ClawBackup installed successfully. Make sure $BIN_DIR is in your PATH."