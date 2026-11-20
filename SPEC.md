# dsh-plugin-obsidian — FROZEN INTERFACE SPEC (v1)

> Owner: Lead. Teammates: treat every signature/shape here as **frozen**. If something is
> impossible in the environment, report it to the Lead instead of silently changing a shape.

## 0. What we are building

一个真正的 DeepSeek Harness 插件包 `dsh-plugin-obsidian`，把本机 Obsidian 仓库接进 DSH：

1. **Agent 工具（host half）**：`obsidian_*` 工具注册进 DSH 工具表，agent 可以直接「添加 / 管理」笔记。
2. **HTTP API（host half）**：host web server 上的 `/dsh-obsidian/api/*`，供浏览器半区与外部脚本使用。
3. **浏览器面板（client half）**：DSH Web GUI 侧栏出现「Obsidian」，可浏览树、搜索、读、新建、追加、编辑保存、移回收站、今日日记、在 Obsidian 中打开。
4. **安装/卸载脚本**：往 DSH profile 里加一个 `link:` 依赖 + 一个 bundle 项，带备份、自校验、失败回滚。
5. **可重复验证**：离线测试 + 隔离实例真机验证（绝不碰真实 profile / 真实 vault 写操作）。

技术路线：**直接读写 Obsidian vault 目录下的 Markdown 文件**（vault 没有装社区插件，也不需要装）。
Obsidian 侧联动通过 `obsidian://` URI 打开笔记（Obsidian 会自己热更新外部改动）。

## 1. 环境事实（已探明，勿重新发明）

| 项 | 值 |
|---|---|
| OS / shell | Windows 10/11，PowerShell 5.1 与 pwsh 7 都要能跑安装脚本 |
| Node | `v24.21.0`（`resources\runtime\bin\node.cmd`） |
| DSH 安装 | `C:\Users\谢安豪\AppData\Local\Programs\DeepSeek Harness` |
| DSH CLI | `...\resources\runtime\cli\bin\dsh.cmd`（`dsh web --port 0 --no-open`、`dsh plugin --profile <name> add <path>`） |
| DSH runtime pnpm | `...\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`（用 `node <pnpm.mjs> install`） |
| DSH_HOME | `C:\Users\谢安豪\.dsh`（`profiles\desktop`、`profiles\web`） |
| 已装插件参考实现 | `<DSH_HOME>\profiles\desktop\node_modules\dsh-plugin-undermind\lib\index.js`（host 注册 tools + webServer 路由）、`dsh-skill-manager\lib\index.js|client.js`（最小完整双半区插件） |
| Obsidian 安装 | `C:\Users\谢安豪\AppData\Local\Programs\Obsidian\Obsidian.exe`（当前未运行） |
| Obsidian vault | `C:\Users\谢安豪\Documents\Obsidian Vault`（`%APPDATA%\obsidian\obsidian.json` 注册，`open:true`；**只有这一个**） |
| vault 结构 | `00-收件箱/`、`01-笔记/`、`02-资源/`、`03-归档/`、`日记/`、`模板/`、`欢迎.md`、`首页.md`；`.obsidian/` 下 `app.json`、`core-plugins.json` 等；**无社区插件、无 daily-notes.json** |
| 插件安装形态 | profile `package.json`：`dependencies` 加 `"dsh-plugin-obsidian": "link:<repo abs path>"`；`dsh.profile.bundles` 末尾加 `"dsh-plugin-obsidian"`；然后 `node <pnpm.mjs> install` |

### 1.1 DSH host 插件契约（实测自 undermind / skill-manager 源码）

```js
// host half entry: lib/index.js
export const name = 'dsh-plugin-obsidian'          // 必须等于 cordis.patch.yml 的 insert id 与包名
export const inject = ['webServer']                 // 顶层声明的服务
export function apply(ctx, config) { /* config 是行 config（普通对象） */ }
```

- 注册 agent 工具：`ctx.inject(['tools'], (toolCtx) => { const dispose = toolCtx.tools.register(def) })`
  `def = { name, description, parameters, output: { schema, render }, async execute(args, exec) }`；
  `render(_args, value)` 返回 `[{ type: 'text', text: '...' }]`；`exec.signal` 是 AbortSignal。
