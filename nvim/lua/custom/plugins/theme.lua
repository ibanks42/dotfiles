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
    return content
  end
  return 'light' -- Default theme
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
local function set_cursor_color(is_dark)
  -- Reset guicursor to default first
  vim.opt.guicursor = 'n-v-c:block,i-ci-ve:ver25,r-cr:hor20,o:hor50'
  vim.opt.guicursor:append 'a:blinkwait700-blinkoff400-blinkon250'

  if is_dark then
    -- White cursor for dark theme
    vim.cmd [[highlight Cursor guifg=black guibg=white]]
    vim.cmd [[highlight iCursor guifg=black guibg=white]]
    vim.cmd [[highlight vCursor guifg=black guibg=white]]
    vim.cmd [[highlight lCursor guifg=black guibg=white]]
  else
    -- Semi-transparent dark cursor for light theme
    -- Using a dark gray (#444444) instead of pure black for less harshness
    vim.cmd [[highlight Cursor guifg=white guibg=#ababab]]
    vim.cmd [[highlight iCursor guifg=white guibg=#ababab]]
    vim.cmd [[highlight vCursor guifg=white guibg=#ababab]]
    vim.cmd [[highlight lCursor guifg=white guibg=#ababab]]
  end

  vim.opt.guicursor:append 'n-v-c:block-Cursor/lCursor'
  vim.opt.guicursor:append 'i-ci:ver25-iCursor/lCursor'
  vim.opt.guicursor:append 'r-cr:hor20,o:hor50'
end

-- Function to apply theme
local function apply_theme(theme)
  if theme == 'light' then
    vim.o.background = 'light'
    vim.cmd 'colorscheme vscode'
    set_cursor_color(false)
  else
    vim.o.background = 'dark'
    vim.cmd 'colorscheme catppuccin-macchiato'
    set_cursor_color(true)
  end

  -- Force redraw to apply cursor changes
  vim.cmd 'redraw'
end

-- Make sure termguicolors is enabled
vim.opt.termguicolors = true

-- Create theme toggle command
vim.keymap.set('n', '<leader>ut', function()
  local current_theme = vim.o.background
  if current_theme == 'dark' then
    apply_theme 'light'
    write_theme_preference 'light'
  else
    apply_theme 'dark'
    write_theme_preference 'dark'
  end
end, { desc = '[T]oggle Dark/Light Mode' })

-- Set theme based on saved preference (call this after plugins are loaded)
vim.api.nvim_create_autocmd('User', {
  pattern = 'LazyDone',
  callback = function()
    local saved_theme = read_theme_preference()
    apply_theme(saved_theme)
    -- Create an autocmd to ensure cursor color persists after colorscheme changes
    vim.api.nvim_create_autocmd('ColorScheme', {
      pattern = '*',
      callback = function()
        local is_dark = (vim.o.background == 'dark')
        set_cursor_color(is_dark)
      end,
    })
  end,
})

return {
  {
    'Mofiqul/vscode.nvim',
    priority = 1000,
    config = function()
      require('vscode').setup()
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
    'rebelot/kanagawa.nvim',
    opts = {},
  },
  {
    'catppuccin/nvim',
    name = 'catppuccin',
    opts = {},
  },
}
