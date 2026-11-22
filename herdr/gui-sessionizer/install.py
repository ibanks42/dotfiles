#!/usr/bin/env python3
"""Install the sessionizer mod into Herdr's app folder (Linux, macOS, Windows).

Files are replaced atomically; an existing config.json is preserved.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parent
app_home = Path(os.environ.get('HERDR_APP_HOME') or Path.home() / '.config' / 'herdr-app')
destination = app_home / 'mods' / 'sessionizer'


def install(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=dst.parent, prefix='.install.')
    os.close(fd)
    shutil.copyfile(src, temp)
    os.chmod(temp, 0o644)
    os.replace(temp, dst)


for name in ['main.js', 'model.mjs', 'filesystem.py', 'mod.json']:
    install(source / name, destination / name)
for icon in sorted((source / 'icons').glob('*.svg')):
    install(icon, destination / 'icons' / icon.name)
if not (destination / 'config.json').exists():
    shutil.copyfile(source / 'config.json', destination / 'config.json')

herdr_app = shutil.which('herdr-app')
if herdr_app is None:
    sys.exit(f'Installed {destination}, but herdr-app is not on PATH to check it')
subprocess.run([herdr_app, 'check', str(destination)], check=True)
print(f'Installed {destination} (existing config preserved)')
