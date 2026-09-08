-- Modest Dark — port of timcole/modest-dark (Zed) to Neovim
-- Based on One Dark with brighter colours on a darker background

vim.cmd("highlight clear")
if vim.g.colors_name then
  vim.cmd("let g:colors_name = ''")
end
vim.g.colors_name = "modest-dark"

local c = {
  bg = "#1C1F25",
  bg_element = "#242C3C",
  bg_selected = "#2C3444",
  bg_highlight = "#3e4452",
  fg = "#abb2bf",
  fg_bright = "#e6e6e6",
  variable = "#d7dae0",
  comment = "#546178",
  line_nr = "#495162",
  ignored = "#636b78",
  red = "#e06c75",
  red_bright = "#ef5f6b",
  warning = "#D6A07A",
  string = "#A3BE8C",
  green_bright = "#a5e075",
  yellow = "#e5c07b",
  yellow_bright = "#ebc275",
  orange = "#d99a5e",
  literal = "#B4A7D6",
  blue = "#5ab0f6",
  magenta = "#c678dd",
  teal = "#4EC9B0",
  magenta_bright = "#de73ff",
  cyan = "#56b6c2",
  deleted = "#ff616e",
  none = "NONE",
}

local g = vim.api.nvim_set_hl

g(0, "Normal", { fg = c.fg, bg = c.bg })
g(0, "NormalFloat", { fg = c.fg, bg = c.bg })
g(0, "FloatBorder", { fg = c.bg_element, bg = c.bg })
g(0, "NormalNC", { fg = c.fg, bg = c.bg })
g(0, "Comment", { fg = c.comment })
g(0, "Cursor", { fg = c.bg, bg = c.fg })
g(0, "CursorColumn", { bg = c.bg })
g(0, "CursorLine", { bg = c.bg })
g(0, "CursorLineNr", { fg = c.fg })
g(0, "LineNr", { fg = c.line_nr })
g(0, "ColorColumn", { bg = c.bg_element })
g(0, "Conceal", { fg = c.ignored })
g(0, "Directory", { fg = c.blue })
g(0, "EndOfBuffer", { fg = c.bg })
g(0, "Error", { fg = c.red_bright, bg = c.none })
g(0, "ErrorMsg", { fg = c.red_bright })
g(0, "WarningMsg", { fg = c.yellow_bright })
g(0, "MatchParen", { fg = c.fg_bright, bg = c.bg_element })
g(0, "ModeMsg", { fg = c.fg })
g(0, "MoreMsg", { fg = c.green_bright })
g(0, "NonText", { fg = c.line_nr })
g(0, "Pmenu", { fg = c.fg, bg = c.bg })
g(0, "PmenuSbar", { bg = c.bg })
g(0, "PmenuSel", { fg = c.fg_bright, bg = c.bg_element })
g(0, "PmenuThumb", { bg = c.bg_element })
g(0, "Question", { fg = c.green_bright })
g(0, "QuickFixLine", { bg = c.bg_selected })
g(0, "Search", { fg = c.bg, bg = c.bg_highlight })
g(0, "IncSearch", { fg = c.bg, bg = c.orange })
g(0, "CurSearch", { link = "IncSearch" })
g(0, "Substitute", { fg = c.bg, bg = c.bg_highlight })
g(0, "SignColumn", { fg = c.line_nr, bg = c.bg })
g(0, "SpecialKey", { fg = c.line_nr })
g(0, "SpellBad", { fg = c.red_bright, undercurl = true })
g(0, "SpellCap", { fg = c.yellow_bright, undercurl = true })
g(0, "SpellRare", { fg = c.magenta_bright, undercurl = true })
g(0, "SpellLocal", { fg = c.cyan, undercurl = true })
g(0, "StatusLine", { fg = c.fg, bg = c.bg })
g(0, "StatusLineNC", { fg = c.line_nr, bg = c.bg })
g(0, "TabLine", { fg = c.line_nr, bg = c.bg })
g(0, "TabLineFill", { fg = c.none, bg = c.bg })
g(0, "TabLineSel", { fg = c.fg_bright, bg = c.bg_element })
g(0, "Title", { fg = c.fg_bright, bold = true })
g(0, "VertSplit", { fg = c.bg_element, bg = c.none })
g(0, "WinSeparator", { fg = c.bg_element, bg = c.none })
g(0, "Visual", { bg = c.bg_selected })
g(0, "VisualNOS", { bg = c.bg_selected })
g(0, "Whitespace", { fg = c.bg_element })
g(0, "WildMenu", { fg = c.fg_bright, bg = c.bg_element })
g(0, "Folded", { fg = c.line_nr, bg = c.bg })
g(0, "FoldColumn", { fg = c.line_nr, bg = c.bg })

