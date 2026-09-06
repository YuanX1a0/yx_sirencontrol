# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.
"""Build a clean install ZIP from committed Git blobs, never working-tree files.

Example, from a clean committed checkout:
    python tools/build-package.py --commit HEAD --output-directory D:/Packages/3.9.0

The existing output directory must be outside this repository. Each output must
be new. SHA256SUMS records the completed ZIP's hash. package-files.json controls
installation contents; release-files.json remains the reviewed source inventory.
Python 3.9+ and Git are required. No external Python packages or network access.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import zipfile


RESOURCE = 'yx_sirencontrol'
REQUIRED_FILES = frozenset({
    'LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.md', 'fxmanifest.lua',
    'audio/README.md', 'audio/install.ps1',
    'client/menu.lua', 'client/config.js', 'client/settings.js',
    'client/beacon.js', 'client/main.js',
    'server/yuanx1a0_siren_control.net.dll', 'server/beacon.lua',
    'config/beacon.json', 'config/sirens/builtin.json',
    'docs/audio-installation.md', 'docs/custom-sirens.md',
    'stream/yx_movia_d_red.ydr', 'stream/yx_movia_d_red_glow.ydr',
    'stream/yx_movia_d_red_glow.ytyp',
})
BINARY_FILES = frozenset({
    'server/yuanx1a0_siren_control.net.dll',
    'stream/yx_movia_d_red.ydr', 'stream/yx_movia_d_red_glow.ydr',
    'stream/yx_movia_d_red_glow.ytyp',
})
SIREN_PATH = re.compile(r'config/sirens/[a-z0-9_]+\.json\Z')
VERSION = re.compile(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\Z')
BLOCKED_MAGIC = (b'ADAT', b'TADA', b'RIFF', b'OggS', b'fLaC', b'ID3',
                 b'PK\x03\x04', b'Rar!', b'7z\xbc\xaf\x27\x1c')


class PackageError(Exception):
    """An unreviewed or incomplete release must not be packaged."""


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Do not echo blob contents, credentials or machine paths from Git errors.
        raise PackageError('Git command failed: ' + args[0])
    return result.stdout


def assert_clean(repo):
    if git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all'):
        raise PackageError('Commit or remove staged, unstaged and untracked changes before packaging.')


def assert_plain_path(path):
    """Reject symlinks/junctions before resolving filesystem output paths."""
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise PackageError('Symbolic links and junctions are not accepted for package output.')


def tree_blobs(repo, commit):
    entries = {}
    for record in git(repo, 'ls-tree', '-r', '-z', '--full-tree', commit).split(b'\0'):
        if not record:
            continue
        header, name = record.split(b'\t', 1)
        mode, kind, oid = header.decode('ascii').split()
        try:
            path = name.decode('utf-8')
        except UnicodeDecodeError as error:
            raise PackageError('Commit contains a filename which is not UTF-8.') from error
        entries[path] = (mode, kind, oid)
    return entries


def read_blob(repo, entries, path):
    if path not in entries:
        raise PackageError('Missing committed file: ' + path)
    mode, kind, oid = entries[path]
    if kind != 'blob' or mode not in {'100644', '100755'}:
        raise PackageError('Only regular Git blobs can be packaged: ' + path)
    return git(repo, 'cat-file', 'blob', oid)


def read_json(repo, entries, path):
    try:
        value = json.loads(read_blob(repo, entries, path).decode('utf-8-sig'))
    except (UnicodeDecodeError, ValueError) as error:
        raise PackageError('Invalid committed JSON: ' + path) from error
    if not isinstance(value, dict):
        raise PackageError('Expected an object in ' + path)
    return value


def check_inventory(inventory, reviewed):
    version = inventory.get('version')
    files = inventory.get('files')
    if inventory.get('resource') != RESOURCE:
        raise PackageError('Package resource must be exactly ' + RESOURCE + '.')
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise PackageError('Package version must be a safe semantic version.')
    if not isinstance(files, list) or not files or not all(isinstance(p, str) and p for p in files):
        raise PackageError('Package files must be a nonempty array of paths.')
    if len(files) != len({p.casefold() for p in files}):
        raise PackageError('Package inventory contains duplicate or case-conflicting paths.')
    for name in files:
        path = PurePosixPath(name)
        if path.is_absolute() or name != path.as_posix() or '..' in path.parts or '\\' in name or ':' in name:
            raise PackageError('Unsafe package path: ' + name)
        if name not in REQUIRED_FILES and not SIREN_PATH.fullmatch(name):
            raise PackageError('Development files and third-party audio cannot enter the package: ' + name)
    missing = REQUIRED_FILES - set(files)
    if missing:
        raise PackageError('Missing required installation files: ' + ', '.join(sorted(missing)))
    reviewed_files = reviewed.get('files')
    if reviewed.get('version') != version:
        raise PackageError('Package version differs from the reviewed source inventory.')
    if not isinstance(reviewed_files, list) or not all(isinstance(p, str) for p in reviewed_files):
        raise PackageError('Invalid reviewed source inventory.')
    if not set(files).issubset(set(reviewed_files)):
        raise PackageError('Package contains files absent from the reviewed source inventory.')
    hashes = reviewed.get('binary_sha256')
    if not isinstance(hashes, dict) or not all(isinstance(hashes.get(p), str) for p in BINARY_FILES):
        raise PackageError('Reviewed hashes are required for every runtime binary.')
    return version, sorted(files), hashes


def check_manifest(raw, version, files):
    # This resource uses literal manifest entries. Reject missing local references
    # before writing the ZIP; @RageUI entries intentionally remain external.
    text = raw.decode('utf-8-sig')
    text = re.sub(r'--\[\[.*?\]\]', '', text, flags=re.S)
    text = re.sub(r'--[^\r\n]*', '', text)
    versions = re.findall(r'\bversion\s+[\'"]([^\'"]+)[\'"]', text)
    if versions != [version]:
        raise PackageError('fxmanifest.lua must contain exactly the package version.')
    refs = re.findall(r'\b(?:client_script|server_script|shared_script|file|siren_pack)\s+[\'"]([^\'"]+)[\'"]', text)
    for block in re.findall(r'\b(?:client_scripts|server_scripts|shared_scripts|files)\s*\{(.*?)\}', text, flags=re.S):
        refs.extend(re.findall(r'[\'"]([^\'"]+)[\'"]', block))
    refs.extend(re.findall(r'\bdata_file\s+[\'"][^\'"]+[\'"]\s+[\'"]([^\'"]+)[\'"]', text))
    names = set(files)
    for path in refs:
        if path.startswith('@'):
            continue
        if path not in names:
            raise PackageError('Manifest references a file absent from the package: ' + path)


def build_package(repo, commit, output_directory):
    repo = Path(repo).resolve()
    if Path(git(repo, 'rev-parse', '--show-toplevel').decode('utf-8').strip()).resolve() != repo:
        raise PackageError('Repository argument must be the Git root.')
    assert_clean(repo)
    if not isinstance(commit, str) or not commit.strip():
        raise PackageError('An explicit Git commit or ref is required.')
    resolved = git(repo, 'rev-parse', '--verify', '--end-of-options', commit + '^{commit}').decode('ascii').strip()
    output = Path(output_directory)
    if not output.is_absolute() or not output.is_dir():
        raise PackageError('Output directory must be an existing absolute directory.')
    assert_plain_path(output)
    output = output.resolve()
    if output == repo or repo in output.parents:
        raise PackageError('Output directory must be outside the source repository.')
    entries = tree_blobs(repo, resolved)
    inventory = read_json(repo, entries, 'package-files.json')
    reviewed = read_json(repo, entries, 'release-files.json')
    version, files, hashes = check_inventory(inventory, reviewed)
    payloads = {}
    for path in files:
        raw = read_blob(repo, entries, path)
        if raw.startswith(BLOCKED_MAGIC):
            raise PackageError('Audio or archive signature is forbidden: ' + path)
        if path in BINARY_FILES:
            if hashlib.sha256(raw).hexdigest() != hashes[path]:
                raise PackageError('Runtime binary differs from its reviewed hash: ' + path)
            signature = b'MZ' if path.endswith('.dll') else b'RSC7'
            if not raw.startswith(signature):
                raise PackageError('Unexpected runtime binary signature: ' + path)
        else:
            try:
                text = raw.decode('utf-8-sig')
            except UnicodeDecodeError as error:
                raise PackageError('Installation text must be UTF-8: ' + path) from error
            if '\0' in text:
                raise PackageError('Unexpected binary data in installation text: ' + path)
        payloads[path] = raw
    check_manifest(payloads['fxmanifest.lua'], version, files)

    archive = output / (RESOURCE + '-v' + version + '.zip')
    checksums = output / 'SHA256SUMS'
    if os.path.lexists(archive) or os.path.lexists(checksums):
        raise PackageError('Package output already exists; use a new output directory.')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for path in files:
            info = zipfile.ZipInfo(RESOURCE + '/' + path, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(info, payloads[path], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    zip_bytes = buffer.getvalue()
    checksum = hashlib.sha256(zip_bytes).hexdigest() + '  ' + archive.name + '\n'
    # A concurrent edit cannot change captured commit blobs, but still violates
    # the clean-checkout rule. Recheck immediately before creating artifacts.
    assert_clean(repo)
    assert_plain_path(output)
    try:
        with archive.open('xb') as handle:
            handle.write(zip_bytes)
        with checksums.open('xb') as handle:
            handle.write(checksum.encode('ascii'))
    except OSError as error:
        raise PackageError('Could not create new package outputs; inspect the output directory before retrying.') from error
    return {'archive': archive, 'checksums': checksums, 'commit': resolved, 'version': version}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--commit', required=True, help='Committed Git revision, for example HEAD or a full SHA.')
    parser.add_argument('--output-directory', required=True, type=Path, help='Existing absolute directory outside the repository.')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1], help='Git root; defaults to this source checkout.')
    args = parser.parse_args()
    try:
        result = build_package(args.repo, args.commit, args.output_directory)
    except (PackageError, OSError) as error:
        parser.exit(1, 'Package build failed: ' + str(error) + '\n')
    print('Built ' + result['archive'].name + ' from commit ' + result['commit'])
    print('ZIP: ' + str(result['archive']))
    print('SHA256SUMS: ' + str(result['checksums']))


if __name__ == '__main__':
    main()
