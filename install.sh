#!/bin/bash
#
# Dotfiles Installation Script
# Interactive installer with component selection, backup support, and error handling
#

set -euo pipefail

# =============================================================================
# Constants
# =============================================================================

REPO_URL="https://github.com/ibanks42/dotfiles.git"
DOTFILES_PATH="$HOME/dotfiles"
BACKUP_DIR="$HOME/.backup"
LOCAL_BIN="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config"
TMP_DIR="/tmp/dotfiles-install-$$"

# Detect if we have a TTY for interactive input
# When piped (wget | bash), stdin is the script itself, not a terminal
if [[ -t 0 ]]; then
    HAS_TTY="true"
else
    HAS_TTY="false"
fi

# Colors (disable if not outputting to terminal)
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    NC='\033[0m' # No Color
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    CYAN=''
    BOLD=''
    NC=''
fi

# Component list (order matters for dependencies)
COMPONENTS=(
    "git:Git:install_git:true"
    "gh:GitHub CLI:install_gh:true"
    "fonts:Fonts:install_fonts:true"
    "cli:CLI Tools (fzf, eza, fd, lazygit, bat, zoxide):install_cli_tools:true"
    "mise:Mise (runtime manager):install_mise:true"
    "nvim:Neovim + config:install_nvim:true"
    "zellij:Zellij + config:install_zellij:true"
    "ghostty:Ghostty terminal:install_ghostty:false"
    "ideavim:IdeaVim config:install_ideavim:false"
    "zsh:Zsh + Oh My Zsh:install_zsh:true"
)

# Track installation results
declare -A INSTALL_RESULTS

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}${BOLD}::${NC} $1"
}

log_success() {
    echo -e "${GREEN}${BOLD}  ✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}${BOLD}  !${NC} $1"
}

log_error() {
    echo -e "${RED}${BOLD}  ✗${NC} $1"
}

log_step() {
    echo -e "${CYAN}${BOLD}==>${NC} ${BOLD}$1${NC}"
}

# Confirm prompt - returns 0 for yes, 1 for no
# Usage: confirm "Do something?" && do_it
confirm() {
    local prompt="$1"
    local default="${2:-y}"
    local reply

    if [[ "$AUTO_YES" == "true" ]] || [[ "$HAS_TTY" == "false" ]]; then
        return 0
    fi

    if [[ "$default" == "y" ]]; then
        prompt="$prompt [Y/n] "
    else
        prompt="$prompt [y/N] "
    fi

    read -rp "$(echo -e "${YELLOW}${prompt}${NC}")" reply
    reply="${reply:-$default}"

    [[ "$reply" =~ ^[Yy]$ ]]
}

