#!/bin/zsh

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git"
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"
NVIM_SHARE_PATH="$HOME/.local/share/nvim"
NVIM_DATA_PATH="$HOME/.local/share/nvim"
NVIM_CACHE_PATH="$HOME/.cache/nvim"
KITTY_PATH="$HOME/.config/kitty"
CWD=$(pwd)

# Function to clone the repository
clone_repository() {
    if [[ -d "$TEMP_PATH" ]]; then  # Zsh conditional syntax
        echo "Removing existing temporary directory..."
        rm -rf "$TEMP_PATH"
    fi
    
    echo "Cloning repository..."
    
    git clone -q "$REPO_URL" "$TEMP_PATH"
    
    # Get the submodules
    cd "$TEMP_PATH"
    git submodule update --init --recursive

    cd "$CWD"
    
    echo "-> Repository cloned successfully."
}

# Function to copy nvim configuration
copy_nvim_config() {
    if [[ -d "$NVIM_CONFIG_PATH" ]]; then 
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
    mkdir -p "$HOME/Library/Fonts"  # macOS font directory

    # Check if the fonts directory exists
    if [[ ! -d "$TEMP_PATH/fonts" ]]; then
        echo "-> Fonts directory not found. Skipping font installation."
        return  # Exit the function if no fonts directory
    fi

    # Find all .ttf and .otf files recursively within the fonts directory
    find "$TEMP_PATH/fonts" -type f \( -name "*.ttf" -o -name "*.otf" \) -exec cp {} "$HOME/Library/Fonts" \;
}

# Main script
if ! command -v git &> /dev/null; then
    echo "Git is not installed. Please install Git and try again."
    exit 1
fi

install_kitty() {
    echo "Installing kitty..."

    curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/stdin

    # Create symbolic links to add kitty and kitten to PATH (assuming ~/.local/bin is in
    # your system-wide PATH)
    ln -sf ~/.local/kitty.app/bin/kitty ~/.local/kitty.app/bin/kitten ~/.local/bin/
    # Place the kitty.desktop file somewhere it can be found by the OS
    cp ~/.local/kitty.app/share/applications/kitty.desktop ~/.local/share/applications/
    # If you want to open text files and images in kitty via your file manager also add the kitty-open.desktop file
    cp ~/.local/kitty.app/share/applications/kitty-open.desktop ~/.local/share/applications/
    # Update the paths to the kitty and its icon in the kitty desktop file(s)
    sed -i "s|Icon=kitty|Icon=$(readlink -f ~)/.local/kitty.app/share/icons/hicolor/256x256/apps/kitty.png|g" ~/.local/share/applications/kitty*.desktop
    sed -i "s|Exec=kitty|Exec=$(readlink -f ~)/.local/kitty.app/bin/kitty|g" ~/.local/share/applications/kitty*.desktop
    # Make xdg-terminal-exec (and hence desktop environments that support it use kitty)
    echo 'kitty.desktop' > ~/.config/xdg-terminals.list
}

# Clone the repository
clone_repository

install_kitty

# Copy nvim configuration
copy_nvim_config

# Copy kitty configuration
copy_kitty_config

# Install fonts
install_fonts

# Cleanup
rm -rf "$TEMP_PATH"
