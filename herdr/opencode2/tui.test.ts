import { afterEach, expect, mock, test } from "bun:test"
import net from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

mock.module("@opencode/plugin/tui", () => ({ Plugin: { define: (value: unknown) => value } }))
const { default: plugin } = await import("./tui")
const original = { ...process.env }
let cleanup: (() => Promise<void>) | undefined
let server: net.Server
let directory: string

afterEach(async () => {
  await cleanup?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  process.env = original
  rmSync(directory, { recursive: true, force: true })
})

test("selection precedes session-owned, sequenced working/blocked/completion reports", async () => {
  directory = mkdtempSync(join(tmpdir(), "herdr-opencode2-"))
  const socket = join(directory, "herdr.sock")
  const reports: any[] = []
  let failSelection = true
  server = net.createServer((client) => {
    let buffer = ""
    client.on("data", (data) => {
      buffer += data.toString()
      if (!buffer.includes("\n")) return
      const report = JSON.parse(buffer.split("\n")[0])
      reports.push(report)
      client.end(JSON.stringify(failSelection ? { error: { message: "retry" } } : { result: { ok: true } }) + "\n")
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "test:p1", HERDR_SOCKET_PATH: socket, XDG_STATE_HOME: directory })
  let selected = "session-a"
  let running = true
  let blocked = false
  cleanup = plugin.setup({
    ui: { router: { current: () => ({ type: "session", sessionID: selected }) }, tabs: { list: () => [{ sessionID: selected }] } },
    data: { session: {
      get: () => ({ title: "Test", time: { idle: 0 }, location: { directory } }),
      root: (id: string) => id,
      family: () => [],
      status: () => running ? "running" : "idle",
      permission: { list: () => blocked ? [{ id: "permission" }] : [] },
      form: { list: () => [] },
    } },
  } as any) as () => Promise<void>
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for report")
      await Bun.sleep(20)
    }
  }
  await waitFor(() => reports.length >= 2)
  expect(reports.every((report) => report.method === "pane.report_agent_session")).toBe(true)
  failSelection = false
  await waitFor(() => reports.some((report) => report.params.state === "working"))
  blocked = true
  await waitFor(() => reports.some((report) => report.params.state === "blocked"))
  blocked = false
  running = false
  await waitFor(() => reports.some((report) => report.params.state === "idle"))
  selected = "session-b"
  await waitFor(() => reports.some((report) => report.method === "pane.report_agent" && report.params.agent_session_id === selected))
  const states = reports.filter((report) => report.method === "pane.report_agent")
  expect(states.map((report) => report.params.state)).toEqual(["working", "blocked", "idle", "idle"])
  expect(states.map((report) => report.params.agent_session_id)).toEqual(["session-a", "session-a", "session-a", "session-b"])
  expect(reports.every((report) => report.params.source === "herdr:opencode")).toBe(true)
  expect(states.every((report, index) => index === 0 || report.params.seq > states[index - 1].params.seq)).toBe(true)
  expect(reports.filter((report) => report.method === "pane.report_agent_session").every((report) => report.params.seq === undefined)).toBe(true)
}, 10000)
