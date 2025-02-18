vim.keymap.set('n', '<leader>zz', function()
  local zen = require 'zen-mode'
  zen.setup {
    window = {
      width = 90,
      options = {},
    },
  }
  zen.toggle()
end)

return {
  'folke/zen-mode.nvim',
}
