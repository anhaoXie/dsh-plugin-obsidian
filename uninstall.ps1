# 从 DSH profile 卸载 dsh-plugin-obsidian。
#
# 安装改动了三处，这个脚本把它们还原：
#   1. <profile>\package.json —— dependencies 里的 link: 依赖
#   2. <profile>\package.json —— dsh.profile.bundles 里多出的一项
#   3. （可选）-RemoveNodeModules —— node_modules 与 pnpm-lock.yaml 一起清
#
# 安全约定与 install.ps1 相同：
#   - 改 profile 前先备份到 <ProfileDir>\.uninstall-backup\<时间戳>\
#   - 写 JSON 必须无 BOM；写后读回自校验；失败立刻回滚并退出非 0
#   - -WhatIf / -Check 只打印计划，不写任何文件
#   - 幂等：没装过也能安全地跑
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#   ... -ProfileDir <路径> [-RemoveNodeModules] [-WhatIf]
#
# 改完之后刷新页面（Ctrl+R），或重启 DeepSeek Harness 才会生效。

[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$DshHome = "$env:USERPROFILE\.dsh",
  [string]$PackageName = 'dsh-plugin-obsidian',
  [switch]$RemoveNodeModules,
  [switch]$WhatIf,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$dryRun = [bool]($WhatIf -or $Check)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Message) { Write-Host $Message }
function Test-Bom([byte[]]$Bytes) {
  return ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF)
}

if (-not $ProfileDir) { $ProfileDir = Join-Path $DshHome 'profiles\desktop' }
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)
$pkgFile = Join-Path $ProfileDir 'package.json'
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$linked = Join-Path $ProfileDir "node_modules\$PackageName"

Write-Step "目标 profile: $ProfileDir"
if ($dryRun) { Write-Step "[WhatIf] 只打印计划，不会写任何文件" }

if (-not (Test-Path -LiteralPath $pkgFile)) {
  throw "找不到 profile 的 package.json：$pkgFile"
}

# ---------- 1. 读取并计算新内容 ----------
$json = [System.IO.File]::ReadAllText($pkgFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($null -eq $json) { throw "profile 的 package.json 解析结果为空：$pkgFile" }

$removeDependency = $false
$oldDependency = $null
if ($json.dependencies -and $json.dependencies.PSObject.Properties[$PackageName]) {
  $removeDependency = $true
  $oldDependency = [string]$json.dependencies.PSObject.Properties[$PackageName].Value
}

$bundles = @()
$removeBundle = $false
if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.PSObject.Properties['bundles'] -and $json.dsh.profile.bundles) {
  $bundles = @($json.dsh.profile.bundles)
  $removeBundle = (@($bundles | Where-Object { $_ -eq $PackageName }).Count -gt 0)
}

$nodeModulesExists = Test-Path -LiteralPath $linked
$lockExists = Test-Path -LiteralPath (Join-Path $ProfileDir 'pnpm-lock.yaml')
$changed = ($removeDependency -or $removeBundle)

if (-not $changed) {
  Write-Step "未安装：package.json 里没有 $PackageName 的依赖或 bundle 项（幂等，无需修改）。"
  if ($RemoveNodeModules -and $dryRun) { Write-Step "[WhatIf] 仍会清理 node_modules / pnpm-lock.yaml（如存在）" }
}

if ($dryRun) {
  Write-Step ""
  if ($removeDependency) { Write-Step "[WhatIf] 将移除 dependencies.$PackageName（当前 $oldDependency）" }
  if ($removeBundle) { Write-Step "[WhatIf] 将从 dsh.profile.bundles 移除 $PackageName" }
  if ($changed) {
    $remaining = @($bundles | Where-Object { $_ -ne $PackageName })
    Write-Step "[WhatIf] dsh.profile.bundles 将变为：[$($remaining -join ', ')]"
    Write-Step "[WhatIf] 备份到：$(Join-Path $ProfileDir '.uninstall-backup\<时间戳>')"
  }
  if ($RemoveNodeModules) {
    Write-Step "[WhatIf] 将删除 node_modules（存在=$nodeModulesExists）与 pnpm-lock.yaml（存在=$lockExists）"
  }
  Write-Step "[WhatIf] 不写任何文件，退出 0。"
  exit 0
}

