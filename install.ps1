# 把 dsh-plugin-obsidian 装进一个 DSH profile（默认桌面 profile）。
#
# 做三件事，全部幂等：
#   1. 在 profile 的 package.json 里登记 `link:` 依赖（link 而不是 file：
#      file 会被 pnpm 硬链接复制，之后源码改动进不去）
#   2. 把包名加进 dsh.profile.bundles（这个包自带 cordis.patch.yml，会插入自己的行）
#   3. 用 DSH 自带的 pnpm 安装
#
# 安全约定（照抄 dsh-plugin-zero-friction 的教训）：
#   - 改 profile 前先备份到 <ProfileDir>\.install-backup\<时间戳>\
#   - 写 JSON 必须无 BOM（PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
#     带 BOM 的 JSON 会让 DSH 起不来）
#   - 写后读回自校验：无 BOM + 可解析 + 两项都在；失败立刻用备份回滚并退出非 0
#   - -WhatIf / -Check 只打印计划，不写任何文件
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   ... -ProfileDir <路径>
#   ... -DshHome <路径> -ProfileDir <路径>
#   ... -WhatIf
#
# 装完需要刷新页面（Ctrl+R）；侧栏没出现「Obsidian」就重启 DeepSeek Harness。

[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$DshHome = "$env:USERPROFILE\.dsh",
  [string]$InstallDir,
  [string]$PackageName = 'dsh-plugin-obsidian',
  [string]$PackagePath,
  [int]$TimeoutSeconds = 300,
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

# ---------- 0. 解析参数与路径 ----------
if (-not $ProfileDir) { $ProfileDir = Join-Path $DshHome 'profiles\desktop' }
if (-not $PackagePath) { $PackagePath = Split-Path -Parent $MyInvocation.MyCommand.Path }
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)

$pkgFile = Join-Path $ProfileDir 'package.json'
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'

Write-Step "插件源码   : $PackagePath"
Write-Step "目标 profile: $ProfileDir"
if ($dryRun) { Write-Step "[WhatIf] 只打印计划，不会写任何文件" }

if (-not (Test-Path -LiteralPath $pkgFile)) {
  throw "找不到 profile 的 package.json：$pkgFile（用 -ProfileDir 指定一个存在的 profile，先让 DSH 初始化它）"
}

$repoPkg = Join-Path $PackagePath 'package.json'
if (-not (Test-Path -LiteralPath $repoPkg)) {
  throw "插件源码不完整：$repoPkg 不存在。请在仓库根目录运行本脚本。"
}
if (-not (Test-Path -LiteralPath (Join-Path $PackagePath 'lib\index.js'))) {
  Write-Warning "插件源码里还没有 lib\index.js。安装会成功，但插件行会 import 失败（面板/工具不会激活）。"
}

# link: 用正斜杠，与官方 CLI 写入的形态一致
$spec = 'link:' + ($PackagePath -replace '\\', '/')

# ---------- 1. 读取并计算新内容（不落盘） ----------
$originalBytes = [System.IO.File]::ReadAllBytes($pkgFile)
$originalHasBom = Test-Bom $originalBytes
$originalText = [System.IO.File]::ReadAllText($pkgFile, [System.Text.Encoding]::UTF8)
$json = $originalText | ConvertFrom-Json
if ($null -eq $json) { throw "profile 的 package.json 解析结果为空：$pkgFile" }

if ($null -eq $json.dependencies) {
  $json | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue (New-Object psobject) -Force
}
$depProp = $json.dependencies.PSObject.Properties[$PackageName]
$hadDependency = [bool]$depProp
$oldDependency = if ($hadDependency) { [string]$depProp.Value } else { $null }
if ($hadDependency) { $depProp.Value = $spec }
else { $json.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $spec -Force }

if ($null -eq $json.dsh) { $json | Add-Member -NotePropertyName 'dsh' -NotePropertyValue (New-Object psobject) -Force }
if ($null -eq $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue (New-Object psobject) -Force }

$bundles = @()
if ($json.dsh.profile.PSObject.Properties['bundles'] -and $json.dsh.profile.bundles) {
  $bundles = @($json.dsh.profile.bundles)
}
$bundleCountBefore = @($bundles | Where-Object { $_ -eq $PackageName }).Count
# 去重：移除已有的同名项后追加到末尾（幂等）
$bundles = @($bundles | Where-Object { $_ -ne $PackageName })
$bundles = @($bundles) + @($PackageName)
$json.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $bundles -Force

$alreadyInstalled = ($hadDependency -and $oldDependency -eq $spec -and $bundleCountBefore -eq 1)

$jsonText = $json | ConvertTo-Json -Depth 20

