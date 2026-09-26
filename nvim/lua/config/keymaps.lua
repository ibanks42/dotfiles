-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

-- LazyVim maps insert-mode Alt+j/k to "move line and stay in insert mode".
-- Over mosh, a fast "Esc j" can arrive as Alt+j, so you never leave insert mode.
pcall(vim.keymap.del, "i", "<A-j>")
pcall(vim.keymap.del, "i", "<A-k>")
