import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backend', Path(__file__).with_name('filesystem.py'))
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
TABS = [{'name': 'shell', 'argv': None}]


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gui-sessionizer-test-')
        self.home = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'HOME': str(self.home), 'USERPROFILE': str(self.home)})
        self.env.start()
    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()
    def request(self, action, **args):
        return backend.dispatch(dict(action=action, **args))
    def test_home_expansion_and_absolute_only(self):
        self.assertEqual(backend.path_of('~/a'), self.home / 'a')
        with self.assertRaises(ValueError): backend.path_of('relative')
    @unittest.skipUnless(os.name == 'nt', 'Windows paths')
    def test_windows_backslash_home_and_junctions_not_followed(self):
        self.assertEqual(backend.path_of('~\\a'), self.home.resolve() / 'a')
        root = self.home / 'root'
        (root / 'real').mkdir(parents=True)
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(root / 'link'), str(root)], check=True, capture_output=True)
        result = self.request('discover', roots=[{'path': str(root), 'depth': 3}])
        self.assertEqual(sorted(result['paths']), sorted([str(root.resolve()), str((root / 'real').resolve())]))
    def test_discovery_depth_hidden_dedup_and_symlink_cycle(self):
        (self.home / 'repo/.git').mkdir(parents=True)
        (self.home / 'repo/.hidden').mkdir()
        (self.home / 'repo/deep/child').mkdir(parents=True)
        (self.home / 'repo/loop').symlink_to(self.home / 'repo', target_is_directory=True)
        result = self.request('discover', roots=[{'path': '~', 'depth': 2}, {'path': '~/repo', 'depth': 0}], spaces={'s': str(self.home / 'repo/loop')})
        self.assertIn(str(self.home / 'repo/.hidden'), result['paths'])
        self.assertNotIn(str(self.home / 'repo/.git'), result['paths'])
        self.assertNotIn(str(self.home / 'repo/deep/child'), result['paths'])
        self.assertEqual(len(result['paths']), len(set(result['paths'])))
        self.assertEqual(result['canonicalSpaces']['s'], str(self.home / 'repo'))
    def test_root_priority_is_preserved_with_overlap(self):
        (self.home / 'early/project').mkdir(parents=True)
        (self.home / 'late/aaa').mkdir(parents=True)
        result = self.request('discover', roots=[{'path': '~/early', 'depth': 1}, {'path': '~', 'depth': 2}])
        self.assertEqual(result['priorities'][str(self.home / 'early/project')], 0)
        self.assertEqual(result['priorities'][str(self.home / 'late/aaa')], 1)
        self.assertEqual(result['paths'].count(str(self.home / 'early/project')), 1)
    def test_explicit_priorities_survive_filtering_roots_for_a_machine(self):
        (self.home / 'work').mkdir()
        (self.home / 'personal').mkdir()
        result = self.request('discover', roots=[{'path': '~/work', 'depth': 0, 'priority': 0}, {'path': '~/personal', 'depth': 0, 'priority': 2}])
        self.assertEqual(result['priorities'][str(self.home / 'work')], 0)
        self.assertEqual(result['priorities'][str(self.home / 'personal')], 2)
    def test_missing_root_warns(self):
        self.assertIn('Missing root', self.request('discover', roots=[{'path': '~/absent', 'depth': 1}])['warnings'][0])
    def test_discovery_bound_is_visible(self):
        for n in range(5): (self.home / str(n)).mkdir()
        with patch.object(backend, 'MAX_DIRS', 2):
            result = self.request('discover', roots=[{'path': '~', 'depth': 1}])
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['paths']), 2)
    def test_destination_validation_and_atomic_creation(self):
        for name in ['', '..', '../escape', '/absolute', 'a/../../escape', '.']:
            with self.assertRaises(ValueError): self.request('destination', root='~', name=name)
        name = "quote' ; $(touch bad) nested/folder"
        target = self.request('mkdir', root='~', name=name)['path']
        self.assertTrue(Path(target).is_dir())
        self.assertFalse((self.home / 'bad').exists())
        with self.assertRaises(ValueError): self.request('mkdir', root='~', name=name)
    def test_symlink_escape_rejected(self):
        with tempfile.TemporaryDirectory() as outside:
            (self.home / 'escape').symlink_to(outside)
            with self.assertRaises(ValueError): self.request('mkdir', root='~', name='escape/child')
    def test_project_layout_is_data_not_shell(self):
        (self.home / '.tmux_sessionizer.conf').write_text('touch SHOULD_NOT_EXIST')
        result = self.request('plan', path='~', tabs=TABS)
        self.assertTrue(result['warnings'])
        self.assertFalse((self.home / 'SHOULD_NOT_EXIST').exists())
        (self.home / '.herdr-sessionizer.json').write_text(json.dumps({'version': 1, 'tabs': [{'name': 'custom', 'argv': ['printf', 'hello; $(bad)']}]}))
        result = self.request('plan', path='~', tabs=TABS)
        self.assertEqual(result['tabs'][0]['argv'][1], 'hello; $(bad)')
    def test_invalid_project_config_fails_closed(self):
        for content in ['{bad', '{"version":2,"tabs":[]}', '{"version":1,"tabs":[{"name":"x","argv":"pi"}]}']:
            (self.home / '.herdr-sessionizer.json').write_text(content)
            with self.assertRaises((ValueError, TypeError)): self.request('plan', path='~', tabs=TABS)
    def test_clone_rejects_helpers_credentials_existing_paths(self):
        for url in ['ext::evil', '-upload-pack=evil', 'https://secret@host/repo', 'https://host/repo\nmalicious']:
            with self.assertRaises(ValueError): self.request('clone-start', root='~', name='dest', url=url)
        (self.home / 'exists').mkdir()
        with self.assertRaises(ValueError): self.request('clone-start', root='~', name='exists', url='file:///repo')
    def test_clone_worker_real_local_git_and_status(self):
        repo = self.home / 'source'
        subprocess.run(['git', 'init', '--bare', str(repo)], check=True, capture_output=True)
        with patch.object(backend.subprocess, 'Popen') as spawn:
            result = self.request('clone-start', root='~', name='destination', url=repo.as_uri())
            worker_args = spawn.call_args.args[0]
        subprocess.run(worker_args, check=True, capture_output=True, timeout=10)
        self.assertEqual(self.request('clone-status', job=result['job'])['state'], 'complete')
        self.assertTrue((self.home / 'destination/.git').is_dir())
    def test_failed_clone_preserves_folder_and_log(self):
        with patch.object(backend.subprocess, 'Popen') as spawn:
            result = self.request('clone-start', root='~', name='failed', url=(self.home / 'missing').as_uri())
            worker_args = spawn.call_args.args[0]
        subprocess.run(worker_args, check=True, capture_output=True, timeout=10)
        status = self.request('clone-status', job=result['job'])
        self.assertEqual(status['state'], 'failed')
        self.assertTrue(Path(status['log']).is_file())
        self.assertTrue((self.home / 'failed').is_dir())
    def test_job_path_traversal_is_rejected(self):
        with self.assertRaises(ValueError): self.request('clone-status', job='../../secret')


if __name__ == '__main__': unittest.main()
