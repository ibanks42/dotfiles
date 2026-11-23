# Installing these dotfiles (instructions for an agent)

This file tells a coding agent (Claude Code, pi, Codex, and so on) how to set up
these dotfiles on a machine. The repo has no installer script. You, the agent,
do the install by following these steps and adapting them to the machine.

Linux and macOS are the main platforms. Windows is supported for a subset of
modules; read [Windows](#windows) before you start there. Each module below
says what changes on Windows, or that it doesn't apply.

## Rules

1. **Ask before you change anything.** Show the user the list of modules below
   and ask which ones to install. Defaults are marked ✅. On Windows, show only
   the modules that apply there.
2. **Back up before you replace.** If a target path already exists and is not
   already a link to this repo, move it to
   `~/.backup/dotfiles/<YYYYMMDD-HHMMSS>/<same relative path>` first. Never
   delete user files. (Windows: `~` is `%USERPROFILE%`.)
3. **Link, don't copy.** Configs are symlinks into the repo
   (`ln -sfn <repo path> <target>`), so edits land in git. The exceptions are
   fonts (copied), `~/.bashrc.local` (created, never linked) and anything
   installed by its own installer script. Windows linking is described in
   [Windows](#windows).
4. **Detect the OS and package manager.** Don't assume Arch. Use `pacman`/`paru`,
   `dnf`, `apt` or `brew` as appropriate (`winget`, falling back to `scoop`, on
   Windows), and tell the user about any package that isn't available (see
   "Package names" below).
5. **Keep machine-specific settings out of git.** Anything that only makes sense
   on this machine (SDK paths, tools installed only here, secrets, blocks that
   installers append to `~/.bashrc`) goes in `~/.bashrc.local`, not in
   `bash/.bashrc`. On Windows the equivalent is the PowerShell profile
   (`$PROFILE`), which is not in this repo.
6. **Finish with a summary**: what you installed, what you linked, what you
   backed up, and any manual steps left for the user.

`$DOTFILES` below means the repo checkout, normally `~/dotfiles`:

```sh
git clone https://github.com/ibanks42/dotfiles.git ~/dotfiles
git -C ~/dotfiles submodule update --init --recursive   # fonts submodule
```

On Windows, install Git first (`winget install --exact --id Git.Git`), then run
the same two commands in PowerShell; `~/dotfiles` becomes
`$env:USERPROFILE\dotfiles`.

## Windows

Use PowerShell 7 (`winget install --exact --id Microsoft.PowerShell`) for the
commands below. Herdr also uses it as the default shell when it's installed.

**Packages.** Use `winget install --exact --id <Id>`. Confirm each ID with
`winget search --exact --id <Id>` first; if winget lacks a package, use scoop
and tell the user. IDs used in this file:

| Tool | winget ID |
|---|---|
| git | `Git.Git` |
| gh | `GitHub.cli` |
| jq | `jqlang.jq` |
| fzf | `junegunn.fzf` |
| fd | `sharkdp.fd` |
| bat | `sharkdp.bat` |
| eza | `eza-community.eza` |
| lazygit | `JesseDuffield.lazygit` |
| zoxide | `ajeetdsouza.zoxide` |
| ripgrep | `BurntSushi.ripgrep.MSVC` |
| neovim | `Neovim.Neovim` |
| starship | `Starship.Starship` |
| mise | `jdx.mise` |
| Python 3 | `Python.Python.3.13` (or the newest `Python.Python.3.*`) |
| zig (C compiler for Neovim treesitter) | `zig.zig` |

winget changes `PATH` only for new shells. Open a new terminal after
installing, or the tools won't be found.

**Linking.** Windows has no `ln -s` in PowerShell:

- **Directories**: use a junction. It needs no admin rights:
  `New-Item -ItemType Junction -Path <target> -Target <repo dir>`.
- **Files**: use a symbolic link,
  `New-Item -ItemType SymbolicLink -Path <target> -Target <repo file>`. This
  needs Developer Mode (Settings → System → For developers) or an elevated
  shell. Check `(Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock).AllowDevelopmentWithoutDevLicense`;
  `1` means Developer Mode is on. If it's off, ask the user to enable it.
  Don't fall back to hard links: git replaces files on checkout, which
  silently breaks them. If links can't be made, copy the file and tell the
  user it won't follow the repo.
- A target that already points at the right repo path counts as "already
  linked": check with `(Get-Item <target>).Target`.

**`~/.local/bin`.** Several modules put commands there. Create
`$env:USERPROFILE\.local\bin` and add it to the *user* `PATH`:
`[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$env:USERPROFILE\.local\bin", 'User')`
(skip if it's already listed).

**PowerShell profile (instead of bash).** Ask the user before editing
`$PROFILE` (create it if missing; back it up if it exists). Mirror what
`bash/.bashrc` does:

```powershell
$env:EDITOR = 'nvim'
Invoke-Expression (&starship init powershell)
Invoke-Expression (& { (zoxide init powershell | Out-String) })
(& mise activate pwsh) | Out-String | Invoke-Expression
```

Only add the lines whose tools are installed. Don't port the Debian-only
`fd`/`bat` aliases. Check: a new `pwsh -c 'echo ok'` prints `ok` with no errors.

**Line endings.** `.gitattributes` normalizes text, and forces `*.cmd` to
CRLF. Don't change `core.autocrlf` for this repo.

**Doesn't apply on Windows:** bash (use the profile above), Ghostty, yazi,
the bash herdr helper scripts (`herdr-sessionizer`, `herdr-space-*`,
`herdr-split`), `agy-worker`, and the Pi patch launcher. Say so in the
summary rather than skipping them silently.

## Modules

### ✅ Core and CLI tools
Packages: git, gh (GitHub CLI), curl, wget, jq, unzip, zip, tar, xz, a C
toolchain (`base-devel` / `build-essential` / `@development-tools`), fzf, eza,
fd, bat, lazygit, zoxide, ripgrep.

**Windows:** curl, tar and zip support already ship with Windows 10 and
later; wget, unzip and xz aren't needed. Install the rest from the winget
table. The C toolchain is zig (see Neovim).

### ✅ Fonts
Copy every font file in `$DOTFILES/fonts` (a git submodule) into
`~/.local/share/fonts/`, then run `fc-cache -f`. Only needed on machines that
draw text (the machine the user sits at, running Ghostty or the Herdr app), not
on a headless server.

**Windows:** install per user, which needs no admin rights. Copy each `.ttf`/`.otf` into
`$env:LOCALAPPDATA\Microsoft\Windows\Fonts` and register it:

```powershell
$dir = "$env:LOCALAPPDATA\Microsoft\Windows\Fonts"
$reg = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'
New-Item -ItemType Directory -Force $dir | Out-Null
Get-ChildItem "$env:USERPROFILE\dotfiles\fonts" -Recurse -Include *.ttf,*.otf | ForEach-Object {
  Copy-Item $_.FullName $dir -Force
  $kind = if ($_.Extension -eq '.otf') { 'OpenType' } else { 'TrueType' }
  Set-ItemProperty $reg -Name "$($_.BaseName) ($kind)" -Value (Join-Path $dir $_.Name)
}
```

Apps that are already open must be restarted to see the fonts.

### ✅ bash (main shell)
Packages: bash, starship, fzf, gawk (fzf-tab-completion prefers it).

| Source | Target |
|---|---|
| `$DOTFILES/bash/.bashrc` | `~/.bashrc` (aliases, key bindings, starship, zoxide, mise, fzf tab completion) |
| `$DOTFILES/bash/starship.toml` | `~/.config/starship.toml` |

`bash/fzf-bash-completion.sh` is a vendored copy of
[lincheney/fzf-tab-completion](https://github.com/lincheney/fzf-tab-completion)'s
bash script. `.bashrc` sources it from the repo (it follows its own symlink),
so it needs no link of its own.

Then:
- Make sure `~/.bash_profile` sources `~/.bashrc` (create it with
  `[ -f ~/.bashrc ] && . ~/.bashrc` if missing), so login shells get the config.
- Create `~/.bashrc.local` if it doesn't exist, with a one-line comment header.
  If the old `~/.bashrc` had machine-specific lines (PATHs, SDKs, installer
  blocks), move them into `~/.bashrc.local` and show the user what you moved.
- If the login shell isn't bash, ask before running `chsh -s "$(command -v bash)"`.
- Install [flyline](https://github.com/HalFrgrd/flyline), the readline
  replacement `.bashrc` loads from `~/.local/lib/libflyline.so` (Linux only;
  `.bashrc` skips it where it's missing). Do this after linking `~/.bashrc`:

  ```sh
  source <(curl -sSfL https://github.com/HalFrgrd/flyline/releases/latest/download/install.sh)
  git -C "$DOTFILES" checkout -- bash/.bashrc
  ```

  The installer appends its own `enable flyline` line to `~/.bashrc`, which is
  the repo file through the link. `.bashrc` already loads flyline, so the
  `checkout` throws that line away. Don't move it to `~/.bashrc.local` either.
- Check: `bash -ic 'echo ok'` prints `ok` with no errors.

**Windows:** skip bash. Do link the starship config (a file
symlink) at `$env:USERPROFILE\.config\starship.toml`, which is where starship
looks on Windows. Then set up the PowerShell profile from [Windows](#windows).

### ✅ Neovim
Packages: neovim (recent; the config is LazyVim). Link `$DOTFILES/nvim` →
`~/.config/nvim`. Back up `~/.local/share/nvim` and `~/.cache/nvim` if they
exist, so plugins install clean.

**Windows:** junction `$DOTFILES\nvim` → `$env:LOCALAPPDATA\nvim`. Back up
`$env:LOCALAPPDATA\nvim-data` if it exists. The config uses the `main`
branch of nvim-treesitter, which compiles parsers. That needs a C compiler
(`zig.zig`) and the `tree-sitter` CLI on `PATH`. Install the CLI with
`mise use --global tree-sitter@latest`, or `cargo install tree-sitter-cli` if
mise can't. Then run `nvim --headless "+Lazy! sync" +qa` and report any errors.
`lua/config/remote_clipboard.lua` only matters over SSH and needs nothing on
Windows.

### ✅ Ghostty
Packages: ghostty. Link `$DOTFILES/ghostty` → `~/.config/ghostty`.
**Only on the machine the user sits at.** Ghostty runs locally; its config on a
remote server does nothing. The config sends Esc as `CSI 27u`
(`keybind = escape=csi:27u`); herdr already handles that.

**Windows:** doesn't apply (Ghostty has no Windows build). Terminals there
run in the Herdr app or Windows Terminal.

### ✅ Herdr app (desktop GUI from herdr.dev)
Herdr's desktop app, from https://herdr.dev/download. It also installs
herdr-core if it's missing, and updates itself after that. Not the
`herdr-gpui` project on GitHub; that's a different app.

- Linux/macOS: `curl -fsSL https://releases.herdr.dev/app/install.sh | sh`
- Windows: `powershell -c "irm https://releases.herdr.dev/app/install.ps1 | iex"`
  (x64 only). It puts `herdr-app` on the user `PATH` and adds Herdr to the
  Start menu, so open a new terminal afterwards.

The app keeps its settings in its own folder (`~/.config/herdr-app`, or
`$HERDR_APP_HOME`); `appHome()` in its `herdr.d.ts` is authoritative. This
repo doesn't link that folder. Its `AGENTS.md` describes the app for agents.

Then install the **GUI sessionizer** mod (fuzzy project/Space picker, works
on Linux, macOS and Windows; needs Python 3 and Git):

```sh
python3 $DOTFILES/herdr/gui-sessionizer/install.py   # Windows: py -3 $DOTFILES\herdr\gui-sessionizer\install.py
```

It copies the mod into `<app folder>/mods/sessionizer/` (copied, not linked;
rerun after editing the source), keeps an existing `config.json`, and runs
`herdr-app check`. Open it with `herdr-app do mod.open --name sessionizer`,
or bind `mod.open:sessionizer`. Its search roots and startup tabs are edited
in the dialog's Settings. See `herdr/gui-sessionizer/README.md`.

### ✅ herdr (terminal workspace manager, TUI)
Install herdr from https://herdr.dev (see its install page). Link each file
individually, because `~/.config/herdr` also holds live server state and must
stay a real directory:

| Source | Target |
|---|---|
| `$DOTFILES/herdr/config.toml` | `~/.config/herdr/config.toml` |
| `$DOTFILES/herdr/herdr-sessionizer.conf` | `~/.config/herdr/herdr-sessionizer.conf` |
| `$DOTFILES/herdr/herdr-sessionizer` | `~/.local/bin/herdr-sessionizer` |
| `$DOTFILES/herdr/herdr-space-numbers` | `~/.local/bin/herdr-space-numbers` |
| `$DOTFILES/herdr/herdr-space-jumper` | `~/.local/bin/herdr-space-jumper` |
| `$DOTFILES/herdr/herdr-split` | `~/.local/bin/herdr-split` |

Install the plugins used by the Neovim and lazygit keybindings (review their
source before approving installation; plugins run commands as your user):

```sh
herdr plugin install ChmaraX/herdr-nvim
herdr plugin install JacquesvanWyk/herdr-lazygit
```

Ensure `nvim` and `lazygit` are on `PATH`. The Neovim config already includes
`ChmaraX/herdr-nvim` for the editor-side integration. Verify registration with
`herdr plugin action list`: expect `chmarax.herdr-nvim.toggle`,
`chmarax.herdr-nvim.pick-file`, `herdr-lazygit.open-lazygit`, and
`herdr-lazygit.open-lazygit-tab`. Keybindings alone do not install plugins.

The herdr-scope plugin writes absolute home paths into `config.toml`, so the
repo stores them as `$HOME/` through a git clean filter. Git doesn't copy
filter settings when you clone, so run this once in every clone:

```sh
git -C "$DOTFILES" config filter.homepath.clean 'sed -e "s#$HOME/#\$HOME/#g"'
```

Check with `herdr config check`. If a herdr server is running, apply with
`herdr server reload-config`.

**Windows:** off by default; ask the user, since the Herdr app above covers
the same ground. The TUI runs natively
(`powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"`)
and reads `%APPDATA%\herdr\config.toml`, but this repo's `config.toml` is
Linux-specific: its `[[keys.command]]` entries call the bash helpers above,
and its tab bar runs `cat` on a `$HOME/...` path through a POSIX shell. Don't link it as-is.
Don't install the bash helpers on Windows. Plugins are preview on Windows, so
install the two above only if the user asks.

### ✅ yazi
Packages: yazi. Link `$DOTFILES/yazi` → `~/.config/yazi`. Plugins listed in
`yazi/package.toml` install with `ya pkg install` (`yazi/plugins/` is ignored
by git).

**Windows:** doesn't apply.

### ✅ mise (language runtimes)
Install with `curl https://mise.run | sh` (puts `mise` in `~/.local/bin`) or the
package manager. Ask which runtimes to install globally; defaults are node, go
and bun. Optional: python, rust, zig, java. For each one:
`mise use --global <name>@latest`.

**Windows:** `winget install --exact --id jdx.mise`, then activate it in the
PowerShell profile (see [Windows](#windows)). Its shims live in
`$env:LOCALAPPDATA\mise\shims`. Same runtime defaults. Prefer the winget
Python over mise's on Windows, because the GUI sessionizer and other tools
look for `python`/`py`.

### Pi with Bun
If you install the Pi configuration, link `$DOTFILES/bin/bun-as-npm` to `~/.local/bin/bun-as-npm`.
Install Bun and add `~/.local/bin` to `PATH` before you run `pi update --extensions`.
The wrapper keeps Pi packages in `~/.pi/agent/npm/`. See `.pi/README.md` for the Pi setup steps.

**Windows:**
- Junction `$DOTFILES\.pi` → `$env:USERPROFILE\.pi`.
- Create `$env:USERPROFILE\.pi\agent\sessions` (there's no `chmod 700`; the
  user profile is already private).
- Symlink both `bin\bun-as-npm` and `bin\bun-as-npm.cmd` into
  `$env:USERPROFILE\.local\bin`. They must sit in the same folder: the `.cmd`
  runs the script next to it with Bun.
- The patch launcher (`.pi/agent/patches/pi`) doesn't support Windows: its
  runner uses Unix file locking. Skip it, and tell the user that the patches
  in `.pi/agent/patches/manifest.json` won't be reapplied after
  `pi update`.
- Check with `bun-as-npm root -g`, which prints Bun's global `node_modules`
  path. Optionally run `bun test ./bin/bun-as-npm.test.mjs` from `$DOTFILES`.

### Antigravity (`agy`)
Link `$DOTFILES/.gemini/config` to `~/.gemini/config` (keeping `~/.gemini` as a real directory so `~/.gemini/antigravity-cli` stays machine-local) and link `$DOTFILES/bin/agy-worker` to `~/.local/bin/agy-worker`.

**Windows:** junction `$DOTFILES\.gemini\config` →
`$env:USERPROFILE\.gemini\config`. Skip `agy-worker`: it's a bash script.

### Apps (off by default)
- Bitwarden: rbw, bitwarden-cli
- Vivaldi (+ ffmpeg codecs), Steam (on Arch, needs `multilib`), Spotify, Dolphin

**Windows:** winget has `Bitwarden.Bitwarden`, `Bitwarden.CLI`,
`Vivaldi.Vivaldi`, `Valve.Steam` and `Spotify.Spotify`. rbw and Dolphin
don't apply.

### Not linked automatically
`zed/` and `vscode/` (a Modest Dark theme) exist but are not linked on the
current machines. Ask the user before linking them.

- Zed: link `zed/settings.json` and `zed/keymap.json` into `~/.config/zed/`,
  and `zed/themes` to `~/.config/zed/themes`. Windows: `$env:APPDATA\Zed\`.
- VS Code theme: link the `vscode/modest-dark` folder to
  `~/.vscode/extensions/modest-dark` (Windows:
  `$env:USERPROFILE\.vscode\extensions\modest-dark`, a junction), then
  restart VS Code and pick the theme.

## Package names
- Debian/Ubuntu: `fd` is `fd-find` (binary `fdfind`), `bat` is binary `batcat`.
  `bash/.bashrc` aliases `fd=fdfind` and `bat=batcat` only when `fd`/`bat`
  aren't on `PATH`, so other distros are unaffected.
- eza, lazygit, starship, ghostty, yazi and a recent neovim may be missing or
  old in apt/dnf repos. Use the upstream install method (release binary,
  COPR, cargo, or the project's install script) and say which you used.
- Windows: see the winget table in [Windows](#windows).

## Known quirks
- **mosh** drops cursor-shape codes, so the vi-mode cursor shape (line/block)
  doesn't change over mosh. The prompt ❯ colour shows the mode instead.
- **Esc** is sent as `CSI 27u` by Ghostty. Programs outside herdr that don't
  understand the kitty keyboard protocol may show `[27u` when Esc is pressed.
- **Windows `python3`** may be the Microsoft Store placeholder, which only
  opens the Store. Use `py -3` or `python` from the winget install. The GUI
  sessionizer already falls back to them.
