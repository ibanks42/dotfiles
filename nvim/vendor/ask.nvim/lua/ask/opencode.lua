local M = {}

function M.parse_model(model)
  if type(model) ~= "string" then
    return nil
  end

  local provider_id, model_id = model:match("^([^/]+)/(.+)$")
  if not provider_id or not model_id then
    return nil
  end

  return { providerID = provider_id, modelID = model_id }
end

local function join_url(url, path)
  return url:gsub("/$", "") .. path
end

local function with_directory(path, directory)
  if not directory or directory == "" then
    return path
  end
  return path .. (path:find("?", 1, true) and "&" or "?") .. "directory=" .. vim.uri_encode(directory)
end

local function describe_permission(properties)
  local action = properties.permission or properties.action or "use a tool"
  local resources = properties.patterns or properties.resources or {}
  local description = "Permit OpenCode to " .. action
  if #resources > 0 then
    description = description .. "\n\n" .. table.concat(resources, "\n")
  end
  return description .. "?"
end

local function response_delta(request, text)
  if text == "" then
    return
  end

  -- OpenCode can split adjacent sentences into separate deltas without the space.
  if request.last_text:match("[%.%!%?]$") and text:match("^[A-Z]") then
    text = " " .. text
  end
  request.last_text = text
  request.on_delta(text)
end

local function error_message(value)
  if type(value) == "string" and value ~= "" then
    return value
  end
  if type(value) ~= "table" then
    return nil
  end
  for _, key in ipairs({ "message", "error", "data", "status" }) do
    local message = error_message(value[key])
    if message then
      return message
    end
  end
  return nil
end

local function event_session_id(value)
  if type(value) ~= "table" then
    return nil
  end
  if type(value.sessionID) == "string" then
    return value.sessionID
  end
  if type(value.session_id) == "string" then
    return value.session_id
  end
  for _, key in ipairs({ "info", "error", "data", "status" }) do
    local session_id = event_session_id(value[key])
    if session_id then
      return session_id
    end
  end
  return nil
end

local function default_auth_path()
  local data_home = vim.env.XDG_DATA_HOME
  if not data_home or data_home == "" then
    data_home = vim.fn.expand("~/.local/share")
  end
  return vim.fs.joinpath(data_home, "opencode", "auth.json")
end

local function available_port()
  local uv = vim.uv or vim.loop
  local socket = uv.new_tcp()
  assert(socket:bind("127.0.0.1", 0))
  local address = socket:getsockname()
  socket:close()
  return address.port
end

local variant_order = { none = 1, low = 2, medium = 3, high = 4, xhigh = 5 }

local function parse_verbose_models(lines)
  local models = {}
  local value
  local json_lines
  local depth = 0
  for _, line in ipairs(lines or {}) do
    if not json_lines and line:match("^[^/]+/.+$") then
      value = line
    elseif value and not json_lines and line == "{" then
      json_lines = { line }
      depth = 1
    elseif json_lines then
      table.insert(json_lines, line)
      local opens = select(2, line:gsub("{", ""))
      local closes = select(2, line:gsub("}", ""))
      depth = depth + opens - closes
      if depth == 0 then
        local ok, metadata = pcall(vim.json.decode, table.concat(json_lines, "\n"))
        if ok then
          local variants = vim.tbl_keys(metadata.variants or {})
          table.sort(variants, function(a, b)
            return (variant_order[a] or 100) < (variant_order[b] or 100)
          end)
          table.insert(models, {
            value = value,
            label = value:gsub("/", " / ", 1),
            variants = variants,
          })
        end
        value = nil
        json_lines = nil
      end
    end
  end
  return models
end

M.parse_verbose_models = parse_verbose_models

