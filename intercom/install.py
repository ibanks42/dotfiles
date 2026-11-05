#!/usr/bin/env python3
"""Install the native intercom command and shared skills for this OS user."""
from datetime import datetime
from pathlib import Path
import json


def install(home, repo):
    repo = repo.resolve()
    command = repo / 'intercom/intercom.py'
    skill = repo / '.agents/skills/intercom'
    if not command.is_file() or not (skill / 'SKILL.md').is_file():
        raise ValueError('Run this installer from a complete dotfiles checkout')
    targets = {
        home / '.local/bin/intercom': command,
        home / '.agents/skills/intercom': skill,
        home / '.claude/skills/intercom': skill,
    }
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    actions = []
    for target, source in targets.items():
        if target.is_symlink() and target.resolve() == source:
            actions.append({'path': str(target), 'status': 'already linked'})
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            backup = home / '.backup/dotfiles' / stamp / target.relative_to(home)
            backup.parent.mkdir(parents=True, exist_ok=True)
            target.rename(backup)
            actions.append({'backup': str(backup)})
        target.symlink_to(source, target_is_directory=source.is_dir())
        actions.append({'path': str(target), 'target': str(source), 'status': 'linked'})
    return actions


if __name__ == '__main__':
    print(json.dumps(install(Path.home(), Path(__file__).resolve().parents[1]), indent=2))
