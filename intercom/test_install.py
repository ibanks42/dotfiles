from pathlib import Path
import subprocess
import tempfile
import unittest

from install import install


class InstallTests(unittest.TestCase):
    def test_links_work_outside_checkout_and_install_is_repeatable(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as root:
            home = Path(root)
            install(home, repo)
            result = subprocess.run([str(home / '.local/bin/intercom'), '--help'],
                                    cwd=home, capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)
            for base in ['.agents', '.claude']:
                skill = home / base / 'skills/intercom/SKILL.md'
                self.assertEqual(repo / '.agents/skills/intercom/SKILL.md', skill.resolve())
            self.assertTrue(all(a.get('status') == 'already linked' for a in install(home, repo)))

    def test_existing_files_and_broken_links_are_backed_up(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as root:
            home = Path(root)
            command = home / '.local/bin/intercom'
            command.parent.mkdir(parents=True)
            command.write_text('existing command')
            skill = home / '.claude/skills/intercom'
            skill.parent.mkdir(parents=True)
            skill.symlink_to(home / 'missing-old-skill')
            actions = install(home, repo)
            backups = [Path(a['backup']) for a in actions if 'backup' in a]
            self.assertEqual(2, len(backups))
            self.assertTrue(any(p.is_file() and p.read_text() == 'existing command' for p in backups))
            self.assertTrue(any(p.is_symlink() for p in backups))
            self.assertEqual(repo / 'intercom/intercom.py', command.resolve())


if __name__ == '__main__':
    unittest.main()
