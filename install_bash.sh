#!/bin/bash

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git"
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"
NVIM_SHARE_PATH="$HOME/.local/share/nvim"
NVIM_DATA_PATH="$HOME/.local/share/nvim"
NVIM_CACHE_PATH="$HOME/.cache/nvim"
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
  if ! command -v git &>/dev/null; then
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
  cd "$TEMP_PATH" || exit
  git submodule -q update --init --recursive

  cd "$CWD" || exit

  echo "-> Repository cloned successfully."
}

install_nvim() {
  if ! command -v nvim &>/dev/null; then
    wget -q -O "$TEMP_PATH/nvim-linux64.tar.gz" "https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz"
    cd "$TEMP_PATH" || exit
    tar -xf "$TEMP_PATH/nvim-linux64.tar.gz"
    sudo install nvim-linux64/bin/nvim /usr/local/bin/nvim
    sudo cp -R nvim-linux64/lib /usr/local/
    sudo cp -R nvim-linux64/share /usr/local
    cd "$CWD" || exit
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

  cp -f -r "$TEMP_PATH/nvim" "$NVIM_CONFIG_PATH"

  echo "-> Neovim configuration installed successfully."
}

install_zellij() {
  if ! command -v nvim &>/dev/null; then
    echo "-> Installing zellij..."
    wget -q -O "$TEMP_PATH/zellij.tar.xz" "https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz"
    cd "$TEMP_PATH" || exit
    tar -xf "$TEMP_PATH/zellij.tar.xz"
    sudo install zellij /usr/local/bin/zelli
    cd "$CWD" || exit
  fi

  echo "-> Copying zellij configuration..."
  cp -f -r "$TEMP_PATH/zelli" "$HOME/.config/zellij"
  echo "-> Zellij installed successfully..."
}

install_alacritty() {
  if ! command -v alacritty &>/dev/null; then
    echo "-> Installing alacritty..."

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
  cp -f -r "$TEMP_PATH/alacritty" "$HOME/.config/alacritty"

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

install_ideavim() {
  cp -f "$TEMP_PATH/idea/.ideavimrc" "$HOME/.ideavimrc"
}

install_git

clone_repository

install_nvim

install_alacritty

install_zellij

install_fonts

install_ideavim

echo "-> Cleaning up..."
# Cleanup
rm -rf "$TEMP_PATH"

echo ""
echo "Done!"
