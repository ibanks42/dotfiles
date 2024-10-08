return {
  {
    'xiyaowong/transparent.nvim',
    lazy = false,
    priority = 1000,
    config = function()
      vim.o.background = 'light'
      vim.cmd.colorscheme 'catppuccin'
    end,
  },
  {
    'catppuccin/nvim',
    name = 'catppuccin',
    priority = 1000,
    config = function()
      require('catppuccin').setup {
        color_overrides = {
          latte = {
            green = '#0D9A06',
            blue = '#1e49ff',
            lavender = '#2381FF',
            peach = '#74531F',
            mauve = '#AF15FF',
          },
        },
      }
    end,
  },
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
  --   'zenbones-theme/zenbones.nvim',
  --   -- Optionally install Lush. Allows for more configuration or extending the colorscheme
  --   -- If you don't want to install lush, make sure to set g:zenbones_compat = 1
  --   -- In Vim, compat mode is turned on as Lush only works in Neovim.
  --   dependencies = 'rktjmp/lush.nvim',
  --   lazy = false,
  --   priority = 1000,
  --   config = function()
  --     vim.g.seoulbones = {
  --       lightness = 'bright',
  --     }
  --     -- vim.cmd.colorscheme 'seoulbones'
  --   end,
  -- },
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
  --   'Verf/deepwhite.nvim',
  --   lazy = false,
  --   priority = 1000,
  -- },
  -- {
  --   'folke/tokyonight.nvim',
  --   lazy = false,
  --   priority = 1000,
  --   config = function()
  --     vim.cmd.colorscheme 'tokyonight-day'
  --   end,
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
