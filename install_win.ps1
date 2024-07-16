# Set variables
$repoUrl = "https://github.com/ibanks42/dotfiles.git"
$tempPath = "$env:TEMP\nvim-install"
$nvimConfigPath = "$env:LOCALAPPDATA\nvim"
$weztermConfigPath = "$env:USERPROFILE"

function Install-Wezterm {
    $weztermInstalled = winget list --name wezterm
    if ($weztermInstalled -like "*WezTerm*") {
	Write-Host "-> Wezterm is installed."
    } else {
	Write-Host "-> Wezterm is not installed. Installing Wezterm..."
	winget install wez.wezterm
    }
}

function Install-Neovim {
    $nvimInstalled = winget list --name neovim
    if ($nvimInstalled -like "*Neovim*") {
	Write-Host "-> Neovim is installed."
    } else {
	Write-Host "-> Neovim is not installed. Installing Neovim..."
	winget install neovim
    }
}

function Get-Repository {
    if (Test-Path -Path $tempPath) {
        Remove-Item -Recurse -Force -Path $tempPath
    }

    Write-Host "-> Cloning repository..."

    git clone -q $repoUrl $tempPath
}

function Copy-NvimConfig {
    if (Test-Path -Path $nvimConfigPath) {
        Remove-Item -Recurse -Force -Path $nvimConfigPath
    }

    Copy-Item -Recurse -Force -Path "$tempPath\nvim" -Destination $nvimConfigPath

    Write-Host "-> Neovim configuration installed successfully."
}

function Copy-WeztermConfig {
    if (Test-Path -Path "$env:HOME\.wezterm.lua") {
        Remove-Item -Recurse -Force -Path "$env:HOME\.wezterm.lua"
    }

    Copy-Item -Recurse -Force -Path "$tempPath\wezterm\*" -Destination $weztermConfigPath

    Write-Host "-> Wezterm configuration installed successfully."
}

# Main script
try {
    # Check if git is installed
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Error "Git is not installed. Please install Git and try again."
        exit 1
    }

    # Check if Wezterm is installed
    Install-Wezterm

    # Check if Neovim is installed
    Install-Neovim

    # Clone the repository
    Get-Repository

    # Copy nvim configuration
    Copy-NvimConfig

    # Copy Wezterm configuration
    Copy-WeztermConfig

    # Copilot, put a checkmark at the beginning of the string
    Write-Host "✅ Installation complete!"

} catch {
    Write-Error "An error occurred: $_"
} finally {
    # Cleanup
    if (Test-Path -Path $tempPath) {
        Remove-Item -Recurse -Force -Path $tempPath
    }
}
