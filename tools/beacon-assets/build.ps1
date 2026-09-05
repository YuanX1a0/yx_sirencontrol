param(
    [Parameter(Mandatory = $true)][string]$CodeWalkerDirectory,
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outputDirectory = Join-Path $taskRoot 'stream'
$sourceDirectory = Join-Path $PSScriptRoot 'build'
& $Python (Join-Path $PSScriptRoot 'generate.py')
if ($LASTEXITCODE -ne 0) { throw 'Geometry generation failed.' }
foreach ($assembly in @('SharpDX.dll', 'SharpDX.Mathematics.dll', 'CodeWalker.Core.dll')) {
    [System.Reflection.Assembly]::LoadFrom((Join-Path $CodeWalkerDirectory $assembly)) | Out-Null
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$typeFile = [CodeWalker.Core.GameFiles.FileTypes.YtypFile]::new()
$typeFile.NameHash = [CodeWalker.Core.GameFiles.Utils.JenkHash]::GenHash('yx_movia_d_red_glow')
$stats = Get-Content -Raw (Join-Path $sourceDirectory 'geometry.json') | ConvertFrom-Json
foreach ($stat in $stats) {
    $name = $stat.name
    $xml = Get-Content -Raw (Join-Path $sourceDirectory ($name + '.ydr.xml'))
    $ydr = [CodeWalker.Core.GameFiles.FileTypes.XmlYdr]::GetYdr($xml, $sourceDirectory)
    $bytes = $ydr.Save()
    [System.IO.File]::WriteAllBytes((Join-Path $outputDirectory ($name + '.ydr')), $bytes)
    $reload = [CodeWalker.Core.GameFiles.FileTypes.YdrFile]::new()
    $reload.Load($bytes)
    if (-not $reload.Drawable -or $reload.Drawable.AllModels.Length -ne 1) { throw "Invalid drawable $name" }
    $modelVertices = ($reload.Drawable.AllModels[0].Geometries | Measure-Object -Property VerticesCount -Sum).Sum
    if ($modelVertices -ne $stat.vertices) { throw "Vertex count mismatch for $name" }
    $width = [double]$stat.max[0] - [double]$stat.min[0]
    $height = [double]$stat.max[2] - [double]$stat.min[2]
    if ($name -eq 'yx_movia_d_red' -and ([Math]::Abs($width - 0.128) -gt 0.00001 -or [Math]::Abs($height - 0.142) -gt 0.00001)) {
        throw 'Beacon must remain 128 mm wide and 142 mm high.'
    }
    if ($name -eq 'yx_movia_d_red_glow') {
        # Check the actual serialized shader after reloading, not only source XML.
        [xml]$decoded = [CodeWalker.Core.GameFiles.FileTypes.YdrXml]::GetXml($reload)
        $shader = $decoded.Drawable.ShaderGroup.Shaders.Item
        $expectedShaderHash = 'hash_{0:X8}' -f [CodeWalker.Core.GameFiles.Utils.JenkHash]::GenHash('emissive.sps')
        if ($shader.FileName -notin @('emissive.sps', $expectedShaderHash)) { throw 'Glow shader must be emissive.sps.' }
        if ([int]$shader.RenderBucket.value -ne 0) { throw 'Glow must use the opaque emissive render bucket.' }
        $multiplier = $shader.SelectSingleNode('Parameters/Item[@name="emissiveMultiplier"]')
        if ([double]$multiplier.x -ne 35) { throw 'Glow emissive strength did not survive binary serialization.' }
        if ($width -ge 0.128 -or [double]$stat.max[2] -gt 0.142) { throw 'Glow must stay within the physical beacon silhouette.' }
        Write-Output 'Glow shader: emissive.sps, render bucket 0, multiplier 35; decoded binary verified.'
    }
    $archetype = $typeFile.AddArchetype()
    $def = $archetype._BaseArchetypeDef
    $def.name = [CodeWalker.Core.GameFiles.Utils.JenkHash]::GenHash($name)
    $def.assetName = $def.name
    $def.lodDist = 120
    $def.hdTextureDist = 120
    $def.flags = 32
    $def.bbMin = [SharpDX.Vector3]::new($stat.min[0], $stat.min[1], $stat.min[2])
    $def.bbMax = [SharpDX.Vector3]::new($stat.max[0], $stat.max[1], $stat.max[2])
    $def.bsCentre = [SharpDX.Vector3]::new($stat.center[0], $stat.center[1], $stat.center[2])
    $def.bsRadius = $stat.radius
    $archetype._BaseArchetypeDef = $def
    Write-Output "$name : $($bytes.Length) bytes, $modelVertices vertices; binary round trip passed."
}
$typeBytes = $typeFile.Save()
[System.IO.File]::WriteAllBytes((Join-Path $outputDirectory 'yx_movia_d_red_glow.ytyp'), $typeBytes)
$typeReload = [CodeWalker.Core.GameFiles.FileTypes.YtypFile]::new()
$typeReload.Load($typeBytes)
if ($typeReload.AllArchetypes.Length -ne 2) { throw 'YTYP must contain both beacon archetypes.' }
foreach ($archetype in $typeReload.AllArchetypes) {
    if ($archetype._BaseArchetypeDef.assetType.ToString() -ne 'ASSET_TYPE_DRAWABLE') { throw 'Invalid archetype asset type.' }
}
Write-Output "YTYP : $($typeBytes.Length) bytes, 2 archetypes; binary round trip passed."
