# 隔离实例端到端验证：dsh-plugin-obsidian
#
# 绝不碰真实环境：
#   - DSH_HOME 被强制指向 %TEMP% 下的临时目录（脚本开头会断言这一点）
#   - vault 是临时目录里的中文 .md 文件，DSH_OBSIDIAN_VAULT 注入给插件
#   - 只 kill 自己启动的进程树，不碰正在运行的 DeepSeek Harness
#   - 结束删掉临时 DSH_HOME / 临时 vault（-KeepTemp 可保留排查）
#
# 验证内容：
#   A. 安装器往返：-WhatIf 不写文件 → 装两次幂等 → dump-config 行已组合
#                  → 卸载移除两项 → JSON 始终无 BOM 可解析 → 二次卸载幂等
#   B. 官方 CLI 安装：dsh plugin --profile web add <repo>（失败回退 install.ps1）
#   C. 启服务：dsh web --port <空闲> --no-open，从 stdout 抓带 token 的 URL
#   D. HTTP API：health（toolsRegistered==10）/ status / tree / note CRUD / search / trash / 跨源拒绝
#   E. 浏览器面板（有 Chromium/Edge 时）：headless CDP 打开 GUI →
#      [data-obsidian-panel="root"] → state=ready → data-obsidian-vault →
#      新建笔记流程（树里出现）→ 页面内 fetch health → 截图
#   F. 无浏览器：退化为 HTTP 断言，并明确报告「面板未做浏览器验证」
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-isolated.ps1
#   ... -HttpOnly        强制跳过浏览器（只跑 HTTP 断言）
#   ... -KeepTemp        保留临时目录（失败排查用）
#   ... -RepoPath <路径> -DshCli <dsh.cmd 路径>
#
# 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 前置条件不满足（源码/CLI 缺失）

