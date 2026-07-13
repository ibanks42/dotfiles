return {
  {
    dir = vim.fs.joinpath(vim.fn.stdpath("config"), "vendor", "ask.nvim"),
    name = "ask.nvim",
    event = "BufEnter",
    config = function()
      require("ask").setup({
        provider = "opencode",
        history = {
          persist = true,
          max_entries = 200,
        },
        context = {
          current_file = {
            enabled = true,
          },
        },
        providers = {
          opencode = {
            -- Set model to a provider/model value to override OpenCode's default.
            -- Permission prompts continue to use OpenCode's configured policy.
            model = nil,
          },
        },
      })

      vim.keymap.set("n", "<leader>ah", function()
        return require("ask").show_history()
      end, { desc = "Ask History" })

      vim.keymap.set("n", "<leader>aa", function()
        vim.ui.input({ prompt = "Ask " }, function(input)
          if input and input ~= "" then
            require("ask").query(input)
          end
        end)
      end, { desc = "Ask OpenCode" })

      vim.keymap.set("n", "<leader>am", function()
        require("ask").select_model()
      end, { desc = "Select model" })

      vim.keymap.set("v", "<leader>aa", function()
        vim.ui.input({ prompt = "'<,'>Ask " }, function(input)
          if input and input ~= "" then
            require("ask").query_visual(input, vim.fn.line("'<"), vim.fn.line("'>"))
          end
        end)
      end, { desc = "Ask OpenCode (Visual)" })

      local wk = require("which-key")
      wk.add({
        { "<leader>a", group = "ask", mode = { "n", "v" } },
      })
    end,
  },
}
