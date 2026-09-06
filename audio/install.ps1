# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.

<#
.SYNOPSIS
Installs optional siren audio inside this yx_sirencontrol resource.
.DESCRIPTION
This script downloads nothing and contains no third-party recordings or audio
definitions. Original AWC and DAT files are copied byte-for-byte, never converted.
An existing install is never overwritten. The script updates the managed audio
block in this resource's fxmanifest.lua after copied files pass SHA-256 checks.
Restart yx_sirencontrol after installation; no additional audio resource is used.

Modern: this controller's labels were verified with the user's 3.1.5.A copy.
Author-page versions can differ. Obtain and extract a permitted copy from
https://www.gta5-mods.com/misc/realistic-american-sirens-pack or
https://www.lcpdfr.com/downloads/gta5mods/audio/14373-modern-siren-pack/ .
Point SourceDirectory at the extracted pack (vehicles/vehicles.awc), the vehicles
directory itself (vehicles.awc), or a prepared directory with sfx/resident/vehicles.awc.
The resident wavepack replaces GTA's native siren recordings globally; use only
one resident/vehicles.awc replacement at a time. No DAT file is needed.

Lvc: download the complete audio files from
https://github.com/fk-1997/Server-Sided-Sounds-and-Sirens and overlay the seven AWC
files you download from the Server Sided Mega Pack A (5+1) directory in
https://github.com/TrevorBarns/luxart-vehicle-control-extras . Extract its
dlc_serversideaudio.zip, then overlay the seven AWC files on the complete local
base copy. The Mega Pack alone is incomplete: it supplies replacement banks, not
the original DAT or all other banks referenced by that DAT. SourceDirectory must contain
data/serversideaudio_sounds.dat54.rel and dlc_serversideaudio/*.awc (or
sfx/dlc_serversideaudio/*.awc). A resource root with that layout under audio/ is
also supported. The original DLC_SERVERSIDEAUDIO names are preserved. Every bank
referenced by the original DAT must exist, including banks unused by our menu.
Do not start the original audio resource alongside yx_sirencontrol: both would
register the same DLC_SERVERSIDEAUDIO namespace.

Keep the downloaded authors' notices and follow their terms. Their recordings
remain separate from the controller's license. This script copies only audio;
it never copies or runs scripts, DLLs, README files, or executables from the pack.
.PARAMETER Pack
Modern installs under audio/modern. Lvc installs under audio/lvc.
.PARAMETER SourceDirectory
Absolute path to one of the supported extracted layouts above. No archive input.
.EXAMPLE
./audio/install.ps1 -Pack Modern -SourceDirectory 'D:/Downloads/Modern Pack'
.EXAMPLE
./audio/install.ps1 -Pack Lvc -SourceDirectory 'D:/Downloads/Server-Sided-Sounds-and-Sirens' -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Modern', 'Lvc')][string]$Pack,
    [Parameter(Mandatory = $true)][string]$SourceDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-AbsoluteDirectory([string]$Path, [string]$Label) {
    $fullyQualified = if ([IO.Path]::DirectorySeparatorChar -eq '\') {
        $Path -match '^[A-Za-z]:[\\/]' -or $Path -match '^\\\\[^\\/:?*]+\\[^\\/:?*]+(?:\\|$)'
    } else { $Path.StartsWith('/') }
    if ([string]::IsNullOrWhiteSpace($Path) -or -not $fullyQualified) {
        throw "$Label must be an absolute filesystem directory."
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $fullPath -Force
    if (-not $item.PSIsContainer -or $item.PSProvider.Name -ne 'FileSystem') {
        throw "$Label must be an existing filesystem directory."
    }
    Assert-NoReparsePoint $item.FullName
    return $item.FullName
}

function Assert-NoReparsePoint([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Symbolic links and junctions are not accepted: $($item.FullName)"
        }
        if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
    }
}

function Test-WithinDirectory([string]$Path, [string]$Directory) {
    $normalPath = [IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/')
    $normalDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/')
    $comparison = [StringComparison]::OrdinalIgnoreCase
    return $normalPath.Equals($normalDirectory, $comparison) -or
        $normalPath.StartsWith($normalDirectory + [IO.Path]::DirectorySeparatorChar, $comparison)
}

function Assert-Awc([string]$Path) {
    Assert-NoReparsePoint $Path
    $stream = [IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 16) { throw "Truncated AWC file: $Path" }
        $header = New-Object byte[] 4
        if ($stream.Read($header, 0, 4) -ne 4) { throw "Cannot read AWC file: $Path" }
        $magic = [Text.Encoding]::ASCII.GetString($header)
        if ($magic -ne 'ADAT' -and $magic -ne 'TADA') { throw "Invalid AWC signature: $Path" }
    } finally { $stream.Dispose() }
}

function Get-Sha256([string]$Path) {
    # Get-FileHash inherits a script-level -WhatIf in Windows PowerShell 5.1.
    # Use the framework implementation so a dry run still validates real files.
    Assert-NoReparsePoint $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-RelBankNames([string]$Path) {
    # Only read the DAT54 container-name table. No sound definitions are rewritten.
    Assert-NoReparsePoint $Path
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -lt 20 -or $length -gt 64MB) { throw 'Invalid DAT54 file size.' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ([BitConverter]::ToUInt32($bytes, 0) -ne 54) { throw 'Expected an unmodified DAT54 .rel file.' }
    $tablePosition = 8L + [BitConverter]::ToUInt32($bytes, 4)
    if ($tablePosition + 8 -gt $bytes.LongLength) { throw 'DAT54 data block is truncated.' }
    $tableLength = [long][BitConverter]::ToUInt32($bytes, [int]$tablePosition)
    $count = [long][BitConverter]::ToUInt32($bytes, [int]($tablePosition + 4))
    $stringsPosition = $tablePosition + 8 + 4 * $count
    $tableEnd = $tablePosition + 4 + $tableLength
    if ($count -lt 1 -or $count -gt 4096 -or $tableLength -lt 4 + 4 * $count -or
        $tableEnd -gt $bytes.LongLength -or $stringsPosition -ge $tableEnd) {
        throw 'DAT54 container-name table is invalid or truncated.'
    }
    $seen = @{}
    for ($index = 0; $index -lt $count; $index++) {
        $offset = [BitConverter]::ToUInt32($bytes, [int]($tablePosition + 8 + 4 * $index))
        $start = $stringsPosition + $offset
        if ($start -ge $tableEnd) { throw 'DAT54 container-name offset is out of bounds.' }
        $end = $start
        while ($end -lt $tableEnd -and $bytes[$end] -ne 0) { $end++ }
        if ($end -ge $tableEnd) { throw 'DAT54 container name has no terminator.' }
        $name = [Text.Encoding]::ASCII.GetString($bytes, [int]$start, [int]($end - $start))
        if ($name -notmatch '^DLC_SERVERSIDEAUDIO[\\/]([A-Za-z0-9_]+)$') {
            throw "Unsupported or unsafe DAT54 container name: $name"
        }
        $bank = $Matches[1].ToLowerInvariant()
        if (-not $seen.ContainsKey($bank)) { $seen[$bank] = $true; $bank }
    }
}

$source = Get-AbsoluteDirectory $SourceDirectory 'SourceDirectory'
$resource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Assert-NoReparsePoint $resource
if ([IO.Path]::GetFileName($resource.TrimEnd([char[]]'\/')) -cne 'yx_sirencontrol') {
    throw 'The resource directory must be named exactly yx_sirencontrol before installing audio.'
}
$manifest = Join-Path $resource 'fxmanifest.lua'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw 'Cannot find this resource''s fxmanifest.lua.' }
if ((Test-WithinDirectory $source $resource) -or (Test-WithinDirectory $resource $source)) {
    throw 'SourceDirectory and yx_sirencontrol must be separate directories.'
}
$packDirectory = $Pack.ToLowerInvariant()
$target = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $packDirectory))
if (-not (Test-WithinDirectory $target $PSScriptRoot)) { throw 'Resolved audio destination escaped the audio directory.' }
if (Test-Path -LiteralPath $target) { throw "Audio pack already exists; nothing was overwritten: $target" }

# Validate the exact managed block before copying anything. This keeps a damaged or
# hand-edited manifest from leaving behind a target directory that blocks a retry.
$begin = "-- BEGIN YX_AUDIO_$($Pack.ToUpperInvariant())"
$end = "-- END YX_AUDIO_$($Pack.ToUpperInvariant())"
$manifestLines = [IO.File]::ReadAllLines($manifest)
$beginIndexes = @(for ($index = 0; $index -lt $manifestLines.Length; $index++) { if ($manifestLines[$index] -ceq $begin) { $index } })
$endIndexes = @(for ($index = 0; $index -lt $manifestLines.Length; $index++) { if ($manifestLines[$index] -ceq $end) { $index } })
if ($beginIndexes.Count -ne 1 -or $endIndexes.Count -ne 1 -or $beginIndexes[0] -ge $endIndexes[0]) {
    throw "fxmanifest.lua has no unique managed block for $Pack audio."
}

$copyPlan = New-Object 'System.Collections.Generic.List[object]'
if ($Pack -eq 'Modern') {
    $candidates = @(
        'vehicles.awc', 'vehicles/vehicles.awc', 'sfx/resident/vehicles.awc'
    ) | ForEach-Object { Join-Path $source $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    if (@($candidates).Count -ne 1) {
        throw 'Expected exactly one vehicles.awc in a supported Modern layout. Select the precise extracted vehicles directory if more than one exists.'
    }
    $copyPlan.Add([pscustomobject]@{ Source = @($candidates)[0]; Relative = 'sfx/resident/vehicles.awc' })
    $wavepack = 'sfx/resident'
} else {
    $layouts = New-Object 'System.Collections.Generic.List[object]'
    foreach ($prefix in @('', 'audio')) {
        $audioRoot = if ($prefix) { Join-Path $source $prefix } else { $source }
        $relPath = Join-Path $audioRoot 'data/serversideaudio_sounds.dat54.rel'
        foreach ($bankRelative in @('dlc_serversideaudio', 'sfx/dlc_serversideaudio')) {
            $bankRoot = Join-Path $audioRoot $bankRelative
            if ((Test-Path -LiteralPath $relPath -PathType Leaf) -and (Test-Path -LiteralPath $bankRoot -PathType Container)) {
                $layouts.Add([pscustomobject]@{ Rel = $relPath; Banks = $bankRoot })
            }
        }
    }
    if ($layouts.Count -ne 1) { throw 'Expected exactly one complete Lvc audio layout: data/serversideaudio_sounds.dat54.rel and dlc_serversideaudio (or sfx/dlc_serversideaudio). The Mega Pack alone is incomplete.' }
    $layout = $layouts[0]
    Assert-NoReparsePoint $layout.Banks
    $requiredBanks = @(Get-RelBankNames $layout.Rel)
    foreach ($profileBank in @('oiss_ssa_vehaud_lssd_new', 'oiss_ssa_vehaud_lsfd_new', 'oiss_ssa_vehaud_bcfd_new')) {
        if ($requiredBanks -notcontains $profileBank) { throw "Original DAT54 is missing the required profile bank: $profileBank" }
    }
    $available = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $layout.Banks -File)) {
        if ($file.Name -match '(?i)^oiss_ssa_vehaud_[a-z0-9_]+\.awc$') {
            $key = $file.BaseName.ToLowerInvariant()
            if ($available.ContainsKey($key)) { throw "Duplicate AWC filename: $key" }
            $available[$key] = $file
        }
    }
    foreach ($bank in $requiredBanks) {
        if (-not $available.ContainsKey($bank)) { throw "Missing original DAT54 bank: $bank.awc. Start with the complete upstream audio package, then overlay the Mega Pack." }
    }
    foreach ($bank in @($available.Keys | Sort-Object)) {
        $copyPlan.Add([pscustomobject]@{ Source = $available[$bank].FullName; Relative = 'sfx/dlc_serversideaudio/' + $available[$bank].Name })
    }
    $copyPlan.Add([pscustomobject]@{ Source = $layout.Rel; Relative = 'data/serversideaudio_sounds.dat54.rel' })
    $wavepack = 'sfx/dlc_serversideaudio'
}

foreach ($entry in $copyPlan) {
    if ([IO.Path]::GetExtension($entry.Source) -ieq '.awc') { Assert-Awc $entry.Source }
    $entry | Add-Member -NotePropertyName Hash -NotePropertyValue (Get-Sha256 $entry.Source)
}

if (-not $PSCmdlet.ShouldProcess($target, "Install $Pack audio inside yx_sirencontrol from $($copyPlan.Count) verified files")) { return }

# All validation happens before creation. Never use -Force or overwrite an old install.
# The install marker is written last so an incomplete copy never enables a menu pack.
New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
foreach ($entry in $copyPlan) {
    $destination = Join-Path $target $entry.Relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::Copy($entry.Source, $destination, $false)
    if ((Get-Sha256 $destination) -cne $entry.Hash) {
        throw "Audio copy changed during installation. Incomplete resource has no manifest; inspect: $target"
    }
}

$utf8 = New-Object Text.UTF8Encoding($false)
$records = @($copyPlan | ForEach-Object { [ordered]@{ File = $_.Relative; SHA256 = $_.Hash } })
$prefix = "audio/$packDirectory/"
$managed = @($begin, 'files {', "    '$($prefix)installed-files.json',", "    '$prefix$wavepack/*.awc',")
if ($Pack -eq 'Lvc') { $managed += "    '$($prefix)data/serversideaudio_sounds.dat54.rel'," }
$managed += @('}', "data_file 'AUDIO_WAVEPACK' '$prefix$wavepack'")
if ($Pack -eq 'Lvc') { $managed += "data_file 'AUDIO_SOUNDDATA' '$($prefix)data/serversideaudio_sounds.dat'" }
$managed += $end
$updated = @()
if ($beginIndexes[0] -gt 0) { $updated += $manifestLines[0..($beginIndexes[0] - 1)] }
$updated += $managed
if ($endIndexes[0] + 1 -lt $manifestLines.Length) { $updated += $manifestLines[($endIndexes[0] + 1)..($manifestLines.Length - 1)] }
[IO.File]::WriteAllText($manifest, ($updated -join "`n") + "`n", $utf8)
[IO.File]::WriteAllText((Join-Path $target 'installed-files.json'), (ConvertTo-Json -InputObject $records -Depth 3) + "`n", $utf8)
Write-Host "Installed $Pack audio inside yx_sirencontrol. Restart yx_sirencontrol; do not ensure a separate audio resource."
[pscustomobject]@{ ResourceName = 'yx_sirencontrol'; Pack = $Pack; Destination = $target; FileCount = $copyPlan.Count }
