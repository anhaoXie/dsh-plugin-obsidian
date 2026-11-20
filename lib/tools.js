// dsh-plugin-obsidian — agent 工具定义（SPEC §4）。
//
// 10 个 `obsidian_*` 工具：结构化 execute() 返回对象，render() 转文本；
// 错误统一 `throw new Error(<中文说明> [code])` 保留 VaultError.code。
import { spawn } from 'node:child_process'
import { ERROR_CODES, VaultError } from './vault.js'

/** 10 个工具名（顺序即注册顺序）。 */
export const TOOL_NAMES = Object.freeze([
  'obsidian_status',
  'obsidian_list',
  'obsidian_read',
  'obsidian_search',
  'obsidian_write',
  'obsidian_manage',
  'obsidian_daily',
  'obsidian_tags',
  'obsidian_links',
  'obsidian_open',
])

const KNOWN_CODES = new Set(ERROR_CODES)
const RENDER_TEXT_LIMIT = 8000

function textResult(value) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (typeof text !== 'string') text = String(text)
  if (text.length > RENDER_TEXT_LIMIT) {
    text = `${text.slice(0, RENDER_TEXT_LIMIT - 120)}\n…（输出过长已截断；完整内容请用 obsidian 面板或减小 limit / maxBytes 参数。）`
  }
  return [{ type: 'text', text }]
}

/** 保留 VaultError.code 的中文工具错误。 */
function toToolError(error) {
  if (error instanceof VaultError) {
    const wrapped = new Error(`${error.message} [${error.code}]`)
    wrapped.code = error.code
    return wrapped
  }
  if (error && typeof error === 'object' && typeof error.code === 'string' && KNOWN_CODES.has(error.code)) {
    const wrapped = new Error(`${error.message ?? error.code} [${error.code}]`)
    wrapped.code = error.code
    return wrapped
  }
  if (error instanceof Error) return error
  return new Error(String(error))
}

function vaultUnavailableError() {
  const error = new Error(
    'Obsidian vault 未配置或不可用：请在插件配置中设置 vaultPath，或设置环境变量 DSH_OBSIDIAN_VAULT [vault-unavailable]',
  )
  error.code = 'vault-unavailable'
  return error
}

/**
 * 在 Obsidian 中打开一个笔记。返回 `{ path, uri, opened, hint? }`。
 * 拉起失败不抛错，返回 `opened:false` + `hint`；路径非法仍抛 VaultError（由调用方决定如何处理）。
 *
 * @param {{ normalizePath(path: string): string, name?: string, root?: string|null }} vault
 * @param {Record<string, any>} config
 * @param {string} rawPath
 */
