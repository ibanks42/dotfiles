# Set variables
$repoUrl = "https://github.com/ibanks42/dotfiles.git" # Replace with your repository URL
$tempPath = "$env:TEMP\nvim-install"
$nvimConfigPath = "$env:LOCALAPPDATA\nvim"

# Function to clone the repository
function Clone-Repository {
    Write-Host "Cloning repository from $repoUrl..."
    git clone $repoUrl $tempPath
}

# Function to copy nvim configuration
function Copy-NvimConfig {
    Write-Host "Copying nvim configuration to $nvimConfigPath..."
    if (Test-Path -Path $nvimConfigPath) {
        Remove-Item -Recurse -Force -Path $nvimConfigPath
    }
    Copy-Item -Recurse -Force -Path "$tempPath\nvim" -Destination $nvimConfigPath
}

function Copy-WeztermConfig {
    Write-Host "Copying wezterm configuration to $env:HOME\.wezterm.lua..."
    Copy-Item -Recurse -Force -Path "$tempPath\wezterm\wezterm.lua" -Destination "$env:HOME\.wezterm.lua"
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

    Write-Host "nvim configuration installed successfully."
} catch {
    Write-Error "An error occurred: $_"
} finally {
    # Cleanup
    if (Test-Path -Path $tempPath) {
        Remove-Item -Recurse -Force -Path $tempPath
    }
}
