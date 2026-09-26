import { Plugin } from "@opencode/plugin/tui"
import net from "node:net"
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const source = "herdr:opencode"
let sequence = Date.now() * 1000

function request(pane: string, socket: string, method: string, params = {}) {
  return new Promise<boolean>((resolve) => {
    const client = net.createConnection(socket)
    let buffer = ""
    const finish = (ok: boolean) => { client.destroy(); resolve(ok) }
    client.setTimeout(500, () => finish(false))
    client.on("error", () => finish(false))
    client.on("end", () => finish(false))
    client.on("connect", () => client.write(JSON.stringify({
      id: `${source}:${Date.now()}`,
      method,
      // Unsequenced selections let Herdr reconcile the foreground TUI after a restart.
      params: {
        pane_id: pane,
        source,
        agent: "opencode",
        ...(method === "pane.report_agent_session" ? {} : { seq: sequence = Math.max(sequence + 1, Date.now() * 1000) }),
        ...params,
      },
    }) + "\n"))
    client.on("data", (data) => {
      buffer += data.toString()
      if (!buffer.includes("\n")) return
      try { finish(Boolean(JSON.parse(buffer.split("\n")[0]).result)) }
      catch { finish(false) }
    })
  })
}

export default Plugin.define({
  id: "local.herdr-opencode2",
  setup(ctx) {
    const pane = process.env.HERDR_PANE_ID
    const socket = process.env.HERDR_SOCKET_PATH
    if (process.env.HERDR_ENV !== "1" || !pane || !socket) return
    const directory = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "herdr/opencode2")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, encodeURIComponent(pane) + ".json")
    let events: any[] = []
    let sessions: any[] = []
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))
      if (saved.pid === process.pid && saved.socket === socket) {
        events = saved.events ?? []
        sessions = saved.sessions ?? []
      }
    } catch {}
    let writtenAt = 0
    let signature = ""
    let previous = ""
    let sentAt = 0
    let pending = false
    let disposed = false
    let selected = ""
    let selectedAt = 0
    const sync = async () => {
      if (pending || disposed) return
      const route = ctx.ui.router.current()
      const tabs = ctx.ui.tabs.list()
      const roots = tabs.map((tab) => tab.sessionID)
      if (route.type === "session") roots.push(route.sessionID)
      let state = "idle"
      const next = [...new Set(roots)].map((root) => {
        const info = ctx.data.session.get(root)
        const family = [...new Set([root, ...ctx.data.session.family(root)])]
        const requests = family.flatMap((id) => {
          const location = ctx.data.session.get(id)?.location
          return [...(ctx.data.session.permission.list(id) ?? []), ...(ctx.data.session.form.list(id, location) ?? [])]
        })
        const status = requests.length ? "blocked" : family.some((id) => ctx.data.session.status(id) === "running") ? "working" : "idle"
        const old = sessions.find((session) => session.id === root)
        const idle = info?.time.idle ?? 0
        const title = info?.title ?? tabs.find((tab) => tab.sessionID === root)?.title ?? root
        const block = requests.map((request) => request.id).sort().join(":")
        if (status === "blocked" && (!old || old.block !== block || old.status !== "blocked")) {
          events.push({ id: `${root}:blocked:${block}`, sessionID: root, title, status: "blocked", time: Date.now() })
        }
        if (old && ((idle > old.idle && idle > 0) || (status === "idle" && old.status !== "idle"))) {
          const id = `${root}:done:${idle}`
          if (!events.some((event) => event.id === id)) events.push({ id, sessionID: root, title, status: "done", time: Date.now() })
        }
        return { id: root, title, status, idle, block, active: route.type === "session" && route.sessionID === root, directory: info?.location.directory, children: family.filter((id) => id !== root) }
      })
      sessions = next
      events = events.slice(-100)
      if (sessions.some((session) => session.status === "blocked")) state = "blocked"
      else if (sessions.some((session) => session.status === "working")) state = "working"
      const current = JSON.stringify({ sessions, events })
      if (current !== signature || Date.now() - writtenAt >= 5000) {
        writeFileSync(file + ".tmp", JSON.stringify({ version: 1, pid: process.pid, socket, pane_id: pane, updated: Date.now(), sessions, events }), { mode: 0o600 })
        renameSync(file + ".tmp", file)
        signature = current
        writtenAt = Date.now()
      }
      const sessionID = route.type === "session" ? ctx.data.session.root(route.sessionID) : selected
      if (!sessionID) return
      const reportSelection = sessionID && (sessionID !== selected || Date.now() - selectedAt >= 10000)
      // Selection is independent of aggregate state: switching idle tabs must report too.
      if (!reportSelection && state === previous && Date.now() - sentAt < 10000) return
      pending = true
      try {
        if (reportSelection) {
          const accepted = await request(pane, socket, "pane.report_agent_session", {
            agent_session_id: sessionID,
            session_start_source: "select",
          })
          if (!accepted) return
          selected = sessionID
          selectedAt = Date.now()
        }
        if (await request(pane, socket, "pane.report_agent", { state, agent_session_id: sessionID })) {
          previous = state
          sentAt = Date.now()
        }
      } finally { pending = false }
    }
    const tick = () => void sync().catch((error) => console.error("Herdr status:", error))
    const timer = setInterval(tick, 250)
    tick()
    return async () => {
      disposed = true
      clearInterval(timer)
      // Wait for the single in-flight report before releasing authority.
      while (pending) await new Promise((resolve) => setTimeout(resolve, 10))
      await request(pane, socket, "pane.release_agent")
      try { unlinkSync(file) } catch {}
    }
  },
})
