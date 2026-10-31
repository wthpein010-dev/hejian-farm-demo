[CmdletBinding()]
param([switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$source = Join-Path $repo 'unity'
$buildRoot = 'D:\farm-unity-build'
$project = Join-Path $buildRoot 'project'
$output = Join-Path $buildRoot 'output'
$logs = Join-Path $buildRoot 'logs'
$temp = Join-Path $buildRoot 'temp'
$gradle = Join-Path $buildRoot 'gradle'
$unityExe = 'D:\unity\2022.3.62f3c1\Editor\Unity.exe'
$android = 'D:\unity\2022.3.62f3c1\Editor\Data\PlaybackEngines\AndroidPlayer'
$packageId = 'com.hegeng.xiaoshe.demo'
$ownerFile = Join-Path $buildRoot '.hegeng-unity-build-owner.json'

function Assert-PlainPath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($resolved -ne $buildRoot -and -not $resolved.StartsWith($buildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Build target escaped the fixed D:\farm-unity-build boundary.'
    }
    $ancestor = $resolved
    while ($ancestor -and $ancestor -ne 'D:\') {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'A build target or parent is a link/reparse point; refusing to follow it.'
            }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
}

function Assert-NoLinks([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $links = @(Get-ChildItem -LiteralPath $Path -Recurse -Force | Where-Object {
            $_.Attributes -band [IO.FileAttributes]::ReparsePoint
        })
        if ($links.Count -ne 0) { throw 'A source/build subtree contains links; refusing to synchronize.' }
    }
}

if (-not (Test-Path -LiteralPath $unityExe -PathType Leaf)) { throw 'Expected Unity 2022.3.62f3c1 is missing.' }
foreach ($required in @('Assets', 'Packages', 'ProjectSettings')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Container)) {
        throw "Missing Unity source directory: $required"
    }
}
foreach ($relative in @('SDK\platforms\android-34\android.jar', 'SDK\build-tools\34.0.0\aapt2.exe',
        'NDK\source.properties', 'OpenJDK\bin\java.exe', 'Tools\gradle\lib\gradle-launcher-7.5.1.jar')) {
    if (-not (Test-Path -LiteralPath (Join-Path $android $relative) -PathType Leaf)) {
        throw "An expected embedded Android build component is missing: $relative"
    }
}
& node (Join-Path $PSScriptRoot 'sync-unity-theme.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Unity theme verification failed.' }
& python (Join-Path $PSScriptRoot 'prepare-unity.py') --check
if ($LASTEXITCODE -ne 0) { throw 'Unity photo/font verification failed.' }
Assert-PlainPath $buildRoot
Assert-NoLinks $source

if (Test-Path -LiteralPath $buildRoot) {
    if (-not (Test-Path -LiteralPath $ownerFile -PathType Leaf)) {
        throw 'D:\farm-unity-build already exists without this project ownership marker; nothing was overwritten.'
    }
    Assert-PlainPath $ownerFile
    $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    if ($owner.schema -ne 1 -or $owner.packageId -ne $packageId -or $owner.sourceRoot -ne $repo) {
        throw 'Build-directory ownership does not match this exact checkout; nothing was overwritten.'
    }
} else {
    New-Item -ItemType Directory -Path $buildRoot | Out-Null
    $owner = [ordered]@{ schema = 1; packageId = $packageId; sourceRoot = $repo; createdUtc = [DateTime]::UtcNow.ToString('o') }
    $jsonBytes = [Text.UTF8Encoding]::new($false).GetBytes(($owner | ConvertTo-Json) + "`n")
    $ownerStream = [IO.File]::Open($ownerFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $ownerStream.Write($jsonBytes, 0, $jsonBytes.Length); $ownerStream.Flush() } finally { $ownerStream.Dispose() }
}

