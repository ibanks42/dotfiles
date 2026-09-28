// Child process for the FIFO test: drives the real hooks and command once with a
// fake Pi API, then prints "done". If any open() blocked on a FIFO, the parent's
// timeout kills this process and the test fails.
export {};
const { default: extension } = await import("../index.ts");
const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
const notes: string[] = [];
extension({
  on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
  getThinkingLevel: () => "medium",
} as never);
const ctx = {
  sessionManager: { getSessionId: () => "s1" }, model: { provider: "openai", id: "gpt-5.5" },
  modelRegistry: { find: () => undefined }, ui: { notify: (text: string) => notes.push(text) },
};
const emit = async (name: string, event: Record<string, unknown>) => {
  for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx);
};
await command!("status", ctx);
await emit("context_with_system", { messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] });
await emit("before_provider_request", { payload: { model: "gpt-5.5", instructions: "s", input: [{ role: "user", content: "q" }] } });
await emit("message_end", { message: { role: "assistant", provider: "openai", model: "gpt-5.5", api: "openai-responses", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
await command!("report", ctx);
console.log(`done ${notes.length}`);
