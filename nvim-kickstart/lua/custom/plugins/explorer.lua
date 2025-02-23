if vim.g.vscode then
  return {}
end

vim.api.nvim_set_keymap('n', '<leader>e', ':lua ToggleNetrw()<CR>', { noremap = true, silent = true, desc = '[E]xplorer' })

local function is_netrw_open()
  return vim.bo.filetype == 'netrw'
end

local prev_buf = nil

function ToggleNetrw()
  if is_netrw_open() then
    -- If we have a previous buffer and it's still valid, go to it
    if prev_buf and vim.api.nvim_buf_is_valid(prev_buf) then
      vim.cmd('buffer ' .. prev_buf)
      prev_buf = nil -- Clear the stored buffer after using it
    else
      vim.cmd 'bd'
    end
  else
    -- Store the current buffer before opening netrw
    local current_buf = vim.api.nvim_get_current_buf()
    vim.cmd 'Explore'
    if not is_netrw_open() then
      -- If Explore didn't open netrw, don't set prev_buf
      return
    end
    prev_buf = current_buf
  end
end

return {}
