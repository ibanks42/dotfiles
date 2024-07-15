#!/bin/zsh

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git" # Replace with your repository URL
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"
WEZTERM_CONFIG_PATH="$HOME"

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

# Function to copy Wezterm configuration
copy_wezterm_config() {
    if [ -d "$WEZTERM_CONFIG_PATH" ]; then
        rm -rf "$WEZTERM_CONFIG_PATH"
    fi
    cp -r "$TEMP_PATH/wezterm/." "$WEZTERM_CONFIG_PATH"

    echo "-> Wezterm configuration installed successfully."
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

# Cleanup
rm -rf "$TEMP_PATH"
