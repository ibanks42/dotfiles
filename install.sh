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
source /etc/os-release
DISTRO="${ID_LIKE:-$ID}"

update_packages() {
  case "$DISTRO" in
  *debian*)
    sudo apt-get update && sudo apt-get upgrade
    ;;
  *fedora*)
    sudo dnf update
    ;;
  *arch*)
    sudo pacman -Syu
    ;;
  *suse*)
    sudo zypper update
    ;;
  *rhel* | *centos*)
    sudo yum update
    ;;
  *)
    echo "-> Unsupported distribution \"$DISTRO\" for updating packages."
    ;;
  esac
}

install_git() {
  if ! command -v git &>/dev/null; then
    echo "-> Installing Git..."
    case "$DISTRO" in
    *debian* | *ubuntu* | *linuxmint*)
      sudo apt-get install -y git
      ;;
    *fedora*)
      sudo dnf install -y git
      ;;
    *arch*)
      sudo pacman -S --noconfirm git
      ;;
    *suse*)
      sudo zypper install -y git
      ;;
    *rhel* | *centos*)
      sudo yum install -y git
      ;;
    *)
      echo "-> Unsupported distribution \"$DISTRO\" for installing Git."
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
  echo "-> Updating font submodules..."
  cd "$TEMP_PATH" || exit
  git submodule -q update --init --recursive

  cd "$CWD" || exit
}

