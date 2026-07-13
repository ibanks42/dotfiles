# ask.nvim

A Neovim plugin for brief one-line questions to a coding agent.
No file edits, no tool use, no piping your entire root directory as context — just a question and an answer in a floating window.

The addiction of being able to accept a 10,000 line change from an agent got too much.
I realised that they want you to accept the changes, even if not prompted to make changes, and if you have always accept enabled, they will just run wild.

Coding agents are great for helping you understand code or answering quick questions like "How do I read files in python".
This plugin limits interaction to exactly that (Also, ironically: Written with claude).

I don't think this is the perfect solution by any means (that would be willpower)  
But as an experiment I think limiting my token spend on explanations/knowledge can't be a bad idea. 

## Requirements

- [Claude CLI](https://github.com/anthropics/claude-code) and/or [Codex CLI](https://github.com/openai/codex)
- Set your API key as an environment variable in your shell profile if needed (OAuth users will not need to):
  ```sh
  # ~/.zshrc or ~/.bashrc
  export ANTHROPIC_API_KEY="sk-..."   # for claude
  export OPENAI_API_KEY="sk-..."      # for codex
  ```

## Install

lazy.nvim:

```lua
{
    "zaderrr/ask.nvim",
    config = function()
        require("ask").setup({})
    end,
}
```

## Config

Defaults:

```lua
require("ask").setup({
    provider = "claude",  -- "claude" or "codex"
    width = 0.6,
    height = 0.6,
})
```

If using Claude, you must set `auth`. See [Claude auth](#claude-auth) below.

### Claude auth

You must set `auth` in your setup. The plugin will not run without it.

If you're using an API key (via `ANTHROPIC_API_KEY`), set `auth = "api-key"`. This uses `--bare` mode for the leanest requests.

If you're authenticated via OAuth, set `auth = "oauth"`. This disables `--bare` and adds a default system prompt and `--tools ''` to prevent tool use.
This is because `--bare` is not available to oauth users. So a system prompt is prepended to the prompt. See below for configuring system prompt.

```lua
-- API key
require("ask").setup({
    providers = { claude = { auth = "api-key" } }
})

-- OAuth
require("ask").setup({
    providers = { claude = { auth = "oauth" } }
})
```

### Custom system prompt

By default, no system prompt is provided to codex, and when authenticated with oauth Claude uses:  
`You are a helpful coding assistant. Answer only based on the code provided in the user message.`

Both providers support a custom system prompt:

```lua
-- Claude: works with either auth mode
require("ask").setup({
    providers = {
        claude = {
            system_prompt = "Be concise. Answer in bullet points.",
        }
    }
})

-- Codex: prepended to the user prompt
require("ask").setup({
    provider = "codex",
    providers = {
        codex = {
            system_prompt = "Be concise. Answer in bullet points.",
        }
    }
})
```

**Claude with `api-key` auth:** no system prompt is sent by default (bare mode). Setting one adds `--system-prompt` to the command.

**Claude with `oauth` auth:** a default system prompt is used. Setting one overrides it.
Setting the system prompt to `""` will allow Claude to access outside of selections or use existing context for prompts when using OAuth.

**Codex:** no system prompt by default. When set, it is prepended to the user prompt (Codex CLI has no dedicated system prompt flag).

The spirit of this plugin is to limit the usage to quick questions, but you do you.

### Model selection

By default, both providers use whatever model their CLI is configured with. You can override this per-provider:

```lua
-- Claude: accepts aliases ("sonnet", "opus") or full names ("claude-sonnet-4-6")
require("ask").setup({
    providers = {
        claude = {
            model = "sonnet",
        }
    }
})

-- Codex: accepts model names like "o3", "o4-mini"
require("ask").setup({
    provider = "codex",
    providers = {
        codex = {
            model = "o3",
        }
    }
})
```

### Using codex instead

```lua
require("ask").setup({
    provider = "codex",
})
```

### OpenCode sessions and project context

Each `:Ask` starts an OpenCode conversation. Follow-ups remain in that conversation, and completed
conversations are persisted by OpenCode in an ask.nvim-only database at
`stdpath("state")/ask-opencode.db`. They do not appear in the normal OpenCode TUI history.

ask.nvim binds each conversation to the current buffer's nearest Git project root, falling back to
Neovim's current working directory. OpenCode then loads that project's configuration, `.opencode` resources,
instructions such as `AGENTS.md`, and working-directory context automatically. Ordinary prompts do not
include file contents. Visual selections remain explicit context because the selected text is part of
the question.

The database location can be configured:

```lua
require("ask").setup({
    provider = "opencode",
    providers = {
        opencode = {
            database_path = vim.fn.stdpath("state") .. "/my-ask-opencode.db",
        },
    },
})
```

### OpenCode model selection

Use `:Ask model` to select from fresh CLI model listings for authenticated OpenCode providers. The picker uses
`vim.ui.select`, so configured Telescope or fzf-lua UI-select integrations are used automatically,
with Neovim's native selector as a fallback. Selecting a model immediately opens a second picker for
that model's supported reasoning level. Use `:Ask reasoning` to change only the reasoning level later,
or `:Ask status` to display the currently selected provider, model, and reasoning level.

The model and reasoning level are persisted in ask.nvim's own state file (`ask-opencode.json` under
Neovim's state directory) and sent only with ask.nvim requests. They do not change OpenCode's project
configuration or other OpenCode sessions. Explicit `providers.opencode.model` and
`providers.opencode.reasoning` settings take priority over persisted selections.

To use an externally managed server instead, set `managed_server = false` and provide its `url`.

OpenCode retry messages are shown in the response window. Requests that never complete fail after two
minutes by default instead of remaining on `Thinking...`; configure this with
`providers.opencode.timeout_ms`, or set it to `0` to disable the timeout.
Closing an answer window aborts an active turn but preserves the conversation in history.

History is queried directly from OpenCode and scoped to the current Git project or working directory.
The old ask.nvim JSON history files are no longer read or written; existing files are left untouched.
An external server supplied with `managed_server = false` controls its own database and isolation.

## Usage

```
:Ask How do I write a for loop in lua?
```
![ask](https://github.com/user-attachments/assets/d6dbda12-964a-4e43-8417-e46339a726b1)

Select code in visual mode, then:

```
:'<,'>Ask What does this function do?
```
![visual](https://github.com/user-attachments/assets/9637851c-09ed-4fcb-8ebc-d6c33da45807)

Browse previous conversations:

```
:Ask history
```
![ezgif-34b636e37da8b9a6](https://github.com/user-attachments/assets/208a4c7c-9d52-44a6-8c3d-efd9f63a1f10)
Select an entry with `<CR>` to view the complete conversation. Historical conversation windows remain
attached to their OpenCode session, so press `a` there to continue the conversation.
  
Go to previous prompt without navigating history:  

```
:Ask history <number>
```
Press `q` to close any window.

### Follow-ups

OpenCode response windows retain their conversation. Press `a` in a
live response window to enter a follow-up, or use `:Ask followup [prompt]` while that buffer is current.
Follow-up questions and answers are appended to the same window and persisted in the same OpenCode
conversation. Live and historical windows show a `Press a to ask a follow-up` hint at the bottom and use
`You` / `Assistant` transcript headings. Closing the response window aborts any active turn without
deleting its history.
