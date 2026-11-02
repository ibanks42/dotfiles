#!/usr/bin/env -S node --no-warnings --import file://${HOME}/.pi/agent/npm/node_modules/tsx/dist/loader.mjs
/**
 * Persistent pi-intercom bridge for Antigravity (agy) CLI sessions.
 *
 * Keeps a persistent connection to the local pi-intercom broker so the agy
 * session remains continuously visible in Pi's `/intercom` (Alt+M) roster under
 * its chosen alias, queues incoming messages while agy is busy working, and
 * integrates with agy's background-task Reactive Wakeup via `wait`.
 */

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  Attachment,
  Message,
  SessionInfo,
} from "pi-intercom/types.ts";

const PI_INTERCOM = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-intercom");


const RUNTIME_DIR = path.join(os.homedir(), ".pi", "agent", "intercom", "agy-bridges");

interface QueuedInbound {
  from: {
    id: string;
    name: string;
    cwd: string;
    model: string;
  };
  messageId: string;
  replyTo?: string;
  expectsReply?: boolean;
  timestamp: number;
  text: string;
  attachments?: Attachment[];
}

interface DaemonRequest {
  action: "status" | "list" | "send" | "ask" | "reply" | "wait" | "alias" | "stop";
  to?: string;
  text?: string;
  newName?: string;
  timeoutMs?: number;
}

function sanitizeAlias(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._-]/g, "-") || "agy";
}

function getSocketPath(alias: string): string {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  return path.join(RUNTIME_DIR, `${sanitizeAlias(alias)}.sock`);
}

function findOwnerPid(explicitPid?: number): number | undefined {
  if (explicitPid && Number.isSafeInteger(explicitPid) && explicitPid > 1) {
    return explicitPid;
  }
  try {
    let pid = process.ppid;
    let fallbackShellPid: number | undefined;
    while (pid > 1) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const openParen = stat.indexOf("(");
      const comm = stat.slice(openParen + 1, closeParen);
      const rest = stat.slice(closeParen + 2).split(" ");
      const ppid = Number.parseInt(rest[1] ?? "0", 10);
      if (comm === "agy" || comm === "agy-worker") {
        return pid;
      }
      if (!fallbackShellPid && (comm === "zsh" || comm === "bash" || comm === "fish")) {
        fallbackShellPid = pid;
      }
      pid = ppid;
    }
    return fallbackShellPid;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatAttachments(attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return "";
  const parts: string[] = ["\n\n--- Attachments ---"];
  for (const att of attachments) {
    parts.push(`\n[${att.type}: ${att.name}]`);
    if (att.language) {
      parts.push(`\`\`\`${att.language}\n${att.content}\n\`\`\``);
    } else {
      parts.push(att.content);
    }
  }
  return parts.join("\n");
}

function formatInboundForAgy(alias: string, item: QueuedInbound): string {
  const lines: string[] = [];
  lines.push(`=== INCOMING PI-INTERCOM MESSAGE TO "${alias}" ===`);
  lines.push(`From: ${item.from.name} (id: ${item.from.id.slice(0, 8)}, cwd: ${item.from.cwd})`);
  lines.push(`Message ID: ${item.messageId}`);
  if (item.expectsReply) {
    lines.push(`Action Required: Sender used 'ask' and is waiting for your reply!`);
    lines.push(`To reply: ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts reply --name ${alias} --to ${item.from.name} --text "<your reply>"`);
  } else {
    lines.push(`To reply: ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts reply --name ${alias} --text "<your reply>"`);
    lines.push(`To ask a clarifying question: ~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts ask --name ${alias} --to ${item.from.name} --text "<your question>"`);
  }
  lines.push(`--------------------------------------------------`);
  lines.push(`${item.text}${formatAttachments(item.attachments)}`);
  lines.push(`==================================================`);
  return lines.join("\n");
}

function buildInlinePromptForPane(alias: string, item: QueuedInbound): string {
  const sender = item.from.name || "pi";
  const fullBody = `${item.text}${formatAttachments(item.attachments)}`.trim();
  const inlineText = fullBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" \\n ");

  const replyCmd = `~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts reply --name ${alias} --to ${sender} --text "<reply>"`;
  const askCmd = `~/.gemini/config/skills/pi-intercom/scripts/agy-intercom.ts ask --name ${alias} --to ${sender} --text "<question>"`;

  const actionNote = item.expectsReply
    ? `Sender used 'ask' and is waiting for your reply. Reply via: \`${replyCmd}\`.`
    : `When finished, report back via: \`${replyCmd}\` (or ask clarifying questions mid-task via: \`${askCmd}\`).`;

  return `[pi-intercom from "${sender}" to "${alias}"]: ${inlineText} — (${actionNote})`;
}