# ---------- 2. 依赖 / pnpm 探测 ----------
function Find-DshInstall {
  param([string]$Explicit)
  if ($Explicit) {
    if (Test-Path -LiteralPath (Join-Path $Explicit 'resources\runtime')) { return (Resolve-Path -LiteralPath $Explicit).Path }
    throw "指定的 DSH 安装目录无效：$Explicit（找不到 resources\runtime）"
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:PROGRAMFILES 'DeepSeek Harness'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'),
    (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness'),
    (Join-Path $env:PROGRAMFILES 'deepseek-harness')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'resources\runtime'))) { return $c }
  }
  # 注册表兜底（卸载信息里的 DisplayName / InstallLocation）
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($root in $roots) {
    try {
      $entries = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
      foreach ($e in $entries) {
        if ($e.DisplayName -and $e.DisplayName -like '*DeepSeek Harness*' -and $e.InstallLocation) {
          if (Test-Path -LiteralPath (Join-Path $e.InstallLocation 'resources\runtime')) { return $e.InstallLocation }
        }
      }
    } catch { }
  }
  return $null
}

function Find-Pnpm([string]$Install) {
  $rels = @(
    'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs',
    'resources\runtime\pnpm\bin\pnpm.mjs',
    'resources\runtime\cli\node_modules\pnpm\bin\pnpm.cjs'
  )
  if ($Install) {
    foreach ($rel in $rels) {
      $p = Join-Path $Install $rel
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
  return $null
}

function Find-Node([string]$Install) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
  if ($Install) {
    $rels = @(
      'resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
      'resources\runtime\bin\node.exe'
    )
    foreach ($rel in $rels) {
      $p = Join-Path $Install $rel
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  foreach ($p in @((Join-Path $env:PROGRAMFILES 'nodejs\node.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

$resolvedInstall = $null
try { $resolvedInstall = Find-DshInstall -Explicit $InstallDir } catch { throw }
$pnpmPath = Find-Pnpm -Install $resolvedInstall
$nodePath = Find-Node -Install $resolvedInstall

if (-not $pnpmPath) {
  throw "找不到 DSH 自带的 pnpm（探测过 $resolvedInstall 与 PATH）。dependencies/bundles 还没改，profile 未被修改。"
}
if ($pnpmPath -like '*.cmd' -or $pnpmPath -like '*.ps1') {
  throw "探测到的 pnpm 是包装脚本（$pnpmPath），请用 -InstallDir 指向 DeepSeek Harness 安装目录。"
}
if (-not $nodePath) {
  throw "找不到 node（PATH 与 DSH 自带目录都没有）。dependencies/bundles 还没改，profile 未被修改。"
}

# ---------- 3. 干跑 ----------
if ($dryRun) {
  Write-Step ""
  Write-Step "[WhatIf] 将备份：$(Join-Path $ProfileDir '.install-backup\<时间戳>')"
  Write-Step "[WhatIf] dependencies.$PackageName = $spec"
  Write-Step "[WhatIf] dependencies.$PackageName 当前值：$(if ($hadDependency) { $oldDependency } else { '<不存在>' })"
  Write-Step "[WhatIf] dsh.profile.bundles 将变为：[$($bundles -join ', ')]"
  Write-Step "[WhatIf] 用 pnpm 安装：$nodePath $pnpmPath install  （在 $ProfileDir，超时 ${TimeoutSeconds}s）"
  if ($alreadyInstalled) { Write-Step "[WhatIf] 已安装且 spec 一致：真实运行会跳过写文件与 pnpm（幂等）" }
  Write-Step "[WhatIf] 不写任何文件，退出 0。"
  exit 0
}

# ---------- 4. 备份 ----------
$backupRoot = Join-Path $ProfileDir '.install-backup'
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
  if ($alreadyInstalled) {
    Write-Step "package.json 已是目标状态（依赖 + bundle 各一项），跳过写文件。"
  } else {
    # ---------- 5. 写 JSON（无 BOM）----------
    [System.IO.File]::WriteAllText($pkgFile, $jsonText, $Utf8NoBom)
    $wrote = $true

    # ---------- 6. 读回自校验 ----------
    $bytes = [System.IO.File]::ReadAllBytes($pkgFile)
    if (Test-Bom $bytes) { throw "写出来的 package.json 带 BOM" }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $readBackText = [System.IO.File]::ReadAllText($pkgFile, $strictUtf8)
    $checkJson = $readBackText | ConvertFrom-Json
    $checkDep = $checkJson.dependencies.PSObject.Properties[$PackageName]
    if (-not $checkDep) { throw "读回校验失败：dependencies.$PackageName 不存在" }
    if ([string]$checkDep.Value -ne $spec) { throw "读回校验失败：dependencies.$PackageName 的值是 '$($checkDep.Value)'，期望 '$spec'" }
    $checkBundles = @($checkJson.dsh.profile.bundles)
    $checkCount = @($checkBundles | Where-Object { $_ -eq $PackageName }).Count
    if ($checkCount -ne 1) { throw "读回校验失败：dsh.profile.bundles 里 $PackageName 出现 $checkCount 次（期望 1 次）" }
    if ([string]$checkJson.name -ne [string]$json.name) { throw "读回校验失败：profile 名 '$($checkJson.name)' 与原值不一致" }
    Write-Step "已登记依赖与 bundle（已校验：无 BOM、可解析、依赖与 bundle 各一项）"
  }

  # ---------- 7. pnpm install（带超时）----------
  Write-Step ""
  Write-Step "用 pnpm 安装依赖：$nodePath $pnpmPath install  （cwd=$ProfileDir，超时 ${TimeoutSeconds}s）"
  $job = Start-Job -ScriptBlock {
    param($NodePath, $PnpmPath, $WorkDir)
    try {
      Set-Location -LiteralPath $WorkDir
      $out = & $NodePath $PnpmPath install 2>&1 | Out-String
      [pscustomobject]@{ Code = $LASTEXITCODE; Output = $out }
    } catch {
      [pscustomobject]@{ Code = -1; Output = $_.Exception.Message }
    }
  } -ArgumentList $nodePath, $pnpmPath, $ProfileDir

  $finished = Wait-Job -Job $job -Timeout $TimeoutSeconds
  if (-not $finished) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    $partial = Receive-Job -Job $job -ErrorAction SilentlyContinue | Out-String
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    if ($partial.Trim()) { Write-Step $partial.Trim() }
    throw "pnpm install 超时（${TimeoutSeconds}s）"
  }
  $result = Receive-Job -Job $job -ErrorAction SilentlyContinue
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  $pnpmCode = -1
  $pnpmOut = ''
  if ($result) {
    $last = @($result)[-1]
    if ($null -ne $last.Code) { $pnpmCode = [int]$last.Code }
    if ($last.Output) { $pnpmOut = [string]$last.Output }
  }
  if ($pnpmOut.Trim()) {
    $lines = @($pnpmOut.Trim() -split "`r?`n")
    $tail = @($lines | Select-Object -Last 12)
    foreach ($line in $tail) { Write-Step "  | $line" }
  }
  if ($pnpmCode -ne 0) { throw "pnpm install 失败（exit $pnpmCode）" }
  Write-Step "pnpm install 完成（exit 0）"

  $linked = Join-Path $ProfileDir "node_modules\$PackageName"
  if (Test-Path -LiteralPath $linked) {
    $item = Get-Item -LiteralPath $linked -Force
    $targetText = if ($item.Target) { ($item.Target -join '; ') } else { '<未知>' }
    Write-Step "已链接：$($item.LinkType) → $targetText"
  } else {
    Write-Warning "pnpm 跑完了但 node_modules\$PackageName 不存在，请检查上面的 pnpm 输出。"
  }
} catch {
  $message = $_.Exception.Message
  $where = $_.InvocationInfo.PositionMessage
  $stack = $_.ScriptStackTrace
  if ($wrote) {
    try {
      Copy-Item -LiteralPath (Join-Path $backupDir 'package.json') -Destination $pkgFile -Force
      if ($patchBackedUp) { Copy-Item -LiteralPath (Join-Path $backupDir 'cordis.patch.yml') -Destination $patchFile -Force }
      Write-Warning "已从备份回滚 package.json / cordis.patch.yml。"
      Write-Warning "node_modules 可能仍有残留；可用 uninstall.ps1 -RemoveNodeModules 清理。"
    } catch {
      Write-Warning "回滚失败：$($_.Exception.Message)。手工备份在：$backupDir"
    }
    Write-Host "[失败] $message" -ForegroundColor Red
    Write-Host "  位置：$where" -ForegroundColor Red
    Write-Host "  调用栈：$stack" -ForegroundColor Red
    Write-Host "安装中止：profile 未被改动（备份保留在 $backupDir）。" -ForegroundColor Red
  } else {
    Write-Host "[失败] $message" -ForegroundColor Red
    Write-Host "安装中止：package.json 未被修改。" -ForegroundColor Red
  }
  exit 1
}

Write-Step ""
Write-Step "下一步：刷新页面（Ctrl+R）。侧栏没出现「Obsidian」就重启 DeepSeek Harness。" -ForegroundColor Yellow
exit 0
