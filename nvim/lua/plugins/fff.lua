local function project_root()
  if _G.LazyVim and LazyVim.root then
    return LazyVim.root()
  end

  return vim.uv.cwd()
end

local function current_word()
  return vim.fn.expand("<cword>")
end

local function selection_text()
  local lines = vim.fn.getregion(vim.fn.getpos("v"), vim.fn.getpos("."), { type = vim.fn.mode() })
  local query = table.concat(lines, " "):gsub("%s+", " ")

  return vim.trim(query)
end

local function find_files(opts)
  require("fff").find_files(opts)
end

local function live_grep(opts)
  require("fff").live_grep(opts)
end

local function grep_query(query, opts)
  if query == "" then
    return
  end

  live_grep(vim.tbl_deep_extend("force", opts or {}, { query = query }))
end

return {
  {
    "dmtrKovalenko/fff.nvim",
    build = function()
      require("fff.download").download_or_build_binary()
    end,
    opts = {},
    lazy = true,
    keys = {
      {
        "<leader><space>",
        function()
          find_files({ cwd = project_root() })
        end,
        desc = "Find Files (Root Dir)",
      },
      {
        "<leader>/",
        function()
          live_grep({ cwd = project_root() })
        end,
        desc = "Grep (Root Dir)",
      },
      {
        "<leader>fc",
        function()
          find_files({ cwd = vim.fn.stdpath("config"), title = "Config Files" })
        end,
        desc = "Find Config File",
      },
      {
        "<leader>ff",
        function()
          find_files({ cwd = project_root() })
        end,
        desc = "Find Files (Root Dir)",
      },
      {
        "<leader>fF",
        function()
          find_files({ cwd = vim.uv.cwd() })
        end,
        desc = "Find Files (cwd)",
      },
      {
        "<leader>sg",
        function()
          live_grep({ cwd = project_root() })
        end,
        desc = "Grep (Root Dir)",
      },
      {
        "<leader>sG",
        function()
          live_grep({ cwd = vim.uv.cwd() })
        end,
        desc = "Grep (cwd)",
      },
      {
        "<leader>sw",
        function()
          grep_query(current_word(), { cwd = project_root() })
        end,
        desc = "Word (Root Dir)",
      },
      {
        "<leader>sW",
        function()
          grep_query(current_word(), { cwd = vim.uv.cwd() })
        end,
        desc = "Word (cwd)",
      },
      {
        "<leader>sw",
        function()
          grep_query(selection_text(), { cwd = project_root() })
        end,
        mode = "x",
        desc = "Selection (Root Dir)",
      },
      {
        "<leader>sW",
        function()
          grep_query(selection_text(), { cwd = vim.uv.cwd() })
        end,
        mode = "x",
        desc = "Selection (cwd)",
      },
      {
        "fg",
        function()
          live_grep()
        end,
        desc = "LiFFFe grep",
      },
      {
        "fz",
        function()
          live_grep({
            grep = {
              modes = { "fuzzy", "plain" },
            },
          })
        end,
        desc = "Live fffuzy grep",
      },
      {
        "fc",
        function()
          grep_query(current_word())
        end,
        desc = "Search current word",
      },
    },
  },
}
