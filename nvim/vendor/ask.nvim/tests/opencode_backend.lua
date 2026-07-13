local plugin_root = vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, "S").source:sub(2)))
vim.opt.runtimepath:append(plugin_root)

local ok, opencode = pcall(require, "ask.opencode")
assert(ok, "ask.opencode backend is unavailable")

local model = opencode.parse_model("openai/gpt-5.6-terra-pro")
assert(vim.deep_equal(model, {
  providerID = "openai",
  modelID = "gpt-5.6-terra-pro",
}), "provider/model must become an OpenCode model reference")

assert(opencode.parse_model(nil) == nil, "an unset model must use OpenCode's default")
assert(opencode.parse_model("gpt-5.6-terra-pro") == nil, "a model without a provider must use OpenCode's default")

local ask = require("ask")
assert(ask.config.providers.opencode, "ask.nvim must expose the OpenCode provider")

local original_jobstart = vim.fn.jobstart
local original_jobstop = vim.fn.jobstop
local event_handler
local prompt_body
local prompt_count = 0
local session_count = 0
local created_session_body
local requested_urls = {}
local deleted_session
local aborted_session
local next_job = 1
local auth_path = vim.fn.tempname()
local serve_command
local serve_exits = {}
local delay_health = false
local pending_health
local model_commands = {}
local stopped_job
vim.fn.writefile({ vim.json.encode({ openai = { type = "oauth" } }) }, auth_path)

vim.fn.jobstop = function(job)
  stopped_job = job
  return 1
end

