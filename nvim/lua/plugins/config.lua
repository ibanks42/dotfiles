-- every spec file under the "plugins" directory will be loaded automatically by lazy.nvim
--
-- In your plugin files, you can:
-- * add extra plugins
-- * disable/enabled LazyVim plugins
-- * override the configuration of LazyVim plugins

vim.g.zig_fmt_autosave = 0

return {
  -- better escape jk to save, jj to escape
  {
    {
      "max397574/better-escape.nvim",
      config = function()
        require("better_escape").setup({
          timeout = vim.o.timeoutlen,
          default_mappings = false,
          mappings = {
            i = {
              j = {
                k = function()
                  local keys = vim.api.nvim_replace_termcodes("<Esc>:w<CR>", true, false, true)
                  vim.api.nvim_feedkeys(keys, "m", false)
                  -- vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", true)
                  -- format
                  -- vim.schedule(function()
                  --   vim.cmd.w()
                  -- end)
                end,
                j = "<Esc>",
              },
            },
          },
        })
      end,
    },
  },

  {
    "folke/snacks.nvim",
    priority = 1000,
    lazy = false,
    opts = {
      -- your configuration comes here
      -- or leave it empty to use the default settings
      -- refer to the configuration section below
      bigfile = { enabled = true },
      notifier = { enabled = true },
      quickfile = { enabled = true },
      statuscolumn = { enabled = true },
      words = { enabled = true },
      scroll = { enabled = false },
      inlay_hints = { enabled = false },
      dashboard = {
        formats = {
          key = function(item)
            return { { "[", hl = "special" }, { item.key, hl = "key" }, { "]", hl = "special" } }
          end,
        },
        sections = {
          { section = "terminal", padding = 1, height = 1, cmd = "" },
          {
            pane = 2,
            section = "terminal",
            height = 1,
            padding = 1,
            cmd = "",
          },
          { title = "Sessions", padding = 1 },
          { section = "projects", padding = 1 },
          { title = "MRU", padding = 1 },
          { section = "recent_files", limit = 8, padding = 1 },
          { title = "Bookmarks", padding = 1 },
          { section = "keys", gap = 1, padding = 1 },
          {
            pane = 2,
            icon = " ",
            desc = "Browse Repo",
            padding = 1,
            key = "b",
            action = function()
              Snacks.gitbrowse()
            end,
          },
          function()
            local in_git = Snacks.git.get_root() ~= nil
            local cmds = {
              {
                title = "Notifications",
                cmd = "gh notify -s -a -n5",
                action = function()
                  vim.ui.open("https://github.com/notifications")
                end,
                key = "n",
                icon = " ",
                height = 5,
                enabled = true,
              },
              {
                title = "Open Issues",
                cmd = "gh issue list -L 3",
                key = "i",
                action = function()
                  vim.fn.jobstart("gh issue list --web", { detach = true })
                end,
                icon = " ",
                height = 7,
              },
              {
                icon = " ",
                title = "Open PRs",
                cmd = "gh pr list -L 3",
                key = "p",
                action = function()
                  vim.fn.jobstart("gh pr list --web", { detach = true })
                end,
                height = 7,
              },
              {
                icon = " ",
                title = "Git Status",
                cmd = "hub --no-pager diff --stat -B -M -C",
                height = 10,
              },
            }
            return vim.tbl_map(function(cmd)
              return vim.tbl_extend("force", {
                pane = 2,
                section = "terminal",
                enabled = in_git,
                padding = 1,
                ttl = 5 * 60,
                indent = 3,
              }, cmd)
            end, cmds)
          end,
          { section = "startup" },
        },
      },
    },
  },
  -- add build_on_save to zls
  {
    "neovim/nvim-lspconfig",
    config = function()
      require("lspconfig").zls.setup({
        settings = {
          zls = {
            enable_build_on_save = true,
          },
        },
      })
    end,
  },
}
