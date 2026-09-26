import { randomUUID } from "node:crypto";

interface Bus {
  on(name: string, handler: (value: any) => void): () => void;
  emit(name: string, value: unknown): void;
}

/** Subscribe before emitting. Always release listeners and deadlines. */
export function rpc(bus: Bus, method: string, payload: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Cancelled")); return; }
    const requestId = randomUUID();
    const channel = "subagents:rpc:" + method;
    let off = () => {};
    const cleanup = () => { clearTimeout(timer); off(); signal?.removeEventListener("abort", abort); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(new Error("Cancelled"));
    const timer = setTimeout(() => fail(new Error("pi-subagents did not reply. Reload Pi and check that the package is enabled.")), timeoutMs);
    off = bus.on(channel + ":reply:" + requestId, (reply) => {
      cleanup();
      if (reply?.success === true) resolve(reply.data);
      else reject(new Error(reply?.error ?? "Invalid pi-subagents reply"));
    });
    signal?.addEventListener("abort", abort, { once: true });
    try { bus.emit(channel, { ...payload, requestId }); } catch (error) { fail(error); }
  });
}
