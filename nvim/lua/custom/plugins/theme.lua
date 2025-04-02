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

-- Function to set cursor color based on theme
local function set_cursor_color()
  -- Reset guicursor to default first
  -- vim.opt.guicursor = 'n-v-c:block,i-ci-ve:ver25,r-cr:hor20,o:hor50'
  -- vim.opt.guicursor:append 'a:blinkwait700-blinkoff400-blinkon250'
  --
  -- if vim.o.background == 'light' then
  --   -- Semi-transparent dark cursor for light theme
  --   -- Using a dark gray (#ababab) instead of pure black for less harshness
  --
  --   vim.cmd [[highlight Cursor guifg=black guibg=black]]
  --   vim.cmd [[highlight iCursor guifg=black guibg=black]]
  --   vim.cmd [[highlight vCursor guifg=black guibg=black]]
  --   vim.cmd [[highlight lCursor guifg=black guibg=black]]
  -- else
  --   --
  --   -- White cursor for dark theme
  --   vim.cmd [[highlight Cursor guifg=black guibg=white]]
  --   vim.cmd [[highlight iCursor guifg=black guibg=white]]
  --   vim.cmd [[highlight vCursor guifg=black guibg=white]]
  --   vim.cmd [[highlight lCursor guifg=black guibg=white]]
  -- end

  -- Append cursor styles using the defined highlight groups
  -- vim.opt.guicursor:append 'n-v-c:block-Cursor/lCursor'
  -- vim.opt.guicursor:append 'i-ci:ver25-iCursor/lCursor'
  -- vim.opt.guicursor:append 'r-cr:hor20-Cursor/lCursor' -- Apply to replace mode too
  -- vim.opt.guicursor:append 'o:hor50' -- Operator-pending mode
end

-- Function to apply theme
local function apply_theme(theme)
  vim.notify(theme)
  if theme == 'light' then
    vim.o.background = 'light'
    -- require('carbide').apply 'light'
    vim.cmd 'colorscheme daylight'
    set_cursor_color()
  elseif theme == 'catppuccin' then
    vim.o.background = 'dark'
    vim.cmd 'colorscheme catppuccin-macchiato'
    set_cursor_color()
    -- hi('@tag.attribute', { fg = c.Grey3.fg, bold = true })
  elseif theme == 'rose-pine' then
    vim.o.background = 'dark'
    vim.cmd 'colorscheme rose-pine'
    set_cursor_color()
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
    -- Create an autocmd to ensure cursor color persists after colorscheme changes
    vim.api.nvim_create_autocmd('ColorScheme', {
      pattern = '*',
      callback = function()
        -- Give Neovim a moment to fully apply the colorscheme before setting cursor
        vim.defer_fn(function()
          local is_dark = (vim.o.background == 'dark')
          set_cursor_color(is_dark)
        end, 50) -- 50ms delay, adjust if needed
      end,
      desc = 'Reapply custom cursor color on colorscheme change',
    })
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
