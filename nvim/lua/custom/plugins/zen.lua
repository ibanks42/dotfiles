if vim.g.vscode then
  return {}
end

vim.keymap.set('n', '<leader>z', function()
  local zen = require 'zen-mode'
  zen.setup {
    window = {
      width = 90,
      options = {},
    },
  }
  zen.toggle()
end, { desc = '[Z]en Mode' })

return { 'folke/zen-mode.nvim' }
