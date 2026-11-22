"""Stateless JSON filesystem protocol, run on the SELECTED machine via hc exec.
No shell evaluation, sourcing config, or Herdr lifecycle operations here.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

MAX_DIRS = 4000
MAX_SECONDS = 3


def path_of(value):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError('Enter a valid folder path')
    if value == '~' or value.startswith('~/') or (os.sep == '\\' and value.startswith('~\\')):
        value = str(Path.home()) + value[1:]
    p = Path(value)
    if not p.is_absolute():
        raise ValueError('Use an absolute path or ~/… (on the selected machine)')
    return p.resolve()


def validate_tabs(tabs):
    if not isinstance(tabs, list) or not 1 <= len(tabs) <= 12:
        raise ValueError('Startup layout must contain 1–12 tabs')
    result = []
    for tab in tabs:
        name, argv = tab.get('name'), tab.get('argv')
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ValueError('Startup tabs need nonempty names of at most 100 characters')
        if argv is not None and (not isinstance(argv, list) or not argv or any(not isinstance(a, str) or (index == 0 and not a) or '\x00' in a for index, a in enumerate(argv))):
            raise ValueError('Use argv arrays, not shell command strings')
        result.append({'name': name, 'argv': argv})
    return result


def project_plan(path, tabs):
    tabs = validate_tabs(tabs)
    config = path / '.herdr-sessionizer.json'
    warnings = []
    if config.is_file():
        if config.stat().st_size > 65536:
            raise ValueError('Project startup config is too large (64 KiB limit)')
        raw = json.loads(config.read_text(encoding='utf-8'))
        if raw.get('version') != 1 or set(raw) - {'version', 'tabs'}:
            raise ValueError('Project config supports only version: 1 and tabs')
        tabs = validate_tabs(raw.get('tabs'))
        warnings.append('Project startup configuration: ' + str(config))
    if (path / '.tmux_sessionizer.conf').exists():
        warnings.append('Legacy .tmux_sessionizer.conf is NOT executed. Convert its tab layout to .herdr-sessionizer.json.')
    return {'path': str(path), 'name': path.name or 'home', 'tabs': tabs, 'warnings': warnings}


def discover(request):
    roots = request.get('roots', [])
    if not isinstance(roots, list) or not 1 <= len(roots) <= 64:
        raise ValueError('Configure 1–64 roots')
    paths, seen, warnings, priorities = [], set(), [], {}
    started = time.monotonic()
    truncated = False
    def add(p, priority):
        canonical = str(p.resolve())
        if canonical not in seen:
            seen.add(canonical)
            paths.append(canonical)
            priorities[canonical] = priority
    for index, spec in enumerate(roots):
        priority = spec.get('priority', index)
        if not isinstance(priority, int) or isinstance(priority, bool) or priority < 0:
            raise ValueError('Root priority must be a nonnegative integer')
        depth = spec.get('depth')
        if not isinstance(depth, int) or isinstance(depth, bool) or not 0 <= depth <= 5:
            raise ValueError('Root depth must be 0–5')
        root = path_of(spec.get('path'))
        if not root.is_dir():
            warnings.append('Missing root: ' + str(root))
            continue
        pending = [(root, 0)]
        while pending:
            if len(paths) >= MAX_DIRS or time.monotonic() - started > MAX_SECONDS:
                truncated = True
                break
            folder, level = pending.pop()
            add(folder, priority)
            if level >= depth:
                continue
            try:
                # Never follow directory symlinks or Windows junctions: bounded
                # traversal, no cycles.
                with os.scandir(folder) as entries:
                    children = []
                    for entry in entries:
                        if len(children) >= MAX_DIRS or time.monotonic() - started > MAX_SECONDS:
                            truncated = True
                            break
                        if entry.name != '.git' and entry.is_dir(follow_symlinks=False) and not is_junction(entry):
                            children.append(Path(entry.path))
                    pending.extend((child, level + 1) for child in sorted(children, reverse=True))
            except OSError as error:
                warnings.append(str(error))
        if truncated:
            break
    canonical = {}
    for key, value in request.get('spaces', {}).items():
        if value:
            try:
                canonical[key] = str(path_of(value))
            except (ValueError, OSError):
                pass
    return {'paths': paths, 'priorities': priorities, 'canonicalSpaces': canonical, 'warnings': warnings[:20], 'truncated': truncated, 'home': str(Path.home())}


def is_junction(entry):
    if os.name != 'nt':
        return False
    if hasattr(entry, 'is_junction'):  # Python 3.12+
        return entry.is_junction()
    try:
        return bool(entry.stat(follow_symlinks=False).st_file_attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
    except OSError:
        return True


def destination(request):
    root = path_of(request.get('root'))
    if not root.is_dir():
        raise ValueError('Choose an existing parent folder')
    name = request.get('name', '')
    if not isinstance(name, str) or not name.strip() or Path(name).is_absolute() or '..' in Path(name).parts or '\x00' in name:
        raise ValueError('Use a nonempty relative folder name without ..')
    target = (root / name).resolve()
    if target == root or root not in target.parents:
        raise ValueError('Destination must stay beneath the chosen root')
    if target.exists():
        raise ValueError('Destination already exists; use Open folder instead')
    return target


# Clone runs independently of the window. Status is atomically replaced; a
# window closing never cancels git or launches a duplicate clone on reopening.
CLONE_WORKER = r'''
import json, os, subprocess, sys, time
from pathlib import Path
job, target, url = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
def status(state, **extra):
    temp = job / 'status.tmp'
    temp.write_text(json.dumps(dict(state=state, path=target, **extra)), encoding='utf-8')
    temp.replace(job / 'status.json')
try:
    status('running')
    with (job / 'git.log').open('wb') as log:
        result = subprocess.run(['git', 'clone', '--', url, target], stdin=subprocess.DEVNULL,
            stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, GIT_TERMINAL_PROMPT='0'), timeout=1800)
    if result.returncode:
        raise RuntimeError('git clone exited ' + str(result.returncode))
    status('complete')
except Exception as error:
    status('failed', error=str(error), log=str(job / 'git.log'))
'''


def clone_start(request):
    target = destination(request)
    url = request.get('url', '').strip()
    # Explicit transports only; no ext:: helpers, option injection, or shell.
    if not (re.match(r'^(https://|ssh://|git://|file://)', url) or re.match(r'^[\w.-]+@[\w.-]+:[^\s]+$', url)):
        raise ValueError('Use an https://, ssh://, git://, file:// or user@host:path Git URL')
    if any(ord(c) < 32 for c in url):
        raise ValueError('Git URL contains control characters')
    if re.match(r'^https://[^/]*@', url):
        raise ValueError('Do not put credentials in Git URLs; configure a credential helper')
    # Exclusive reservation. No overwrites, including an existing empty folder.
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    token = uuid.uuid4().hex
    job = Path.home() / '.cache/herdr-sessionizer/jobs' / token
    job.mkdir(parents=True, mode=0o700)
    (job / 'status.json').write_text(json.dumps({'state': 'starting', 'path': str(target)}), encoding='utf-8')
    # Detach so git outlives this helper: a new session on Unix; on Windows a
    # new process group with a hidden console that git inherits (a fully
    # detached worker would flash a console window for every git child).
    if os.name == 'nt':
        detach = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    else:
        detach = {'start_new_session': True}
    try:
        subprocess.Popen([sys.executable, '-c', CLONE_WORKER, str(job), str(target), url],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **detach)
    except Exception as error:
        (job / 'status.json').write_text(json.dumps({'state': 'failed', 'path': str(target), 'error': str(error)}), encoding='utf-8')
        raise
    return {'job': token, 'path': str(target)}


def dispatch(request):
    action = request.get('action')
    if action == 'discover':
        return discover(request)
    if action == 'plan':
        path = path_of(request.get('path'))
        if not path.is_dir():
            raise ValueError('Folder does not exist on this machine')
        return project_plan(path, request.get('tabs'))
    if action == 'destination':
        return {'path': str(destination(request))}
    if action == 'mkdir':
        target = destination(request)
        target.mkdir(parents=True, exist_ok=False)
        return {'path': str(target)}
    if action == 'clone-start':
        return clone_start(request)
    if action == 'clone-status':
        token = request.get('job', '')
        if not re.fullmatch('[a-f0-9]{32}', token):
            raise ValueError('Invalid clone job ID')
        return json.loads((Path.home() / '.cache/herdr-sessionizer/jobs' / token / 'status.json').read_text(encoding='utf-8'))
    raise ValueError('Unknown filesystem operation')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': dispatch(json.loads(sys.argv[1]))}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
