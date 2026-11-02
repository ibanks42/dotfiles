import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface Prompt {
  id: string;
  text: string;
  reply: string;
}

/** Plain terminal-safe previews; never render prompt-supplied escape sequences. */
export function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

export function collectPrompts(branch: readonly SessionEntry[]): Prompt[] {
  const prompts: Prompt[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (message.role === "user") {
      prompts.push({ id: entry.id, text: clean(text) || "[image / attachment]", reply: "" });
    } else if (prompts.length && clean(text)) {
      prompts[prompts.length - 1].reply = clean(text);
    }
  }
  return prompts;
}

export function promptHistory(branch: readonly SessionEntry[], id: string) {
  const start = branch.findIndex((entry) => entry.id === id && entry.type === "message" && entry.message.role === "user");
  if (start < 0) return;
  let prompt = "";
  const replies: string[] = [];
  for (let i = start; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (i > start && message.role === "user") break;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content;
    const raw = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const text = stripTerminalSequences(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\t/g, "    ");
    if (message.role === "user") prompt = text || "[image / attachment]";
    else if (text.trim()) replies.push(text);
  }
  return { prompt, reply: replies.join("\n\n") };
}

