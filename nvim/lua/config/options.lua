-- Options are automatically loaded before lazy.nvim startup.
require("config.remote_clipboard").setup()
-- require("config.colorcolumn").setup()

local theme_util = require("util.theme")

theme_util.setup_autosave()

local target_theme = theme_util.normalize_theme(theme_util.get_saved_theme())
  or theme_util.default_theme
local ok, resolved_theme = theme_util.apply_theme(target_theme)

if ok then
  theme_util.save_theme(resolved_theme)
end
theme_util._startup_complete = true

-- plain yank/paste syncs the system clipboard (via the OSC 52 provider)
vim.opt.clipboard = "unnamedplus"

vim.opt.listchars = { tab = "┊ ", trail = "·", nbsp = "␣" }
vim.opt.relativenumber = true
vim.g.autoformat = true
vim.g.snacks_animate = false
vim.g.lazyvim_picker = "fzf"
vim.g.ai_cmp = true
-- vim.opt.colorcolumn = "80"
vim.opt.ttimeoutlen = 0
