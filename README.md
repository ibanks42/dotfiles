# My dotfiles (WIP)

## Installation

#### Linux Install

<details><summary>Ubuntu Install Steps</summary>

```
sudo add-apt-repository ppa:neovim-ppa/unstable -y
sudo apt update
sudo apt install make gcc ripgrep unzip git xclip neovim zoxide fzf fortune-mod -y

LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | \grep -Po '"tag_name": *"v\K[^"]*')
curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazygit.tar.gz lazygit
sudo install lazygit -D -t /usr/local/bin/

npm install -g cowsay
```

</details>
<details><summary>Debian Install Steps</summary>

```
sudo apt update
sudo apt install make gcc ripgrep unzip git xclip curl zoxide fzf fortune-mod

# Now we install nvim
curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux64.tar.gz
sudo rm -rf /opt/nvim-linux64
sudo mkdir -p /opt/nvim-linux64
sudo chmod a+rX /opt/nvim-linux64
sudo tar -C /opt -xzf nvim-linux64.tar.gz

# make it available in /usr/local/bin, distro installs to /usr/bin
sudo ln -sf /opt/nvim-linux64/bin/nvim /usr/local/bin/

LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | \grep -Po '"tag_name": *"v\K[^"]*')
curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazygit.tar.gz lazygit
sudo install lazygit -D -t /usr/local/bin/

npm install -g cowsay
```

</details>
<details><summary>Fedora Install Steps</summary>

```
sudo dnf install -y gcc make git ripgrep fd-find unzip neovim zoxide fzf fortune-mod

sudo dnf copr enable atim/lazygit -y
sudo dnf install -y lazygit

npm install -g cowsay
```

</details>

<details><summary>Arch Install Steps</summary>

```
sudo pacman -S --noconfirm --needed gcc make git ripgrep fd unzip neovim zoxide fzf fortune-mod lazygit

npm install -g cowsay
```

</details>


### Install dotfiles

> **NOTE**
> Backup your previous configuration (if any exists)

<details><summary>Linux</summary>

```sh
bash <(curl -s https://raw.githubusercontent.com/ibanks42/dotfiles/main/install_bash.sh)
```
#### Or
```sh
wget -qO- https://raw.githubusercontent.com/ibanks42/dotfiles/main/install_bash.sh | bash
```

</details>


<details><summary>Windows</summary>
Alternatively, one can install gcc and make which don't require changing the config,
the easiest way is to use choco:

1. install [chocolatey](https://chocolatey.org/install)
either follow the instructions on the page or use winget,
run in cmd as **admin**:

```sh
winget install --id Microsoft.PowerShell --source winget

winget install --accept-source-agreements chocolatey.chocolatey
```

2. install all requirements using choco, exit previous cmd and
open a powershell as **admin**:

```sh
choco install -y neovim git ripgrep wget fd unzip gzip mingw make

Invoke-RestMethod https://raw.githubusercontent.com/ibanks42/dotfiles/main/install_win.ps1 | Invoke-Expression
```

</details>