- 注册 HTTP 路由：`ctx.inject(['webServer'], (hostCtx) => { hostCtx.effect(() => hostCtx.webServer.register({ kind: 'exact'|'prefix', path, handler }), 'label') })`
  返回 disposer；`handler(req, res)` 是原生 Node IncomingMessage/ServerResponse。
- 资源释放：`ctx.effect(() => () => {...}, 'label')`；`ctx.inject` 回调里用该 ctx 的 `effect`。
- **不要 import 任何 `@deepseek-ai/*` 包**（本插件故意零依赖，避免解析/版本风险；不需要 Config schema）。

### 1.2 DSH 浏览器插件契约

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-obsidian',                 // 必须等于包名
  factory: (require) => {
    const react = require('react')           // 只保证 react / react/jsx-runtime
    const module = { exports: {} }
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' })
    function apply(ctx) { ... }              // ctx.effect / ctx.slots.inject / ctx.slots.register
    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  }
})
```

- 侧栏入口：
  ```js
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => 'Obsidian' }, PanelIcon));
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: PANEL_ID }, ObsidianPage);
  });
  ```
  参考：`dsh-plugin-zero-friction\lib\client.js` 第 1740-1763 行。
- **只准用 inject 里声明的服务**（Cordis 未声明 = undefined，会静默失效）。本插件只用 `slots`。
  `ctx.effect`、`ctx.slots.*` 是 ctx 自身方法，不算服务。
- 同源 `fetch('/dsh-obsidian/api/...')` 可直连 host 半区（同一 web server）。
- 面板所有交互元素必须带 `data-obsidian-*` 属性（自动化验证要用），见 §6。

## 2. 目录与写作用域（严格遵守，别碰别人文件）

```
dsh-plugin-obsidian/
  SPEC.md                 # Lead
  README.md               # Lead
  package.json            # TEAMMATE C (packaging)
  cordis.patch.yml        # TEAMMATE C
  install.ps1/.cmd        # TEAMMATE C
  uninstall.ps1/.cmd      # TEAMMATE C
  lib/
    vault.js              # TEAMMATE A (vault engine)
    tools.js              # TEAMMATE A (agent tools)
    api.js                # TEAMMATE A (HTTP routes)
    index.js              # TEAMMATE A (plugin entry, wires A's files only)
    client.js             # TEAMMATE B (browser panel)
  tools/
    test-vault.cjs        # TEAMMATE A
    test-tools.cjs        # TEAMMATE A
    test-api.cjs          # TEAMMATE A
    check-client.cjs      # TEAMMATE B
    harness-host.cjs      # Lead
    verify.cjs            # Lead (runs every test-*.cjs + check-client.cjs)
    verify-isolated.ps1   # TEAMMATE C (+ .cmd wrapper)
```

## 3. `lib/vault.js` —— 纯 Node vault 引擎（ESM，只用 node: 内置模块）

```js
export class VaultError extends Error { constructor(code, message) }  // code 见下
export function discoverVault(registryPath /* 可选，测试用 */) -> string|null
export function createVault(options) -> Vault
// options: { vaultPath, backupDir?, trashDir?, maxReadBytes?, maxSearchFiles?, ignoreDirs?, now? }
```

`VaultError.code` 取值（API 映射见 §5，工具输出照原样带 code）：
`invalid-path` | `outside-vault` | `not-found` | `exists` | `not-a-file` | `too-large` | `readonly-path` | `vault-unavailable`

### 3.1 路径安全（硬要求，测试要覆盖）

- 工具/API 只接受 **vault 相对路径**（`/` 或 `\` 均可）。绝对路径、盘符、`..` 段、以 `.` 开头的段（`.obsidian`、`.git`、`.trash`）、
  Windows 非法字符 `<>:"|?*`、控制字符 → `invalid-path`。
- 文件一律补 `.md` 后缀（已带则不重复补）。空路径 → `invalid-path`。
- 解析为绝对路径后必须仍在 vault 根内（`path.relative` 不以 `..` 开头、非绝对）；**若目标已存在**再用 `fs.realpathSync.native`
  校验真实路径仍在根内，防 symlink 逃逸。
- 规范化输出：始终返回 `relPath`（正斜杠、无前导 `/`）。

### 3.2 方法（全部同步实现；错误抛 VaultError）

