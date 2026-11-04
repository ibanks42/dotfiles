"""Resolve native session names inside the caller's hc core/session/space."""
import json
from contextlib import closing
import os
from pathlib import Path
import select
import sqlite3
import subprocess
from urllib.parse import quote


def command(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError(result.stderr.strip()[-1000:])
    return json.loads(result.stdout) if result.stdout.strip() else None


def snapshot():
    process = subprocess.Popen(['hc', 'connect'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, text=True)
    results = []
    try:
        for index, method in enumerate(['hello', 'terminal.list']):
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': index,
                                            'method': method, 'params': {}}) + '\n')
            process.stdin.flush()
            if not select.select([process.stdout], [], [], 10)[0]:
                raise ValueError('hc discovery timed out')
            response = json.loads(process.stdout.readline())
            if 'error' in response:
                raise ValueError(str(response['error']))
            results.append(response['result'])
    finally:
        process.terminate()
        process.wait(timeout=5)
    return results[0]['core']['id'], results[1]['terminals']


def scoped_terminals(core, terminals, caller):
    own = next((t for t in terminals if t['address'] == caller and t['state'] == 'live'), None)
    if not own:
        raise ValueError('Caller must be a live local hc terminal (HC_TERMINAL_ID)')
    space = own.get('labels', {}).get('herdr.space')
    if not space:
        raise ValueError('Caller has no hc space; refusing unscoped discovery')
    scope = json.dumps([core, os.environ.get('HC_SESSION', 'default'), space])
    return scope, [t for t in terminals if '/' not in t['address'] and
                   t['state'] == 'live' and t.get('labels', {}).get('herdr.space') == space]


def native_peer(terminal):
    app = terminal.get('status', {}).get('app') if terminal.get('status') else None
    if (terminal.get('foreground') or {}).get('name') == 'codex':
        app = 'codex'  # OSC status can lag behind an otherwise live TUI.
    pid = terminal.get('foreground', {}).get('pid') if terminal.get('foreground') else None
    cwd = terminal.get('foreground', {}).get('cwd', terminal['cwd']) if terminal.get('foreground') else terminal['cwd']
    if app == 'claude-code':
        path = Path.home() / '.claude/sessions' / f'{pid}.json'
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        if data.get('pid') != pid or data.get('cwd') != cwd:
            return None
        return dict(name=data.get('name'), provider='claude', session=data['sessionId'],
                    endpoint=data.get('messagingSocketPath'))
    if app == 'opencode':
        title = terminal.get('title', '')
        if not title.startswith('OC | '):
            return None
        name = title[5:]
        data = command(['opencode', 'api', 'GET', '/api/session?search=' + quote(name) + '&order=desc'])
        matches = [s for s in data.get('data', []) if s.get('title') == name and
                   s.get('location', {}).get('directory') == cwd]
    elif app == 'codex':
        name = terminal.get('title', '').lstrip(' ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✔').rsplit(' | ', 1)[0]
        path = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'state_5.sqlite'
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            matches = [dict(id=row[0]) for row in db.execute(
                'SELECT id FROM threads WHERE name=? AND cwd=? AND archived=0', (name, cwd))]
            labels = terminal.get('labels', {})
            bound = labels.get('intercom.codex.thread')
            same_process = (labels.get('intercom.codex.pid') == str(pid) and
                            labels.get('intercom.codex.created') == str(terminal.get('created_ms')))
            if bound and same_process:
                # A positive different-session title invalidates the binding;
                # unrecognized working text does not. Scope still comes from
                # this live hc terminal, never from a cached space/cwd.
                if not matches or all(m['id'] == bound for m in matches):
                    row = db.execute('SELECT id,name FROM threads WHERE id=? AND archived=0', (bound,)).fetchone()
                    if row and row[1]:
                        return dict(name=row[1], provider='codex', session=row[0], endpoint=None)
    else:
        return None
    if len(matches) != 1:
        raise ValueError(f'Cannot uniquely bind {name!r} to a native {app} session')
    return dict(name=name, provider=app, session=matches[0]['id'], endpoint=None)


def opencode_tabs(terminal, active, all_terminals):
    """Use the saved tab set only when one live TUI can own that cwd."""
    cwd = terminal['foreground']['cwd']
    owners = [t for t in all_terminals if t.get('state') == 'live' and
              (t.get('status') or {}).get('app') == 'opencode' and
              (t.get('foreground') or {}).get('cwd', t.get('cwd')) == cwd]
    if len(owners) != 1:
        raise ValueError('OpenCode tab ownership is ambiguous: multiple live terminals share this directory')
    root = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state')))
    path = root / 'opencode/latest/tui/tabs.json'
    if not path.exists():
        return []
    saved = json.loads(path.read_text()).get('cwd', {}).get(cwd, {}).get('tabs', [])
    ids = {tab.get('sessionID') for tab in saved}
    if active['session'] not in ids:
        raise ValueError('OpenCode saved tabs do not contain the live active session')
    peers = []
    for sid in ids - {active['session'], None}:
        try:
            session = command(['opencode', 'api', 'GET', '/api/session/' + quote(sid)])['data']
        except ValueError as exc:
            if '404' in str(exc) or 'SessionNotFound' in str(exc):
                continue
            raise
        if session.get('location', {}).get('directory') != cwd:
            raise ValueError('OpenCode saved tab has an unexpected directory')
        if session.get('title'):
            peers.append(dict(name=session['title'], provider='opencode', session=sid, endpoint=None))
    return peers


