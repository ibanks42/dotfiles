return {
  {
    'rose-pine/neovim',
    name = 'rose-pine',
    lazy = false,
    priority = 1000,
  },
  {
    'navarasu/onedark.nvim',
    lazy = false,
    priority = 1000,
    opts = {
      style = 'dark',
    },
  },
  {
    'olivercederborg/poimandres.nvim',
    lazy = false,
    priority = 1000,
    opts = {},
  },
  {
    'Mofiqul/vscode.nvim',
    lazy = false,
    priority = 1000,
  },
  {
    'scottmckendry/cyberdream.nvim',
    lazy = false,
    priority = 1000,
    opts = {},
  },
  {
    'folke/tokyonight.nvim',
    lazy = false,
    priority = 1000,
    config = function()
      vim.cmd [[colorscheme vscode]]
    end,
  },
}