# Get user choice from numbered options
# Usage: choice=$(get_choice "Prompt" "Option1" "Option2" "Option3")
get_choice() {
    local prompt="$1"
    shift
    local options=("$@")
    local choice

    # If no TTY, return default (option 2 for dotfiles = pull latest)
    if [[ "$HAS_TTY" == "false" ]] || [[ "$AUTO_YES" == "true" ]]; then
        echo "2"
        return 0
    fi

    echo -e "${YELLOW}${prompt}${NC}"
    for i in "${!options[@]}"; do
        echo "  $((i + 1)). ${options[$i]}"
    done

    while true; do
        read -rp "Choose [1-${#options[@]}]: " choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && ((choice >= 1 && choice <= ${#options[@]})); then
            echo "$choice"
            return 0
        fi
        log_error "Invalid choice. Please enter a number between 1 and ${#options[@]}"
    done
}

# Backup a config directory
# Usage: backup_config "$HOME/.config/nvim" "nvim"
backup_config() {
    local source="$1"
    local name="$2"
    local timestamp
    local backup_path

    if [[ ! -e "$source" ]]; then
        return 0
    fi

    timestamp=$(date +%Y-%m-%d_%H-%M-%S)
    backup_path="$BACKUP_DIR/$timestamp/$name"

    mkdir -p "$(dirname "$backup_path")"
    mv "$source" "$backup_path"
    log_success "Backed up $source → $backup_path"

    # Cleanup old backups (keep last 5)
    cleanup_old_backups
}

# Remove backups older than the 5 most recent
cleanup_old_backups() {
    local backup_count
    backup_count=$(find "$BACKUP_DIR" -maxdepth 1 -type d 2>/dev/null | wc -l)

    if ((backup_count > 6)); then # 6 because find includes the parent dir
        find "$BACKUP_DIR" -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null |
            sort -n |
            head -n $((backup_count - 6)) |
            cut -d' ' -f2- |
            xargs rm -rf
    fi
}

# Download latest release from GitHub
# Usage: download_github_release "owner/repo" "asset_pattern" "output_file"
download_github_release() {
    local repo="$1"
    local pattern="$2"
    local output="$3"
    local api_url="https://api.github.com/repos/$repo/releases/latest"
    local download_url

    download_url=$(wget -qO- "$api_url" | grep -Po "\"browser_download_url\": *\"[^\"]*${pattern}[^\"]*\"" | head -1 | grep -Po 'https://[^"]+')

    if [[ -z "$download_url" ]]; then
        log_error "Could not find release asset matching '$pattern' for $repo"
        return 1
    fi

    wget -qO "$output" "$download_url"
}

# Get latest version tag from GitHub
# Usage: version=$(get_github_version "owner/repo")
get_github_version() {
    local repo="$1"
    wget -qO- "https://api.github.com/repos/$repo/releases/latest" | grep -Po '"tag_name": *"v?\K[^"]*'
}

# Install package using system package manager
# Usage: pkg_install "package_name"
pkg_install() {
    local pkg="$1"

    case "$DISTRO" in
    *debian* | *ubuntu*)
        sudo apt-get install -y "$pkg"
        ;;
    *fedora*)
        sudo dnf install -y "$pkg"
        ;;
    *arch*)
        sudo pacman -S --noconfirm "$pkg"
        ;;
    *suse*)
        sudo zypper install -y "$pkg"
        ;;
    *rhel* | *centos*)
        sudo yum install -y "$pkg"
        ;;
    *)
        log_error "Unsupported distribution '$DISTRO' for installing $pkg"
        return 1
        ;;
    esac
}

# Create temp directory and setup cleanup trap
setup_temp() {
    mkdir -p "$TMP_DIR"
    trap cleanup_temp EXIT
}

cleanup_temp() {
    rm -rf "$TMP_DIR"
}

# =============================================================================
# Argument Parsing
# =============================================================================

AUTO_YES="false"
SKIP_UPDATE="false"
SELECTED_COMPONENTS=()
SHOW_HELP="false"

print_help() {
    cat <<EOF
${BOLD}Dotfiles Installation Script${NC}

${BOLD}Usage:${NC}
    ./install.sh [options] [components...]

${BOLD}Options:${NC}
    -h, --help          Show this help message
    -y, --yes           Non-interactive mode (accept all defaults)
    --skip-update       Skip system package updates

${BOLD}Components:${NC}
    git                 Git version control
    gh                  GitHub CLI
    fonts               Custom fonts (requires gh auth for private repo)
    cli                 CLI tools (fzf, eza, fd, lazygit, bat, zoxide)
    mise                Mise runtime manager
    nvim                Neovim + configuration
    zellij              Zellij terminal multiplexer + config
    ghostty             Ghostty terminal emulator
    ideavim             IdeaVim configuration
    zsh                 Zsh + Oh My Zsh

${BOLD}Examples:${NC}
    ./install.sh                    # Interactive mode
    ./install.sh --yes              # Install all defaults non-interactively
    ./install.sh nvim zellij        # Install only nvim and zellij
    ./install.sh --yes cli mise     # Install cli tools and mise non-interactively

EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
        -h | --help)
            SHOW_HELP="true"
            shift
            ;;
        -y | --yes)
            AUTO_YES="true"
            shift
            ;;
        --skip-update)
            SKIP_UPDATE="true"
            shift
            ;;
        *)
            SELECTED_COMPONENTS+=("$1")
            shift
            ;;
        esac
    done
}

