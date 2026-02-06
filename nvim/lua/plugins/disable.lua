return {
  {
    "folke/snacks.nvim",
    ---@type snacks.Config
    opts = {
      scroll = {
        enabled = false,
      },
    },
  },
  {
    "neovim/nvim-lspconfig",
    opts = {
      inlay_hints = {
        enabled = false,
      },
    },
  },
}
