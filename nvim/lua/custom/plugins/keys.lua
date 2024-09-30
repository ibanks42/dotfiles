return {
  {
    'max397574/better-escape.nvim',
    config = function()
      require('better_escape').setup {
        timeout = vim.o.timeoutlen,
        default_mappings = false,
        mappings = {
          i = {
            j = {
              k = function()
                vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'n', true)
                vim.schedule(function()
                  vim.cmd.w()
                end)
              end,
              j = '<Esc>',
            },
          },
        },
      }
    end,
  },
}
