/**
 * quick-archive — a one-click archive button on hover for sidebar session rows.
 *
 * It does not identify sessions or call the API itself. Clicking the button opens the row's own
 * context menu (hidden) and selects its native "Archive" item, so OpenCode archives exactly that
 * row through its own code path: the row leaves the list, tabs close, the Archived section updates.
 *
 * DOM ownership: one fixed-position overlay button appended to <body>. The only attribute set on
 * app nodes is `data-qa-pending` on a row while its archive is queued or running.
 */
import { Plugin, Style } from "@opencode/plugin/gui"
import css from "./quick-archive.css?inline"

const ICON = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.75 5.25h10.5v7a1 1 0 0 1-1 1H3.75a1 1 0 0 1-1-1v-7Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M2.25 2.75h11.5v2.5H2.25z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M6.25 8.25h3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`

const SIDEBAR = "#vertical-tabs-sidebar"
/** Session rows that carry a native context menu with an Archive item. */
const ROW = [
  '[data-slot="sidebar-inbox-item"]',
  "button[data-titlebar-tab-action]:not([data-action])",
  "[data-titlebar-tab-slot]",
].join(",")
const MENU_ITEM = '[role="menu"] [role="menuitem"]'
const ARCHIVE_LABEL = "Archive"
const MENU_TIMEOUT = 1_000
/** If the app hasn't removed the row this long after archiving, show it again. */
const REMOVE_TIMEOUT = 4_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export default Plugin.define({
  setup(ctx) {
    let active = true
    let hovered: HTMLElement | undefined
    let pointer: { x: number; y: number } | undefined
    let frame = 0
    const queue: HTMLElement[] = []
    let running = false

    const button = document.createElement("button")
    button.type = "button"
    button.dataset.qaOverlay = ""
    button.setAttribute("aria-label", "Archive session")
    button.title = "Archive"
    button.innerHTML = ICON
    document.body.append(button)

    const sidebar = () => document.querySelector<HTMLElement>(SIDEBAR)

    // Pure geometry, not elementsFromPoint: while the native context menu is open the app turns
    // off pointer events on the page, which would make a hit test find nothing.
    const rowAt = (x: number, y: number) => {
      const root = sidebar()
      if (!root) return undefined
      const bounds = root.getBoundingClientRect()
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return undefined

      let found: HTMLElement | undefined
      for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
        if (row.hasAttribute("data-qa-pending")) continue
        const rect = row.getBoundingClientRect()
        if (rect.height === 0) continue
        // Innermost match wins (project rows can sit inside tab slots).
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) found = row
      }
      return found
    }

    const render = () => {
      frame = 0
      if (!active) return
      // Re-hit-test from the last pointer position: after a row hides, the next one slides under
      // the cursor without any pointer event.
      if (pointer) hovered = rowAt(pointer.x, pointer.y)
      if (hovered && (!hovered.isConnected || hovered.hasAttribute("data-qa-pending"))) hovered = undefined

      if (!hovered) {
        button.removeAttribute("data-visible")
        return
      }
      const rect = hovered.getBoundingClientRect()
      const size = 22
      button.style.left = `${Math.round(rect.right - size - 6)}px`
      // Two-line inbox cards keep their time on the bottom line (8px padding, 16px line): sit on
      // it so the button replaces the time cleanly. Single-line rows: center vertically.
      const top = rect.height > 40 ? rect.bottom - 8 - 8 - size / 2 : rect.top + (rect.height - size) / 2
      button.style.top = `${Math.round(top)}px`
      button.setAttribute("data-visible", "")
    }

    const schedule = () => {
      if (!frame && active) frame = requestAnimationFrame(render)
    }

    /** True while we dispatch our own pointer events into the native menu. */
    let driving = false

    const onMove = (event: PointerEvent) => {
      // Our own synthetic events on the menu item must not move the remembered pointer.
      if (driving) return
      pointer = { x: event.clientX, y: event.clientY }
      schedule()
    }

    const onLeave = (event: PointerEvent) => {
      if (driving) return
      // Leaving the window entirely.
      if (!event.relatedTarget) {
        pointer = undefined
        hovered = undefined
        schedule()
      }
    }

    const fire = (target: Element, type: string, init: PointerEventInit) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))

    const closeMenus = () => {
      const target = document.activeElement ?? document.body
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    }

    /** Opens the row's native context menu and selects Archive. Resolves false if there is none. */
    const nativeArchive = async (row: HTMLElement) => {
      const rect = row.getBoundingClientRect()
      const x = rect.left + 12
      const y = rect.top + 8
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }),
      )

      let item: HTMLElement | undefined
      const deadline = Date.now() + MENU_TIMEOUT
      while (!item && Date.now() < deadline) {
        await sleep(10)
        item = [...document.querySelectorAll<HTMLElement>(MENU_ITEM)].find(
          (element) => element.textContent?.trim() === ARCHIVE_LABEL,
        )
      }
      if (!item) {
        closeMenus()
        return false
      }

      const box = item.getBoundingClientRect()
      const init = {
        clientX: box.left + 4,
        clientY: box.top + 4,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
      }
      driving = true
      try {
        fire(item, "pointermove", { ...init, buttons: 0 })
        fire(item, "pointerdown", { ...init, buttons: 1 })
        fire(item, "pointerup", { ...init, buttons: 0 })
      } finally {
        driving = false
      }
      return true
    }

    const unhide = (row: HTMLElement) => {
      row.removeAttribute("data-qa-pending")
      schedule()
    }

    const run = async () => {
      if (running) return
      running = true
      document.documentElement.setAttribute("data-qa-archiving", "")
      try {
        while (active && queue.length > 0) {
          const row = queue.shift()!
          if (!row.isConnected) continue
          let ok = false
          try {
            ok = await nativeArchive(row)
          } catch (error) {
            console.error("[quick-archive]", error)
          }
          if (!ok) {
            unhide(row)
            ctx.toast.show({ title: "Archive failed", description: "This row has no Archive action.", variant: "error" })
            continue
          }
          // Let the menu close before opening the next one.
          await sleep(30)
          schedule()
          setTimeout(() => {
            if (active && row.isConnected) unhide(row)
          }, REMOVE_TIMEOUT)
        }
      } finally {
        document.documentElement.removeAttribute("data-qa-archiving")
        running = false
        // The list settles (row removal, menu teardown) over the next moments; follow it so the
        // button lands on whatever row is now under the still pointer.
        for (const delay of [0, 50, 150, 300, 600]) setTimeout(schedule, delay)
      }
    }

    const onClick = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const row = hovered
      if (!row || row.hasAttribute("data-qa-pending")) return
      row.setAttribute("data-qa-pending", "")
      hovered = undefined
      queue.push(row)
      render()
      void run()
    }

    // Keep focus where it is and don't let the press reach anything underneath.
    const swallow = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
    }

    button.addEventListener("click", onClick)
    button.addEventListener("pointerdown", swallow)
    button.addEventListener("mousedown", swallow)
    document.addEventListener("pointermove", onMove, true)
    document.addEventListener("pointerout", onLeave, true)
    window.addEventListener("scroll", schedule, true)
    window.addEventListener("resize", schedule)
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })

    ctx.add(Style, css)

    return () => {
      active = false
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener("pointermove", onMove, true)
      document.removeEventListener("pointerout", onLeave, true)
      window.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      button.remove()
      queue.length = 0
      document.documentElement.removeAttribute("data-qa-archiving")
      document.querySelectorAll("[data-qa-pending]").forEach((row) => row.removeAttribute("data-qa-pending"))
    }
  },
})
