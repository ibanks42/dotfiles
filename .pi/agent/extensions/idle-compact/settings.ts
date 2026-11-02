import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, SettingsList, Text } from "@earendil-works/pi-tui";

export type Minimum = number | null;
export type Field = "keepaliveMinimumTokens" | "compactionMinimumTokens";
export type Thresholds = Record<Field, Minimum>;
export interface Settings {
	defaults: Thresholds;
	modelOverrides: Record<string, Partial<Thresholds>>;
}
export const DEFAULTS: Readonly<Thresholds> = { keepaliveMinimumTokens: 100_000, compactionMinimumTokens: 200_000 };
const fields: Field[] = ["keepaliveMinimumTokens", "compactionMinimumTokens"];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const expand = (p: string) => p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
export const settingsPath = () => process.env.PI_IDLE_COMPACT_CONFIG
	? resolve(expand(process.env.PI_IDLE_COMPACT_CONFIG))
	: join(process.env.PI_CODING_AGENT_DIR ? resolve(expand(process.env.PI_CODING_AGENT_DIR)) : join(homedir(), ".pi/agent"), "idle-compact.json");
export const modelKey = (model: ExtensionContext["model"]) => model && `${model.provider}/${model.id}`;

function minimum(value: unknown): Minimum {
	if (value === null || value === 0) return null;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	throw new Error("Minimum must be a nonnegative safe integer or null (no minimum)");
}
export function parseMinimum(text: string): Minimum {
	const input = text.trim().toLowerCase();
	if (["none", "no minimum"].includes(input)) return null;
	const clean = input.replace(/,/g, "");
	const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(clean);
	if (!match) throw new Error("Enter tokens such as 25000, 25k, 1.5m, or 0 for no minimum");
	return minimum(Number(match[1]) * (match[2] === "k" ? 1000 : match[2] === "m" ? 1_000_000 : 1));
}
export const formatMinimum = (value: Minimum | undefined) => value === undefined ? "Unavailable" : value === null ? "No minimum" : `${value.toLocaleString("en-US")} tokens`;
/** No minimum removes the floor; unknown/invalid context usage still fails closed. */
export function meetsMinimum(tokens: number | null | undefined, value: Minimum | undefined): boolean {
	return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 && value !== undefined
		&& (value === null || tokens > value);
}
export function readSettings(): Settings {
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(settingsPath(), "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { defaults: { ...DEFAULTS }, modelOverrides: {} };
		throw error;
	}
	if (!object(raw) || (raw.defaults !== undefined && !object(raw.defaults)) || (raw.modelOverrides !== undefined && !object(raw.modelOverrides))) {
		throw new Error("Invalid idle-compact settings structure");
	}
	const defaults = { ...DEFAULTS };
	for (const field of fields) if (object(raw.defaults) && Object.hasOwn(raw.defaults, field)) defaults[field] = minimum(raw.defaults[field]);
	const modelOverrides: Settings["modelOverrides"] = Object.create(null);
	for (const [key, values] of Object.entries(raw.modelOverrides ?? {})) {
		if (!/^[^/\s]+\/\S+$/.test(key) || !object(values)) throw new Error("Invalid model override");
		const override: Partial<Thresholds> = {};
		for (const field of fields) if (Object.hasOwn(values, field)) override[field] = minimum(values[field]);
		modelOverrides[key] = override;
	}
	return { defaults, modelOverrides };
}
export function resolveThresholds(settings: Settings, key?: string): Thresholds {
	return { ...settings.defaults, ...(key ? settings.modelOverrides[key] : {}) };
}
/** Invalid settings disable automatic work; the settings command reports the error. */
export function thresholdsFor(model: ExtensionContext["model"]): Thresholds | undefined {
	try { return resolveThresholds(readSettings(), modelKey(model)); } catch { return undefined; }
}
export function saveSetting(scope: string | undefined, field: Field, value: Minimum | "inherit"): Settings {
	const settings = readSettings(); // Read latest values instead of editing a cached document.
	if (scope) {
		if (!/^[^/\s]+\/\S+$/.test(scope)) throw new Error("Invalid provider/model id");
		const override = { ...settings.modelOverrides[scope] };
		if (value === "inherit") delete override[field];
		else override[field] = minimum(value);
		if (Object.keys(override).length) settings.modelOverrides[scope] = override;
		else delete settings.modelOverrides[scope];
	} else {
		if (value === "inherit") throw new Error("Defaults cannot inherit");
		settings.defaults[field] = minimum(value);
	}
	const file = settingsPath(), temp = `${file}.${randomUUID()}.tmp`;
	mkdirSync(dirname(file), { recursive: true });
	try {
		writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
	} finally {
		try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return settings;
}

export async function showSettings(ctx: ExtensionContext, onChange: () => void): Promise<void> {
	if (ctx.mode !== "tui") { ctx.ui.notify("Idle settings requires interactive TUI mode", "warning"); return; }
	try { readSettings(); } catch (error) { ctx.ui.notify(`Cannot read ${settingsPath()}: ${error}`, "error"); return; }
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let scope: string | undefined;
		const selectionTheme = {
			selectedPrefix: (s: string) => theme.fg("accent", s), selectedText: (s: string) => theme.fg("accent", s),
			description: (s: string) => theme.fg("muted", s), scrollInfo: (s: string) => theme.fg("dim", s), noMatch: (s: string) => theme.fg("warning", s),
		};
		const currentValue = (field: Field) => {
			const settings = readSettings();
			const value = scope ? settings.modelOverrides[scope]?.[field] : settings.defaults[field];
			return value === undefined ? `Default (${formatMinimum(settings.defaults[field])})` : formatMinimum(value);
		};
		function minimumMenu(field: Field, finish: (value?: string) => void) {
			const choices = [
				...(scope ? [{ value: "inherit", label: "Use default", description: formatMinimum(readSettings().defaults[field]) }] : []),
				{ value: "none", label: "No minimum" },
				...[25, 50, 75, 100, 150, 200, 250, 300, 500, 1000].map(k => ({ value: String(k * 1000), label: `${k}k tokens` })),
				{ value: "custom", label: "Custom…", description: "Any token count, e.g. 125k or 250000" },
			];
			const list = new SelectList(choices, 12, selectionTheme);
			const settings = readSettings();
			const current = scope ? settings.modelOverrides[scope]?.[field] : settings.defaults[field];
			const selected = current === undefined ? "inherit" : current === null ? "none" : String(current);
			const index = choices.findIndex(item => item.value === selected);
			list.setSelectedIndex(index < 0 ? choices.length - 1 : index);
			const input = new Input();
			let editing = false, error = "";
			list.onSelect = item => {
				if (item.value !== "custom") { finish(item.value); return; }
				editing = true; input.focused = true;
				const value = resolveThresholds(readSettings(), scope)[field];
				input.setValue(value === null ? "0" : String(value)); tui.requestRender();
			};
			list.onCancel = () => finish();
			input.onSubmit = value => {
				try { const parsed = parseMinimum(value); finish(parsed === null ? "none" : String(parsed)); }
				catch (e) { error = String(e); tui.requestRender(); }
			};
			input.onEscape = () => { editing = false; error = ""; tui.requestRender(); };
			return {
				get focused() { return input.focused; }, set focused(value: boolean) { input.focused = value; },
				render(width: number) {
					if (!editing) return list.render(width);
					return [...new Text("Minimum tokens (0 = no minimum; k/m accepted)", 0, 0).render(width), ...input.render(width), ...new Text(error, 0, 0).render(width)];
				},
				invalidate() { list.invalidate(); input.invalidate(); },
				handleInput(data: string) { if (editing) input.handleInput(data); else list.handleInput(data); tui.requestRender(); },
			};
		}
		const list = new SettingsList([
			{ id: "scope", label: "Edit", currentValue: "Defaults", submenu: (_value, finish) => {
				const keys = new Set<string>(Object.keys(readSettings().modelOverrides));
				const current = modelKey(ctx.model); if (current) keys.add(current);
				for (const scoped of ctx.scopedModels ?? []) keys.add(`${scoped.model.provider}/${scoped.model.id}`);
				const choices = [{ value: "defaults", label: "Defaults", description: "Used by models without an override" }, ...[...keys].sort().map(key => ({ value: key, label: key }))];
				const select = new SelectList(choices, 12, selectionTheme);
				select.setSelectedIndex(Math.max(0, choices.findIndex(item => item.value === (scope ?? "defaults"))));
				select.onSelect = item => finish(item.value); select.onCancel = () => finish(); return select;
			} },
			{ id: "keepaliveMinimumTokens", label: "Keepalive minimum", currentValue: currentValue("keepaliveMinimumTokens"), description: "Strictly above this size; No minimum removes the floor. Unknown context usage remains ineligible.", submenu: (_value, finish) => minimumMenu("keepaliveMinimumTokens", finish) },
			{ id: "compactionMinimumTokens", label: "Compaction minimum", currentValue: currentValue("compactionMinimumTokens"), description: "Independent compaction floor. No minimum can compact small contexts at the idle horizon.", submenu: (_value, finish) => minimumMenu("compactionMinimumTokens", finish) },
		], 10, {
			label: (s, selected) => theme.fg(selected ? "accent" : "text", s), value: s => theme.fg("muted", s),
			description: s => theme.fg("dim", s), cursor: theme.fg("accent", "> "), hint: s => theme.fg("dim", s),
		}, (id, value) => {
			try {
				if (id === "scope") { scope = value === "defaults" ? undefined : value; list.updateValue("scope", scope ?? "Defaults"); }
				else { saveSetting(scope, id as Field, value === "inherit" ? "inherit" : parseMinimum(value)); onChange(); }
				for (const field of fields) list.updateValue(field, currentValue(field));
			} catch (error) { ctx.ui.notify(`Idle settings not saved: ${error}`, "error"); }
			tui.requestRender();
		}, () => done(), { enableSearch: false });
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", "Idle cache settings")));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "Changes save immediately • Esc closes")));
		return {
			render: (width: number) => container.render(width), invalidate: () => container.invalidate(),
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
		};
	});
}
