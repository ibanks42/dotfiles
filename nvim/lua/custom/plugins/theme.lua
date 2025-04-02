-- ~/.config/nvim/lua/core/theme.lua (or wherever you keep this file)

if vim.g.vscode then
  return {}
end

-- Path to store theme preference
local theme_file = vim.fn.stdpath 'data' .. '/theme_preference.txt'

-- Function to read theme preference
local function read_theme_preference()
  local file = io.open(theme_file, 'r')
  if file then
    local content = file:read '*all'
    file:close()
    -- Trim whitespace just in case
    return content:match '^%s*(.-)%s*$' or 'light'
  end
  return 'catppuccin' -- Default theme
end

-- Function to write theme preference
local function write_theme_preference(theme)
  local file = io.open(theme_file, 'w')
  if file then
    file:write(theme)
    file:close()
  end
end

-- Function to apply theme
local function apply_theme(theme)
  if theme == 'light' then
    vim.o.background = 'light'
    -- require('carbide').apply 'light'
    vim.cmd 'colorscheme daylight'
  elseif theme == 'catppuccin' then
    vim.o.background = 'dark'
    vim.cmd 'colorscheme catppuccin-macchiato'
  elseif theme == 'vscode' then
    vim.o.background = 'dark'
    require('vscode').load 'dark'
  elseif theme == 'rose-pine' then
    vim.o.background = 'dark'
    vim.cmd 'colorscheme rose-pine'
  end

  -- Force redraw to apply cursor changes if needed
  -- vim.cmd('redraw') -- Often not strictly necessary after colorscheme change
end

-- Make sure termguicolors is enabled
vim.opt.termguicolors = true

-- Create theme toggle command
vim.keymap.set('n', '<leader>ut', function()
  local current_theme = read_theme_preference()
  if current_theme == 'light' then
    apply_theme 'catppuccin'
    write_theme_preference 'catppuccin'
  elseif current_theme == 'catppuccin' then
    apply_theme 'rose-pine'
    write_theme_preference 'rose-pine'
  elseif current_theme == 'rose-pine' then
    apply_theme 'vscode'
    write_theme_preference 'vscode'
  else
    apply_theme 'light'
    write_theme_preference 'light'
  end
end, { desc = '[T]oggle Dark/Light Mode' })

-- Set theme based on saved preference (call this after plugins are loaded)
vim.api.nvim_create_autocmd('User', {
  pattern = 'LazyDone', -- Or VimEnter if not using lazy.nvim
  callback = function()
    local saved_theme = read_theme_preference()
    apply_theme(saved_theme)
  end,
})

-- Return plugin specifications for lazy.nvim
return {
  -- NOTE: Removed 'macguirerintoul/night_owl_light.vim' entry
  {
    'catppuccin/nvim',
    priority = 1000,
    config = function()
      require('catppuccin').setup()
    end,
  },
  {
    'Mofiqul/vscode.nvim',
    priority = 1000,
    config = function()
      require('vscode').setup {}
    end,
  },
  {
    'rose-pine/neovim',
    name = 'rose-pine',
    priority = 1000,
    config = function()
      require('rose-pine').setup {}
    end,
  },
  {
    'ferdinandrau/carbide.nvim',
    priority = 1000,
    config = function(_, opts)
      require('carbide').setup(opts)
    end,
  },
  {
    'cdmill/neomodern.nvim',
    lazy = false,
    priority = 1000,
    config = function()
      require('neomodern').setup {}
    end,
  },
}
