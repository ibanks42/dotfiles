if not vim.g.vscode then
  return {}
end

vim.notify = require('vscode').notify

vim.keymap.set('n', '<leader>bd', function()
  require('vscode').action('workbench.action.closeActiveEditor', {})
end, { noremap = true, silent = true })

return {}
