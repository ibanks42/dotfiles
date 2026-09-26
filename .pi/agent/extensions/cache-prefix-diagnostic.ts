import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Temporary, local-only observer. No tools, prompt edits, requests, or raw text logs.
const TARGET = "01a0bf33-ac38-7425-bf0d-7cf3770b587b";
const DIR = join(homedir(), ".pi", "agent", "cache-diagnostics", TARGET);
const LIMIT = 10;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => JSON.stringify(value) ?? "undefined";
type Fingerprint = {
	sha256: string; jsonChars: number; kind: string; chars?: number; chunkChars?: number;
	chunks?: string[]; chunksTruncated?: boolean; items?: Fingerprint[]; fields?: Record<string, Fingerprint>;
};

export function fingerprint(value: unknown): Fingerprint {
	const text = encode(value);
	const base = { sha256: hash(text), jsonChars: text.length };
	if (typeof value === "string") {
		const chunks: string[] = [];
		for (let i = 0; i < Math.min(value.length, 2_097_152); i += 512) chunks.push(hash(value.slice(i, i + 512)));
		return { ...base, kind: "string", chars: value.length, chunkChars: 512, chunks, chunksTruncated: value.length > 2_097_152 };
	}
	if (Array.isArray(value)) return { ...base, kind: "array", items: value.map(fingerprint) };
	if (value && typeof value === "object") {
		return { ...base, kind: "object", fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fingerprint(item)])) };
	}
	return { ...base, kind: value === null ? "null" : typeof value };
}

export function compareRequests(previous: Record<string, unknown>, current: Record<string, unknown>) {
	const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(current)])]
		.filter(key => encode(previous[key]) !== encode(current[key]));
	const arrays: Record<string, unknown> = {};
	for (const key of ["input", "messages", "tools"]) {
		const a = previous[key], b = current[key];
		if (!Array.isArray(a) || !Array.isArray(b)) continue;
		let shared = 0;
		while (shared < Math.min(a.length, b.length) && encode(a[shared]) === encode(b[shared])) shared++;
		const oldItem = encode(a[shared]), newItem = encode(b[shared]);
		let chars = 0;
		while (chars < Math.min(oldItem.length, newItem.length) && oldItem[chars] === newItem[chars]) chars++;
		arrays[key] = {
			previousItems: a.length, currentItems: b.length, sharedPrefixItems: shared,
			oldPrefixPreserved: shared === a.length,
			firstDifferentItem: shared < Math.min(a.length, b.length) ? shared : null,
			sharedJsonCharsInDifferentItem: chars,
		};
	}
	return { changedFields, arrays };
}

export default function (pi: ExtensionAPI) {
	const run = randomUUID();
	let count = 0;
	let previous: Record<string, unknown> | undefined;
	let pending: number | undefined;
	let warned = false;
	const matches = (ctx: any) => ctx.sessionManager.getSessionId() === TARGET
		&& ctx.model?.provider === "openai-codex" && ctx.model?.id === "gpt-6-astra";
	const enabled = (ctx: any) => matches(ctx) && !existsSync(join(DIR, "STOP"));
	function save(record: unknown) {
		mkdirSync(DIR, { recursive: true, mode: 0o700 });
		appendFileSync(join(DIR, `${run}.jsonl`), JSON.stringify(record) + "\n", { mode: 0o600 });
	}
	function failed(ctx: any) {
		if (!warned) { warned = true; ctx.ui.notify("Cache diagnostic could not save fingerprints; requests are unchanged.", "warning"); }
	}
	pi.on("session_start", (_event, ctx) => {
		if (enabled(ctx)) ctx.ui.notify("Cache diagnostic armed: next 10 Astra requests; hashes only.", "info");
	});
	pi.on("before_provider_request", (event, ctx) => {
		pending = undefined;
		if (!enabled(ctx) || count >= LIMIT) return;
		try {
			// Freeze this hook's view; later handlers can still replace the payload.
			const payload = JSON.parse(encode(event.payload));
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
			const sequence = ++count;
			save({ kind: "request", at: Date.now(), sequence, stage: "before_provider_request observer (not wire capture)",
				comparison: previous ? compareRequests(previous, payload) : null, fingerprint: fingerprint(payload) });
			previous = payload;
			pending = sequence;
		} catch { failed(ctx); }
		// No return value: never replace the request payload.
	});
	pi.on("message_end", (event, ctx) => {
		if (!enabled(ctx) || pending === undefined || event.message.role !== "assistant") return;
		try {
			const { input, cacheRead, cacheWrite, output } = event.message.usage;
			save({ kind: "usage", at: Date.now(), sequence: pending, usage: { input, cacheRead, cacheWrite, output }, stopReason: event.message.stopReason });
			pending = undefined;
			if (count >= LIMIT) { previous = undefined; ctx.ui.notify("Cache diagnostic captured 10 requests. Logging stopped; goal execution is unchanged.", "info"); }
		} catch { failed(ctx); }
	});
	pi.on("session_shutdown", () => { previous = undefined; pending = undefined; });
}
