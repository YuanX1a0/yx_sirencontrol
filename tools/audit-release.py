# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.
"""Check the reviewed upload inventory without printing sensitive file contents."""
from pathlib import Path, PurePosixPath
import json
import hashlib
import re
import subprocess
import sys

BINARY_FILES = {
    'server/yuanx1a0_siren_control.net.dll',
    'stream/yx_movia_d_red.ydr',
    'stream/yx_movia_d_red_glow.ydr',
    'stream/yx_movia_d_red_glow.ytyp',
    'docs/beacon-preview.png',
}
BLOCKED_SUFFIXES = {'.awc', '.wav', '.mp3', '.ogg', '.flac', '.oac', '.rel', '.rpf',
                    '.ycd', '.ytd', '.zip', '.7z', '.rar', '.exe', '.pdb', '.pem', '.key', '.pfx'}
BLOCKED_PARTS = {'audio', 'vendor', 'third_party', 'rageui', 'reference', 'beacon-animation'}
CSHARP_SUFFIXES = {'.cs', '.csx', '.csproj', '.sln', '.slnx', '.props', '.targets', '.suo', '.user'}
MAGIC = (b'ADAT', b'TADA', b'RIFF', b'OggS', b'fLaC', b'ID3', b'PK\x03\x04', b'Rar!')
SENSITIVE = [
    re.compile(r'gh[pousr]_[A-Za-z0-9]{36,}'),
    re.compile(r'github_pat_[A-Za-z0-9_]{50,}'),
    re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(r'https?://[^\s/:]+:[^\s/@]+@'),
    re.compile(r'(?i)\b[A-Za-z]:[/\\](?:Users[/\\][^\s/\\]+|SCRIPS[/\\]|FXserver[/\\])'),
]


def audit(root):
    root = Path(root).resolve()
    issues = []
    manifest = root / 'release-files.json'
    try:
        inventory = json.loads(manifest.read_text(encoding='utf-8'))
        files = inventory['files']
        if not isinstance(files, list) or not files or not all(isinstance(p, str) for p in files):
            raise ValueError('expected nonempty files array')
    except (OSError, ValueError, KeyError, TypeError):
        return ['release-files.json: invalid upload inventory']
    if len(files) != len(set(p.casefold() for p in files)):
        issues.append('release-files.json: duplicate or case-conflicting paths')
    expected = set(files)
    if (root / '.git').is_dir():
        result = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                                cwd=root, capture_output=True, check=True)
        actual = set(result.stdout.decode('utf-8').strip('\0').split('\0')) - {''}
        unstaged = subprocess.check_output(['git', 'diff', '--name-only', '-z'], cwd=root)
        for name in unstaged.decode('utf-8').strip('\0').split('\0'):
            if name:
                issues.append(name + ': unstaged content differs from the upload index')
    else:
        # Pre-initialization checks also exclude recognized build-only folders.
        actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()
                  and not set(p.relative_to(root).parts) & {'bin', 'obj', '__pycache__', '.git', '.venv', 'node_modules'}}
    for path in sorted(actual - expected):
        issues.append(path + ': not in reviewed upload inventory')
    for name in files:
        rel = PurePosixPath(name)
        if rel.is_absolute() or '..' in rel.parts or '\\' in name or ':' in name:
            issues.append(name + ': unsafe inventory path'); continue
        path = root / name
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            issues.append(name + ': missing, linked, or outside repository'); continue
        if (path.suffix.lower() in CSHARP_SUFFIXES or name.casefold() == 'build.ps1'
                or set(part.casefold() for part in rel.parts) & {'src', '.vs', 'bin', 'obj'}):
            issues.append(name + ': C# source/build projects must stay local')
        if set(part.casefold() for part in rel.parts) & BLOCKED_PARTS:
            issues.append(name + ': third-party or downloaded-content directory')
        if path.suffix.lower() in BLOCKED_SUFFIXES or name.lower().endswith('.rel.xml'):
            issues.append(name + ': excluded asset/archive/credential extension')
        raw = path.read_bytes()
        if raw.startswith(MAGIC):
            issues.append(name + ': audio/archive signature, regardless of extension')
        if name not in BINARY_FILES:
            if path.suffix.lower() in {'.dll', '.ydr', '.ytyp', '.png', '.yft', '.ydd', '.xml'}:
                issues.append(name + ': unapproved binary or extracted-data file')
            try:
                text = raw.decode('utf-8-sig')
                if '\0' in text: issues.append(name + ': unexpected binary content')
            except UnicodeDecodeError:
                issues.append(name + ': expected UTF-8 text'); continue
        else:
            approved_hash = inventory.get('binary_sha256', {}).get(name)
            if approved_hash != hashlib.sha256(raw).hexdigest():
                issues.append(name + ': binary differs from reviewed hash')
            # Search ASCII and UTF-16 paths in our own compiled assets as well.
            text = raw.decode('latin-1') + '\n' + raw.decode('utf-16le', errors='ignore')
        normalized = text.replace('\\\\', '\\')
        if any(rule.search(normalized) for rule in SENSITIVE):
            issues.append(name + ': possible credential or personal machine path')
        if ('SPDX-License-Identifier: ' + 'GPL-3.0-only') in text:
            issues.append(name + ': old license header needs ownership review')
    return issues


if __name__ == '__main__':
    failures = audit(Path(__file__).resolve().parents[1])
    if failures:
        print('Upload audit FAILED:')
        print('\n'.join('- ' + item for item in failures))
        sys.exit(1)
    print('Upload audit passed: inventory, excluded content, signatures and secret/path scan.')
