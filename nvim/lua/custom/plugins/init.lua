-- You can add your own plugins here or in other files in this directory!
--  I promise not to create any merge conflicts in this directory :)
--
-- See the kickstart.nvim README for more information
return {
  {
    'akinsho/bufferline.nvim',
    version = '*',
    dependencies = { 'nvim-tree/nvim-web-devicons', 'famiu/bufdelete.nvim' },
    config = function()
      local bufferline = require 'bufferline'
      bufferline.setup {
        options = {
          offsets = {
            {
              filetype = 'NvimTree',
              text = 'File Explorer',
              separator = true,
              text_align = 'left',
            },
          },
        },
      }

      vim.keymap.set('n', 'th', ':BufferLineCyclePrev<CR>', { silent = true, noremap = true, desc = 'Previous Buffer' })
      vim.keymap.set('n', 'tl', ':BufferLineCycleNext<CR>', { silent = true, noremap = true, desc = 'Next Buffer' })
      vim.keymap.set('n', 'td', ':Bdelete<CR>', { silent = true, noremap = true, desc = 'Close Buffer' })
    end,
  },
  {
    'kdheepak/lazygit.nvim',
    cmd = {
      'LazyGit',
      'LazyGitConfig',
      'LazyGitCurrentFile',
      'LazyGitFilter',
      'LazyGitFilterCurrentFile',
    },
    -- optional for floating window border decoration
    dependencies = {
      'nvim-lua/plenary.nvim',
    },
    -- setting the keybinding for LazyGit with 'keys' is recommended in
    -- order to load the plugin when the command is run for the first time
    keys = {
      { '<leader>lg', '<cmd>LazyGit<cr>', desc = 'LazyGit' },
    },
  },
  {
    'lewis6991/gitsigns.nvim',
    config = function()
      require('gitsigns').setup {}
    end,
  },
  {
    'stevearc/resession.nvim',
    opts = {},
    config = function()
      local resession = require 'resession'
      resession.setup {}
      vim.keymap.set('n', '<leader>ns', resession.save, { desc = 'Resessio[n] [S]ave' })
      vim.keymap.set('n', '<leader>nl', resession.load, { desc = 'Resessio[n] [L]oad' })
      vim.keymap.set('n', '<leader>nd', resession.delete, { desc = 'Resessio[n] [D]elete' })
      vim.api.nvim_create_autocmd('VimLeavePre', {
        callback = function()
          resession.save 'last'
        end,
      })
      vim.api.nvim_create_autocmd('VimEnter', {
        callback = function()
          if vim.fn.argc(-1) == 0 then
            if resession.list {} ~= nil and table.getn(resession.list {}) > 0 then
              resession.load 'last'
            end
          end
        end,
      })
    end,
  },
  {
    'EdenEast/nightfox.nvim',
    name = 'nightfox',
    config = function()
      vim.cmd 'colorscheme carbonfox'
    end,
  },
  {
    'MysticalDevil/inlay-hints.nvim',
    config = function()
      require('inlay-hints').setup {
        commands = { enable = true },
        autocmd = { enable = true },
      }
    end,
  },
  {
    'Exafunction/codeium.vim',
    config = function()
      -- Change '<C-g>' here to any keycode you like.
      vim.keymap.set('i', '<Tab>', function()
        return vim.fn['codeium#Accept']()
      end, { expr = true, silent = true })
      vim.keymap.set('i', '<C-;>', function()
        return vim.fn['codeium#CycleCompletions'](1)
      end, { expr = true, silent = true })
      vim.keymap.set('i', '<C-,>', function()
        return vim.fn['codeium#CycleCompletions'](-1)
      end, { expr = true, silent = true })
      vim.keymap.set('i', '<C-x>', function()
        return vim.fn['codeium#Clear']()
      end, { expr = true, silent = true })
    end,
  },
  {
    'karb94/neoscroll.nvim',
    event = 'WinScrolled',
    config = function()
      require('neoscroll').setup {
        -- All these keys will be mapped to their corresponding default scrolling animation
        mappings = { '<C-u>', '<C-d>', '<C-b>', '<C-f>', '<C-y>', '<C-e>', 'zt', 'zz', 'zb' },
        hide_cursor = false,         -- Hide cursor while scrolling
        stop_eof = true,             -- Stop at <EOF> when scrolling downwards
        use_local_scrolloff = false, -- Use the local scope of scrolloff instead of the global scope
        respect_scrolloff = false,   -- Stop scrolling when the cursor reaches the scrolloff margin of the file
        cursor_scrolls_alone = true, -- The cursor will keep on scrolling even if the window cannot scroll further
        easing_function = nil,       -- Default easing function
        pre_hook = nil,              -- Function to run before the scrolling animation starts
        post_hook = nil,             -- Function to run after the scrolling animation ends
      }
    end,
  },
  {
    'ahmedkhalf/project.nvim',
    config = function()
      require('project_nvim').setup {}
    end,
  },
  {
    'max397574/better-escape.nvim',
    config = function()
      require('better_escape').setup {
        timeout = vim.o.timeoutlen,
        default_mappings = true,
        mappings = {
          i = {
            j = {
              k = '<Esc>:w<CR>',
              j = '<Esc>',
            },
          },
          c = {
            j = {
              k = '<Esc>:w<CR>',
              j = '<Esc>',
            },
          },
          t = {
            j = {
              k = '<Esc>:w<CR>',
              j = '<Esc>',
            },
          },
          v = {
            j = {
              k = '<Esc>:w<CR>',
            },
          },
          s = {
            j = {
              k = '<Esc>:w<CR>',
            },
          },
        },
      }
    end,
  },
}
