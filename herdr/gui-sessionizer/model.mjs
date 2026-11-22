// Pure policy and matching. No UI, shell, filesystem or global session state.
export function validateConfig(raw) {
  if (!raw || ![1, 2].includes(raw.version)) throw new Error('Sessionizer config must have version: 1 or 2');
  if (!Array.isArray(raw.roots)) throw new Error('Configure an ordered roots array');
  if (raw.machines !== undefined && (!raw.machines || typeof raw.machines !== 'object' || Array.isArray(raw.machines))) throw new Error('machines must be an object keyed by configured machine name');
  const checkRoot = (r, machine) => {
    if (!r || typeof r.path !== 'string' || !r.path || !Number.isInteger(r.depth) || r.depth < 0 || r.depth > 5) throw new Error('Each root needs a path and depth (0–5)');
    if (machine !== null && (typeof machine !== 'string' || !machine.trim())) throw new Error('Each root needs local (null) or a machine name');
    return { machine, path: r.path, depth: r.depth };
  };
  // Read legacy machine lists without losing them; the next GUI save writes v2.
  const roots = raw.roots.map(r => checkRoot(r, raw.version === 1 ? null : r.machine));
  const machines = {};
  for (const [machine, override] of Object.entries(raw.machines ?? {})) {
    if (!override || typeof override !== 'object' || Array.isArray(override) || Object.keys(override).some(key => !['roots', 'tabs'].includes(key))) throw new Error(`Invalid override for ${machine}`);
    if (override.roots !== undefined) {
      if (raw.version !== 1 || !Array.isArray(override.roots)) throw new Error('v2 stores all machine paths in the global roots list');
      roots.push(...override.roots.map(r => checkRoot(r, machine)));
    }
    // Legacy per-machine layouts are no longer applied: defaults are global.
    if (override.tabs) validateTabs(override.tabs);
  }
  if (roots.length > 64) throw new Error('Configure at most 64 search roots');
  return { version: 2, roots, tabs: validateTabs(raw.tabs), machines };
}
export function validateTabs(tabs) {
  if (!Array.isArray(tabs) || !tabs.length || tabs.length > 12) throw new Error('Startup layout needs 1–12 tabs');
  return tabs.map(t => {
    if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 100) throw new Error('Every startup tab needs a short name');
    if (t.argv !== null && (!Array.isArray(t.argv) || !t.argv.length || t.argv.some((a, index) => typeof a !== 'string' || (index === 0 && !a) || a.includes('\0')))) throw new Error('argv must be null (shell) or a nonempty array of arguments');
    return { name: t.name, argv: t.argv === null ? null : [...t.argv] };
  });
}
export function configFor(config, machine) {
  config = validateConfig(config);
  return { ...config, roots: config.roots.map((root, priority) => ({ ...root, priority })).filter(root => root.machine === machine),
    tabs: config.tabs, machines: {} };
}
export function parseArgv(text) {
  if (!text.trim()) return null;
  if (text.trim().startsWith('[')) return validateTabs([{name:'command',argv:JSON.parse(text)}])[0].argv;
  const words = []; let word = '', quote = null, escaped = false, started = false;
  for (const c of text) {
    if (escaped) { word += c; escaped = false; started = true; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (c === quote) quote = null; else word += c; started = true; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false; } continue; }
    if ('|;&<>'.includes(c)) throw new Error('Shell operators are not supported; specify sh -c explicitly if needed');
    word += c; started = true;
  }
  if (quote || escaped) throw new Error('Unclosed quote or trailing backslash in command');
  if (started) words.push(word);
  return validateTabs([{name:'command',argv:words}])[0].argv;
}
export function formatArgv(argv) {
  if (argv?.some(arg => /[\n\r\t]/.test(arg))) return JSON.stringify(argv);
  return argv ? argv.map(arg => /^[\w./:@%+=,-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ') : '';
}
export function fuzzyScore(query, text) {
  query = query.toLocaleLowerCase().trim(); text = text.toLocaleLowerCase();
  if (!query) return 0;
  let at = -1, score = 0;
  for (const c of query) {
    const next = text.indexOf(c, at + 1);
    if (next < 0) return -Infinity;
    score += next === at + 1 ? 12 : 1;
    if (next === 0 || '/\\_- .'.includes(text[next - 1])) score += 8;
    at = next;
  }
  return score - text.length / 100;
}
export function candidates(machine, allSpaces, paths, canonicalSpaces, query, priorities = {}) {
  const current = allSpaces.filter(s => (s.machine ?? null) === machine);
  const spaceByPath = new Map();
  for (const s of current) {
    const path = canonicalSpaces[s.id] || s.folder;
    for (const alias of [path, canonicalSpaces[`${s.id}#origin`] || s.folder]) if (alias && !spaceByPath.has(alias)) spaceByPath.set(alias, s);
  }
  const rows = current.map(s => ({ key: `space:${s.id}`, machine, kind: 'space', id: s.id, name: s.name, path: canonicalSpaces[s.id] || s.folder || '', active: s.active }));
  for (const path of new Set(paths)) if (!spaceByPath.has(path)) rows.push({ key: `path:${path}`, kind: 'path', machine, path, priority: priorities[path] ?? 0, name: path.split(/[\\/]/).filter(Boolean).at(-1) || path });
  return rows.map(r => ({ ...r, score: fuzzyScore(query, `${r.name} ${r.path} ${machine ?? 'local'}`) }))
    .filter(r => r.score > -Infinity)
    .sort((a, b) => Number(b.kind === 'space') - Number(a.kind === 'space') ||
      (a.priority ?? 0) - (b.priority ?? 0) || b.score - a.score || a.name.localeCompare(b.name));
}
export function combinedCandidates(allSpaces, catalogs, query) {
  const names = new Set([...catalogs.map(c => c.machine), ...allSpaces.map(s => s.machine ?? null)]);
  return [...names].flatMap(machine => {
    const catalog = catalogs.find(c => c.machine === machine);
    return candidates(machine, [], catalog?.paths ?? [], catalog?.canonicalSpaces ?? {}, query, catalog?.priorities ?? {})
      .map(row => ({ ...row, key: JSON.stringify([machine, row.key]) }));
  }).sort((a, b) => Number(b.kind === 'space') - Number(a.kind === 'space') ||
    (a.priority ?? 0) - (b.priority ?? 0) || b.score - a.score || a.name.localeCompare(b.name) || (a.machine ?? '').localeCompare(b.machine ?? ''));
}
export function duplicateSpace(machine, path, spaces, canonical = {}) {
  return spaces.find(s => (s.machine ?? null) === machine && [canonical[s.id], canonical[`${s.id}#origin`], s.folder].includes(path));
}
export function newJournal(machine, plan) {
  return { version: 1, machine, path: plan.path, name: plan.name, tabs: plan.tabs, space: null, createdTabs: [], phase: 'prepared', at: Date.now() };
}
// One request per stage. Persist BEFORE each mutation: an interrupted request is
// uncertain, not safe to retry. No automatic rollback of programs or user files.
export async function launchSpace(journal, command, save) {
  journal.phase = 'creating-space'; save(journal);
  const first = journal.tabs[0];
  const result = await command('space.new', { machine: journal.machine ?? '', folder: journal.path, name: journal.name, tab: first.name, ...(first.argv ? { argv: first.argv } : {}) });
  if (typeof result.space !== 'string' || typeof result.tab !== 'string') throw new Error('Space creation reply missing IDs; inspect recovery record before retrying');
  journal.space = result.space; journal.createdTabs.push(result.tab); journal.phase = 'space-created'; save(journal);
  for (const tab of journal.tabs.slice(1)) {
    journal.phase = 'creating-tab'; save(journal);
    const result = await command('tab.new', { space: journal.space, folder: journal.path, name: tab.name, ...(tab.argv ? { argv: tab.argv } : {}) });
    if (typeof result.tab !== 'string') throw new Error('Tab creation reply missing ID; inspect recovery record before retrying');
    journal.createdTabs.push(result.tab); journal.phase = 'tab-created'; save(journal);
  }
  journal.phase = 'complete'; save(journal);
  return journal;
}
