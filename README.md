# My dotfiles

## Installation

### Prerequisites

The install script will automatically install most dependencies, but you need these to get started:

<details><summary>Ubuntu/Debian</summary>

```bash
sudo apt update
sudo apt install -y curl wget git
```

</details>

<details><summary>Fedora</summary>

```bash
sudo dnf install -y curl wget git
```

</details>

<details><summary>Arch</summary>

```bash
sudo pacman -S --noconfirm --needed curl wget git
```

</details>

### Install dotfiles

> **NOTE**  
> The installer will automatically backup any existing configurations to `~/.backup/`

<details><summary>Linux (Interactive)</summary>

**Recommended:** Interactive installation with component selection menu:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh)"
```

Or with wget:

```bash
bash -c "$(wget -qO- https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh)"
```

</details>

<details><summary>Linux (Non-interactive)</summary>

Install all defaults without prompts:

```bash
curl -fsSL https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh | bash
```

Or install specific components:

```bash
# Download and run with specific components
wget -qO- https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh > /tmp/install.sh
chmod +x /tmp/install.sh
/tmp/install.sh nvim zellij cli
```

</details>

<details><summary>Installation Options</summary>

The installer supports various options:

```bash
./install.sh --help              # Show all options
./install.sh --yes               # Non-interactive, install all defaults
./install.sh nvim zellij         # Install only specific components
./install.sh --skip-update       # Skip system package updates
```

**Available components:**
- `git` - Git version control
- `gh` - GitHub CLI (required for private fonts repo)
- `fonts` - Custom fonts
- `cli` - CLI tools (fzf, eza, fd, lazygit, bat, zoxide)
- `mise` - Mise runtime manager
- `nvim` - Neovim + configuration
- `zellij` - Zellij terminal multiplexer + config
- `ghostty` - Ghostty terminal emulator
- `ideavim` - IdeaVim configuration
- `zsh` - Zsh + Oh My Zsh

</details>

<details><summary>Windows</summary>

1. Install [chocolatey](https://chocolatey.org/install), either follow the instructions on the page or use winget (run in cmd as **admin**):

```powershell
winget install --id Microsoft.PowerShell --source winget
winget install --accept-source-agreements chocolatey.chocolatey
```

2. Install requirements using choco (open powershell as **admin**):

```powershell
choco install -y neovim git ripgrep wget fd unzip gzip mingw make

Invoke-RestMethod https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.ps1 | Invoke-Expression
```

</details>