export function openNoteInObsidian(vault, config, rawPath) {
  if (!vault || typeof vault.normalizePath !== 'function') throw vaultUnavailableError()
  const relPath = vault.normalizePath(rawPath)
  const vaultName = (vault && typeof vault.name === 'string' && vault.name) || 'Obsidian'
  const filePart = relPath.replace(/\.md$/i, '')
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePart)}`
  const cfg = config && typeof config === 'object' ? config : {}
  if (cfg.allowOpenInObsidian === false) {
    return {
      path: relPath,
      uri,
      opened: false,
      hint: '当前配置 allowOpenInObsidian=false，已禁用从 DSH 唤起 Obsidian；可复制 uri 手动打开。',
    }
  }
  try {
    if (typeof cfg.launcher === 'function') cfg.launcher(uri)
    else launchObsidianUri(uri)
    return { path: relPath, uri, opened: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { path: relPath, uri, opened: false, hint: `无法唤起 Obsidian：${message}。可复制 uri 手动打开。` }
  }
}

/** 平台相关 URI 唤起（失败由调用方捕获；子进程错误不冒泡）。 */
function launchObsidianUri(uri) {
  let child
  if (process.platform === 'win32') {
    // 用 windowsVerbatimArguments 自行控制引号：URI 里的 `&` 在 cmd 中必须被引号包住。
    child = spawn('cmd.exe', ['/c', 'start', '""', `"${uri}"`], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    })
  } else {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
    child = spawn(command, [uri], { detached: true, stdio: 'ignore' })
  }
  child.on('error', () => {
    /* 拉起失败：工具返回 opened 仅代表已派发 */
  })
  child.unref()
}

/**
 * 创建 10 个 agent 工具。
 * @param {{ getVault: () => any, getConfig?: () => Record<string, any> }} options
 */
export function createTools(options = {}) {
  const getVaultFn = typeof options.getVault === 'function' ? options.getVault : () => null
  const getConfigFn = typeof options.getConfig === 'function' ? options.getConfig : () => ({})

  const getConfig = () => {
    try {
      return getConfigFn() || {}
    } catch {
      return {}
    }
  }
  const requireVault = () => {
    let vault
    try {
      vault = getVaultFn()
    } catch (error) {
      throw toToolError(error)
    }
    if (!vault) throw vaultUnavailableError()
    return vault
  }
  const getVaultOrNull = () => {
    try {
      return getVaultFn() || null
    } catch {
      return null
    }
  }

  /** 统一包装：取消检查 + 错误规范化。 */
  const makeExecute = (run) => async (args, exec) => {
    if (exec && exec.signal && exec.signal.aborted) throw new Error('调用已取消。')
    try {
      return await run(args && typeof args === 'object' ? args : {})
    } catch (error) {
      throw toToolError(error)
    }
  }

  /** 统一 output 描述。DSH 调用 `render(args, value)`，必须取第二个参数。 */
  const output = () => ({
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => textResult(value),
  })

  const tools = []

  tools.push({
    name: 'obsidian_status',
    description:
      '查看本机 Obsidian vault 的状态：路径、笔记数、目录数、总字节数、日记配置与 Obsidian 配置摘要。当需要确认 vault 是否可用、位于哪里、日记格式如何配置，或排查写入失败原因时使用。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: output(),
    execute: makeExecute(async () => {
      const vault = getVaultOrNull()
      if (!vault) {
        return {
          ok: true,
          available: false,
          vaultPath: null,
          name: '',
          noteCount: 0,
          folderCount: 0,
          totalBytes: 0,
          daily: { folder: '', format: 'YYYY-MM-DD', template: '' },
          obsidianConfig: { appJson: null, corePlugins: null, dailyNotes: null },
          error: { code: 'vault-unavailable', message: vaultUnavailableError().message },
        }
      }
      return vault.status()
    }),
  })

  tools.push({
    name: 'obsidian_list',
    description:
      '列出 Obsidian vault 中某个目录下的笔记与子目录（按层级展开）。当需要浏览仓库结构、找到某篇笔记的相对路径，或确认目录里有哪些笔记时使用。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '要列出的 vault 相对目录；留空表示 vault 根目录。' },
        depth: { type: 'integer', minimum: 1, maximum: 5, default: 2, description: '展开层数，1 表示只看当前目录的直接子项。' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200, description: '最多返回的条目数（上限 500）。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) =>
      requireVault().list({ dir: args.dir ?? '', depth: args.depth ?? 2, limit: args.limit ?? 200 }),
    ),
  })

  tools.push({
    name: 'obsidian_read',
    description:
      '读取一篇 Obsidian 笔记：标题、正文、frontmatter、标签、wikilink 与文件元数据。当需要查看笔记内容、在写作前获取上下文、或核对标签/链接时使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: '笔记的 vault 相对路径，例如「01-笔记/我的笔记.md」；省略 .md 会自动补上。' },
        maxBytes: { type: 'integer', minimum: 1, description: '正文读取字节上限；超过时 truncated=true 并截断。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) => requireVault().read({ path: args.path, maxBytes: args.maxBytes })),
  })

  tools.push({
    name: 'obsidian_search',
    description:
      '在 Obsidian vault 中按字面关键词搜索笔记（大小写不敏感），可限定标题/正文/标签模式与目录、标签过滤。当需要查找某个主题的笔记、定位写了某段文字的笔记、或找出带某个标签的笔记时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '搜索关键词（字面匹配，不是正则）。' },
        mode: { type: 'string', enum: ['all', 'title', 'content', 'tag'], default: 'all', description: '搜索范围：all=全部；title=标题；content=正文；tag=标签。' },
        dir: { type: 'string', description: '限定搜索的 vault 相对目录，留空表示全仓。' },
        tag: { type: 'string', description: '按标签过滤（不带 #），只返回含该标签的笔记。' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: '返回结果上限（上限 500）。' },
        context: { type: 'integer', minimum: 0, maximum: 1000, default: 60, description: '摘要片段命中的上下文长度（字符）。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) =>
      requireVault().search({
        query: args.query,
        mode: args.mode,
        dir: args.dir ?? '',
        tag: args.tag ?? '',
        limit: args.limit ?? 50,
        context: args.context ?? 60,
      }),
    ),
  })

  tools.push({
    name: 'obsidian_write',
    description:
      '写入 Obsidian 笔记：新建、整篇覆盖、在末尾追加或在开头插入；可合并 frontmatter 与设置标签。当需要「添加一篇笔记」「把一段内容追加到某篇笔记」「更新某篇笔记正文」时使用。默认 create 模式，已存在会报错，避免误覆盖。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: '笔记的 vault 相对路径；省略 .md 会自动补上。' },
        content: { type: 'string', description: '正文内容（不含 frontmatter；如需可传完整 Markdown，开头的 frontmatter 块会被识别）。' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'create', 'append', 'prepend'],
          default: 'create',
          description: '写入模式：create=仅新建；overwrite=整篇替换；append=追加到正文末尾；prepend=插入到正文开头。',
        },
        frontmatter: { description: '要合并进 frontmatter 的对象；值为 null 表示删除该键；传 null 表示删除整个 frontmatter。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'frontmatter 标签数组（不带 #）。' },
        backup: { type: 'boolean', default: true, description: '覆盖/追加前是否备份旧文件。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) =>
      requireVault().write({
        path: args.path,
        content: args.content ?? '',
        mode: args.mode ?? 'create',
        frontmatter: args.frontmatter,
        tags: args.tags,
        backup: args.backup ?? true,
      }),
    ),
  })

  tools.push({
    name: 'obsidian_manage',
    description:
      '管理 Obsidian 笔记：移动/重命名（move）或移入 vault 回收站（trash，hard=true 真删除）。当需要整理笔记位置、改名，或安全地删掉一篇笔记时使用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'trash'], description: 'move=移动/重命名；trash=移入回收站或真删除。' },
        from: { type: 'string', description: 'move 的源 vault 相对路径。' },
        to: { type: 'string', description: 'move 的目标 vault 相对路径。' },
        path: { type: 'string', description: 'trash 要处理的 vault 相对路径。' },
        overwrite: { type: 'boolean', default: false, description: 'move 时目标已存在是否覆盖。' },
        hard: { type: 'boolean', default: false, description: 'trash 时是否真删除（默认移到 .trash 回收站）。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) =>
      requireVault().manage({
        action: args.action,
        from: args.from,
        to: args.to,
        path: args.path,
        overwrite: args.overwrite,
        hard: args.hard,
      }),
    ),
  })

  tools.push({
    name: 'obsidian_daily',
    description:
      '读取或写入今天的 Obsidian 日记（自动使用 vault 的 daily-notes 目录与日期格式；缺失时按模板创建）。当需要「写今天的日记」「把一段内容追加到今日日记」「确认今天日记是否已存在」时使用。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '日期 YYYY-MM-DD；留空表示今天。' },
        mode: { type: 'string', enum: ['read', 'append', 'create'], default: 'read', description: 'read=只读；append=不存在则用模板创建后追加；create=只创建。' },
        content: { type: 'string', description: 'append 模式要追加的正文。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) => requireVault().daily({ date: args.date ?? '', mode: args.mode ?? 'read', content: args.content ?? '' })),
  })

  tools.push({
    name: 'obsidian_tags',
    description:
      '汇总 Obsidian vault 的全部标签：frontmatter tags/tag 与正文内联 #标签，按出现笔记数降序。当需要了解仓库标签体系、找热门标签，或确认某标签有哪些笔记时使用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list'], default: 'list', description: '目前只支持 list（列出全部标签）。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) => {
      if (args.action !== undefined && args.action !== 'list') {
        const error = new VaultError('invalid-path', `不支持的 tags action：${args.action}（目前只支持 list）。`)
        throw error
      }
      return requireVault().tags()
    }),
  })

  tools.push({
    name: 'obsidian_links',
    description:
      '查看一篇 Obsidian 笔记的 [[wikilink]]：出链、反向链接（backlinks）与未解析链接。当需要确认笔记之间的引用关系、找「谁引用了这篇笔记」，或清理死链时使用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: '笔记的 vault 相对路径（省略 .md 会自动补上）。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) => requireVault().links({ path: args.path })),
  })

  tools.push({
    name: 'obsidian_open',
    description:
      '在 Obsidian 客户端中打开指定笔记（通过 obsidian:// URI，由系统唤醒 Obsidian）。当用户希望「在 Obsidian 里看这篇笔记」时使用；DSH 内置面板无法渲染 Markdown 或需要 Obsidian 插件能力时也用它。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: '要在 Obsidian 中打开的笔记 vault 相对路径（省略 .md 会自动补上）。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: output(),
    execute: makeExecute(async (args) => {
      const vault = requireVault()
      return openNoteInObsidian(vault, getConfig(), args.path)
    }),
  })

  return tools
}
