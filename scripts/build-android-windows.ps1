param(
    [ValidateSet('aarch64', 'armv7', 'i686', 'x86_64')]
    [string]$Target = 'aarch64',
    [switch]$Release
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$androidRoot = Join-Path $projectRoot 'src-tauri\gen\android'
if (-not (Test-Path -LiteralPath $androidRoot)) {
    throw 'Android project is not initialized. Run npm run android:init first.'
}

$version = '5.2.0'
$expectedSha256 = 'B5378C1D9DB2573D61B304E89CF83DB187A05C3E4FF081D9B2EF3D0BB00CA314'
$downloadUrl = "https://repo1.maven.org/maven2/com/goterl/lazysodium-android/$version/lazysodium-android-$version.aar"
$buildRoot = Join-Path $env:TEMP 'nudge-android-build'
$cacheRoot = Join-Path $buildRoot "libsodium\$version"
$archivePath = Join-Path $cacheRoot "lazysodium-android-$version.aar"
$extractRoot = Join-Path $cacheRoot 'extracted'

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-Host "Downloading verified Android libsodium $version..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$archiveStream = [System.IO.File]::OpenRead($archivePath)
try {
    $actualSha256 = ([System.BitConverter]::ToString($sha256.ComputeHash($archiveStream))).Replace('-', '')
} finally {
    $archiveStream.Dispose()
    $sha256.Dispose()
}
if ($actualSha256 -ne $expectedSha256) {
    throw "lazysodium AAR checksum mismatch: $actualSha256"
}

New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
$abiMap = @{
    aarch64 = 'arm64-v8a'
    armv7 = 'armeabi-v7a'
    i686 = 'x86'
    x86_64 = 'x86_64'
}
$abi = $abiMap[$Target]
$cachedLibrary = Join-Path $extractRoot "jni\$abi\libsodium.so"
if (-not (Test-Path -LiteralPath $cachedLibrary)) {
    tar -xf $archivePath -C $extractRoot "jni/$abi/libsodium.so"
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to extract libsodium from the verified AAR.'
    }
}

$jniDirectory = Join-Path $androidRoot "app\src\main\jniLibs\$abi"
New-Item -ItemType Directory -Force -Path $jniDirectory | Out-Null
Copy-Item -LiteralPath $cachedLibrary -Destination (Join-Path $jniDirectory 'libsodium.so') -Force

# libsodium-sys-stable evaluates target_env on the Windows build-script host
# and asks the Android linker for `libsodium` (which maps to
# `liblibsodium.so`). The AAR's ELF SONAME is still the correct
# `libsodium.so`, so this build-only alias links successfully without changing
# the library name packaged in the APK.
$linkLibrary = Join-Path (Split-Path -Parent $cachedLibrary) 'liblibsodium.so'
Copy-Item -LiteralPath $cachedLibrary -Destination $linkLibrary -Force

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
}
$env:SODIUM_LIB_DIR = Split-Path -Parent $linkLibrary
$env:SODIUM_SHARED = '1'
# The Android NDK linker on Windows cannot reliably open response files and
# object files below a non-ASCII path. Keep Cargo output in an ASCII-only
# temporary directory while leaving the source repository in place.
$env:CARGO_TARGET_DIR = Join-Path $buildRoot 'cargo-target'
New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null

$arguments = @('tauri', 'android', 'build', '--apk', '--target', $Target, '--ci')
if (-not $Release) {
    $arguments += '--debug'
}

Write-Host "Building Nudge Android APK for $Target..."
& npx @arguments
$tauriExitCode = $LASTEXITCODE
if ($tauriExitCode -eq 0) {
    exit 0
}

# cargo-mobile2 creates a jniLibs symlink after Cargo succeeds. Windows blocks
# that operation unless Developer Mode or SeCreateSymbolicLinkPrivilege is
# enabled. When the Rust library exists, copy it and let Gradle finish the APK
# while skipping only the already-completed Rust task.
$tripleMap = @{
    aarch64 = 'aarch64-linux-android'
    armv7 = 'armv7-linux-androideabi'
    i686 = 'i686-linux-android'
    x86_64 = 'x86_64-linux-android'
}
$flavorMap = @{
    aarch64 = 'Arm64'
    armv7 = 'Arm'
    i686 = 'X86'
    x86_64 = 'X86_64'
}
$profile = if ($Release) { 'release' } else { 'debug' }
$profileName = if ($Release) { 'Release' } else { 'Debug' }
$rustLibrary = Join-Path $env:CARGO_TARGET_DIR "$($tripleMap[$Target])\$profile\libnudge_lib.so"
if (-not (Test-Path -LiteralPath $rustLibrary)) {
    exit $tauriExitCode
}

Write-Host 'Tauri finished the Rust build but Windows blocked its jniLibs symlink. Finishing with a copy-based Gradle build...'
Copy-Item -LiteralPath $rustLibrary -Destination (Join-Path $jniDirectory 'libnudge_lib.so') -Force
$assembleTask = "assemble$($flavorMap[$Target])$profileName"
$rustTask = "rustBuild$($flavorMap[$Target])$profileName"
Push-Location $androidRoot
try {
    & .\gradlew.bat $assembleTask '-x' $rustTask '--console=plain'
    $gradleExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $gradleExitCode
