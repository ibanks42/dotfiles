local M = {}
M.version = "0.2.0-local"

M._conversations = {}

local DEFAULT_SYSTEM_PROMPT =
	"You are a helpful coding assistant. Answer only based on the code provided in the user message."

M.config = {
	provider = "claude",
	width = 0.6,
	height = 0.6,
	context = {
		current_file = {
			enabled = false,
		},
	},
	providers = {
		claude = {
			cmd = "claude",
			auth = nil, -- must be set to "api-key" or "oauth" in setup()
			model = nil, -- e.g. "sonnet", "opus", "claude-sonnet-4-6"
			system_prompt = nil, -- nil = use default for oauth, omit for api-key
			build_cmd = function(cmd, prompt)
				local claude_cfg = M.config.providers.claude
				local parts = { "echo", vim.fn.shellescape(prompt), "|", cmd }

				if claude_cfg.auth == "api-key" then
					table.insert(parts, "--bare")
				end

				table.insert(
					parts,
					"-p --verbose --output-format stream-json --include-partial-messages --no-session-persistence"
				)

				if claude_cfg.auth == "oauth" then
					table.insert(parts, "--tools ''")
				end

				if claude_cfg.model then
					table.insert(parts, "--model " .. claude_cfg.model)
				end

				-- system prompt: explicit config wins, otherwise default for oauth only
				local sp = claude_cfg.system_prompt
				if sp then
					table.insert(parts, "--system-prompt " .. vim.fn.shellescape(sp))
				elseif claude_cfg.auth == "oauth" then
					table.insert(parts, "--system-prompt " .. vim.fn.shellescape(DEFAULT_SYSTEM_PROMPT))
				end

				return table.concat(parts, " ")
			end,
			parse = function(event)
				if event.type == "stream_event" and event.event then
					local ev = event.event
					if ev.type == "content_block_delta" and ev.delta and ev.delta.text then
						return ev.delta.text
					end
				end
				return nil
			end,
			parse_usage = function(event)
				if event.type == "result" and event.usage then
					local model = "unknown"
					if event.modelUsage then
						for k, _ in pairs(event.modelUsage) do
							model = k
							break
						end
					end
					return string.format(
						"model: %s | tokens: %d in / %d out | cost: $%.4f",
						model,
						event.usage.input_tokens or 0,
						event.usage.output_tokens or 0,
						event.total_cost_usd or 0
					)
				end
				return nil
			end,
		},
		codex = {
			cmd = "codex",
			model = nil, -- e.g. "o3", "o4-mini"
			system_prompt = nil, -- prepended to prompt when set
			build_cmd = function(cmd, prompt)
				local codex_cfg = M.config.providers.codex
				local sp = codex_cfg.system_prompt
				if sp and sp ~= "" then
					prompt = sp .. "\n\n" .. prompt
				end
				local base = string.format("echo %s | %s exec --json -s read-only", vim.fn.shellescape(prompt), cmd)
				if codex_cfg.model then
					base = base .. " -m " .. codex_cfg.model
				end
				return base
			end,
			parse = function(event)
				if event.type == "item.completed" and event.item then
					local text = event.item.text
					if text and text ~= "" then
						return text
					end
				end
				return nil
			end,
			parse_usage = function(event)
				if event.type == "turn.completed" and event.usage then
					local model = M.config.providers.codex.model or "default"
					return string.format(
						"model: %s | tokens: %d in (%d cached) / %d out",
						model,
						event.usage.input_tokens or 0,
						event.usage.cached_input_tokens or 0,
						event.usage.output_tokens or 0
					)
				end
				return nil
			end,
		},
		opencode = {
			cmd = "opencode",
			url = nil,
			managed_server = true,
			auto_start = true,
			database_path = nil,
			state_path = nil,
			auth_path = nil,
			model = nil, -- provider/model, e.g. "openai/gpt-5.6-terra-pro"
			reasoning = nil,
			timeout_ms = 120000,
			agent = nil,
			system_prompt = nil,
			tools = nil,
		},
	},
}

