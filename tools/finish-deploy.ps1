# Finish a staged plugin deployment. Run this AFTER fully quitting Zotero.
#
# WHY A TWO-PHASE DEPLOY: while Zotero is running it memory-maps the installed xpi,
# so the file cannot be replaced ("user-mapped section open"). Rather than fight that,
# deploy-to-zotero.ps1 stages the new build as "<id>.xpi.new"; this script performs the
# swap once Zotero has exited.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\finish-deploy.ps1
# ASCII-only output on purpose (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

param(
    [string]$ProfilePath = "$env:APPDATA\Zotero\Zotero\Profiles\4gvbpaje.default",
    [string]$BackupRoot = "$env:APPDATA\Zotero\Zotero\plugin-backups",
    [string]$StagingRoot = "$env:APPDATA\Zotero\Zotero\plugin-staging"
)

$ErrorActionPreference = "Stop"
# ⚠️ addonID 从 package.json 读取，而不在这里再写一份字面量 ——
# 双份字面量在改 ID 时必然分叉，而分叉的后果是部署到错的文件名。
$addonId = (Get-Content "$PSScriptRoot\..\package.json" -Raw | ConvertFrom-Json).config.addonID
$extDir = Join-Path $ProfilePath "extensions"
$staged = Join-Path $StagingRoot "$addonId.xpi"
$target = Join-Path $extDir "$addonId.xpi"

Write-Host "=== 1. Is Zotero fully quit? ==="
$running = @(Get-Process -Name zotero -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    throw ("Zotero is still running (" + $running.Count + " process(es)). Quit it completely, then run this script again.")
}
Write-Host "  yes"

Write-Host "=== 2. Is there a staged build? ==="
if (-not (Test-Path $staged)) {
    Write-Host "  no staged build found; nothing to do."
    Write-Host ("  (expected: " + $staged + ")")
    exit 0
}
$stagedSize = (Get-Item $staged).Length
Write-Host ("  yes: " + $stagedSize + " bytes")

Write-Host "=== 3. Move the currently installed copy aside ==="
if (Test-Path $target) {
    if (-not (Test-Path $BackupRoot)) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    }
    $old = Join-Path $BackupRoot ("{0}.{1}" -f (Split-Path $target -Leaf), (Get-Date -Format "yyyyMMdd-HHmmss"))
    Move-Item $target $old -Force
    Write-Host ("  old copy backed up to: " + $old)
} else {
    Write-Host "  no installed copy to move"
}

Write-Host "=== 4. Promote the staged build ==="
Move-Item $staged $target -Force
Write-Host ("  installed: " + $target + " (" + (Get-Item $target).Length + " bytes)")

Write-Host "=== 5. Verify exactly one copy of this addon id ==="
$mine = @(Get-ChildItem $extDir -Force -File | Where-Object { $_.Name -like "$addonId.xpi*" })
foreach ($f in $mine) { Write-Host ("  " + $f.Name + "  " + $f.Length + " bytes") }
if ($mine.Count -ne 1) {
    throw ("found " + $mine.Count + " files matching " + $addonId + ".xpi* -- Zotero may uninstall the plugin again")
}

Write-Host ""
Write-Host "Done. Now start Zotero and open the Tools menu."
