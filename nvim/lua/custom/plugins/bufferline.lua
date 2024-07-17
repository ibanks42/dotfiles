return {
  'akinsho/bufferline.nvim',
  version = '*',
  dependencies = { 'nvim-tree/nvim-web-devicons', 'famiu/bufdelete.nvim' },
  config = function()
    local bufferline = require 'bufferline'
    bufferline.setup {
      options = {
        name_formatter = function(buf)
          function getDirectory(path)
            local dir = path:match '(.*[/\\])'
            return dir:match '([^/\\]+)[/\\]*$'
          end

          local folder = getDirectory(buf.path)
          return folder .. '/' .. buf.name
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
