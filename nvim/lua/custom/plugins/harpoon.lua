return {
  'ThePrimeagen/harpoon',
  branch = 'harpoon2',
  commit = 'e76cb03',
  dependencies = { 'nvim-lua/plenary.nvim' },
  event = 'BufEnter',
  config = function()
    local harpoon = require 'harpoon'
    local conf = require('telescope.config').values

    -- REQUIRED
    harpoon:setup()
    -- basic telescope configuration
    local function toggle_finder(harpoon_files)
      -- if not on windows, we use telescope. Telescope bugged on me on windows so we just use harpoon list then.
      if vim.fn.has 'win32' == 1 then
        harpoon.ui:toggle_quick_menu(harpoon_files)
        return
      end

      local file_paths = {}
      for _, item in ipairs(harpoon_files.items) do
        table.insert(file_paths, item.value)
      end

      require('telescope.pickers')
          .new({}, {
            prompt_title = 'Harpoon',
            finder = require('telescope.finders').new_table {
              results = file_paths,
            },
            previewer = conf.file_previewer {},
            sorter = conf.generic_sorter {},
          })
          :find()
    end

    -- REQUIRED
    local function remove(item)
      local list = harpoon:list()
      item = item or list.config.create_list_item(list.config)
      local Extensions = require 'harpoon.extensions'
      local Logger = require 'harpoon.logger'

      local items = list.items
      if item ~= nil then
        for i = 1, list._length do
          local v = items[i]
          if list.config.equals(v, item) then
            -- this clears list somehow
            -- items[i] = nil
            table.remove(items, i)
            list._length = list._length - 1

            Logger:log('HarpoonList:remove', { item = item, index = i })

            Extensions.extensions:emit(Extensions.event_names.REMOVE, { list = list, item = item, idx = i })
            break
          end
        end
      end
    end

    vim.keymap.set('n', '<leader>ha', function()
      harpoon:list():add()
    end, { desc = 'Add current buffer to Harpoon list' })
    vim.keymap.set('n', '<leader>hd', remove, { desc = 'Delete current buffer to Harpoon list' })

    vim.keymap.set('n', '<leader>ho', function()
      toggle_finder(harpoon:list())
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
