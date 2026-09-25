-- Options are automatically loaded before lazy.nvim startup.
require("config.remote_clipboard").setup()
-- plain yank/paste syncs the system clipboard (via the OSC 52 provider)
vim.opt.clipboard = "unnamedplus"

vim.opt.listchars = { tab = "┊ ", trail = "·", nbsp = "␣" }
vim.opt.relativenumber = true
vim.g.autoformat = true
vim.g.snacks_animate = false
vim.g.lazyvim_picker = "fzf"
vim.g.ai_cmp = true
-- no wait after Esc (Ghostty sends Esc as CSI 27u; herdr forwards keys whole)
vim.opt.ttimeoutlen = 0
local opt = vim.opt
