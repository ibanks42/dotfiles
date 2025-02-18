-- every spec file under the "plugins" directory will be loaded automatically by lazy.nvim
--
-- In your plugin files, you can:
-- * add extra plugins
-- * disable/enabled LazyVim plugins
-- * override the configuration of LazyVim plugins

if vim.g.vscode then
  return {}
end
vim.g.zig_fmt_autosave = 0

return {
  -- better escape jk to save, jj to escape
  {
    {
      "max397574/better-escape.nvim",
      config = function()
        require("better_escape").setup({
          timeout = vim.o.timeoutlen,
          default_mappings = false,
          mappings = {
            i = {
              j = {
                k = function()
                  local keys = vim.api.nvim_replace_termcodes("<Esc>:w<CR>", true, false, true)
                  vim.api.nvim_feedkeys(keys, "m", false)
                  -- vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", true)
                  -- format
                  -- vim.schedule(function()
                  --   vim.cmd.w()
                  -- end)
                end,
                j = "<Esc>",
              },
            },
          },
        })
      end,
    },
  },

  {
    "folke/snacks.nvim",
    priority = 1000,
    lazy = false,
    opts = {
      -- your configuration comes here
      -- or leave it empty to use the default settings
      -- refer to the configuration section below
      bigfile = { enabled = true },
      notifier = { enabled = true },
      quickfile = { enabled = true },
      statuscolumn = { enabled = true },
      words = { enabled = true },
      scroll = { enabled = false },
      inlay_hints = { enabled = false },
    },
  },
}
