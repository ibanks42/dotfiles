#!/bin/bash

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git"
DOTFILES_PATH="$HOME/dotfiles"
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
    *debian*)
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
  if [ -d "$DOTFILES_PATH" ]; then
    echo "-> Removing existing temporary directory..."
    rm -rf "$DOTFILES_PATH"
  fi

  echo "-> Cloning repository..."

  git clone -q "$REPO_URL" "$DOTFILES_PATH"

  # Get the submodules
  echo "-> Updating font submodules..."
  cd "$DOTFILES_PATH" || exit
  git submodule -q update --init --recursive

  cd "$CWD" || exit
}

install_gh() {
  if ! command -v gh &>/dev/null; then
    echo "-> Installing gh..."
    GHVERSION=$(wget -q "https://api.github.com/repos/cli/cli/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO gh.tar.gz "https://github.com/cli/cli/releases/download/v${GHVERSION}/gh_${GHVERSION}_linux_amd64.tar.gz"
    tar xf gh.tar.gz
    sudo install "gh_${GHVERSION}_linux_amd64/bin/gh" -D -t "$HOME/.local/bin"
    sudo cp -R "gh_${GHVERSION}_linux_amd64/share" "$HOME/.local/bin"

    rm -rf gh.tar.gz "gh_${GHVERSION}_linux_amd64"
    gh auth login
  fi
}

install_nvim() {
  if ! command -v nvim &>/dev/null; then
    echo "-> Installing neovim..."
    cd "$DOTFILES_PATH" || exit
    wget -q -O nvim-linux64.tar.gz "https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz"
    tar -xf nvim-linux64.tar.gz
    sudo install nvim-linux64/bin/nvim "$HOME/.local/bin/nvim"
    sudo cp -R nvim-linux64/lib "$HOME/.local/bin"
    sudo cp -R nvim-linux64/share "$HOME/.local/bin"
    rm -rf nvim-linux64.tar.gz nvim-linux64
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

  ln -s "$DOTFILES_PATH/nvim" "$NVIM_CONFIG_PATH" 

  printf "\u2705Neovim configuration installed successfully.\n"
}

install_tmux() {
   if ! command -v tmux &> /dev/null; then
      echo "-> Installing tmux..."

      case "$DISTRO" in
          *debian*)
              sudo apt-get install -y tmux
              ;;
          *fedora*)
              sudo dnf install -y tmux
              ;;
          *arch*)
              sudo pacman -S tmux -y
              ;;
          *suse*)
              sudo zypper install -y tmux
              ;;
          *rhel* | *centos*)
              sudo yum install -y tmux
              ;;
          *)
              echo "-> Unsupported distribution for tmux. Please install tmux manually."
              ;;
      esac
  fi

  echo "-> Copying tmux configuration..."
  ln -s "$DOTFILES_PATH/tmux" "$HOME/.config/tmux"
  printf "\u2705Tmux installed successfully...\n"
}

install_ghostty() {
  if ! command -v ghostty &>/dev/null; then
    echo "-> Installing ghostty..."
    case "$DISTRO" in
    *debian*)
      curl -fsSL https://raw.githubusercontent.com/mkasberg/ghostty-ubuntu/HEAD/install.sh
      ;;
    *fedora*)
      sudo dnf install --nogpgcheck --repofrompath 'terra,https://repos.fyralabs.com/terra$releasever' terra-release
      sudo dnf install ghostty
      ;;
    *arch*)
      sudo pacman -S --no-confirm ghostty
      ;;
    *suse*)
      sudo zypper -y ghostty
      ;;
    *)
      echo "-> Unsupported distribution \"$DISTRO\" for installing ghostty."
      return
      ;;
    esac

    ln -s "$DOTFILES_PATH/ghostty" "$HOME/.config/ghostty"

    cd "$CWD" || exit

  fi

  rm -rf "$HOME/.config/ghostty"
  ln -s "$DOTFILES_PATH/ghostty" "$HOME/.config/ghostty"
}

install_fonts() {
  echo "-> Installing fonts..."
  mkdir -p "$HOME/.local/share/fonts"

  if [ ! -d "$DOTFILES_PATH/fonts" ]; then
    echo "-> Fonts directory not found. Skipping font installation."
    return
  fi

  find "$DOTFILES_PATH/fonts" -type f \( -name "*.ttf" -o -name "*.otf" \) -exec cp {} "$HOME/.local/share/fonts" \;

  fc-cache -f
}

install_ideavim() {
  ln -s "$DOTFILES_PATH/idea/.ideavimrc" "$HOME/.ideavimrc"
}

install_mise() {
  if ! command -v mise &>/dev/null; then
    # Install mise for managing multiple versions of languages. See https://mise.jdx.dev/
    wget -O ~/.local/bin/mise https://mise.jdx.dev/mise-latest-linux-x64
    chmod +x ~/.local/bin/mise
    tee -a "$HOME/.zshrc" <<<"eval \"\$(\$HOME/.local/bin/mise activate bash)\"" >/dev/null 2>&1
    "$HOME/.local/bin/mise" use --global node@latest
  fi
}

