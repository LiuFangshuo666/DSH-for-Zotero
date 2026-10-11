# Remove a previously installed copy of this plugin from the Zotero profile.
#
# WHY THIS EXISTS
#
# Zotero derives a plugin's identity from the ID inside its manifest, and the install
# flow records that ID in extensions.json. When the ID changes -- which happened once
# here, from dsh-for-zotero@local.dev to dsh-for-zotero@zotero.cn -- the old install
# does not disappear: it stays registered, keeps loading its own (older) code, and both
# copies show up in Tools -> Plugins as separate entries.
#
# The new ID cannot be installed cleanly until the old record is gone, and Zotero has no
# way to uninstall an entry whose file has been replaced. So this script does the two
# things the install flow would otherwise own:
#
#   1. remove the old xpi from the profile's extensions/ directory
#   2. drop the old entry from extensions.json
#
# Both are needed. Removing only the file leaves a dangling record; removing only the
# record leaves a file that Zotero re-registers on the next start.
#
# THIS SCRIPT MUST RUN WHILE ZOTERO IS NOT RUNNING. Zotero rewrites extensions.json on
# exit, so an edit made while it is up will simply be overwritten.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\remove-old-addon.ps1
#   powershell -ExecutionPolicy Bypass -File tools\remove-old-addon.ps1 -OldId "x@y.z"
#
# NOTE: output is deliberately ASCII-only so it renders the same under Windows
#       PowerShell 5.1 (which reads BOM-less UTF-8 as ANSI).

param(
    [string]$ProfilePath = "$env:APPDATA\Zotero\Zotero\Profiles\4gvbpaje.default",
    [string]$BackupRoot = "$env:APPDATA\Zotero\Zotero\plugin-backups",
    # The ID this plugin used before it was renamed for release.
    [string]$OldId = "dsh-for-zotero@local.dev"
)

$ErrorActionPreference = "Stop"

# --- refuse to run while Zotero is up -------------------------------------------
$running = @(Get-Process -Name zotero -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    throw ("Zotero is running (" + $running.Count + " process(es)). " +
        "Fully quit it first -- Zotero rewrites extensions.json on exit and would undo this.")
}

$extDir = Join-Path $ProfilePath "extensions"
$extJson = Join-Path $ProfilePath "extensions.json"
$changed = $false

Write-Host ("=== Removing old addon id: " + $OldId + " ===")

# --- 1. the xpi file ------------------------------------------------------------
if (Test-Path $extDir) {
    # Match the exact name and its backups: Zotero keys an addon by file name, so
    # "name.xpi.bak-20260101" resolves to the SAME id and would count as a duplicate.
    $mine = @(Get-ChildItem $extDir -Force -File | Where-Object { $_.Name -like "$OldId.xpi*" })
    if ($mine.Count -eq 0) {
        Write-Host "  no file in extensions/ (already removed)"
    }
    else {
        if (-not (Test-Path $BackupRoot)) {
            New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
        }
        foreach ($f in $mine) {
            $dest = Join-Path $BackupRoot ("{0}.{1}" -f $f.Name, (Get-Date -Format "yyyyMMdd-HHmmss"))
            Move-Item $f.FullName $dest -Force
            Write-Host ("  moved to backups: " + $f.Name)
            $changed = $true
        }
    }
}
else {
    Write-Host ("  extensions directory not found: " + $extDir)
}

# --- 2. the extensions.json record ---------------------------------------------
if (Test-Path $extJson) {
    # Read as UTF-8 explicitly: the file is JSON and may contain non-ASCII in other
    # plugins' names. Get-Content would guess the encoding on Windows PowerShell.
    $raw = [System.IO.File]::ReadAllText($extJson, [System.Text.Encoding]::UTF8)
    $json = $raw | ConvertFrom-Json
    $before = @($json.addons).Count
    $kept = @($json.addons | Where-Object { $_.id -ne $OldId })
    $after = $kept.Count

    if ($after -eq $before) {
        Write-Host "  no record in extensions.json (already removed)"
    }
    else {
        Copy-Item $extJson ($extJson + ".bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")) -Force
        $json.addons = $kept
        # -Depth keeps nested objects intact; 100 is the cmdlet's maximum.
        $out = $json | ConvertTo-Json -Depth 100
        [System.IO.File]::WriteAllText($extJson, $out, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host ("  removed " + ($before - $after) + " record(s); " + $after + " left")
        $changed = $true
    }
}
else {
    Write-Host ("  extensions.json not found: " + $extJson)
}

Write-Host ""
if ($changed) {
    Write-Host "Done. Next: start Zotero, then install the new xpi via"
    Write-Host "  Tools -> Plugins -> gear icon -> Install Plugin From File..."
    Write-Host "Dropping the file into extensions/ does NOT register it -- only that flow does."
}
else {
    Write-Host "Nothing to do -- the old addon id was not present."
}