```js
class Vault {
  constructor(options)                 // 不抛错；vault 不可用时方法抛 vault-unavailable
  get root()                           // 绝对路径（规范化的）
  status() -> {
    ok: true, vaultPath, name,              // name = 目录名
    noteCount, folderCount, totalBytes,
    daily: { folder, format, template },    // 自动从 .obsidian/daily-notes.json 探测，缺省 folder='' format='YYYY-MM-DD' template=''
    obsidianConfig: { appJson, corePlugins, dailyNotes },  // 原样对象或 null
  }
  list({ dir = '', depth = 2, limit = 500 } = {}) -> {
    dir, entries: [ { path, name, type: 'folder'|'note', size?, mtime?, title? } ],
    truncated: boolean,
  }
  read({ path, maxBytes } = {}) -> {
    path, title, frontmatter, frontmatterRaw, tags, links,
    content,                  // 去掉 frontmatter 的正文
    size, mtime, truncated,   // truncated: 超过 maxReadBytes 时 true 且 content 截断
  }
  write({ path, content = '', mode = 'overwrite', frontmatter, tags, createDirs = true, backup = true } = {}) -> {
    path, mode, created: boolean, bytes, backupPath: string|null,
  }
  search({ query, mode = 'all', dir = '', tag = '', limit = 50, context = 60 } = {}) -> {
    total, truncated, results: [
      { path, title, line, snippet, score, matched: 'title'|'content'|'tag'|'path' }
    ],
  }
  manage({ action, from, to, path, overwrite = false, hard = false }) -> object
  daily({ date = '', mode = 'read', content = '' } = {}) -> {
    path, date, created: boolean, content, appended: boolean, bytes,
  }
  tags() -> { tags: [ { tag, count, notes: [path...最多 20] } ], total }
  links({ path }) -> { path, outgoing: [target...], backlinks: [path...], unresolved: [target...] }
}
```

语义细节（必须按此实现）：

- **忽略目录**：`.obsidian`、`.trash`、`.git`、`node_modules`、`.dsh-obsidian`，以及 options.ignoreDirs。list/search/tags/links 都跳过。
- `write` 模式：
  - `create`：目标已存在 → `exists`；不覆盖。
  - `overwrite`：整文件替换（保留 frontmatter 由 `frontmatter`/`tags` 参数决定；传 `frontmatter: null` 表示显式删除 frontmatter）。
  - `append`：在正文末尾追加（保留原 frontmatter；若传 frontmatter/tags 则先在原 frontmatter 上合并）。
  - `prepend`：在 frontmatter 之后、正文之前插入。
  - `frontmatter` 是普通对象（键值合并进原 frontmatter，`null` 值表示删除该键）；`tags` 是字符串数组，写入 frontmatter 的 `tags`。
  - `createDirs=true` 自动建目录；`backup=true` 且目标已存在时，先把旧内容复制到
    `<backupDir>/<YYYYMMDD-HHmmss-SSS>/<relPath>`（backupDir 默认 `<DSH_HOME>/obsidian-backups`），返回 `backupPath`。
  - 原子写：同目录临时文件 + `renameSync`；UTF-8，**无 BOM**；换行统一 LF。
- `manage`：
  - `move`：`from`→`to`（自动建父目录；`to` 已存在且 `overwrite=false` → `exists`），返回 `{ action:'move', from, to }`
  - `trash`：移动到 `<vault>/.trash/<YYYYMMDD-HHmmss>-<basename>`（`hard:true` 才真删），返回 `{ action:'trash', path, trashPath, hard }`
- `search`：`query` 是**字面**（非正则）；大小写不敏感；`mode`：`all|title|content|tag`；`tag` 参数按标签过滤（不带 `#`）；
  标题命中 score 100、标签 60、正文 40、路径 30；`line` 为 1 基行号；`snippet` 单行、去多余空白、首尾加省略号；`limit` 上限 500。
- `daily`：路径 = `<folder>/<formatDate(date||today)>`；`mode: 'read'` 只读（不存在则 `created:false, content:''`，不建文件）；
  `'append'` 不存在时用模板（若 daily.template 存在，替换 `{{date}}`；`{{time}}` 替换 HH:mm；`{{title}}` 替换文件名）创建，再追加 content；
  `'create'` 只创建（已存在则 created:false 不报错）。日期格式支持 `YYYY MM M DD D YY ddd`（本地时间）。
- `tags()`：frontmatter `tags`/`tag`（数组或逗号/空格分隔字符串）+ 正文内联 `#tag`（跳代码围栏）；标签规范化去 `#`，保留大小写；
  按 `count` 降序、tag 升序；`count` 为出现笔记数。