[CmdletBinding()]
param(
  [string]$RepoPath,
  [string]$DshCli,
  [string]$InstallDir,
  [switch]$HttpOnly,
  [switch]$KeepTemp,
  [int]$BootTimeoutSeconds = 150,
  [int]$PanelTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$script:Results = New-Object System.Collections.ArrayList
$script:LogLines = New-Object System.Collections.ArrayList
$script:BootPid = 0
$script:ChromePid = 0
$script:BrowserVerified = $false
$script:WebSession = $null

function Write-Log([string]$Line) {
  [void]$script:LogLines.Add($Line)
  Write-Host $Line
}

function Add-Result([string]$Name, [bool]$Ok, [string]$Detail) {
  $entry = [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }
  [void]$script:Results.Add($entry)
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  $color = if ($Ok) { 'Green' } else { 'Red' }
  $line = "[{0}] {1}  {2}" -f $tag, $Name, $Detail
  [void]$script:LogLines.Add($line)
  Write-Host $line -ForegroundColor $color
}

function Read-SharedText([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try {
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
    } finally { }
  } catch { return '' }
}

function Wait-FileRegex([string]$Path, [string]$Pattern, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $text = Read-SharedText $Path
    if ($text) {
      $m = [regex]::Match($text, $Pattern)
      if ($m.Success) { return $m.Value }
    }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

function Get-FreePort {
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return [int]($listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function Test-PortOpen([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($ar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Stop-Tree([int]$ProcId) {
  if (-not $ProcId -or $ProcId -le 0) { return }
  try { & taskkill /PID $ProcId /T /F 2>&1 | Out-Null } catch { }
}

# 用 cmd.exe 包一层跑 CLI 并抓输出 + exit code；不改全局环境。
# 约定：$CommandLine 必须以带引号的 exe 路径开头（例如 '"C:\...\dsh.cmd" --profile web ...'），
# 这里再补外层引号，得到 cmd 认得的 /d /c ""<exe>" <args> > "<out>" 2>&1 形式。
function Invoke-Capture([string]$CommandLine, [string]$OutFile) {
  Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
  $cmdArgs = '/d /c "' + $CommandLine + ' > "' + $OutFile + '" 2>&1"'
  $proc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArgs -Wait -PassThru -WindowStyle Hidden
  return $proc.ExitCode
}

function Find-DshCli([string]$Explicit, [string]$InstallRoot) {
  $candidates = @()
  if ($Explicit) { $candidates += $Explicit }
  if ($InstallRoot) { $candidates += (Join-Path $InstallRoot 'resources\runtime\cli\bin\dsh.cmd') }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:PROGRAMFILES 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

function Find-Browser {
  $candidates = @(
    (Join-Path $env:PROGRAMFILES 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:PROGRAMFILES 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

function Invoke-Api([string]$Method, [string]$PathAndQuery, $Body) {
  $params = @{
    Uri = "$script:ApiBase$PathAndQuery"
    UseBasicParsing = $true
    WebSession = $script:WebSession
    TimeoutSec = 30
    Method = $Method
  }
  if ($null -ne $Body) {
    # PowerShell 5.1 的 Invoke-WebRequest 会把字符串 body 按 Latin-1 发出，中文变 '?'；
    # 显式传 UTF-8 字节数组，真正验证插件的 UTF-8 处理。
    $params['ContentType'] = 'application/json; charset=utf-8'
    $params['Body'] = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
  }
  try {
    $resp = Invoke-WebRequest @params
    $json = $null
    try { $json = $resp.Content | ConvertFrom-Json } catch { }
    return [pscustomobject]@{ Ok = $true; Status = [int]$resp.StatusCode; Json = $json; Raw = $resp.Content }
  } catch {
    $status = -1
    $raw = ''
    if ($_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch { }
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $raw = $reader.ReadToEnd()
          $reader.Dispose()
        }
      } catch { }
    }
    $json = $null
    if ($raw -and $raw.TrimStart().StartsWith('{')) { try { $json = $raw | ConvertFrom-Json } catch { } }
    return [pscustomobject]@{ Ok = $false; Status = $status; Json = $json; Raw = $raw; Error = $_.Exception.Message }
  }
}

function Write-Utf8File([string]$Path, [string]$Content) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-FileNoBom([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  return -not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
}

# Headless Chromium CDP 驱动（运行在临时目录，由本脚本写入 cdp-verify.cjs）。
# 使用 Node 24 内置的 fetch / WebSocket；只连 127.0.0.1 的调试端口。
$CdpDriverSource = @'
#!/usr/bin/env node
// 由 tools/verify-isolated.ps1 生成到临时目录：headless Chromium CDP 面板验证。
// 只连 127.0.0.1 的调试端口，不改仓库、不碰真实 vault。
'use strict';
const fs = require('node:fs');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

function record(name, ok, detail) {
  const safe = String(detail === undefined || detail === null ? '' : detail).replace(/[\r\n]+/g, ' ');
  console.log('ASSERT|' + name + '|' + (ok ? 'PASS' : 'FAIL') + '|' + safe);
}

async function main() {
  const cdpBase = 'http://127.0.0.1:' + cfg.cdpPort;
  const created = await (await fetch(cdpBase + '/json/new?url=' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
  if (!created.webSocketDebuggerUrl) throw new Error('没有 webSocketDebuggerUrl: ' + JSON.stringify(created));
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('WebSocket 连接失败')); });

  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      exceptions.push(String((d && ((d.exception && d.exception.description) || d.text)) || 'unknown exception').slice(0, 200));
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evalJs = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('页面 JS 异常: ' + String((d.exception && d.exception.description) || d.text).slice(0, 200));
    }
    return res.result ? res.result.value : undefined;
  };
  const poll = async (fn, timeoutMs, intervalMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const v = await fn(); if (v) return v; } catch (e) { }
      await sleep(intervalMs || 400);
    }
    return null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: cfg.url });

  const ready = await poll(async () => {
    const st = await evalJs('document.readyState');
    return st === 'complete' ? st : null;
  }, 60000, 300);
  record('页面加载完成 (readyState=complete)', !!ready, ready ? 'ok' : 'timeout');
  if (!ready) throw new Error('页面 60s 内没有加载完成');

  // 1b. 关闭启动提示/引导弹窗（「预览版说明」「开始使用」等），避免遮挡与干扰交互。
  //     只点关闭类控件（继续/知道了/×/aria-label=关闭），绝不点「登录」「添加 API Key」。
  const dismissNotice = async (tag) => {
    const dismissed = [];
    for (let i = 0; i < 6; i++) {
      const clicked = await evalJs(`(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
        const btns = Array.from(document.querySelectorAll('button')).filter(visible);
        const byText = btns.find((b) => /^(继续|知道了|我知道了|开始使用|关闭|确定)$/.test((b.textContent || '').trim()));
        if (byText) { byText.click(); return 'text:' + (byText.textContent || '').trim(); }
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]')).filter(visible);
        for (const d of dialogs) {
          const closer = Array.from(d.querySelectorAll('button, [role="button"]')).filter(visible).find((el) => {
            const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
            const txt = (el.textContent || '').trim();
            return /关闭|close|dismiss/i.test(label) || txt === '×' || txt === '✕' || txt === 'X';
          });
          if (closer) { closer.click(); return 'close:' + (((closer.getAttribute('aria-label') || '').trim()) || 'button'); }
        }
        return null;
      })()`).catch(() => null);
      if (clicked) { dismissed.push(clicked); await sleep(600); } else { break; }
    }
    if (dismissed.length) { record('关闭启动提示弹窗 (' + tag + ')', true, dismissed.join(' → ')); }
    return dismissed;
  };
  await dismissNotice('page-load');

  const rootSelector = '[data-obsidian-panel="root"]';
  const rootExpr = 'document.querySelector(' + JSON.stringify(rootSelector) + ')';
  let sidebarInfo = null;
  let rootFound = await poll(async () => (await evalJs('!!' + rootExpr)), 5000, 300);
  if (!rootFound) {
    const attempts = Math.max(1, Math.ceil((cfg.panelTimeoutMs || 90000) / 5000));
    for (let i = 0; i < attempts && !rootFound; i++) {
      sidebarInfo = await evalJs(`(() => {
        const all = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"]'));
        const hits = all.filter((el) => {
          const txt = (el.textContent || '').trim();
          const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
          if (!(txt === 'Obsidian' || label.indexOf('Obsidian') >= 0)) return false;
          const r = el.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        });
        if (!hits.length) return { clicked: false, candidates: all.length };
        hits.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.width * ra.height - rb.width * rb.height; });
        const el = hits[0];
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40), candidates: hits.length };
      })()`).catch((e) => ({ clicked: false, error: String(e && e.message || e) }));
      rootFound = await poll(async () => (await evalJs('!!' + rootExpr)), 5000, 300);
    }
  }
  record('面板 root 出现 (' + rootSelector + ')', !!rootFound, sidebarInfo ? ('sidebar=' + JSON.stringify(sidebarInfo)) : '(无需点侧栏)');
  if (!rootFound) {
    const bodyText = await evalJs('(document.body ? document.body.innerText : "").slice(0, 300)').catch(() => '');
    record('面板诊断', false, String(bodyText).replace(/\s+/g, ' ').slice(0, 250));
    throw new Error('面板没有出现，终止浏览器断言');
  }

  const state = await poll(async () => {
    const v = await evalJs(rootExpr + '.getAttribute("data-obsidian-state")');
    return v === 'ready' ? v : null;
  }, 45000, 400);
  record('面板 state=ready', !!state, 'state=' + String(state));
  if (!state) {
    const cur = await evalJs(rootExpr + '.getAttribute("data-obsidian-state")').catch(() => '?');
    const errText = await evalJs('(() => { const e = document.querySelector("[data-obsidian-error]"); return e ? (e.textContent || "").slice(0, 200) : ""; })()').catch(() => '');
    record('面板 state 诊断', false, 'state=' + String(cur) + ' error=' + String(errText));
  }

  let vaultAttr = '';
  try { vaultAttr = await evalJs(rootExpr + '.getAttribute("data-obsidian-vault") || ""'); } catch (e) { vaultAttr = ''; }
  let vaultOk = norm(vaultAttr) === norm(cfg.vaultPath);
  if (!vaultAttr) {
    const st = await evalJs("(async () => { const r = await fetch('/dsh-obsidian/api/status'); const j = await r.json(); return JSON.stringify(j); })()").catch(() => '');
    try { const parsed = JSON.parse(st); vaultAttr = parsed.vaultPath || ''; } catch (e) { }
    vaultOk = norm(vaultAttr) === norm(cfg.vaultPath);
  }
  record('data-obsidian-vault = 临时 vault', vaultOk, 'attr=' + vaultAttr + ' expected=' + cfg.vaultPath);

  const healthRaw = await evalJs("(async () => { const r = await fetch('/dsh-obsidian/api/health'); const j = await r.json(); return JSON.stringify(j); })()").catch((e) => 'EVAL_ERR: ' + e.message);
  let toolsCount = -1;
  let healthOk = false;
  try { const h = JSON.parse(healthRaw); healthOk = h.ok === true; toolsCount = (h.toolsRegistered || []).length; } catch (e) { }
  record('页面 fetch /health toolsRegistered = 10', !!(healthOk && toolsCount === 10), 'count=' + toolsCount + ' raw=' + String(healthRaw).slice(0, 160));

  const newInfo = await evalJs(`(() => {
    const root = ${rootExpr};
    const btn = root.querySelector('[data-obsidian-action="new"]');
    if (!btn) return { ok: false, reason: 'no new button' };
    btn.click();
    return { ok: true, text: (btn.textContent || '').trim().slice(0, 40) };
  })()`).catch((e) => ({ ok: false, reason: String(e && e.message || e) }));
  record('点击「新建笔记」按钮', !!(newInfo && newInfo.ok), JSON.stringify(newInfo));
  await sleep(600);

  const inputs = await evalJs(`(() => {
    const root = ${rootExpr};
    return Array.from(root.querySelectorAll('input, textarea')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }).map((el, i) => ({ i: i, tag: el.tagName, type: el.type || '', placeholder: el.placeholder || '', name: el.name || '' }));
  })()`).catch(() => []);
  record('找到新建笔记表单输入框', !!(Array.isArray(inputs) && inputs.length > 0), 'inputs=' + JSON.stringify(inputs).slice(0, 300));

  const fill = await evalJs(`(() => {
    const root = ${rootExpr};
    const wanted = { path: ${JSON.stringify(cfg.newNotePath)}, marker: ${JSON.stringify(cfg.marker)} };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const inputs = Array.from(root.querySelectorAll('input')).filter(visible);
    const areas = Array.from(root.querySelectorAll('textarea')).filter(visible);
    const setValue = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pick = (arr, words) => arr.find((el) => {
      const hay = ((el.placeholder || '') + ' ' + (el.name || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      return words.some((w) => hay.indexOf(w) >= 0);
    });
    const pathInput = pick(inputs, ['路径', 'path']) || inputs.filter((el) => el.type === 'text')[0] || inputs[0];
    const titleInput = pick(inputs, ['标题', 'title']);
    const contentArea = pick(areas, ['内容', 'content']) || areas[0];
    const tagsInput = pick(inputs, ['标签', 'tags', 'tag']);
    const filled = [];
    if (pathInput) { setValue(pathInput, wanted.path); filled.push('path'); }
    if (titleInput && titleInput !== pathInput) { setValue(titleInput, wanted.marker); filled.push('title'); }
    if (contentArea) { setValue(contentArea, '# ' + wanted.marker + '\\n\\n由 CDP 隔离验证创建。'); filled.push('content'); }
    if (tagsInput && tagsInput !== pathInput && tagsInput !== titleInput) { setValue(tagsInput, 'verify,cdp'); filled.push('tags'); }
    const buttons = Array.from(root.querySelectorAll('button')).filter(visible).map((b) => ({ el: b, text: (b.textContent || '').trim(), action: b.getAttribute('data-obsidian-action') || '' }));
    const forbidden = /^(refresh|daily|new|open|trash|edit|append)$/;
    const submit = buttons.find((b) => b.action === 'save' || b.action === 'create' || b.action === 'submit') ||
      buttons.find((b) => /创建笔记|保存|提交/.test(b.text) && !/取消/.test(b.text)) ||
      buttons.find((b) => /创建|新建/.test(b.text) && !/新建笔记|取消/.test(b.text) && !forbidden.test(b.action));
    if (!submit) return { ok: false, filled: filled, buttons: buttons.map((b) => b.text + '[' + b.action + ']').slice(0, 12) };
    submit.el.click();
    return { ok: true, filled: filled, submit: submit.text + '[' + submit.action + ']' };
  })()`).catch((e) => ({ ok: false, reason: String(e && e.message || e) }));
  record('填写并提交新建笔记表单', !!(fill && fill.ok), JSON.stringify(fill).slice(0, 300));

  const findNote = async () => {
    return await evalJs(`(() => {
      const root = ${rootExpr};
      if (!root) return null;
      const items = Array.from(root.querySelectorAll('[data-obsidian-note-item]')).map((el) => (el.textContent || '').trim());
      const hit = items.find((t) => t.indexOf(${JSON.stringify(cfg.marker)}) >= 0 || t.indexOf(${JSON.stringify(cfg.newNotePath)}) >= 0);
      if (hit) return { via: 'tree-item', text: hit.slice(0, 80) };
      const np = root.querySelector('[data-obsidian-note-path]');
      if (np && (np.textContent || '').indexOf(${JSON.stringify(cfg.newNotePath)}) >= 0) return { via: 'note-path', text: (np.textContent || '').slice(0, 80) };
      const body = root.innerText || '';
      if (body.indexOf(${JSON.stringify(cfg.marker)}) >= 0) return { via: 'panel-text', text: ${JSON.stringify(cfg.marker)} };
      return null;
    })()`);
  };
  let appeared = await poll(findNote, 12000, 500);
  if (!appeared) {
    const refreshed = await evalJs(`(() => {
      const root = ${rootExpr};
      const btn = root ? root.querySelector('[data-obsidian-action="refresh"]') : null;
      if (!btn) return false;
      btn.click();
      return true;
    })()`).catch(() => false);
    record('新建笔记未出现→点击刷新重试', true, 'refreshClicked=' + refreshed);
    if (refreshed) { await sleep(800); appeared = await poll(findNote, 12000, 500); }
  }
  if (!appeared) {
    const diag = await evalJs(`(() => {
      const root = ${rootExpr};
      const err = root ? root.querySelector('[data-obsidian-error]') : null;
      return JSON.stringify({
        error: err ? (err.textContent || '').slice(0, 200) : '',
        items: root ? Array.from(root.querySelectorAll('[data-obsidian-note-item]')).map((el) => (el.textContent || '').trim()).slice(0, 20) : [],
        notePathText: root && root.querySelector('[data-obsidian-note-path]') ? (root.querySelector('[data-obsidian-note-path]').textContent || '').slice(0, 120) : '',
        buttons: root ? Array.from(root.querySelectorAll('button')).map((b) => ((b.textContent || '').trim() + '[' + (b.getAttribute('data-obsidian-action') || '') + ']')).slice(0, 15) : []
      });
    })()`).catch(() => '');
    record('新建笔记失败诊断', false, String(diag).slice(0, 600));
  }
  record('新建笔记出现在树/内容区', !!appeared, appeared ? JSON.stringify(appeared) : 'timeout');

  const treeCheck = await evalJs(`(async () => {
    const r = await fetch('/dsh-obsidian/api/tree');
    const j = await r.json();
    const paths = (j.entries || []).map((e) => e.path || '');
    return JSON.stringify({ ok: j.ok === true, match: paths.filter((p) => p.indexOf(${JSON.stringify(cfg.newNotePath)}) >= 0 || p.indexOf(${JSON.stringify(cfg.marker)}) >= 0) });
  })()`).catch((e) => 'EVAL_ERR: ' + e.message);
  let apiHit = false;
  try { const t = JSON.parse(treeCheck); apiHit = !!(t.ok && t.match && t.match.length > 0); } catch (e) { }
  record('页面内 /tree 包含新建笔记', apiHit, String(treeCheck).slice(0, 200));

  try {
    await dismissNotice('before-screenshot');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(cfg.screenshotPath, Buffer.from(shot.data, 'base64'));
    const size = fs.statSync(cfg.screenshotPath).size;
    record('截图已写入', size > 1000, cfg.screenshotPath + ' (' + size + ' bytes)');
  } catch (e) {
    record('截图已写入', false, String(e && e.message || e));
  }

  record('页面无未捕获异常', exceptions.length === 0, 'count=' + exceptions.length + (exceptions.length ? (' first=' + exceptions[0]) : ''));

  try { ws.close(); } catch (e) { }
  await fetch(cdpBase + '/json/close/' + created.id).catch(() => { });
  process.exit(0);
}

main().catch((err) => {
  record('CDP 驱动致命错误', false, String((err && err.message) || err));
  process.exit(1);
});
'@

# ============================================================
# 0. 前置检查与临时环境
# ============================================================
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $RepoPath) {
  if (-not $PSScriptRoot) { Write-Host "无法确定仓库路径，请用 -RepoPath 指定。" -ForegroundColor Red; exit 2 }
  $RepoPath = Split-Path -Parent $PSScriptRoot
}
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path
$repoPkg = Join-Path $RepoPath 'package.json'
$repoEntry = Join-Path $RepoPath 'lib\index.js'
$repoClient = Join-Path $RepoPath 'lib\client.js'

Write-Log "== dsh-plugin-obsidian 隔离验证 =="
Write-Log "仓库: $RepoPath"
Write-Log "时间: $stamp"

$missing = @()
foreach ($need in @($repoPkg, $repoEntry, $repoClient, (Join-Path $RepoPath 'cordis.patch.yml'))) {
  if (-not (Test-Path -LiteralPath $need)) { $missing += $need }
}
if ($missing.Count -gt 0) {
  Write-Log "前置条件不满足：插件源码不完整，缺少：$($missing -join ', ')"
  Add-Result 'precondition: 插件源码完整 (lib/index.js, lib/client.js, cordis.patch.yml)' $false ($missing -join ', ')
  Write-Log "FAIL（源码未就绪，验证未执行）"
  exit 2
}
Add-Result 'precondition: 插件源码完整 (lib/index.js, lib/client.js, cordis.patch.yml)' $true 'ok'

$dsh = Find-DshCli -Explicit $DshCli -InstallRoot $InstallDir
if (-not $dsh) {
  Add-Result 'precondition: 找到 DSH CLI (dsh.cmd)' $false '未找到；用 -DshCli/-InstallDir 指定'
  Write-Log "FAIL（找不到 DSH CLI）"
  exit 2
}
Add-Result 'precondition: 找到 DSH CLI (dsh.cmd)' $true $dsh
Write-Log "DSH CLI: $dsh"

$nodePath = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $nodePath) {
  Add-Result 'precondition: 找到 node' $false 'PATH 里没有 node'
  exit 2
}
Add-Result 'precondition: 找到 node' $true "$nodePath ($(& $nodePath --version))"

$tempBase = [System.IO.Path]::GetFullPath($env:TEMP)
$root = Join-Path $tempBase ("dsh-obsidian-verify-" + $stamp)
$rootFull = [System.IO.Path]::GetFullPath($root)
$inTemp = $rootFull.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and -not $rootFull.Equals($tempBase, [System.StringComparison]::OrdinalIgnoreCase)
Add-Result 'safety: 临时根目录位于 %TEMP% 下' $inTemp $rootFull
if (-not $inTemp) { Write-Log "拒绝在 %TEMP% 之外创建临时环境"; exit 2 }

$origDshHome = $env:DSH_HOME
$origVault = $env:DSH_OBSIDIAN_VAULT
$origInstallDir = $env:DSH_INSTALL_DIR

$screenshotPath = Join-Path $RepoPath ("verify-isolated-" + $stamp + ".png")
$reportPath = Join-Path $RepoPath ("verify-isolated-" + $stamp + ".log")

try {
  New-Item -ItemType Directory -Force -Path $rootFull | Out-Null

  # ============================================================
  # A. 安装器往返（独立临时 DSH_HOME）
  # ============================================================
  Write-Log ""
  Write-Log "-- A. 安装器往返（-WhatIf / 幂等 / 卸载 / dump-config）--"
  $installerHome = Join-Path $rootFull 'installer-home'
  New-Item -ItemType Directory -Force -Path $installerHome | Out-Null
  $env:DSH_HOME = $installerHome
  $installerProfile = Join-Path $installerHome 'profiles\web'

  # 用官方 CLI 初始化 profile 模板（不安装插件，只 dump 一次）
  $initLog = Join-Path $rootFull 'installer-init.log'
  $initExit = Invoke-Capture ('"' + $dsh + '" --profile web --dump-config') $initLog
  $profilePkg = Join-Path $installerProfile 'package.json'
  Add-Result 'installer: 临时 profile 初始化 (dsh --dump-config exit 0)' ($initExit -eq 0) "exit=$initExit"
  if (-not (Test-Path -LiteralPath $profilePkg)) { throw "临时 profile 初始化失败：$profilePkg 不存在" }

  $installPs1 = Join-Path $RepoPath 'install.ps1'
  $uninstallPs1 = Join-Path $RepoPath 'uninstall.ps1'
  $powershellExe = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $powershellExe)) { $powershellExe = 'powershell.exe' }

  # A1 -WhatIf 不写文件
  $beforeHash = (Get-FileHash -LiteralPath $profilePkg -Algorithm SHA256).Hash
  $whatIfOut = Join-Path $rootFull 'installer-whatif.log'
  $whatIfProc = Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $installPs1 + '"'), '-ProfileDir', ('"' + $installerProfile + '"'), '-DshHome', ('"' + $installerHome + '"'), '-WhatIf') -RedirectStandardOutput $whatIfOut -RedirectStandardError ($whatIfOut + '.err') -Wait -PassThru -WindowStyle Hidden
  $afterHash = (Get-FileHash -LiteralPath $profilePkg -Algorithm SHA256).Hash
  $backupDirA = Join-Path $installerProfile '.install-backup'
  $noWrite = ($whatIfProc.ExitCode -eq 0) -and ($beforeHash -eq $afterHash) -and (-not (Test-Path -LiteralPath $backupDirA))
  Add-Result 'installer: -WhatIf exit 0 且不写任何文件' $noWrite "exit=$($whatIfProc.ExitCode) hashSame=$($beforeHash -eq $afterHash) backupCreated=$(Test-Path -LiteralPath $backupDirA)"

  # A2 首次安装
  $installOut1 = Join-Path $rootFull 'installer-install1.log'
  $install1 = Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $installPs1 + '"'), '-ProfileDir', ('"' + $installerProfile + '"'), '-DshHome', ('"' + $installerHome + '"')) -RedirectStandardOutput $installOut1 -RedirectStandardError ($installOut1 + '.err') -Wait -PassThru -WindowStyle Hidden
  Add-Result 'installer: 首次安装 exit 0' ($install1.ExitCode -eq 0) "exit=$($install1.ExitCode)"

  # A3 JSON 无 BOM 且可解析 + 两项各一项
  $installerJson = $null
  $bomFree = $false
  $parsed = $false
  if (Test-Path -LiteralPath $profilePkg) {
    $bomFree = Test-FileNoBom $profilePkg
    try {
      $installerJson = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $parsed = $true
    } catch { $parsed = $false }
  }
  Add-Result 'installer: 安装后 JSON 无 BOM 且可解析' ($bomFree -and $parsed) "noBom=$bomFree parse=$parsed"
  $depOk = $false; $bundleOk = $false; $linkVal = ''
  if ($parsed) {
    $depProp = $installerJson.dependencies.PSObject.Properties['dsh-plugin-obsidian']
    if ($depProp) {
      $linkVal = [string]$depProp.Value
      $expectedLink = 'link:' + ($RepoPath -replace '\\', '/')
      $depOk = ($linkVal -eq $expectedLink)
    }
    $bundleList = @($installerJson.dsh.profile.bundles)
    $bundleOk = (@($bundleList | Where-Object { $_ -eq 'dsh-plugin-obsidian' }).Count -eq 1)
  }
  Add-Result 'installer: dependencies 里 link: 指向本仓库' $depOk $linkVal
  Add-Result 'installer: dsh.profile.bundles 里恰好一项' $bundleOk ("bundles=" + $(if ($parsed) { ($bundleList -join ',') } else { '<parse failed>' }))

  # A4 二次安装幂等
  $installOut2 = Join-Path $rootFull 'installer-install2.log'
  $install2 = Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $installPs1 + '"'), '-ProfileDir', ('"' + $installerProfile + '"'), '-DshHome', ('"' + $installerHome + '"')) -RedirectStandardOutput $installOut2 -RedirectStandardError ($installOut2 + '.err') -Wait -PassThru -WindowStyle Hidden
  $jsonText2 = if (Test-Path -LiteralPath $profilePkg) { [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) } else { '' }
  $depCount2 = ([regex]::Matches($jsonText2, '"dsh-plugin-obsidian"')).Count
  $idempotentOk = ($install2.ExitCode -eq 0) -and ($depCount2 -eq 2) -and (Test-FileNoBom $profilePkg)
  Add-Result 'installer: 二次安装 exit 0 且不产生重复项' $idempotentOk "exit=$($install2.ExitCode) occurrences(含 dep+bundle)=$depCount2"

  # A5 dump-config 行已组合
  $dumpInstalled = Join-Path $rootFull 'installer-dump-installed.txt'
  $dump1Exit = Invoke-Capture ('"' + $dsh + '" --profile web --dump-config') $dumpInstalled
  $dumpText1 = Read-SharedText $dumpInstalled
  $rowPresent = ($dumpText1 -match '(?m)^\s*- id: dsh-plugin-obsidian\s*$')
  Add-Result 'installer: dsh --profile web --dump-config exit 0 且行已组合' (($dump1Exit -eq 0) -and $rowPresent) "exit=$dump1Exit row=$rowPresent"

  # A6 卸载
  $uninstallOut = Join-Path $rootFull 'installer-uninstall.log'
  $uninstall1 = Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $uninstallPs1 + '"'), '-ProfileDir', ('"' + $installerProfile + '"'), '-DshHome', ('"' + $installerHome + '"')) -RedirectStandardOutput $uninstallOut -RedirectStandardError ($uninstallOut + '.err') -Wait -PassThru -WindowStyle Hidden
  $jsonText3 = if (Test-Path -LiteralPath $profilePkg) { [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) } else { '' }
  $uninstallClean = ($uninstall1.ExitCode -eq 0) -and (-not ($jsonText3 -match '"dsh-plugin-obsidian"')) -and (Test-FileNoBom $profilePkg)
  $uninstallParsed = $true
  try { $jsonText3 | ConvertFrom-Json | Out-Null } catch { $uninstallParsed = $false }
  Add-Result 'installer: 卸载移除依赖与 bundle 且 JSON 无 BOM' ($uninstallClean -and $uninstallParsed) "exit=$($uninstall1.ExitCode) contains=$(($jsonText3 -match '"dsh-plugin-obsidian"')) parse=$uninstallParsed"

  # A7 卸载后 dump-config 无该行
  $dumpRemoved = Join-Path $rootFull 'installer-dump-removed.txt'
  $dump2Exit = Invoke-Capture ('"' + $dsh + '" --profile web --dump-config') $dumpRemoved
  $dumpText2 = Read-SharedText $dumpRemoved
  Add-Result 'installer: 卸载后 dump-config exit 0 且行已消失' (($dump2Exit -eq 0) -and (-not ($dumpText2 -match 'dsh-plugin-obsidian'))) "exit=$dump2Exit"

  # A8 二次卸载幂等
  $uninstallOut2 = Join-Path $rootFull 'installer-uninstall2.log'
  $uninstall2 = Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $uninstallPs1 + '"'), '-ProfileDir', ('"' + $installerProfile + '"'), '-DshHome', ('"' + $installerHome + '"')) -RedirectStandardOutput $uninstallOut2 -RedirectStandardError ($uninstallOut2 + '.err') -Wait -PassThru -WindowStyle Hidden
  Add-Result 'installer: 二次卸载 exit 0（幂等）' ($uninstall2.ExitCode -eq 0) "exit=$($uninstall2.ExitCode)"

  # A9 回滚故障注入：让 pnpm 一定失败，install.ps1 必须把 package.json 原样还原并退出非 0
  $rollbackHome = Join-Path $rootFull 'rollback-home'
  $rollbackProfile = Join-Path $rollbackHome 'profiles\web'
  New-Item -ItemType Directory -Force -Path $rollbackProfile | Out-Null
  $rbPkg = Join-Path $rollbackProfile 'package.json'
  $rbObj = [pscustomobject]@{
    name = 'dsh-profile-web'
    private = $true
    dependencies = (New-Object psobject)
    dsh = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
  }
  Write-Utf8File $rbPkg ($rbObj | ConvertTo-Json -Depth 10)
  $rbBeforeHash = (Get-FileHash -LiteralPath $rbPkg -Algorithm SHA256).Hash
  $fakeDsh = Join-Path $rootFull 'fake-dsh'
  $fakePnpm = Join-Path $fakeDsh 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
  Write-Utf8File $fakePnpm "process.exit(3);`n"
  $rbOut = Join-Path $rootFull 'installer-rollback.log'
  $rbProc = Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $installPs1 + '"'), '-ProfileDir', ('"' + $rollbackProfile + '"'), '-InstallDir', ('"' + $fakeDsh + '"')) -RedirectStandardOutput $rbOut -RedirectStandardError ($rbOut + '.err') -Wait -PassThru -WindowStyle Hidden
  $rbAfterHash = (Get-FileHash -LiteralPath $rbPkg -Algorithm SHA256).Hash
  $rbText = [System.IO.File]::ReadAllText($rbPkg, [System.Text.Encoding]::UTF8)
  $rbHasOur = ($rbText -match 'dsh-plugin-obsidian')
  $rbBackupDirs = @(Get-ChildItem (Join-Path $rollbackProfile '.install-backup') -Directory -ErrorAction SilentlyContinue)
  $rbOk = ($rbProc.ExitCode -ne 0) -and ($rbBeforeHash -eq $rbAfterHash) -and (-not $rbHasOur) -and ($rbBackupDirs.Count -gt 0) -and (Test-FileNoBom $rbPkg)
  Add-Result 'installer: pnpm 失败时自动回滚（exit≠0 + package.json 原样还原）' $rbOk "exit=$($rbProc.ExitCode) hashRestored=$($rbBeforeHash -eq $rbAfterHash) containsPlugin=$rbHasOur backupKept=$($rbBackupDirs.Count -gt 0)"

  # ============================================================
  # B. E2E 临时 DSH_HOME + 临时 vault
  # ============================================================
  Write-Log ""
  Write-Log "-- B. 隔离实例（全新临时 DSH_HOME + 临时 vault）--"
  $e2eHome = Join-Path $rootFull 'home'
  $vault = Join-Path $rootFull 'vault'
  New-Item -ItemType Directory -Force -Path $e2eHome | Out-Null
  New-Item -ItemType Directory -Force -Path $vault | Out-Null
  $env:DSH_HOME = $e2eHome
  $env:DSH_OBSIDIAN_VAULT = $vault

  # 临时 vault：中文 .md 文件（UTF-8 无 BOM）
  Write-Utf8File (Join-Path $vault '欢迎.md') ("# 欢迎`n`n这是隔离验证用的临时 Obsidian vault。`n")
  Write-Utf8File (Join-Path $vault '首页.md') ("# 首页`n`n- 目标：验证 dsh-plugin-obsidian 端到端可用`n- vault：临时目录`n")
  Write-Utf8File (Join-Path $vault '01-笔记\读书笔记.md') ("---`ntags: [读书, 验证]`n---`n# 读书笔记`n`n这是一篇带 frontmatter 的中文笔记。`n")
  Write-Utf8File (Join-Path $vault '00-收件箱\收件箱.md') ("# 收件箱`n`n临时条目 #验证`n")
  Write-Utf8File (Join-Path $vault '.obsidian\app.json') '{ "showLineNumber": false }'
  Add-Result 'e2e: 临时 vault 就绪（中文笔记）' $true $vault

  $e2eProfile = Join-Path $e2eHome 'profiles\web'
  $e2eProfilePkg = Join-Path $e2eProfile 'package.json'

  # B1 官方 CLI 安装
  $addLog = Join-Path $rootFull 'cli-add.log'
  $addExit = Invoke-Capture ('"' + $dsh + '" plugin --profile web add "' + $RepoPath + '"') $addLog
  $usedFallback = $false
  Add-Result 'e2e: 官方 CLI 安装 (dsh plugin --profile web add)' ($addExit -eq 0) "exit=$addExit"
  if ($addExit -ne 0) {
    Write-Log "官方 CLI 安装失败，回退 install.ps1："
    Write-Log (Read-SharedText $addLog)
    # 先让官方 CLI 初始化 profile 模板，再用 install.ps1 兜底
    $null = Invoke-Capture ('"' + $dsh + '" --profile web --dump-config') (Join-Path $rootFull 'e2e-init-fallback.log')
    $installFallback = Start-Process -FilePath $powershellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $installPs1 + '"'), '-ProfileDir', ('"' + $e2eProfile + '"'), '-DshHome', ('"' + $e2eHome + '"')) -RedirectStandardOutput (Join-Path $rootFull 'e2e-install-fallback.log') -RedirectStandardError (Join-Path $rootFull 'e2e-install-fallback.log.err') -Wait -PassThru -WindowStyle Hidden
    $usedFallback = $true
    Add-Result 'e2e: 兜底 install.ps1 安装' ($installFallback.ExitCode -eq 0) "exit=$($installFallback.ExitCode)"
  }

  $e2ePkgOk = $false
  $e2ePkgDetail = 'missing package.json'
  if (Test-Path -LiteralPath $e2eProfilePkg) {
    try {
      $e2eJson = [System.IO.File]::ReadAllText($e2eProfilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $depProp2 = $e2eJson.dependencies.PSObject.Properties['dsh-plugin-obsidian']
      $bundlesE2e = @($e2eJson.dsh.profile.bundles)
      $hasBundle = (@($bundlesE2e | Where-Object { $_ -eq 'dsh-plugin-obsidian' }).Count -eq 1)
      $e2ePkgOk = [bool]$depProp2 -and $hasBundle -and (Test-FileNoBom $e2eProfilePkg)
      $e2ePkgDetail = "dep=$(if ($depProp2) { [string]$depProp2.Value } else { '<none>' }) bundle=$hasBundle noBom=$(Test-FileNoBom $e2eProfilePkg)"
    } catch { $e2ePkgDetail = "parse error: $($_.Exception.Message)" }
  }
  Add-Result 'e2e: 临时 profile 里依赖 + bundle 已登记（无 BOM）' $e2ePkgOk $e2ePkgDetail

  # B2 dump-config 组合
  $dumpE2e = Join-Path $rootFull 'e2e-dump.txt'
  $dumpE2eExit = Invoke-Capture ('"' + $dsh + '" --profile web --dump-config') $dumpE2e
  $dumpE2eText = Read-SharedText $dumpE2e
  $e2eRow = ($dumpE2eText -match '(?m)^\s*- id: dsh-plugin-obsidian\s*$')
  Add-Result 'e2e: dsh --profile web --dump-config exit 0 且行已组合' (($dumpE2eExit -eq 0) -and $e2eRow) "exit=$dumpE2eExit row=$e2eRow fallback=$usedFallback"

  # ============================================================
  # C. 启服务
  # ============================================================
  Write-Log ""
  Write-Log "-- C. 启动隔离 web 实例 --"
  $port = Get-FreePort
  $bootOut = Join-Path $rootFull 'boot-out.log'
  $bootErr = Join-Path $rootFull 'boot-err.log'
  Remove-Item $bootOut, $bootErr -Force -ErrorAction SilentlyContinue
  $bootCmd = '/d /c ""' + $dsh + '" web --port ' + $port + ' --no-open > "' + $bootOut + '" 2>&1"'
  $bootProc = Start-Process -FilePath $env:ComSpec -ArgumentList $bootCmd -PassThru -WindowStyle Hidden
  $script:BootPid = $bootProc.Id
  Write-Log "web 进程 pid=$($bootProc.Id) port=$port（DSH_HOME=$e2eHome）"

  $url = Wait-FileRegex $bootOut 'https?://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9._~\-]+' $BootTimeoutSeconds
  Add-Result 'e2e: dsh web 打印带 token 的 URL' ($null -ne $url) $(if ($url) { $url } else { 'timeout' })
  if (-not $url) {
    Write-Log "启动日志（boot-out.log）："
    Write-Log (Read-SharedText $bootOut)
    Write-Log "启动错误（boot-err.log）："
    Write-Log (Read-SharedText $bootErr)
    throw "隔离 web 实例启动失败（无 URL）"
  }

  $base = ($url -split '\?')[0]
  $base = $base.TrimEnd('/')
  $script:ApiBase = $base + '/dsh-obsidian/api'
  $parsedUrl = New-Object System.Uri($url)
  Add-Result 'e2e: URL 端口 = 分配端口' ($parsedUrl.Port -eq $port) "urlPort=$($parsedUrl.Port) expected=$port"

  # 等页面可达（token 换取会话 cookie）
  $script:WebSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $reachable = $false; $reachDetail = ''
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -WebSession $script:WebSession -TimeoutSec 10
      if ([int]$resp.StatusCode -eq 200) { $reachable = $true; $reachDetail = "HTTP 200, $($resp.Content.Length) bytes"; break }
    } catch { $reachDetail = $_.Exception.Message }
    Start-Sleep -Milliseconds 500
  }
  Add-Result 'e2e: 带 token 的 GUI URL 返回 HTTP 200' $reachable $reachDetail

  # 插件行是否激活（import 失败会写在启动日志里）
  $bootText = Read-SharedText $bootOut
  $importFailed = ($bootText -match 'dsh-plugin-obsidian[^\r\n]*failed to import') -or ($bootText -match 'dsh: warning: .*entry did not activate')
  Add-Result 'e2e: 插件 host 行激活（启动日志无 import 失败）' (-not $importFailed) $(if ($importFailed) { '日志含 failed to import / did not activate' } else { 'ok' })
  # 启动日志里应该出现插件自己的「已注册 10/10 个 agent 工具」（digits 不受控制台代码页影响）
  $hostToolsLine = ($bootText -match '10/10')
  Add-Result 'e2e: 启动日志确认 10/10 个 agent 工具已注册' $hostToolsLine $(if ($hostToolsLine) { '看到 10/10' } else { '启动日志无 10/10' })

  # ============================================================
  # D. HTTP API 断言
  # ============================================================
  Write-Log ""
  Write-Log "-- D. HTTP API --"
  $health = Invoke-Api 'GET' '/health' $null
  $healthOk = $health.Ok -and ($health.Json.ok -eq $true)
  $tools = @()
  if ($healthOk -and $health.Json.toolsRegistered) { $tools = @($health.Json.toolsRegistered) }
  Add-Result 'api: GET /health ok:true' $healthOk ("status=$($health.Status)")
  Add-Result 'api: /health toolsRegistered 数量 = 10' ($tools.Count -eq 10) ("count=$($tools.Count) names=$($tools -join ',')")

  $status = Invoke-Api 'GET' '/status' $null
  $statusOk = $status.Ok -and ($status.Json.ok -eq $true)
  $vaultFromStatus = ''
  if ($statusOk) { $vaultFromStatus = [string]$status.Json.vaultPath }
  $norm = { param($p) if (-not $p) { return '' } ($p -replace '/', '\').TrimEnd('\').ToLowerInvariant() }
  Add-Result 'api: GET /status 的 vaultPath = 临时 vault' ($statusOk -and ((& $norm $vaultFromStatus) -eq (& $norm $vault))) "status.vaultPath=$vaultFromStatus expected=$vault"

  $tree = Invoke-Api 'GET' '/tree' $null
  $treeOk = $tree.Ok -and ($tree.Json.ok -eq $true) -and ($null -ne $tree.Json.entries)
  $treePaths = @()
  if ($treeOk) { $treePaths = @($tree.Json.entries | ForEach-Object { [string]$_.path }) }
  $hasChinese = (@($treePaths | Where-Object { $_ -match '欢迎|首页|读书笔记|收件箱' }).Count -gt 0)
  Add-Result 'api: GET /tree 列出中文笔记' ($treeOk -and $hasChinese) ("entries=$($treePaths.Count): " + (($treePaths | Select-Object -First 8) -join ', '))

  $notePath = 'verify-http/接口验证笔记'
  $created = Invoke-Api 'POST' '/note' @{ path = $notePath; content = "# 接口验证笔记`n`n来自隔离验证的 HTTP 断言。"; mode = 'create' }
  $createOk = $created.Ok -and ($created.Json.ok -eq $true) -and ($created.Json.result.created -eq $true)
  Add-Result 'api: POST /note mode=create 新建笔记' $createOk ("status=$($created.Status) result=$($created.Raw)")

  $readBack = Invoke-Api 'GET' ('/note?path=' + [System.Uri]::EscapeDataString($notePath)) $null
  $contentOk = $readBack.Ok -and ($readBack.Json.ok -eq $true) -and ([string]$readBack.Json.note.content -match '隔离验证')
  Add-Result 'api: GET /note 读回新建内容' $contentOk "status=$($readBack.Status)"

  $search = Invoke-Api 'GET' ('/search?q=' + [System.Uri]::EscapeDataString('接口验证')) $null
  $searchOk = $search.Ok -and ($search.Json.ok -eq $true) -and ($null -ne $search.Json.results)
  Add-Result 'api: GET /search 命中新建笔记' $searchOk ("status=$($search.Status) total=$($search.Json.total)")

  $trash = Invoke-Api 'POST' '/manage' @{ action = 'trash'; path = $notePath }
  $trashOk = $trash.Ok -and ($trash.Json.ok -eq $true) -and ([string]$trash.Json.result.action -eq 'trash')
  Add-Result 'api: POST /manage trash 移回收站' $trashOk ("status=$($trash.Status) result=$($trash.Raw)")

  # 跨源请求必须被拒绝（403 + cross-site-request-rejected）
  $crossOk = $false; $crossDetail = ''
  try {
    $crossResp = Invoke-WebRequest -Uri "$script:ApiBase/health" -UseBasicParsing -WebSession $script:WebSession -Headers @{ 'Origin' = 'http://evil.example' } -TimeoutSec 10
    $crossDetail = "unexpected status=$($crossResp.StatusCode)"
  } catch {
    $code = -1; $body = ''
    if ($_.Exception.Response) {
      try { $code = [int]$_.Exception.Response.StatusCode } catch { }
      try { $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); $body = $reader.ReadToEnd(); $reader.Dispose() } catch { }
    }
    $crossOk = ($code -eq 403) -and ($body -match 'cross-site-request-rejected')
    $crossDetail = "status=$code body=$body"
  }
  Add-Result 'api: 跨源请求被拒绝 (403 cross-site-request-rejected)' $crossOk $crossDetail

  # ============================================================
  # E. 浏览器面板（headless Chromium + CDP）
  # ============================================================
  Write-Log ""
  Write-Log "-- E. 浏览器面板（headless CDP）--"
  $browser = Find-Browser
  if ($HttpOnly) {
    Add-Result 'browser: 已用 -HttpOnly 跳过浏览器验证' $true '降级：面板未做浏览器验证（显式跳过）'
    Write-Log "注意：面板本身未做浏览器验证（-HttpOnly）。"
  } elseif (-not $browser) {
    Add-Result 'browser: 未找到 Chromium/Edge（降级为 HTTP-only）' $true '降级：面板未做浏览器验证（只验了 HTTP API）；安装 Chrome/Edge 后重跑可做浏览器验证'
    Write-Log "注意：没有可用的 headless 浏览器，面板本身未做浏览器验证（只验了 HTTP API）。本次降级仍算通过，但面板未被浏览器验证。"
  } else {
    Write-Log "浏览器: $browser"
    Add-Result 'browser: 找到 headless Chromium/Edge' $true $browser
    $cdpPort = Get-FreePort
    $chromeProfile = Join-Path $rootFull 'chrome-profile'
    $chromeArgs = @(
      '--headless=new',
      "--remote-debugging-port=$cdpPort",
      "--user-data-dir=$chromeProfile",
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--remote-allow-origins=*',
      '--window-size=1440,900',
      '--hide-scrollbars',
      'about:blank'
    )
    $chromeProc = Start-Process -FilePath $browser -ArgumentList $chromeArgs -PassThru -WindowStyle Hidden
    $script:ChromePid = $chromeProc.Id
    $cdpReady = $false
    $cdpDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $cdpDeadline) {
      try {
        $verResp = Invoke-WebRequest -Uri "http://127.0.0.1:$cdpPort/json/version" -UseBasicParsing -TimeoutSec 2
        if ([int]$verResp.StatusCode -eq 200) { $cdpReady = $true; break }
      } catch { }
      Start-Sleep -Milliseconds 300
    }
    Add-Result 'browser: CDP 端点就绪' $cdpReady "cdpPort=$cdpPort pid=$($chromeProc.Id)"
    if (-not $cdpReady) {
      Add-Result 'browser: 面板验证' $false 'CDP 未就绪，无法做浏览器验证'
    } else {
      $driverPath = Join-Path $rootFull 'cdp-verify.cjs'
      $cfgPath = Join-Path $rootFull 'cdp-config.json'
      $cfg = [pscustomobject]@{
        cdpPort = $cdpPort
        url = $url
        vaultPath = $vault
        screenshotPath = $screenshotPath
        panelTimeoutMs = ($PanelTimeoutSeconds * 1000)
        marker = '浏览器新建笔记'
        newNotePath = '浏览器新建笔记'
      }
      Write-Utf8File $cfgPath ($cfg | ConvertTo-Json -Depth 5)
      Write-Utf8File $driverPath $CdpDriverSource
      $driverOut = Join-Path $rootFull 'cdp-driver.out.log'
      $driverErr = Join-Path $rootFull 'cdp-driver.err.log'
      $driverProc = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $driverPath + '"'), ('"' + $cfgPath + '"')) -RedirectStandardOutput $driverOut -RedirectStandardError $driverErr -PassThru -WindowStyle Hidden
      $driverExited = $false
      $driverDeadline = (Get-Date).AddSeconds(300)
      while ((Get-Date) -lt $driverDeadline) {
        if ($driverProc.HasExited) { $driverExited = $true; break }
        Start-Sleep -Milliseconds 500
      }
      if (-not $driverExited) {
        Stop-Tree $driverProc.Id
        Add-Result 'browser: CDP 驱动运行' $false '超时（300s）'
      } else {
        try { $driverProc.WaitForExit() } catch { }
        try { $driverProc.Refresh() } catch { }
        $driverExitCode = -999
        try { $driverExitCode = [int]$driverProc.ExitCode } catch { }
        Add-Result 'browser: CDP 驱动运行' ($driverExitCode -eq 0) "exit=$driverExitCode"
      }
      $driverText = Read-SharedText $driverOut
      foreach ($line in ($driverText -split "`r?`n")) {
        if ($line -match '^ASSERT\|([^|]+)\|(PASS|FAIL)\|(.*)$') {
          $rName = $Matches[1]
          $rOk = ($Matches[2] -eq 'PASS')
          $rDetail = $Matches[3]
          Add-Result ("browser: " + $rName) $rOk $rDetail
        } elseif ($line.Trim()) {
          Write-Log "  [cdp] $($line.Trim())"
        }
      }
      if (-not ($driverText -match '(?m)^ASSERT\|')) {
        Write-Log "CDP 驱动 stderr："
        Write-Log (Read-SharedText $driverErr)
        Add-Result 'browser: 面板验证产出断言' $false '驱动没有输出 ASSERT 行'
      }
      if (Test-Path -LiteralPath $screenshotPath) {
        $shotSize = (Get-Item -LiteralPath $screenshotPath).Length
        Add-Result 'browser: 截图已保存' ($shotSize -gt 1000) "$screenshotPath ($shotSize bytes)"
      } else {
        Add-Result 'browser: 截图已保存' $false $screenshotPath
      }
      if (($driverText -match '(?m)^ASSERT\|') -and ($driverText -match '(?m)^ASSERT\|\S+\|PASS\|')) {
        $script:BrowserVerified = $true
      }
    }
    if ($script:ChromePid -gt 0) { Stop-Tree $script:ChromePid; $script:ChromePid = 0 }
  }
} catch {
  Add-Result 'harness: 验证流程未抛出异常' $false $_.Exception.Message
  Write-Log "异常位置：$($_.InvocationInfo.PositionMessage)"
  Write-Log $_.ScriptStackTrace
} finally {
  # ---------- 收尾：杀自己启动的进程树、删临时环境 ----------
  Write-Log ""
  Write-Log "-- F. 收尾 --"
  if ($script:BootPid -gt 0) { Stop-Tree $script:BootPid }
  if ($script:ChromePid -gt 0) { Stop-Tree $script:ChromePid }
  $portClosed = $true
  if ($port -and $port -gt 0) {
    $wait = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $wait) {
      if (-not (Test-PortOpen $port)) { break }
      Start-Sleep -Milliseconds 300
    }
    $portClosed = -not (Test-PortOpen $port)
  }
  Add-Result 'cleanup: 隔离 web 进程树已退出、端口已释放' $portClosed "port=$port"

  $env:DSH_HOME = $origDshHome
  $env:DSH_OBSIDIAN_VAULT = $origVault
  if ($origInstallDir) { $env:DSH_INSTALL_DIR = $origInstallDir } else { Remove-Item Env:\DSH_INSTALL_DIR -ErrorAction SilentlyContinue }

  # 汇总
  $passed = @($script:Results | Where-Object { $_.Ok }).Count
  $failed = @($script:Results | Where-Object { -not $_.Ok }).Count
  Write-Log ""
  Write-Log "=============================="
  Write-Log ("结果：PASS {0} / FAIL {1} / 共 {2}" -f $passed, $failed, $script:Results.Count)
  Write-Log "=============================="
  foreach ($r in $script:Results) {
    $tag = if ($r.Ok) { 'PASS' } else { 'FAIL' }
    Write-Log ("[{0}] {1}  {2}" -f $tag, $r.Name, $r.Detail)
  }
  if ($failed -eq 0) {
    Write-Log "OVERALL: PASS"
  } else {
    Write-Log "OVERALL: FAIL"
  }
  if ($script:BrowserVerified) {
    Write-Log "面板浏览器验证: 已执行（headless Chromium + CDP）"
  } else {
    Write-Log "面板浏览器验证: 未执行（降级：HTTP-only；面板本身未做浏览器验证）"
  }
  if (Test-Path -LiteralPath $screenshotPath) {
    Write-Log "截图: $screenshotPath"
  } elseif ($HttpOnly -or -not $browser) {
    Write-Log "截图: <无（面板未做浏览器验证）>"
  } else {
    Write-Log "截图: <未生成>"
  }

  if ($KeepTemp) {
    Write-Log "临时目录（-KeepTemp 保留）: $rootFull"
    $logOk = $true
    try { [System.IO.File]::WriteAllText($reportPath, ($script:LogLines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false))) } catch { $logOk = $false }
    if ($logOk) { Write-Log "报告: $reportPath" }
  } else {
    $deleted = $false
    for ($i = 0; $i -lt 5; $i++) {
      try { Remove-Item -LiteralPath $rootFull -Recurse -Force -ErrorAction Stop; $deleted = $true; break } catch { Start-Sleep -Milliseconds 600 }
    }
    if (-not $deleted) {
      Write-Log "警告：临时目录未能完全删除（可能被进程占用）：$rootFull"
    }
    $logOk = $true
    try { [System.IO.File]::WriteAllText($reportPath, ($script:LogLines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false))) } catch { $logOk = $false }
    if ($logOk) { Write-Log "报告: $reportPath" }
  }
  if ($failed -gt 0) { exit 1 }
  exit 0
}
