return {
  {
    dependencies = { { "saghen/blink.compat", version = "2.*" } },
    "ThePrimeagen/99",
    config = function()
      local _99 = require("99")

      local state_path = vim.fs.joinpath(vim.fn.stdpath("state"), "99-state.json")

      local function read_state()
        local ok, lines = pcall(vim.fn.readfile, state_path)
        if not ok or type(lines) ~= "table" or #lines == 0 then
          return {}
        end

        local ok_decode, decoded = pcall(vim.json.decode, table.concat(lines, "\n"))
        if not ok_decode or type(decoded) ~= "table" then
          return {}
        end

        return decoded
      end

      local function save_state(state)
        local dir = vim.fs.dirname(state_path)
        if dir and dir ~= "" then
          vim.fn.mkdir(dir, "p")
        end

        local ok_encode, encoded = pcall(vim.json.encode, state)
        if not ok_encode then
          return
        end

        pcall(vim.fn.writefile, { encoded }, state_path)
      end

      local function current_from_runtime(kind)
        local getter = kind == "model" and _99.get_model or _99.get_provider
        if type(getter) == "function" then
          local ok, value = pcall(getter)
          if ok and type(value) == "string" and value ~= "" then
            return value
          end
        end

        local state = rawget(_99, "state")
        if type(state) == "table" and type(state[kind]) == "string" and state[kind] ~= "" then
          return state[kind]
        end

        local config = rawget(_99, "config")
        if type(config) == "table" and type(config[kind]) == "string" and config[kind] ~= "" then
          return config[kind]
        end

        local opts = rawget(_99, "opts")
        if type(opts) == "table" and type(opts[kind]) == "string" and opts[kind] ~= "" then
          return opts[kind]
        end

        return nil
      end

      local persisted_state = read_state()

      local setup_opts = {
        tmp_dir = "./tmp",

        completion = {
          custom_rules = {
            "scratch/custom_rules/",
          },

          --- Configure @file completion (all fields optional, sensible defaults)
          files = {
            -- enabled = true,
            -- max_file_size = 102400,     -- bytes, skip files larger than this
            -- max_files = 5000,            -- cap on total discovered files
            -- exclude = { ".env", ".env.*", "node_modules", ".git", ... },
          },

          source = "blink",
        },

        md_files = {
          "AGENT.md",
        },
      }

      if type(persisted_state.provider) == "string" and persisted_state.provider ~= "" then
        setup_opts.provider = persisted_state.provider
      end

      if type(persisted_state.model) == "string" and persisted_state.model ~= "" then
        setup_opts.model = persisted_state.model
      end

      _99.setup(setup_opts)

      local function persist_kind(kind, explicit_value)
        local value = explicit_value
        if type(value) ~= "string" or value == "" then
          value = current_from_runtime(kind)
        end

        if type(value) ~= "string" or value == "" then
          return
        end

        persisted_state[kind] = value
        save_state(persisted_state)
      end

      vim.keymap.set("v", "<leader>9v", function()
        _99.visual()
      end, { desc = "Use 99 with visual selection" })

      --- if you have a request you dont want to make any changes, just cancel it
      vim.keymap.set("n", "<leader>9x", function()
        _99.stop_all_requests()
      end, { desc = "Stop all 99 requests" })

      vim.keymap.set("n", "<leader>9s", function()
        _99.search()
      end, { desc = "Search with 99" })

      -- Wrap set_model/set_provider so we persist state on every selection,
      -- regardless of how it's triggered (fzf, telescope, API, etc.)
      local orig_set_model = _99.set_model
      _99.set_model = function(...)
        local ret = orig_set_model(...)
        vim.schedule(function()
          persist_kind("model")
        end)
        return ret
      end

      local orig_set_provider = _99.set_provider
      _99.set_provider = function(...)
        local ret = orig_set_provider(...)
        vim.schedule(function()
          persist_kind("provider")
          -- provider change may also reset the model
          persist_kind("model")
        end)
        return ret
      end

      vim.keymap.set("n", "<leader>9m", function()
        require("99.extensions.fzf_lua").select_model()
      end, {
        desc = "Select 99 model with fzf",
      })

      vim.keymap.set("n", "<leader>9p", function()
        require("99.extensions.fzf_lua").select_provider()
      end, {
        desc = "Select 99 provider with fzf",
      })
    end,
  },
}
