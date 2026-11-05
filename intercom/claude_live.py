"""Connect only to a live Claude inbox owned by the expected local process."""
import os
from pathlib import Path
import socket
import stat
import struct


def connect_inbox(pid, endpoint):
    if not isinstance(pid, int) or pid <= 0 or not endpoint:
        raise OSError('Missing Claude process/inbox identity')
    info = Path(endpoint).lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise OSError('Unsafe Claude inbox endpoint')
    if not hasattr(socket, 'SO_PEERCRED'):
        raise ValueError('Strict Claude inbox process verification requires SO_PEERCRED on this platform')
    client = socket.socket(socket.AF_UNIX)
    try:
        client.settimeout(2)
        client.connect(str(endpoint))
        owner_pid, owner_uid, _ = struct.unpack('3i', client.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if owner_pid != pid or owner_uid != os.getuid():
            raise OSError('Claude inbox is owned by a different process')
        return client
    except BaseException:
        client.close()
        raise
