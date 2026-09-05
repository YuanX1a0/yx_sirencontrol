# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.

<#
.SYNOPSIS
Creates an optional FiveM audio resource from files you downloaded yourself.
.DESCRIPTION
This script downloads nothing and contains no third-party recordings or audio
definitions. Original AWC and DAT files are copied byte-for-byte, never converted.
The destination parent must already exist and must be outside this repository.
An existing resource is never overwritten. Start the generated resource before
yx_sirencontrol; without it the controller continues to offer GTA native sounds.

Modern: download and extract Realistic American Sirens Pack / Modern Siren Pack
3.1.5.A from https://www.gta5-mods.com/misc/realistic-american-sirens-pack .
Point SourceDirectory at the extracted pack (vehicles/vehicles.awc), the vehicles
directory itself (vehicles.awc), or a prepared directory with sfx/resident/vehicles.awc.
The resident wavepack replaces GTA's native siren recordings globally; use only
one resident/vehicles.awc replacement at a time. No DAT file is needed.

Lvc: download the complete audio files from
https://github.com/fk-1997/Server-Sided-Sounds-and-Sirens and overlay the seven AWC
files you download from the Server Sided Mega Pack A (5+1) directory in
https://github.com/TrevorBarns/luxart-vehicle-control-extras .
The Mega Pack alone is incomplete: it supplies replacement banks, not the original
DAT or all other banks referenced by that DAT. SourceDirectory must contain
data/serversideaudio_sounds.dat54.rel and dlc_serversideaudio/*.awc (or
sfx/dlc_serversideaudio/*.awc). A resource root with that layout under audio/ is
also supported. The original DLC_SERVERSIDEAUDIO names are preserved. Every bank
referenced by the original DAT must exist, including banks unused by our menu.
Start the generated wrapper only, not the original audio resource alongside it:
both would register the same DLC_SERVERSIDEAUDIO namespace.

Keep the downloaded authors' notices and follow their terms. Their recordings
remain separate from the controller's license. This script copies only audio;
it never copies or runs scripts, DLLs, README files, or executables from the pack.
.PARAMETER Pack
Modern creates yx_siren_audio_modern. Lvc creates yx_siren_audio_lvc.
.PARAMETER SourceDirectory
Absolute path to one of the supported extracted layouts above. No archive input.
.PARAMETER OutputDirectory
Absolute path to an existing parent folder outside this repository and outside
SourceDirectory. Only the new, fixed-name child resource is created there.
.EXAMPLE
./tools/install-audio.ps1 -Pack Modern -SourceDirectory 'D:/Downloads/Modern Pack' -OutputDirectory 'D:/AudioResources'
.EXAMPLE
./tools/install-audio.ps1 -Pack Lvc -SourceDirectory 'D:/Downloads/Server-Sided-Sounds-and-Sirens/audio' -OutputDirectory 'D:/AudioResources' -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Modern', 'Lvc')][string]$Pack,
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
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
$outputParent = Get-AbsoluteDirectory $OutputDirectory 'OutputDirectory'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resourceName = if ($Pack -eq 'Modern') { 'yx_siren_audio_modern' } else { 'yx_siren_audio_lvc' }
$target = [IO.Path]::GetFullPath((Join-Path $outputParent $resourceName))
if ((Test-WithinDirectory $outputParent $repository) -or (Test-WithinDirectory $target $repository)) {
    throw 'OutputDirectory must be outside the controller repository.'
}
if (Test-WithinDirectory $outputParent $source) { throw 'OutputDirectory must be outside SourceDirectory.' }
if (Test-Path -LiteralPath $target) { throw "Target already exists; nothing was overwritten: $target" }

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
    $entry | Add-Member -NotePropertyName Hash -NotePropertyValue (Get-FileHash -LiteralPath $entry.Source -Algorithm SHA256).Hash
}

if (-not $PSCmdlet.ShouldProcess($target, "Create $resourceName from $($copyPlan.Count) verified local audio files")) { return }

# All validation happens before creation. Never use -Force or overwrite an old install.
# The manifest is written last so an incomplete copy is not a runnable resource.
New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
foreach ($entry in $copyPlan) {
    $destination = Join-Path $target $entry.Relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::Copy($entry.Source, $destination, $false)
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne $entry.Hash) {
        throw "Audio copy changed during installation. Incomplete resource has no manifest; inspect: $target"
    }
}

$manifestLines = @(
    '-- SPDX-License-Identifier: LicenseRef-Proprietary',
    '-- Copyright (c) 2026 YuanX1a0. Wrapper only; audio retains upstream rights.',
    "fx_version 'cerulean'", "game 'gta5'", "description 'Locally installed optional siren audio'",
    'files {', "    '$wavepack/*.awc',"
)
if ($Pack -eq 'Lvc') { $manifestLines += "    'data/serversideaudio_sounds.dat54.rel'," }
$manifestLines += @('}', "data_file 'AUDIO_WAVEPACK' '$wavepack'")
if ($Pack -eq 'Lvc') { $manifestLines += "data_file 'AUDIO_SOUNDDATA' 'data/serversideaudio_sounds.dat'" }
$utf8 = New-Object Text.UTF8Encoding($false)
$records = @($copyPlan | ForEach-Object { [ordered]@{ File = $_.Relative; SHA256 = $_.Hash } })
[IO.File]::WriteAllText((Join-Path $target 'installed-files.json'), (ConvertTo-Json -InputObject $records -Depth 3), $utf8)
[IO.File]::WriteAllText((Join-Path $target 'fxmanifest.lua'), ($manifestLines -join "`n") + "`n", $utf8)
Write-Host "Created $resourceName. Add 'ensure $resourceName' before 'ensure yx_sirencontrol' yourself."
[pscustomobject]@{ ResourceName = $resourceName; Destination = $target; FileCount = $copyPlan.Count }
