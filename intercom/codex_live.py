"""Read loaded thread IDs from Codex's local control socket (no inference)."""
import base64
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import socket
import struct


def receive(sock, count):
    result = b''
    while len(result) < count:
        data = sock.recv(count - len(result))
        if not data:
            raise ValueError('Codex control socket closed')
        result += data
    return result


def send_frame(sock, payload, opcode=1):
    mask = os.urandom(4)
    size = len(payload)
    header = bytes([0x80 | opcode, 0x80 | (size if size < 126 else 126)])
    if size >= 126:
        header += struct.pack('!H', size)
    sock.sendall(header + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))


def response(sock, request_id):
    while True:
        first, second = receive(sock, 2)
        size = second & 127
        if size == 126:
            size = struct.unpack('!H', receive(sock, 2))[0]
        elif size == 127:
            size = struct.unpack('!Q', receive(sock, 8))[0]
        if size > 8 * 1024 * 1024 or second & 128 or not first & 128:
            raise ValueError('Unsupported Codex control frame')
        payload = receive(sock, size)
        opcode = first & 15
        if opcode == 9:
            send_frame(sock, payload, 10)
            continue
        if opcode == 8:
            raise ValueError('Codex control socket closed')
        if opcode != 1:
            continue
        result = json.loads(payload)
        if result.get('id') == request_id:
            if 'error' in result:
                raise ValueError(str(result['error']))
            return result['result']


@lru_cache(maxsize=1)
def loaded_threads():
    root = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    endpoint = root / 'app-server-control/app-server-control.sock'
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(3)
        sock.connect(str(endpoint))
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                      'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                      f'Sec-WebSocket-Key: {key}\r\n\r\n').encode())
        headers = b''
        while not headers.endswith(b'\r\n\r\n'):
            headers += receive(sock, 1)
            if len(headers) > 16384:
                raise ValueError('Invalid Codex control handshake')
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        if b' 101 ' not in headers.split(b'\r\n')[0] or accept.lower() not in headers.lower():
            raise ValueError('Codex control WebSocket handshake rejected')
        send_frame(sock, json.dumps({'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'intercom-discovery', 'version': '1.0'}}}).encode())
        response(sock, 1)
        send_frame(sock, b'{"method":"initialized"}')
        ids, cursor = set(), None
        while True:
            send_frame(sock, json.dumps({'id': 2, 'method': 'thread/loaded/list',
                                         'params': {'cursor': cursor, 'limit': 100}}).encode())
            page = response(sock, 2)
            ids.update(page['data'])
            next_cursor = page.get('nextCursor')
            if not next_cursor:
                return frozenset(ids)
            if next_cursor == cursor:
                raise ValueError('Repeated Codex thread cursor')
            cursor = next_cursor
