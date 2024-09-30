#!/bin/zsh

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git" # Replace with your repository URL
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"
NVIM_SHARE_PATH="$HOME/.local/share/nvim"
NVIM_DATA_PATH="$HOME/.local/share/nvim"
NVIM_CACHE_PATH="$HOME/.cache/nvim"
KITTY_PATH="$HOME/.config/kitty"

# Function to clone the repository
clone_repository() {
    git clone -q "$REPO_URL" "$TEMP_PATH"
}

# Function to copy nvim configuration
copy_nvim_config() {
    if [[ -d "$NVIM_CONFIG_PATH" ]]; then  # Use [[ ]] for conditionals in zsh
        echo "Removing existing Neovim configuration..."
        rm -rf "$NVIM_CONFIG_PATH"
    fi
    if [[ -d "$NVIM_SHARE_PATH" ]]; then
        echo "Removing existing Neovim share directory..."
        rm -rf "$NVIM_SHARE_PATH"
    fi
    if [[ -d "$NVIM_DATA_PATH" ]]; then
        echo "Removing existing Neovim data directory..."
        rm -rf "$NVIM_DATA_PATH"
    fi
    if [[ -d "$NVIM_CACHE_PATH" ]]; then
        echo "Removing existing Neovim cache directory..."
        rm -rf "$NVIM_CACHE_PATH"
    fi
    
    echo "Copying Neovim configuration..."
    
    cp -r "$TEMP_PATH/nvim" "$NVIM_CONFIG_PATH"

    echo "-> Neovim configuration installed successfully."
}

# Function to copy kitty configuration
copy_kitty_config() {
    if [[ -d "$KITTY_PATH" ]]; then
        echo "Removing existing Kitty configuration..."
        rm -rf "$KITTY_PATH"
    fi

    echo "Copying Kitty configuration..."
    cp -r "$TEMP_PATH/kitty/." "$KITTY_PATH"
    echo "-> Kitty configuration installed successfully."
}

install_fonts() {
    echo "Installing fonts..."
    mkdir -p "$HOME/.local/share/fonts"

    # Copy both .ttf and .otf files
    for font in "$TEMP_PATH/fonts/"*.{ttf,otf}; do
        echo "-> Installing $font"
        cp "$font" "$HOME/.local/share/fonts"
    done

    fc-cache -f  # Update font cache
}

# Main script
if ! command -v git &> /dev/null; then  # This works the same in bash and zsh
    echo "Git is not installed. Please install Git and try again."
    exit 1
fi

# Clone the repository
clone_repository

# Copy nvim configuration
copy_nvim_config

# Copy kitty configuration
copy_kitty_config

# Install fonts
install_fonts

# Cleanup
rm -rf "$TEMP_PATH"
