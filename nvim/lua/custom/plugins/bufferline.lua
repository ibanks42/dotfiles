return {
  'akinsho/bufferline.nvim',
  version = '*',
  dependencies = { 'nvim-tree/nvim-web-devicons', 'famiu/bufdelete.nvim' },
  config = function()
    local bufferline = require 'bufferline'
    bufferline.setup {
      options = {
        offsets = {
          {
            filetype = 'NvimTree',
            text = 'File Explorer',
            separator = true,
            text_align = 'left',
          },
        },
      },
    }

    vim.keymap.set('n', 'th', ':BufferLineCyclePrev<CR>', { silent = true, noremap = true, desc = 'Previous Buffer' })
    vim.keymap.set('n', 'tl', ':BufferLineCycleNext<CR>', { silent = true, noremap = true, desc = 'Next Buffer' })
    vim.keymap.set('n', 'td', ':Bdelete<CR>', { silent = true, noremap = true, desc = 'Close Buffer' })
  end,
}
