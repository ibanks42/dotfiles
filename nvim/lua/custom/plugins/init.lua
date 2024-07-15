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
    'Shatur/neovim-session-manager',
    config = function()
      local session_manager = require 'session_manager'
      session_manager.setup {
        autoload_mode = require('session_manager.config').AutoloadMode.Disabled,
      }
      -- Auto save session
      vim.api.nvim_create_autocmd({ 'BufWritePre' }, {
        callback = function()
          for _, buf in ipairs(vim.api.nvim_list_bufs()) do
            -- Don't save while there's any 'nofile' buffer open.
            if vim.api.nvim_get_option_value('buftype', { buf = buf }) == 'nofile' then
              return
            end
          end
          session_manager.save_current_session()
        end,
      })
    end,
    dependencies = { 'nvim-lua/plenary.nvim' },
  },
  {
    'goolord/alpha-nvim', -- Dashboard for Neovim
    config = function()
      local alpha = require 'alpha'

      require 'alpha.term'
      local dashboard = require 'alpha.themes.dashboard'

      -- Terminal header
      -- local logo = [[
      --                                              
      --       ████ ██████           █████      ██
      --      ███████████             █████ 
      --      █████████ ███████████████████ ███   ███████████
      --     █████████  ███    █████████████ █████ ██████████████
      --    █████████ ██████████ █████████ █████ █████ ████ █████
      --  ███████████ ███    ███ █████████ █████ █████ ████ █████
      -- ██████  █████████████████████ ████ █████ █████ ████ ██████
      --
      --      ]]
      --
      local logo = {
        [[                                                                       ]],
        [[  ██████   █████                   █████   █████  ███                  ]],
        [[ ░░██████ ░░███                   ░░███   ░░███  ░░░                   ]],
        [[  ░███░███ ░███   ██████   ██████  ░███    ░███  ████  █████████████   ]],
        [[  ░███░░███░███  ███░░███ ███░░███ ░███    ░███ ░░███ ░░███░░███░░███  ]],
        [[  ░███ ░░██████ ░███████ ░███ ░███ ░░███   ███   ░███  ░███ ░███ ░███  ]],
        [[  ░███  ░░█████ ░███░░░  ░███ ░███  ░░░█████░    ░███  ░███ ░███ ░███  ]],
        [[  █████  ░░█████░░██████ ░░██████     ░░███      █████ █████░███ █████ ]],
        [[ ░░░░░    ░░░░░  ░░░░░░   ░░░░░░       ░░░      ░░░░░ ░░░░░ ░░░ ░░░░░  ]],
        [[                                                                       ]],
      }

      --[[ dashboard.section.header.val = vim.split(logo, '\n') ]]
      dashboard.section.header.val = logo

      local function button(sc, txt, keybind, keybind_opts)
        local b = dashboard.button(sc, txt, keybind, keybind_opts)
        b.opts.hl = 'AlphaButtonText'
        b.opts.hl_shortcut = 'AlphaButtonShortcut'
        return b
      end

      dashboard.section.buttons.val = {
        button('l', '   Load session', '<cmd>SessionManager load_session<CR>'),
        button('n', '   New file', '<cmd>ene <BAR> startinsert <CR>'),
        button('r', '   Recent files', "<cmd>lua require('telescope').extensions.recent_files.pick()<CR>"),
        button('f', '󰱽   Find file', '<cmd>Telescope find_files hidden=true path_display=smart<CR>'),
        button('s', '󱘣   Search files', '<cmd>Telescope live_grep path_display=smart<CR>'),
        button('u', '   Update plugins', "<cmd>lua require('lazy').sync()<CR>"),
        button('q', '󰩈   Quit Neovim', '<cmd>qa!<CR>'),
      }
      -- dashboard.section.buttons.opts = {
      --   spacing = 0,
      -- }

      -- Footer
      local function footer()
        local total_plugins = require('lazy').stats().count
        local version = vim.version()
        local nvim_version_info = '- Neovim v' .. version.major .. '.' .. version.minor .. '.' .. version.patch

        return ' ' .. total_plugins .. ' plugins ' .. nvim_version_info
      end

      dashboard.section.footer.val = footer()
      dashboard.section.footer.opts.hl = 'AlphaFooter'

      -- Layout
      -- dashboard.config.layout = {
      --   { type = 'padding', val = 2 },
      --   dashboard.section.header,
      --   { type = 'padding', val = 5 },
      --   dashboard.section.terminal,
      --   { type = 'padding', val = 5 },
      --   dashboard.section.buttons,
      --   { type = 'padding', val = 2 },
      --   dashboard.section.footer,
      -- }

      dashboard.config.opts.noautocmd = false

      alpha.setup(dashboard.opts)
    end,
    dependencies = {
      {
        'smartpde/telescope-recent-files',
        config = function()
          require('telescope').load_extension 'recent_files'
        end,
      },
    },
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
    'EdenEast/nightfox.nvim',
    name = 'nightfox',
    config = function()
      vim.cmd 'colorscheme carbonfox'
    end,
  },
  {
    'MysticalDevil/inlay-hints.nvim',
    event = { 'BufEnter' },
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