install_miscellaneous() {
  echo "-> Setting up bash and installing requirements..."
  if ! command -v eza &>/dev/null; then
    echo "-> Installing eza (ls alternative)..."
    cd "$DOTFILES_PATH" || exit
    wget -qO eza.tar.gz "https://github.com/eza-community/eza/releases/latest/download/eza_x86_64-unknown-linux-gnu.tar.gz"
    tar xf eza.tar.gz
    sudo install eza "$HOME/.local/bin"
    rm -rf eza eza.tar.gz
    cd "$CWD" || exit
  fi

  if ! command -v fzf &>/dev/null; then
    echo "-> Installing fzf (telescope alternative)..."
    cd "$DOTFILES_PATH" || exit
    FZFVERSION=$(wget -q "https://api.github.com/repos/junegunn/fzf/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO fzf.tar.gz "https://github.com/junegunn/fzf/releases/download/v${FZFVERSION}/fzf-${FZFVERSION}-linux_amd64.tar.gz"
    tar xf fzf.tar.gz fzf
    sudo install fzf -D -t "$HOME/.local/bin"
    rm -rf fzf.tar.gz fzf
    cd "$CWD" || exit
  fi

  if ! command -v zoxide &>/dev/null; then
    echo "-> Installing zoxide (cd alternative)..."
    cd "$DOTFILES_PATH" || exit
    wget -qO- https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh
    tee -a "$HOME/.zshrc" <<<"export PATH=\"\$PATH:\$HOME/.local/bin\"" >/dev/null 2>&1
    tee -a "$HOME/.zshrc" <<<"eval \"\$(zoxide init bash)\"" >/dev/null 2>&1
    cd "$CWD" || exit
  fi

  if ! command -v fdfind &>/dev/null; then
    echo "-> Installing fd..."
    cd "$DOTFILES_PATH" || exit
    FDVERSION=$(wget -q "https://api.github.com/repos/sharkdp/fd/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO fd.tar.gz "https://github.com/sharkdp/fd/releases/download/v${FDVERSION}/fd-v${FDVERSION}-x86_64-unknown-linux-musl.tar.gz"
    tar xf fd.tar.gz
    cp "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fd" "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fdfind"
    sudo install "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fd" -D -t "$HOME/.local/bin"
    sudo install "fd-v${FDVERSION}-x86_64-unknown-linux-musl/fdfind" -D -t "$HOME/.local/bin"
    rm -rf fd.tar.gz "fd-v${FDVERSION}-x86_64-unknown-linux-musl"
    cd "$CWD" || exit
  fi

  if ! command -v lazygit &>/dev/null; then
    echo "-> Installing lazygit..."
    cd "$DOTFILES_PATH" || exit
    LAZYGIT_VERSION=$(wget -q "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
    tar xf lazygit.tar.gz lazygit
    sudo install lazygit -D -t "$HOME/.local/bin"
    rm -rf lazygit.tar.gz lazygit
    cd "$CWD" || exit
  fi

  if ! command -v batcat &>/dev/null; then
    echo "-> Installing bat..."
    cd "$DOTFILES_PATH" || exit
    BATCATVERSION=$(wget -q "https://api.github.com/repos/sharkdp/bat/releases/latest" -O - | grep -Po '"tag_name": *"v\K[^"]*')
    wget -qO bat.tar.gz "https://github.com/sharkdp/bat/releases/download/v${BATCATVERSION}/bat-v${BATCATVERSION}-x86_64-unknown-linux-musl.tar.gz"
    tar xf bat.tar.gz
    sudo mv "bat-v${BATCATVERSION}-x86_64-unknown-linux-musl" "$HOME/.local/bin/bat"
    tee -a "$HOME/.zshrc" <<<"alias bat='$HOME/.local/bin/bat/bat'" >/dev/null 2>&1
    tee -a "$HOME/.zshrc" <<<"alias batcat='$HOME/.local/bin/bat/bat'" >/dev/null 2>&1
    rm -rf bat.tar.gz
    cd "$CWD" || exit
  fi
}

install_zsh ()
{
  if ! command -v zsh &>/dev/null; then
    case "$DISTRO" in
    *debian*)
      sudo apt-get install -y zsh
      ;;
    *fedora*)
      sudo dnf install -y zsh
      ;;
    *arch*)
      sudo pacman -S --noconfirm zsh
      ;;
    *suse*)
      sudo zypper install -y zsh
      ;;
    *rhel* | *centos*)
      sudo yum install -y zsh
      ;;
    *)
      echo "-> Unsupported distribution \"$DISTRO\" for installing zsh."
      ;;
    esac
  fi
 
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
 
  cp -f -r "$DOTFILES_PATH/zsh/.zshrc" "$HOME/.zshrc"

  exec zsh
}

update_packages

install_zsh

install_git

install_gh

clone_repository

install_fonts

install_miscellaneous

install_mise

install_ghostty

install_tmux

install_nvim

install_ideavim

echo ""
printf "\u2705Done!\n"
echo ""