$lockPath = Join-Path $buildRoot 'build.lock'
Assert-PlainPath $lockPath
$buildLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    foreach ($dir in @($project, $output, $logs, $temp, $gradle)) {
        Assert-PlainPath $dir
        Assert-NoLinks $dir
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    }
    $activeEditors = @(Get-CimInstance Win32_Process -Filter "name='Unity.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($activeEditors.Count -ne 0) { throw 'A Unity process already owns this build project; wait for it instead of overwriting.' }

    # Only these three source-owned directories are mirrored. Library remains on D:.
    # Both absolute targets and every existing descendant were checked for links.
    foreach ($dirName in @('Assets', 'Packages', 'ProjectSettings')) {
        $from = Join-Path $source $dirName
        $to = Join-Path $project $dirName
        Assert-PlainPath $to
        & robocopy $from $to /MIR /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /NFL /NDL /NP /NJH /NJS
        if ($LASTEXITCODE -ge 8) { throw "Source synchronization failed: $dirName" }
    }
    if ($PrepareOnly) {
        Write-Output "Unity sources synchronized into $project. Unity was not launched."
        exit 0
    }

    # ASCII source also works in Windows PowerShell 5.1 without relying on a BOM.
    $apkName = -join ([char[]]@(0x5408, 0x8015, 0x5c0f, 0x820d))
    $apkName += '-Unity' + (-join ([char[]]@(0x4f53, 0x9a8c, 0x7248))) + '.apk'
    $apk = Join-Path $output $apkName
    Assert-PlainPath $apk
    $logPath = Join-Path $logs ('build-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.log')
    Assert-PlainPath $logPath
    $started = [DateTime]::UtcNow
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $unityExe
    $start.WorkingDirectory = $project
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Arguments = '-batchmode -nographics -quit -buildTarget Android -projectPath "' + $project +
        '" -executeMethod FarmBuild.BuildAndroid -logFile "' + $logPath + '"'
    $start.EnvironmentVariables['TEMP'] = $temp
    $start.EnvironmentVariables['TMP'] = $temp
    $start.EnvironmentVariables['GRADLE_USER_HOME'] = $gradle
    $start.EnvironmentVariables['JAVA_HOME'] = Join-Path $android 'OpenJDK'
    $start.EnvironmentVariables['ANDROID_HOME'] = Join-Path $android 'SDK'
    $start.EnvironmentVariables['ANDROID_SDK_ROOT'] = Join-Path $android 'SDK'
    $start.EnvironmentVariables['HEGENG_UNITY_APK_OUTPUT'] = $apk
    $process = [Diagnostics.Process]::Start($start)
    Write-Output "Unity Android build started (PID $($process.Id)); log: $logPath"
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Unity exited with code $($process.ExitCode). Inspect $logPath" }
    if (-not (Test-Path -LiteralPath $apk -PathType Leaf) -or (Get-Item -LiteralPath $apk).Length -eq 0 -or
        (Get-Item -LiteralPath $apk).LastWriteTimeUtc -lt $started) {
        throw 'No fresh non-empty APK was produced; previous artifacts are not proof of this build.'
    }
    if (-not (Select-String -LiteralPath $logPath -SimpleMatch 'HEGENG_BUILD_SUCCEEDED package=com.hegeng.xiaoshe.demo version=0.1.1' -Quiet)) {
        throw 'Unity did not emit the required successful domain-check/build marker.'
    }
    $buildInfo = [ordered]@{
        schema = 1; packageId = $packageId; version = '0.1.1'; unity = '2022.3.62f3c1'
        architectures = @('arm64-v8a', 'armeabi-v7a'); signing = 'Unity local development key; not a production signing identity'
        apk = [IO.Path]::GetFileName($apk); bytes = (Get-Item -LiteralPath $apk).Length
        sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
        startedUtc = $started.ToString('o'); finishedUtc = [DateTime]::UtcNow.ToString('o')
    }
    $infoPath = Join-Path $output 'build-info.json'
    Assert-PlainPath $infoPath
    [IO.File]::WriteAllText($infoPath, ($buildInfo | ConvertTo-Json -Depth 4) + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Built $apk ($($buildInfo.bytes) bytes; SHA256 $($buildInfo.sha256))."
    Write-Output 'Verify the APK package, signature and ABI before installing. No VM or app was started.'
} finally {
    $buildLock.Dispose()
}