local function project_directory()
	local cwd = vim.fn.getcwd()
	local name = vim.api.nvim_buf_get_name(0)
	local start = name ~= "" and vim.fs.dirname(name) or cwd
	local marker = vim.fs.find(".git", { path = start, upward = true })[1]
	if not marker and start ~= cwd then
		marker = vim.fs.find(".git", { path = cwd, upward = true })[1]
	end
	return marker and vim.fs.dirname(marker) or cwd
end

local function opencode_state_path()
	return M.config.providers.opencode.state_path or vim.fs.joinpath(vim.fn.stdpath("state"), "ask-opencode.json")
end

local function load_opencode_state()
	local ok, lines = pcall(vim.fn.readfile, opencode_state_path())
	if not ok or type(lines) ~= "table" or #lines == 0 then
		return {}
	end

	local ok_decode, state = pcall(vim.json.decode, table.concat(lines, "\n"))
	if ok_decode and type(state) == "table" then
		return state
	end
	return {}
end

local function save_opencode_state(model, reasoning)
	local path = opencode_state_path()
	local dir = vim.fs.dirname(path)
	if dir and dir ~= "" then
		vim.fn.mkdir(dir, "p")
	end
	pcall(vim.fn.writefile, { vim.json.encode({ model = model, reasoning = reasoning }) }, path)
end

function M.setup(opts)
	opts = opts or {}
	local configured_model = opts.providers
		and opts.providers.opencode
		and type(opts.providers.opencode.model) == "string"
		and opts.providers.opencode.model ~= ""
	local configured_reasoning = opts.providers
		and opts.providers.opencode
		and type(opts.providers.opencode.reasoning) == "string"
		and opts.providers.opencode.reasoning ~= ""
	M.config = vim.tbl_deep_extend("force", M.config, opts)
	local opencode_state = load_opencode_state()
	if not configured_model then
		M.config.providers.opencode.model = opencode_state.model or M.config.providers.opencode.model
	end
	if not configured_reasoning then
		M.config.providers.opencode.reasoning = opencode_state.reasoning or M.config.providers.opencode.reasoning
	end

	vim.api.nvim_create_autocmd("VimLeavePre", {
		group = vim.api.nvim_create_augroup("AskOpenCodeLifecycle", { clear = true }),
		callback = function()
			if M._opencode then
				M._opencode.stop()
			end
		end,
	})
	if M.config.provider == "opencode" and not M._opencode then
		M._opencode = require("ask.opencode").new(M.config.providers.opencode)
		M._opencode.start(function(message)
			if message then
				vim.schedule(function()
					vim.notify("ask.nvim: " .. message, vim.log.levels.ERROR)
				end)
			end
		end)
	end
end

--- Open a floating scratch buffer and return buf, win
local function open_float()
	local buf = vim.api.nvim_create_buf(false, true)
	vim.bo[buf].buftype = "nofile"
	vim.bo[buf].filetype = "markdown"
	vim.bo[buf].syntax = "markdown"
	local width = math.floor(vim.o.columns * M.config.width)
	local height = math.floor(vim.o.lines * M.config.height)
	local win = vim.api.nvim_open_win(buf, true, {
		relative = "editor",
		width = width,
		height = height,
		col = math.floor((vim.o.columns - width) / 2),
		row = math.floor((vim.o.lines - height) / 2),
		style = "minimal",
		border = "rounded",
		title = " Ask ",
		title_pos = "center",
	})

	vim.wo[win].wrap = true
	vim.wo[win].linebreak = true

	-- q to close
	vim.keymap.set("n", "q", function()
		if vim.api.nvim_win_is_valid(win) then
			vim.api.nvim_win_close(win, true)
		end
	end, { buffer = buf, nowait = true })

	return buf, win
end

