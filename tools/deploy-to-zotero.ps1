# Deploy the built XPI into the local Zotero profile (development helper).
#
# WHY THIS SCRIPT EXISTS -- hard-won lesson:
# **Never leave backup copies inside the extensions directory.**
# Zotero/AddonManager derives a plugin's ID from its FILENAME, so
#   dsh-for-zotero@zotero.cn.xpi.bak-20261002-205547
# resolves to the same ID as the real file: dsh-for-zotero@zotero.cn.
# When one ID appears more than once in extensions/, Zotero uninstalls the plugin
# entirely on startup (deletes the xpi and drops the record from extensions.json),
# which shows up to the user as "the Tools menu has nothing in it".
#
# So this script does exactly one thing: guarantee there is a single copy of the
# main file, moving anything else OUT of extensions/.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\deploy-to-zotero.ps1
# NOTE: output is deliberately ASCII-only so it renders the same under
#       Windows PowerShell 5.1 (which reads BOM-less UTF-8 as ANSI).

param(
    [string]$ProfilePath = "$env:APPDATA\Zotero\Zotero\Profiles\4gvbpaje.default",
    # ⚠️ 这里**不能**用 `$PSScriptRoot` 做默认值！
    #
    # 真机故障：param 块的默认值在**被调用的那一刻**求值，而此时 `$PSScriptRoot`
    # 还是空的（它由 PowerShell 在进入脚本体后才赋值）。于是：
    #   - `$SourceXpi` 变成 `..\.scaffold\build\dsh-for-zotero.xpi`（坏路径），
    #     只因当时的工作目录恰好是仓库根，`Test-Path` 居然通过了 —— 掩盖了问题；
    #   - `$packagePath` 在同一次求值里被污染成空 → `$addonId` 为空
    #     → 脚本**静默地**把 xpi 部署成一个叫 `.xpi` 的文件，还打印 "deployed"。
    #
    # 所以：与脚本自身位置相关的默认值一律留空，改到**脚本体里**再补
    # （那里 `$PSScriptRoot` 已经有值）。这正是"失败却报成功"的典型成因。
    [string]$SourceXpi = "",
    [string]$BackupRoot = "$env:APPDATA\Zotero\Zotero\plugin-backups",
    # Staging area must live OUTSIDE extensions/ -- keeping anything that resolves to the
    # same addon id inside extensions/ is exactly what got the plugin uninstalled before.
    [string]$StagingRoot = "$env:APPDATA\Zotero\Zotero\plugin-staging"
)

$ErrorActionPreference = "Stop"

# 到这里 `$PSScriptRoot` 才可用（见 param 块里的说明）
if ([string]::IsNullOrWhiteSpace($SourceXpi)) {
    $SourceXpi = Join-Path $PSScriptRoot "..\.scaffold\build\dsh-for-zotero.xpi"
}

# ⚠️ addonID 从 package.json 读取，而不在这里再写一份字面量 ——
# 双份字面量在改 ID 时必然分叉，而分叉的后果是部署到错的文件名。
#
# 并**校验取到的不是空值**：空 ID 会让脚本把 xpi 部署成 `.xpi`（一个没有 ID 的
# 垃圾文件），却仍然打印 "deployed" 说成功了。这类"失败却报成功"的脚本比直接
# 报错危险得多，所以这里显式挡住。
$packagePath = Join-Path $PSScriptRoot "..\package.json"
if (-not (Test-Path $packagePath)) {
    throw "Cannot find package.json at $packagePath (needed to resolve the addon ID)"
}
$addonId = (Get-Content $packagePath -Raw | ConvertFrom-Json).config.addonID
if ([string]::IsNullOrWhiteSpace($addonId)) {
    throw "package.json has no config.addonID; refusing to deploy a file named '.xpi'"
}
$extDir = Join-Path $ProfilePath "extensions"
$target = Join-Path $extDir "$addonId.xpi"
$mainName = "$addonId.xpi"

if (-not (Test-Path $SourceXpi)) {
    throw "Build artifact not found: $SourceXpi (run 'npm run build' first)"
}
if (-not (Test-Path $extDir)) {
    throw "extensions directory not found: $extDir"
}

Write-Host "=== 1. Remove duplicate copies of the same addon ID ==="
Get-ChildItem $extDir -Force -File | Where-Object {
    $_.Name -like "$mainName*" -and $_.Name -ne $mainName
} | ForEach-Object {
    if (-not (Test-Path $BackupRoot)) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    }
    $dest = Join-Path $BackupRoot ("{0}.{1}" -f $_.Name, (Get-Date -Format "yyyyMMdd-HHmmss"))
    Move-Item $_.FullName $dest -Force
    Write-Host ("  moved out of extensions: " + $_.Name)
}

Write-Host "=== 2. Refuse to deploy while Zotero is running ==="
$running = @(Get-Process -Name zotero -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Warning ("Zotero is running (" + $running.Count + " process(es)). Fully quit Zotero first, otherwise the change may be reverted.")
}

Write-Host "=== 3. Install the single main file ==="
try {
    Copy-Item $SourceXpi $target -Force
    $size = (Get-Item $target).Length
    Write-Host ("  deployed: " + $target + " (" + $size + " bytes)")
} catch {
    # While Zotero runs it memory-maps the installed xpi, so the file cannot be replaced.
    # Stage the build outside extensions/; tools\finish-deploy.ps1 promotes it after Zotero exits.
    if (-not (Test-Path $StagingRoot)) {
        New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
    }
    $staged = Join-Path $StagingRoot "$addonId.xpi"
    Copy-Item $SourceXpi $staged -Force
    Write-Host ("  Zotero has the installed xpi memory-mapped, so it cannot be replaced right now.")
    Write-Host ("  staged instead: " + $staged + " (" + (Get-Item $staged).Length + " bytes)")
    Write-Host ""
    Write-Host "  NEXT: fully quit Zotero, then run:  powershell -ExecutionPolicy Bypass -File tools\finish-deploy.ps1"
    exit 0
}

Write-Host "=== 4. Verify ==="
$left = @(Get-ChildItem $extDir -Force -File | Select-Object -ExpandProperty Name)
Write-Host ("  extensions now contains: " + ($left -join " | "))
$mine = @($left | Where-Object { $_ -like "$mainName*" })
if ($mine.Count -ne 1) {
    throw ("extensions contains " + $mine.Count + " files matching " + $mainName + " -- Zotero may uninstall the plugin again")
}
Write-Host ("  backups live in: " + $BackupRoot)
Write-Host ""
Write-Host "Next: fully quit and restart Zotero, then open the Tools menu."