function injectIntoHerdrPane(paneId: string, promptText: string): boolean {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH || path.join(os.homedir(), ".local", "bin", "herdr");
    const sendText = spawn(herdrBin, ["pane", "send-text", paneId, promptText], {
      stdio: "ignore",
    });
    sendText.on("close", (code) => {
      if (code === 0) {
        setTimeout(() => {
          const sendEnter = spawn(herdrBin, ["pane", "send-keys", paneId, "enter"], {
            stdio: "ignore",
          });
          sendEnter.unref();
        }, 120);
      }
    });
    sendText.unref();
    return true;
  } catch {
    return false;
  }
}

async function ensureIntercomBroker(): Promise<void> {
  const { spawnBrokerIfNeeded } = await import(path.join(PI_INTERCOM, "broker", "spawn.ts"));
  const { loadConfig } = await import(path.join(PI_INTERCOM, "config.ts"));
  const config = loadConfig();
  await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
}

async function runDaemon(initialAlias: string, cwd: string, ownerPid?: number): Promise<void> {
  let currentAlias = initialAlias;
  let sockPath = getSocketPath(currentAlias);
  try {
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
  } catch {
    // ignore
  }

  await ensureIntercomBroker();
  const { IntercomClient } = await import(path.join(PI_INTERCOM, "broker", "client.ts"));
  const client = new IntercomClient();

  const inboundQueue: QueuedInbound[] = [];
  const waitingSockets: Array<{
    resolve: (item: QueuedInbound) => void;
    timer?: NodeJS.Timeout;
  }> = [];
  const askWaiters = new Map<
    string,
    {
      to: string;
      resolve: (msg: { from: string; text: string }) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  let lastSender: { name: string; id: string; messageId: string; expectsReply?: boolean } | null = null;

  const herdrPaneId = process.env.HERDR_PANE_ID?.trim() || undefined;
  const tmuxPane = process.env.TMUX_PANE?.trim() || undefined;

  await client.connect({
    cwd,
    model: "antigravity",
    pid: ownerPid ?? process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    name: currentAlias,
    status: "idle",
    acknowledgesReceipts: true,
    ...(herdrPaneId ? { herdrPaneId } : {}),
    ...(tmuxPane ? { tmuxPane } : {}),
  });

  client.on("message", (from: SessionInfo, message: Message) => {
    const senderName = from.name || from.id;
    client.sendMessageReceipt({
      messageId: message.id,
      status: "receiver_received",
      timestamp: Date.now(),
    });

    // Check if this is a reply to a pending outbound `ask` from agy
    if (message.replyTo && askWaiters.has(message.replyTo)) {
      const waiter = askWaiters.get(message.replyTo)!;
      askWaiters.delete(message.replyTo);
      clearTimeout(waiter.timer);
      client.sendMessageReceipt({
        messageId: message.id,
        status: "acknowledged",
        timestamp: Date.now(),
        detail: "matched reply waiter",
      });
      waiter.resolve({ from: senderName, text: message.content.text });
      return;
    }

    client.sendMessageReceipt({
      messageId: message.id,
      status: "acknowledged",
      timestamp: Date.now(),
      detail: "accepted by agy bridge",
    });

    const item: QueuedInbound = {
      from: {
        id: from.id,
        name: senderName,
        cwd: from.cwd,
        model: from.model,
      },
      messageId: message.id,
      replyTo: message.replyTo,
      expectsReply: message.expectsReply,
      timestamp: message.timestamp,
      text: message.content.text,
      attachments: message.content.attachments,
    };

    lastSender = {
      name: senderName,
      id: from.id,
      messageId: message.id,
      expectsReply: message.expectsReply,
    };

    // In Herdr, always type into the pane so the listener never depends on a
    // one-shot `wait` that agy has to re-arm after every message.
    const nextWaiter = herdrPaneId ? undefined : waitingSockets.shift();
    if (herdrPaneId && injectIntoHerdrPane(herdrPaneId, buildInlinePromptForPane(currentAlias, item))) {
      client.updatePresence({ status: "thinking" });
      client.sendMessageReceipt({
        messageId: message.id,
        status: "injected",
        timestamp: Date.now(),
      });
    } else if (nextWaiter) {
      if (nextWaiter.timer) clearTimeout(nextWaiter.timer);
      client.updatePresence({ status: "thinking" });
      client.sendMessageReceipt({
        messageId: message.id,
        status: "injected",
        timestamp: Date.now(),
      });
      nextWaiter.resolve(item);
    } else {
      inboundQueue.push(item);
      client.sendMessageReceipt({
        messageId: message.id,
        status: "queued",
        timestamp: Date.now(),
      });
    }
  });

  const server = net.createServer((conn) => {
    let raw = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      raw += chunk;
      const nl = raw.indexOf("\n");
      if (nl === -1) return;
      const line = raw.slice(0, nl);
      raw = raw.slice(nl + 1);
      void handleRequest(conn, line);
    });
  });

  async function handleRequest(conn: net.Socket, line: string): Promise<void> {
    const replyJson = (obj: Record<string, unknown>) => {
      if (!conn.destroyed) {
        conn.end(`${JSON.stringify(obj)}\n`);
      }
    };

    let req: DaemonRequest;
    try {
      req = JSON.parse(line) as DaemonRequest;
    } catch (err) {
      replyJson({ ok: false, error: `Invalid JSON: ${String(err)}` });
      return;
    }

    try {
      switch (req.action) {
        case "status": {
          replyJson({
            ok: true,
            alias: currentAlias,
            sessionId: client.sessionId,
            connected: client.isConnected(),
            queuedMessages: inboundQueue.length,
            lastSender,
          });
          return;
        }

        case "list": {
          const sessions = await client.listSessions();
          replyJson({
            ok: true,
            self: { alias: currentAlias, sessionId: client.sessionId },
            sessions: sessions.map((s) => ({
              name: s.name ?? "(unnamed)",
              id: s.id,
              model: s.model,
              status: s.status ?? "?",
              cwd: s.cwd,
            })),
          });
          return;
        }

        case "alias": {
          if (!req.newName) {
            replyJson({ ok: false, error: "Missing newName" });
            return;
          }
          const oldSock = sockPath;
          currentAlias = req.newName.trim();
          client.updatePresence({ name: currentAlias });
          sockPath = getSocketPath(currentAlias);
          if (oldSock !== sockPath) {
            try {
              if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
              fs.linkSync(oldSock, sockPath);
            } catch {
              // ignore link errors
            }
          }
          replyJson({ ok: true, alias: currentAlias });
          return;
        }

        case "send": {
          if (!req.to || !req.text) {
            replyJson({ ok: false, error: "Both --to and --text are required" });
            return;
          }
          const res = await client.send(req.to, { text: req.text });
          if (inboundQueue.length === 0) {
            client.updatePresence({ status: "idle" });
          }
          replyJson({
            ok: res.delivered,
            delivered: res.delivered,
            id: res.id,
            reason: res.reason,
          });
          return;
        }

        case "reply": {
          if (!req.text) {
            replyJson({ ok: false, error: "--text is required for reply" });
            return;
          }
          const target = req.to || lastSender?.name || lastSender?.id;
          if (!target) {
            replyJson({
              ok: false,
              error: "No recent sender to reply to; specify --to <session-alias>",
            });
            return;
          }
          const replyToId = lastSender?.messageId;
          const res = await client.send(target, {
            text: req.text,
            ...(replyToId ? { replyTo: replyToId } : {}),
          });
          if (inboundQueue.length === 0) {
            client.updatePresence({ status: "idle" });
          }
          replyJson({
            ok: res.delivered,
            delivered: res.delivered,
            to: target,
            replyTo: replyToId,
            id: res.id,
            reason: res.reason,
          });
          return;
        }

        case "ask": {
          if (!req.to || !req.text) {
            replyJson({ ok: false, error: "Both --to and --text are required for ask" });
            return;
          }
          const timeoutMs = req.timeoutMs ?? 300_000;
          const res = await client.send(req.to, {
            text: req.text,
            expectsReply: true,
          });
          if (!res.delivered) {
            replyJson({
              ok: false,
              error: `Delivery failed: ${res.reason ?? "unknown"}`,
            });
            return;
          }
          const reply = await new Promise<{ from: string; text: string }>((resolve, reject) => {
            const timer = setTimeout(() => {
              askWaiters.delete(res.id);
              client.cancelAsk(res.id);
              reject(new Error(`Timed out after ${timeoutMs}ms waiting for reply from ${req.to}`));
            }, timeoutMs);
            askWaiters.set(res.id, { to: req.to!, resolve, reject, timer });
          });
          replyJson({
            ok: true,
            from: reply.from,
            text: reply.text,
          });
          return;
        }

        case "wait": {
          if (inboundQueue.length > 0) {
            const item = inboundQueue.shift()!;
            client.updatePresence({ status: "thinking" });
            client.sendMessageReceipt({
              messageId: item.messageId,
              status: "injected",
              timestamp: Date.now(),
            });
            replyJson({ ok: true, message: item, formatted: formatInboundForAgy(currentAlias, item) });
            return;
          }

          const waiter: {
            resolve: (item: QueuedInbound) => void;
            timer?: NodeJS.Timeout;
          } = {
            resolve: (item) => {
              replyJson({ ok: true, message: item, formatted: formatInboundForAgy(currentAlias, item) });
            },
          };

          if (req.timeoutMs && req.timeoutMs > 0) {
            waiter.timer = setTimeout(() => {
              const idx = waitingSockets.indexOf(waiter);
              if (idx !== -1) waitingSockets.splice(idx, 1);
              replyJson({ ok: false, timeout: true, error: "Wait timed out" });
            }, req.timeoutMs);
          }

          conn.on("close", () => {
            const idx = waitingSockets.indexOf(waiter);
            if (idx !== -1) waitingSockets.splice(idx, 1);
            if (waiter.timer) clearTimeout(waiter.timer);
          });

          waitingSockets.push(waiter);
          return;
        }

        case "stop": {
          replyJson({ ok: true, stopped: true });
          await client.disconnect().catch(() => {});
          server.close();
          try {
            if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
          } catch {
            // ignore
          }
          process.exit(0);
        }
      }
    } catch (err) {
      replyJson({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  server.listen(sockPath, () => {
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch {
      // ignore
    }
  });

  const cleanup = () => {
    if (ownerTimer) clearInterval(ownerTimer);
    try {
      if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
    } catch {
      // ignore
    }
    void client.disconnect().finally(() => process.exit(0));
  };

  const ownerTimer = ownerPid
    ? setInterval(() => {
        if (!isPidAlive(ownerPid)) {
          cleanup();
        }
      }, 2000)
    : null;
  ownerTimer?.unref?.();

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
}

async function sendDaemonRequest(alias: string, req: DaemonRequest): Promise<Record<string, unknown>> {
  const sockPath = getSocketPath(alias);
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(`${JSON.stringify(req)}\n`);
    });
    sock.on("data", (chunk) => {
      buf += chunk;
    });
    sock.on("end", () => {
      try {
        resolve(JSON.parse(buf.trim()) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`Invalid response from daemon: ${buf}`));
      }
    });
    sock.on("error", (err) => {
      reject(err);
    });
  });
}

