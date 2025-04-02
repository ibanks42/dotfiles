return {
  'aidancz/buvvers.nvim',
  dependencies = { { 'echasnovski/mini.bufremove', version = false, opts = {} } },
  config = function()
    require('buvvers').setup {}
  end,
}