def calling_peer(peers, caller, expected=None):
    candidates = [p for p in peers if p['terminal'] == caller]
    if expected:
        candidates = [p for p in candidates if identity(p) == expected]
    elif len(candidates) > 1:
        # A shell tool belongs to the session currently executing it, which may
        # be an inactive TUI tab. Never silently select a different busy tab.
        active = command(['opencode', 'api', 'GET', '/api/session/active']).get('data', {})
        working = [p for p in candidates if p['session'] in active]
        if len(working) > 1:
            raise ValueError('Multiple OpenCode tabs are working; sender identity is ambiguous')
        candidates = working or candidates[:1]  # First is the selected TUI tab.
    if len(candidates) != 1:
        raise ValueError('Current native session cannot be uniquely bound to the caller terminal')
    return candidates[0]


def caller_terminal(terminals):
    """Codex's daemon may give tools another TUI's HC_TERMINAL_ID.

    CODEX_THREAD_ID is supplied for the individual tool invocation. Bind that
    native identity to a live TUI before choosing a space; never use cwd as a
    substitute or fall back to the inherited terminal on a failed match.
    """
    thread = os.environ.get('CODEX_THREAD_ID')
    if thread:
        matches = []
        rejected = []
        for terminal in terminals:
            if (terminal.get('state') != 'live' or '/' in terminal['address'] or
                    ((terminal.get('status') or {}).get('app') != 'codex' and
                     (terminal.get('foreground') or {}).get('name') != 'codex')):
                continue
            try:
                peer = native_peer(terminal)
            except ValueError as exc:
                # An unrelated unnamed/ambiguous Codex TUI is not a caller
                # candidate. If ours is ambiguous, no unique match remains.
                rejected.append(f"{terminal['address']}: {exc}")
                continue
            if peer and peer['session'] == thread:
                matches.append(terminal['address'])
            elif peer:
                rejected.append(f"{terminal['address']}: different native thread ({peer['name']})")
        if len(matches) != 1:
            raise ValueError('Native Codex thread cannot be uniquely bound to a live hc terminal; refusing inherited scope. '
                             + f'Invocation thread={thread}; candidates: ' + ('; '.join(rejected) or str(matches)))
        return matches[0], ('codex', thread)
    caller = os.environ.get('HC_TERMINAL_ID')
    if not caller:
        raise ValueError('Run intercom inside an hc terminal; HC_TERMINAL_ID is required')
    return caller, None


def discover(expected=None):
    if not os.environ.get('CODEX_THREAD_ID') and not os.environ.get('HC_TERMINAL_ID'):
        raise ValueError('Run intercom inside an hc terminal; native caller identity is required')
    core, all_terminals = snapshot()
    caller, native_identity = caller_terminal(all_terminals)
    if expected and native_identity and expected != native_identity:
        raise ValueError('Message identity does not match the invoking native Codex thread')
    scope, terminals = scoped_terminals(core, all_terminals, caller)
    if native_identity:
        terminal = next(t for t in terminals if t['address'] == caller)
        labels = terminal.get('labels', {})
        registration = {'intercom.codex.thread': native_identity[1],
                        'intercom.codex.pid': str(terminal['foreground']['pid']),
                        'intercom.codex.created': str(terminal['created_ms'])}
        if any(labels.get(k) != v for k, v in registration.items()):
            # Persist only a positively validated caller, not guesses based on
            # cwd, the inherited HC_TERMINAL_ID, or a global session name.
            command(['hc', 'label', caller, *(k + '=' + v for k, v in registration.items())])
            terminal.setdefault('labels', {}).update(registration)
    peers = []
    for terminal in terminals:
        peer = native_peer(terminal)
        if peer and peer.get('name'):
            peers.append(dict(peer, terminal=terminal['address']))
            if peer['provider'] == 'opencode':
                peers.extend(dict(tab, terminal=terminal['address'])
                             for tab in opencode_tabs(terminal, peer, all_terminals))
    own = calling_peer(peers, caller, expected or native_identity)
    return scope, peers, own


def named(peers, name):
    matches = [p for p in peers if p['name'] == name]
    if len(matches) != 1:
        raise ValueError(f'Session name {name!r}: expected one match in this hc space, found {len(matches)}')
    return matches[0]


def identity(peer):
    return peer['provider'], peer['session']
