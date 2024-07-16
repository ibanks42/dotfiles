return {
  'akinsho/bufferline.nvim',
  version = '*',
  dependencies = { 'nvim-tree/nvim-web-devicons', 'famiu/bufdelete.nvim' },
  config = function()
    local bufferline = require 'bufferline'
    bufferline.setup {
      options = {
        name_formatter = function(buf) -- buf contains:
          -- name                | str        | the basename of the active file
          -- path                | str        | the full path of the active file
          -- bufnr (buffer only) | int        | the number of the active buffer
          -- buffers (tabs only) | table(int) | the numbers of the buffers in the tab
          -- tabnr (tabs only)   | int        | the "handle" of the tab, can be converted to its ordinal number using: `vim.api.nvim_tabpage_get_number(buf.tabnr)`

          -- return 'folder/file'
          return '/' .. buf.name
        end,
        offsets = {
          {
            filetype = 'neo-tree',
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