# =============================================================================
# System Detection
# =============================================================================

detect_system() {
    # Detect distro
    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        source /etc/os-release
        DISTRO="${ID_LIKE:-$ID}"
    else
        DISTRO="unknown"
    fi

    # Detect architecture
    ARCH=$(uname -m)
    if [[ "$ARCH" != "x86_64" ]]; then
        log_warning "This script is optimized for x86_64. Some downloads may fail on $ARCH."
    fi

    log_info "Detected: $ID ($DISTRO) on $ARCH"
}

# =============================================================================
# Component Selection Menu
# =============================================================================

declare -A COMPONENT_ENABLED

init_component_selection() {
    # Initialize with defaults or from CLI args
    for comp_def in "${COMPONENTS[@]}"; do
        IFS=':' read -r id name func default <<<"$comp_def"

        if [[ ${#SELECTED_COMPONENTS[@]} -gt 0 ]]; then
            # User specified components on CLI
            COMPONENT_ENABLED[$id]="false"
            for selected in "${SELECTED_COMPONENTS[@]}"; do
                if [[ "$selected" == "$id" ]]; then
                    COMPONENT_ENABLED[$id]="true"
                    break
                fi
            done
        else
            # Use defaults
            COMPONENT_ENABLED[$id]="$default"
        fi
    done
}

show_component_menu() {
    # Skip menu if no TTY (piped execution)
    if [[ "$HAS_TTY" == "false" ]]; then
        log_info "No TTY detected (piped execution) - using default components"
        return 0
    fi

    if [[ "$AUTO_YES" == "true" ]] && [[ ${#SELECTED_COMPONENTS[@]} -eq 0 ]]; then
        # Auto mode with no specific components - use defaults
        return 0
    fi

    if [[ ${#SELECTED_COMPONENTS[@]} -gt 0 ]]; then
        # User specified components on CLI - skip menu
        return 0
    fi

    echo ""
    log_step "Component Selection"
    echo ""
    echo "Select components to install (enter numbers to toggle, 'a' for all, 'n' for none, 'd' for defaults, or Enter to continue):"
    echo ""

    while true; do
        local i=1
        for comp_def in "${COMPONENTS[@]}"; do
            IFS=':' read -r id name func default <<<"$comp_def"
            local status="[ ]"
            if [[ "${COMPONENT_ENABLED[$id]}" == "true" ]]; then
                status="[X]"
            fi
            echo -e "  ${GREEN}${status}${NC} $i. $name"
            ((i++))
        done

        echo ""
        read -rp "Toggle [1-${#COMPONENTS[@]}], a=all, n=none, d=defaults, Enter=continue: " input

        if [[ -z "$input" ]]; then
            break
        elif [[ "$input" == "a" ]]; then
            for comp_def in "${COMPONENTS[@]}"; do
                IFS=':' read -r id _ _ _ <<<"$comp_def"
                COMPONENT_ENABLED[$id]="true"
            done
        elif [[ "$input" == "n" ]]; then
            for comp_def in "${COMPONENTS[@]}"; do
                IFS=':' read -r id _ _ _ <<<"$comp_def"
                COMPONENT_ENABLED[$id]="false"
            done
        elif [[ "$input" == "d" ]]; then
            for comp_def in "${COMPONENTS[@]}"; do
                IFS=':' read -r id _ _ default <<<"$comp_def"
                COMPONENT_ENABLED[$id]="$default"
            done
        else
            # Toggle numbered items
            for num in $input; do
                if [[ "$num" =~ ^[0-9]+$ ]] && ((num >= 1 && num <= ${#COMPONENTS[@]})); then
                    local idx=$((num - 1))
                    IFS=':' read -r id _ _ _ <<<"${COMPONENTS[$idx]}"
                    if [[ "${COMPONENT_ENABLED[$id]}" == "true" ]]; then
                        COMPONENT_ENABLED[$id]="false"
                    else
                        COMPONENT_ENABLED[$id]="true"
                    fi
                fi
            done
        fi

        # Clear lines and redraw - need to clear prompt + components + blank line
        local lines_to_clear=$((${#COMPONENTS[@]} + 2))
        printf "\033[%dA\033[J" "$lines_to_clear"
    done
}

# =============================================================================
# Prerequisites
# =============================================================================

update_packages() {
    if [[ "$SKIP_UPDATE" == "true" ]]; then
        log_info "Skipping system package update (--skip-update)"
        return 0
    fi

    if ! confirm "Update system packages?"; then
        return 0
    fi

    log_step "Updating system packages"

    case "$DISTRO" in
    *debian* | *ubuntu*)
        sudo apt-get update && sudo apt-get upgrade -y
        ;;
    *fedora*)
        sudo dnf update -y
        ;;
    *arch*)
        sudo pacman -Syu --noconfirm
        ;;
    *suse*)
        sudo zypper update -y
        ;;
    *rhel* | *centos*)
        sudo yum update -y
        ;;
    *)
        log_warning "Unsupported distribution '$DISTRO' for package updates"
        ;;
    esac
}

# =============================================================================
# Dotfiles Repository Handling
# =============================================================================

handle_dotfiles_repo() {
    log_step "Dotfiles Repository"

    if [[ -d "$DOTFILES_PATH" ]]; then
        echo ""
        log_info "Dotfiles directory found at $DOTFILES_PATH"

        if [[ "$AUTO_YES" == "true" ]]; then
            log_info "Pulling latest changes..."
            cd "$DOTFILES_PATH"
            git pull --rebase || log_warning "Could not pull latest changes"
            git submodule update --init --recursive
            return 0
        fi

        local choice
        choice=$(get_choice "What would you like to do?" \
            "Keep existing (skip clone/pull)" \
            "Pull latest changes" \
            "Delete and re-clone (WARNING: loses local changes)")

        case "$choice" in
        1)
            log_info "Keeping existing dotfiles"
            ;;
        2)
            log_info "Pulling latest changes..."
            cd "$DOTFILES_PATH"
            git pull --rebase || log_warning "Could not pull latest changes"
            git submodule update --init --recursive
            ;;
        3)
            if confirm "Are you sure? This will delete $DOTFILES_PATH" "n"; then
                log_info "Removing and re-cloning..."
                rm -rf "$DOTFILES_PATH"
                clone_dotfiles
            else
                log_info "Cancelled. Keeping existing dotfiles."
            fi
            ;;
        esac
    else
        clone_dotfiles
    fi
}

clone_dotfiles() {
    log_info "Cloning dotfiles repository..."
    git clone -q "$REPO_URL" "$DOTFILES_PATH"

    log_info "Updating submodules..."
    cd "$DOTFILES_PATH"
    git submodule update --init --recursive
    
    log_success "Dotfiles cloned to $DOTFILES_PATH"
}

# =============================================================================
# Installation Functions
# =============================================================================

install_git() {
    log_step "Installing Git"

    if command -v git &>/dev/null; then
        log_success "Git already installed ($(git --version))"
        return 0
    fi

    pkg_install git
    log_success "Git installed"
}

install_gh() {
    log_step "Installing GitHub CLI"

    if command -v gh &>/dev/null; then
        log_success "GitHub CLI already installed ($(gh --version | head -1))"
    else
        local version
        version=$(get_github_version "cli/cli")
        
        cd "$TMP_DIR"
        wget -qO gh.tar.gz "https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_amd64.tar.gz"
        tar xf gh.tar.gz
        install "gh_${version}_linux_amd64/bin/gh" -D -t "$LOCAL_BIN"
        rm -rf gh.tar.gz "gh_${version}_linux_amd64"
        
        log_success "GitHub CLI installed"
    fi

    # Check if already authenticated
    if gh auth status &>/dev/null; then
        log_success "Already authenticated with GitHub"
    else
        if [[ "$HAS_TTY" == "false" ]]; then
            log_warning "GitHub authentication required but no TTY available"
            log_warning "Run 'gh auth login' manually after installation to access private repos"
        else
            log_info "GitHub authentication required (needed for private fonts repo)"
            echo ""
            gh auth login
        fi
    fi
}

install_fonts() {
    log_step "Installing Fonts"

    mkdir -p "$HOME/.local/share/fonts"

    if [[ ! -d "$DOTFILES_PATH/fonts" ]]; then
        log_warning "Fonts directory not found in dotfiles. Skipping."
        return 0
    fi

    local font_count
    font_count=$(find "$DOTFILES_PATH/fonts" -type f \( -name "*.ttf" -o -name "*.otf" \) | wc -l)

    if [[ "$font_count" -eq 0 ]]; then
        log_warning "No fonts found in $DOTFILES_PATH/fonts"
        return 0
    fi

    find "$DOTFILES_PATH/fonts" -type f \( -name "*.ttf" -o -name "*.otf" \) -exec cp {} "$HOME/.local/share/fonts" \;
    fc-cache -f

    log_success "Installed $font_count fonts"
}

install_cli_tools() {
    log_step "Installing CLI Tools"

    mkdir -p "$LOCAL_BIN"
    cd "$TMP_DIR"

    # eza
    if ! command -v eza &>/dev/null; then
        log_info "Installing eza..."
        wget -qO eza.tar.gz "https://github.com/eza-community/eza/releases/latest/download/eza_x86_64-unknown-linux-gnu.tar.gz"
        tar xf eza.tar.gz
        install eza "$LOCAL_BIN"
        rm -rf eza eza.tar.gz
        log_success "eza installed"
    else
        log_success "eza already installed"
    fi

    # fzf
    if ! command -v fzf &>/dev/null; then
        log_info "Installing fzf..."
        local fzf_version
        fzf_version=$(get_github_version "junegunn/fzf")
        wget -qO fzf.tar.gz "https://github.com/junegunn/fzf/releases/download/v${fzf_version}/fzf-${fzf_version}-linux_amd64.tar.gz"
        tar xf fzf.tar.gz fzf
        install fzf "$LOCAL_BIN"
        rm -rf fzf.tar.gz fzf
        log_success "fzf installed"
    else
        log_success "fzf already installed"
    fi

    # fd
    if ! command -v fd &>/dev/null && ! command -v fdfind &>/dev/null; then
        log_info "Installing fd..."
        local fd_version
        fd_version=$(get_github_version "sharkdp/fd")
        wget -qO fd.tar.gz "https://github.com/sharkdp/fd/releases/download/v${fd_version}/fd-v${fd_version}-x86_64-unknown-linux-musl.tar.gz"
        tar xf fd.tar.gz
        install "fd-v${fd_version}-x86_64-unknown-linux-musl/fd" "$LOCAL_BIN"
        ln -sf "$LOCAL_BIN/fd" "$LOCAL_BIN/fdfind"
        rm -rf fd.tar.gz "fd-v${fd_version}-x86_64-unknown-linux-musl"
        log_success "fd installed"
    else
        log_success "fd already installed"
    fi

    # lazygit
    if ! command -v lazygit &>/dev/null; then
        log_info "Installing lazygit..."
        local lazygit_version
        lazygit_version=$(get_github_version "jesseduffield/lazygit")
        wget -qO lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/download/v${lazygit_version}/lazygit_${lazygit_version}_Linux_x86_64.tar.gz"
        tar xf lazygit.tar.gz lazygit
        install lazygit "$LOCAL_BIN"
        rm -rf lazygit.tar.gz lazygit
        log_success "lazygit installed"
    else
        log_success "lazygit already installed"
    fi

    # bat
    if ! command -v bat &>/dev/null && ! command -v batcat &>/dev/null; then
        log_info "Installing bat..."
        local bat_version
        bat_version=$(get_github_version "sharkdp/bat")
        wget -qO bat.tar.gz "https://github.com/sharkdp/bat/releases/download/v${bat_version}/bat-v${bat_version}-x86_64-unknown-linux-musl.tar.gz"
        tar xf bat.tar.gz
        install "bat-v${bat_version}-x86_64-unknown-linux-musl/bat" "$LOCAL_BIN"
        rm -rf bat.tar.gz "bat-v${bat_version}-x86_64-unknown-linux-musl"
        log_success "bat installed"
    else
        log_success "bat already installed"
    fi

    # zoxide
    if ! command -v zoxide &>/dev/null; then
        log_info "Installing zoxide..."
        curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash &>/dev/null
        log_success "zoxide installed"
    else
        log_success "zoxide already installed"
    fi
}

install_mise() {
    log_step "Installing Mise"

    if command -v mise &>/dev/null; then
        log_success "Mise already installed ($(mise --version))"
        return 0
    fi

    local version
    version=$(get_github_version "jdx/mise")
    
    cd "$TMP_DIR"
    wget -qO mise "https://github.com/jdx/mise/releases/download/v${version}/mise-v${version}-linux-x64-musl"
    install mise "$LOCAL_BIN"
    chmod +x "$LOCAL_BIN/mise"
    
    log_success "Mise installed"

    if confirm "Install Node.js via mise?"; then
        "$LOCAL_BIN/mise" use --global node@latest
        log_success "Node.js installed via mise"
    fi
}

install_nvim() {
    log_step "Installing Neovim"

    mkdir -p "$LOCAL_BIN"

    # Install neovim binary
    if ! command -v nvim &>/dev/null; then
        log_info "Installing Neovim..."
        
        case "$DISTRO" in
        *debian* | *ubuntu*)
            # Try package manager first (might be old version)
            if pkg_install neovim 2>/dev/null; then
                log_success "Neovim installed via apt"
            else
                install_nvim_tarball
            fi
            ;;
        *fedora*)
            pkg_install neovim
            log_success "Neovim installed via dnf"
            ;;
        *arch*)
            pkg_install neovim
            log_success "Neovim installed via pacman"
            ;;
        *)
            install_nvim_tarball
            ;;
        esac
    else
        log_success "Neovim already installed ($(nvim --version | head -1))"
    fi

    # Setup config
    local nvim_config="$CONFIG_DIR/nvim"

    if [[ -e "$nvim_config" ]] || [[ -L "$nvim_config" ]]; then
        backup_config "$nvim_config" "nvim"
    fi

    # Also backup data/cache directories
    [[ -d "$HOME/.local/share/nvim" ]] && backup_config "$HOME/.local/share/nvim" "nvim-share"
    [[ -d "$HOME/.cache/nvim" ]] && backup_config "$HOME/.cache/nvim" "nvim-cache"

    ln -sf "$DOTFILES_PATH/nvim" "$nvim_config"
    log_success "Neovim config linked"
}

install_nvim_tarball() {
    log_info "Installing Neovim from tarball..."
    cd "$TMP_DIR"
    wget -qO nvim.tar.gz "https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz"
    tar xzf nvim.tar.gz
    
    # Install to ~/.local
    mkdir -p "$HOME/.local"
    rm -rf "$HOME/.local/nvim-linux64"
    mv nvim-linux64 "$HOME/.local/"
    
    # Symlink binary
    ln -sf "$HOME/.local/nvim-linux64/bin/nvim" "$LOCAL_BIN/nvim"
    
    log_success "Neovim installed from tarball"
}

install_zellij() {
    log_step "Installing Zellij"

    mkdir -p "$LOCAL_BIN"

    # Install zellij binary
    if ! command -v zellij &>/dev/null; then
        case "$DISTRO" in
        *debian* | *ubuntu*)
            pkg_install zellij 2>/dev/null || install_zellij_binary
            ;;
        *fedora*)
            pkg_install zellij 2>/dev/null || install_zellij_binary
            ;;
        *arch*)
            pkg_install zellij
            ;;
        *)
            install_zellij_binary
            ;;
        esac
        log_success "Zellij installed"
    else
        log_success "Zellij already installed ($(zellij --version))"
    fi

    # Setup config
    local zellij_config="$CONFIG_DIR/zellij"

    if [[ -e "$zellij_config" ]] || [[ -L "$zellij_config" ]]; then
        backup_config "$zellij_config" "zellij"
    fi

    ln -sf "$DOTFILES_PATH/zellij" "$zellij_config"
    log_success "Zellij config linked"

    # Symlink sessionizer to PATH
    ln -sf "$CONFIG_DIR/zellij/zellij-sessionizer" "$LOCAL_BIN/zellij-sessionizer"
    log_success "zellij-sessionizer added to PATH"
}

