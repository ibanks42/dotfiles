vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = 'Open diagnostic [Q]uickfix list' })
vim.keymap.set('t', '<Esc><Esc>', '<C-\\><C-n>', { desc = 'Exit terminal mode' })

vim.api.nvim_create_autocmd('TextYankPost', {
  desc = 'Highlight when yanking (copying) text',
  group = vim.api.nvim_create_augroup('kickstart-highlight-yank', { clear = true }),
  callback = function()
    vim.highlight.on_yank()
  end,
})

-- SMART-SPLITS
local wk = require 'which-key'
wk.add { { '<leader>u', group = '[U]I' } }

-- init.lua or keymaps.lua
vim.keymap.set('n', '<leader>uv', ':vsplit<CR>', { desc = '[V]ertical Split' })
vim.keymap.set('n', '<leader>uh', ':split<CR>', { desc = '[H]orizontal Split' })

vim.keymap.set('n', '<A-h>', function()
  require('smart-splits').resize_left()
end)
vim.keymap.set('n', '<A-j>', function()
  require('smart-splits').resize_down()
end)
vim.keymap.set('n', '<A-k>', function()
  require('smart-splits').resize_up()
end)
vim.keymap.set('n', '<A-l>', function()
  require('smart-splits').resize_right()
end)
-- moving between splits
vim.keymap.set('n', '<C-h>', function()
  require('smart-splits').move_cursor_left()
end)
vim.keymap.set('n', '<C-j>', function()
  require('smart-splits').move_cursor_down()
end)
vim.keymap.set('n', '<C-k>', function()
  require('smart-splits').move_cursor_up()
end)
vim.keymap.set('n', '<C-l>', function()
  require('smart-splits').move_cursor_right()
end)
vim.keymap.set('n', '<C-\\>', function()
  require('smart-splits').move_cursor_previous()
end)
-- swapping buffers between windows
vim.keymap.set('n', '<leader><leader>h', function()
  require('smart-splits').swap_buf_left()
end)
vim.keymap.set('n', '<leader><leader>j', function()
  require('smart-splits').swap_buf_down()
end)
vim.keymap.set('n', '<leader><leader>k', function()
  require('smart-splits').swap_buf_up()
end)
vim.keymap.set('n', '<leader><leader>l', function()
  require('smart-splits').swap_buf_right()
end)
-- END SMART-SPLITS

-- TELESCOPE
local builtin = require 'telescope.builtin'
vim.keymap.set('n', '<leader>sh', builtin.help_tags, { desc = '[S]earch [H]elp' })
vim.keymap.set('n', '<leader>sk', builtin.keymaps, { desc = '[S]earch [K]eymaps' })
vim.keymap.set('n', '<leader>sf', builtin.find_files, { desc = '[S]earch [F]iles' })
vim.keymap.set('n', '<leader>ss', builtin.builtin, { desc = '[S]earch [S]elect Telescope' })
vim.keymap.set('n', '<leader>sw', builtin.grep_string, { desc = '[S]earch current [W]ord' })
vim.keymap.set('n', '<leader>sg', builtin.live_grep, { desc = '[S]earch by [G]rep' })
vim.keymap.set('n', '<leader>sd', builtin.diagnostics, { desc = '[S]earch [D]iagnostics' })
vim.keymap.set('n', '<leader>sr', builtin.resume, { desc = '[S]earch [R]esume' })
vim.keymap.set('n', '<leader>s.', builtin.oldfiles, { desc = '[S]earch Recent Files ("." for repeat)' })
vim.keymap.set('n', '<leader><leader>', builtin.buffers, { desc = '[ ] Find existing buffers' })
vim.keymap.set('n', '<leader>/', function()
  builtin.current_buffer_fuzzy_find(require('telescope.themes').get_dropdown { winblend = 10, previewer = false })
end, { desc = '[/] Fuzzily search in current buffer' })
vim.keymap.set('n', '<leader>s/', function()
  builtin.live_grep { grep_open_files = true, prompt_title = 'Live Grep in Open Files' }
end, { desc = '[S]earch [/] in Open Files' })
vim.keymap.set('n', '<leader>sn', function()
  builtin.find_files { cwd = vim.fn.stdpath 'config' }
end, { desc = '[S]earch [N]eovim files' })
-- END TELESCOPE

-- SNACKS
Snacks.toggle.indent():map '<leader>ui'
-- END SNACKS

-- BUVVERS
wk.add { { '<leader>b', group = '[B]uffer List' } }
vim.keymap.set('n', '<leader>b', function()
  require('buvvers').toggle()
  require('smart-splits').move_cursor_right()
end, { desc = '[T]oggle Buffer List' })

local function add_buffer_keybindings()
  vim.keymap.set('n', 'd', function()
    local cursor_buf_handle = require('buvvers').buvvers_buf_get_buf(vim.fn.line '.')
    ---@diagnostic disable-next-line: undefined-global
    MiniBufremove.delete(cursor_buf_handle, false)
  end, {
    buffer = require('buvvers').buvvers_get_buf(),
  })
  vim.keymap.set('n', '<CR>', function()
    local cursor_buf_handle = require('buvvers').buvvers_buf_get_buf(vim.fn.line '.')
    local previous_win_handle = vim.fn.win_getid(vim.fn.winnr '#')
    ---@diagnostic disable-next-line: param-type-mismatch
    vim.api.nvim_win_set_buf(previous_win_handle, cursor_buf_handle)
    vim.api.nvim_set_current_win(previous_win_handle)
  end, {
    buffer = require('buvvers').buvvers_get_buf(),
  })
end
vim.api.nvim_create_augroup('buvvers_config', { clear = true })
vim.api.nvim_create_autocmd('User', {
  group = 'buvvers_config',
  pattern = 'BuvversBufEnabled',
  callback = add_buffer_keybindings,
})
-- END BUVVERS
