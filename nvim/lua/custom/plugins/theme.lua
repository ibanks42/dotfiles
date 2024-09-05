return {
  {
    'rose-pine/neovim',
    name = 'rose-pine',
    lazy = false,
    priority = 1000,
  },
  {
    'Mofiqul/vscode.nvim',
    lazy = false,
    priority = 1000,
    config = function()
      vim.cmd [[colorscheme vscode]]
    end,
  },
  {
    'folke/tokyonight.nvim',
    lazy = false,
    priority = 1000,
  },
}