g(0, "Constant", { fg = c.variable })
g(0, "Number", { fg = c.literal })
g(0, "Boolean", { fg = c.literal })
g(0, "Float", { fg = c.literal })
g(0, "Character", { fg = c.string })
g(0, "String", { fg = c.string })
g(0, "Identifier", { fg = c.variable })
g(0, "Function", { fg = c.blue })
g(0, "Statement", { fg = c.magenta })
g(0, "Conditional", { link = "Statement" })
g(0, "Repeat", { link = "Statement" })
g(0, "Label", { link = "Statement" })
g(0, "Operator", { fg = c.fg })
g(0, "Keyword", { link = "Statement" })
g(0, "Exception", { link = "Statement" })
g(0, "PreProc", { link = "Statement" })
g(0, "Include", { link = "Statement" })
g(0, "Define", { fg = c.red })
g(0, "Macro", { link = "Function" })
g(0, "PreCondit", { link = "Statement" })
g(0, "Type", { fg = c.teal })
g(0, "StorageClass", { link = "Define" })
g(0, "Structure", { link = "Type" })
g(0, "Typedef", { link = "Type" })
g(0, "Special", { fg = c.cyan })
g(0, "SpecialChar", { fg = c.cyan })
g(0, "Tag", { fg = c.red })
g(0, "Delimiter", { fg = c.fg })
g(0, "SpecialComment", { fg = c.comment })
g(0, "Debug", { fg = c.orange })
g(0, "Underlined", { fg = c.blue, underline = true })
g(0, "Ignore", { fg = c.ignored })

g(0, "DiagnosticError", { fg = c.red_bright })
g(0, "DiagnosticWarn", { fg = c.warning })
g(0, "DiagnosticInfo", { fg = c.blue })
g(0, "DiagnosticHint", { fg = c.fg })
g(0, "DiagnosticUnderlineError", { fg = c.none, undercurl = true, sp = c.red_bright })
g(0, "DiagnosticUnderlineWarn", { fg = c.none, undercurl = true, sp = c.warning })
g(0, "DiagnosticUnderlineInfo", { fg = c.none, undercurl = true, sp = c.blue })
g(0, "DiagnosticUnderlineHint", { fg = c.none, undercurl = true, sp = c.fg })
g(0, "DiagnosticVirtualTextError", { fg = c.red_bright, bg = c.none })
g(0, "DiagnosticVirtualTextWarn", { fg = c.warning, bg = c.none })
g(0, "DiagnosticVirtualTextInfo", { fg = c.blue, bg = c.none })
g(0, "DiagnosticVirtualTextHint", { fg = c.fg, bg = c.none })

g(0, "Added", { fg = c.green_bright })
g(0, "Removed", { fg = c.deleted })
g(0, "Changed", { fg = c.yellow })
g(0, "diffAdded", { fg = c.green_bright })
g(0, "diffRemoved", { fg = c.deleted })
g(0, "diffChanged", { fg = c.yellow })
g(0, "diffFile", { fg = c.orange })
g(0, "diffLine", { fg = c.blue })

