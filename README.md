# My dotfiles (WIP)

## Installation

#### Prerequisites

<details><summary>Ubuntu/Debian</summary>

```
sudo apt update
sudo apt install make gcc ripgrep unzip xclip -y
```

</details>

<details><summary>Fedora</summary>

```
sudo dnf install -y gcc make ripgrep unzip
```

</details>

<details><summary>Arch</summary>

```
sudo pacman -S --noconfirm --needed gcc make ripgrep unzip 
```

</details>

### Install dotfiles

> **NOTE**
> Backup previous configuration (if any exists)

<details><summary>Linux</summary>

```sh
bash <(curl -s https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh)
```

#### Or

```sh
wget -qO- https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.sh | bash
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

Invoke-RestMethod https://raw.githubusercontent.com/ibanks42/dotfiles/main/install.ps1 | Invoke-Expression
```

</details>
