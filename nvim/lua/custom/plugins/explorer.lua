if vim.g.vscode then
  return {}
end

return {
  {
    'echasnovski/mini.nvim',
    version = false,
    config = function()
      require('mini.files').setup {
        mappings = {
          go_in_plus = '<CR>',
        },
      }

      -- init.lua or keymaps.lua
      vim.keymap.set('n', '<leader>e', function()
        require('mini.files').open(vim.api.nvim_buf_get_name(0))
      end, { desc = '[E]xplorer' })
    end,
  },
  -- {
  --   'nvim-telescope/telescope-file-browser.nvim',
  --   dependencies = { 'nvim-telescope/telescope.nvim', 'nvim-lua/plenary.nvim' },
  --   config = function()
  --     require('telescope').setup {
  --       extensions = {
  --         file_browser = {
  --           theme = 'ivy',
  --           -- disables netrw and use telescope-file-browser in its place
  --           hijack_netrw = true,
  --           initial_mode = 'normal',
  --           grouped = true,
  --         },
  --       },
  --     }
  --     -- To get telescope-file-browser loaded and working with telescope,
  --     -- you need to call load_extension, somewhere after setup function:
  --     require('telescope').load_extension 'file_browser'
  --
  --     vim.keymap.set('n', '<space>e', function()
  --       require('telescope').extensions.file_browser.file_browser {
  --         path = '%:p:h',
  --         select_buffer = true,
  --       }
  --     end, { desc = '[e]xplorer (Current File)' })
  --
  --     vim.keymap.set('n', '<space>E', function()
  --       require('telescope').extensions.file_browser.file_browser {
  --         path = '%:p:h',
  --       }
  --     end, { desc = '[E]xplorer (CWD)' })
  --   end,
  -- },
}