--- Append text lines to buffer, scrolling to bottom
local function append_to_buf(buf, win, text)
	local lines = vim.split(text, "\n", { plain = true })
	-- Merge with last line (streaming partial lines)
	local last = vim.api.nvim_buf_line_count(buf)
	local last_line = vim.api.nvim_buf_get_lines(buf, last - 1, last, false)[1] or ""
	lines[1] = last_line .. lines[1]
	vim.api.nvim_buf_set_lines(buf, last - 1, last, false, lines)
	-- Scroll to bottom
	if vim.api.nvim_win_is_valid(win) then
		vim.api.nvim_win_set_cursor(win, { vim.api.nvim_buf_line_count(buf), 0 })
	end
end

local function set_buf_text(buf, text)
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(tostring(text), "\n", { plain = true }))
end

local function prompt_with_current_file(prompt)
	local current_file = M.config.context.current_file or {}
	if not current_file.enabled then
		return prompt
	end

	local name = vim.api.nvim_buf_get_name(0)
	if name == "" then
		return prompt
	end

	return table.concat({
		prompt,
		"",
		"Current file: " .. name,
		"The file contents are not included in this prompt. Read the file only if you need more context.",
	}, "\n")
end

local function opencode_backend()
	local opencode = require("ask.opencode")
	M._opencode = M._opencode or opencode.new(M.config.providers.opencode)
	return M._opencode
end

function M.select_model()
	if M.config.provider ~= "opencode" then
		vim.notify("ask.nvim: model selection is only available for the OpenCode provider", vim.log.levels.WARN)
		return
	end

	local backend = opencode_backend()
	backend.list_models(function(models, message)
		vim.schedule(function()
			if message then
				vim.notify("ask.nvim: " .. tostring(message), vim.log.levels.ERROR)
				return
			end

			vim.ui.select(models, {
				prompt = "ask.nvim model",
				format_item = function(item)
					local selected = item.value == backend.model and "* " or "  "
					return selected .. item.label .. " (" .. item.value .. ")"
				end,
			}, function(item)
				if item then
					backend.set_model(item.value)
					M.config.providers.opencode.model = item.value
					save_opencode_state(item.value, backend.reasoning)
					vim.notify("ask.nvim model: " .. item.value)
					M.select_reasoning()
				end
			end)
		end)
	end)
end

function M.select_reasoning()
	if M.config.provider ~= "opencode" then
		vim.notify("ask.nvim: reasoning selection is only available for the OpenCode provider", vim.log.levels.WARN)
		return
	end

	local backend = opencode_backend()
	if not backend.model then
		vim.notify("ask.nvim: select a model with :Ask model first", vim.log.levels.WARN)
		return
	end
	backend.list_reasoning(function(variants, message)
		vim.schedule(function()
			if message then
				vim.notify("ask.nvim: " .. tostring(message), vim.log.levels.ERROR)
				return
			end
			if #variants == 0 then
				vim.notify("ask.nvim: selected model has no reasoning levels", vim.log.levels.WARN)
				return
			end
			vim.ui.select(variants, {
				prompt = "ask.nvim reasoning",
				format_item = function(item)
					return (item == backend.reasoning and "* " or "  ") .. item
				end,
			}, function(item)
				if item then
					backend.set_reasoning(item)
					M.config.providers.opencode.reasoning = item
					save_opencode_state(backend.model, item)
					vim.notify("ask.nvim reasoning: " .. item)
				end
			end)
		end)
	end)
end

function M.show_status()
	local provider = M.config.provider
	if provider == "opencode" then
		local config = M.config.providers.opencode
		vim.notify(string.format(
			"ask.nvim: provider=%s | model=%s | reasoning=%s",
			provider,
			config.model or "OpenCode default",
			config.reasoning or "model default"
		))
		return
	end

	local config = M.config.providers[provider] or {}
	vim.notify(string.format(
		"ask.nvim: provider=%s | model=%s",
		provider,
		config.model or "provider default"
	))
