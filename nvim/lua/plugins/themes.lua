return {
  {
    -- LazyVim v16 applies its default colorscheme (tokyonight) via
    -- require("tokyonight").load() *after* config/options.lua has run, which
    -- silently overrides whatever was applied earlier. Route its colorscheme
    -- hook through our persisted theme instead.
    "LazyVim/LazyVim",
    opts = {
      colorscheme = function()
        local theme_util = require("util.theme")
        theme_util.apply_theme(
          theme_util.get_saved_theme() or theme_util.default_theme
        )
      end,
    },
  },
  -- not used; the LazyVim override above replaces the default tokyonight loader
  {
    "kepano/flexoki-neovim",
    opts = {},
  },
}