- `links()`：`[[target]]`、`[[target|alias]]`、`[[target#heading]]`、`![[embed]]` 提取 target（去 `#` 后段）；backlinks 全 vault 扫描
  （上限 `maxSearchFiles`，默认 5000 篇；超过则结果带 `truncated: true`）。未解析 target（vault 里找不到对应笔记名/路径）进 `unresolved`。
- 标题：首个 `# ` 标题，否则文件名去 `.md`。
- frontmatter 解析：支持标量、引号字符串、`[a, b]` 内联数组、`- item` 块数组、`|`/`>` 块文本；保留原始文本 `frontmatterRaw`。
  **嵌套映射不解析**（保留原始，写回时若被修改则按标量覆盖——README 里要写这条限制）。
- 所有文本读写禁用 BOM；读到的 BOM 自动剥掉。

## 4. `lib/tools.js` —— agent 工具定义

```js
export const TOOL_NAMES = [...10 个名字...]
export function createTools({ getVault, getConfig }) -> Array<ToolDef>
```

每个 ToolDef：`{ name, description, parameters, output: { schema, render }, async execute(args, exec) }`。
- `description` 用中文，写清「什么时候用」；`parameters` 用 JSON Schema（object/properties/required/additionalProperties:false）。
- `execute` 返回**结构化对象**（不是字符串）；`render(_args, value)` → `[{type:'text', text}]`，用 `JSON.stringify(value, null, 2)`
  或短文本摘要（≤ 2000 字符标题行 + JSON）。错误统一 `throw new Error(<中文说明> [code])`，保留 code。
- `exec.signal?.aborted` 时抛 `new Error('调用已取消。')`。
- `getVault()` 每次调用重新取（配置可在运行中改）；vault 不可用时抛错并提示设置 vaultPath。

10 个工具（名字不可改）：

| name | parameters（要点） | 返回 |
|---|---|---|
| `obsidian_status` | 无 | `status()` |
| `obsidian_list` | `dir?`,`depth?`(1-5,默认2),`limit?`(1-500,默认200) | `list()` |
| `obsidian_read` | `path` 必填,`maxBytes?` | `read()` |
| `obsidian_search` | `query` 必填,`mode?`(all/title/content/tag),`dir?`,`tag?`,`limit?`,`context?` | `search()` |
| `obsidian_write` | `path` 必填,`content?`,`mode?`(overwrite/create/append/prepend,默认 create),`frontmatter?`(object),`tags?`(string[]),`backup?` | `write()` |
| `obsidian_manage` | `action` 必填(move/trash),`from?`,`to?`,`path?`,`overwrite?`,`hard?` | `manage()` |
| `obsidian_daily` | `date?`(YYYY-MM-DD),`mode?`(read/append/create,默认 read),`content?` | `daily()` |
| `obsidian_tags` | `action?`(list,默认 list) | `tags()` |
| `obsidian_links` | `path` 必填 | `links()` |
| `obsidian_open` | `path` 必填 | `{ path, uri, opened: boolean, hint?: string }` |

`obsidian_open`：`uri = obsidian://open?vault=<encodeURIComponent(vaultName)>&file=<encodeURIComponent(relPathWithoutExt)>`；
仅当 `getConfig().allowOpenInObsidian !== false` 时真正拉起（Windows：`spawn('cmd.exe', ['/c','start','""',uri], {windowsHide:true, detached:true}).unref()`），
失败不抛错，返回 `opened:false` + `hint`。

## 5. `lib/api.js` —— HTTP 路由

```js
export function createApi(ctx, { getVault, getConfig }) -> { handle(req, res): Promise<void>, dispose(): void }
```
`index.js` 用一次 `webServer.register({ kind: 'prefix', path: '/dsh-obsidian/api', handler })` 注册（前缀路由）。
路由内部再分发。**必须**：
- 同源校验（照抄 `dsh-skill-manager\lib\index.js` 的 `isSameOriginRequest` 逻辑：`sec-fetch-site==='cross-site'` 或 Origin host≠Host → 403 `{ok:false,error:{code:'cross-site-request-rejected'}}`）。
- JSON 响应统一 `{ ok: true, ...payload }` / `{ ok: false, error: { code, message } }`。
- 请求体 JSON 解析上限 1 MiB；`content-type` 不校验但解析失败 → 400 `bad-request`。
- 方法不符 → 405 `method-not-allowed`；未知路由 → 404 `not-found`。
- VaultError code→HTTP：`invalid-path`/`outside-vault`/`too-large` 400，`not-found` 404，`exists` 409，`vault-unavailable` 503，其余 500。