g(0, "@attribute", { fg = c.yellow_bright })
g(0, "@boolean", { fg = c.literal })
g(0, "@comment", { fg = c.comment })
g(0, "@constant", { link = "Constant" })
g(0, "@constant.builtin", { link = "Constant" })
g(0, "@constructor", { fg = c.red })
g(0, "@function", { link = "Function" })
g(0, "@function.builtin", { link = "Function" })
g(0, "@function.call", { link = "Function" })
g(0, "@function.method", { link = "Function" })
g(0, "@function.method.call", { link = "Function" })
g(0, "@function.macro", { link = "Function" })
g(0, "@keyword", { link = "Keyword" })
-- The ECMA query extension separates const/let/var from generic keywords.
g(0, "@keyword.declaration", { link = "Define" })
g(0, "@keyword.function", { link = "Define" })
g(0, "@keyword.type", { link = "Define" })
g(0, "@keyword.storage", { link = "StorageClass" })
g(0, "@keyword.storageclass", { link = "StorageClass" })
g(0, "@keyword.import", { link = "Keyword" })
g(0, "@keyword.conditional", { link = "Keyword" })
g(0, "@keyword.conditional.ternary", { link = "Delimiter" })
g(0, "@keyword.repeat", { link = "Keyword" })
g(0, "@keyword.return", { link = "Keyword" })
g(0, "@keyword.exception", { link = "Keyword" })
g(0, "@keyword.coroutine", { link = "Keyword" })
g(0, "@keyword.operator", { link = "Keyword" })
g(0, "@label", { fg = c.red })
g(0, "@module", { link = "Identifier" })
g(0, "@module.builtin", { link = "Identifier" })
g(0, "@markup.raw", { link = "String" })
g(0, "@number", { fg = c.literal })
g(0, "@operator", { fg = c.fg })
g(0, "@property", { fg = c.yellow })
g(0, "@variable.member", { link = "@property" })
g(0, "@punctuation", { fg = c.fg })
g(0, "@punctuation.bracket", { fg = c.fg })
g(0, "@punctuation.delimiter", { fg = c.fg })
g(0, "@punctuation.special", { fg = c.fg })
g(0, "@string", { fg = c.string })
g(0, "@string.escape", { fg = c.string })
g(0, "@string.regex", { fg = c.string })
g(0, "@string.regexp", { fg = c.string })
g(0, "@string.special", { fg = c.cyan })
g(0, "@tag", { fg = c.red })
g(0, "@tag.attribute", { fg = c.yellow_bright })
g(0, "@tag.delimiter", { fg = c.fg })
g(0, "@type", { link = "Type" })
g(0, "@type.builtin", { link = "Type" })
g(0, "@variable", { link = "Identifier" })
g(0, "@variable.builtin", { link = "Identifier" })
g(0, "@variable.parameter", { link = "Identifier" })

-- Semantic tokens take precedence over Treesitter; keep their palette aligned.
for token, target in pairs({
  variable = "@variable",
  parameter = "@variable.parameter",
  property = "@property",
  enumMember = "@constant",
  ["function"] = "@function",
  method = "@function.method",
  macro = "@function.macro",
  type = "@type",
  class = "@type",
  interface = "@type",
  struct = "@type",
  enum = "@type",
  typeParameter = "@type",
  namespace = "@module",
  keyword = "@keyword",
  string = "@string",
  number = "@number",
  boolean = "@boolean",
  operator = "@operator",
  decorator = "@attribute",
}) do
  g(0, "@lsp.type." .. token, { link = target })
end
g(0, "@lsp.typemod.variable.defaultLibrary", { link = "@variable.builtin" })
g(0, "@lsp.typemod.variable.readonly", { link = "@constant" })
g(0, "@lsp.typemod.property.readonly", { link = "@property" })

g(0, "TelescopeBorder", { fg = c.bg_element, bg = c.bg })
g(0, "TelescopePromptTitle", { fg = c.fg_bright, bg = c.bg_element })
g(0, "TelescopeSelection", { fg = c.fg_bright, bg = c.bg_element })
g(0, "NotifyINFOBorder", { fg = c.blue })
g(0, "NotifyWARNBorder", { fg = c.yellow_bright })
g(0, "NotifyERRORBorder", { fg = c.red_bright })

g(0, "Terminal", { fg = c.fg, bg = c.bg })
for i, hex in ipairs({
  "#3f4451", "#ef5f6b", "#8cc265", "#ebc275",
  "#5ab0f6", "#c162de", "#4dbdcb", "#d7dae0",
  "#4f5666", "#ef5f6b", "#a5e075", "#ebc275",
  "#5ab0f6", "#de73ff", "#4dbdcb", "#e6e6e6",
}) do
  vim.g["terminal_color_" .. (i - 1)] = hex
end
