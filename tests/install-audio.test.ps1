# SPDX-License-Identifier: LicenseRef-Proprietary
# Copyright (c) 2026 YuanX1a0. All rights reserved.
# Run with PowerShell 5.1 or newer. All audio bytes below are synthetic fixtures.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installerPath = Join-Path $repositoryDirectory 'tools/install-audio.ps1'
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Installer not found: $installerPath"
}

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

function New-FixtureDirectory([string]$Path) {
    [void][IO.Directory]::CreateDirectory($Path)
    return [IO.Path]::GetFullPath($Path)
}

function New-Case {
    $script:caseNumber++
    $caseRoot = New-FixtureDirectory (Join-Path $fixtureRoot ('case-' + $script:caseNumber))
    return [pscustomobject]@{
        Root = $caseRoot
        Source = New-FixtureDirectory (Join-Path $caseRoot 'source')
        Output = New-FixtureDirectory (Join-Path $caseRoot 'output')
    }
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
    finally {
        $writer.Dispose()
        $stream.Dispose()
        $strings.Dispose()
    }
}

function New-LvcFixture(
    [string]$Source,
    [string]$Layout = 'direct',
    [string[]]$ReferencedBanks = $script:requiredBanks,
    [string[]]$ExtraNames = @()
) {
    $audioRoot = $Source
    if ($Layout -like 'audio-*') { $audioRoot = Join-Path $Source 'audio' }
    $bankRelative = 'dlc_serversideaudio'
    if ($Layout -like '*sfx') { $bankRelative = 'sfx/dlc_serversideaudio' }
    $bankDirectory = New-FixtureDirectory (Join-Path $audioRoot $bankRelative)
    $dataPath = Join-Path $audioRoot 'data/serversideaudio_sounds.dat54.rel'
    $names = @($ReferencedBanks | ForEach-Object { 'DLC_SERVERSIDEAUDIO\' + $_ }) + @($ExtraNames)
    Write-Rel $dataPath $names
    $marker = 1
    foreach ($bank in $ReferencedBanks) {
        Write-Awc (Join-Path $bankDirectory ($bank.ToLowerInvariant() + '.awc')) 'ADAT' ([byte]$marker)
        $marker++
    }
    return [pscustomobject]@{ Source = $Source; Banks = $bankDirectory; Data = $dataPath }
}

function Invoke-Installer([string]$Pack, [string]$Source, [string]$Output) {
    & $installerPath -Pack $Pack -SourceDirectory $Source -OutputDirectory $Output | Out-Null
}

function Assert-Rejected([string]$Pack, [string]$Source, [string]$Output, [string]$ErrorPattern = '') {
    $target = Join-Path $Output ('yx_siren_audio_' + $Pack.ToLowerInvariant())
    $existed = Test-Path -LiteralPath $target
    $rejected = $false
    try { Invoke-Installer $Pack $Source $Output }
    catch {
        $rejected = $true
        if ($ErrorPattern) {
            Assert-True ($_.Exception.Message -match $ErrorPattern) ('Unexpected rejection reason: ' + $_.Exception.Message)
        }
    }
    Assert-True $rejected 'Invalid installation was accepted.'
    if (-not $existed) {
        Assert-True (-not (Test-Path -LiteralPath $target)) 'Rejected installation created a target directory.'
    }
}

function Assert-SameBytes([string]$Source, [string]$Destination) {
    Assert-True (Test-Path -LiteralPath $Destination -PathType Leaf) "Missing output: $Destination"
    $expected = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
    Assert-True ($expected -ceq $actual) "Copied bytes changed: $Destination"
}

function Assert-Inventory([string]$Target, [int]$ExpectedCount) {
    $json = [IO.File]::ReadAllText((Join-Path $Target 'installed-files.json'))
    $decoded = $json | ConvertFrom-Json
    $records = @($decoded)
    Assert-True ($records.Count -eq $ExpectedCount) 'Inventory has the wrong file count.'
    Assert-True ($json -notmatch '[A-Za-z]:[\\/]|yx-siren-audio-tests-') 'Inventory leaks absolute source or output paths.'
    foreach ($record in $records) {
        Assert-True (@($record.PSObject.Properties).Count -eq 2) 'Inventory contains fields other than filename and hash.'
        Assert-True (-not [IO.Path]::IsPathRooted($record.File)) 'Inventory has an absolute filename.'
        Assert-True ($record.SHA256 -match '^[A-Fa-f0-9]{64}$') 'Inventory has an invalid SHA256.'
        $actual = (Get-FileHash -LiteralPath (Join-Path $Target $record.File) -Algorithm SHA256).Hash
        Assert-True ($actual -ceq $record.SHA256) 'Inventory hash does not match installed bytes.'
    }
}

function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:passed++
        Write-Host "PASS $Name"
    }
    catch {
        $message = $Name + ': ' + $_.Exception.Message
        $script:failures.Add($message)
        Write-Host "FAIL $message"
    }
}

