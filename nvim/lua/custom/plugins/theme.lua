return {
  {
    'xiyaowong/transparent.nvim',
    lazy = false,
    priority = 1000,
    config = function()
      -- vim.o.background = 'light'
      -- vim.cmd.colorscheme 'catppuccin'
      -- vim.cmd 'TransparentEnable'
      vim.o.background = 'dark'
      vim.cmd.colorscheme 'kanagawa-dragon'
    end,
  },
  -- {
  --   'catppuccin/nvim',
  --   name = 'catppuccin',
  --   priority = 1000,
  --   config = function()
  --     require('catppuccin').setup {
  --       flavour = 'latte',
  --       term_colors = true,
  --       color_overrides = {
  --         latte = {
  --           green = '#0D9A06',
  --           blue = '#1e49ff',
  --           lavender = '#2381FF',
  --           peach = '#74531F',
  --           mauve = '#AF15FF',
  --           base = '#DEE2EE',
  --         },
  --       },
  --     }
  --   end,
  -- },
  -- {
  --   'Mofiqul/vscode.nvim',
  --   lazy = false,
  --   priority = 1000,
  --   config = function()
  --     require('vscode').setup {
  --       italic_comments = true,
  --     }
  --   end,
  -- },
  -- {
  --   'pineapplegiant/spaceduck',
  --   lazy = false,
  --   priority = 1000,
  -- },
  {
    'rebelot/kanagawa.nvim',
    lazy = false,
    priority = 1000,
    opts = {
      transparent = true,
      theme = 'dragon',
    },
  },
  -- {
  --   'scottmckendry/cyberdream.nvim',
  --   lazy = false,
  --   priority = 1000,
  --   config = function()
  --     vim.cmd.colorscheme 'cyberdream'
  --     require('cyberdream').setup {
  --       theme = {
  --         variant = 'light',
  --       },
  --     }
  --   end,
  -- },
  -- {
  --   'folke/tokyonight.nvim',
  --   lazy = false,
  --   priority = 1000,
  -- },
  -- {
  --   'rose-pine/neovim',
  --   lazy = false,
  --   priority = 1000,
  -- },
  -- {
  --   'neanias/everforest-nvim',
  --   version = false,
  --   lazy = false,
  --   priority = 1000,
  --   config = function()
  --     require('everforest').setup {
  --       background = 'hard',
  --       comment_style = 'italic',
  --       transparent_background_level = 2,
  --     }
  --     vim.cmd.colorscheme 'everforest'
  --   end,
  -- },
}
