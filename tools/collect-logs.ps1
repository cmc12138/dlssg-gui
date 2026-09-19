# DLSSG GUI 诊断信息收集（在出问题的那台机器上运行）
# 只读取和打包，不修改任何东西。产物：桌面上的 DLSSG-诊断-<时间>.zip
#
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里：
#   powershell -NoProfile -ExecutionPolicy Bypass -File collect-logs.ps1

param(
  [string]$OutDir = [Environment]::GetFolderPath('Desktop'),
  [string]$GameDir = ''
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $env:TEMP "dlssg-diag-$stamp"
$zip = Join-Path $OutDir "DLSSG-诊断-$stamp.zip"

New-Item -ItemType Directory -Force -Path $stage | Out-Null
function Section($name) { New-Item -ItemType Directory -Force -Path (Join-Path $stage $name) | Out-Null }

Write-Host "收集到：$stage" -ForegroundColor Cyan

# ── 1. 本工具的数据目录（记录 + 备份清单 + 设置）────────────────
Section '1-工具数据目录'
$dataDir = Join-Path $env:APPDATA 'dlssg-gui'
foreach ($f in 'games.json', 'packages.json', 'settings.json') {
  $src = Join-Path $dataDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $stage '1-工具数据目录') -Force }
}
if (Test-Path (Join-Path $dataDir 'logs')) {
  Copy-Item (Join-Path $dataDir 'logs') (Join-Path $stage '1-工具数据目录\logs') -Recurse -Force -ErrorAction SilentlyContinue
}
# 备份目录只记清单，不打包文件（可能很大）
if (Test-Path (Join-Path $dataDir 'backups')) {
  Get-ChildItem (Join-Path $dataDir 'backups') -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object FullName, Length, LastWriteTime |
    Export-Csv (Join-Path $stage '1-工具数据目录\backups-清单.csv') -NoTypeInformation -Encoding UTF8
}

# ── 2. 每个游戏条目的目录状态 + 游戏侧日志 ──────────────────────
Section '2-游戏目录'
$games = @()
$gamesJson = Join-Path $dataDir 'games.json'
if (Test-Path $gamesJson) {
  try { $games = (Get-Content $gamesJson -Raw -Encoding UTF8 | ConvertFrom-Json).games } catch { }
}
if ($GameDir) {
  $games = @([pscustomobject]@{ id = 'manual'; name = '手动指定'; exeDir = $GameDir })
}
if ($games.Count -eq 0) {
  Write-Host "  games.json 里没有条目，尝试从 Steam 库里找带 re_chunk_*.pak 的目录…" -ForegroundColor Yellow
  $roots = @()
  foreach ($drive in (Get-PSDrive -PSProvider FileSystem).Root) {
    $candidate = Join-Path $drive 'SteamLibrary\steamapps\common'
    if (Test-Path $candidate) { $roots += $candidate }
  }
  $roots += 'C:\Program Files (x86)\Steam\steamapps\common'
  foreach ($root in $roots) {
    Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      if (Get-ChildItem $_.FullName -Filter 're_chunk_*.pak' -ErrorAction SilentlyContinue) {
        $games += [pscustomobject]@{ id = 'steam'; name = $_.Name; exeDir = $_.FullName }
      }
    }
  }
}

