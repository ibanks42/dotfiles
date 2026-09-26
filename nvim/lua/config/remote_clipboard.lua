-- Clipboard for sessions whose yanks may need to reach another machine:
-- every copy is emitted as OSC 52 (inside tmux this becomes a tmux buffer,
-- rebroadcast to every attached client, local or SSH). Paste prefers the
-- local Wayland clipboard when one is available, so content copied in other
-- apps remains pasteable; without a display, paste reads the tmux buffer
-- or the last text copied in this Neovim instance. Never query OSC 52:
-- terminals and multiplexers may leave clipboard reads unanswered.
local M = {}

local function proc_lines(pid, file)
  local ok, lines = pcall(vim.fn.readfile, "/proc/" .. pid .. "/" .. file)
  return ok and lines or {}
end

local function proc_ppid(pid)
  for _, line in ipairs(proc_lines(pid, "status")) do
    local ppid = line:match("^PPid:%s+(%d+)")
    if ppid then
      return tonumber(ppid)
    end
  end
end

local function ancestor_process_named(name)
  local pid = vim.fn.getpid()

  for _ = 1, 16 do
    local ppid = proc_ppid(pid)
    if not ppid or ppid <= 1 then
      return false
    end

    local comm = proc_lines(ppid, "comm")[1] or ""
    if comm:find(name, 1, true) then
      return true
    end

    pid = ppid
  end

  return false
end

function M.setup()
  local in_tmux = vim.env.TMUX ~= nil
  local in_ssh = vim.env.SSH_TTY ~= nil or vim.env.SSH_CONNECTION ~= nil
  local in_herdr = vim.env.HERDR_PANE_ID ~= nil
    or ancestor_process_named("herdr")

  if not (in_tmux or in_ssh or in_herdr) then
    return
  end

  local osc52 = require("vim.ui.clipboard.osc52")
  local has_wayland = vim.env.WAYLAND_DISPLAY ~= nil
    and vim.fn.executable("wl-copy") == 1
    and vim.fn.executable("wl-paste") == 1

  -- The helper targets tmux's client tty and mirrors its paste-buffer.
  -- Outside tmux, use Neovim's UI output: vim.fn.system() children have
  -- no controlling terminal, so the helper cannot open /dev/tty.
  local osc52_sh = vim.fn.expand("~/.config/tmux/osc52.sh")
  local has_osc52_sh = vim.uv.fs_stat(osc52_sh) ~= nil
  local copied = {
    ["+"] = { {}, "v" },
    ["*"] = { {}, "v" },
  }

  local function copy(register)
    local emit = osc52.copy(register)

    return function(lines, regtype)
      copied[register] = { vim.deepcopy(lines), regtype or "v" }
      if has_wayland then
        local cmd = { "wl-copy", "--sensitive", "--type", "text/plain" }
        if register == "*" then
          cmd[#cmd + 1] = "--primary"
        end
        vim.fn.system(cmd, lines)
      end

      if in_tmux and has_osc52_sh then
        vim.fn.system(osc52_sh, lines)
      elseif vim.g.remote_clipboard_osc52 ~= false then
        emit(lines)
      end
    end
  end

  local function paste(register)
    if has_wayland then
      return function()
        local cmd = { "wl-paste", "--no-newline" }
        if register == "*" then
          cmd[#cmd + 1] = "--primary"
        end

        local lines = vim.fn.systemlist(cmd, "", 1)
        return vim.v.shell_error == 0 and lines or {}
      end
    end

    -- No local display (e.g. remote server): OSC 52 paste queries go
    -- unanswered behind mosh, so read the tmux paste-buffer instead —
    -- osc52.sh keeps it in sync with every copy (nvim and tmux alike).
    if vim.env.TMUX then
      return function()
        local lines = vim.fn.systemlist("tmux save-buffer -", "", 1)
        return vim.v.shell_error == 0 and lines or {}
      end
    end

    return function()
      return vim.deepcopy(copied[register])
    end
  end

  vim.g.clipboard = {
    name = "RemoteClipboard",
    copy = { ["+"] = copy("+"), ["*"] = copy("*") },
    paste = { ["+"] = paste("+"), ["*"] = paste("*") },
    cache_enabled = 0,
  }
end

return M
