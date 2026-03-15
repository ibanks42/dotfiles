return {
  {
    "shellRaining/hlchunk.nvim",
    event = { "BufReadPre", "BufNewFile" },
    config = function()
      require("hlchunk").setup({
        chunk = {
          enable = true,
        },
        line_num = {
          enable = true,
          priority = 10,
          use_treesitter = true,
          style = "#806d9c",
        },
        indent = {
          enable = true,
          style = "#806d9c",
          chars = {
            "¦",
          },
        },
      })
    end,
  },
}