install_gh() {
  if ! command -v gh &>/dev/null; then
    echo "-> Installing gh..."
    GHVERSION=$(wget -q "https://api.github.com/repos/cli/cli/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO gh.tar.gz "https://github.com/cli/cli/releases/download/v${GHVERSION}/gh_${GHVERSION}_linux_amd64.tar.gz"
    tar xf gh.tar.gz >/dev/null 2>&1
    sudo install "gh_${GHVERSION}_linux_amd64/bin/gh" -D -t /usr/bin/ >/dev/null 2>&1
    sudo cp -R "gh_${GHVERSION}_linux_amd64/share" /usr/local

    rm -rf gh.tar.gz "gh_${GHVERSION}_linux_amd64"

    gh auth login
  fi
}

install_nvim() {
  if ! command -v nvim &>/dev/null; then
    echo "-> Installing neovim..."
    cd "$TEMP_PATH" || exit
    wget -q -O nvim-linux64.tar.gz "https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz"
    tar -xf nvim-linux64.tar.gz >/dev/null 2>&1
    sudo install nvim-linux64/bin/nvim /usr/local/bin/nvim >/dev/null 2>&1
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

  if [[ -z $(gh ext list | grep "meiji163/gh-notify") ]]; then
    echo "-> Installing gh-notify for neovim dashboard..."
    gh ext install meiji163/gh-notify >/dev/null 2>&1
  fi

  printf "\u2705Neovim configuration installed successfully.\n"
}

install_zellij() {
  if ! command -v zellij &>/dev/null; then
    echo "-> Installing zellij..."
    cd "$TEMP_PATH" || exit
    wget -q -O "zellij.tar.xz" "https://github.com/zellij-org/zellij/releases/latest/download/zellij-x86_64-unknown-linux-musl.tar.gz"
    tar -xf "zellij.tar.xz" >/dev/null 2>&1
    sudo install zellij /usr/local/bin/zellij >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  echo "-> Copying zellij configuration..."
  cp -f -r "$TEMP_PATH/zelli" "$HOME/.config/zellij"
  printf "\u2705Zellij installed successfully...\n"
}

# install_alacritty() {
#   if ! command -v alacritty &>/dev/null; then
#     echo "-> Installing alacritty..."
#
#     case "$DISTRO" in
#     *debian*)
#       sudo apt-get install -y cmake g++ pkg-config libfreetype6-dev libfontconfig1-dev libxcb-xfixes0-dev libxkbcommon-dev python3 alacritty
#       ;;
#     *rhel* | *fedora*)
#       sudo dnf install -y cmake freetype-devel fontconfig-devel libxcb-devel libxkbcommon-devel g++ alacritty
#       ;;
#     *arch*)
#       sudo pacman -S cmake freetype2 fontconfig pkg-config make libxcb libxkbcommon python alacritty --noconfirm
#       ;;
#     *suse*)
#       sudo zypper install -y cmake freetype-devel fontconfig-devel libxcb-devel libxkbcommon-devel alacritty
#       ;;
#     *)
#       echo "Unsupported distribution: $DISTRO"
#       return 1
#       ;;
#     esac
#   fi
#
#   echo "-> Copying Alacritty configuration..."
#   cp -f -r "$TEMP_PATH/alacritty" "$HOME/.config/alacritty"
#
#   printf "\u2705Alacritty configuration installed successfully.\n"
# }

install_ghostty() {
  if ! command -v ghostty &>/dev/null; then
    echo "-> Installing ghostty..."
    cd "$TEMP_PATH" || exit
    git clone https://github.com/ghostty-org/ghostty.git ghostty-src
    cd ghostty-src || exit

    if ! command -v zig &>/dev/null; then
      "$HOME/.local/bin/mise" use --global zig >/dev/null 2>&1
    fi

    zig build -p "$HOME/.local" -Doptimize=ReleaseFast

    cp -f -r "$TEMP_PATH/ghostty" "$HOME/.config/ghostty"

    cd "$CWD" || exit

    printf "\u2705Ghostty configuration installed"
  fi
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

install_mise() {
  if ! command -v mise &>/dev/null; then
    # Install mise for managing multiple versions of languages. See https://mise.jdx.dev/
    wget -qO - https://mise.run | sh >/dev/null 2>&1
    tee -a "$HOME/.bashrc" <<<"eval \"\$(\$HOME/.local/bin/mise activate bash)\"" >/dev/null 2>&1
    "$HOME/.local/bin/mise" use --global node@latest >/dev/null 2>&1
  fi
}

install_miscellaneous() {
  echo "-> Setting up bash and installing requirements..."
  if ! command -v eza &>/dev/null; then
    echo "-> Installing eza (ls alternative)..."
    cd "$TEMP_PATH" || exit
    wget -qO eza.tar.gz "https://github.com/eza-community/eza/releases/latest/download/eza_x86_64-unknown-linux-gnu.tar.gz"
    tar xf eza.tar.gz >/dev/null 2>&1
    sudo install eza /usr/bin/eza >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  if ! command -v fzf &>/dev/null; then
    echo "-> Installing fzf (telescope alternative)..."
    cd "$TEMP_PATH" || exit
    FZFVERSION=$(wget -q "https://api.github.com/repos/junegunn/fzf/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO fzf.tar.gz "https://github.com/junegunn/fzf/releases/download/v${FZFVERSION}/fzf-${FZFVERSION}-linux_amd64.tar.gz"
    tar xf fzf.tar.gz fzf >/dev/null 2>&1
    sudo install fzf -D -t /usr/local/bin/ >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  if ! command -v zoxide &>/dev/null; then
    echo "-> Installing zoxide (cd alternative)..."
    cd "$TEMP_PATH" || exit
    wget -qO- https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh >/dev/null 2>&1
    tee -a "$HOME/.bashrc" <<<"export PATH=\"\$PATH:\$HOME/.local/bin\"" >/dev/null 2>&1
    tee -a "$HOME/.bashrc" <<<"eval \"\$(zoxide init bash)\"" >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  if ! command -v fdfind &>/dev/null; then
    echo "-> Installing fd..."
    cd "$TEMP_PATH" || exit
    FDVERSION=$(wget -q "https://api.github.com/repos/sharkdp/fd/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO fd.tar.gz "https://github.com/sharkdp/fd/releases/download/v${FDVERSION}/fd-v${FDVERSION}-x86_64-unknown-linux-musl.tar.gz"
    tar xf fd.tar.gz >/dev/null 2>&1
    cp "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fd" "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fdfind"
    sudo install "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fd" -D -t /usr/local/bin/ >/dev/null 2>&1
    sudo install "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fdfind" -D -t /usr/local/bin/ >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  if ! command -v fdfind &>/dev/null; then
    echo "-> Installing fd..."
    cd "$TEMP_PATH" || exit
    FDVERSION=$(wget -q "https://api.github.com/repos/sharkdp/fd/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO fd.tar.gz "https://github.com/sharkdp/fd/releases/download/v${FDVERSION}/fd-v${FDVERSION}-x86_64-unknown-linux-musl.tar.gz"
    tar xf fd.tar.gz >/dev/null 2>&1
    cp "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fd" "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fdfind"
    sudo install "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fd" -D -t /usr/local/bin/ >/dev/null 2>&1
    sudo install "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fdfind" -D -t /usr/local/bin/ >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  if ! command -v lazygit &>/dev/null; then
    echo "-> Installing lazygit..."
    cd "$TEMP_PATH" || exit
    LAZYGIT_VERSION=$(wget -q "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
    tar xf lazygit.tar.gz lazygit >/dev/null 2>&1
    sudo install lazygit -D -t /usr/local/bin/ >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  if ! command -v batcat &>/dev/null; then
    echo "-> Installing bat..."
    cd "$TEMP_PATH" || exit
    BATCATVERSION=$(wget -q "https://api.github.com/repos/sharkdp/bat/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO bat.tar.gz "https://github.com/sharkdp/bat/releases/download/v${BATCATVERSION}/bat-v${BATCATVERSION}-x86_64-unknown-linux-musl.tar.gz"
    tar xf bat.tar.gz >/dev/null 2>&1
    sudo mv "bat-v${BATCATVERSION}-x86_64-unknown-linux-musl" /usr/local/bat
    tee -a "$HOME/.bashrc" <<<"alias bat='/usr/local/bat/bat'" >/dev/null 2>&1
    tee -a "$HOME/.bashrc" <<<"alias batcat='/usr/local/bat/bat'" >/dev/null 2>&1
    cd "$CWD" || exit
  fi
}

update_bashrc() {
  echo "-> Writing bashrc config..."
  declare -A entries=(
    ["alias ls"]='alias ls="eza -lh --group-directories-first --icons"'
    ["alias lsa"]='alias lsa="ls -a"'
    ["alias la"]='alias la="ls -a"'
    ["alias lt"]='alias lt="eza --tree --level=2 --long --icons --git"'
    ["alias lta"]='alias lta="lt -a"'
    ["alias ff"]='alias ff="fzf --preview '\''batcat --style=numbers --color=always {}'\''"'
    ["alias fd"]='alias fd="fdfind"'
    ["alias cd"]='alias cd="z"'
    ["PS1"]='PS1="\[\e[0;35m\]\u@\h\[\e[0m\]:\[\e[0;32m\]\w\[\e[0m\]\\$ "'
  )

  for key in "${!entries[@]}"; do
    entry="${entries[$key]}"
    if ! grep -qxF "$entry" "$HOME/.bashrc"; then
      # Add only if it doesn't already exist
      echo "$entry" | tee -a "$HOME/.bashrc" >/dev/null
    fi
  done

  printf "\u2705Bash configuration updated.\n"
}

update_packages

install_git

install_gh

clone_repository

install_fonts

install_miscellaneous

install_mise

# install_alacritty
install_ghostty

install_zellij

install_nvim

install_ideavim

update_bashrc

echo "-> Cleaning up..."
# Cleanup
# rm -rf "$TEMP_PATH"

echo ""
printf "\u2705Done!\n"
echo ""

echo "-------------------"
echo "Run the following to finish installation"
echo ""
echo "  source ~/.bashrc"
echo ""
echo "-------------------"
