# Set variables
$repoUrl = "https://github.com/ibanks42/dotfiles.git" # Replace with your repository URL
$tempPath = "$env:TEMP\nvim-install"
$nvimConfigPath = "$env:LOCALAPPDATA\nvim"
$weztermConfigPath = "$env:USERPROFILE"

# Function to clone the repository
function Clone-Repository {
    if (Test-Path -Path $tempPath) {
        Remove-Item -Recurse -Force -Path $tempPath
    }

    Write-Host "Cloning repository from $repoUrl..."

    git clone -q $repoUrl $tempPath
}

# Function to copy nvim configuration
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

    # Clone the repository
    Clone-Repository

    # Copy nvim configuration
    Copy-NvimConfig

    Copy-WeztermConfig

} catch {
    Write-Error "An error occurred: $_"
} finally {
    # Cleanup
    if (Test-Path -Path $tempPath) {
        # Remove-Item -Recurse -Force -Path $tempPath
    }
}