vim.fn.jobstart = function(command, options)
  local job = next_job
  next_job = next_job + 1
  if command[2] == "models" then
    table.insert(model_commands, vim.deepcopy(command))
    if options.on_stdout then
      options.on_stdout(job, {
        "openai/beta", "{", '  "variants": { "high": {}, "low": {} }', "}",
        "openai/alpha", "{", '  "variants": { "xhigh": {}, "none": {}, "medium": {} }', "}", "",
      })
    end
    options.on_exit(job, 0)
    return job
  end
  if command[2] == "serve" then
    serve_command = command
    serve_exits[job] = options.on_exit
    return job
  end

  local url = command[#command]
  table.insert(requested_urls, url)

  if url:find("/global/health", 1, true) then
    if delay_health then
      pending_health = { job = job, options = options }
    else
      options.on_stdout(job, { '{"healthy":true}' })
      options.on_exit(job, 0)
    end
  elseif url:find("/event", 1, true) then
    event_handler = options.on_stdout
  elseif command[5] == "GET" and url:find("/session?", 1, true) then
    options.on_stdout(job, { vim.json.encode({ { id = "ses_history", title = "ask.nvim: Project question", metadata = { client = "ask.nvim" } } }) })
    options.on_exit(job, 0)
  elseif command[5] == "GET" and url:find("/session/ses_history/message", 1, true) then
    options.on_stdout(job, { vim.json.encode({
      { info = { role = "user" }, parts = { { type = "text", text = "Project question" } } },
      { info = { role = "assistant" }, parts = { { type = "text", text = "Project answer" } } },
    }) })
    options.on_exit(job, 0)
  elseif command[5] == "DELETE" and url:find("/session/ses_test", 1, true) then
    deleted_session = true
    options.on_stdout(job, { "true" })
    options.on_exit(job, 0)
  elseif url:find("/session/ses_test/abort", 1, true) then
    aborted_session = true
    options.on_stdout(job, { "true" })
    options.on_exit(job, 0)
  elseif url:find("/session", 1, true) and not url:find("prompt_async", 1, true) then
    session_count = session_count + 1
    for index, value in ipairs(command) do
      if value == "-d" then
        created_session_body = vim.json.decode(command[index + 1])
      end
    end
    options.on_stdout(job, { '{"id":"ses_test"}' })
    options.on_exit(job, 0)
  elseif url:find("prompt_async", 1, true) then
    prompt_count = prompt_count + 1
    for index, value in ipairs(command) do
      if value == "-d" then
        prompt_body = vim.json.decode(command[index + 1])
      end
    end
    options.on_stdout(job, { "" })
    options.on_exit(job, 0)
  end

  return job
end

local deltas = {}
local completed = false
local backend = opencode.new({
  url = "http://opencode.test:4096",
  managed_server = false,
  auto_start = false,
  auth_path = auth_path,
  model = "openai/gpt-5.6-terra-pro",
  reasoning = "high",
})
backend.ask("Read the current file if needed.", {
  on_delta = function(delta)
    table.insert(deltas, delta)
  end,
  on_complete = function()
    completed = true
  end,
  on_error = error,
})

assert(vim.deep_equal(prompt_body.model, {
  providerID = "openai",
  modelID = "gpt-5.6-terra-pro",
}), "the OpenCode request must include the selected model")
assert(prompt_body.parts[1].text == "Read the current file if needed.", "the prompt must be passed unchanged")
assert(prompt_body.variant == "high", "the OpenCode request must include the selected reasoning variant")
assert(created_session_body.metadata.client == "ask.nvim", "sessions must be marked as ask.nvim-owned")
assert(created_session_body.title:match("^ask%.nvim:"), "sessions must have an ask.nvim title prefix")

event_handler(1, {
  "data: " .. vim.json.encode({
    type = "message.part.delta",
    properties = { sessionID = "ses_test", field = "text", delta = "hello" },
  }),
  "",
})
event_handler(1, {
  "data: " .. vim.json.encode({
    type = "message.part.delta",
    properties = { sessionID = "ses_test", field = "text", delta = "." },
  }),
  "",
})
event_handler(1, {
  "data: " .. vim.json.encode({
    type = "message.part.delta",
    properties = { sessionID = "ses_test", field = "text", delta = "Next" },
  }),
  "",
})
event_handler(1, {
  "data: " .. vim.json.encode({
    type = "session.idle",
    properties = { sessionID = "ses_test" },
  }),
  "",
})

assert(vim.deep_equal(deltas, { "hello", ".", " Next" }), "text SSE events must preserve sentence spacing")
assert(completed, "an idle event must complete the request")
assert(not deleted_session, "completed ask.nvim sessions must remain available as history")

deleted_session = false
local cancelled = backend.ask("Cancel this request.", {
  on_delta = function() end,
  on_complete = function() error("a cancelled request must not complete") end,
  on_error = function() error("a cancelled request must not report an error") end,
})
cancelled.cancel()
assert(aborted_session, "cancelling must abort the active OpenCode request")
assert(not deleted_session, "cancelling must preserve the interrupted conversation in history")
assert(backend.active.ses_test == nil, "a cancelled request must be removed from active requests")

deleted_session = false
local retained_first = false
local retained_second = false
local retained = backend.ask("First turn.", {
  on_delta = function() end,
  on_complete = function() retained_first = true end,
  on_error = error,
}, { keep_session = true })
backend.handle_event({ type = "session.idle", properties = { sessionID = "ses_test" } })
assert(retained_first, "the first retained turn must complete")
assert(not deleted_session, "a retained conversation must survive between turns")
local sessions_before_followup = session_count
local prompts_before_followup = prompt_count
local followup_ok = retained.prompt("Clarify that.", {
  on_delta = function() end,
  on_complete = function() retained_second = true end,
  on_error = error,
})
assert(followup_ok, "a retained conversation must accept a follow-up")
assert(session_count == sessions_before_followup, "a follow-up must reuse the existing OpenCode session")
assert(prompt_count == prompts_before_followup + 1, "a follow-up must send one new prompt")
assert(prompt_body.parts[1].text == "Clarify that.", "the follow-up prompt must be passed unchanged")
local concurrent_ok, concurrent_error = retained.prompt("Too soon.", {
  on_delta = function() end,
  on_complete = function() end,
  on_error = error,
})
assert(not concurrent_ok and concurrent_error:find("in progress", 1, true), "concurrent follow-ups must be rejected")
backend.handle_event({ type = "session.idle", properties = { sessionID = "ses_test" } })
assert(retained_second, "the follow-up turn must complete independently")
retained.close()
assert(not deleted_session, "closing a conversation must preserve its OpenCode history")

local attached = backend.attach("ses_test", { directory = "/tmp/project" })
local sessions_before_attach = session_count
local attached_complete = false
local attached_ok = attached.prompt("Resume from history.", {
  on_delta = function() end,
  on_complete = function() attached_complete = true end,
  on_error = error,
})
assert(attached_ok, "a historical session must accept a follow-up")
assert(session_count == sessions_before_attach, "resuming history must not create a new session")
assert(prompt_body.parts[1].text == "Resume from history.", "historical follow-ups must use the existing session")
backend.handle_event({ type = "session.idle", properties = { sessionID = "ses_test" } })
assert(attached_complete, "a historical follow-up must complete normally")
attached.close()

local retry_status
local provider_error
backend.active.ses_error = {
  last_text = "",
  on_status = function(message) retry_status = message end,
  on_error = function(message) provider_error = message end,
  on_complete = function() error("a failed request must not complete") end,
}
backend.handle_event({
  type = "session.status",
  properties = {
    sessionID = "ses_error",
    status = { type = "retry", message = "Model not found gpt-5.6-luna" },
  },
})
assert(retry_status:find("Model not found gpt-5.6-luna", 1, true), "provider retries must be shown to the user")
backend.handle_event({ type = "session.idle", properties = { sessionID = "ses_error" } })
assert(provider_error == "Model not found gpt-5.6-luna", "an idle failed session must surface its provider error")

local timeout_error
local timeout_backend = opencode.new({
  url = "http://opencode.test:4096",
  managed_server = false,
  timeout_ms = 10,
})
timeout_backend.active.ses_timeout = {
  last_error = "Model not found gpt-5.6-luna",
  on_error = function(message) timeout_error = message end,
}
timeout_backend.start_timeout("ses_timeout")
assert(vim.wait(1000, function() return timeout_error ~= nil end), "stalled requests must time out")
assert(timeout_error:find("timed out", 1, true), "timeout errors must explain what happened")
assert(timeout_error:find("Model not found gpt-5.6-luna", 1, true), "timeout errors must include the last provider error")

local available_models
backend.list_models(function(models, message)
  assert(not message, message)
  available_models = models
end)
assert(vim.deep_equal(available_models, {
  { value = "openai/alpha", label = "openai / alpha", variants = { "none", "medium", "xhigh" } },
  { value = "openai/beta", label = "openai / beta", variants = { "low", "high" } },
}), "the picker must contain fresh CLI models from authenticated providers only")

backend.set_model("openai/alpha")
assert(backend.model == "openai/alpha", "model selection must remain in the ask.nvim backend")
local available_reasoning
backend.list_reasoning(function(variants)
  available_reasoning = variants
end)
assert(vim.deep_equal(available_reasoning, { "none", "medium", "xhigh" }), "reasoning levels must match the selected model")

local managed = opencode.new({ auth_path = auth_path })
local managed_error
local initial_model_command_count = #model_commands
managed.start(function(message)
  managed_error = message or false
end)
assert(managed_error == false, managed_error)
assert(vim.tbl_contains(model_commands[initial_model_command_count + 1], "--refresh"), "setup must refresh models before starting the server")
assert(serve_command[2] == "serve", "ask.nvim must start its own OpenCode server")
assert(serve_command[#serve_command] ~= "4096", "the managed server must not use OpenCode's shared default port")
assert(managed.url:match("^http://127%.0%.0%.1:%d+$"), "the managed server must use an ephemeral localhost URL")
local managed_job = managed.server_job
local model_command_count = #model_commands
managed.list_models(function(models, message)
  assert(models and not message, message)
end)
assert(#model_commands == model_command_count + 1, "the picker must query the existing model registry")
assert(not vim.tbl_contains(model_commands[#model_commands], "--refresh"), "the picker must not refresh models mid-session")
assert(managed.server_job == managed_job, "the picker must not restart the managed server")
managed.stop()
assert(stopped_job == managed_job, "the managed OpenCode server must be stopped explicitly")
serve_exits[managed_job](managed_job, 143)
assert(managed_error == false, "an intentional shutdown must not report exit code 143")

local state_path = vim.fn.tempname()
ask.setup({
  provider = "opencode",
  providers = { opencode = { state_path = state_path } },
})
ask._opencode = backend
local original_select = vim.ui.select
vim.ui.select = function(items, _, callback)
  callback(items[1])
end
ask.select_model()
vim.wait(1000, function()
  return vim.fn.filereadable(state_path) == 1
end)
local persisted = vim.json.decode(table.concat(vim.fn.readfile(state_path), "\n"))
assert(persisted.model == "openai/alpha", "ask.nvim must persist its selected model in its own state")
assert(persisted.reasoning == "none", "ask.nvim must persist its selected reasoning level")
ask.config.providers.opencode.model = nil
ask.setup({ providers = { opencode = { state_path = state_path } } })
assert(ask.config.providers.opencode.model == "openai/alpha", "setup must restore ask.nvim's persisted model")
assert(ask.config.providers.opencode.reasoning == "none", "setup must restore ask.nvim's persisted reasoning level")
ask.setup({ providers = { opencode = { state_path = state_path, model = "openai/beta" } } })
assert(ask.config.providers.opencode.model == "openai/beta", "an explicitly configured model must take priority")
ask.setup({ providers = { opencode = { state_path = state_path, reasoning = "high" } } })
assert(ask.config.providers.opencode.reasoning == "high", "an explicitly configured reasoning level must take priority")
local original_notify = vim.notify
local status
vim.notify = function(message)
  status = message
end
ask.show_status()
assert(status:find("model=openai/alpha", 1, true), "status must show the selected model")
assert(status:find("reasoning=high", 1, true), "status must show the selected reasoning level")
vim.notify = original_notify
vim.ui.select = original_select
assert(vim.fn.exists(":Ask") == 0, "the plugin command should not exist before plugin loading in this test")
dofile(vim.fs.joinpath(plugin_root, "plugin", "ask.lua"))
assert(vim.fn.exists(":Ask") == 2, "the plugin must expose the :Ask command")
assert(vim.fn.exists(":ASKM") == 0, "legacy abbreviated commands must be removed")

ask.query("Transcript question")
local response_buf = vim.api.nvim_get_current_buf()
local response_win = vim.api.nvim_get_current_win()
local response_lines = vim.api.nvim_buf_get_lines(response_buf, 0, -1, false)
assert(response_lines[1] == "## You", "the initial prompt must use transcript syntax")
assert(vim.tbl_contains(response_lines, "## Assistant"), "the initial response must have an Assistant heading")
assert(response_lines[#response_lines]:find("Press `a`", 1, true), "response windows must show the follow-up hint")
assert(not vim.bo[response_buf].modifiable, "response transcripts must not look like editable buffers")
assert(vim.bo[response_buf].syntax == "markdown", "response transcripts must enable Markdown highlighting")
assert(vim.fn.maparg("a", "n", false, true).buffer == 1, "response windows must map a to follow-up")
backend.handle_event({ type = "session.idle", properties = { sessionID = "ses_test" } })
vim.wait(1000, function() return not ask._conversations[response_buf].busy end)
vim.api.nvim_win_set_cursor(response_win, { 1, 0 })
ask.followup("One more detail.", response_buf)
assert(vim.api.nvim_win_get_cursor(response_win)[1] == vim.api.nvim_buf_line_count(response_buf), "adding a follow-up must scroll to the bottom")
backend.handle_event({ type = "session.idle", properties = { sessionID = "ses_test" } })
vim.api.nvim_win_close(response_win, true)

local original_cwd = vim.fn.getcwd()
local project = vim.fn.tempname()
local nested = project .. "/src"
local other = vim.fn.tempname()
vim.fn.mkdir(project .. "/.git", "p")
vim.fn.mkdir(nested, "p")
vim.fn.mkdir(other, "p")
vim.fn.chdir(nested)
ask.show_history()
vim.wait(1000, function() return requested_urls[#requested_urls]:find("/session?", 1, true) ~= nil end)
assert(requested_urls[#requested_urls]:find(vim.uri_encode(project), 1, true), "history must query the nearest Git project root")
vim.fn.chdir(other)
ask.show_history()
vim.wait(1000, function() return requested_urls[#requested_urls]:find(vim.uri_encode(other), 1, true) ~= nil end)
assert(requested_urls[#requested_urls]:find(vim.uri_encode(other), 1, true), "history must fall back to the current directory")
vim.fn.chdir(original_cwd)
vim.fn.delete(project, "rf")
vim.fn.delete(other, "rf")
vim.fn.delete(state_path)
vim.fn.delete(auth_path)

vim.fn.jobstart = original_jobstart
vim.fn.jobstop = original_jobstop
