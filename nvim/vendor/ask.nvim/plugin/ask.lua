local subcommands = { "model", "reasoning", "status", "history", "followup" }

local function complete(arglead, cmdline)
    local args = vim.split(cmdline, "%s+", { trimempty = true })
    if #args > 2 then
        return {}
    end
    return vim.tbl_filter(function(value)
        return value:sub(1, #arglead) == arglead
    end, subcommands)
end

vim.api.nvim_create_user_command("Ask", function(opts)
    local ask = require("ask")
    local command, rest = opts.args:match("^(%S+)%s*(.*)$")

    if opts.range > 0 then
        ask.query_visual(opts.args, opts.line1, opts.line2)
    elseif command == "model" and rest == "" then
        ask.select_model()
    elseif command == "reasoning" and rest == "" then
        ask.select_reasoning()
    elseif command == "status" and rest == "" then
        ask.show_status()
    elseif command == "history" then
        ask.show_history(tonumber(rest))
    elseif command == "followup" then
        ask.followup(rest ~= "" and rest or nil)
    else
        ask.query(opts.args)
    end
end, {
    nargs = "*",
    range = true,
    complete = complete,
    desc = "Ask a question or manage ask.nvim",
})