| 方法/路径 | 请求 | 响应 |
|---|---|---|
| `GET /dsh-obsidian/api/health` | — | `{ok:true, vaultPath, toolsRegistered:[...names], version}` |
| `GET .../status` | — | `status()` |
| `GET .../tree?dir=&depth=&limit=` | query | `list()` |
| `GET .../note?path=&maxBytes=` | query | `{ok:true, note:<read()>}` |
| `POST .../note` | `{path,content,mode,frontmatter,tags,backup}` | `{ok:true, result:<write()>}` |
| `GET .../search?q=&mode=&dir=&tag=&limit=&context=` | query | `search()` |
| `POST .../manage` | `{action,from,to,path,overwrite,hard}` | `{ok:true, result:<manage()>}` |
| `GET .../daily?date=` | query | `{ok:true, daily:<daily read>}` |
| `POST .../daily` | `{date,content,mode}` | `{ok:true, daily:<daily()>}` |
| `GET .../tags` | — | `tags()` |
| `GET .../links?path=` | query | `links()` |
| `POST .../open` | `{path}` | `{ok:true, result:<obsidian_open 的结构>}` |

`health.toolsRegistered` 由 `index.js` 在 `ctx.inject(['tools'])` 回调成功后写入注入的 state（`{ toolsRegistered: [] }`），api 每次读取。

## 6. `lib/client.js` —— 浏览器面板（DSH Web GUI）

`window.__ModuleLoader__.load({ id: 'dsh-plugin-obsidian', factory })`，`exports.inject = ['slots']`。

侧栏入口 `sidebar.panellist`（id/key = `'dsh-obsidian'`，label `'Obsidian'`，order 6，图标用内联 SVG/emoji），
主面板 `main`。面板 UI（中文，浅色/深色都用 `var(--dsw-alias-*)` 变量，参考 skill-manager 的 `s` 样式表）：

- 顶栏：标题「Obsidian」+ vault 路径/笔记数 + 「刷新」按钮 + 「今日日记」按钮 + 「新建笔记」按钮。
- 左列：搜索框（本地过滤 + 服务器搜索二选一：先本地过滤树，回车/输入 2 字符以上用 `/search`）；目录树（可折叠，`data-obsidian-tree`）。
- 右列：笔记内容（`data-obsidian-note`）显示标题、路径、标签、正文（`<pre>` 保留空白，不做 markdown 渲染——限制写进 README）；
  按钮：「编辑」→ textarea + 保存（POST /note mode overwrite）、「追加」（追加一段文字到末尾）、
  「在 Obsidian 中打开」（POST /open）、「移回收站」（POST /manage trash，需二次确认）。
- 「新建笔记」表单：路径（含目录）、标题（可选，自动 `# 标题`）、内容、标签（逗号分隔）。POST /note mode create。
- 一切网络失败 → 显示可读错误 + 「重试」，**永不白屏、永不抛未捕获异常**。
- 必须带的数据属性（自动化验证用）：
  `data-obsidian-panel="root"`、`data-obsidian-state="loading|ready|error"`、`data-obsidian-vault`、
  `data-obsidian-tree`、`data-obsidian-note-path`、`data-obsidian-action="refresh|new|daily|save|append|open|trash|edit"`、
  `data-obsidian-note-item`、`data-obsidian-search`、`data-obsidian-error`。
- 组件拆分：`ObsidianPage`（主）、`PanelIcon`、`NewNoteForm`、`NoteViewer`、`NoteEditor`、`Tree`。
- 状态管理：`useState`/`useEffect`/`useCallback`/`useRef`（只 require `react`）。**不要**用 `useSyncExternalStore` 等宿主可能没有的 API。
- 写入成功后自动刷新当前笔记与树；错误显示在面板内。

## 7. 打包与安装（TEAMMATE C）

`package.json`（不可有运行时依赖）：
```json
{
  "name": "dsh-plugin-obsidian",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Obsidian vault integration for DeepSeek Harness: agent tools, HTTP API and a browser panel to add and manage notes.",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["@deepseek-ai/dsh-client-ui-slots"], "platform": "web" }
  },
  "license": "MIT"
}
```
`cordis.patch.yml`：`- insert:` 一行 `id: dsh-plugin-obsidian`、`name: dsh-plugin-obsidian`（行 id、包名、模块 id 三者一致）。