install_zellij_binary() {
    local version
    version=$(get_github_version "zellij-org/zellij")
    
    cd "$TMP_DIR"
    wget -qO zellij.tar.gz "https://github.com/zellij-org/zellij/releases/download/v${version}/zellij-x86_64-unknown-linux-musl.tar.gz"
    tar xf zellij.tar.gz
    install zellij "$LOCAL_BIN"
    rm -rf zellij.tar.gz zellij
}

install_ghostty() {
    log_step "Installing Ghostty"

    # Install ghostty binary
    if ! command -v ghostty &>/dev/null; then
        case "$DISTRO" in
        *debian* | *ubuntu*)
            log_info "Installing Ghostty via Ubuntu PPA..."
            curl -fsSL https://raw.githubusercontent.com/mkasberg/ghostty-ubuntu/HEAD/install.sh | bash
            ;;
        *fedora*)
            sudo dnf install --nogpgcheck --repofrompath 'terra,https://repos.fyralabs.com/terra$releasever' -y terra-release
            sudo dnf install -y ghostty
            ;;
        *arch*)
            pkg_install ghostty
            ;;
        *)
            log_error "Unsupported distribution '$DISTRO' for Ghostty installation"
            log_info "Please install Ghostty manually: https://ghostty.org/docs/install"
            return 1
            ;;
        esac
        log_success "Ghostty installed"
    else
        log_success "Ghostty already installed"
    fi

    # Setup config
    local ghostty_config="$CONFIG_DIR/ghostty"

    if [[ -e "$ghostty_config" ]] || [[ -L "$ghostty_config" ]]; then
        backup_config "$ghostty_config" "ghostty"
    fi

    ln -sf "$DOTFILES_PATH/ghostty" "$ghostty_config"
    log_success "Ghostty config linked"
}

