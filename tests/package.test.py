# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.
"""Fixture tests only: no installed server, real audio or current-tree release build."""
from pathlib import Path
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
import zipfile


SPEC = importlib.util.spec_from_file_location(
    'package_builder', Path(__file__).resolve().parents[1] / 'tools/build-package.py')
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class Fixture:
    def __init__(self, folder):
        self.root = Path(folder) / 'source'
        self.output = Path(folder) / 'output'
        self.root.mkdir()
        self.output.mkdir()
        self.files = sorted(BUILDER.REQUIRED_FILES | {
            'config/sirens/ss2000.json', 'config/sirens/fire_q.json',
            'config/sirens/modern_police.json', 'config/sirens/modern_lafd.json'})
        for name in self.files:
            if name in BUILDER.BINARY_FILES:
                signature = b'MZ' if name.endswith('.dll') else b'RSC7'
                self.write(name, signature + b'ORIGINAL SYNTHETIC TEST DATA\x00')
            elif name.endswith('.json'):
                self.write(name, '{}\n')
            else:
                self.write(name, '// Fixture owned by this test\n')
        self.write('client/main.js', '// committed client revision one\n')
        self.write('.gitignore', 'ignored-build/\n')
        self.write('tools/developer-only.py', '# Never an installation file\n')
        self.write('tests/never-ship.txt', 'Development fixture\n')
        self.write('docs/beacon-preview.png', b'PNG PLACEHOLDER, NO REAL IMAGE')
        self.set_version('3.9.1')
        self.git('init', '-q')
        for name, value in [('user.name', 'Package Fixture'),
                            ('user.email', 'fixture@example.invalid'),
                            ('commit.gpgsign', 'false'), ('core.autocrlf', 'false')]:
            self.git('config', name, value)
        self.commit = self.save_commit()

    def git(self, *args, input_bytes=None):
        result = subprocess.run(['git', '-C', str(self.root), *args], input=input_bytes,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise AssertionError('Fixture Git failed: ' + args[0] + ': ' + result.stderr.decode('utf-8', errors='replace'))
        return result.stdout

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode('utf-8'))

    def load_json(self, name):
        return json.loads((self.root / name).read_text(encoding='utf-8'))

    def write_json(self, name, value):
        self.write(name, json.dumps(value, indent=2) + '\n')

    def set_version(self, version):
        self.write('fxmanifest.lua', """fx_version 'cerulean'
game 'gta5'
version '%s'
files { 'config/beacon.json', 'stream/yx_movia_d_red_glow.ytyp', 'config/sirens/builtin.json' }
data_file 'DLC_ITYP_REQUEST' 'stream/yx_movia_d_red_glow.ytyp'
siren_pack 'config/sirens/builtin.json'
client_scripts { '@RageUI/RMenu.lua', 'client/menu.lua', 'client/config.js',
 'client/settings.js', 'client/beacon.js', 'client/main.js' }
server_script 'server/yuanx1a0_siren_control.net.dll'
""" % version)
        self.write_json('package-files.json', {'version': version, 'resource': BUILDER.RESOURCE, 'files': self.files})
        reviewed = sorted({p.relative_to(self.root).as_posix() for p in self.root.rglob('*')
                           if p.is_file() and '.git' not in p.relative_to(self.root).parts}
                          | {'release-files.json'})
        hashes = {p: hashlib.sha256((self.root / p).read_bytes()).hexdigest() for p in BUILDER.BINARY_FILES}
        self.write_json('release-files.json', {'version': version, 'files': reviewed, 'binary_sha256': hashes})

    def save_commit(self):
        self.git('add', '-A')
        self.git('commit', '-qm', 'Synthetic package fixture')
        return self.git('rev-parse', 'HEAD').decode('ascii').strip()

    def build(self, commit='HEAD', output=None):
        return BUILDER.build_package(self.root, commit, output or self.output)


class PackageTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='yx-package-tests-')
        self.addCleanup(temporary.cleanup)
        return Fixture(temporary.name)

    def assert_rejected(self, fixture, message, **kwargs):
        with self.assertRaisesRegex(BUILDER.PackageError, message):
            fixture.build(**kwargs)
        self.assertEqual(list(fixture.output.iterdir()), [])

    def test_install_zip_exact_contents_and_checksum(self):
        fixture = self.fixture()
        result = fixture.build()
        self.assertEqual(result['commit'], fixture.commit)
        self.assertEqual(result['version'], '3.9.1')
        self.assertEqual(result['archive'].name, 'yx_sirencontrol-v3.9.1.zip')
        self.assertEqual(result['checksums'].name, 'SHA256SUMS')
        with zipfile.ZipFile(result['archive']) as archive:
            self.assertEqual(archive.namelist(), ['yx_sirencontrol/' + p for p in sorted(fixture.files)])
            for info in archive.infolist():
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                name = info.filename[len('yx_sirencontrol/'):]
                self.assertEqual(archive.read(info), (fixture.root / name).read_bytes())
            self.assertFalse(any('/tools/' in p or '/tests/' in p or '/.git' in p for p in archive.namelist()))
            self.assertFalse(any(p.endswith(('release-files.json', 'package-files.json', 'beacon-preview.png')) for p in archive.namelist()))
            lua_files = [p for p in archive.namelist() if p.endswith('.lua')]
            self.assertEqual(lua_files, ['yx_sirencontrol/client/menu.lua', 'yx_sirencontrol/fxmanifest.lua'])
        expected = hashlib.sha256(result['archive'].read_bytes()).hexdigest() + '  ' + result['archive'].name + '\n'
        self.assertEqual(result['checksums'].read_text('ascii'), expected)

    def test_same_commit_is_reproducible(self):
        fixture = self.fixture()
        first = fixture.build()
        other = fixture.output.parent / 'second-output'
        other.mkdir()
        second = fixture.build(output=other)
        self.assertEqual(first['archive'].read_bytes(), second['archive'].read_bytes())
        self.assertEqual(first['checksums'].read_bytes(), second['checksums'].read_bytes())

    def test_historical_commit_uses_old_inventory_and_blobs(self):
        fixture = self.fixture()
        original = fixture.commit
        fixture.write('client/main.js', '// clean current revision TWO\n')
        fixture.set_version('3.9.2')
        fixture.save_commit()
        result = fixture.build(commit=original)
        self.assertEqual(result['version'], '3.9.1')
        with zipfile.ZipFile(result['archive']) as archive:
            self.assertEqual(archive.read('yx_sirencontrol/client/main.js'), b'// committed client revision one\n')
            self.assertIn(b"version '3.9.1'", archive.read('yx_sirencontrol/fxmanifest.lua'))

    def test_unstaged_change_rejected(self):
        fixture = self.fixture()
        fixture.write('client/main.js', '// not committed\n')
        self.assert_rejected(fixture, 'staged, unstaged and untracked')

    def test_staged_change_rejected(self):
        fixture = self.fixture()
        fixture.write('client/main.js', '// staged but not committed\n')
        fixture.git('add', '--', 'client/main.js')
        self.assert_rejected(fixture, 'staged, unstaged and untracked')

    def test_untracked_change_rejected(self):
        fixture = self.fixture()
        fixture.write('new-secret.txt', 'not reviewed\n')
        self.assert_rejected(fixture, 'staged, unstaged and untracked')

    def test_ignored_build_files_cannot_enter_archive(self):
        fixture = self.fixture()
        fixture.write('ignored-build/tone.awc', b'ADAT SYNTHETIC EXCLUDED DATA')
        result = fixture.build()
        with zipfile.ZipFile(result['archive']) as archive:
            self.assertFalse(any('ignored-build' in p or p.endswith('.awc') for p in archive.namelist()))

    def test_invalid_ref_is_rejected(self):
        fixture = self.fixture()
        self.assert_rejected(fixture, 'Git command failed', commit='definitely-no-such-commit')

    def test_inventory_duplicate_paths_rejected(self):
        fixture = self.fixture()
        inventory = fixture.load_json('package-files.json')
        inventory['files'].append('README.md')
        fixture.write_json('package-files.json', inventory)
        fixture.save_commit()
        self.assert_rejected(fixture, 'duplicate or case-conflicting')

    def test_inventory_case_collision_rejected(self):
        fixture = self.fixture()
        inventory = fixture.load_json('package-files.json')
        inventory['files'].append('readme.md')
        fixture.write_json('package-files.json', inventory)
        fixture.save_commit()
        self.assert_rejected(fixture, 'duplicate or case-conflicting')

    def test_unsafe_paths_rejected(self):
        for name in ['../escape.txt', '/absolute.txt', 'client\\main.js', 'client/../main.js', 'client//main.js']:
            with self.subTest(name=name):
                fixture = self.fixture()
                inventory = fixture.load_json('package-files.json')
                inventory['files'].append(name)
                fixture.write_json('package-files.json', inventory)
                fixture.save_commit()
                self.assert_rejected(fixture, 'Unsafe package path')

    def test_development_or_audio_paths_are_rejected(self):
        for name in ['tools/developer-only.py', 'docs/beacon-preview.png', '.gitignore',
                     'release-files.json', 'tests/never-ship.txt', 'audio/tone.awc', 'src/server/Server.cs']:
            with self.subTest(name=name):
                fixture = self.fixture()
                inventory = fixture.load_json('package-files.json')
                inventory['files'].append(name)
                fixture.write_json('package-files.json', inventory)
                fixture.save_commit()
                self.assert_rejected(fixture, 'cannot enter the package')

    def test_required_file_cannot_be_omitted(self):
        fixture = self.fixture()
        inventory = fixture.load_json('package-files.json')
        inventory['files'].remove('stream/yx_movia_d_red_glow.ytyp')
        fixture.write_json('package-files.json', inventory)
        fixture.save_commit()
        self.assert_rejected(fixture, 'Missing required installation files')

    def test_invalid_resource_and_version_rejected(self):
        for field, value, error in [('resource', 'yx_sirencontorl', 'resource must be exactly'),
                                    ('version', '../escape', 'safe semantic version')]:
            with self.subTest(field=field):
                fixture = self.fixture()
                inventory = fixture.load_json('package-files.json')
                inventory[field] = value
                fixture.write_json('package-files.json', inventory)
                fixture.save_commit()
                self.assert_rejected(fixture, error)

    def test_manifest_version_must_match(self):
        fixture = self.fixture()
        fixture.write('fxmanifest.lua', "version '9.9.9'\n")
        fixture.save_commit()
        self.assert_rejected(fixture, 'exactly the package version')

    def test_reviewed_version_must_match(self):
        fixture = self.fixture()
        reviewed = fixture.load_json('release-files.json')
        reviewed['version'] = '3.8.1'
        fixture.write_json('release-files.json', reviewed)
        fixture.save_commit()
        self.assert_rejected(fixture, 'reviewed source inventory')

    def test_reviewed_inventory_must_include_every_file(self):
        fixture = self.fixture()
        reviewed = fixture.load_json('release-files.json')
        reviewed['files'].remove('client/main.js')
        fixture.write_json('release-files.json', reviewed)
        fixture.save_commit()
        self.assert_rejected(fixture, 'absent from the reviewed')

    def test_binary_hash_must_match(self):
        fixture = self.fixture()
        fixture.write('stream/yx_movia_d_red.ydr', b'RSC7 changed fixture')
        fixture.save_commit()
        self.assert_rejected(fixture, 'differs from its reviewed hash')

    def test_renamed_audio_is_rejected(self):
        fixture = self.fixture()
        fixture.write('audio/README.md', b'ADAT OWN SYNTHETIC FIXTURE')
        fixture.save_commit()
        self.assert_rejected(fixture, 'Audio or archive signature')

    def test_binary_disguised_as_text_is_rejected(self):
        fixture = self.fixture()
        fixture.write('audio/README.md', b'text\x00binary')
        fixture.save_commit()
        self.assert_rejected(fixture, 'Unexpected binary data')

    def test_missing_committed_blob_rejected(self):
        fixture = self.fixture()
        (fixture.root / 'client/main.js').unlink()
        fixture.save_commit()
        self.assert_rejected(fixture, 'Missing committed file: client/main.js')

    def test_symlink_git_blob_rejected_without_os_symlink_privileges(self):
        fixture = self.fixture()
        oid = fixture.git('hash-object', '-w', '--stdin', input_bytes=b'../elsewhere').decode('ascii').strip()
        fixture.git('update-index', '--add', '--cacheinfo', '120000,' + oid + ',client/main.js')
        fixture.git('commit', '-qm', 'Commit synthetic symlink blob')
        fixture.git('update-index', '--skip-worktree', 'client/main.js')
        self.assertEqual(fixture.git('status', '--porcelain'), b'')
        self.assert_rejected(fixture, 'Only regular Git blobs')

    def test_manifest_local_reference_must_be_in_zip(self):
        fixture = self.fixture()
        path = fixture.root / 'fxmanifest.lua'
        fixture.write('fxmanifest.lua', path.read_text() + "client_script 'tools/developer-only.py'\n")
        fixture.save_commit()
        self.assert_rejected(fixture, 'Manifest references a file absent')

    def test_output_inside_repo_is_rejected(self):
        fixture = self.fixture()
        output = fixture.root / 'ignored-build'
        output.mkdir()
        self.assert_rejected(fixture, 'outside the source repository', output=output)
        self.assertEqual(list(output.iterdir()), [])

    def test_nonexistent_output_parent_is_rejected(self):
        fixture = self.fixture()
        self.assert_rejected(fixture, 'existing absolute directory', output=fixture.output / 'missing')

    def test_outputs_are_never_overwritten(self):
        fixture = self.fixture()
        first = fixture.build()
        original = first['archive'].read_bytes()
        sums = first['checksums'].read_bytes()
        with self.assertRaisesRegex(BUILDER.PackageError, 'already exists'):
            fixture.build()
        self.assertEqual(first['archive'].read_bytes(), original)
        self.assertEqual(first['checksums'].read_bytes(), sums)

    def test_existing_checksum_blocks_archive_creation(self):
        fixture = self.fixture()
        (fixture.output / 'SHA256SUMS').write_text('preserve me')
        with self.assertRaisesRegex(BUILDER.PackageError, 'already exists'):
            fixture.build()
        self.assertEqual([p.name for p in fixture.output.iterdir()], ['SHA256SUMS'])
        self.assertEqual((fixture.output / 'SHA256SUMS').read_text(), 'preserve me')


if __name__ == '__main__':
    unittest.main()
