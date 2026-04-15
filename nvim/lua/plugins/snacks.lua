return {
  {
    "folke/snacks.nvim",
    keys = {
      { "<leader>ff", false },
    },
    opts = function(_, opts)
      local theme_util = require("util.theme")

      opts.indent = vim.tbl_deep_extend("force", opts.indent or {}, {
        enabled = false,
      })

      opts.picker = vim.tbl_deep_extend("force", opts.picker or {}, {
        enabled = false,
      })

      opts.scroll = { enabled = true }
      opts.picker.ignored = true
      opts.picker.sources = opts.picker.sources or {}
      opts.picker.sources.colorschemes = vim.tbl_deep_extend("force", opts.picker.sources.colorschemes or {}, {
        confirm = function(picker, item)
          picker:close()

          if not item then
            return
          end

          picker.preview.state.colorscheme = nil

          local theme_name = theme_util.normalize_theme(item.text) or theme_util.default_theme
          theme_util.save_theme(theme_name)

          vim.schedule(function()
            local ok, resolved_theme = theme_util.apply_theme(theme_name)
            if not ok then
              vim.notify("Failed to load colorscheme: " .. theme_name, vim.log.levels.ERROR)
              return
            end

            theme_util.save_theme(resolved_theme)
          end)
        end,
      })
    end,
  },
}
