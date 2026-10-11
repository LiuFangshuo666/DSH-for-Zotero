# 部署 + 重启 + 取证：一次跑完的辅助脚本
#
# ⚠️ 血泪教训（2026-10-02，反复踩了三次）：
# **绝对不要用 Stop-Process -Force 强杀 Zotero。**
# 强杀会让它来不及写完 `extensions.json`，并留下 `.startup-incomplete`；
# 下次启动时 Zotero 会因为这份不一致的插件数据库**丢掉插件记录**
# （文件还在磁盘上，但 extensions.json 里没有它，于是什么都不加载）。
#
# 正确做法：优先用 CloseMainWindow() 发关闭请求并**等它自己退干净**；
# 超时后才退化为强杀，并且强杀之后要清理 `.startup-incomplete`。
#
# 用法：pwsh -File tools/zotero-restart.ps1 [-WaitSeconds 40]

param(
    [int]$WaitSeconds = 40,
    [string]$ZoteroExe = "C:\Program Files\Zotero\zotero.exe",
    [string]$ProfileDir = "$env:APPDATA\Zotero\Zotero\Profiles\4gvbpaje.default",
    [string]$LocalProfileDir = "$env:LOCALAPPDATA\Zotero\Zotero\Profiles\4gvbpaje.default"
)

function Get-ZoteroCount {
    return @(Get-Process -Name zotero -ErrorAction SilentlyContinue).Count
}

Write-Host "=== 1. Graceful shutdown (no force kill unless necessary) ==="
$count = Get-ZoteroCount
if ($count -eq 0) {
    Write-Host "  Zotero is not running"
} else {
    Write-Host ("  asking $count process(es) to close their windows...")
    Get-Process -Name zotero -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.CloseMainWindow() | Out-Null } catch { }
    }
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline -and (Get-ZoteroCount) -gt 0) {
        Start-Sleep -Milliseconds 500
    }
    $left = Get-ZoteroCount
    if ($left -gt 0) {
        Write-Warning ("  still $left process(es) after $WaitSeconds s - forcing")
        Write-Warning "  NOTE: force-killing can leave the addon database inconsistent; if the plugin"
        Write-Warning "        then stops loading, reinstall it through Zotero's own Add-ons dialog."
        Get-Process -Name zotero -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    } else {
        Write-Host "  exited cleanly"
    }
}

# ⚠️ 刻意**不**碰 `.startup-incomplete`。
# 2026-10-02 实测更正：Zotero **正常退出后该文件依然存在**，因此它并非
# "启动是否完成"的标记（我一度这样认为，并在脚本里删过它）。
# 它的确切语义未经证实 —— 而擅自删除一个语义不明、由 Zotero 自己维护的文件，
# 正是本项目反复踩坑的模式。确需清理时请单独、显式地做，并说明理由。

Write-Host "=== 3. Plugin registration state BEFORE restart ==="
$extJson = Join-Path $ProfileDir "extensions.json"
if (Test-Path $extJson) {
    $json = [System.IO.File]::ReadAllText($extJson, [System.Text.Encoding]::UTF8)
    if ($json -match '"id":"dsh-for-zotero@local\.dev"') {
        Write-Host "  registered"
    } else {
        Write-Warning "  dsh-for-zotero is NOT in extensions.json - Zotero will not load it"
        Write-Host "  A clean re-registration needs Zotero's own installer:"
        Write-Host "    Tools -> Add-ons -> gear -> Install Add-on From File..."
    }
}

Write-Host "=== 4. Start Zotero ==="
Start-Process -FilePath $ZoteroExe -WorkingDirectory (Split-Path $ZoteroExe -Parent)
Start-Sleep -Seconds 12
Write-Host ("  running: " + (Get-ZoteroCount) + " process(es)")
