$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    . "$PSScriptRoot\prepare-windows-deps.ps1"
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript validation failed' }
    npx tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
} finally {
    Pop-Location
}
