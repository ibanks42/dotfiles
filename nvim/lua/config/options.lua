-- Options are automatically loaded before lazy.nvim startup.
require("config.remote_clipboard").setup()
-- plain yank/paste syncs the system clipboard (via the OSC 52 provider)
vim.opt.clipboard = "unnamedplus"

vim.opt.listchars = { tab = "┊ ", trail = "·", nbsp = "␣" }
vim.opt.relativenumber = false
vim.g.autoformat = false