foreach ($game in $games) {
  if (-not $game.exeDir -or -not (Test-Path $game.exeDir)) { continue }
  $safe = ($game.name -replace '[^\w\u4e00-\u9fa5-]', '_')
  $target = Join-Path $stage "2-游戏目录\$safe"
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Write-Host "  扫描 $($game.name) → $($game.exeDir)" -ForegroundColor DarkGray

  # 顶层文件清单（看有没有 dinput8.dll / version.dll / reframework 这些东西）
  Get-ChildItem $game.exeDir -Force -ErrorAction SilentlyContinue |
    Select-Object Name, Length, LastWriteTime, Mode |
    Export-Csv (Join-Path $target '目录清单.csv') -NoTypeInformation -Encoding UTF8

  # 我们/REFramework 装进去的文件，单独列一份并复制小文件
  foreach ($name in 'dinput8.dll', 'version.dll', 'winmm.dll', 'dbghelp.dll', 'dxgi.dll', 'd3d12.dll', 'dlssg_sm86.ini', 'reframework_revision.txt', 'reframework') {
    $p = Join-Path $game.exeDir $name
    if (Test-Path $p) {
      Add-Content -Path (Join-Path $target '可疑文件.txt') -Value "$name  $(if ((Get-Item $p).PSIsContainer) { '目录' } else { (Get-Item $p).Length })  $((Get-Item $p).LastWriteTime)" -Encoding UTF8
    }
  }

  # 游戏侧日志（代理的 loader/backend jsonl）
  $logDir = Join-Path $game.exeDir 'dlssg_sm86'
  if (Test-Path $logDir) {
    Copy-Item $logDir (Join-Path $target 'dlssg_sm86') -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ── 3. 卡普空自己的崩溃日志 ────────────────────────────────────
Section '3-卡普空崩溃日志'
$capcom = Join-Path $env:LOCALAPPDATA 'Capcom'
if (Test-Path $capcom) {
  Copy-Item $capcom (Join-Path $stage '3-卡普空崩溃日志\Capcom') -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Set-Content (Join-Path $stage '3-卡普空崩溃日志\没找到.txt') "%LOCALAPPDATA%\Capcom 不存在" -Encoding UTF8
}
# 崩溃转储 / WER 报告
foreach ($p in (Join-Path $env:LOCALAPPDATA 'CrashDumps'), (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER')) {
  if (Test-Path $p) {
    Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) } |
      Select-Object -First 40 FullName, Length, LastWriteTime |
      Export-Csv (Join-Path $stage '3-卡普空崩溃日志\崩溃文件清单.csv') -NoTypeInformation -Encoding UTF8
  }
}

# ── 4. 事件查看器里的崩溃记录（最有用的：出错模块名）────────────
Section '4-事件日志'
try {
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 200 -ErrorAction Stop |
    Where-Object { $_.Message -match 'PRAGMATA|Capcom|re_chunk|\.exe' -or $_.ProviderName -match 'Application Error|Application Hang|\.NET Runtime' } |
    Select-Object TimeCreated, Id, ProviderName, LevelDisplayName, Message |
    Format-List | Out-File (Join-Path $stage '4-事件日志\Application-近7天.txt') -Encoding UTF8
} catch {
  Set-Content (Join-Path $stage '4-事件日志\读取失败.txt') "$($_.Exception.Message)" -Encoding UTF8
}

# ── 5. 环境信息 ────────────────────────────────────────────────
Section '5-环境'
$env_info = @()
$env_info += "时间: $(Get-Date)"
$env_info += "系统: $((Get-CimInstance Win32_OperatingSystem).Caption) 版本 $((Get-CimInstance Win32_OperatingSystem).Version)"
$env_info += "显卡: " + ((Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join ' / ')
try { $env_info += "nvidia-smi: " + ((& nvidia-smi --query-gpu=name,driver_version --format=csv,noheader) -join ' / ') } catch { }
$env_info += "工具版本: " + ((Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'DLSSG' } | ForEach-Object { $_.Name }) -join ', ')
Set-Content (Join-Path $stage '5-环境\环境.txt') $env_info -Encoding UTF8

# ── 打包 ───────────────────────────────────────────────────────
try {
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "完成：$zip" -ForegroundColor Green
  Write-Host "把这个 zip 拿回来（或者只发里面的 4-事件日志 和 3-卡普空崩溃日志）" -ForegroundColor Green
} catch {
  Write-Host "打包失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "东西还在 $stage，可以手动压缩" -ForegroundColor Yellow
}