`install.ps1` 要求（照抄 zero-friction 的教训，**必须全部实现**）：
1. `-ProfileDir` 默认 `$env:USERPROFILE\.dsh\profiles\desktop`；`-DshHome` 可覆盖。
2. 先备份 `package.json` / `cordis.patch.yml` 到 `<ProfileDir>\.install-backup\<ts>\`。
3. 修改 profile `package.json`：`dependencies["dsh-plugin-obsidian"] = "link:<repo>"`，`dsh.profile.bundles` 追加（去重置尾）。
4. 写 JSON 用 `[IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))`（**无 BOM**，5.1 兼容）；
   写完读回自校验：无 BOM + `ConvertFrom-Json` 成功 + 两项都在；失败用备份回滚并退出非 0。
5. 用 `node <runtime pnpm.mjs> install`（自动探测 DSH 安装路径：`-DshHome` → 默认路径 → 注册表/常见路径），超时 300s，
   失败也回滚（或至少报错并保留备份）。
6. `-WhatIf`/`-Check` 模式：只打印将要做的事，不写任何文件（隔离验证会用到）。
7. 幂等：重复执行不产生重复项。
8. `.cmd` 包装器：**只写 ASCII**（cmd.exe 按 OEM 代码页读），优先 `pwsh`，回退 `powershell`。
9. `.ps1` 文件本身带 UTF-8 BOM（5.1 读无 BOM 中文会解析错），内部字符串中文没问题。
10. 结束打印唯一一条「下一步」：先刷新 GUI（Ctrl+R），不行就重启 DeepSeek Harness。

`uninstall.ps1`：移除依赖项 + bundles 项（保留备份），可选 `-RemoveNodeModules`。

`tools/verify-isolated.ps1`：**只用临时 DSH_HOME，绝不碰真实 `~/.dsh`**：
1. `$root = Join-Path $env:TEMP ("dsh-obsidian-verify-" + timestamp)`；`$env:DSH_HOME = "$root\home"`。
2. `dsh plugin --profile web add <repo>`（官方 CLI 路径，验证「可被官方 CLI 安装」；失败则退回 `install.ps1 -ProfileDir <临时 profile>` + pnpm）。
3. `dsh web --port <空闲端口> --no-open` 后台启动，从 stdout 抓 URL（含 token）；等待 `/` 可访问。
4. 用本机 Chromium（探测 `C:\Program Files\Google\Chrome\Application\chrome.exe`、Edge、
   `C:\Users\谢安豪\AppData\Local\Programs\...`）headless + CDP：打开 URL → 等 `[data-obsidian-panel="root"]` →
   断言 `data-obsidian-state="ready"` → 读 `data-obsidian-vault` → 点「新建笔记」流程（先在**临时 vault** 上，
   用 `--vault-path` 注入临时 vault；不要写真实 vault！）→ 断言新笔记出现在树/内容区 → 截图存 `verify-isolated-*.png`。
5. 通过页面 `fetch('/dsh-obsidian/api/health')` 断言 `toolsRegistered` 数量 === 10。
6. 收尾：kill 进程树（含子 node）、删临时 DSH_HOME；输出 PASS/FAIL 明细 + 日志路径。
7. 若 headless 浏览器不可用：退化为 HTTP 断言（health + tree + note CRUD 在临时 vault），明确报告「面板未做浏览器验证」。

**临时 vault 注入**：插件的 vault 路径来源优先级：row `config.vaultPath` > 环境变量 `DSH_OBSIDIAN_VAULT` > 自动发现。T1 必须实现这个优先级（隔离验证用环境变量）。

## 8. 验证纪律（全员必须遵守）

- 每条结论必须有**实际运行输出**支撑；没跑过的不要说能跑。
- 测试**只能写临时目录**（`os.tmpdir()` 下自建），不得写真实 vault、不得写 `~/.dsh`。
- 自测命令写进 `README` 的「开发」章节（Lead 汇总）。
- 交付前各自跑通自己的测试，把**完整命令 + 关键输出行**报回 Lead。
- 若发现 SPEC 有错/不可行：**先停下报告**，不要偷偷改契约。
