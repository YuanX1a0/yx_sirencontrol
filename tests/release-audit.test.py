# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.
import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('release_audit', Path(__file__).resolve().parents[1] / 'tools/audit-release.py')
audit_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_module)


class ReleaseAuditTests(unittest.TestCase):
    def fixture(self, folder, extra=None):
        root = Path(folder)
        (root / 'main.js').write_text('// Own code\n', encoding='utf-8')
        names = ['main.js', 'release-files.json'] + (extra or [])
        (root / 'release-files.json').write_text(json.dumps({'files': names}), encoding='utf-8')
        return root

    def test_clean_inventory(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(audit_module.audit(self.fixture(folder)), [])

    def test_unreviewed_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            (root / 'unreviewed.txt').write_text('data')
            self.assertTrue(any('not in reviewed' in x for x in audit_module.audit(root)))

    def test_renamed_audio_and_archive(self):
        for magic in (b'ADAT', b'RIFF', b'PK\x03\x04'):
            with self.subTest(magic=magic), tempfile.TemporaryDirectory() as folder:
                root = self.fixture(folder)
                (root / 'main.js').write_bytes(magic + b'not code')
                self.assertTrue(any('signature' in x for x in audit_module.audit(root)))

    def test_token_scan_does_not_print_token(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            token = 'gh' + 'p_' + 'A' * 40
            (root / 'main.js').write_text(token)
            failures = audit_module.audit(root)
            self.assertTrue(any('credential' in x for x in failures))
            self.assertNotIn(token, '\n'.join(failures))

    def test_forbidden_directory_and_extension(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder, ['audio/tone.awc'])
            (root / 'audio').mkdir()
            (root / 'audio/tone.awc').write_text('not even real audio')
            failures = audit_module.audit(root)
            self.assertTrue(any('directory' in x for x in failures))
            self.assertTrue(any('extension' in x for x in failures))

    def test_inventory_cannot_escape_root(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertTrue(any('unsafe' in x for x in audit_module.audit(self.fixture(folder, ['../outside.txt']))))

    def test_csharp_source_and_projects_are_rejected_even_if_added_to_inventory(self):
        for name in ('SirenServer.cs', 'Main.CS', 'script.csx', 'server.csproj', 'server.sln',
                     'server.slnx', 'Directory.Build.props', 'build.targets', 'debug.suo', 'debug.user',
                     'src/renamed.txt', '.vs/local.txt', 'build.ps1'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                root = self.fixture(folder, [name])
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('// Local-only C# development file\n')
                self.assertTrue(any('C# source/build' in x for x in audit_module.audit(root)))

    def test_runtime_dll_and_js_lua_are_allowed_without_csharp_project(self):
        with tempfile.TemporaryDirectory() as folder:
            name = 'server/yuanx1a0_siren_control.net.dll'
            root = self.fixture(folder, [name, 'menu.lua'])
            (root / 'server').mkdir()
            raw = b'MZ' + bytes(64)
            (root / name).write_bytes(raw)
            (root / 'menu.lua').write_text('-- Runtime menu\n')
            path = root / 'release-files.json'
            inventory = json.loads(path.read_text())
            inventory['binary_sha256'] = {name: hashlib.sha256(raw).hexdigest()}
            path.write_text(json.dumps(inventory))
            self.assertEqual(audit_module.audit(root), [])

    def test_own_binary_requires_the_reviewed_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            name = 'stream/yx_movia_d_red.ydr'
            root = self.fixture(folder, [name])
            (root / 'stream').mkdir()
            raw = b'RSC7' + bytes(24)
            (root / name).write_bytes(raw)
            path = root / 'release-files.json'
            inventory = json.loads(path.read_text())
            inventory['binary_sha256'] = {name: hashlib.sha256(raw).hexdigest()}
            path.write_text(json.dumps(inventory))
            self.assertEqual(audit_module.audit(root), [])
            (root / name).write_bytes(raw + b'changed')
            self.assertTrue(any('reviewed hash' in x for x in audit_module.audit(root)))

    def test_audit_cannot_approve_different_staged_content(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.fixture(folder)
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'add', '--', 'main.js', 'release-files.json'], cwd=root, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.assertEqual(audit_module.audit(root), [])
            (root / 'main.js').write_text('// Different working copy\n')
            self.assertTrue(any('upload index' in x for x in audit_module.audit(root)))


if __name__ == '__main__':
    unittest.main()
