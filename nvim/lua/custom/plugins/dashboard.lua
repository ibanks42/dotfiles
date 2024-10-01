return {
  'goolord/alpha-nvim', -- Dashboard for Neovim
  config = function()
    local alpha = require 'alpha'

    require 'alpha.term'
    local dashboard = require 'alpha.themes.dashboard'

    dashboard.section.header.val = {
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

    local function button(sc, txt, keybind, keybind_opts)
      local b = dashboard.button(sc, txt, keybind, keybind_opts)
      b.opts.hl = 'AlphaButtonText'
      b.opts.hl_shortcut = 'AlphaButtonShortcut'
      return b
    end

    dashboard.section.buttons.val = {
      button('l', '   Load session', '<cmd>SessionManager load_session<CR>'),
      button('o', '   Session Manager', '<cmd>SessionManager<CR>'),
      button('n', '   New file', '<cmd>ene <BAR> startinsert <CR>'),
      button('r', '   Recent files', "<cmd>lua require('telescope').extensions.recent_files.pick()<CR>"),
      button('f', '󰱽   Find file', '<cmd>Telescope find_files hidden=true path_display=smart<CR>'),
      button('s', '󱘣   Search files', '<cmd>Telescope live_grep path_display=smart<CR>'),
      button('u', '   Update plugins', "<cmd>lua require('lazy').sync()<CR>"),
      button('m', '󰏖   Manage plugins', '<cmd>Lazy<CR>'),
      button('q', '󰩈   Quit Neovim', '<cmd>qa!<CR>'),
    }

    -- Footer
    local function footer()
      local total_plugins = require('lazy').stats().count
      local version = vim.version()
      local nvim_version_info = '- Neovim v' .. version.major .. '.' .. version.minor .. '.' .. version.patch

      return ' ' .. total_plugins .. ' plugins ' .. nvim_version_info
    end

    dashboard.section.footer.val = footer()
    dashboard.section.footer.opts.hl = 'AlphaFooter'
    dashboard.config.opts.noautocmd = false

    alpha.setup(dashboard.opts)
  end,
}
