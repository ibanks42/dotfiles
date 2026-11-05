import json
from contextlib import closing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from discovery import caller_terminal, calling_peer, discover, named, native_peer, opencode_tabs, scoped_terminals
import sqlite3
import socket
from runtime import database, put, scoped_message


def peer(name, session):
    return dict(name=name, provider='claude', session=session)


class ScopeTests(unittest.TestCase):
    def test_opencode_idle_tabs_are_eligible_but_history_and_closed_tabs_are_not(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'XDG_STATE_HOME': root}):
            path = Path(root) / 'opencode/latest/tui/tabs.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'cwd': {'/project': {'tabs': [
                {'sessionID': 'selected'}, {'sessionID': 'idle-background'}]}}}))
            sessions = {
                'selected': {'title': 'oc-main', 'location': {'directory': '/project'}},
                'idle-background': {'title': 'oc-idle', 'location': {'directory': '/project'}}}
            terminal = dict(address='t2', state='live', cwd='/project', title='OC | oc-main',
                            status={'app': 'opencode'}, foreground={'pid': 1, 'cwd': '/project'})
            def get_session(argv):
                self.assertEqual('/api/session/', argv[-1][:13])
                return {'data': sessions[argv[-1].split('/')[-1]]}
            with patch('discovery.command', side_effect=get_session):
                active = native_peer(terminal)
                self.assertEqual('selected', active['session'])
                self.assertEqual('idle-background', opencode_tabs(terminal, active, [terminal])[0]['session'])
                # A historical name outside the tab IDs is not even queried.
                terminal['title'] = 'OC | historical-session'
                self.assertIsNone(native_peer(terminal))
                path.write_text(json.dumps({'cwd': {'/project': {'tabs': [{'sessionID': 'selected'}]}}}))
                terminal['title'] = 'OC | oc-idle'
                self.assertIsNone(native_peer(terminal))
                path.unlink()
                terminal['title'] = 'OC | oc-main'
                self.assertIsNone(native_peer(terminal))

    def test_claude_historical_registry_without_live_inbox_is_excluded(self):
        with tempfile.TemporaryDirectory() as root, patch('discovery.Path.home', return_value=Path(root)):
            registry = Path(root) / '.claude/sessions' / f'{os.getpid()}.json'
            registry.parent.mkdir(parents=True)
            endpoint = Path(root) / 'closed.sock'
            registry.write_text(json.dumps({'pid': os.getpid(), 'cwd': '/project',
                'sessionId': 'historical', 'name': 'orchestrator', 'messagingSocketPath': str(endpoint)}))
            terminal = dict(address='t1', state='live', cwd='/project',
                foreground={'name': 'claude', 'pid': os.getpid(), 'cwd': '/project'},
                status={'app': 'claude-code'})
            self.assertIsNone(native_peer(terminal))
            # A stale socket file is not a running session either.
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(endpoint))
            self.assertIsNone(native_peer(terminal))
            endpoint.unlink()
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(endpoint))
                server.listen(4)
                self.assertEqual(os.getpid(), native_peer(terminal)['pid'])
                # A retained status report cannot make a recovered shell an agent.
                terminal['foreground']['name'] = 'zsh'
                self.assertIsNone(native_peer(terminal))
                # A registry cannot claim another process's live inbox.
                terminal['foreground'].update(name='claude', pid=os.getpid() + 100000)
                data = json.loads(registry.read_text())
                data['pid'] = terminal['foreground']['pid']
                (registry.parent / f"{data['pid']}.json").write_text(json.dumps(data))
                self.assertIsNone(native_peer(terminal))

    def test_sole_historical_match_and_cached_binding_are_never_recipients(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'CODEX_HOME': root}):
            with closing(sqlite3.connect(Path(root) / 'state_5.sqlite')) as db, db:
                db.execute('CREATE TABLE threads (id TEXT, name TEXT, cwd TEXT, archived INTEGER)')
                db.execute('INSERT INTO threads VALUES (?,?,?,0)', ('historical', 'orchestrator', '/rc2fx'))
            terminal = dict(address='t24', state='live', created_ms=10, cwd='/rc2fx',
                title='orchestrator | rc2fx', foreground={'pid': 123, 'cwd': '/rc2fx'},
                status={'app': 'codex'}, labels={})
            with patch('discovery.loaded_threads', return_value=set()):
                self.assertIsNone(native_peer(terminal))
                terminal['labels'] = {'intercom.codex.thread': 'historical',
                    'intercom.codex.pid': '123', 'intercom.codex.created': '10'}
                self.assertIsNone(native_peer(terminal))
            with patch('discovery.loaded_threads', side_effect=OSError('control socket unavailable')):
                with self.assertRaises(OSError):
                    native_peer(terminal)

    def test_historical_duplicate_name_is_not_a_live_codex_session(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'CODEX_HOME': root}):
            with closing(sqlite3.connect(Path(root) / 'state_5.sqlite')) as db, db:
                db.execute('CREATE TABLE threads (id TEXT, name TEXT, cwd TEXT, archived INTEGER)')
                db.executemany('INSERT INTO threads VALUES (?,?,?,0)', [
                    ('old-thread', 'orchestrator', '/rc2fx'),
                    ('restored-thread', 'orchestrator', '/rc2fx')])
            terminal = dict(address='t24', state='live', cwd='/rc2fx',
                title='orchestrator | rc2fx', foreground={'pid': 123, 'cwd': '/rc2fx'},
                status={'app': 'codex'}, labels={})
            with patch('discovery.loaded_threads', return_value={'restored-thread'}):
                self.assertEqual('restored-thread', native_peer(terminal)['session'])
            with patch('discovery.loaded_threads', return_value={'old-thread', 'restored-thread'}):
                with self.assertRaisesRegex(ValueError, 'uniquely bind'):
                    native_peer(terminal)
            with patch('discovery.loaded_threads', return_value=set()):
                self.assertIsNone(native_peer(terminal))

    def test_registered_codex_binding_survives_transient_title(self):
        with tempfile.TemporaryDirectory() as root, patch('discovery.loaded_threads', return_value={'rc-thread', 'new-thread'}), patch.dict(os.environ, {
                'CODEX_HOME': root, 'CODEX_THREAD_ID': 'rc-thread', 'HC_TERMINAL_ID': 't21'}):
            with closing(sqlite3.connect(Path(root) / 'state_5.sqlite')) as db, db:
                db.execute('CREATE TABLE threads (id TEXT, name TEXT, cwd TEXT, archived INTEGER)')
                db.execute('INSERT INTO threads VALUES (?,?,?,0)', ('rc-thread', 'orchestrator', '/rc2fx'))
            terminal = dict(address='t25', state='live', created_ms=10, cwd='/rc2fx',
                title='Working on SSH', status={'app': 'codex'},
                foreground={'pid': 123, 'cwd': '/rc2fx'}, labels={
                    'herdr.space': 'rc2fx', 'intercom.codex.thread': 'rc-thread',
                    'intercom.codex.pid': '123', 'intercom.codex.created': '10'})
            self.assertEqual(('t25', ('codex', 'rc-thread')), caller_terminal([terminal]))
            # Stale OSC metadata must not hide a real Codex foreground process.
            terminal['status'] = None
            terminal['foreground']['name'] = 'codex'
            self.assertEqual(('t25', ('codex', 'rc-thread')), caller_terminal([terminal]))
            # A real session switch in the same TUI replaces the old binding.
            with closing(sqlite3.connect(Path(root) / 'state_5.sqlite')) as db, db:
                db.execute('INSERT INTO threads VALUES (?,?,?,0)', ('new-thread', 'new-session', '/rc2fx'))
            terminal['title'] = 'new-session | rc2fx'
            self.assertEqual('new-thread', native_peer(terminal)['session'])
            with self.assertRaisesRegex(ValueError, 'refusing inherited scope'):
                caller_terminal([terminal])
            terminal['title'] = 'Working on SSH'
            terminal['foreground']['pid'] = 456
            with self.assertRaisesRegex(ValueError, 'refusing inherited scope'):
                caller_terminal([terminal])

    def test_unknown_or_duplicated_native_thread_never_falls_back_to_terminal_env(self):
        terminal = dict(address='t21', state='live', status={'app': 'codex'})
        with patch.dict(os.environ, {'CODEX_THREAD_ID': 'native', 'HC_TERMINAL_ID': 't21'}):
            with patch('discovery.native_peer', return_value=peer('other', 'different')):
                with self.assertRaisesRegex(ValueError, 'refusing inherited scope'):
                    caller_terminal([terminal])
            with patch('discovery.native_peer', return_value=peer('same', 'native')):
                with self.assertRaisesRegex(ValueError, 'refusing inherited scope'):
                    caller_terminal([terminal, dict(terminal, address='t25')])

    def test_native_codex_thread_overrides_stale_daemon_terminal_environment(self):
        terminals = [dict(address='t21', state='live', created_ms=1, foreground={'pid': 21}, status={'app': 'codex'}, labels={'herdr.space': 'dotfiles'}),
                     dict(address='t25', state='live', created_ms=2, foreground={'pid': 25}, status={'app': 'codex'}, labels={'herdr.space': 'rc2fx'})]
        native = {'t21': dict(name='codex-test', provider='codex', session='dotfiles-thread'),
                  't25': dict(name='orchestrator', provider='codex', session='rc2fx-thread')}
        with patch.dict(os.environ, {'HC_TERMINAL_ID': 't21', 'CODEX_THREAD_ID': 'rc2fx-thread'}), \
                patch('discovery.snapshot', return_value=('core', terminals)), \
                patch('discovery.command', return_value={}), \
                patch('discovery.native_peer', side_effect=lambda t: native[t['address']]):
            scope, peers, own = discover()
        self.assertEqual('orchestrator', own['name'])
        self.assertEqual('rc2fx', json.loads(scope)[2])
        self.assertNotIn('codex-test', [p['name'] for p in peers])

    def test_inactive_tab_reply_keeps_addressed_identity(self):
        tabs = [dict(peer('oc-test1', 'active'), provider='opencode', terminal='t2'),
                dict(peer('oc-test', 'inactive'), provider='opencode', terminal='t2')]
        self.assertEqual('oc-test', calling_peer(tabs, 't2', ('opencode', 'inactive'))['name'])
        with self.assertRaises(ValueError):
            calling_peer(tabs, 't3', ('opencode', 'inactive'))

    def test_tab_sender_uses_running_session_and_rejects_concurrency(self):
        tabs = [dict(peer('selected', 'a'), provider='opencode', terminal='t2'),
                dict(peer('background', 'b'), provider='opencode', terminal='t2')]
        with patch('discovery.command', return_value={'data': {'b': {'type': 'running'}}}):
            self.assertEqual('background', calling_peer(tabs, 't2')['name'])
        with patch('discovery.command', return_value={'data': {'a': {}, 'b': {}}}):
            with self.assertRaisesRegex(ValueError, 'ambiguous'):
                calling_peer(tabs, 't2')

    def test_tab_directory_shared_with_other_space_fails_closed(self):
        terminal = dict(state='live', status={'app': 'opencode'},
                        foreground={'cwd': '/project'})
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            opencode_tabs(terminal, {'session': 'a'}, [terminal, dict(terminal)])

    def test_saved_tabs_need_live_anchor_and_native_cwd_validation(self):
        terminal = dict(state='live', status={'app': 'opencode'}, foreground={'cwd': '/project'})
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'XDG_STATE_HOME': root}):
            path = Path(root) / 'opencode/latest/tui/tabs.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'cwd': {'/project': {'tabs': [{'sessionID': 'b'}]}}}))
            with self.assertRaisesRegex(ValueError, 'active session'):
                opencode_tabs(terminal, {'session': 'a'}, [terminal])
            path.write_text(json.dumps({'cwd': {'/project': {'tabs': [{'sessionID': 'a'}, {'sessionID': 'b'}]}}}))
            with patch('discovery.command', return_value={'data': {
                    'title': 'background', 'location': {'directory': '/project'}}}):
                self.assertEqual('b', opencode_tabs(terminal, {'session': 'a'}, [terminal])[0]['session'])
            with patch('discovery.command', return_value={'data': {
                    'title': 'other', 'location': {'directory': '/elsewhere'}}}):
                with self.assertRaisesRegex(ValueError, 'unexpected directory'):
                    opencode_tabs(terminal, {'session': 'a'}, [terminal])

    def test_duplicate_name_in_other_space_is_excluded(self):
        terminals = [dict(address='t1', state='live', labels={'herdr.space': 'a'}),
                     dict(address='t2', state='live', labels={'herdr.space': 'b'}),
                     dict(address='remote/t3', state='live', labels={'herdr.space': 'a'})]
        with patch.dict(os.environ, {'HC_SESSION': 'test'}):
            scope, members = scoped_terminals('core1', terminals, 't1')
        self.assertEqual(['core1', 'test', 'a'], json.loads(scope))
        self.assertEqual(['t1'], [t['address'] for t in members])

    def test_missing_scope_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'no hc space'):
            scoped_terminals('core1', [dict(address='t1', state='live')], 't1')

    def test_names_are_exact_and_duplicates_fail(self):
        peers = [peer('review', 'one'), peer('review', 'two')]
        for name in ['review', 'rev', 'one', 'Review']:
            with self.assertRaises(ValueError):
                named(peers, name)

    def test_mail_cannot_be_read_or_replied_across_scope_or_identity(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'INTERCOM_STATE_DIR': root}):
            with closing(database()) as db, db, patch('runtime.deliver') as delivery:
                sender, receiver = peer('sender', 's1'), peer('receiver', 's2')
                mid = put(db, 'scope-a', sender, receiver, 'hello')
                delivery.assert_called_once()
                for scope, actor in [('scope-b', receiver), ('scope-a', sender)]:
                    with self.assertRaises(ValueError):
                        scoped_message(db, mid, scope, actor, 'recipient')
                # Identity remains valid after a display-name change.
                renamed = peer('renamed', 's2')
                self.assertEqual(mid, scoped_message(db, mid, 'scope-a', renamed, 'recipient')['id'])

    def test_ambiguous_transport_is_persisted_without_retry(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'INTERCOM_STATE_DIR': root}):
            with closing(database()) as db, db, patch('runtime.deliver', side_effect=TimeoutError('unknown')) as delivery:
                with self.assertRaises(TimeoutError):
                    put(db, 'scope-a', peer('a', '1'), peer('b', '2'), 'hello')
                self.assertEqual(1, delivery.call_count)
                self.assertEqual('delivery_unknown', db.execute('SELECT state FROM messages').fetchone()[0])


if __name__ == '__main__':
    unittest.main()