end

--- Ask a follow-up in the OpenCode conversation attached to a response buffer
function M.followup(prompt, buf)
	buf = buf or vim.api.nvim_get_current_buf()
	local conversation = M._conversations[buf]
	if not conversation then
		vim.notify("ask.nvim: current buffer has no active conversation", vim.log.levels.WARN)
		return
	end
	if not prompt or prompt == "" then
		vim.ui.input({ prompt = "Follow-up: " }, function(input)
			if input and input ~= "" then
				M.followup(input, buf)
			end
		end)
		return
	end
	conversation.submit(prompt)
end

local FOLLOWUP_FOOTER = { "", "---", "", "_Press `a` to ask a follow-up._" }

local function update_response_buf(buf, callback)
	if not vim.api.nvim_buf_is_valid(buf) then
		return
	end
	vim.bo[buf].modifiable = true
	callback()
	vim.bo[buf].modifiable = false
end

local function replace_current_answer(buf, text)
	update_response_buf(buf, function()
		local count = vim.api.nvim_buf_line_count(buf)
		vim.api.nvim_buf_set_lines(buf, count - 5, count - 4, false, vim.split(tostring(text), "\n", { plain = true }))
	end)
end

local function append_current_answer(buf, win, text)
	update_response_buf(buf, function()
		local count = vim.api.nvim_buf_line_count(buf)
		local index = count - 5
		local current = vim.api.nvim_buf_get_lines(buf, index, index + 1, false)[1] or ""
		local lines = vim.split(text, "\n", { plain = true })
		lines[1] = current .. lines[1]
		vim.api.nvim_buf_set_lines(buf, index, index + 1, false, lines)
	end)
	if vim.api.nvim_win_is_valid(win) then
		vim.api.nvim_win_set_cursor(win, { vim.api.nvim_buf_line_count(buf), 0 })
	end
end

local function begin_transcript(buf, prompt)
	local lines = { "## You", "" }
	vim.list_extend(lines, vim.split(prompt, "\n", { plain = true }))
	vim.list_extend(lines, { "", "---", "", "## Assistant", "", "Thinking..." })
	vim.list_extend(lines, FOLLOWUP_FOOTER)
	update_response_buf(buf, function()
		vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	end)
end

