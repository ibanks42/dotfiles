#!/bin/bash

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git" # Replace with your repository URL
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"
KITTY_PATH="$HOME/.config/kitty"

# Function to clone the repository
clone_repository() {
    git clone -q "$REPO_URL" "$TEMP_PATH"
}

# Function to copy nvim configuration
copy_nvim_config() {
    if [ -d "$NVIM_CONFIG_PATH" ]; then
        rm -rf "$NVIM_CONFIG_PATH"
    fi
    cp -r "$TEMP_PATH/nvim" "$NVIM_CONFIG_PATH"

    echo "-> Neovim configuration installed successfully."
}

# Function to copy kitty configuration
copy_kitty_config() {
    if [ -d "$KITTY_PATH" ]; then
        rm -rf "$KITTY_PATH"
    fi
    cp -r "$TEMP_PATH/kitty/." "$KITTY_PATH"

    echo "-> Kitty configuration installed successfully."
}

install_fonts() {
    echo "Installing fonts..."
    mkdir -p "$HOME/.local/share/fonts"

    # Copy both .ttf and .otf files
    for font in "$TEMP_PATH/fonts/"*.{ttf,otf}; do
        cp "$font" "$HOME/.local/share/fonts"
    done

    fc-cache -fv  # Update font cache
}

# Main script
if ! command -v git &> /dev/null; then
    echo "Git is not installed. Please install Git and try again."
    exit 1
fi

# Clone the repository
clone_repository

# Copy nvim configuration
copy_nvim_config

# Copy kitty configuration
copy_kitty_config

# Cleanup
rm -rf "$TEMP_PATH"