install_ideavim() {
    log_step "Installing IdeaVim config"

    local ideavimrc="$HOME/.ideavimrc"

    if [[ -e "$ideavimrc" ]] || [[ -L "$ideavimrc" ]]; then
        backup_config "$ideavimrc" "ideavimrc"
    fi

    ln -sf "$DOTFILES_PATH/idea/.ideavimrc" "$ideavimrc"
    log_success "IdeaVim config linked"
}

install_zsh() {
    log_step "Installing Zsh"

    # Install zsh if needed
    if ! command -v zsh &>/dev/null; then
        pkg_install zsh
        log_success "Zsh installed"
    else
        log_success "Zsh already installed"
    fi

    # Install Oh My Zsh
    if [[ ! -d "$HOME/.oh-my-zsh" ]]; then
        log_info "Installing Oh My Zsh..."
        # Use unattended install to avoid exec zsh
        RUNZSH=no CHSH=no sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
        log_success "Oh My Zsh installed"
    else
        log_success "Oh My Zsh already installed"
    fi

    # Link zshrc
    local zshrc="$HOME/.zshrc"

    if [[ -e "$zshrc" ]] || [[ -L "$zshrc" ]]; then
        backup_config "$zshrc" "zshrc"
    fi

    ln -sf "$DOTFILES_PATH/zsh/.zshrc" "$zshrc"
    log_success "Zsh config linked"

    # Change default shell
    if [[ "$SHELL" != *"zsh"* ]]; then
        if confirm "Change default shell to zsh?"; then
            chsh -s "$(which zsh)"
            log_success "Default shell changed to zsh"
            log_info "Please log out and back in for the change to take effect"
        fi
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    parse_args "$@"

    if [[ "$SHOW_HELP" == "true" ]]; then
        print_help
        exit 0
    fi

    # Welcome banner
    echo ""
    echo -e "${BOLD}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║     ${CYAN}Dotfiles Installation Script${NC}${BOLD}       ║${NC}"
    echo -e "${BOLD}╚═══════════════════════════════════════╝${NC}"
    echo ""

    # Warn about piped execution
    if [[ "$HAS_TTY" == "false" ]]; then
        log_warning "Running in non-interactive mode (piped execution detected)"
        log_info "Using default component selection. For interactive mode, run:"
        log_info "  bash -c \"\$(wget -qO- https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh)\""
        echo ""
    fi

    # Setup
    setup_temp
    detect_system
    mkdir -p "$LOCAL_BIN" "$CONFIG_DIR"

    # Initialize component selection
    init_component_selection

    # Install prerequisites (git, gh) - always needed
    if [[ "${COMPONENT_ENABLED[git]}" == "true" ]]; then
        install_git
        INSTALL_RESULTS[git]="success"
    fi

    if [[ "${COMPONENT_ENABLED[gh]}" == "true" ]]; then
        if install_gh; then
            INSTALL_RESULTS[gh]="success"
        else
            INSTALL_RESULTS[gh]="failed"
        fi
    fi

    # Handle dotfiles repo (needs gh auth for private fonts)
    handle_dotfiles_repo

    # Update packages
    update_packages

    # Show component selection menu
    show_component_menu

    # Confirm before proceeding
    echo ""
    log_step "Components to install:"
    for comp_def in "${COMPONENTS[@]}"; do
        IFS=':' read -r id name _ _ <<<"$comp_def"
        if [[ "${COMPONENT_ENABLED[$id]}" == "true" ]]; then
            echo -e "  ${GREEN}✓${NC} $name"
        fi
    done
    echo ""

    if ! confirm "Proceed with installation?"; then
        log_info "Installation cancelled"
        exit 0
    fi

    echo ""

    # Install selected components
    for comp_def in "${COMPONENTS[@]}"; do
        IFS=':' read -r id name func _ <<<"$comp_def"

        # Skip git and gh as they're already handled
        if [[ "$id" == "git" ]] || [[ "$id" == "gh" ]]; then
            continue
        fi

        if [[ "${COMPONENT_ENABLED[$id]}" == "true" ]]; then
            if $func; then
                INSTALL_RESULTS[$id]="success"
            else
                INSTALL_RESULTS[$id]="failed"
            fi
            echo ""
        fi
    done

    # Summary
    echo ""
    echo -e "${BOLD}╔═══════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║          ${CYAN}Installation Summary${NC}${BOLD}          ║${NC}"
    echo -e "${BOLD}╚═══════════════════════════════════════╝${NC}"
    echo ""

    local success_count=0
    local fail_count=0

    for comp_def in "${COMPONENTS[@]}"; do
        IFS=':' read -r id name _ _ <<<"$comp_def"
        if [[ "${COMPONENT_ENABLED[$id]}" == "true" ]]; then
            if [[ "${INSTALL_RESULTS[$id]:-}" == "success" ]]; then
                echo -e "  ${GREEN}✓${NC} $name"
                ((success_count++))
            elif [[ "${INSTALL_RESULTS[$id]:-}" == "failed" ]]; then
                echo -e "  ${RED}✗${NC} $name"
                ((fail_count++))
            fi
        fi
    done

    echo ""
    if [[ $fail_count -eq 0 ]]; then
        echo -e "${GREEN}${BOLD}All components installed successfully!${NC}"
    else
        echo -e "${YELLOW}${BOLD}Installed $success_count components, $fail_count failed${NC}"
    fi

    if [[ -d "$BACKUP_DIR" ]]; then
        echo ""
        log_info "Backups stored in: $BACKUP_DIR"
    fi

    echo ""
    echo -e "${BOLD}Done!${NC}"
    echo ""
}

main "$@"