local function append_transcript_turn(buf, win, prompt)
	update_response_buf(buf, function()
		local count = vim.api.nvim_buf_line_count(buf)
		vim.api.nvim_buf_set_lines(buf, count - #FOLLOWUP_FOOTER, count, false, {})
		local lines = { "", "---", "", "## You", "" }
		vim.list_extend(lines, vim.split(prompt, "\n", { plain = true }))
		vim.list_extend(lines, { "", "---", "", "## Assistant", "", "Thinking..." })
		vim.list_extend(lines, FOLLOWUP_FOOTER)
		vim.api.nvim_buf_set_lines(buf, -1, -1, false, lines)
	end)
	if vim.api.nvim_win_is_valid(win) then
		vim.api.nvim_win_set_cursor(win, { vim.api.nvim_buf_line_count(buf), 0 })
	end
end

local function attach_response_conversation(buf, win, request, directory, busy)
	local conversation = { busy = busy == true, closed = false, request = request }
	M._conversations[buf] = conversation

	local function close_conversation()
		if conversation.closed then
			return
		end
		conversation.closed = true
		M._conversations[buf] = nil
		if conversation.request then
			conversation.request.close()
		end
	end
	vim.api.nvim_create_autocmd("BufWipeout", { buffer = buf, once = true, callback = close_conversation })
	vim.api.nvim_create_autocmd("WinClosed", { pattern = tostring(win), once = true, callback = close_conversation })
	vim.keymap.set("n", "a", function()
		M.followup(nil, buf)
	end, { buffer = buf, silent = true, desc = "Ask a follow-up" })

	local function callbacks_for()
		local got_content = false
		return {
			on_status = function(message)
				vim.schedule(function()
					if not got_content then
						replace_current_answer(buf, message)
					end
				end)
			end,
			on_delta = function(text)
				vim.schedule(function()
					if not text or text == "" then
						return
					end
					if not got_content then
						got_content = true
						replace_current_answer(buf, "")
					end
					append_current_answer(buf, win, text)
				end)
			end,
			on_complete = function()
				vim.schedule(function()
					conversation.busy = false
					if not got_content then
						replace_current_answer(buf, "No response received.")
					end
				end)
			end,
			on_error = function(message)
				vim.schedule(function()
					conversation.busy = false
					replace_current_answer(buf, "Error: " .. tostring(message))
				end)
			end,
		}
	end

	function conversation.submit(followup_prompt)
		if conversation.closed then
			return
		end
		if conversation.busy then
			vim.notify("ask.nvim: a response is already in progress", vim.log.levels.WARN)
			return
		end
		local ok, message = conversation.request.prompt(followup_prompt, callbacks_for())
		if not ok then
			vim.notify("ask.nvim: " .. message, vim.log.levels.WARN)
			return
		end
		conversation.busy = true
		append_transcript_turn(buf, win, followup_prompt)
	end

	return conversation, callbacks_for
end

--- Send a prompt to the configured provider and stream the response into a float
function M.query(prompt, context)
	if not prompt or prompt == "" then
		vim.notify("ask.nvim: no prompt provided", vim.log.levels.WARN)
		return
	end

	local provider = M.config.providers[M.config.provider]
	if not provider then
		vim.notify("ask.nvim: unknown provider '" .. M.config.provider .. "'", vim.log.levels.ERROR)
		return
	end
	local query_directory = project_directory()

	-- Check auth is configured for claude
	if M.config.provider == "claude" and not provider.auth then
		local buf, win = open_float()
		vim.api.nvim_buf_set_lines(buf, 0, -1, false, {
			"Auth not configured.",
			"",
			"Set auth in your setup():",
			"",
			'  require("ask").setup({',
			'      providers = { claude = { auth = "api-key" } }',
			"  })",
			"",
			'Options: "api-key" or "oauth"',
		})
		return
	end

	local full_prompt = prompt
	if context and context ~= "" then
		full_prompt = "Here is the relevant code:\n```\n" .. context .. "\n```\n\n" .. prompt
	else
		full_prompt = prompt_with_current_file(prompt)
	end

	local buf, win = open_float()
	vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "Thinking..." })

	local got_content = false
	local partial_line = ""
	local usage_line = nil
	local response_parts = {}

	if M.config.provider == "opencode" then
		begin_transcript(buf, prompt)
		local conversation, callbacks_for = attach_response_conversation(buf, win, nil, query_directory, true)
		local request = opencode_backend().ask(full_prompt, callbacks_for(), {
			keep_session = true,
			directory = query_directory,
			title = prompt,
		})
		conversation.request = request
		return
	end

	local cmd = provider.build_cmd(provider.cmd, full_prompt)

	vim.fn.jobstart(cmd, {
		stdout_buffered = false,
		on_stdout = function(_, data)
			vim.schedule(function()
				if not vim.api.nvim_buf_is_valid(buf) then
					return
				end
				for _, chunk in ipairs(data) do
					partial_line = partial_line .. chunk
					if partial_line == "" then
						goto continue
					end
					local ok, event = pcall(vim.json.decode, partial_line)
					if not ok then
						goto continue
					end
					partial_line = ""
					local text = provider.parse(event)
					if text then
						if not got_content then
							got_content = true
							vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "" })
						end
						append_to_buf(buf, win, text)
						table.insert(response_parts, text)
					end
					local usage = provider.parse_usage(event)
					if usage then
						usage_line = usage
					end
					::continue::
				end
			end)
		end,
		stderr_buffered = true,
		on_stderr = function(_, _) end,
		on_exit = function(_, code)
			vim.schedule(function()
				if not vim.api.nvim_buf_is_valid(buf) then
					return
				end
				if code ~= 0 then
					set_buf_text(buf, "Error: " .. M.config.provider .. " exited with code " .. code)
				elseif not got_content then
					set_buf_text(buf, "No response received.")
				end
				if usage_line then
					append_to_buf(buf, win, "\n\n---\n" .. usage_line)
				end
			end)
		end,
	})
