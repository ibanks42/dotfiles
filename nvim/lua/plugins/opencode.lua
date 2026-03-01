return {
  "sudo-tee/opencode.nvim",
  config = function()
    require("opencode").setup({
      preferred_picker = "fzf",
      keymap = {
        input_window = {
          ["<S-cr>"] = { "\n", mode = { "n", "i" } },
          ["<cr>"] = { "submit_input_prompt", mode = { "n", "i" } },
        },
      },
      quick_chat = {
        default_model = "github-copilot/gpt-5.1-codex-mini",
        default_agent = "build",
        instructions = nil,
      },
    })

    local wk = require("which-key")
    wk.add({
      { "<leader>o", group = "opencode" },
    })
  end,
  dependencies = {
    "nvim-lua/plenary.nvim",
    {
      "MeanderingProgrammer/render-markdown.nvim",
      opts = {
        anti_conceal = { enabled = false },
        file_types = { "markdown", "opencode_output" },
      },
      ft = { "markdown", "Avante", "copilot-chat", "opencode_output" },
    },
    "saghen/blink.cmp",
    "ibhagwan/fzf-lua",
  },
}