async function isDaemonRunning(alias: string): Promise<boolean> {
  try {
    const res = await sendDaemonRequest(alias, { action: "status" });
    return res.ok === true;
  } catch {
    return false;
  }
}

async function ensureDaemonRunning(alias: string, cwd: string, ownerPid?: number): Promise<void> {
  if (await isDaemonRunning(alias)) return;

  const resolvedOwner = findOwnerPid(ownerPid);
  const scriptPath = fileURLToPath(import.meta.url);
  const args = [
    ...process.execArgv,
    scriptPath,
    "__daemon",
    "--name",
    alias,
    "--cwd",
    cwd,
    ...(resolvedOwner ? ["--owner-pid", String(resolvedOwner)] : []),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd,
  });
  child.unref();

  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await isDaemonRunning(alias)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out starting agy-intercom daemon for alias "${alias}"`);
}

function parseArgs(argv: string[]): {
  command: string;
  name: string;
  to?: string;
  text?: string;
  newName?: string;
  cwd: string;
  timeoutMs?: number;
  ownerPid?: number;
  json: boolean;
} {
  const [command = "status", ...rest] = argv;
  let name = "";
  let to: string | undefined;
  let text: string | undefined;
  let newName: string | undefined;
  let cwd = process.cwd();
  let timeoutMs: number | undefined;
  let ownerPid: number | undefined;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    const val = rest[i + 1];
    if (arg === "--name" && val) {
      name = val;
      i++;
    } else if (arg === "--to" && val) {
      to = val;
      i++;
    } else if (arg === "--text" && val) {
      text = val;
      i++;
    } else if (arg === "--new-name" && val) {
      newName = val;
      i++;
    } else if (arg === "--cwd" && val) {
      cwd = val;
      i++;
    } else if (arg === "--timeout-ms" && val) {
      timeoutMs = Number(val);
      i++;
    } else if (arg === "--owner-pid" && val) {
      ownerPid = Number(val);
      i++;
    }
  }

  if (!name) {
    console.error("Error: --name <alias> is required (set via /alias <name>).");
    process.exit(1);
  }

  return { command, name, to, text, newName, cwd, timeoutMs, ownerPid, json };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.command === "__daemon") {
    await runDaemon(opts.name, opts.cwd, opts.ownerPid);
    return;
  }

  if (opts.command === "stop") {
    if (!(await isDaemonRunning(opts.name))) {
      console.log(`Intercom bridge "${opts.name}" is not running.`);
      return;
    }
    await sendDaemonRequest(opts.name, { action: "stop" });
    console.log(`Stopped intercom bridge "${opts.name}".`);
    return;
  }

  await ensureDaemonRunning(opts.name, opts.cwd, opts.ownerPid);

  switch (opts.command) {
    case "start":
    case "status": {
      const res = await sendDaemonRequest(opts.name, { action: "status" });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(
          `Connected to pi-intercom as "${res.alias}" (session: ${String(res.sessionId).slice(0, 8)}, queued: ${res.queuedMessages})`,
        );
      }
      return;
    }

    case "list": {
      const res = await sendDaemonRequest(opts.name, { action: "list" });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        const sessions = (res.sessions as Array<Record<string, string>>) ?? [];
        console.log(`Active pi-intercom sessions (self = "${opts.name}"):`);
        for (const s of sessions) {
          console.log(`  • ${s.name}\t(${s.id.slice(0, 8)})\t[${s.status}]\t${s.model}\t${s.cwd}`);
        }
      }
      return;
    }

    case "alias": {
      if (!opts.newName) {
        console.error("Usage: agy-intercom.ts alias --name <current> --new-name <new>");
        process.exit(1);
      }
      const res = await sendDaemonRequest(opts.name, {
        action: "alias",
        newName: opts.newName,
      });
      console.log(`Renamed intercom session to "${res.alias}".`);
      return;
    }

    case "send": {
      if (!opts.to || !opts.text) {
        console.error("Usage: agy-intercom.ts send --name <self> --to <target-alias> --text <message>");
        process.exit(1);
      }
      const res = await sendDaemonRequest(opts.name, {
        action: "send",
        to: opts.to,
        text: opts.text,
      });
      if (!res.ok) {
        console.error(`Failed to send to ${opts.to}: ${res.reason ?? res.error}`);
        process.exit(1);
      }
      console.log(`Sent message to "${opts.to}" (id: ${res.id}).`);
      return;
    }

    case "reply": {
      if (!opts.text) {
        console.error("Usage: agy-intercom.ts reply --name <self> [--to <target-alias>] --text <message>");
        process.exit(1);
      }
      const res = await sendDaemonRequest(opts.name, {
        action: "reply",
        to: opts.to,
        text: opts.text,
      });
      if (!res.ok) {
        console.error(`Failed to reply: ${res.reason ?? res.error}`);
        process.exit(1);
      }
      console.log(`Replied to "${res.to}" (id: ${res.id}).`);
      return;
    }

    case "ask": {
      if (!opts.to || !opts.text) {
        console.error("Usage: agy-intercom.ts ask --name <self> --to <target-alias> --text <question>");
        process.exit(1);
      }
      const res = await sendDaemonRequest(opts.name, {
        action: "ask",
        to: opts.to,
        text: opts.text,
        timeoutMs: opts.timeoutMs,
      });
      if (!res.ok) {
        console.error(`Ask failed: ${res.error}`);
        process.exit(1);
      }
      console.log(`Reply from ${res.from}:\n${res.text}`);
      return;
    }

    case "wait": {
      const res = await sendDaemonRequest(opts.name, {
        action: "wait",
        timeoutMs: opts.timeoutMs,
      });
      if (!res.ok) {
        console.error(`Wait ended: ${res.error}`);
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        console.log(String(res.formatted));
      }
      return;
    }

    default:
      console.error(`Unknown command: ${opts.command}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
