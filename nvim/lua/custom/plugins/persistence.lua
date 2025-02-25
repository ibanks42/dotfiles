if vim.g.vscode then
  return {}
end

return {
  'folke/persistence.nvim',
  event = 'BufReadPre',
  opts = {},
}
