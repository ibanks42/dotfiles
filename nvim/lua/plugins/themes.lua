local theme_util = require("util.theme")

theme_util.setup_autosave()

return {
  {
    "kepano/flexoki-neovim",
    opts = {},
  },
  {
    "Ferouk/bearded-nvim",
    lazy = false,
    priority = 1000,
    opts = {
      flavor = theme_util.get_bearded_flavor(theme_util.get_saved_theme()),
    },
    config = function(_, opts)
      require("bearded").setup(opts)

      local target_theme = theme_util.normalize_theme(theme_util.get_saved_theme()) or theme_util.default_theme
      local ok, resolved_theme = theme_util.apply_theme(target_theme)

      if not ok then
        resolved_theme = theme_util.default_theme
        theme_util.apply_theme(resolved_theme)
      end

      theme_util.save_theme(resolved_theme)
      theme_util._startup_complete = true
    end,
  },
}
