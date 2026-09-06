# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.
# Run with Windows PowerShell 5.1. All audio bytes are synthetic fixtures.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installerPath = Join-Path $repositoryDirectory 'audio/install.ps1'
$manifestTemplate = Join-Path $repositoryDirectory 'fxmanifest.lua'
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$fixtureName = 'yx-siren-audio-tests-' + [Guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path $temporaryParent $fixtureName
$junctions = New-Object 'System.Collections.Generic.List[string]'
$failures = New-Object 'System.Collections.Generic.List[string]'
$passed = 0
$caseNumber = 0
$requiredBanks = @('OISS_SSA_VEHAUD_LSSD_NEW', 'OISS_SSA_VEHAUD_LSFD_NEW', 'OISS_SSA_VEHAUD_BCFD_NEW')

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function New-Directory([string]$Path) {
    [void][IO.Directory]::CreateDirectory($Path)
    return [IO.Path]::GetFullPath($Path)
}
function New-Resource([string]$Parent, [string]$Name = 'yx_sirencontrol') {
    $resource = New-Directory (Join-Path $Parent $Name)
    $audio = New-Directory (Join-Path $resource 'audio')
    [IO.File]::Copy($installerPath, (Join-Path $audio 'install.ps1'), $false)
    [IO.File]::Copy($manifestTemplate, (Join-Path $resource 'fxmanifest.lua'), $false)
    return $resource
}
function New-Case {
    $script:caseNumber++
    $caseRoot = New-Directory (Join-Path $fixtureRoot ('case-' + $script:caseNumber))
    return [pscustomobject]@{ Root = $caseRoot; Source = New-Directory (Join-Path $caseRoot 'source'); Resource = New-Resource $caseRoot }
}
function Write-Awc([string]$Path, [string]$Signature = 'ADAT', [byte]$Marker = 1) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    $bytes = New-Object byte[] 32
    [Array]::Copy([Text.Encoding]::ASCII.GetBytes($Signature), 0, $bytes, 0, 4)
    $bytes[8] = $Marker
    [IO.File]::WriteAllBytes($Path, $bytes)
}
function Write-Rel([string]$Path, [string[]]$Names) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    $strings = New-Object IO.MemoryStream
    $offsets = New-Object 'System.Collections.Generic.List[uint32]'
    foreach ($name in $Names) {
        $offsets.Add([uint32]$strings.Position)
        $encoded = [Text.Encoding]::UTF8.GetBytes($name)
        $strings.Write($encoded, 0, $encoded.Length)
        $strings.WriteByte(0)
    }
    $stream = New-Object IO.MemoryStream
    $writer = New-Object IO.BinaryWriter($stream)
    try {
        $writer.Write([uint32]54)
        $writer.Write([uint32]4)
        $writer.Write([uint32]0)
        $writer.Write([uint32](4 + 4 * $Names.Count + $strings.Length))
        $writer.Write([uint32]$Names.Count)
        foreach ($offset in $offsets) { $writer.Write([uint32]$offset) }
        $writer.Write([byte[]]$strings.ToArray())
        $writer.Flush()
        [IO.File]::WriteAllBytes($Path, $stream.ToArray())
    }
    finally { $writer.Dispose(); $stream.Dispose(); $strings.Dispose() }
}
function New-LvcFixture([string]$Source, [string]$Layout = 'direct', [string[]]$Banks = $script:requiredBanks, [string[]]$ExtraNames = @()) {
    $audioRoot = if ($Layout -like 'audio-*') { Join-Path $Source 'audio' } else { $Source }
    $relative = if ($Layout -like '*sfx') { 'sfx/dlc_serversideaudio' } else { 'dlc_serversideaudio' }
    $bankDirectory = New-Directory (Join-Path $audioRoot $relative)
    $dataPath = Join-Path $audioRoot 'data/serversideaudio_sounds.dat54.rel'
    Write-Rel $dataPath (@($Banks | ForEach-Object { 'DLC_SERVERSIDEAUDIO\' + $_ }) + @($ExtraNames))
    $marker = 1
    foreach ($bank in $Banks) { Write-Awc (Join-Path $bankDirectory ($bank.ToLowerInvariant() + '.awc')) 'ADAT' ([byte]$marker); $marker++ }
    return [pscustomobject]@{ Banks = $bankDirectory; Data = $dataPath }
}
function Invoke-Installer([string]$Pack, [string]$Source, [string]$Resource, [switch]$WhatIf) {
    & (Join-Path $Resource 'audio/install.ps1') -Pack $Pack -SourceDirectory $Source -WhatIf:$WhatIf | Out-Null
}
function Read-Manifest([string]$Resource) { return [IO.File]::ReadAllText((Join-Path $Resource 'fxmanifest.lua')) }
function Assert-Rejected([string]$Pack, [string]$Source, [string]$Resource, [string]$Pattern = '') {
    $target = Join-Path $Resource ('audio/' + $Pack.ToLowerInvariant())
    $existed = Test-Path -LiteralPath $target
    $before = Read-Manifest $Resource
    $rejected = $false
    try { Invoke-Installer $Pack $Source $Resource }
    catch {
        $rejected = $true
        if ($Pattern) { Assert-True ($_.Exception.Message -match $Pattern) ('Unexpected rejection: ' + $_.Exception.Message) }
    }
    Assert-True $rejected 'Invalid installation was accepted.'
    Assert-True ((Read-Manifest $Resource) -ceq $before) 'Rejected installation changed the main manifest.'
    if (-not $existed) { Assert-True (-not (Test-Path -LiteralPath $target)) 'Validation failure created an audio target.' }
}
function Assert-SameBytes([string]$Source, [string]$Destination) {
    Assert-True (Test-Path -LiteralPath $Destination -PathType Leaf) "Missing output: $Destination"
    Assert-True ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ceq (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash) "Copied bytes changed: $Destination"
}
function Assert-Inventory([string]$Target, [int]$Count) {
    $json = [IO.File]::ReadAllText((Join-Path $Target 'installed-files.json'))
    Assert-True ($json.TrimStart().StartsWith('[')) 'The marker must be a JSON array even for one file.'
    $decoded = $json | ConvertFrom-Json
    $records = @($decoded)
    Assert-True ($records.Count -eq $Count) 'Wrong inventory count.'
    Assert-True ($json -notmatch '[A-Za-z]:[\\/]|yx-siren-audio-tests-') 'Inventory leaks machine paths.'
    $names = @()
    foreach ($record in $records) {
        Assert-True (@($record.PSObject.Properties).Count -eq 2) 'Inventory contains unexpected fields.'
        Assert-True (-not [IO.Path]::IsPathRooted($record.File) -and $record.File -notmatch '(^|[/\\])\.\.([/\\]|$)') 'Unsafe inventory path.'
        Assert-True ($record.SHA256 -match '^[A-Fa-f0-9]{64}$') 'Invalid SHA256.'
        Assert-True ((Get-FileHash -LiteralPath (Join-Path $Target $record.File) -Algorithm SHA256).Hash -ceq $record.SHA256) 'Inventory hash differs from copied bytes.'
        $names += $record.File
    }
    Assert-True (@($names | Select-Object -Unique).Count -eq $Count) 'Duplicate inventory entries.'
    Assert-True (@(Get-ChildItem -LiteralPath $Target -File -Recurse).Count -eq ($Count + 1)) 'Audio target contains undeclared files.'
}
function Get-Block([string]$Text, [string]$Pack) {
    $tag = [regex]::Escape($Pack.ToUpperInvariant())
    $match = [regex]::Match($Text, "(?ms)^-- BEGIN YX_AUDIO_$tag\r?`n.*?^-- END YX_AUDIO_$tag(?=\r?$)")
    Assert-True $match.Success "Missing managed block: $Pack"
    return $match.Value.Replace("`r`n", "`n")
}
function Assert-Manifest([string]$Resource, [string]$Pack, [string]$Before) {
    $after = Read-Manifest $Resource
    $block = Get-Block $after $Pack
    $prefix = 'audio/' + $Pack.ToLowerInvariant() + '/'
    $wave = if ($Pack -eq 'Modern') { 'sfx/resident' } else { 'sfx/dlc_serversideaudio' }
    $waveDeclaration = "data_file 'AUDIO_WAVEPACK' '$prefix$wave'"
    Assert-True ($block.Contains("'$($prefix)installed-files.json'")) 'The install marker is not available to clients.'
    Assert-True ($block.Contains("'$prefix$wave/*.awc'")) 'Incorrect internal wavepack files path.'
    Assert-True ($block.Contains($waveDeclaration)) 'Incorrect internal AUDIO_WAVEPACK path.'
    if ($Pack -eq 'Lvc') {
        $dataDeclaration = "data_file 'AUDIO_SOUNDDATA' '$($prefix)data/serversideaudio_sounds.dat'"
        Assert-True ($block.Contains($dataDeclaration)) 'LVC must register the virtual .dat path.'
        Assert-True ($block.Contains("'$($prefix)data/serversideaudio_sounds.dat54.rel'")) 'LVC must include the real DAT54 file.'
        Assert-True ($block.IndexOf($waveDeclaration) -lt $block.IndexOf($dataDeclaration)) 'Wavepack registration must precede sound data.'
    } else { Assert-True ($block -notmatch 'AUDIO_SOUNDDATA|\.dat54?\b') 'Modern unexpectedly registers a DAT.' }
    $oldBlock = Get-Block $Before $Pack
    $expected = $Before.Replace("`r`n", "`n").Replace($oldBlock, $block).TrimEnd("`n") + "`n"
    Assert-True ($after.Replace("`r`n", "`n") -ceq $expected) 'Content outside the target managed block changed.'
    Assert-True ($after -notmatch 'yx_siren_audio_|(?m)^\s*ensure\s') 'The manifest requires an external audio resource.'
    Assert-True (@(Get-ChildItem -LiteralPath $Resource -Filter 'fxmanifest.lua' -File -Recurse).Count -eq 1) 'A second resource manifest was created.'
}
function Test-Case([string]$Label, [scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Host "PASS $Label" }
    catch { $message = $Label + ': ' + $_.Exception.Message; $script:failures.Add($message); Write-Host "FAIL $message" }
}
function New-Junction([string]$Path, [string]$Target) {
    [void](New-Item -ItemType Junction -Path $Path -Target $Target)
    $script:junctions.Add([IO.Path]::GetFullPath($Path))
}

[void](New-Directory $fixtureRoot)
try {
    foreach ($relative in @('vehicles.awc', 'vehicles/vehicles.awc', 'sfx/resident/vehicles.awc')) {
        Test-Case "Modern installs $relative internally and copies only audio" {
            $case = New-Case
            $awc = Join-Path $case.Source $relative
            Write-Awc $awc
            foreach ($name in @('README.txt', 'client.lua', 'fxmanifest.lua', 'plugin.dll', 'install.ps1')) {
                [IO.File]::WriteAllText((Join-Path $case.Source $name), 'Do not copy or execute this fixture.')
            }
            $before = Read-Manifest $case.Resource
            $output = & (Join-Path $case.Resource 'audio/install.ps1') -Pack Modern -SourceDirectory $case.Source 6>&1
            Assert-True (($output | Out-String) -notmatch 'yx_siren_audio_|(?im)^\s*ensure\s+\w+') 'Output instructs users to start another audio resource.'
            $result = @($output | Where-Object { $_.PSObject.Properties.Name -contains 'ResourceName' })
            $target = Join-Path $case.Resource 'audio/modern'
            Assert-True ($result.Count -eq 1 -and $result[0].ResourceName -ceq 'yx_sirencontrol' -and $result[0].Destination -ceq $target) 'Wrong resource or destination in result.'
            Assert-SameBytes $awc (Join-Path $target 'sfx/resident/vehicles.awc')
            Assert-Manifest $case.Resource 'Modern' $before
            Assert-Inventory $target 1
            Assert-True (@(Get-ChildItem -LiteralPath $case.Root -Directory).Count -eq 2) 'A sibling resource was created.'
        }
    }
    Test-Case 'TADA, spaces and bracketed resource/source paths work literally' {
        $case = New-Case
        $source = New-Directory (Join-Path $case.Root 'source [download] pack')
        $resource = New-Resource (New-Directory (Join-Path $case.Root '[server] resources'))
        $awc = Join-Path $source 'vehicles.awc'
        Write-Awc $awc 'TADA'
        $before = Read-Manifest $resource
        Invoke-Installer 'Modern' $source $resource
        Assert-SameBytes $awc (Join-Path $resource 'audio/modern/sfx/resident/vehicles.awc')
        Assert-Manifest $resource 'Modern' $before
        Assert-Inventory (Join-Path $resource 'audio/modern') 1
    }
    foreach ($damage in @('ambiguous', 'signature', 'truncated')) {
        Test-Case "Modern rejects $damage input before writing" {
            $case = New-Case
            $awc = Join-Path $case.Source 'vehicles.awc'
            Write-Awc $awc
            switch ($damage) {
                'ambiguous' { Write-Awc (Join-Path $case.Source 'vehicles/vehicles.awc') }
                'signature' { Write-Awc $awc 'FAKE' }
                'truncated' { [IO.File]::WriteAllBytes($awc, [Text.Encoding]::ASCII.GetBytes('ADAT')) }
            }
            Assert-Rejected 'Modern' $case.Source $case.Resource
        }
    }
    foreach ($pack in @('Modern', 'Lvc')) {
        Test-Case "$pack refuses an existing internal target without changing it" {
            $case = New-Case
            if ($pack -eq 'Modern') { Write-Awc (Join-Path $case.Source 'vehicles.awc') } else { $fixture = New-LvcFixture $case.Source }
            $target = New-Directory (Join-Path $case.Resource ('audio/' + $pack.ToLowerInvariant()))
            $sentinel = Join-Path $target 'keep.txt'
            [IO.File]::WriteAllText($sentinel, 'untouched')
            Assert-Rejected $pack $case.Source $case.Resource 'already exists'
            Assert-True ([IO.File]::ReadAllText($sentinel) -ceq 'untouched') 'Existing content changed.'
            Assert-True (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 1) 'Existing target gained files.'
        }
        Test-Case "$pack WhatIf changes no files or directories" {
            $case = New-Case
            if ($pack -eq 'Modern') { Write-Awc (Join-Path $case.Source 'vehicles.awc') } else { $fixture = New-LvcFixture $case.Source }
            $before = Read-Manifest $case.Resource
            Invoke-Installer $pack $case.Source $case.Resource -WhatIf
            Assert-True ((Read-Manifest $case.Resource) -ceq $before) 'WhatIf changed the manifest.'
            Assert-True (@(Get-ChildItem -LiteralPath $case.Resource -File -Recurse).Count -eq 2) 'WhatIf created files.'
            Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $case.Resource 'audio') -Directory).Count -eq 0) 'WhatIf created directories.'
        }
    }
    Test-Case 'Modern WhatIf also works through powershell.exe -File' {
        $case = New-Case
        $awc = Join-Path $case.Source 'vehicles.awc'
        Write-Awc $awc
        $stream = [IO.File]::Open($awc, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.SetLength(16MB) } finally { $stream.Dispose() }
        $before = Read-Manifest $case.Resource
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $case.Resource 'audio/install.ps1') `
            -Pack Modern -SourceDirectory $($case.Source) -WhatIf 2>&1
        Assert-True ($LASTEXITCODE -eq 0) ('powershell.exe -File WhatIf failed: ' + ($output | Out-String))
        Assert-True ((Read-Manifest $case.Resource) -ceq $before) 'External-process WhatIf changed the manifest.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $case.Resource 'audio/modern'))) 'External-process WhatIf created its target.'
    }
    Test-Case 'Every copied hash is recorded after verified installation' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source
        $target = Join-Path $case.Resource 'audio/lvc'
        $before = Read-Manifest $case.Resource
        Invoke-Installer 'Lvc' $case.Source $case.Resource
        Assert-True (Test-Path -LiteralPath (Join-Path $target 'installed-files.json') -PathType Leaf) 'Successful install has no marker.'
        Assert-Manifest $case.Resource 'Lvc' $before
        Assert-Inventory $target 4
    }
    Test-Case 'Failure writing the main manifest cannot publish the final marker' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        $manifest = Join-Path $case.Resource 'fxmanifest.lua'
        $before = Read-Manifest $case.Resource
        [IO.File]::SetAttributes($manifest, [IO.FileAttributes]::ReadOnly)
        $rejected = $false
        try { Invoke-Installer 'Modern' $case.Source $case.Resource } catch { $rejected = $true }
        finally { [IO.File]::SetAttributes($manifest, [IO.FileAttributes]::Normal) }
        Assert-True $rejected 'An unwritable manifest was accepted.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $case.Resource 'audio/modern/installed-files.json'))) 'Marker appeared before manifest write succeeded.'
        Assert-True ((Read-Manifest $case.Resource) -ceq $before) 'Failed manifest write changed the original.'
    }
    foreach ($layout in @('direct', 'sfx', 'audio-direct', 'audio-sfx')) {
        Test-Case "LVC accepts $layout and preserves all original banks internally" {
            $case = New-Case
            $banks = @($requiredBanks) + @('OISS_SSA_VEHAUD_ADDITIONAL_NEW')
            $fixture = New-LvcFixture $case.Source $layout $banks
            $extra = Join-Path $fixture.Banks 'oiss_ssa_vehaud_extra_new.awc'
            Write-Awc $extra 'TADA' 9
            Write-Awc (Join-Path $fixture.Banks 'unrelated.awc')
            foreach ($name in @('README.txt', 'client.lua', 'fxmanifest.lua', 'plugin.dll', 'install.ps1')) {
                [IO.File]::WriteAllText((Join-Path $fixture.Banks $name), 'Do not copy or execute this fixture.')
            }
            $before = Read-Manifest $case.Resource
            Invoke-Installer 'Lvc' $case.Source $case.Resource
            $target = Join-Path $case.Resource 'audio/lvc'
            Assert-SameBytes $fixture.Data (Join-Path $target 'data/serversideaudio_sounds.dat54.rel')
            foreach ($bank in $banks) {
                $name = $bank.ToLowerInvariant() + '.awc'
                Assert-SameBytes (Join-Path $fixture.Banks $name) (Join-Path $target ('sfx/dlc_serversideaudio/' + $name))
            }
            Assert-SameBytes $extra (Join-Path $target 'sfx/dlc_serversideaudio/oiss_ssa_vehaud_extra_new.awc')
            Assert-Manifest $case.Resource 'Lvc' $before
            Assert-Inventory $target 6
        }
    }
    foreach ($order in @('Modern,Lvc', 'Lvc,Modern')) {
        Test-Case "Both packs coexist and preserve each other: $order" {
            $case = New-Case
            $lvcSource = New-Directory (Join-Path $case.Root 'lvc-source')
            Write-Awc (Join-Path $case.Source 'vehicles.awc')
            $fixture = New-LvcFixture $lvcSource
            foreach ($pack in $order.Split(',')) {
                $before = Read-Manifest $case.Resource
                $source = if ($pack -eq 'Modern') { $case.Source } else { $lvcSource }
                Invoke-Installer $pack $source $case.Resource
                Assert-Manifest $case.Resource $pack $before
            }
            Assert-Inventory (Join-Path $case.Resource 'audio/modern') 1
            Assert-Inventory (Join-Path $case.Resource 'audio/lvc') 4
            Assert-True (@(Get-ChildItem -LiteralPath $case.Resource -File -Recurse).Count -eq 9) 'Installing both packs produced unexpected files.'
        }
    }
    Test-Case 'LVC rejects a missing non-core DAT-referenced bank' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source 'direct' (@($requiredBanks) + @('OISS_SSA_VEHAUD_ADDITIONAL_NEW'))
        Remove-Item -LiteralPath (Join-Path $fixture.Banks 'oiss_ssa_vehaud_additional_new.awc')
        Assert-Rejected 'Lvc' $case.Source $case.Resource 'Missing original DAT54 bank'
    }
    Test-Case 'LVC rejects a DAT without every core bank' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source 'direct' @('OISS_SSA_VEHAUD_LSSD_NEW', 'OISS_SSA_VEHAUD_LSFD_NEW')
        Assert-Rejected 'Lvc' $case.Source $case.Resource 'missing the required profile bank'
    }
    foreach ($name in @('DLC_SERVERSIDEAUDIO\..\EVIL', 'DLC_OTHER\OISS_SSA_VEHAUD_LSSD_NEW', 'DLC_SERVERSIDEAUDIO\OISS_SSA_VEHAUD_NEW/../../EVIL')) {
        Test-Case "LVC rejects an unsafe or foreign bank: $name" {
            $case = New-Case
            $fixture = New-LvcFixture $case.Source 'direct' $requiredBanks @($name)
            Assert-Rejected 'Lvc' $case.Source $case.Resource 'Unsupported or unsafe'
        }
    }
    foreach ($bank in @('oiss_ssa_vehaud_lsfd_new.awc', 'oiss_ssa_vehaud_extra_new.awc')) {
        Test-Case "LVC rejects an invalid matching AWC: $bank" {
            $case = New-Case
            $fixture = New-LvcFixture $case.Source
            Write-Awc (Join-Path $fixture.Banks $bank) 'FAKE'
            Assert-Rejected 'Lvc' $case.Source $case.Resource 'signature'
        }
    }
    foreach ($damage in @('version', 'truncated-table', 'offset')) {
        Test-Case "LVC rejects malformed DAT54: $damage" {
            $case = New-Case
            $fixture = New-LvcFixture $case.Source
            $bytes = [IO.File]::ReadAllBytes($fixture.Data)
            switch ($damage) {
                'version' { $bytes[0] = 55 }
                'truncated-table' { $bytes = [byte[]]$bytes[0..($bytes.Length - 2)] }
                'offset' { [Array]::Copy([BitConverter]::GetBytes([uint32]4294967295), 0, $bytes, 20, 4) }
            }
            [IO.File]::WriteAllBytes($fixture.Data, $bytes)
            Assert-Rejected 'Lvc' $case.Source $case.Resource 'DAT54'
        }
    }
    Test-Case 'LVC rejects two complete source layouts' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source 'direct'
        $other = New-LvcFixture $case.Source 'audio-sfx'
        Assert-Rejected 'Lvc' $case.Source $case.Resource 'exactly one'
    }
    foreach ($name in @('renamed-controller', 'YX_sirencontrol')) {
        Test-Case "Resource name must match exactly: $name" {
            $case = New-Case
            Write-Awc (Join-Path $case.Source 'vehicles.awc')
            $resource = New-Resource (New-Directory (Join-Path $case.Root 'other-parent')) $name
            Assert-Rejected 'Modern' $case.Source $resource 'named exactly yx_sirencontrol'
        }
    }
    Test-Case 'Relative, bare-drive and root-relative sources are rejected' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        $bareDrive = [IO.Path]::GetPathRoot($case.Root).TrimEnd('\', '/')
        Assert-True ($bareDrive -match '^[A-Za-z]:$') 'This Windows fixture requires a drive-letter temp directory.'
        $rootRelative = $case.Source.Substring($bareDrive.Length)
        Push-Location -LiteralPath $case.Root
        try {
            Assert-True (Test-Path -LiteralPath $rootRelative -PathType Container) 'Root-relative source fixture is missing on the current drive.'
            foreach ($source in @('source', $bareDrive, $rootRelative)) { Assert-Rejected 'Modern' $source $case.Resource 'absolute' }
        }
        finally { Pop-Location }
    }
    Test-Case 'Sources equal to or inside the resource and its ancestor are rejected' {
        $case = New-Case
        $inside = New-Directory (Join-Path $case.Resource 'downloads')
        Write-Awc (Join-Path $inside 'vehicles.awc')
        foreach ($source in @($case.Resource, $inside, $case.Root)) { Assert-Rejected 'Modern' $source $case.Resource 'separate directories' }
    }
    Test-Case 'A source junction ancestor is rejected' {
        $case = New-Case
        $leaf = New-Directory (Join-Path $case.Source 'leaf')
        Write-Awc (Join-Path $leaf 'vehicles.awc')
        $link = Join-Path $case.Root 'source-link'
        New-Junction $link $case.Source
        Assert-Rejected 'Modern' (Join-Path $link 'leaf') $case.Resource 'junctions'
    }
    Test-Case 'An AWC beneath a source junction is rejected' {
        $case = New-Case
        $actual = New-Directory (Join-Path $case.Root 'actual-audio')
        Write-Awc (Join-Path $actual 'vehicles.awc')
        New-Junction (Join-Path $case.Source 'vehicles') $actual
        Assert-Rejected 'Modern' $case.Source $case.Resource 'junctions'
    }
    Test-Case 'A linked LVC bank directory is rejected' {
        $case = New-Case
        $actual = New-Directory (Join-Path $case.Root 'actual-lvc')
        $fixture = New-LvcFixture $actual
        [void](New-Directory (Join-Path $case.Source 'data'))
        [IO.File]::Copy($fixture.Data, (Join-Path $case.Source 'data/serversideaudio_sounds.dat54.rel'))
        New-Junction (Join-Path $case.Source 'dlc_serversideaudio') $fixture.Banks
        Assert-Rejected 'Lvc' $case.Source $case.Resource 'junctions'
    }
    Test-Case 'A junction in the destination resource parent is rejected' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        $parent = New-Directory (Join-Path $case.Root 'actual-resources')
        $resource = New-Resource $parent
        $link = Join-Path $case.Root 'linked-resources'
        New-Junction $link $parent
        Assert-Rejected 'Modern' $case.Source (Join-Path $link 'yx_sirencontrol') 'junctions'
    }
    foreach ($damage in @('missing', 'duplicate', 'reversed')) {
        Test-Case "Invalid managed block cannot publish a marker: $damage" {
            $case = New-Case
            Write-Awc (Join-Path $case.Source 'vehicles.awc')
            $manifest = Join-Path $case.Resource 'fxmanifest.lua'
            $before = Read-Manifest $case.Resource
            switch ($damage) {
                'missing' { $before = $before.Replace('-- BEGIN YX_AUDIO_MODERN', '-- missing begin') }
                'duplicate' { $before += "`n-- BEGIN YX_AUDIO_MODERN`n-- END YX_AUDIO_MODERN`n" }
                'reversed' { $before = $before.Replace('-- BEGIN YX_AUDIO_MODERN', '-- TEMP_MODERN').Replace('-- END YX_AUDIO_MODERN', '-- BEGIN YX_AUDIO_MODERN').Replace('-- TEMP_MODERN', '-- END YX_AUDIO_MODERN') }
            }
            [IO.File]::WriteAllText($manifest, $before)
            $rejected = $false
            try { Invoke-Installer 'Modern' $case.Source $case.Resource } catch { $rejected = $true }
            Assert-True $rejected 'An invalid managed block was accepted.'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $case.Resource 'audio/modern/installed-files.json'))) 'Invalid manifest published a marker.'
            Assert-True ((Read-Manifest $case.Resource) -ceq $before) 'Invalid manifest was changed.'
        }
    }
}
finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $safePrefix = $temporaryParent + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedFixture) -cne $fixtureName -or
        -not $fixtureName.StartsWith('yx-siren-audio-tests-', [StringComparison]::Ordinal)) {
        throw 'Refusing cleanup: fixture path escaped its expected temporary directory.'
    }
    # Remove junction entries before recursively removing this verified fixture root.
    for ($index = $junctions.Count - 1; $index -ge 0; $index--) {
        $junction = $junctions[$index]
        if (-not $junction.StartsWith($resolvedFixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup: junction escaped the fixture directory.' }
        if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
    }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
Write-Host ("Audio installer fixtures: {0} passed, {1} failed. PowerShell {2}." -f $passed, $failures.Count, $PSVersionTable.PSVersion)
if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }
