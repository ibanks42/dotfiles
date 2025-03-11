if vim.g.vscode then
  return {}
end

local wk = require 'which-key'
wk.add {
  { '<leader>n', group = '[N]otifications' },
}

vim.keymap.set('n', '<leader>i', function()
  require('snacks.toggle').option('indent', { on = false })
end, { desc = '[I]ndent' })

return {
  'folke/snacks.nvim',
  lazy = false,
  priority = 1000,
  opts = {
    dashboard = {
      sections = {
        { section = 'header' },
        { icon = ' ', title = 'Keymaps', section = 'keys', indent = 2, padding = 1 },
        { icon = ' ', title = 'Recent Files', section = 'recent_files', indent = 2, padding = 1 },
        { icon = ' ', title = 'Projects', section = 'projects', indent = 2, padding = 1 },
        { section = 'startup' },
      },
    },
    bigfile = { enabled = true },
    lazygit = { enabled = true },
    input = { enabled = true },
    notifier = { enabled = true },
    indent = { enabled = true, toggle = { enabled = true } },
    scope = { enabled = true },
    scroll = { enabled = false },
    words = { enabled = true },
    toggle = {
      map = vim.keymap.set, -- keymap.set function to use
      which_key = true, -- integrate with which-key to show enabled/disabled icons and colors
      notify = true, -- show a notification when toggling
      -- icons for enabled/disabled states
      icon = {
        enabled = ' ',
        disabled = ' ',
      },
      -- colors for enabled/disabled states
      color = {
        enabled = 'green',
        disabled = 'yellow',
      },
      wk_desc = {
        enabled = 'Disable ',
        disabled = 'Enable ',
      },
      indent = {
        enabled = 'Indent ',
        disabled = 'Disabled ',
      },
    },
  },
  keys = {
    {
      '<leader>gg',
      function()
        Snacks.lazygit()
      end,
      desc = 'Lazygit',
    },
    {
      '<leader>gG',
      function()
        local function script_path(str)
          return str:match '(.*/)'
        end

        local root = script_path(vim.fn.expand '%:p')
        local git_root = vim.fs.find('.git', { path = root, upward = true })[1]
        local ret = git_root and vim.fn.fnamemodify(git_root, ':h') or root
        Snacks.lazygit { cwd = ret }
      end,
      desc = 'Lazygit (current file)',
    },
    {
      '<leader>nh',
      function()
        if Snacks.config.picker and Snacks.config.picker.enabled then
          Snacks.picker.notifications()
        else
          Snacks.notifier.show_history()
        end
      end,
      desc = '[H]istory',
    },
    {
      '<leader>nd',
      function()
        Snacks.notifier.hide()
      end,
      desc = '[D]ismiss All Notifications',
    },
  },
}
