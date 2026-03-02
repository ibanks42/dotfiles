local M = {}

local state_file = vim.fn.stdpath("data") .. "/theme_state.lua"

-- Flag to prevent autosave during startup loading
M._startup_complete = false

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

function M.setup_autosave()
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = vim.api.nvim_create_augroup("ThemeSwitcher", { clear = true }),
    callback = function(args)
      -- Only save if startup is complete (prevents overwriting during theme loading)
      if M._startup_complete then
        -- Prefer the explicit colorscheme name from the event.
        -- Some themes emit a follow-up generic event (e.g. "bearded") after a
        -- specific variant event (e.g. "bearded-hc-flurry"). Guard against
        -- that generic overwrite so variant selections persist across restarts.
        local theme_name = args.match
        if not theme_name or theme_name == "" then
          return
        end

        if theme_name == "bearded" then
          local existing = M.get_saved_theme()
          if existing and existing:match("^bearded%-") then
            return
          end
        end

        M.save_theme(theme_name)
      end
    end,
  })
  
  -- Mark startup as complete after a delay
  vim.defer_fn(function()
    M._startup_complete = true
  end, 500)
end

return M
