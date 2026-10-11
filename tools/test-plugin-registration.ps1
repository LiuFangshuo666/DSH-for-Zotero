# 受控实验：直接放 xpi 到底能否被 Zotero 重新登记？
#
# 背景：本项目反复出现"文件在磁盘上、extensions.json 里却没有记录 → 插件不加载"。
# 猜测过原因是"手工复制不可靠"，但一直没有做干净的对照实验。
#
# 关键前提（踩坑得出）：
#  1. **绝不强杀 Zotero** —— 强杀会留下 `.startup-incomplete` 并让插件数据库不一致，
#     下次启动就丢插件记录。必须 CloseMainWindow() 并耐心等它退干净。
#  2. `extensions.json` / `addonStartup.json.lz4` 只在启动流程的**后段**落盘，
#     启动早期去看它们会误判。必须用 `.startup-incomplete` 消失作为"启动完成"的判据。
#
# 用法：pwsh -File tools/test-plugin-registration.ps1

param(
    [string]$ZoteroExe = "C:\Program Files\Zotero\zotero.exe",
    [string]$ProfileDir = "$env:APPDATA\Zotero\Zotero\Profiles\4gvbpaje.default",
    [string]$LocalProfileDir = "$env:LOCALAPPDATA\Zotero\Zotero\Profiles\4gvbpaje.default",
    # ⚠️ 不能在这里用 `$PSScriptRoot`：param 默认值在**被调用那一刻**求值，
    # 那时它还是空的（PowerShell 进入脚本体后才赋值），于是路径被拼成
    # `..\.scaffold\...` —— 而 `deploy-to-zotero.ps1` 曾因此**静默地把 xpi
    # 部署成一个叫 `.xpi` 的文件还报成功**。默认值留空，到脚本体里再补。
    [string]$SourceXpi = "",
    [string]$StagingXpi = ""
)

$ErrorActionPreference = "Stop"

# 到这里 `$PSScriptRoot` 才可用（见 param 块里的说明）
if ([string]::IsNullOrWhiteSpace($SourceXpi)) {
    $SourceXpi = Join-Path $PSScriptRoot "..\.scaffold\build\dsh-for-zotero.xpi"
}

# ⚠️ addonID 从 package.json 读取，而不在这里再写一份字面量 ——
# 双份字面量在改 ID 时必然分叉，而分叉的后果是部署到错的文件名。
$packagePath = Join-Path $PSScriptRoot "..\package.json"
$addonId = (Get-Content $packagePath -Raw | ConvertFrom-Json).config.addonID
if ([string]::IsNullOrWhiteSpace($addonId)) {
    throw "package.json has no config.addonID; refusing to operate on a file named '.xpi'"
}
if ([string]::IsNullOrWhiteSpace($StagingXpi)) {
    $StagingXpi = Join-Path $env:APPDATA "Zotero\Zotero\plugin-staging\$addonId.xpi"
}
$extDir = Join-Path $ProfileDir "extensions"
$target = Join-Path $extDir "$addonId.xpi"
$flag = Join-Path $LocalProfileDir ".startup-incomplete"

function Get-Count { return @(Get-Process -Name zotero -ErrorAction SilentlyContinue).Count }

function Wait-StartupComplete([int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Path $flag)) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Wait-Exit([int]$TimeoutSeconds = 60) {
    Get-Process -Name zotero -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.CloseMainWindow() | Out-Null } catch { }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline -and (Get-Count) -gt 0) { Start-Sleep -Milliseconds 700 }
    if ((Get-Count) -gt 0) {
        Write-Warning "  did not exit within $TimeoutSeconds s; forcing"
        Get-Process -Name zotero -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        if (Test-Path $flag) { Remove-Item $flag -Force }
        return $false
    }
    return $true
}

function Show-Registration([string]$label) {
    $extJson = Join-Path $ProfileDir "extensions.json"
    $json = [System.IO.File]::ReadAllText($extJson, [System.Text.Encoding]::UTF8)
    $has = $json -match [regex]::Escape($addonId)
    $startupJson = Join-Path $ProfileDir "addonStartup.json.lz4"
    $hasStartup = $false
    if (Test-Path $startupJson) {
        $bytes = [System.IO.File]::ReadAllBytes($startupJson)
        $hasStartup = [System.Text.Encoding]::ASCII.GetString($bytes) -match [regex]::Escape($addonId)
    }
    Write-Host ("  [" + $label + "] extensions.json 有记录=" + $has + " ; addonStartup 有记录=" + $hasStartup)
    return $has
}

Write-Host "=== A. Quit Zotero cleanly ==="
if ((Get-Count) -gt 0) { [void](Wait-Exit) }
Write-Host ("  running: " + (Get-Count))
if (Test-Path $flag) { Remove-Item $flag -Force; Write-Host "  cleared stale .startup-incomplete" }

Write-Host "=== B. Remove the plugin file, then start once (clean baseline) ==="
if (Test-Path $target) {
    New-Item -ItemType Directory -Path (Split-Path $StagingXpi -Parent) -Force | Out-Null
    Move-Item $target $StagingXpi -Force
    Write-Host "  moved plugin xpi out"
}
Start-Process -FilePath $ZoteroExe -WorkingDirectory (Split-Path $ZoteroExe -Parent)
$ok = Wait-StartupComplete 90
Write-Host ("  startup complete: " + $ok)
[void](Show-Registration "baseline")

Write-Host "=== C. Quit cleanly, drop the xpi back in, start again ==="
[void](Wait-Exit)
Copy-Item $SourceXpi $target -Force
Write-Host ("  placed: " + $target + " (" + (Get-Item $target).Length + " bytes)")
Start-Process -FilePath $ZoteroExe -WorkingDirectory (Split-Path $ZoteroExe -Parent)
$ok2 = Wait-StartupComplete 90
Write-Host ("  startup complete: " + $ok2)
$registered = Show-Registration "after-drop"

Write-Host ""
if ($registered) {
    Write-Host "RESULT: dropping the xpi into extensions/ DOES get it registered."
} else {
    Write-Host "RESULT: dropping the xpi does NOT register it - Zotero's own installer is required."
    Write-Host "        Tools -> Add-ons -> gear -> Install Add-on From File... -> dsh-for-zotero.xpi"
}
