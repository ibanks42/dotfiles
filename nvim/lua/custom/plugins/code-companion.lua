return {
  'olimorris/codecompanion.nvim',
  dependencies = {
    'nvim-lua/plenary.nvim',
    'nvim-treesitter/nvim-treesitter',
    'hrsh7th/nvim-cmp', -- Optional: For using slash commands and variables in the chat buffer
    'nvim-telescope/telescope.nvim', -- Optional: For using slash commands
    { 'stevearc/dressing.nvim', opts = {} }, -- Optional: Improves `vim.ui.select`
  },
  config = function()
    require('codecompanion').setup {
      strategies = {
        chat = {
          adapter = 'ollama',
        },
        inline = {
          adapter = 'ollama',
        },
        agent = {
          adapter = 'ollama',
        },
      },
      adapters = {
        ollama = function()
          return require('codecompanion.adapters').extend('ollama', {
            schema = {
              model = {
                default = 'llama3.1',
              },
            },
          })
        end,
      },
      prompt_library = {
        ['Code Expert'] = {
          strategy = 'chat',
          description = 'Get some special advice from an LLM',
          opts = {
            mapping = '<LocalLeader>ce',
            modes = { 'v' },
            slash_cmd = 'expert',
            auto_submit = true,
            stop_context_insertion = true,
            user_prompt = true,
          },
          prompts = {
            {
              role = 'system',
              content = function(context)
                return 'I want you to act as a senior '
                  .. context.filetype
                  .. ' developer. I will ask you specific questions and I want you to return concise explanations and codeblock examples.'
              end,
            },
            {
              role = 'user',
              content = function(context)
                local text = require('codecompanion.helpers.actions').get_code(context.start_line, context.end_line)

                return 'I have the following code:\n\n```' .. context.filetype .. '\n' .. text .. '\n```\n\n'
              end,
              opts = {
                contains_code = true,
              },
            },
          },
        },
      },
    }
  end,
}
