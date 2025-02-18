vim.api.nvim_set_keymap('n', '<leader>e', ':lua ToggleNetrw()<CR>', { noremap = true, silent = true, desc = '[E]xplorer' })

function ToggleNetrw()
  if vim.bo.filetype == 'netrw' then
    vim.cmd 'bd' -- Close the current buffer (Netrw)
  else
    vim.cmd 'Explore' -- Open Netrw
  end
end

return {}
