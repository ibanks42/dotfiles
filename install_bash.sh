#!/bin/bash

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git"
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"
NVIM_SHARE_PATH="$HOME/.local/share/nvim"
NVIM_DATA_PATH="$HOME/.local/share/nvim"
NVIM_CACHE_PATH="$HOME/.cache/nvim"
TMUX_CONFIG_PATH="$HOME/.tmux.conf"
ALACRITTY_CONFIG_PATH="$HOME/.config/alacritty/alacritty.toml"
CWD=$(pwd)

# Check for /etc/os-release
if [ -f /etc/os-release ]; then
    source /etc/os-release
    DISTRO="$ID"
else
    # Fallback to lsb_release if /etc/os-release is not present
    DISTRO=$(lsb_release -i | awk '{print $3}')
fi

install_git() {
    if ! command -v git &> /dev/null; then
        echo "Installing Git..."
        case "$DISTRO" in
            "ubuntu" | "debian")
                sudo apt-get install -y git
                ;;
            "fedora")
                sudo dnf install -y git
                ;;
            "arch")
                sudo pacman -S git -y
                ;;
            "opensuse")
                sudo zypper install -y git
                ;;
            "rhel" | "centos")
                sudo yum install -y git
                ;;
            *)
                echo "-> Unsupported distribution for Git. Please install Git manually."
                ;;
        esac
    fi
}

clone_repository() {
    if [ -d "$TEMP_PATH" ]; then
        echo "-> Removing existing temporary directory..."
        rm -rf "$TEMP_PATH"
    fi

    echo "-> Cloning repository..."

    git clone -q "$REPO_URL" "$TEMP_PATH"

    # Get the submodules
    cd "$TEMP_PATH"
    git submodule -q update --init --recursive

    cd "$CWD"

    echo "-> Repository cloned successfully."
}

install_nvim() {
    if ! command -v nvim &> /dev/null; then
	wget -q -O "$TEMP_PATH/nvim-linux64.tar.gz" "https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz"	
	cd "$TEMP_PATH"
	tar -xf "$TEMP_PATH/nvim-linux64.tar.gz"
	sudo install nvim-linux64/bin/nvim /usr/local/bin/nvim
	sudo cp -R nvim-linux64/lib /usr/local/
	sudo cp -R nvim-linux64/share /usr/local
	cd "$CWD"
    fi

    if [ -d "$NVIM_CONFIG_PATH" ]; then
        echo "-> Removing existing Neovim configuration..."
        rm -rf "$NVIM_CONFIG_PATH"
    fi
    if [ -d "$NVIM_SHARE_PATH" ]; then
        echo "-> Removing existing Neovim share directory..."
        rm -rf "$NVIM_SHARE_PATH"
    fi
    if [ -d "$NVIM_DATA_PATH" ]; then
        echo "-> Removing existing Neovim data directory..."
        rm -rf "$NVIM_DATA_PATH"
    fi
    if [ -d "$NVIM_CACHE_PATH" ]; then
        echo "-> Removing existing Neovim cache directory..."
        rm -rf "$NVIM_CACHE_PATH"
    fi

    echo "-> Copying Neovim configuration..."

    cp -r "$TEMP_PATH/nvim" "$NVIM_CONFIG_PATH"

    echo "-> Neovim configuration installed successfully."
}

install_tmux() {
    if ! command -v tmux &> /dev/null; then
        echo "-> Installing tmux..."

        case "$DISTRO" in
            "ubuntu" | "debian")
                sudo apt-get install -y tmux
                ;;
            "fedora")
                sudo dnf install -y tmux
                ;;
            "arch")
                sudo pacman -S tmux -y
                ;;
            "opensuse")
                sudo zypper install -y tmux
                ;;
            "rhel" | "centos")
                sudo yum install -y tmux
                ;;
            *)
                echo "-> Unsupported distribution for tmux. Please install tmux manually."
                ;;
        esac
    fi

    echo "-> Copying Tmux configuration..."
    cp -f "$TEMP_PATH/tmux/.tmux.conf" "$TMUX_CONFIG_PATH"

    echo "-> Tmux configuration installed successfully."
}

install_alacritty() {
    if ! command -v alacritty &> /dev/null; then
        echo "-> Installing tmux..."

        case "$DISTRO" in
            "ubuntu" | "debian")
                sudo apt-get install -y alacritty
                ;;
            "fedora")
                sudo dnf install -y alacritty
                ;;
            "arch")
                sudo pacman -S alacritty -y
                ;;
            "opensuse")
                sudo zypper install -y alacritty
                ;;
            *)
                echo "-> Unsupported distribution for alacritty. Please install alacritty manually."
                ;;
        esac
    fi

    echo "-> Copying Alacritty configuration..."
    cp -f "$TEMP_PATH/alacritty/alacritty.toml" "$ALACRITTY_CONFIG_PATH"

    echo "-> Alacritty configuration installed successfully."
}

install_fonts() {
    echo "-> Installing fonts..."
    mkdir -p "$HOME/.local/share/fonts"

    if [ ! -d "$TEMP_PATH/fonts" ]; then
        echo "-> Fonts directory not found. Skipping font installation."
        return
    fi

    find "$TEMP_PATH/fonts" -type f \( -name "*.ttf" -o -name "*.otf" \) -exec cp {} "$HOME/.local/share/fonts" \;

    fc-cache -f
}

install_theme() {
    if command -v gnome-shell &> /dev/null; then
        echo "-> Installing theme..."

        gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
        gsettings set org.gnome.desktop.interface cursor-theme 'Yaru'
        gsettings set org.gnome.desktop.interface gtk-theme "Yaru-bark-dark"
        gsettings set org.gnome.desktop.interface icon-theme "Yaru-bark"

        BACKGROUND_ORG_PATH="$TEMP_PATH/gnome/background.jpg"
        BACKGROUND_DEST_DIR="$HOME/.local/share/backgrounds"
        BACKGROUND_DEST_PATH="$BACKGROUND_DEST_DIR/everforest.jpg"

        if [ ! -d "$BACKGROUND_DEST_DIR" ]; then mkdir -p "$BACKGROUND_DEST_DIR"; fi

        [ ! -f $BACKGROUND_DEST_PATH ] && cp $BACKGROUND_ORG_PATH $BACKGROUND_DEST_PATH
        gsettings set org.gnome.desktop.background picture-uri $BACKGROUND_DEST_PATH
        gsettings set org.gnome.desktop.background picture-uri-dark $BACKGROUND_DEST_PATH
        gsettings set org.gnome.desktop.background picture-options 'zoom'
    fi
}

install_git

clone_repository

install_nvim

install_alacritty

install_tmux

install_fonts

install_theme

echo "-> Cleaning up..."
# Cleanup
rm -rf "$TEMP_PATH"

echo ""
echo "Done!"
