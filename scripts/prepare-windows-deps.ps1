$ErrorActionPreference = 'Stop'

# The crate verifies the archive's minisign signature before using it.
# Cache both files over HTTPS so builds do not depend on its HTTP downloader.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cacheDirectory = Join-Path $repositoryRoot 'src-tauri\target\dependency-cache\libsodium-1.0.22'
New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
foreach ($archiveName in @('libsodium-1.0.22-stable-msvc.zip', 'libsodium-1.0.22-stable-msvc.zip.minisig', 'LATEST.tar.gz', 'LATEST.tar.gz.minisig')) {
    $destination = Join-Path $cacheDirectory $archiveName
    if (-not (Test-Path -LiteralPath $destination)) {
        $partial = "$destination.part"
        Invoke-WebRequest -Uri "https://download.libsodium.org/libsodium/releases/$archiveName" -OutFile $partial -TimeoutSec 180
        Move-Item -LiteralPath $partial -Destination $destination -Force
    }
}
$env:SODIUM_DIST_DIR = $cacheDirectory
Write-Output "Verified-by-crate libsodium distribution cache: $cacheDirectory"

if ($env:GITHUB_ENV) {
    "SODIUM_DIST_DIR=$cacheDirectory" | Out-File -LiteralPath $env:GITHUB_ENV -Append -Encoding utf8
}
