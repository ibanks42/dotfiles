if not vim.g.vscode then
  return {}
end

vim.notify = require('vscode').notify

vim.keymap.set('n', '<leader>bd', function()
  require('vscode').action('workbench.action.closeActiveEditor', {})
end, { noremap = true, silent = true })

vim.keymap.set({ 'n', 'v' }, '<leader>e', function()
  require('vscode').action('workbench.view.explorer', {})
end, { noremap = true, silent = true })

-- Function to update the status line based on mode
local function update_status_line()
  -- Function to get the mode string
  local function get_mode_string()
    local mode_map = {
      n = 'NORMAL',
      no = 'DELETE',
      i = 'INSERT',
      v = 'VISUAL',
      V = 'V-LINE',
      ['\22'] = 'V-BLOCK',
      R = 'REPLACE',
      c = 'COMMAND',
      t = 'TERMINAL',
    }
    return mode_map[vim.api.nvim_get_mode().mode] or 'UNKNOWN'
  end
  vim.opt.statusline = '%#StatusLineMode# ' .. get_mode_string() .. ' [%p%%]\t'
end

-- Update status line on mode change
vim.api.nvim_create_autocmd({ 'ModeChanged' }, {
  pattern = '*',
  callback = update_status_line,
})

-- Initial status line update
update_status_line()

return {}
