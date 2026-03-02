local theme_util = require("util.theme")

-- Set up autosave for theme changes
theme_util.setup_autosave()

-- Get saved theme or default to vscode
local saved_theme = theme_util.get_saved_theme()

-- Built-in colorschemes that don't need plugins
local builtin_themes = {
  blue = true,
  darkblue = true,
  default = true,
  delek = true,
  desert = true,
  elflord = true,
  evening = true,
  industry = true,
  koehler = true,
  morning = true,
  murphy = true,
  pablo = true,
  peachpuff = true,
  ron = true,
  shine = true,
  slate = true,
  torte = true,
}

-- Helper to check if theme is built-in
local function is_builtin(theme)
  return theme and builtin_themes[theme] or false
end

return {
  -- Priority loader for built-in themes - uses init + defer to ensure it runs AFTER lazyvim loads
  {
    "nvim-lua/plenary.nvim",
    lazy = false,
    priority = 1000,
    init = function()
      if saved_theme and is_builtin(saved_theme) then
        -- Defer to ensure we load after LazyVim's default colorscheme
        vim.defer_fn(function()
          vim.cmd("colorscheme " .. saved_theme)
          theme_util._startup_complete = true
        end, 10)
      end
    end,
  },

  {
    "catppuccin/nvim",
    name = "catppuccin",
    lazy = false,
    priority = 1000,
    config = function()
      require("catppuccin").setup({
        transparent_background = true,
      })
      local catppuccin_themes = {
        catppuccin = true,
        ["catppuccin-latte"] = true,
        ["catppuccin-frappe"] = true,
        ["catppuccin-macchiato"] = true,
        ["catppuccin-mocha"] = true,
      }
      if saved_theme and catppuccin_themes[saved_theme] then
        vim.cmd("colorscheme " .. saved_theme)
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "folke/tokyonight.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      require("tokyonight").setup({
        transparent = true,
      })
      local tokyo_themes = {
        tokyonight = true,
        ["tokyonight-night"] = true,
        ["tokyonight-storm"] = true,
        ["tokyonight-day"] = true,
        ["tokyonight-moon"] = true,
      }
      if saved_theme and tokyo_themes[saved_theme] then
        vim.cmd("colorscheme " .. saved_theme)
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "rakr/vim-one",
    lazy = false,
    priority = 1000,
    config = function()
      vim.g.one_allow_italics = 1
      vim.opt.background = "light"
      if saved_theme == "one" or saved_theme == "onelight" then
        vim.cmd("colorscheme one")
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "sainnhe/edge",
    lazy = false,
    priority = 1000,
    config = function()
      vim.g.edge_transparent_background = 1
      vim.g.edge_enable_italic = 1
      if saved_theme == "edge" then
        vim.cmd("colorscheme edge")
        theme_util._startup_complete = true
      end
    end,
  },

  -- VSCode with light variant
  {
    "Mofiqul/vscode.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      if saved_theme == "vscode" then
        require("vscode").setup({
          transparent = true,
          style = "dark",
        })
        vim.cmd("colorscheme vscode")
        theme_util._startup_complete = true
      elseif saved_theme == "vscode-light" then
        require("vscode").setup({
          transparent = false,
          style = "light",
        })
        vim.cmd("colorscheme vscode")
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "ellisonleao/gruvbox.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      require("gruvbox").setup({
        transparent_mode = true,
      })
      local gruvbox_themes = { gruvbox = true, ["gruvbox-light"] = true }
      if saved_theme and gruvbox_themes[saved_theme] then
        if saved_theme == "gruvbox-light" then
          vim.opt.background = "light"
        end
        vim.cmd("colorscheme gruvbox")
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "rose-pine/neovim",
    name = "rose-pine",
    lazy = false,
    priority = 1000,
    config = function()
      require("rose-pine").setup({
        disable_background = true,
      })
      local rose_themes = {
        rosepine = true,
        ["rose-pine"] = true,
        ["rose-pine-main"] = true,
        ["rose-pine-moon"] = true,
        ["rose-pine-dawn"] = true,
      }
      if saved_theme and rose_themes[saved_theme] then
        vim.cmd("colorscheme " .. saved_theme)
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "sainnhe/everforest",
    lazy = false,
    priority = 1000,
    config = function()
      vim.g.everforest_transparent_background = 1
      vim.g.everforest_enable_italic = 1
      if saved_theme == "everforest" then
        vim.cmd("colorscheme everforest")
        theme_util._startup_complete = true
      elseif saved_theme == "everforest-light" then
        vim.g.everforest_background = "hard"
        vim.opt.background = "light"
        vim.cmd("colorscheme everforest")
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "maxmx03/solarized.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      local solarized_themes = { solarized = true, ["solarized-light"] = true, ["solarized-dark"] = true }
      if saved_theme and solarized_themes[saved_theme] then
        if saved_theme == "solarized-light" then
          vim.opt.background = "light"
        else
          vim.opt.background = "dark"
        end
        vim.cmd("colorscheme solarized")
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "shaunsingh/nord.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      vim.g.nord_disable_background = true
      if saved_theme == "nord" then
        vim.cmd("colorscheme nord")
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "rebelot/kanagawa.nvim",
    lazy = false,
    priority = 1000,
    config = function()
      if saved_theme == "kanagawa" then
        vim.cmd("colorscheme kanagawa")
        theme_util._startup_complete = true
      end
    end,
  },

  {
    "Ferouk/bearded-nvim",
    lazy = false,
    priority = 1000,
    config = function()
      local bearded_themes = {
        -- Arc family
        ["bearded-arc"] = true,
        ["bearded-arc-blueberry"] = true,
        ["bearded-arc-eggplant"] = true,
        ["bearded-arc-eolstorm"] = true,
        ["bearded-arc-reversed"] = true,
        -- Aquarelle family
        ["bearded-aquarelle-cymbidium"] = true,
        ["bearded-aquarelle-hydrangea"] = true,
        ["bearded-aquarelle-lilac"] = true,
        -- Exotic family
        ["bearded-altica"] = true,
        ["bearded-earth"] = true,
        ["bearded-coffee"] = true,
        ["bearded-coffee-cream"] = true,
        ["bearded-coffee-reversed"] = true,
        ["bearded-void"] = true,
        -- Black family
        ["bearded-black-&-amethyst"] = true,
        ["bearded-black-&-amethyst-soft"] = true,
        ["bearded-black-&-diamond"] = true,
        ["bearded-black-&-diamond-soft"] = true,
        ["bearded-black-&-emerald"] = true,
        ["bearded-black-&-emerald-soft"] = true,
        ["bearded-black-&-gold"] = true,
        ["bearded-black-&-gold-soft"] = true,
        ["bearded-black-&-ruby"] = true,
        ["bearded-black-&-ruby-soft"] = true,
        -- Classics family
        ["bearded-classics-anthracite"] = true,
        ["bearded-classics-light"] = true,
        -- Feat family
        ["bearded-feat-will"] = true,
        ["bearded-feat-webdevcody"] = true,
        ["bearded-feat-gold-d-raynh"] = true,
        ["bearded-feat-gold-d-raynh-light"] = true,
        ["bearded-feat-mellejulie"] = true,
        ["bearded-feat-mellejulie-light"] = true,
        -- High Contrast family
        ["bearded-hc-ebony"] = true,
        ["bearded-hc-midnightvoid"] = true,
        ["bearded-hc-flurry"] = true,
        ["bearded-hc-wonderland-wood"] = true,
        ["bearded-hc-brewing-storm"] = true,
        ["bearded-hc-minuit"] = true,
        ["bearded-hc-chocolate-espresso"] = true,
        -- Milkshake family
        ["bearded-milkshake-vanilla"] = true,
        ["bearded-milkshake-mint"] = true,
        ["bearded-milkshake-raspberry"] = true,
        ["bearded-milkshake-mango"] = true,
        ["bearded-milkshake-blueberry"] = true,
        -- Monokai family
        ["bearded-monokai-terra"] = true,
        ["bearded-monokai-metallian"] = true,
        ["bearded-monokai-stone"] = true,
        ["bearded-monokai-black"] = true,
        ["bearded-monokai-reversed"] = true,
        -- Solarized/Ocean family
        ["bearded-oceanic"] = true,
        ["bearded-oceanic-reversed"] = true,
        ["bearded-solarized-dark"] = true,
        ["bearded-solarized-light"] = true,
        ["bearded-solarized-reversed"] = true,
        -- Stained family
        ["bearded-stained-blue"] = true,
        ["bearded-stained-purple"] = true,
        -- Surprising family
        ["bearded-surprising-eggplant"] = true,
        ["bearded-surprising-blueberry"] = true,
        ["bearded-surprising-watermelon"] = true,
        -- Other themes
        ["bearded-themanopia"] = true,
        ["bearded-vivid-purple"] = true,
        ["bearded-vivid-black"] = true,
        ["bearded-vivid-light"] = true,
      }
      if saved_theme and bearded_themes[saved_theme] then
        vim.cmd("colorscheme " .. saved_theme)
        -- Ensure theme is saved and mark startup complete
        theme_util.save_theme(saved_theme)
        theme_util._startup_complete = true
      end
    end,
  },

  -- Default to vscode if no theme saved
  {
    "Mofiqul/vscode.nvim",
    name = "vscode-default",
    lazy = false,
    priority = 999,
    config = function()
      if saved_theme == nil then
        require("vscode").setup({
          transparent = true,
          italic_comments = true,
          disable_nvimtree_bg = true,
        })
        vim.cmd("colorscheme vscode")
        theme_util.save_theme("vscode")
        theme_util._startup_complete = true
      end
    end,
  },
}
