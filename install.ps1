# Set variables
$repoUrl = "https://github.com/ibanks42/dotfiles.git"
$tempPath = "$env:TEMP\nvim-install"
$nvimConfigPath = "$env:LOCALAPPDATA\nvim"

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

    Write-Host "-> Updating fonts submodules..."
    
    # Get the submodules
    cd $tempPath
    git submodule update --init --recursive
    
    cd ($pwd).Path
}

function Copy-NvimConfig {
    if (Test-Path -Path $nvimConfigPath) {
        Remove-Item -Recurse -Force -Path $nvimConfigPath
    }

    Copy-Item -Recurse -Force -Path "$tempPath\nvim" -Destination $nvimConfigPath

    Write-Host "-> Neovim configuration installed successfully."
}

function Install-Fonts {
    Write-Host "-> Installing fonts..."

    # Create the fonts directory
    New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\Microsoft\Windows\Fonts"

    # Copy both .ttf and .otf files
    Get-ChildItem -Path "$tempPath\fonts\*" -Include *.ttf, *.otf | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination "$env:LOCALAPPDATA\Microsoft\Windows\Fonts"
    }

    Write-Host "-> Fonts installed successfully."
}

function Copy-Ideavim {
    Write-Host "-> Copying .ideavimrc"
    Copy-Item -Recurse -Force -Path "$tempPath\idea\.ideavimrc" "$env:HOME\.ideavimrc"
}

# Main script
try {
    # Check if git is installed
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Error "Git is not installed. Please install Git and try again."
        exit 1
    }

    Install-Neovim

    Get-Repository

    Copy-NvimConfig

    Copy-Ideavim

    Install-Fonts

    Write-Host "✅ Installation complete!"

} catch {
    Write-Error "An error occurred: $_"
} finally {
    # Cleanup
    if (Test-Path -Path $tempPath) {
        Remove-Item -Recurse -Force -Path $tempPath
    }
}
