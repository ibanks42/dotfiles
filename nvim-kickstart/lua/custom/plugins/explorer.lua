local prev_buf = nil

vim.api.nvim_set_keymap('n', '<leader>e', ':lua ToggleNetrw()<CR>', { noremap = true, silent = true, desc = '[E]xplorer' })

function ToggleNetrw()
  if vim.bo.filetype == 'netrw' then
    -- If we have a previous buffer and it's still valid, go to it
    if prev_buf and vim.api.nvim_buf_is_valid(prev_buf) then
      vim.cmd('buffer ' .. prev_buf)
    else
      vim.cmd 'bd'
    end
  else
    -- Store the current buffer before opening netrw
    prev_buf = vim.api.nvim_get_current_buf()
    vim.cmd 'Explore'
  end
end

return {}
