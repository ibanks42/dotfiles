return {
  {
    'karb94/neoscroll.nvim',
    config = function()
      local neoscroll = require 'neoscroll'
      neoscroll.setup {
        hide_cursor = false,
        -- All these keys will be mapped to their corresponding default scrolling animation
        pre_hook = function()
          require('specs').show_specs()
        end,
        post_hook = function()
          require('specs').show_specs()
        end,
      }
      local keymap = {
        ['<C-u>'] = function()
          neoscroll.ctrl_u { duration = 100, easing = 'linear' }
        end,
        ['<C-d>'] = function()
          neoscroll.ctrl_d { duration = 100, easing = 'linear' }
        end,
      }

      local modes = { 'n', 'v' }
      for key, fn in pairs(keymap) do
        vim.keymap.set(modes, key, fn)
      end

      local function send_key_show_specs(key, width)
        vim.api.nvim_feedkeys(key, 'n', true)
        -- delay to allow the key to be sent
        vim.defer_fn(function()
          pcall(require('specs').show_specs, { width = width })
        end, 10)
      end

      vim.keymap.set({ 'n', 'v' }, 'H', function()
        send_key_show_specs('^', 10)
      end, { noremap = true, silent = true })
      vim.keymap.set({ 'n', 'v' }, 'L', function()
        send_key_show_specs('$', 10)
      end, { noremap = true, silent = true })
      vim.keymap.set({ 'n', 'v' }, 'b', function()
        send_key_show_specs('b', 6)
      end, { noremap = true, silent = true })
      vim.keymap.set({ 'n', 'v' }, 'w', function()
        send_key_show_specs('w', 6)
      end, { noremap = true, silent = true })

      vim.keymap.set({ 'n', 'v' }, 'h', function()
        send_key_show_specs('h', 3)
      end, { noremap = true, silent = true })
      vim.keymap.set({ 'n', 'v' }, 'j', function()
        send_key_show_specs('j', 6)
      end, { noremap = true, silent = true })
      vim.keymap.set({ 'n', 'v' }, 'k', function()
        send_key_show_specs('k', 6)
      end, { noremap = true, silent = true })
      vim.keymap.set({ 'n', 'v' }, 'l', function()
        send_key_show_specs('l', 3)
      end, { noremap = true, silent = true })
    end,
    dependencies = {
      {
        'cxwx/specs.nvim',
        config = function()
          require('specs').setup {
            show_jumps = true,
            min_jump = 30,
            popup = {
              delay_ms = 0, -- delay before popup displays
              inc_ms = 15, -- time increments used for fade/resize effects
              blend = 100, -- starting blend, between 0-100 (fully transparent), see :h winblend
              width = 10,
              winhl = 'StatusLineTerm',
              fader = require('specs').linear_fader,
              resizer = require('specs').shrink_resizer,
            },
            ignore_filetypes = {},
            ignore_buftypes = {
              nofile = true,
            },
          }
        end,
      },
    },
  },
}
