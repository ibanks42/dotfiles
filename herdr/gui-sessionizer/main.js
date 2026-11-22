import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Scrollbar, InputState, Input } from 'gpui-base';
import { appHome, readTextFile, writeTextFile, exec, spaces, panes, machines, run, theme, settings, props, closeOverlay, shared, setShared } from 'herdr';
import { validateConfig, validateTabs, configFor, combinedCandidates, parseArgv, formatArgv, duplicateSpace, newJournal, launchSpace } from './model.mjs';

const BASE = () => `${appHome()}/mods/sessionizer`;
const OP = 'sessionizer.operation';
const CLONE = 'sessionizer.clone';
const textError = error => String(error?.message ?? error);
const ICON = name => `mods/sessionizer/icons/${name}.svg`;
const CHROME = name => `mods/workspace-chrome/${name}.svg`;
// Theme colors are #rrggbb; append an alpha byte for tints, leave anything else alone.
const tint = (color, alpha) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color + alpha : color;
const machineName = machine => machine ?? 'local';
// Display only: /home/<user>, /Users/<user> and C:\Users\<user> read as ~ on any machine.
const shortPath = path => String(path ?? '').replace(/^(?:\/(?:home|Users)\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/, '~');
const parentOf = path => { const p = shortPath(path); const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : p; };
const trimSlashes = path => path.replace(/[\\/]+$/, '');
// python3 on Unix; on Windows usually python or the py launcher (python3 may be a Store stub).
const PYTHONS = [['python3'], ['python'], ['py', '-3']];
const MODES = [
  ['browse', 'Open project', CHROME('search')],
  ['path', 'Exact path', ICON('text-cursor')],
  ['new', 'New folder', CHROME('folder-plus')],
  ['clone', 'Clone repo', ICON('download')],
];
const ROW = 48;

export default class Sessionizer extends View {
  init(_props, cx) {
    this.machine = null;
    this.editTabs = []; this.editRoots = []; this.nextEditId = 0;
    this.mode = 'browse'; this.query = ''; this.at = 0;
    this.settingsTab = 'tabs'; this.savedDraft = ''; this.drag = null; this.focusedInput = null;
    this.catalogs = []; this.warnings = [];
    this.error = ''; this.busy = false; this.loading = true; this.generation = 0;
    this.handle = cx.focus_handle();
    this.listScroll = VirtualListScrollHandle.new();
    const input = (name, placeholder, value = '') => {
      this[name] = InputState.new({ placeholder, value });
      this.trackFocus(this[name]);
      this[name].on('change', (_e, cx) => {
        if (name === 'search') { this.query = this.search.value(); this.at = 0; this.listScroll.scroll_to_item(0); }
        this.error = ''; cx.notify();
      });
    };
    input('search', 'Search projects on every machine…');
    input('pathInput', '/absolute/path or ~/folder');
    input('rootInput', 'Parent folder, e.g. ~/dev', '~');
    input('nameInput', 'new-project');
    input('urlInput', 'https://github.com/owner/repo.git or git@host:repo');
    this.search.on('submit', (_e, cx) => this.choose(this.rows()[this.at], cx));
    this.pathInput.on('submit', (_e, cx) => this.prepare(this.pathInput.value(), cx));
    this.nameInput.on('submit', (_e, cx) => this.mode === 'clone' ? this.startClone(cx) : this.createFolder(cx));
    this.urlInput.on('submit', (_e, cx) => this.startClone(cx));
    this.search.focus();
    cx.spawn(async cx => {
      try {
        const [raw, source] = await Promise.all([
          readTextFile(`${BASE()}/config.json`), readTextFile(`${BASE()}/filesystem.py`),
        ]);
        this.config = validateConfig(JSON.parse(raw ?? 'null'));
        this.configText = raw;
        if (!source) throw new Error('Sessionizer filesystem backend is missing');
        this.source = source;
        this.refresh(cx);
        // mod.open {name: 'sessionizer', props: {mode: 'settings' | 'path' | 'new' | 'clone'}} jumps straight there.
        const mode = props()?.mode;
        if (mode === 'settings') { this.settingsTab = props()?.tab === 'roots' ? 'roots' : 'tabs'; this.startSettings(cx); }
        else if (['path', 'new', 'clone'].includes(mode)) this.setMode(mode, cx);
      } catch (error) { this.loading = false; this.error = textError(error); cx.notify(); }
    });
    // Poll ONLY an explicitly started, persistent clone. No filesystem polling.
    cx.timer.every(1500, cx => { if (shared(CLONE)?.job && !this.polling) this.pollClone(cx); });
  }

  close() {
    this.listScroll?.release();
    this.releaseEdits();
  }

  // Focus rings: remember which input has the caret.
  trackFocus(state) {
    state.on('focus', (_e, cx) => { this.focusedInput = state; cx.notify(); });
    state.on('blur', (_e, cx) => { if (this.focusedInput === state) { this.focusedInput = null; cx.notify(); } });
  }

  releaseEdits() {
    for (const row of [...this.editTabs, ...this.editRoots]) for (const input of row.inputs) input.release?.();
    this.editTabs = []; this.editRoots = []; this.drag = null;
  }

  editRow(values, cx, placeholders = []) {
    const inputs = values.map((value, i) => {
      const input = InputState.new({ value: String(value), placeholder: placeholders[i] ?? '' });
      this.trackFocus(input);
      input.on('change', (_e, cx) => { this.error = ''; cx.notify(); });
      return input;
    });
    return { id: ++this.nextEditId, inputs };
  }

  tabRow(name, command, cx) { return this.editRow([name, command], cx, ['Tab name', 'Command — leave empty for a shell']); }
  rootRow(root, cx) { return { ...this.editRow([root.path], cx, ['~/dev/projects']), machine: root.machine, depth: root.depth }; }

  draft() {
    return JSON.stringify([this.editTabs.map(row => row.inputs.map(input => input.value())),
      this.editRoots.map(row => [row.machine, row.inputs[0].value(), row.depth])]);
  }

  startSettings(cx) {
    if (!this.config || this.busy || shared(OP) || shared(CLONE) || this.mode === 'settings') return;
    this.releaseEdits();
    this.editTabs = this.config.tabs.map(tab => this.tabRow(tab.name, formatArgv(tab.argv), cx));
    this.editRoots = this.config.roots.map(root => this.rootRow(root, cx));
    this.savedDraft = this.draft();
    this.error = ''; this.mode = 'settings'; this.handle.focus?.(); cx.notify();
  }

  leaveSettings(cx) {
    const settings = this.mode === 'settings';
    this.mode = settings ? 'browse' : 'preview'; this.releaseEdits(); this.error = '';
    if (settings) this.search.focus(); else this.handle.focus?.();
    cx.notify();
  }

  customizeTabs(cx) {
    if (!this.plan || this.busy) return;
    this.releaseEdits();
    this.editTabs = this.plan.tabs.map(tab => this.tabRow(tab.name, formatArgv(tab.argv), cx));
    this.savedDraft = this.draft();
    this.error = ''; this.mode = 'edit-tabs'; this.handle.focus?.(); cx.notify();
  }

  editedTabs() {
    return validateTabs(this.editTabs.map(row => ({ name: row.inputs[0].value(), argv: parseArgv(row.inputs[1].value()) })));
  }

  commandError(row) {
    try { parseArgv(row.inputs[1].value()); return ''; } catch (error) { return textError(error); }
  }

  moveEditor(rows, index, delta, cx) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    [rows[index], rows[target]] = [rows[target], rows[index]];
    cx.notify();
  }

  removeEditor(rows, index, cx) {
    const [row] = rows.splice(index, 1); row.inputs.forEach(input => input.release?.()); cx.notify();
  }

  applyTabs(cx) {
    try {
      this.plan = { ...this.plan, tabs: this.editedTabs() };
      this.mode = 'preview'; this.error = ''; this.releaseEdits(); this.handle.focus?.(); cx.notify();
    } catch (error) { this.error = textError(error); cx.notify(); }
  }

  saveSettings(cx) {
    this.perform(cx, async () => {
      const tabs = this.editedTabs();
      const roots = this.editRoots.map(row => {
        if (!Number.isInteger(row.depth) || row.depth < 0 || row.depth > 5) throw new Error('Search depth must be a number from 0 to 5');
        return { machine: row.machine, path: row.inputs[0].value().trim(), depth: row.depth };
      });
      const next = { ...this.config, roots, tabs, machines: {} };
      const validated = validateConfig(next), text = JSON.stringify(validated, null, 2) + '\n';
      await writeTextFile(`${BASE()}/config.json`, text, this.configText);
      this.config = validated; this.configText = text; this.mode = 'browse';
      this.releaseEdits(); this.search.focus(); this.refresh(cx);
    });
  }

  async fs(request, machine = this.machine) {
    // Probe interpreters until one answers in protocol, then stick with it for
    // that machine. The backend always replies with JSON, so a non-JSON reply
    // means the interpreter never ran it and trying the next one is safe.
    this.pythons ??= new Map();
    const key = machineName(machine);
    let failure = null;
    for (const python of this.pythons.has(key) ? [this.pythons.get(key)] : PYTHONS) {
      const [cmd, ...pre] = python;
      let reply, body;
      try { reply = await exec(cmd, [...pre, '-c', this.source, JSON.stringify(request)], { on: machine }); }
      catch (error) { failure = error; continue; }
      try { body = JSON.parse(reply.stdout); }
      catch { failure = reply.stderr || reply.stdout; continue; }
      this.pythons.set(key, python);
      if (reply.code !== 0 || !body.ok) throw new Error(body.error || reply.stderr || 'Filesystem operation failed');
      return body.result;
    }
    throw new Error(`Python 3 is required on ${key} (tried ${PYTHONS.map(p => p.join(' ')).join(', ')})${failure ? `: ${textError(failure)}` : ''}`);
  }

  async command(name, args) {
    // Local window CLI, even for a remote target. Unlike run(), this returns
    // creation IDs and errors so setup can be journaled instead of guessed.
    const reply = await exec('herdr-app', ['do', name, JSON.stringify(args)]);
    let body;
    try { body = JSON.parse(reply.stdout || reply.stderr); } catch {}
    if (reply.code !== 0 || body?.error || !body) throw new Error(body?.error || reply.stderr || reply.stdout || `${name} failed`);
    return body;
  }

  ready(machine = this.machine) {
    return machines().some(m => (m.name ?? null) === machine && m.layout === 'ready');
  }

  folders(machine) {
    const all = panes();
    return Object.fromEntries(spaces().filter(s => (s.machine ?? null) === machine).flatMap(space => {
      const ids = new Set(space.tabs.map(tab => tab.id));
      const active = space.tabs.find(tab => tab.active)?.id;
      const mine = all.filter(p => ids.has(p.tab) && p.cwd);
      const representative = mine.find(p => p.tab === active && p.focused) ?? mine.find(p => p.tab === active) ?? mine[0];
      return [[space.id, representative?.cwd || space.folder], [`${space.id}#origin`, space.folder]];
    }));
  }

  refresh(cx) {
    if (!this.source || !this.config) return;
    const generation = ++this.generation;
    const names = [...new Set([null, ...machines().map(m => m.name ?? null), ...this.config.roots.map(r => r.machine), ...spaces().map(s => s.machine ?? null)])];
    this.loading = true; this.catalogs = names.map(machine => ({ machine, paths: [], warnings: [] }));
    this.warnings = []; this.plan = null;
    cx.spawn(async cx => {
      await Promise.allSettled(names.map(async machine => {
        let catalog;
        try {
          if (!this.ready(machine)) throw new Error('Machine unavailable; connect it in Settings → Machines.');
          const config = configFor(this.config, machine);
          const result = config.roots.length ? await this.fs({ action: 'discover', roots: config.roots, spaces: this.folders(machine) }, machine) :
            { paths: [], priorities: {}, canonicalSpaces: {}, warnings: [] };
          catalog = { ...result, machine, warnings: [...result.warnings.filter(w => !w.startsWith('Missing root:')),
            ...(result.truncated ? ['Folder scan reached its limit. Refine roots or open an exact path.'] : [])] };
        } catch (error) { catalog = { machine, paths: [], warnings: [textError(error)] }; }
        if (generation !== this.generation) return;
        this.catalogs = this.catalogs.map(old => old.machine === machine ? catalog : old);
        this.warnings = this.catalogs.flatMap(c => c.warnings.map(w => `${c.machine ?? 'local'}: ${w}`));
        cx.notify();
      }));
      if (generation === this.generation) { this.loading = false; cx.notify(); }
    });
  }

  rows() { return combinedCandidates(spaces(), this.catalogs, this.query); }

  switchMachine(machine, cx) {
    if (this.busy || shared(OP) || shared(CLONE)) return;
    this.machine = machine; this.error = '';
    this.rootInput.set_value(configFor(this.config, machine).roots[0]?.path ?? '~');
    cx.notify();
  }

  perform(cx, work) {
    if (this.busy) return;
    this.busy = true; this.error = ''; cx.notify();
    cx.spawn(async cx => {
      try { await work(cx); }
      catch (error) { this.error = textError(error); }
      this.busy = false; cx.notify();
    });
  }

  choose(row, cx) {
    if (!row || this.busy) return;
    if (row.kind === 'space') { run('space.select', { id: row.id }); closeOverlay(props().overlay); return; }
    this.prepare(row.path, cx, row.machine);
  }

  prepare(path, cx, machine = this.machine) {
    if (!this.source || !this.ready(machine)) return;
    this.machine = machine;
    this.perform(cx, async () => {
      const config = configFor(this.config, machine);
      const plan = await this.fs({ action: 'plan', path, tabs: config.tabs }, machine);
      plan.tabs = validateTabs(plan.tabs);
      const canonical = this.catalogs.find(c => c.machine === machine)?.canonicalSpaces ?? {};
      const existing = duplicateSpace(machine, plan.path, spaces(), canonical);
      if (existing) { run('space.select', { id: existing.id }); closeOverlay(props().overlay); }
      else { this.plan = plan; this.mode = 'preview'; this.handle.focus?.(); }
    });
  }

  assertIdle() {
    if (shared(OP) || shared(CLONE)) throw new Error('Another operation is pending. Inspect its recovery record first.');
  }

  createFolder(cx) {
    if (!this.source || !this.ready() || shared(OP) || shared(CLONE)) return;
    const root = this.rootInput.value(), name = this.nameInput.value();
    this.perform(cx, async () => {
      const destination = await this.fs({ action: 'destination', root, name });
      // The button explicitly says Create folder; no directory is created while browsing.
      this.assertIdle();
      setShared(OP, { phase: 'creating-folder', machine: this.machine, path: destination.path, at: Date.now() });
      const result = await this.fs({ action: 'mkdir', root, name });
      setShared(OP, null);
      const plan = await this.fs({ action: 'plan', path: result.path, tabs: configFor(this.config, this.machine).tabs });
      this.plan = plan; this.mode = 'preview'; this.handle.focus?.();
    });
  }

  startClone(cx) {
    if (!this.source || !this.ready() || shared(OP) || shared(CLONE)) return;
    const machine = this.machine, root = this.rootInput.value(), name = this.nameInput.value(), url = this.urlInput.value();
    this.perform(cx, async () => {
      const destination = await this.fs({ action: 'destination', root, name }, machine);
      this.assertIdle();
      setShared(CLONE, { machine, path: destination.path, state: 'starting', at: Date.now() });
      const result = await this.fs({ action: 'clone-start', root, name, url }, machine);
      setShared(CLONE, { machine, ...result, state: 'running', at: Date.now() });
    });
  }

  pollClone(cx) {
    const clone = shared(CLONE);
    if (!this.source || !clone?.job) return;
    this.polling = true;
    cx.spawn(async cx => {
      try {
        const status = await this.fs({ action: 'clone-status', job: clone.job }, clone.machine);
        if (shared(CLONE)?.job !== clone.job) return;
        if (status.state === 'complete') setShared(CLONE, { ...clone, ...status, job: undefined });
        else if (status.state === 'failed') setShared(CLONE, { ...clone, ...status, job: undefined });
      } catch (error) { this.error = `Clone status: ${textError(error)}. The clone may still be running; do not restart it.`; }
      finally { this.polling = false; cx.notify(); }
    });
  }

  launch(cx) {
    if (!this.plan || shared(OP) || shared(CLONE) || !this.ready()) return;
    const plan = this.plan, machine = this.machine;
    this.perform(cx, async () => {
      // Recheck against the latest UI snapshot immediately before creation.
      const fresh = await this.fs({ action: 'discover', roots: [{ path: plan.path, depth: 0 }], spaces: this.folders(machine) }, machine);
      const existing = duplicateSpace(machine, plan.path, spaces(), fresh.canonicalSpaces);
      if (existing) { run('space.select', { id: existing.id }); closeOverlay(props().overlay); return; }
      this.assertIdle();
      const journal = newJournal(machine, plan);
      await launchSpace(journal, (name, args) => this.command(name, args), state => setShared(OP, { ...state, createdTabs: [...state.createdTabs] }));
      setShared(OP, null);
      run('tab.select', { id: journal.createdTabs[0] });
      closeOverlay(props().overlay);
    });
  }

  // ───────────────────────────── building blocks ─────────────────────────────

  mono() { return settings()?.font_family ?? 'monospace'; }

  machineColor(machine) {
    const t = theme();
    if (machine === null || machine === undefined) return t.accent;
    let h = 0; for (const c of machine) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return t[`ansi${[13, 11, 14, 10, 12][h % 5]}`] ?? t.muted;
  }

  machineReady(machine) { return machines().some(m => (m.name ?? null) === machine && m.layout === 'ready'); }

  button(id, label, action, enabled = true, { variant = 'ghost', icon = null, kbd = null } = {}) {
    const t = theme(), primary = variant === 'primary', secondary = variant === 'secondary';
    return h_flex().id(id).h(32).px(12).gap(7).flex_none().items_center().rounded(7).text_size(12.5).font_medium()
      .when(primary, el => el.bg(t.solid).text_color(t.solid_foreground))
      .when(secondary, el => el.bg(t.raised).border_1().border_color(t.border).text_color(t.foreground))
      .when(!primary && !secondary, el => el.text_color(t.muted))
      .when(!enabled, el => el.opacity(0.4))
      .when(enabled, el => el.cursor_pointer().hover(s => primary ? s.opacity(0.88) : s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { if (enabled) action(cx); })
      .when(Boolean(icon), el => el.child(svg(icon).size(14).flex_none()))
      .child(label)
      .when(Boolean(kbd), el => el.child(this.kbd(kbd, primary)));
  }

  iconButton(id, icon, tip, action, enabled = true, { danger = false, size = 28 } = {}) {
    const t = theme();
    return div().id(id).w(size).h(size).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).when(!enabled, el => el.opacity(0.3))
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg(danger ? tint(t.blocked, '22') : t.hover).text_color(danger ? t.blocked : t.foreground)))
      .tooltip(tip)
      .on_click((_e, cx) => { if (enabled) action(cx); })
      .child(svg(icon).size(14));
  }

  kbd(text, onSolid = false) {
    const t = theme();
    return div().h(18).px(5).flex_none().flex().items_center().rounded(4).border_1().text_size(10.5).font_medium()
      .border_color(onSolid ? tint(t.solid_foreground, '55') : t.border)
      .text_color(onSolid ? t.solid_foreground : t.dim).child(text);
  }

  hint(key, label) {
    const t = theme();
    return h_flex().gap(5).items_center().flex_none().child(this.kbd(key)).child(div().text_color(t.dim).child(label));
  }

  textBox(state, { width = null, mono = false, invalid = false, icon = null, h = 32, suffix = null, block = false } = {}) {
    const t = theme(), focused = this.focusedInput === state;
    return h_flex().h(h).px(10).gap(8).items_center().rounded(7).border_1().bg(t.background)
      .border_color(invalid ? t.blocked : focused ? t.accent : t.input)
      .when(block, el => el.w_full().flex_none())
      .when(!block && width !== null, el => el.w(width).flex_none()).when(!block && width === null, el => el.flex_1().min_w(0))
      .when(Boolean(icon), el => el.child(svg(icon).size(15).flex_none().text_color(focused ? t.accent : t.dim)))
      .child(Input.new(state).flex_1().min_w(0).text_color(t.foreground).when(mono, el => el.font_family(this.mono())))
      .when(Boolean(suffix), el => el.child(suffix));
  }

  field(label, state, { hint = '', icon = null, mono = false } = {}) {
    const t = theme();
    return v_flex().flex_none().gap(6)
      .child(div().text_size(12).font_medium().text_color(t.foreground).child(label))
      .child(this.textBox(state, { icon, mono, h: 36, block: true }))
      .when(Boolean(hint), el => el.child(div().text_size(11.5).text_color(t.dim).child(hint)));
  }

  machineBadge(machine) {
    const t = theme();
    return h_flex().h(22).px(8).gap(6).flex_none().items_center().rounded_full().border_1().border_color(t.border)
      .bg(t.background).text_size(11).text_color(t.muted)
      .child(svg(CHROME(machine ? 'server' : 'monitor')).size(11).flex_none().text_color(this.machineColor(machine)))
      .child(machineName(machine));
  }

  sectionTitle(title, description, action = null) {
    const t = theme();
    return h_flex().flex_none().gap(12).items_end()
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(11.5).line_height('16px').text_color(t.dim).child(description)))
      .when(Boolean(action), el => el.child(action));
  }

  callout(icon, color, children, action = null) {
    const t = theme();
    return h_flex().flex_none().px(12).py(9).gap(10).items_start().rounded(8)
      .bg(tint(color, '14')).border_1().border_color(tint(color, '44')).text_color(t.foreground)
      .child(div().pt(1).child(svg(icon).size(15).flex_none().text_color(color)))
      .child(v_flex().flex_1().min_w(0).gap(4).text_size(12.5).line_height('18px').children(children))
      .when(Boolean(action), el => el.child(action));
  }

  segmented(id, items, current, pick, locked) {
    const t = theme();
    return h_flex().id(id).flex_none().p(3).gap(2).rounded(9).bg(t.background).border_1().border_color(t.border)
      .children(items.map(([key, label, icon, count]) => {
        const on = key === current;
        return h_flex().id(`${id === 'modes' ? 'mode' : id}-${key}`).flex_1().h(30).px(10).gap(7).items_center().justify_center()
          .rounded(7).text_size(12.5).font_medium()
          .text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.raised).shadow_xs())
          .when(locked && !on, el => el.opacity(0.45))
          .when(!locked && !on, el => el.cursor_pointer().hover(s => s.text_color(t.foreground).bg(t.hover)))
          .on_click((_e, cx) => { if (!locked) pick(key, cx); })
          .when(Boolean(icon), el => el.child(svg(icon).size(14).flex_none().text_color(on ? t.accent : t.dim)))
          .child(label)
          .when(count !== undefined, el => el.child(div().px(6).h(17).flex().items_center().rounded_full()
            .bg(on ? tint(t.accent, '26') : t.raised).text_size(10.5).text_color(on ? t.accent : t.dim).child(String(count))));
      }));
  }

  // ───────────────────────────── settings rows ─────────────────────────────

  grip(rows, row, locked) {
    const t = theme();
    return div().id(`grip-${row.id}`).w(18).h(30).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
      .when(!locked, el => el.cursor_grab().hover(s => s.text_color(t.foreground)))
      .tooltip('Drag to reorder')
      .on_mouse_down('left', (_e, cx) => { if (!locked) { this.drag = { rows, id: row.id }; cx.notify(); } })
      .child(svg(ICON('grip')).size(14));
  }

  // While dragging, entering another row moves the dragged one into its place.
  dragOver(rows, row, cx) {
    if (!this.drag || this.drag.rows !== rows || this.drag.id === row.id) return;
    const from = rows.findIndex(r => r.id === this.drag.id), to = rows.indexOf(row);
    if (from < 0 || to < 0) return;
    rows.splice(to, 0, rows.splice(from, 1)[0]); cx.notify();
  }

  orderBadge(index, accent = false) {
    const t = theme();
    return div().w(22).h(22).flex_none().flex().items_center().justify_center().rounded_full()
      .bg(accent ? tint(t.accent, '22') : t.raised).text_size(11).font_medium().text_color(accent ? t.accent : t.muted).child(String(index + 1));
  }

  rowControls(rows, row, index, locked, removable) {
    return h_flex().flex_none().gap(1)
      .child(this.iconButton(`up-${row.id}`, ICON('arrow-up'), 'Move up', cx => this.moveEditor(rows, index, -1, cx), !locked && index > 0))
      .child(this.iconButton(`down-${row.id}`, ICON('arrow-down'), 'Move down', cx => this.moveEditor(rows, index, 1, cx), !locked && index + 1 < rows.length))
      .child(this.iconButton(`remove-${row.id}`, ICON('trash'), 'Remove', cx => this.removeEditor(rows, index, cx), !locked && removable, { danger: true }));
  }

  editorShell(rows, row, line, below = null) {
    const t = theme(), dragging = this.drag?.id === row.id;
    return v_flex().id(`edit-${row.id}`).flex_none().gap(4).px(6).py(5).rounded(9)
      .when(dragging, el => el.bg(t.selected).border_1().border_color(tint(t.accent, '66')))
      .when(!dragging && !this.drag, el => el.hover(s => s.bg(tint(t.hover, '80'))))
      .on_hover((hovered, cx) => { if (hovered) this.dragOver(rows, row, cx); })
      .child(line).when(Boolean(below), el => el.child(below));
  }

  tabLine(row, index, locked) {
    const t = theme(), rows = this.editTabs, problem = this.commandError(row);
    const line = h_flex().h(34).gap(8).items_center()
      .child(this.grip(rows, row, locked))
      .child(this.orderBadge(index))
      .child(this.textBox(row.inputs[0], { width: 140, invalid: !row.inputs[0].value().trim() }))
      .child(this.textBox(row.inputs[1], { mono: true, icon: CHROME('terminal'), invalid: Boolean(problem) }))
      .child(this.rowControls(rows, row, index, locked, rows.length > 1));
    return this.editorShell(rows, row, line, problem ? h_flex().pl(56).gap(6).items_center().text_size(11.5).text_color(t.blocked)
      .child(svg(ICON('alert')).size(12).flex_none()).child(problem) : null);
  }

  rootLine(row, index, locked) {
    const t = theme(), rows = this.editRoots, color = this.machineColor(row.machine);
    const names = [...new Set([null, ...machines().map(m => m.name ?? null), row.machine])];
    const stepper = h_flex().h(32).flex_none().items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .tooltip('Search depth: folder levels below this path that count as projects (0 = this folder itself)')
      .child(this.iconButton(`depth-dec-${row.id}`, CHROME('minus'), 'Shallower', cx => { row.depth--; cx.notify(); }, !locked && row.depth > 0, { size: 26 }))
      .child(div().w(18).text_center().text_size(12.5).font_medium().text_color(t.foreground).child(String(row.depth)))
      .child(this.iconButton(`depth-inc-${row.id}`, CHROME('plus'), 'Deeper', cx => { row.depth++; cx.notify(); }, !locked && row.depth < 5, { size: 26 }));
    const picker = h_flex().id(`machine-root-${row.id}`).h(32).w(118).flex_none().px(9).gap(7).items_center().rounded(7).border_1()
      .border_color(row.machineOpen ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground)
      .when(!locked, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
      .tooltip('Machine this path is searched on')
      .on_click((_e, cx) => { if (!locked) { row.machineOpen = !row.machineOpen; cx.notify(); } })
      .child(svg(CHROME(row.machine ? 'server' : 'monitor')).size(13).flex_none().text_color(color))
      .child(div().flex_1().min_w(0).truncate().child(machineName(row.machine)))
      .child(svg(CHROME('chevron-down')).size(12).flex_none().text_color(t.dim));
    const line = h_flex().h(34).gap(8).items_center()
      .child(this.grip(rows, row, locked))
      .child(this.orderBadge(index, index === 0))
      .child(picker)
      .child(this.textBox(row.inputs[0], { mono: true, icon: CHROME('folder'), invalid: !row.inputs[0].value().trim() }))
      .child(stepper)
      .child(this.rowControls(rows, row, index, locked, true));
    const choices = row.machineOpen ? h_flex().pl(56).gap(6).flex_wrap().items_center()
      .child(div().text_size(11.5).text_color(t.dim).child('Search on'))
      .children(names.map(machine => {
        const on = machine === row.machine, ready = this.machineReady(machine);
        return h_flex().id(`machine-choice-${row.id}-${machineName(machine)}`).h(26).px(10).gap(6).items_center().rounded_full().border_1()
          .border_color(on ? t.accent : t.border).bg(on ? tint(t.accent, '1f') : t.background)
          .text_size(12).text_color(on ? t.foreground : t.muted)
          .when(!locked, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
          .when(!ready, el => el.tooltip('Not connected right now; the path is still saved'))
          .on_click((_e, cx) => { if (!locked) { row.machine = machine; row.machineOpen = false; cx.notify(); } })
          .child(div().w(7).h(7).rounded_full().bg(ready ? this.machineColor(machine) : t.dim))
          .child(machineName(machine))
          .when(on, el => el.child(svg(CHROME('check')).size(12).text_color(t.accent)));
      })) : null;
    return this.editorShell(rows, row, line, choices);
  }

  columnHeads(columns) {
    const t = theme();
    return h_flex().flex_none().px(6).gap(8).items_center().text_size(10.5).font_medium().text_color(t.dim)
      .children(columns.map(([label, width]) => div().when(width === null, el => el.flex_1()).when(width !== null, el => el.w(width).flex_none()).child(label)));
  }

  tabsEditor(locked, oneOff) {
    const t = theme();
    return v_flex().gap(10)
      .child(this.sectionTitle(oneOff ? `Startup tabs for ${this.plan?.name ?? 'this Space'}` : 'Default startup tabs',
        oneOff ? 'Only affects this opening. Your saved defaults stay as they are.'
          : 'Opened left to right in every new Space, on every machine. Leave the command empty for a plain shell. Quotes work; | ; & are rejected.',
        this.button('add-tab', 'Add tab', cx => {
          this.editTabs.push(this.tabRow(`${this.editTabs.length + 1}`, '', cx)); cx.notify();
        }, !locked && this.editTabs.length < 12, { variant: 'secondary', icon: CHROME('plus') })))
      .child(this.columnHeads([['', 18], ['#', 22], ['NAME', 140], ['COMMAND', null], ['', 86]]))
      .child(v_flex().gap(2).children(this.editTabs.map((row, index) => this.tabLine(row, index, locked))))
      .when(this.editTabs.length >= 12, el => el.child(div().text_size(11.5).text_color(t.dim).child('12 tabs is the maximum.')));
  }

  rootsEditor(locked) {
    const t = theme();
    return v_flex().gap(10)
      .child(this.sectionTitle('Project roots',
        'Folders scanned for projects. Higher rows rank first in search, across all machines. Depth is how many levels below the root count as a project.',
        this.button('add-root', 'Add root', cx => {
          this.editRoots.push(this.rootRow({ machine: this.editRoots.at(-1)?.machine ?? null, path: '~/', depth: 1 }, cx)); cx.notify();
        }, !locked && this.editRoots.length < 64, { variant: 'secondary', icon: CHROME('plus') })))
      .when(this.editRoots.length > 0, el => el.child(this.columnHeads([['', 18], ['#', 22], ['MACHINE', 118], ['PATH', null], ['DEPTH', 82], ['', 86]])))
      .when(this.editRoots.length === 0, el => el.child(v_flex().py(28).gap(6).items_center().rounded(10).border_1().border_dashed().border_color(t.border)
        .child(svg(CHROME('folder')).size(22).text_color(t.dim))
        .child(div().text_color(t.muted).child('No project roots yet'))
        .child(div().text_size(11.5).text_color(t.dim).child('Add a folder like ~/dev to start finding projects.'))))
      .child(v_flex().gap(2).children(this.editRoots.map((row, index) => this.rootLine(row, index, locked))));
  }

  // ───────────────────────────── screens ─────────────────────────────

  header(title, subtitle, { back = null, locked }) {
    const t = theme();
    return h_flex().h(40).flex_none().items_center().gap(10)
      .when(Boolean(back), el => el.child(this.iconButton('back', ICON('arrow-left'), 'Back', back, !locked, { size: 32 })))
      .when(!back, el => el.child(div().w(32).h(32).flex_none().flex().items_center().justify_center().rounded(9)
        .bg(tint(t.accent, '22')).text_color(t.accent).child(svg(ICON('layers')).size(16))))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(subtitle)))
      .when(this.mode !== 'settings' && this.mode !== 'edit-tabs', el => el.child(this.iconButton('settings', CHROME('settings'), 'Settings', cx => this.startSettings(cx), !locked && Boolean(this.config), { size: 32 })))
      .child(this.iconButton('close', CHROME('x'), this.busy ? 'Working…' : 'Close (Esc)', () => closeOverlay(props().overlay), !this.busy, { size: 32 }));
  }

  footer(left, right) {
    const t = theme();
    return h_flex().flex_none().h(44).pt(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).gap(14).items_center().text_size(11.5).text_color(t.dim).children(left))
      .children(right);
  }

  operationScreen(root, operation) {
    const t = theme();
    return root.child(v_flex().flex_1().gap(14)
      .child(this.callout(ICON('alert'), t.blocked, [
        div().font_semibold().child('A Space setup was interrupted'),
        div().text_color(t.muted).child('Nothing is retried or rolled back automatically. Inspect the Space and folder, then dismiss this record. Dismissing deletes nothing.'),
      ]))
      .child(this.detailGrid([
        ['Stage', operation.phase], ['Machine', machineName(operation.machine)], ['Folder', shortPath(operation.path)],
        ['Space', operation.space ?? 'unknown'], ['Tabs created', String(operation.createdTabs?.length ?? 0)],
      ]))
      .child(h_flex().gap(8)
        .when(Boolean(operation.space), el => el.child(this.button('partial', 'Go to partial Space', () => run('space.select', { id: operation.space }), true, { variant: 'secondary', icon: ICON('layers') })))
        .child(this.button('dismiss-operation', 'I inspected it — dismiss', () => setShared(OP, null), !this.busy, { variant: 'primary', icon: CHROME('check') }))));
  }

  detailGrid(pairs) {
    const t = theme();
    return v_flex().flex_none().p(12).gap(7).rounded(10).bg(t.background).border_1().border_color(t.border)
      .children(pairs.map(([label, value]) => h_flex().gap(12).text_size(12.5)
        .child(div().w(110).flex_none().text_color(t.dim).child(label))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).font_family(this.mono()).child(String(value)))));
  }

  cloneScreen(root, clone) {
    const t = theme(), done = clone.state === 'complete', failed = clone.state === 'failed', running = Boolean(clone.job);
    const color = done ? t.done : failed ? t.blocked : t.working;
    const status = h_flex().flex_none().gap(12).items_center().p(14).rounded(10).bg(tint(color, '14')).border_1().border_color(tint(color, '44'))
      .child(div().w(34).h(34).flex_none().flex().items_center().justify_center().rounded_full().bg(tint(color, '26')).text_color(color)
        .child(running ? svg(CHROME('spinner')).size(18).spin(900) : svg(done ? CHROME('circle-check') : ICON('alert')).size(18)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().font_semibold().text_color(t.foreground).child(done ? 'Clone complete' : failed ? 'Clone failed' : running ? 'Cloning…' : 'Clone status uncertain'))
        .child(div().text_size(12).text_color(t.muted).child(clone.error ?? (done ? 'Review the startup layout before anything runs.'
          : running ? 'Runs in the background — you can close this dialog.' : 'Inspect the destination before dismissing this record.'))));
    return root.child(v_flex().flex_1().gap(14)
      .child(status)
      .child(this.detailGrid([['Machine', machineName(clone.machine)], ['Destination', shortPath(clone.path)],
        ...(clone.log ? [['Git log', shortPath(clone.log)]] : [])]))
      .child(h_flex().gap(8)
        .when(done, el => el.child(this.button('open-clone', 'Review startup layout', cx => {
          this.machine = clone.machine; setShared(CLONE, null); this.prepare(clone.path, cx);
        }, true, { variant: 'primary', icon: CHROME('chevron-right') })))
        .when(failed || !running, el => el.child(this.button('dismiss-clone', 'Dismiss (keeps files)', () => setShared(CLONE, null), !this.busy, { variant: 'secondary' })))
        .when(running, el => el.child(this.button('stop-tracking', this.confirmStop ? 'Confirm: stop tracking (Git keeps running)' : 'Stop tracking…', cx => {
          if (this.confirmStop) { setShared(CLONE, null); this.confirmStop = false; }
          else { this.confirmStop = true; cx.notify(); }
        }, !this.busy, { variant: this.confirmStop ? 'secondary' : 'ghost' })))));
  }

  settingsScreen(root, locked) {
    const t = theme(), settings = this.mode === 'settings', dirty = this.draft() !== this.savedDraft;
    const invalid = this.editTabs.some(row => this.commandError(row) || !row.inputs[0].value().trim()) || this.editRoots.some(row => !row.inputs[0].value().trim());
    const body = settings ? (this.settingsTab === 'roots' ? this.rootsEditor(locked) : this.tabsEditor(locked, false)) : this.tabsEditor(locked, true);
    return root
      .when(settings, el => el.child(this.segmented('settings-tab', [
        ['tabs', 'Startup tabs', CHROME('terminal'), this.editTabs.length],
        ['roots', 'Project roots', CHROME('folder'), this.editRoots.length],
      ], this.settingsTab, (key, cx) => { this.settingsTab = key; this.drag = null; cx.notify(); }, false)))
      .child(v_flex().id('settings-body').flex_1().min_h(0).overflow_y_scrollbar().pr(4)
        .when(Boolean(this.drag), el => el.cursor_grabbing())
        .on_hover((hovered, cx) => { if (!hovered && this.drag) { this.drag = null; cx.notify(); } })
        .child(body))
      .child(this.footer([
        h_flex().gap(6).items_center()
          .child(div().w(7).h(7).rounded_full().bg(invalid ? t.blocked : dirty ? t.working : t.done))
          .child(invalid ? 'Fix the highlighted fields' : dirty ? 'Unsaved changes' : settings ? 'Saved' : 'No changes'),
        this.hint('Ctrl S', settings ? 'save' : 'apply'),
      ], [
        this.button('cancel-edit', 'Cancel', cx => this.leaveSettings(cx), !locked),
        this.button('save-settings', settings ? 'Save changes' : 'Use this layout', cx => settings ? this.saveSettings(cx) : this.applyTabs(cx),
          !locked && !invalid, { variant: 'primary', icon: CHROME('check') }),
      ]));
  }

  previewScreen(root, locked) {
    const t = theme(), plan = this.plan, ready = this.ready();
    const tabs = v_flex().gap(2).children(plan.tabs.map((tab, i) => h_flex().h(34).px(10).gap(10).items_center().rounded(7).when(i % 2 === 0, el => el.bg(tint(t.raised, '80')))
      .child(this.orderBadge(i))
      .child(div().w(130).flex_none().truncate().font_medium().text_color(t.foreground).child(tab.name))
      .child(tab.argv
        ? div().flex_1().min_w(0).truncate().font_family(this.mono()).text_size(12).text_color(t.foreground).child(formatArgv(tab.argv))
        : div().flex_1().text_size(12).text_color(t.dim).child('Interactive shell'))));
    return root.child(v_flex().id('preview-body').flex_1().min_h(0).overflow_y_scrollbar().gap(14)
      .child(h_flex().flex_none().gap(12).items_center().p(14).rounded(10).bg(t.background).border_1().border_color(t.border)
        .child(div().w(40).h(40).flex_none().flex().items_center().justify_center().rounded(10).bg(tint(t.accent, '22')).text_color(t.accent)
          .child(svg(CHROME('folder')).size(20)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().truncate().text_size(16).font_semibold().text_color(t.foreground).child(plan.name))
          .child(div().truncate().text_size(12).font_family(this.mono()).text_color(t.dim).child(shortPath(plan.path))))
        .child(this.machineBadge(this.machine)))
      .child(this.sectionTitle(`${plan.tabs.length} startup ${plan.tabs.length === 1 ? 'tab' : 'tabs'}`,
        'These run in your normal shell environment when the Space opens.',
        this.button('customize-tabs', 'Customize…', cx => this.customizeTabs(cx), !locked, { variant: 'secondary', icon: CHROME('square-pen') })))
      .child(tabs)
      .children(plan.warnings.map(w => this.callout(ICON('alert'), t.blocked, [div().child(w)])))
      .when(!ready, el => el.child(this.callout(ICON('alert'), t.blocked, [div().child(`${machineName(this.machine)} is not connected. Connect it in Settings → Machines to open this Space.`)])))
      .child(div().text_size(11.5).text_color(t.dim).child('Project settings are data only — shell config files are never sourced.')))
      .child(this.footer([
        this.button('preview-back', 'Back', cx => { this.mode = 'browse'; this.plan = null; this.search.focus(); cx.notify(); }, !locked, { icon: ICON('arrow-left') }),
      ], [
        this.button('launch-defaults', 'Open with defaults', cx => {
          this.plan = { ...this.plan, tabs: configFor(this.config, this.machine).tabs };
          this.launch(cx);
        }, !locked && ready, { variant: 'secondary' }),
        this.button('launch', this.busy ? 'Opening…' : 'Open Space', cx => this.launch(cx), !locked && ready, { variant: 'primary', kbd: '↵' }),
      ]));
  }

  destinationPicker(locked) {
    const t = theme();
    return v_flex().flex_none().gap(6)
      .child(div().text_size(12).font_medium().text_color(t.foreground).child('Machine'))
      .child(h_flex().id('destination-machines').gap(6).flex_wrap().children(machines().map(m => {
        const name = m.name ?? null, on = this.machine === name, ready = m.layout === 'ready';
        return h_flex().id(`destination-${machineName(name)}`).h(34).px(12).gap(8).items_center().rounded(8).border_1()
          .border_color(on ? t.accent : t.border).bg(on ? tint(t.accent, '1a') : t.background)
          .text_size(12.5).text_color(on ? t.foreground : t.muted)
          .when(!ready, el => el.opacity(0.45).tooltip(m.layout === 'loading' ? 'Connecting…' : 'Unavailable — connect it in Settings → Machines'))
          .when(ready && !locked && !on, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => { if (ready && !locked) this.switchMachine(name, cx); })
          .child(svg(CHROME(name ? 'server' : 'monitor')).size(14).text_color(this.machineColor(name)))
          .child(machineName(name))
          .when(on, el => el.child(svg(CHROME('check')).size(13).text_color(t.accent)));
      })));
  }

  formScreen(root, locked) {
    const t = theme(), ready = this.ready();
    let body = v_flex().id('form-body').flex_1().min_h(0).overflow_y_scrollbar().gap(18).child(this.destinationPicker(locked));
    let action;
    if (this.mode === 'path') {
      body = body.child(this.field('Folder', this.pathInput, { icon: CHROME('folder'), mono: true,
        hint: 'An absolute path or ~/… on the chosen machine. Symlinks are resolved; an already-open folder switches to its Space.' }));
      action = this.button('open-path', 'Review folder', cx => this.prepare(this.pathInput.value(), cx), !locked && ready && Boolean(this.pathInput.value().trim()), { variant: 'primary', kbd: '↵' });
    } else {
      const roots = this.config ? configFor(this.config, this.machine).roots : [];
      const parent = trimSlashes(this.rootInput.value().trim()), name = this.nameInput.value().trim();
      body = body.child(v_flex().flex_none().gap(8)
        .child(this.field('Parent folder', this.rootInput, { icon: CHROME('folder'), mono: true }))
        .when(roots.length > 0, el => el.child(h_flex().gap(6).flex_wrap().items_center()
          .child(div().text_size(11.5).text_color(t.dim).child('Roots:'))
          .children(roots.map((r, i) => {
            const on = parent === trimSlashes(r.path);
            return div().id(`root-${i}`).h(24).px(9).flex().items_center().rounded_full().border_1()
              .border_color(on ? t.accent : t.border).when(on, el => el.bg(tint(t.accent, '1a')))
              .text_size(11.5).font_family(this.mono()).text_color(on ? t.foreground : t.muted)
              .when(!locked, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
              .on_click((_e, cx) => { if (!locked) { this.rootInput.set_value(r.path); cx.notify(); } })
              .child(r.path);
          })))))
        .child(this.field('New folder name', this.nameInput, { icon: CHROME('folder-plus'), mono: true, hint: 'Relative to the parent. Must not exist yet. Nothing is ever overwritten.' }))
        .when(this.mode === 'clone', el => el.child(this.field('Repository URL', this.urlInput, { icon: CHROME('git-branch'), mono: true,
          hint: 'Uses your existing Git/SSH credentials. Failed clones keep their files and log.' })))
        .when(Boolean(parent && name), el => el.child(h_flex().flex_none().gap(8).items_center().px(12).h(34).rounded(8).bg(t.background).border_1().border_dashed().border_color(t.border)
          .child(svg(CHROME('chevron-right')).size(13).text_color(t.dim))
          .child(div().text_size(12).text_color(t.dim).child(this.mode === 'clone' ? 'Clones into' : 'Creates'))
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(this.mono()).text_color(t.foreground).child(`${parent}/${name}`))
          .child(this.machineBadge(this.machine))));
      const enabled = !locked && ready && Boolean(parent && name) && (this.mode !== 'clone' || Boolean(this.urlInput.value().trim()));
      action = this.button('create', this.mode === 'new' ? 'Create & review' : 'Clone & review',
        cx => this.mode === 'new' ? this.createFolder(cx) : this.startClone(cx), enabled, { variant: 'primary', icon: this.mode === 'new' ? CHROME('folder-plus') : ICON('download') });
    }
    return root.child(body).child(this.footer([
      !ready ? h_flex().gap(6).items_center().text_color(t.blocked).child(svg(ICON('alert')).size(12)).child(`${machineName(this.machine)} is not connected`)
        : div().child('Startup tabs are reviewed before anything runs.'),
    ], [action]));
  }

  browseScreen(root, locked) {
    const t = theme(), rows = this.rows();
    const spinner = this.loading ? svg(CHROME('spinner')).size(14).flex_none().text_color(t.dim).spin(900) : null;
    const list = rows.length === 0
      ? v_flex().flex_1().min_h(0).items_center().justify_center().gap(8)
        .child(div().w(44).h(44).flex().items_center().justify_center().rounded(12).bg(t.raised).text_color(t.dim).child(svg(CHROME(this.loading ? 'clock' : 'folder')).size(20)))
        .child(div().font_medium().text_color(t.foreground).child(this.loading ? 'Scanning machines…' : this.query ? `No projects match “${this.query}”` : 'No projects found'))
        .child(div().text_size(12).text_color(t.dim).child(this.loading ? 'Results appear as each machine answers.' : 'Try Exact path, or add a project root in Settings.'))
        .when(!this.loading, el => el.child(h_flex().gap(8).pt(4)
          .child(this.button('empty-path', 'Exact path', cx => this.setMode('path', cx), !locked, { variant: 'secondary', icon: ICON('text-cursor') }))
          .child(this.button('empty-settings', 'Project roots', cx => { this.settingsTab = 'roots'; this.startSettings(cx); }, !locked && Boolean(this.config), { variant: 'secondary', icon: CHROME('settings') }))))
      : v_flex().id('result-list').relative().flex_1().min_h(ROW)
        .child(v_virtual_list('sessionizer-results', rows.length, ROW, index => rows[index].key,
          range => rows.slice(range.start, range.end).map((row, offset) => {
            const selected = range.start + offset === this.at;
            return h_flex().h(ROW - 4).px(10).mr(12).gap(12).items_center().rounded(9).cursor_pointer()
              .when(selected, el => el.bg(t.selected)).when(!selected, el => el.hover(s => s.bg(tint(t.hover, '99'))))
              .child(div().w(30).h(30).flex_none().flex().items_center().justify_center().rounded(8)
                .bg(selected ? tint(t.accent, '26') : t.raised).text_color(selected ? t.accent : t.muted)
                .child(svg(row.kind === 'space' ? ICON('layers') : CHROME('folder')).size(15)))
              .child(v_flex().flex_1().min_w(0).gap(1)
                .child(h_flex().gap(6).items_center().min_w(0)
                  .child(div().truncate().font_medium().text_color(t.foreground).child(row.name))
                  .when(Boolean(row.active), el => el.child(div().px(6).h(16).flex().items_center().rounded_full().bg(tint(t.done, '26')).text_size(10).text_color(t.done).child('current'))))
                .child(h_flex().min_w(0).gap(6).items_center().text_size(11.5)
                  .child(h_flex().flex_none().gap(4).items_center().font_medium().text_color(this.machineColor(row.machine))
                    .child(svg(CHROME(row.machine ? 'server' : 'monitor')).size(11).flex_none())
                    .child(machineName(row.machine)))
                  .child(div().flex_none().text_color(t.dim).child('·'))
                  .child(div().min_w(0).truncate().text_color(t.dim).child(parentOf(row.path)))))
              .child(div().w(20).flex_none().when(selected, el => el.child(svg(ICON('enter')).size(14).text_color(t.muted))));
          }))
          .track_scroll(this.listScroll)
          .on_item_click((key, cx) => this.choose(this.rows().find(row => row.key === key), cx)))
        .child(Scrollbar.vertical('sessionizer-results').absolute().inset_0());
    const machineCount = new Set(rows.map(r => r.machine)).size;
    return root
      .child(this.textBox(this.search, { icon: CHROME('search'), h: 42, suffix: spinner, block: true }))
      .child(list)
      .child(this.footer([
        div().child(`${rows.length} ${rows.length === 1 ? 'project' : 'projects'}${machineCount > 1 ? ` · ${machineCount} machines` : ''}${this.loading ? ' · scanning…' : ''}`),
        ...(this.warnings.length ? [h_flex().id('warnings').min_w(0).gap(5).items_center().text_color(t.blocked).tooltip(this.warnings.join('\n'))
          .child(svg(ICON('alert')).size(12).flex_none())
          .child(div().truncate().child(this.warnings.length === 1 ? this.warnings[0] : `${this.warnings.length} warnings`))] : []),
      ], [
        this.hint('↑↓', 'select'), this.hint('↵', 'open'), this.hint('esc', 'close'),
        this.iconButton('refresh', ICON('refresh'), 'Rescan all machines', cx => this.refresh(cx), !locked && !this.loading),
      ]));
  }

  setMode(mode, cx) {
    this.mode = mode; this.plan = null; this.error = '';
    if (mode !== 'browse') this.rootInput.set_value(configFor(this.config, this.machine).roots[0]?.path ?? '~');
    ({ browse: this.search, path: this.pathInput, new: this.nameInput, clone: this.urlInput })[mode]?.focus();
    cx.notify();
  }

  onKey(e, cx, rows, locked) {
    const mod = e.modifiers?.control || e.modifiers?.platform;
    if ((this.mode === 'settings' || this.mode === 'edit-tabs') && mod && e.key === 's') {
      if (!locked) this.mode === 'settings' ? this.saveSettings(cx) : this.applyTabs(cx);
      cx.stop_propagation(); return;
    }
    if (this.mode === 'preview' && e.key === 'enter' && !locked && this.ready()) { this.launch(cx); cx.stop_propagation(); return; }
    if (this.mode !== 'browse' || locked) return;
    const step = { down: 1, up: -1, pagedown: 8, pageup: -8 }[e.key] ?? (e.modifiers?.control && e.key === 'n' ? 1 : e.modifiers?.control && e.key === 'p' ? -1 : 0);
    if (step) {
      this.at = Math.max(0, Math.min(rows.length - 1, this.at + step));
      this.listScroll.scroll_to_item(this.at, 'center');
      cx.stop_propagation(); cx.notify();
    }
  }

  render(cx) {
    const t = theme(), operation = shared(OP), clone = shared(CLONE);
    const locked = this.busy || Boolean(operation) || Boolean(clone);
    const rows = this.mode === 'browse' ? this.rows() : [];
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const titles = {
      settings: ['Settings', 'Defaults shared by every machine'],
      'edit-tabs': ['Customize tabs', this.plan ? `${this.plan.name} · ${machineName(this.machine)}` : ''],
      preview: ['Review startup', 'Nothing runs until you open the Space'],
    };
    const [title, subtitle] = operation ? ['Recovery', 'An earlier operation needs attention'] : clone ? ['Clone', shortPath(clone.path)]
      : titles[this.mode] ?? ['Sessionizer', 'Open a project as a Space'];
    const back = !operation && !clone && (this.mode === 'settings' || this.mode === 'edit-tabs') ? cx => this.leaveSettings(cx) : null;
    let root = v_flex().id('sessionizer').track_focus(this.handle).size_full().min_h(0).p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .when(Boolean(this.drag), el => el.cursor_grabbing())
      .on_mouse_up('left', (_e, cx) => { if (this.drag) { this.drag = null; cx.notify(); } })
      .on_key_down((e, cx) => this.onKey(e, cx, rows, locked))
      .child(this.header(title, subtitle, { back, locked }))
      .when(Boolean(this.error), el => el.child(this.callout(ICON('alert'), t.blocked, [div().child(this.error)],
        this.iconButton('dismiss-error', CHROME('x'), 'Dismiss', cx => { this.error = ''; cx.notify(); }, true, { size: 22 }))));

    if (operation) return this.operationScreen(root, operation);
    if (clone) return this.cloneScreen(root, clone);
    if (this.mode === 'settings' || this.mode === 'edit-tabs') return this.settingsScreen(root, locked);
    if (this.mode === 'preview' && this.plan) return this.previewScreen(root, locked);

    root = root.child(this.segmented('modes', MODES, this.mode, (mode, cx) => this.setMode(mode, cx), locked));
    if (this.mode === 'new' || this.mode === 'clone' || this.mode === 'path') return this.formScreen(root, locked);
    return this.browseScreen(root, locked);
  }
}
