"""Name-addressed native intercom, bounded to the caller's hc space."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import shlex
import socket
import sqlite3
import stat
import subprocess
import time
import uuid

from discovery import discover, identity, named


def database():
    root = Path(os.environ.get('INTERCOM_STATE_DIR', str(Path.home() / '.local/state/intercom')))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(root / 'scoped-mail.sqlite', timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('''CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      sender_provider TEXT NOT NULL, sender_session TEXT NOT NULL,
      recipient_provider TEXT NOT NULL, recipient_session TEXT NOT NULL,
      body TEXT NOT NULL, reply_to TEXT, state TEXT NOT NULL, created REAL NOT NULL)''')
    return db


def envelope(row):
    cli = shlex.quote(str(Path(__file__).with_name('intercom.py').resolve()))
    return ('Intercom peer request. Use the intercom skill and your normal permissions.\n' +
            json.dumps(dict(row)) + '\nReply: python3 ' + cli + ' reply ' + row['id'] + " 'your reply'")


def deliver(peer, row):
    if peer['provider'] == 'claude':
        endpoint = Path(peer['endpoint'])
        info = endpoint.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('Unsafe native inbox endpoint')
        payload = dict(type='user', session_id=peer['session'], uuid=row['id'],
                       msg_id=row['id'], **{'from': row['sender']},
                       message=dict(role='user', content=envelope(row)))
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(str(endpoint))
            client.sendall((json.dumps(payload) + '\n').encode())
        return
    if peer['provider'] == 'opencode':
        argv = ['opencode', 'api', 'POST', '/api/session/' + peer['session'] + '/synthetic',
                '--data', json.dumps(dict(text=envelope(row), delivery='queue',
                  description='Intercom from ' + row['sender'],
                  metadata={'intercom': {'id': row['id'], 'scope': row['scope']}}))]
    else:
        argv = ['codex', 'queue', '--thread', peer['session'], '--message', envelope(row)]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError(result.stderr[-1000:])


def put(db, scope, sender, recipient, body, reply_to=None):
    mid = str(uuid.uuid4())
    db.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
               (mid, scope, sender['name'], recipient['name'], *identity(sender),
                *identity(recipient), body, reply_to, 'stored', time.time()))
    db.commit()
    row = db.execute('SELECT * FROM messages WHERE id=?', (mid,)).fetchone()
    try:
        deliver(recipient, row)
    except Exception:
        db.execute("UPDATE messages SET state='delivery_unknown' WHERE id=?", (mid,))
        db.commit()
        raise
    db.execute("UPDATE messages SET state='submitted' WHERE id=?", (mid,))
    db.commit()
    return mid


def scoped_message(db, mid, scope, own, role):
    row = db.execute('SELECT * FROM messages WHERE id=? AND scope=?', (mid, scope)).fetchone()
    if not row or (row[role + '_provider'], row[role + '_session']) != identity(own):
        raise ValueError('Message is outside this session/scope')
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    send = sub.add_parser('send')
    send.add_argument('name', help='Exact native session name in this hc space')
    send.add_argument('body')
    reply = sub.add_parser('reply')
    reply.add_argument('message')
    reply.add_argument('body')
    sub.add_parser('inbox')
    wait = sub.add_parser('wait')
    wait.add_argument('message')
    wait.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args()
    with closing(database()) as db, db:
        expected = None
        if args.command in ('reply', 'wait'):
            message = db.execute('SELECT * FROM messages WHERE id=?', (args.message,)).fetchone()
            if message:
                role = 'recipient' if args.command == 'reply' else 'sender'
                expected = message[role + '_provider'], message[role + '_session']
        scope, peers, own = discover(expected)
        # Also reject an ambiguous sender; a name alone must address one session.
        named(peers, own['name'])
        if args.command == 'list':
            print(json.dumps({'scope': json.loads(scope), 'self': own['name'], 'sessions': peers}, indent=2))
        elif args.command == 'send':
            print(json.dumps({'id': put(db, scope, own, named(peers, args.name), args.body)}))
        elif args.command == 'reply':
            row = scoped_message(db, args.message, scope, own, 'recipient')
            targets = [p for p in peers if identity(p) == (row['sender_provider'], row['sender_session'])]
            if len(targets) != 1:
                raise ValueError('Original sender is no longer uniquely present in this hc space')
            named(peers, targets[0]['name'])
            mid = put(db, scope, own, targets[0], args.body, row['id'])
            db.execute("UPDATE messages SET state='replied' WHERE id=?", (row['id'],))
            print(json.dumps({'id': mid, 'reply_to': row['id']}))
        elif args.command == 'inbox':
            rows = db.execute('''SELECT * FROM messages WHERE scope=? AND recipient_provider=?
                AND recipient_session=? ORDER BY created''', (scope, *identity(own)))
            print(json.dumps([dict(row) for row in rows], indent=2))
        elif args.command == 'wait':
            scoped_message(db, args.message, scope, own, 'sender')
            deadline = time.monotonic() + args.timeout
            while True:
                row = db.execute('SELECT * FROM messages WHERE reply_to=? AND scope=? ORDER BY created LIMIT 1',
                                 (args.message, scope)).fetchone()
                if row:
                    print(json.dumps(dict(row)))
                    break
                if time.monotonic() >= deadline:
                    raise ValueError('No reply before timeout; original message remains pending')
                time.sleep(.2)


def run():
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as exc:
        raise SystemExit(str(exc)) from exc