function New-FixtureJunction([string]$Path, [string]$Target) {
    [void](New-Item -ItemType Junction -Path $Path -Target $Target)
    $script:junctions.Add([IO.Path]::GetFullPath($Path))
}

[void](New-FixtureDirectory $fixtureRoot)
try {
    foreach ($relative in @('vehicles.awc', 'vehicles/vehicles.awc', 'sfx/resident/vehicles.awc')) {
        Test-Case "Modern accepts $relative and copies only audio" {
            $case = New-Case
            $awc = Join-Path $case.Source $relative
            Write-Awc $awc
            [IO.File]::WriteAllText((Join-Path $case.Source 'README.txt'), 'Do not copy this fixture.')
            [IO.File]::WriteAllText((Join-Path $case.Source 'install.ps1'), 'throw "Do not execute this fixture."')
            Invoke-Installer 'Modern' $case.Source $case.Output
            $target = Join-Path $case.Output 'yx_siren_audio_modern'
            Assert-SameBytes $awc (Join-Path $target 'sfx/resident/vehicles.awc')
            $manifest = [IO.File]::ReadAllText((Join-Path $target 'fxmanifest.lua'))
            Assert-True ($manifest -match 'AUDIO_WAVEPACK') 'Modern manifest has no wavepack registration.'
            Assert-True ($manifest -match 'sfx/resident') 'Modern manifest uses the wrong bank path.'
            Assert-True ($manifest -notmatch 'AUDIO_SOUNDDATA|\.dat54?\b') 'Modern unexpectedly registers a DAT file.'
            $files = @(Get-ChildItem -LiteralPath $target -File -Recurse)
            Assert-True ($files.Count -eq 3) 'Modern copied unexpected source files.'
            Assert-Inventory $target 1
        }
    }

    Test-Case 'Modern accepts a TADA header' {
        $case = New-Case
        $awc = Join-Path $case.Source 'vehicles.awc'
        Write-Awc $awc 'TADA'
        Invoke-Installer 'Modern' $case.Source $case.Output
        Assert-SameBytes $awc (Join-Path $case.Output 'yx_siren_audio_modern/sfx/resident/vehicles.awc')
    }

    Test-Case 'Spaces and bracketed source/output folders are handled literally' {
        $case = New-Case
        $source = New-FixtureDirectory (Join-Path $case.Root 'source [download] pack')
        $output = New-FixtureDirectory (Join-Path $case.Root '[audio] resources')
        $awc = Join-Path $source 'vehicles.awc'
        Write-Awc $awc
        Invoke-Installer 'Modern' $source $output
        $target = Join-Path $output 'yx_siren_audio_modern'
        Assert-SameBytes $awc (Join-Path $target 'sfx/resident/vehicles.awc')
        Assert-Inventory $target 1
        Assert-True (Test-Path -LiteralPath (Join-Path $target 'fxmanifest.lua') -PathType Leaf) 'No manifest appeared at the exact bracketed path.'
    }

    Test-Case 'Modern rejects two candidate layouts without creating output' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        Write-Awc (Join-Path $case.Source 'vehicles/vehicles.awc')
        Assert-Rejected 'Modern' $case.Source $case.Output
    }

    Test-Case 'Modern rejects a wrong AWC signature' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc') 'FAKE'
        Assert-Rejected 'Modern' $case.Source $case.Output
    }

    Test-Case 'Modern rejects a truncated AWC' {
        $case = New-Case
        [IO.File]::WriteAllBytes((Join-Path $case.Source 'vehicles.awc'), [Text.Encoding]::ASCII.GetBytes('ADAT'))
        Assert-Rejected 'Modern' $case.Source $case.Output
    }

    Test-Case 'Modern refuses an existing output without overwriting it' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        $target = New-FixtureDirectory (Join-Path $case.Output 'yx_siren_audio_modern')
        $sentinel = Join-Path $target 'fxmanifest.lua'
        [IO.File]::WriteAllText($sentinel, 'untouched-existing-resource')
        $hash = (Get-FileHash -LiteralPath $sentinel).Hash
        Assert-Rejected 'Modern' $case.Source $case.Output
        Assert-True ((Get-FileHash -LiteralPath $sentinel).Hash -ceq $hash) 'Existing manifest was overwritten.'
        Assert-True (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 1) 'Existing output was modified.'
    }

    Test-Case 'A failed copy verification leaves no runnable manifest' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        # Simulate a destination hash mismatch after a successful filesystem copy.
        # This function lives only in this case's scope; other cases use the cmdlet.
        function Get-FileHash([string]$LiteralPath, [string]$Algorithm = 'SHA256') {
            if ($LiteralPath -match '[\\/]yx_siren_audio_modern[\\/]') {
                return [pscustomobject]@{ Hash = ('0' * 64) }
            }
            return Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
        }
        $rejected = $false
        try { Invoke-Installer 'Modern' $case.Source $case.Output }
        catch { $rejected = $true }
        $target = Join-Path $case.Output 'yx_siren_audio_modern'
        Assert-True $rejected 'A destination hash mismatch was accepted.'
        Assert-True (Test-Path -LiteralPath (Join-Path $target 'sfx/resident/vehicles.awc')) 'Fixture did not reach the post-copy verification step.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $target 'fxmanifest.lua'))) 'Failed verification left a runnable manifest.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $target 'installed-files.json'))) 'Failed verification published a completed inventory.'
    }

    foreach ($layout in @('direct', 'sfx', 'audio-direct', 'audio-sfx')) {
        Test-Case "LVC accepts $layout and preserves every required bank" {
            $case = New-Case
            $banks = @($requiredBanks) + @('OISS_SSA_VEHAUD_ADDITIONAL_NEW')
            $fixture = New-LvcFixture $case.Source $layout $banks
            $extra = Join-Path $fixture.Banks 'oiss_ssa_vehaud_extra_new.awc'
            Write-Awc $extra 'TADA' 9
            Write-Awc (Join-Path $fixture.Banks 'unrelated.awc')
            [IO.File]::WriteAllText((Join-Path $fixture.Banks 'README.txt'), 'Do not copy this fixture.')
            [IO.File]::WriteAllText((Join-Path $case.Source 'install.ps1'), 'throw "Do not execute this fixture."')
            Invoke-Installer 'Lvc' $case.Source $case.Output
            $target = Join-Path $case.Output 'yx_siren_audio_lvc'
            Assert-SameBytes $fixture.Data (Join-Path $target 'data/serversideaudio_sounds.dat54.rel')
            foreach ($bank in $banks) {
                $name = $bank.ToLowerInvariant() + '.awc'
                Assert-SameBytes (Join-Path $fixture.Banks $name) (Join-Path $target ('sfx/dlc_serversideaudio/' + $name))
            }
            Assert-SameBytes $extra (Join-Path $target 'sfx/dlc_serversideaudio/oiss_ssa_vehaud_extra_new.awc')
            $manifest = [IO.File]::ReadAllText((Join-Path $target 'fxmanifest.lua'))
            Assert-True ($manifest -match 'data_file\s*[''"]AUDIO_SOUNDDATA[''"]\s*[''"]data/serversideaudio_sounds\.dat[''"]') 'LVC manifest registers the wrong sound-data path.'
            Assert-True ($manifest -match 'sfx/dlc_serversideaudio') 'LVC manifest registers the wrong bank directory.'
            Assert-True ($manifest -match 'serversideaudio_sounds\.dat54\.rel') 'LVC manifest does not include its REL file.'
            Assert-True (@(Get-ChildItem -LiteralPath $target -File -Recurse).Count -eq 8) 'LVC omitted a matching bank or copied unrelated material.'
            Assert-Inventory $target 6
        }
    }

    Test-Case 'LVC rejects a missing DAT-referenced bank outside the three core banks' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source 'direct' (@($requiredBanks) + @('OISS_SSA_VEHAUD_ADDITIONAL_NEW'))
        Remove-Item -LiteralPath (Join-Path $fixture.Banks 'oiss_ssa_vehaud_additional_new.awc')
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    Test-Case 'LVC rejects a DAT without all three core banks' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source 'direct' @('OISS_SSA_VEHAUD_LSSD_NEW', 'OISS_SSA_VEHAUD_LSFD_NEW')
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    foreach ($unsafeName in @('DLC_SERVERSIDEAUDIO\..\EVIL', 'DLC_OTHER\OISS_SSA_VEHAUD_LSSD_NEW', 'DLC_SERVERSIDEAUDIO\OISS_SSA_VEHAUD_NEW/../../EVIL')) {
        Test-Case "LVC rejects unsafe or foreign bank name $unsafeName" {
            $case = New-Case
            $fixture = New-LvcFixture $case.Source 'direct' $requiredBanks @($unsafeName)
            Assert-Rejected 'Lvc' $case.Source $case.Output
        }
    }

    Test-Case 'LVC rejects an invalid referenced AWC before creating output' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source
        Write-Awc (Join-Path $fixture.Banks 'oiss_ssa_vehaud_lsfd_new.awc') 'FAKE'
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    Test-Case 'LVC rejects an invalid extra matching AWC before creating output' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source
        Write-Awc (Join-Path $fixture.Banks 'oiss_ssa_vehaud_extra_new.awc') 'FAKE'
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    Test-Case 'LVC rejects a wrong REL format version' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source
        $bytes = [IO.File]::ReadAllBytes($fixture.Data)
        $bytes[0] = 55
        [IO.File]::WriteAllBytes($fixture.Data, $bytes)
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    Test-Case 'LVC rejects a truncated REL name table' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source
        $bytes = [IO.File]::ReadAllBytes($fixture.Data)
        [IO.File]::WriteAllBytes($fixture.Data, [byte[]]$bytes[0..($bytes.Length - 2)])
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    Test-Case 'LVC rejects an out-of-range name offset' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source
        $bytes = [IO.File]::ReadAllBytes($fixture.Data)
        [Array]::Copy([BitConverter]::GetBytes([uint32]4294967295), 0, $bytes, 20, 4)
        [IO.File]::WriteAllBytes($fixture.Data, $bytes)
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    Test-Case 'LVC rejects two complete source layouts' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source 'direct'
        $other = New-LvcFixture $case.Source 'audio-sfx'
        Assert-Rejected 'Lvc' $case.Source $case.Output
    }

    Test-Case 'LVC refuses an existing output without modifying it' {
        $case = New-Case
        $fixture = New-LvcFixture $case.Source
        $target = New-FixtureDirectory (Join-Path $case.Output 'yx_siren_audio_lvc')
        $sentinel = Join-Path $target 'keep.txt'
        [IO.File]::WriteAllText($sentinel, 'untouched')
        Assert-Rejected 'Lvc' $case.Source $case.Output
        Assert-True ([IO.File]::ReadAllText($sentinel) -ceq 'untouched') 'Existing LVC output changed.'
        Assert-True (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 1) 'Existing LVC output gained files.'
    }

    Test-Case 'Relative source and output paths are rejected' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        Push-Location -LiteralPath $case.Root
        try {
            Assert-Rejected 'Modern' 'source' $case.Output
            Assert-Rejected 'Modern' $case.Source 'output'
        }
        finally { Pop-Location }
    }

    Test-Case 'A bare drive and existing root-relative paths are rejected as nonabsolute' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        $driveRoot = [IO.Path]::GetPathRoot($case.Root)
        $bareDrive = $driveRoot.TrimEnd('\', '/')
        Assert-True ($bareDrive -match '^[A-Za-z]:$') 'This Windows drive-path fixture requires a drive-letter temp directory.'
        $rootRelativeSource = $case.Source.Substring($bareDrive.Length)
        $rootRelativeOutput = $case.Output.Substring($bareDrive.Length)
        Push-Location -LiteralPath $case.Root
        try {
            Assert-True (Test-Path -LiteralPath $rootRelativeSource -PathType Container) 'Root-relative source fixture does not exist on the current drive.'
            Assert-True (Test-Path -LiteralPath $rootRelativeOutput -PathType Container) 'Root-relative output fixture does not exist on the current drive.'
            Assert-Rejected 'Modern' $bareDrive $case.Output 'absolute'
            Assert-Rejected 'Modern' $case.Source $bareDrive 'absolute'
            Assert-Rejected 'Modern' $rootRelativeSource $case.Output 'absolute'
            Assert-Rejected 'Modern' $case.Source $rootRelativeOutput 'absolute'
        }
        finally { Pop-Location }
    }

    Test-Case 'Output within the repository is rejected' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        Assert-Rejected 'Modern' $case.Source $PSScriptRoot
    }

    Test-Case 'Output inside SourceDirectory is rejected' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        $output = New-FixtureDirectory (Join-Path $case.Source 'output')
        Assert-Rejected 'Modern' $case.Source $output
    }

    Test-Case 'WhatIf validates Modern and LVC without creating resources' {
        foreach ($pack in @('Modern', 'Lvc')) {
            $case = New-Case
            if ($pack -eq 'Modern') { Write-Awc (Join-Path $case.Source 'vehicles.awc') }
            else { $fixture = New-LvcFixture $case.Source }
            & $installerPath -Pack $pack -SourceDirectory $case.Source -OutputDirectory $case.Output -WhatIf | Out-Null
            Assert-True (@(Get-ChildItem -LiteralPath $case.Output -Force).Count -eq 0) 'WhatIf created output files.'
        }
    }

    Test-Case 'A source junction ancestor is rejected' {
        $case = New-Case
        $sourceLeaf = New-FixtureDirectory (Join-Path $case.Source 'leaf')
        Write-Awc (Join-Path $sourceLeaf 'vehicles.awc')
        $junction = Join-Path $case.Root 'source-link'
        New-FixtureJunction $junction $case.Source
        Assert-Rejected 'Modern' (Join-Path $junction 'leaf') $case.Output
    }

    Test-Case 'An output junction ancestor is rejected' {
        $case = New-Case
        Write-Awc (Join-Path $case.Source 'vehicles.awc')
        $outputLeaf = New-FixtureDirectory (Join-Path $case.Output 'leaf')
        $junction = Join-Path $case.Root 'output-link'
        New-FixtureJunction $junction $case.Output
        Assert-Rejected 'Modern' $case.Source (Join-Path $junction 'leaf')
    }

    Test-Case 'An AWC file beneath a source junction is rejected' {
        $case = New-Case
        $actual = New-FixtureDirectory (Join-Path $case.Root 'actual-audio')
        Write-Awc (Join-Path $actual 'vehicles.awc')
        New-FixtureJunction (Join-Path $case.Source 'vehicles') $actual
        Assert-Rejected 'Modern' $case.Source $case.Output
    }
}
finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $safePrefix = $temporaryParent + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedFixture) -cne $fixtureName -or
        -not $fixtureName.StartsWith('yx-siren-audio-tests-', [StringComparison]::Ordinal)) {
        throw 'Refusing cleanup: fixture path did not resolve inside its expected temporary directory.'
    }
    # Delete junction entries themselves before recursively cleaning our unique fixture tree.
    for ($index = $junctions.Count - 1; $index -ge 0; $index--) {
        $junction = $junctions[$index]
        if (-not $junction.StartsWith($resolvedFixture + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing cleanup: junction path escaped the fixture directory.'
        }
        if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
    }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}

Write-Host ("Audio installer fixtures: {0} passed, {1} failed." -f $passed, $failures.Count)
if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }
