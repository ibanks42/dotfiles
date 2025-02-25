if vim.g.vscode then
  return {}
end

vim.keymap.set('n', '<leader>cu', vim.cmd.UndotreeToggle, { desc = '[U]ndo Tree' })

return { 'mbbill/undotree' }