function M.new(config)
  local self = {
    cmd = config.cmd or "opencode",
    url = config.url,
    managed_server = config.managed_server ~= false,
    auto_start = config.auto_start ~= false,
    database_path = config.database_path or vim.fs.joinpath(vim.fn.stdpath("state"), "ask-opencode.db"),
    auth_path = config.auth_path or default_auth_path(),
    model = config.model,
    reasoning = config.reasoning,
    timeout_ms = config.timeout_ms or 120000,
    agent = config.agent,
    system_prompt = config.system_prompt,
    tools = config.tools,
    active = {},
    event_job = nil,
    event_lines = {},
    server_job = nil,
    starting = false,
    server_waiters = {},
    prepare_waiters = {},
    prepare_job = nil,
    preparing = false,
    prepared = false,
  }

  local function active_count()
    local count = 0
    for _ in pairs(self.active) do
      count = count + 1
    end
    return count
  end

  function self.set_model(model)
    self.model = model
  end

  function self.set_reasoning(reasoning)
    self.reasoning = reasoning
  end

  function self.start(callback)
    callback = callback or function() end
    if not self.managed_server or self.prepared then
      self.ensure_server(callback)
      return
    end
    if self.preparing then
      table.insert(self.prepare_waiters, callback)
      return
    end

    self.preparing = true
    self.prepare_waiters = { callback }
    local errors = {}
    local exited = false
    local job = vim.fn.jobstart({ self.cmd, "models", "--refresh" }, {
      stdout_buffered = true,
      stderr_buffered = true,
      on_stderr = function(_, data)
        errors = data or {}
      end,
      on_exit = function(_, code)
        exited = true
        self.prepare_job = nil
        self.preparing = false
        local waiters = self.prepare_waiters
        self.prepare_waiters = {}
        if code ~= 0 then
          local message = "Failed to refresh OpenCode models: " .. table.concat(errors, "\n")
          for _, waiter in ipairs(waiters) do
            waiter(message)
          end
          return
        end
        self.prepared = true
        self.ensure_server(function(message)
          for _, waiter in ipairs(waiters) do
            waiter(message)
          end
        end)
      end,
    })
    self.prepare_job = exited and nil or job
    if job <= 0 then
      self.prepare_job = nil
      self.preparing = false
      local waiters = self.prepare_waiters
      self.prepare_waiters = {}
      for _, waiter in ipairs(waiters) do
        waiter("Failed to run " .. self.cmd .. " models --refresh")
      end
    end
  end

  function self.list_reasoning(callback)
    local function select_variants(models, message)
      if message then
        callback(nil, message)
        return
      end
      for _, model in ipairs(models) do
        if model.value == self.model then
          callback(model.variants)
          return
        end
      end
      callback(nil, "Selected model is unavailable: " .. tostring(self.model))
    end
    if self.models then
      select_variants(self.models)
    else
      self.list_models(select_variants)
    end
  end

  function self.list_models(callback)
    local ok_read, lines = pcall(vim.fn.readfile, self.auth_path)
    local ok_decode, credentials = pcall(vim.json.decode, ok_read and table.concat(lines, "\n") or "")
    if not ok_decode or type(credentials) ~= "table" then
      callback(nil, "Could not read OpenCode credentials from " .. self.auth_path)
      return
    end

    local providers = vim.tbl_keys(credentials)
    table.sort(providers)
    if #providers == 0 then
      callback(nil, "OpenCode has no authenticated providers")
      return
    end

    local models = {}
    local remaining = #providers
    local failed = false
    for _, provider_id in ipairs(providers) do
      local output = {}
      local errors = {}
      local command = { self.cmd, "models", "--verbose", provider_id }
      local job = vim.fn.jobstart(command, {
        stdout_buffered = true,
        stderr_buffered = true,
        on_stdout = function(_, data)
          output = data or {}
        end,
        on_stderr = function(_, data)
          errors = data or {}
        end,
        on_exit = function(_, code)
          if failed then
            return
          end
          if code ~= 0 then
            failed = true
            callback(nil, table.concat(errors, "\n"))
            return
          end
          for _, model in ipairs(parse_verbose_models(output)) do
            table.insert(models, model)
          end
          remaining = remaining - 1
          if remaining == 0 then
            table.sort(models, function(a, b)
              return a.value:lower() < b.value:lower()
            end)
            self.models = models
            callback(models)
          end
        end,
      })
      if job <= 0 and not failed then
        failed = true
        callback(nil, "Failed to run " .. self.cmd .. " models " .. provider_id)
      end
    end
  end

  function self.request(method, path, body, on_success, on_error)
    local command = {
      "curl",
      "-sS",
      "--fail-with-body",
      "-X",
      method,
      "-H",
      "Accept: application/json",
    }
    if path == "/global/health" then
      table.insert(command, 2, "--max-time")
      table.insert(command, 3, "1")
    end
    if body then
      table.insert(command, "-H")
      table.insert(command, "Content-Type: application/json")
      table.insert(command, "-d")
      table.insert(command, vim.json.encode(body))
    end
    table.insert(command, join_url(self.url, path))

    local output = {}
    local errors = {}
    local job = vim.fn.jobstart(command, {
      stdout_buffered = true,
      stderr_buffered = true,
      on_stdout = function(_, data)
        output = data or {}
      end,
      on_stderr = function(_, data)
        errors = data or {}
      end,
      on_exit = function(_, code)
        local text = table.concat(output, "\n")
        if code ~= 0 then
          on_error(table.concat(errors, "\n") .. (text ~= "" and "\n" .. text or ""))
          return
        end

        if text == "" then
          on_success(nil)
          return
        end

        local ok, value = pcall(vim.json.decode, text)
        if ok then
          on_success(value)
        else
          on_error("OpenCode returned invalid JSON: " .. text)
        end
      end,
    })

    if job <= 0 then
      on_error("Failed to start curl for OpenCode request")
    end
  end

  function self.list_sessions(directory, callback)
    self.ensure_server(function(message)
      if message then
        callback(nil, message)
        return
      end
      local path = with_directory("/session?roots=true&limit=100", directory)
      self.request("GET", path, nil, function(sessions)
        local owned = {}
        for _, session in ipairs(type(sessions) == "table" and sessions or {}) do
          local metadata = session.metadata or {}
          if metadata.client == "ask.nvim" or type(session.title) == "string" and session.title:match("^ask%.nvim:") then
            table.insert(owned, session)
          end
        end
        callback(owned)
      end, function(error)
        callback(nil, error)
      end)
    end)
  end

  function self.get_session_messages(session_id, directory, callback)
    self.ensure_server(function(message)
      if message then
        callback(nil, message)
        return
      end
      self.request("GET", with_directory("/session/" .. session_id .. "/message", directory), nil, function(messages)
        callback(type(messages) == "table" and messages or {})
      end, function(error)
        callback(nil, error)
      end)
    end)
  end

  function self.stop_events()
    if self.event_job then
      local job = self.event_job
      self.event_job = nil
      vim.fn.jobstop(job)
    end
  end

  function self.stop()
    self.stop_events()
    if self.prepare_job then
      local job = self.prepare_job
      self.prepare_job = nil
      vim.fn.jobstop(job)
    end
    if self.server_job then
      local job = self.server_job
      self.server_job = nil
      vim.fn.jobstop(job)
    end
    if self.managed_server then
      self.url = nil
    end
    self.starting = false
    self.preparing = false
  end

  function self.finish(session_id, callback)
    local request = self.active[session_id]
    if not request or request.finished then
      return
    end
    request.finished = true
    self.active[session_id] = nil
    callback(request)
    if active_count() == 0 then
      self.stop_events()
    end
  end

  function self.start_timeout(session_id)
    if self.timeout_ms <= 0 then
      return
    end
    vim.defer_fn(function()
      local request = self.active[session_id]
      if not request then
        return
      end
      self.finish(session_id, function(active)
        local message = "OpenCode request timed out after " .. math.floor(self.timeout_ms / 1000) .. " seconds"
        if active.last_error then
          message = message .. ": " .. active.last_error
        end
        active.on_error(message)
      end)
    end, self.timeout_ms)
  end

  function self.reply_to_permission(properties, choice)
    local session_id = properties.sessionID
    local permission_id = properties.id
    if not session_id or not permission_id then
      return
    end

    self.request(
      "POST",
      "/session/" .. session_id .. "/permissions/" .. permission_id,
      { response = choice },
      function() end,
      function(message)
        vim.notify("ask.nvim OpenCode permission reply failed: " .. message, vim.log.levels.ERROR)
      end
    )
  end

  function self.handle_event(event)
    local properties = event.properties or {}
    local session_id = event_session_id(properties)
    local request = session_id and self.active[session_id] or nil

    local status = properties.status
    local retrying = event.type == "session.retry"
      or event.type == "session.status" and type(status) == "table" and status.type == "retry"
    if request and retrying then
      request.last_error = error_message(properties) or request.last_error
      if request.on_status and request.last_error then
        request.on_status("OpenCode is retrying: " .. request.last_error)
      end
    end

    if event.type == "message.part.delta" and request and properties.field == "text" then
      response_delta(request, properties.delta or "")
    elseif event.type == "session.next.text.delta" and request then
      response_delta(request, properties.delta or "")
    elseif event.type == "session.idle" and request then
      self.finish(session_id, request.last_error and function(active)
        active.on_error(active.last_error)
      end or function(active)
        active.on_complete()
      end)
    elseif event.type == "session.error" and request then
      local error = properties.error or {}
      self.finish(session_id, function(active)
        active.on_error(error_message(error) or error_message(properties) or vim.inspect(error))
      end)
    elseif (event.type == "permission.asked" or event.type == "permission.v2.asked") and request then
      vim.schedule(function()
        vim.ui.select({ "Once", "Always", "Reject" }, {
          prompt = describe_permission(properties),
        }, function(choice)
          self.reply_to_permission(properties, (choice or "Reject"):lower())
        end)
      end)
    end
  end

  function self.start_events(on_error, directory)
    if self.event_job then
      return
    end

    self.event_lines = {}
    self.event_job = vim.fn.jobstart({ "curl", "-NsS", join_url(self.url, with_directory("/event", directory)) }, {
      stdout_buffered = false,
      on_stdout = function(_, data)
        for _, line in ipairs(data or {}) do
          if line == "" then
            local payload = table.concat(self.event_lines, "\n")
            self.event_lines = {}
            if payload ~= "" then
              local ok, event = pcall(vim.json.decode, payload)
              if ok and type(event) == "table" then
                self.handle_event(event)
              end
            end
          elseif line:sub(1, 5) == "data:" then
            local data = line:sub(6):gsub("^ ", "")
            table.insert(self.event_lines, data)
          end
        end
      end,
      on_exit = function(_, code)
        self.event_job = nil
        if code ~= 0 and active_count() > 0 then
          for session_id, request in pairs(self.active) do
            self.finish(session_id, function()
              request.on_error("OpenCode event stream exited with code " .. code)
            end)
          end
          on_error("OpenCode event stream exited with code " .. code)
        end
      end,
    })
  end

  function self.ensure_server(callback)
    if self.preparing then
      table.insert(self.prepare_waiters, callback)
      return
    end
    if self.managed_server then
      if not self.url then
        self.url = "http://127.0.0.1:" .. available_port()
      end
    end

    local function start_server(health_error)
      if not self.auto_start then
        callback("Cannot reach OpenCode at " .. tostring(self.url) .. ": " .. health_error)
        return
      end
      if self.starting then
        table.insert(self.server_waiters, callback)
        return
      end

      local host, port
      if self.url then
        host, port = self.url:match("^https?://([^:/]+):(%d+)$")
      end
      if not host or not port then
        callback("Cannot start OpenCode for a non-local server URL: " .. self.url)
        return
      end

      self.starting = true
      self.server_waiters = { callback }
      local server_errors = {}
      local database_dir = vim.fs.dirname(self.database_path)
      if database_dir and database_dir ~= "" then
        vim.fn.mkdir(database_dir, "p")
      end
      self.server_job = vim.fn.jobstart({ self.cmd, "serve", "--hostname", host, "--port", port }, {
        env = { OPENCODE_DB = self.database_path },
        stderr_buffered = true,
        on_stderr = function(_, data)
          server_errors = data or {}
        end,
        on_exit = function(job, code)
          local current_server = self.server_job == job
          if current_server then
            self.server_job = nil
          end
          if current_server and self.starting then
            self.starting = false
            local waiters = self.server_waiters
            self.server_waiters = {}
            local details = table.concat(server_errors, "\n"):gsub("\n+$", "")
            local message = "OpenCode server exited with code " .. code
            if details ~= "" then
              message = message .. ": " .. details
            end
            for _, waiter in ipairs(waiters) do
              waiter(message)
            end
          end
        end,
      })
      if self.server_job <= 0 then
        self.starting = false
        local waiters = self.server_waiters
        self.server_waiters = {}
        for _, waiter in ipairs(waiters) do
          waiter("Failed to start OpenCode server")
        end
        return
      end

      local attempts = 0
      local function wait_for_server()
        attempts = attempts + 1
        self.request("GET", "/global/health", nil, function()
          self.starting = false
          local waiters = self.server_waiters
          self.server_waiters = {}
          for _, waiter in ipairs(waiters) do
            waiter()
          end
        end, function()
          if attempts == 30 then
            self.starting = false
            local waiters = self.server_waiters
            self.server_waiters = {}
            for _, waiter in ipairs(waiters) do
              waiter("OpenCode server did not become ready at " .. self.url)
            end
          else
            vim.defer_fn(wait_for_server, 100)
          end
        end)
      end
      wait_for_server()
    end

    if self.managed_server and not self.server_job then
      start_server("managed server is not running")
    else
      self.request("GET", "/global/health", nil, function()
        callback()
      end, start_server)
    end
  end

  local function conversation_controller(options, session_id)
    local controller = { closed = false, session_id = session_id }
    local function send_prompt(next_prompt, next_callbacks)
      if controller.closed then
        return false, "conversation is closed"
      end
      if not controller.session_id then
        return false, "conversation is not ready"
      end
      if self.active[controller.session_id] then
        return false, "a response is already in progress"
      end

      next_callbacks.last_text = ""
      next_callbacks.keep_session = options.keep_session == true
      self.active[controller.session_id] = next_callbacks
      self.start_events(next_callbacks.on_error, options.directory)
      self.start_timeout(controller.session_id)
      local body = {
        parts = { { type = "text", text = next_prompt } },
      }
      local model = M.parse_model(self.model)
      if model then
        body.model = model
      end
      if self.reasoning then
        body.variant = self.reasoning
      end
      if self.agent then
        body.agent = self.agent
      end
      if self.system_prompt then
        body.system = self.system_prompt
      end
      if self.tools then
        body.tools = self.tools
      end

      self.request("POST", "/session/" .. controller.session_id .. "/prompt_async", body, function()
        -- The response arrives on the event stream.
      end, function(message)
        self.finish(controller.session_id, function(active)
          active.on_error(message)
        end)
      end)
      return true
    end

    function controller.prompt(next_prompt, next_callbacks)
      return send_prompt(next_prompt, next_callbacks)
    end

    function controller.close()
      if controller.closed then
        return
      end
      controller.closed = true
      if controller.session_id then
        if self.active[controller.session_id] then
          self.request("POST", "/session/" .. controller.session_id .. "/abort", nil, function() end, function() end)
        end
        self.finish(controller.session_id, function() end)
      end
    end
    controller.cancel = controller.close

    return controller
  end

  function self.attach(session_id, options)
    return conversation_controller(options or {}, session_id)
  end

  function self.ask(prompt, callbacks, options)
    options = options or {}
    local controller = conversation_controller(options)

    self.ensure_server(function(server_error)
      if controller.closed then
        return
      end
      if server_error then
        callbacks.on_error(server_error)
        return
      end

      self.start_events(callbacks.on_error, options.directory)
      local title = (options.title or prompt):gsub("[\r\n]+", " ")
      if #title > 80 then
        title = title:sub(1, 77) .. "..."
      end
      self.request("POST", with_directory("/session", options.directory), {
        title = "ask.nvim: " .. title,
        metadata = { client = "ask.nvim", schema = 1 },
      }, function(session)
        local session_id = session and session.id
        if type(session_id) ~= "string" then
          callbacks.on_error("OpenCode did not return a session id")
          return
        end
        controller.session_id = session_id

        if controller.closed then
          self.request("DELETE", "/session/" .. session_id, nil, function() end, function() end)
          return
        end

        controller.prompt(prompt, callbacks)
      end, callbacks.on_error)
    end)
    return controller
  end

  return self
end

return M
