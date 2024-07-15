#!/bin/bash

# Variables
REPO_URL="https://github.com/ibanks42/dotfiles.git" # Replace with your repository URL
TEMP_PATH="/tmp/nvim-install"
NVIM_CONFIG_PATH="$HOME/.config/nvim"

# Function to clone the repository (Unix)
clone_repository_unix() {
    echo "Cloning repository from $REPO_URL..."
    git clone "$REPO_URL" "$TEMP_PATH"
}

# Function to copy nvim configuration (Unix)
copy_nvim_config_unix() {
    echo "Copying nvim configuration to $NVIM_CONFIG_PATH..."
    if [ -d "$NVIM_CONFIG_PATH" ]; then
        rm -rf "$NVIM_CONFIG_PATH"
    fi
    cp -r "$TEMP_PATH/nvim" "$NVIM_CONFIG_PATH"
}

# Function to install nvim configuration (Windows)
install_nvim_windows() {
    powershell -Command "
    \$repoUrl = '$REPO_URL'
    \$tempPath = \"\$env:LOCALAPPDATA\\Temp\\nvim-install\"
    \$nvimConfigPath = \"\$env:LOCALAPPDATA\\nvim\"

    function Clone-Repository {
        Write-Host 'Cloning repository from \$repoUrl...'
        git clone \$repoUrl \$tempPath
    }

    function Copy-NvimConfig {
        Write-Host 'Copying nvim configuration to \$nvimConfigPath...'
        if (Test-Path -Path \$nvimConfigPath) {
            Remove-Item -Recurse -Force -Path \$nvimConfigPath
        }
        Copy-Item -Recurse -Force -Path \"\$tempPath\\nvim\" -Destination \$nvimConfigPath
    }

    try {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Write-Error 'Git is not installed. Please install Git and try again.'
            exit 1
        }

        Clone-Repository
        Copy-NvimConfig
        Write-Host 'nvim configuration installed successfully.'
    } catch {
        Write-Error \"An error occurred: \$_\"
    } finally {
        if (Test-Path -Path \$tempPath) {
            Remove-Item -Recurse -Force -Path \$tempPath
        }
    }
    "
}

# Main script
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    install_nvim_windows
else
    if ! command -v git &> /dev/null; then
        echo "Git is not installed. Please install Git and try again."
        exit 1
    fi

    # Clone the repository
    clone_repository_unix

    # Copy nvim configuration
    copy_nvim_config_unix

    # Cleanup
    rm -rf "$TEMP_PATH"

    echo "nvim configuration installed successfully."
fi
