if vim.g.vscode then
  return {}
end

return {
  'saghen/blink.cmp',
  -- optional: provides snippets for the snippet source
  dependencies = { 'rafamadriz/friendly-snippets', 'MahanRahmati/blink-nerdfont.nvim', 'moyiz/blink-emoji.nvim' },

  -- use a release tag to download pre-built binaries
  version = '*',
  -- AND/OR build from source, requires nightly: https://rust-lang.github.io/rustup/concepts/channels.html#working-with-nightly-rust
  -- build = 'cargo build --release',
  -- If you use nix, you can build from source using latest nightly rust with:
  -- build = 'nix run .#build-plugin',

  ---@module 'blink.cmp'
  ---@type blink.cmp.Config
  opts = {
    -- 'default' for mappings similar to built-in completion
    -- 'super-tab' for mappings similar to vscode (tab to accept, arrow keys to navigate)
    -- 'enter' for mappings similar to 'super-tab' but with 'enter' to accept
    -- See the full "keymap" documentation for information on defining your own keymap.
    keymap = {
      -- set to 'none' to disable the 'default' preset
      preset = 'default',

      -- show with a list of providers
      ['<C-space>'] = {
        function(cmp)
          cmp.show {}
        end,
      },

      -- control whether the next command will be run when using a function
      ['<C-n>'] = {
        'select_next',
      },
      ['<Tab>'] = { 'select_and_accept', 'fallback', 'snippet_forward' },

      -- optionally, separate cmdline and terminal keymaps
      -- cmdline = {
      -- sets <CR> to accept the item and run the command immediately
      -- use `select_accept_and_enter` to accept the item or the first item if none are selected
      -- ['<CR>'] = { 'accept_and_enter', 'fallback' },
      -- },
      -- term = {}
    },
    signature = {
      enabled = true,
    },

    appearance = {
      -- Sets the fallback highlight groups to nvim-cmp's highlight groups
      -- Useful for when your theme doesn't support blink.cmp
      -- Will be removed in a future release
      use_nvim_cmp_as_default = true,
      -- Set to 'mono' for 'Nerd Font Mono' or 'normal' for 'Nerd Font'
      -- Adjusts spacing to ensure icons are aligned
      nerd_font_variant = 'mono',
    },
    completion = {
      documentation = {
        auto_show = true,
        auto_show_delay_ms = 150,
      },
      menu = {
        draw = {
          treesitter = { 'lsp' },
          columns = { { 'kind_icon', 'label', 'label_description', 'source_name', gap = 1 } },
        },
      },
    },
    sources = {
      default = {
        'lsp',
        'path',
        'buffer',
        'nerdfont',
        'emoji',
      },
      providers = {
        lazydev = {
          name = 'LazyDev',
          module = 'lazydev.integrations.blink',
          score_offset = 100,
        },
        nerdfont = {
          module = 'blink-nerdfont',
          name = 'Nerd Fonts',
          -- score_offset = 15,
          opts = { insert = true },
        },
        emoji = {
          module = 'blink-emoji',
          name = 'Emoji',
          -- score_offset = 15,
          opts = { insert = true },
          should_show_items = function()
            return vim.tbl_contains({ 'gitcommit', 'markdown' }, vim.o.filetype)
          end,
        },
      },
      transform_items = function(_, items)
        return vim.tbl_filter(function(item)
          return not (item.kind == require('blink.cmp.types').CompletionItemKind.Snippet and item.source_name == 'LSP')
        end, items)
      end,
    },
  },
  opts_extend = { 'sources.default' },
}
