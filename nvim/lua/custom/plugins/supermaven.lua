return {
  'supermaven-inc/supermaven-nvim',
  config = function()
    require('supermaven-nvim').setup {
      keymaps = {
        accept_word = '<M-l>',
        clear_suggestion = '<M-j>',
      },
      ignore_filetypes = { cpp = true },
      color = {
        suggestion_color = vim.o.background == 'light' and '#000000' or '#ffffff',
        cterm = 244,
      },
      log_level = 'off', -- set to "off" to disable logging completely
      disable_inline_completion = false, -- disables inline completion for use with cmp
      disable_keymaps = false, -- disables built in keymaps for more manual control
    }
  end,
}
