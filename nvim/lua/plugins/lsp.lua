local function mason_bin(name)
  return vim.fs.joinpath(vim.fn.stdpath("data"), "mason", "bin", name)
end

return {
  {
    "neovim/nvim-lspconfig",
    -- LazyVim only loads this on BufReadPre. Enable Copilot before that
    -- so :checkhealth / :LspCopilotSignIn work from the dashboard.
    event = "VeryLazy",
    opts = {
      inlay_hints = {
        enabled = false,
      },
      servers = {
        -- mason-lspconfig maps copilot-language-server -> copilot, so LazyVim
        -- would skip vim.lsp.enable() and leave sidekick thinking it's off.
        copilot = {
          mason = false,
          cmd = { mason_bin("copilot-language-server"), "--stdio" },
        },
        ols = {
          init_options = {
            checker_args = "-strict-style",
            collections = {
              { name = "shared", path = vim.fn.expand("$HOME/odin-lib") },
            },
          },
        },
      },
    },
  },
}
