#!/bin/zsh

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git" # Replace with your repository URL
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"

# Function to clone the repository
clone_repository() {
    echo "Cloning repository from $REPO_URL..."
    git clone "$REPO_URL" "$TEMP_PATH"
}

# Function to copy nvim configuration
copy_nvim_config() {
    echo "Copying nvim configuration to $NVIM_CONFIG_PATH..."
    if [ -d "$NVIM_CONFIG_PATH" ]; then
        rm -rf "$NVIM_CONFIG_PATH"
    fi
    cp -r "$TEMP_PATH/nvim" "$NVIM_CONFIG_PATH"
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

echo "nvim configuration installed successfully."