if (-not $changed -and -not $RemoveNodeModules) {
  Write-Step ""
  Write-Step "卸载完成（没有需要改动的内容）。刷新页面（Ctrl+R）即可。" -ForegroundColor Yellow
  exit 0
}

# ---------- 2. 备份 ----------
$backupRoot = Join-Path $ProfileDir '.uninstall-backup'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $backupRoot $stamp
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $pkgFile -Destination (Join-Path $backupDir 'package.json') -Force
$patchBackedUp = $false
if (Test-Path -LiteralPath $patchFile) {
  Copy-Item -LiteralPath $patchFile -Destination (Join-Path $backupDir 'cordis.patch.yml') -Force
  $patchBackedUp = $true
}
Write-Step "已备份 → $backupDir"

$wrote = $false
try {
  if ($changed) {
    if ($removeDependency) { $json.dependencies.PSObject.Properties.Remove($PackageName) }
    if ($removeBundle) {
      $remaining = @($bundles | Where-Object { $_ -ne $PackageName })
      $json.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $remaining -Force
    }

    # ---------- 3. 写 JSON（无 BOM）----------
    $jsonText = $json | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($pkgFile, $jsonText, $Utf8NoBom)
    $wrote = $true

    # ---------- 4. 读回自校验 ----------
    $bytes = [System.IO.File]::ReadAllBytes($pkgFile)
    if (Test-Bom $bytes) { throw "写出来的 package.json 带 BOM" }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $checkJson = [System.IO.File]::ReadAllText($pkgFile, $strictUtf8) | ConvertFrom-Json
    if ($checkJson.dependencies -and $checkJson.dependencies.PSObject.Properties[$PackageName]) {
      throw "读回校验失败：dependencies.$PackageName 仍然存在"
    }
    $checkBundles = @()
    if ($checkJson.dsh -and $checkJson.dsh.profile -and $checkJson.dsh.profile.PSObject.Properties['bundles'] -and $checkJson.dsh.profile.bundles) {
      $checkBundles = @($checkJson.dsh.profile.bundles)
    }
    if (@($checkBundles | Where-Object { $_ -eq $PackageName }).Count -gt 0) {
      throw "读回校验失败：dsh.profile.bundles 里仍有 $PackageName"
    }
    Write-Step "已移除依赖与 bundle（已校验：无 BOM、可解析、两项均已消失）"
  }

  if ($RemoveNodeModules) {
    if (Test-Path -LiteralPath (Join-Path $ProfileDir 'node_modules')) {
      Write-Step "正在删除 node_modules…"
      Remove-Item -LiteralPath (Join-Path $ProfileDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($lockExists) {
      Write-Step "正在删除 pnpm-lock.yaml…"
      Remove-Item -LiteralPath (Join-Path $ProfileDir 'pnpm-lock.yaml') -Force -ErrorAction SilentlyContinue
    }
  } elseif ($nodeModulesExists) {
    Write-Step "保留 node_modules（用 -RemoveNodeModules 可一并删除）"
    Write-Step "  残留：$linked"
  }
} catch {
  $message = $_.Exception.Message
  if ($wrote) {
    try {
      Copy-Item -LiteralPath (Join-Path $backupDir 'package.json') -Destination $pkgFile -Force
      if ($patchBackedUp) { Copy-Item -LiteralPath (Join-Path $backupDir 'cordis.patch.yml') -Destination $patchFile -Force }
      Write-Warning "已从备份回滚。"
    } catch {
      Write-Warning "回滚失败：$($_.Exception.Message)。手工备份在：$backupDir"
    }
    Write-Host "[失败] $message" -ForegroundColor Red
    Write-Host "卸载中止：profile 未被改动（备份保留在 $backupDir）。" -ForegroundColor Red
  } else {
    Write-Host "[失败] $message" -ForegroundColor Red
  }
  exit 1
}

Write-Step ""
Write-Step "卸载完成。刷新页面（Ctrl+R）；侧栏「Obsidian」还在就重启 DeepSeek Harness。" -ForegroundColor Yellow
Write-Step "备份：$backupDir"
exit 0
