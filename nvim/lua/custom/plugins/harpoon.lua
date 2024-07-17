return {
  'ThePrimeagen/harpoon',
  branch = 'harpoon2',
  dependencies = { 'nvim-lua/plenary.nvim' },
  config = function()
    local harpoon = require 'harpoon'

    -- REQUIRED
    harpoon:setup()
    -- REQUIRED

    vim.keymap.set('n', '<leader>ha', function()
      harpoon:list():add()
    end, { desc = 'Add current buffer to Harpoon list' })
    vim.keymap.set('n', '<leader>ho', function()
      harpoon.ui:toggle_quick_menu(harpoon:list())
    end, { desc = 'Toggle Harpoon list' })

    vim.keymap.set('n', '<leader>hh', function()
      harpoon:list():select(1)
    end, { desc = 'Go to 1st buffer in Harpoon list' })
    vim.keymap.set('n', '<leader>hj', function()
      harpoon:list():select(2)
    end, { desc = 'Go to 2nd buffer in Harpoon list' })
    vim.keymap.set('n', '<leader>hk', function()
      harpoon:list():select(3)
    end, { desc = 'Go to 3rd buffer in Harpoon list' })
    vim.keymap.set('n', '<leader>hl', function()
      harpoon:list():select(4)
    end, { desc = 'Go to 4th buffer in Harpoon list' })

    -- Toggle previous & next buffers stored within Harpoon list
    vim.keymap.set('n', '<leader>hp', function()
      harpoon:list():prev()
    end, { desc = 'Go to previous buffer in Harpoon list' })
    vim.keymap.set('n', '<leader>hn', function()
      harpoon:list():next()
    end, { desc = 'Go to next buffer in Harpoon list' })
  end,
}
