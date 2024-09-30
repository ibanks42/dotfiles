local builder = vim.fn.has 'win32' == 1 and 'pwsh -ExecutionPolicy Bypass -File build.ps1 -BuildFromSource false' or
'make'

return {
  'yetone/avante.nvim',
  event = 'VeryLazy',
  --  build 'make' for linux/mac, 'pwsh -ExecutionPolicy Bypass -File build.ps1 -BuildFromSource false' for windows
  build = builder,
  opts = {},
  keys = {
    {
      '<leader>aa',
      function()
        require('avante.api').ask()
      end,
      desc = 'avante: ask',
      mode = { 'n', 'v' },
    },
    {
      '<leader>ar',
      function()
        require('avante.api').refresh()
      end,
      desc = 'avante: refresh',
    },
    {
      '<leader>ae',
      function()
        require('avante.api').edit()
      end,
      desc = 'avante: edit',
      mode = 'v',
    },
  },
  dependencies = {
    'stevearc/dressing.nvim',
    'nvim-lua/plenary.nvim',
    'MunifTanjim/nui.nvim',
    --- The below dependencies are optional,
    'nvim-tree/nvim-web-devicons', -- or echasnovski/mini.icons
    {
      -- support for image pasting
      'HakonHarnes/img-clip.nvim',
      event = 'VeryLazy',
      opts = {
        -- recommended settings
        default = {
          embed_image_as_base64 = false,
          prompt_for_file_name = false,
          drag_and_drop = {
            insert_mode = true,
          },
          -- required for Windows users
          use_absolute_path = true,
        },
      },
    },
    {
      -- Make sure to setup it properly if you have lazy=true
      'MeanderingProgrammer/render-markdown.nvim',
      opts = {
        file_types = { 'markdown', 'Avante' },
      },
      ft = { 'markdown', 'Avante' },
    },
  },
}
