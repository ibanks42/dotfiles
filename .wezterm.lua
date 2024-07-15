local wezterm = require("wezterm")
local act = wezterm.action

local config = wezterm.config_builder()

config.font = wezterm.font("CaskaydiaCove Nerd Font Mono")
config.font_size = 13
config.color_scheme = "rose-pine"

if wezterm.target_triple == "x86_64-pc-windows-msvc" then
  config.default_prog = {
    "pwsh.exe",
  }
end

config.enable_scroll_bar = true

-- fix for ctrl modifiers on windows
config.keys = {
  {
    key = " ",
    mods = "CTRL",
    action = act.SendKey({
      key = " ",
      mods = "CTRL",
    }),
  },
  {
    key = "v",
    mods = "CTRL",
    action = act.PasteFrom("Clipboard"),
  },
  {
    key = "c",
    mods = "CTRL",
    action = act.CopyTo("Clipboard"),
  },
  {
    key = "[",
    mods = "ALT",
    action = act.ActivateTabRelative(-1),
  },
  {
    key = "]",
    mods = "ALT",
    action = act.ActivateTabRelative(1),
  },
}

for i = 1, 9 do
  config.keys[#config.keys + 1] = {
    key = tostring(i),
    mods = "ALT",
    action = act.ActivateTab(i - 1),
  }
end

return config
