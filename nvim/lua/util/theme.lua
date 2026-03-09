local M = {}

local state_file = vim.fn.stdpath("data") .. "/theme_state.lua"
M.default_theme = "bearded-arc"

M._startup_complete = false

function M.is_bearded_theme(theme_name)
  return type(theme_name) == "string" and theme_name:match("^bearded") ~= nil
end

function M.is_bearded_variant(theme_name)
  return type(theme_name) == "string" and theme_name:match("^bearded%-") ~= nil
end

function M.get_saved_theme()
  local f = io.open(state_file, "r")
  if f then
    local content = f:read("*all")
    f:close()
    local chunk = load(content)
    if type(chunk) == "function" then
      local ok, theme = pcall(chunk)
      if ok and theme then
        return theme
      end
    end
  end
  return nil
end

function M.save_theme(theme_name)
  local f = io.open(state_file, "w")
  if f then
    local content = string.format("return %q", theme_name)
    f:write(content)
    f:close()
  end
end

function M.normalize_theme(theme_name)
  if type(theme_name) ~= "string" or theme_name == "" then
    return nil
  end

  if theme_name == "bearded" then
    local existing = M.get_saved_theme()
    if M.is_bearded_variant(existing) then
      return existing
    end
    return M.default_theme
  end

  return theme_name
end

function M.resolve_bearded_theme(theme_name)
  local normalized = M.normalize_theme(theme_name)
  if M.is_bearded_variant(normalized) then
    return normalized
  end
  return M.default_theme
end

function M.get_bearded_flavor(theme_name)
  return M.resolve_bearded_theme(theme_name):gsub("^bearded%-", "")
end

function M.apply_theme(theme_name)
  local resolved_theme = M.normalize_theme(theme_name)
  if not resolved_theme then
    return false, nil
  end

  local ok_loader, loader = pcall(require, "lazy.core.loader")
  if ok_loader then
    pcall(loader.colorscheme, resolved_theme)
  end

  local ok = pcall(vim.cmd, "colorscheme " .. resolved_theme)
  if not ok then
    return false, resolved_theme
  end

  return true, resolved_theme
end

function M.setup_autosave()
  local group = vim.api.nvim_create_augroup("ThemeSwitcher", { clear = true })

  vim.api.nvim_create_autocmd("ColorScheme", {
    group = group,
    callback = function(args)
      if not M._startup_complete then
        return
      end

      local theme_name = M.normalize_theme(args.match)
      if not theme_name then
        return
      end

      M.save_theme(theme_name)
    end,
  })

  vim.defer_fn(function()
    M._startup_complete = true
  end, 100)
end

return M