end

--- Get lines by range from current buffer
local function get_lines(line1, line2)
	local lines = vim.api.nvim_buf_get_lines(0, line1 - 1, line2, false)
	if #lines == 0 then
		return nil
	end
	return table.concat(lines, "\n")
end

--- Query with visual selection as context
function M.query_visual(prompt, line1, line2)
	local selection = get_lines(line1, line2)
	M.query(prompt, selection)
end

local function render_conversation(messages)
	local lines = {}
	for _, message in ipairs(messages) do
		local info = message.info or {}
		local role = info.role == "user" and "You" or info.role == "assistant" and "Assistant" or nil
		local text = {}
		for _, part in ipairs(message.parts or {}) do
			if part.type == "text" and type(part.text) == "string" and part.text ~= "" then
				table.insert(text, part.text)
			end
		end
		if role and #text > 0 then
			if #lines > 0 then
				table.insert(lines, "")
				table.insert(lines, "---")
				table.insert(lines, "")
			end
			table.insert(lines, "## " .. role)
			table.insert(lines, "")
			vim.list_extend(lines, vim.split(table.concat(text, "\n"), "\n", { plain = true }))
		end
	end
	return #lines > 0 and lines or { "No messages in this conversation." }
end

local function open_history_session(session, directory)
	opencode_backend().get_session_messages(session.id, directory, function(messages, message)
		vim.schedule(function()
			if message then
				vim.notify("ask.nvim: " .. tostring(message), vim.log.levels.ERROR)
				return
			end
			local buf, win = open_float()
			local lines = render_conversation(messages)
			vim.list_extend(lines, FOLLOWUP_FOOTER)
			vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
			vim.bo[buf].modifiable = false
			local request = opencode_backend().attach(session.id, { directory = directory })
			attach_response_conversation(buf, win, request, directory, false)
		end)
	end)
end

--- Show project-scoped OpenCode conversations, select with <CR> to view a transcript
function M.show_history(prompt_num)
	if M.config.provider ~= "opencode" then
		vim.notify("ask.nvim: history is available for the OpenCode provider", vim.log.levels.WARN)
		return
	end
	local directory = project_directory()
	opencode_backend().list_sessions(directory, function(sessions, message)
		vim.schedule(function()
			if message then
				vim.notify("ask.nvim: " .. tostring(message), vim.log.levels.ERROR)
				return
			end
			if #sessions == 0 then
				vim.notify("ask.nvim: no history yet", vim.log.levels.INFO)
				return
			end
			if prompt_num then
				if not sessions[prompt_num] then
					vim.notify("ask.nvim: no history with that number exists")
					return
				end
				open_history_session(sessions[prompt_num], directory)
				return
			end

			local buf, win = open_float()
			local display_lines = {}
			for i, session in ipairs(sessions) do
				local title = (session.title or "Untitled conversation"):gsub("^ask%.nvim:%s*", "")
				table.insert(display_lines, string.format(" %d. %s", i, title))
			end
			vim.api.nvim_buf_set_lines(buf, 0, -1, false, display_lines)
			vim.bo[buf].modifiable = false
			vim.keymap.set("n", "<CR>", function()
				local session = sessions[vim.api.nvim_win_get_cursor(win)[1]]
				if session then
					vim.api.nvim_win_close(win, true)
					open_history_session(session, directory)
				end
			end, { buffer = buf, nowait = true })
		end)
	end)
end

return M
