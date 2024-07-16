return {
  'smartpde/telescope-recent-files',
  event = 'VeryLazy',
  config = function()
    require('telescope').load_extension 'recent_files'
  end,
}
