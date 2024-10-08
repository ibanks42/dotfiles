#!/bin/bash

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git"
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"
NVIM_SHARE_PATH="$HOME/.local/share/nvim"
NVIM_DATA_PATH="$HOME/.local/share/nvim"
NVIM_CACHE_PATH="$HOME/.cache/nvim"
TMUX_CONFIG_PATH="$HOME/.tmux.conf"
CWD=$(pwd)

# Function to clone the repository
clone_repository() {
    if [ -d "$TEMP_PATH" ]; then
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
    if [ -d "$NVIM_CONFIG_PATH" ]; then
        echo "Removing existing Neovim configuration..."
        rm -rf "$NVIM_CONFIG_PATH"
    fi
    if [ -d "$NVIM_SHARE_PATH" ]; then
        echo "Removing existing Neovim share directory..."
        rm -rf "$NVIM_SHARE_PATH"
    fi
    if [ -d "$NVIM_DATA_PATH" ]; then
        echo "Removing existing Neovim data directory..."
        rm -rf "$NVIM_DATA_PATH"
    fi
    if [ -d "$NVIM_CACHE_PATH" ]; then
        echo "Removing existing Neovim cache directory..."
        rm -rf "$NVIM_CACHE_PATH"
    fi

    echo "Copying Neovim configuration..."

    cp -r "$TEMP_PATH/nvim" "$NVIM_CONFIG_PATH"

    echo "-> Neovim configuration installed successfully."
}


install_tmux() {
    echo "Installing tmux..."

    # Check for /etc/os-release
    if [ -f /etc/os-release ]; then
        source /etc/os-release
        distro="$ID"
    else
        # Fallback to lsb_release if /etc/os-release is not present
        distro=$(lsb_release -i | awk '{print $3}')
    fi

    case "$distro" in
        "ubuntu" | "debian")
            sudo apt-get install -y tmux
            ;;
        "fedora")
            sudo dnf install -y tmux
            ;;
        "arch")
            sudo pacman -S tmux
            ;;
        "opensuse")
            sudo zypper install -y tmux
            ;;
        "rhel" | "centos")
            sudo yum install -y tmux
            ;;
        *)
            echo "Unsupported distribution: $distro"
            ;;
    esac
}

copy_tmux_config() {
    if [ -d "$TMUX_PATH" ]; then
        echo "Removing existing Tmux configuration..."
        rm -rf "$TMUX_PATH"
    fi

    echo "Copying Tmux configuration..."
    cp -r "$TEMP_PATH/tmux/." "$TMUX_PATH"

    echo "-> Tmux configuration installed successfully."
}

install_fonts() {
    echo "Installing fonts..."
    mkdir -p "$HOME/.local/share/fonts"

    # Check if the fonts directory exists
    if [ ! -d "$TEMP_PATH/fonts" ]; then
        echo "-> Fonts directory not found. Skipping font installation."
        return  # Exit the function if no fonts directory
    fi

    # Find all .ttf and .otf files recursively within the fonts directory
    find "$TEMP_PATH/fonts" -type f \( -name "*.ttf" -o -name "*.otf" \) -exec cp {} "$HOME/.local/share/fonts" \;

    fc-cache -f  # Update font cache
}

install_theme() {
    echo "Installing theme..."

    gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
    gsettings set org.gnome.desktop.interface cursor-theme 'Yaru'
    gsettings set org.gnome.desktop.interface gtk-theme "Yaru-bark-dark"
    gsettings set org.gnome.desktop.interface icon-theme "Yaru-bark"

    BACKGROUND_ORG_PATH="$TEMP_PATH/gnome/background.jpg"
    BACKGROUND_DEST_DIR="$HOME/.local/share/backgrounds"
    BACKGROUND_DEST_PATH="$BACKGROUND_DEST_DIR/everforest.jpg"

    echo "Copying background $BACKGROUND_DEST_PATH"

    if [ ! -d "$BACKGROUND_DEST_DIR" ]; then mkdir -p "$BACKGROUND_DEST_DIR"; fi

    [ ! -f $BACKGROUND_DEST_PATH ] && cp $BACKGROUND_ORG_PATH $BACKGROUND_DEST_PATH
    gsettings set org.gnome.desktop.background picture-uri $BACKGROUND_DEST_PATH
    gsettings set org.gnome.desktop.background picture-uri-dark $BACKGROUND_DEST_PATH
    gsettings set org.gnome.desktop.background picture-options 'zoom'
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

# Install tmux
install_tmux

# Copy tmux configuration
copy_tmux_config

# Install fonts
install_fonts

# Install theme
install_theme

# Cleanup
rm -rf "$TEMP_PATH"
