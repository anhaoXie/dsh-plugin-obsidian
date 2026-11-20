// dsh-plugin-obsidian — 纯 Node Obsidian vault 引擎（ESM，零外部依赖）。
//
// 设计要点（见 SPEC.md §3）：
// - 所有公开方法同步执行，错误统一抛 VaultError（带 code）。
// - 用户输入只能是 vault 相对路径；拒绝绝对路径 / 盘符 / `..` / 隐藏段 / Windows 非法字符，
//   解析后再用 path.relative + realpathSync.native 双重校验，防 symlink/junction 逃逸。
// - 写入：同目录临时文件 + renameSync 原子替换；UTF-8 无 BOM；换行统一 LF。
// - frontmatter：支持标量 / 引号字符串 / 内联数组 / 块数组 / 块文本；嵌套映射保留原始文本
//   （写回时未修改则原样写回，被修改则按标量覆盖）。
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 引擎可能抛出的错误码（SPEC §3）。 */
export const ERROR_CODES = Object.freeze([
  'invalid-path',
  'outside-vault',
  'not-found',
  'exists',
  'not-a-file',
  'too-large',
  'readonly-path',
  'vault-unavailable',
])

/** 固定忽略的目录名（另外所有以 `.` 开头的目录/文件也忽略）。 */
const DEFAULT_IGNORE_DIRS = ['.obsidian', '.trash', '.git', 'node_modules', '.dsh-obsidian']

/** 默认单次读取上限（字节）。 */
const DEFAULT_MAX_READ_BYTES = 1 * 1024 * 1024
/** 默认单文件硬上限（超过直接 too-large，不截断）。 */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
/** 默认 search/tags/links 扫描笔记数上限。 */
const DEFAULT_MAX_SEARCH_FILES = 5000
/** search limit 上限。 */
const MAX_SEARCH_LIMIT = 500

/** Windows 文件名非法字符（含控制字符）。 */
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/
/** Windows 保留设备名（带任意扩展名同样保留）。 */
const WINDOWS_RESERVED_NAMES = new Set(
  ['con', 'prn', 'aux', 'nul'].concat(
    Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
    Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
  ),
)

/** 嵌套映射的原始文本记录（非枚举 Map<key, rawText>，JSON 输出不可见）。 */
const NESTED_KEYS = Symbol.for('dsh-plugin-obsidian.nestedKeys')

/** vault 引擎错误。 */
export class VaultError extends Error {
  /**
   * @param {string} code 错误码，见 ERROR_CODES
   * @param {string} message 中文错误说明
   */
  constructor(code, message) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n')
}

function stripBomAndNormalize(text) {
  return normalizeNewlines(stripBom(String(text)))
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function positiveInt(value, fallback) {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function ensureTrailingNewline(text) {
  if (!text) return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

function baseNameWithoutExt(relPath) {
  return relPath.replace(/^.*\//, '').replace(/\.md$/i, '')
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) return cloneFrontmatter(value)
  return value
}

function cloneFrontmatter(data) {
  const out = {}
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) continue
    out[key] = cloneValue(data[key])
  }
  const nested = data[NESTED_KEYS]
  if (nested instanceof Map && nested.size > 0) {
    Object.defineProperty(out, NESTED_KEYS, { value: new Map(nested), enumerable: false })
  }
  return out
}

function unmarkNested(data, key) {
  const nested = data[NESTED_KEYS]
  if (nested instanceof Map) nested.delete(key)
}

function markNested(data, key, rawText) {
  let nested = data[NESTED_KEYS]
  if (!(nested instanceof Map)) {
    nested = new Map()
    Object.defineProperty(data, NESTED_KEYS, { value: nested, enumerable: false })
  }
  nested.set(key, rawText)
}

/** 把 fs 层的已知错误翻译成 VaultError；未知错误原样抛出（API 会转 500）。 */
function mapFsError(error, relPath) {
  const code = error && typeof error === 'object' ? error.code : ''
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new VaultError('readonly-path', `路径不可写：${relPath}（${code}）`)
  }
  if (code === 'ENOENT') {
    return new VaultError('not-found', `路径不存在：${relPath}`)
  }
  if (code === 'EEXIST') {
    return new VaultError('exists', `目标已存在：${relPath}`)
  }
  if (code === 'ENOTDIR' || code === 'EISDIR') {
    return new VaultError('not-a-file', `目标不是文件：${relPath}`)
  }
  if (code === 'ENAMETOOLONG') {
    return new VaultError('invalid-path', `路径过长：${relPath}`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** 同步睡眠（用于 Windows 上 rename 的瞬时共享冲突重试）。 */
function syncSleep(ms) {
  try {
    const buffer = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(buffer), 0, 0, ms)
  } catch {
    /* Atomics 不可用时退化为忙等 */
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* busy wait */
    }
  }
}

/** Windows 上 rename 覆盖已存在文件时可能瞬时 EPERM/EACCES/EBUSY；做有限重试。 */
function renameWithRetry(fromAbs, toAbs, attempts = 12) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(fromAbs, toAbs)
      return
    } catch (error) {
      lastError = error
      const code = error && typeof error === 'object' ? error.code : ''
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
      syncSleep(Math.min(40, 4 + attempt * 3))
    }
  }
  throw lastError
}

// ── 路径安全 ──────────────────────────────────────────────────────────────

function invalidPath(raw, reason) {
  const shown = typeof raw === 'string' ? raw : String(raw)
  const trimmed = shown.length > 120 ? `${shown.slice(0, 120)}…` : shown
  return new VaultError('invalid-path', `无效的 vault 相对路径「${trimmed}」：${reason}`)
}

/**
 * 校验并规范化一个 vault 相对文件路径（补 `.md`）。
 * @param {string} raw 用户输入（`/` 或 `\` 分隔均可）
 * @returns {string} 正斜杠、无前导斜杠、带 `.md` 的规范化相对路径
 */
function normalizeRelativeFilePath(raw) {
  const segments = validateRelativeSegments(raw, 'invalid-path')
  const last = segments[segments.length - 1]
  if (!/\.md$/i.test(last)) segments[segments.length - 1] = `${last}.md`
  return segments.join('/')
}

/**
 * 校验并规范化一个 vault 相对目录路径（允许空字符串 = vault 根）。
 * @param {string} raw
 * @returns {string} 正斜杠、无前导/尾随斜杠的目录相对路径，根目录为 `''`
 */
function normalizeRelativeDirPath(raw) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw invalidPath(raw, '路径必须是字符串。')
  if (raw.trim() === '' || raw.trim() === '.' || raw.trim() === './') return ''
  return validateRelativeSegments(raw, 'invalid-path').join('/')
}

function validateRelativeSegments(raw, code) {
  if (typeof raw !== 'string') throw invalidPath(raw, '路径必须是字符串。')
  const input = raw.trim()
  if (!input) throw invalidPath(raw, '路径不能为空。')
  if (input.includes('\u0000')) throw invalidPath(raw, '路径包含 NUL 字符。')
  const parts = input.replace(/\\/g, '/')
  if (parts.startsWith('/')) throw invalidPath(raw, '不接受绝对路径。')
  if (/^[A-Za-z]:/.test(parts)) throw invalidPath(raw, '不接受盘符绝对路径。')
  if (/^\/\//.test(parts) || /^[A-Za-z]:\/\//.test(parts)) throw invalidPath(raw, '不接受 UNC 路径。')
  const segments = parts.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) throw invalidPath(raw, '路径不能为空。')
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw invalidPath(raw, '路径中不允许 . 或 .. 段。')
    if (segment.startsWith('.')) throw invalidPath(raw, `不允许访问隐藏路径段「${segment}」。`)
    if (WINDOWS_ILLEGAL_CHARS.test(segment)) {
      throw invalidPath(raw, `路径段「${segment}」包含 Windows 非法字符。`)
    }
    if (/[ .]$/.test(segment)) throw invalidPath(raw, `路径段「${segment}」不能以空格或点结尾。`)
    if (WINDOWS_RESERVED_NAMES.has(segment.replace(/\.[^.]*$/, '').toLowerCase())) {
      throw invalidPath(raw, `路径段「${segment}」是 Windows 保留设备名。`)
    }
    if (segment.length > 255) throw invalidPath(raw, `路径段「${segment}」过长。`)
  }
  return segments
}

// ── vault 自动发现 ────────────────────────────────────────────────────────

/** Obsidian 默认的 vault 注册表路径（按平台）。 */
function defaultRegistryPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'obsidian', 'obsidian.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json')
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'obsidian', 'obsidian.json')
}

/**
 * 从 Obsidian 注册表发现一个已存在 vault 的绝对路径。
 * 优先 `open: true` 的 vault，其次第一个可用的；任何异常都返回 null（绝不抛错）。
 * @param {string} [registryPath] 测试用：显式注册表路径
 * @returns {string|null}
 */
export function discoverVault(registryPath) {
  try {
    const path = registryPath || defaultRegistryPath()
    const data = JSON.parse(stripBom(readFileSync(path, 'utf8')))
    const vaults = data && typeof data.vaults === 'object' && data.vaults ? data.vaults : {}
    const candidates = Object.keys(vaults)
      .map((id) => vaults[id])
      .filter((entry) => entry && typeof entry.path === 'string' && entry.path !== '')
    const ordered = candidates.filter((entry) => entry.open === true).concat(candidates.filter((entry) => entry.open !== true))
    for (const entry of ordered) {
      const abs = resolve(entry.path)
      try {
        if (statSync(abs).isDirectory()) return abs
      } catch {
        /* 跳过不存在的 vault */
      }
    }
  } catch {
    /* 注册表缺失 / 损坏 → 视为未发现 */
  }
  return null
}

// ── frontmatter 解析 / 序列化 ─────────────────────────────────────────────

function indentOf(line) {
  const match = line.match(/^[ \t]*/)
  return match ? match[0].length : 0
}

function parseScalar(token) {
  const raw = String(token).trim()
  if (raw === '') return ''
  if (raw.length >= 2 && (raw.startsWith('"') && raw.endsWith('"'))) {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean' || parsed === null) {
        return parsed === null ? '' : parsed
      }
    } catch {
      /* 非标准 JSON 字符串：退回去引号 */
    }
    return raw.slice(1, -1).replace(/\\"/g, '"')
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (/^(true)$/i.test(raw)) return true
  if (/^(false)$/i.test(raw)) return false
  if (/^(null|~)$/i.test(raw)) return ''
  if (/^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw)
  if (/^-?\d+\.\d+$/.test(raw) && Number.isFinite(Number(raw))) return Number(raw)
  return raw
}

function splitTopLevel(text, separator = ',') {
  const parts = []
  let current = ''
  let depth = 0
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        current += text[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

/** 解析内联数组 `[a, b, "c"]`（允许嵌套方括号与引号）。 */
function parseInlineArray(text) {
  let source = String(text).trim()
  if (source.startsWith('[')) source = source.slice(1)
  const lastClose = source.lastIndexOf(']')
  if (lastClose >= 0) source = source.slice(0, lastClose)
  if (source.trim() === '') return []
  return splitTopLevel(source, ',')
    .map((part) => parseScalar(part))
    .filter((value) => value !== '')
}

/** 解析 `- item` 块数组（返回简单标量数组；复杂项保留为文本）。 */
function parseBlockArray(children, baseIndent) {
  const items = []
  let current = null
  const push = () => {
    if (current === null) return
    const text = current.join('\n')
    items.push(text.includes('\n') ? text : parseScalar(text))
    current = null
  }
  for (const line of children) {
    if (line.trim() === '') continue
    const indent = indentOf(line)
    const content = line.trim()
    if (indent === baseIndent && (content === '-' || content.startsWith('- '))) {
      push()
      current = [content === '-' ? '' : content.slice(2)]
      continue
    }
    if (current !== null) current.push(content)
  }
  push()
  return items
}

/** 解析 `|` / `>` 块文本（含 chomp 标记）。 */
function parseBlockScalar(collected, style, chomp) {
  const lines = collected.slice()
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  const hasContent = lines.some((line) => line.trim() !== '')
  if (!hasContent) return ''
  let minIndent = Infinity
  for (const line of lines) {
    if (line.trim() === '') continue
    minIndent = Math.min(minIndent, indentOf(line))
  }
  if (!Number.isFinite(minIndent)) minIndent = 0
  const stripped = lines.map((line) => (line.trim() === '' ? '' : line.slice(minIndent)))
  // 去掉尾部空行，按 chomp 决定是否补换行
  while (stripped.length > 0 && stripped[stripped.length - 1] === '') stripped.pop()
  let value
  if (style === '|') {
    value = stripped.join('\n')
  } else {
    let folded = ''
    let pendingBlank = 0
    for (const line of stripped) {
      if (line === '') {
        pendingBlank += 1
        continue
      }
      if (folded !== '') folded += pendingBlank > 0 ? '\n'.repeat(pendingBlank) : ' '
      pendingBlank = 0
      folded += line.trim()
    }
    value = folded
  }
  if (chomp === '-') return value
  return value === '' ? '' : `${value}\n`
}

/**
 * 解析 frontmatter。返回 `{ data, raw, body }`：
 * - `data`：解析后的键值对象；嵌套映射以原始文本字符串保存（非枚举标记，JSON 不展开）。
 * - `raw`：`---` 之间的原始文本（无分隔行）。
 * - `body`：去掉 frontmatter 的正文。
 * @param {string} text
 */
export function parseFrontmatter(text) {
  const source = stripBomAndNormalize(text)
  const lines = source.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, raw: '', body: source, hasFrontmatter: false }
  }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed === '---' || trimmed === '...') {
      end = i
      break
    }
  }
  if (end < 0) return { data: {}, raw: '', body: source, hasFrontmatter: false }
  const raw = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n')
  return { data: parseFrontmatterLines(lines.slice(1, end)), raw, body, hasFrontmatter: true }
}

function parseFrontmatterLines(lines) {
  const data = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) {
      i += 1
      continue
    }
    const match = line.match(/^([^\s:#][^:]*?):(?:[ \t]+(.*))?$/)
    if (!match) {
      i += 1
      continue
    }
    const key = match[1].trim()
    const rest = (match[2] ?? '').trim()
    if (!key) {
      i += 1
      continue
    }

    // 块文本 `|` / `>`（可带 +/- chomp）
    if (/^[|>][+-]?$/.test(rest)) {
      const style = rest[0]
      const chomp = rest.length > 1 ? rest[1] : ''
      const collected = []
      i += 1
      while (i < lines.length) {
        const child = lines[i]
        if (child.trim() === '') {
          collected.push('')
          i += 1
          continue
        }
        if (/^[ \t]/.test(child)) {
          collected.push(child)
          i += 1
          continue
        }
        break
      }
      data[key] = parseBlockScalar(collected, style, chomp)
      continue
    }

    // 内联数组
    if (rest.startsWith('[')) {
      data[key] = parseInlineArray(rest)
      i += 1
      continue
    }

    // `key:` 无值 → 子块 / 空值
    if (rest === '') {
      const children = []
      let j = i + 1
      while (j < lines.length) {
        const child = lines[j]
        if (child.trim() === '') {
          children.push('')
          j += 1
          continue
        }
        if (/^[ \t]/.test(child)) {
          children.push(child)
          j += 1
          continue
        }
        break
      }
      while (children.length > 0 && children[children.length - 1].trim() === '') children.pop()
      if (children.length === 0) {
        data[key] = ''
        i = j
        continue
      }
      const first = children.find((child) => child.trim() !== '')
      const baseIndent = indentOf(first)
      const firstContent = first.trim()
      if (firstContent === '-' || firstContent.startsWith('- ')) {
        data[key] = parseBlockArray(children, baseIndent)
        i = j
        continue
      }
      if (/^[^\s:#][^:]*?:/.test(firstContent)) {
        // 嵌套映射：保留原始文本（SPEC 限制：不解析，写回未修改则原样输出）
        const rawText = children.join('\n')
        data[key] = rawText
        markNested(data, key, rawText)
        i = j
        continue
      }
      data[key] = children.map((child) => child.trim()).join(' ').trim()
      i = j
      continue
    }

    data[key] = parseScalar(rest)
    i += 1
  }
  return data
}

function needsQuote(text) {
  if (text === '') return true
  if (/[\u0000-\u001f\u007f]/.test(text)) return true
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true
  if (/\s$/.test(text)) return true
  if (/:\s/.test(text) || /:$/.test(text)) return true
  if (/\s#/.test(text)) return true
  if (/[,[\]{}]/.test(text)) return true
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(text)) return true
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return true
  return false
}

function formatScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value)
  return needsQuote(text) ? JSON.stringify(text) : text
}

function serializeKeyValue(key, value, indent) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`]
    const flat = value.every((item) => item === null || item === undefined || typeof item !== 'object')
    const multiline = value.some((item) => typeof item === 'string' && item.includes('\n'))
    if (flat && !multiline) {
      return [`${pad}${key}: [${value.map((item) => formatScalar(item)).join(', ')}]`]
    }
    const lines = [`${pad}${key}:`]
    for (const item of value) {
      if (isPlainObject(item)) {
        const child = serializeKeyValue('x', item, indent + 4)
        lines.push(`${pad}  - ${child[0].slice(indent + 6)}`)
        lines.push(...child.slice(1))
      } else {
        lines.push(`${pad}  - ${formatScalar(item)}`)
      }
    }
    return lines
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value).filter((childKey) => value[childKey] !== undefined)
    if (entries.length === 0) return [`${pad}${key}: {}`]
    const lines = [`${pad}${key}:`]
    for (const childKey of entries) lines.push(...serializeKeyValue(childKey, value[childKey], indent + 2))
    return lines
  }
  if (typeof value === 'string' && value.includes('\n')) {
    const chomp = value.endsWith('\n') ? '' : '-'
    const body = value.endsWith('\n') ? value.slice(0, -1) : value
    const lines = [`${pad}${key}: |${chomp}`]
    for (const line of body.split('\n')) lines.push(`${pad}  ${line}`)
    return lines
  }
  return [`${pad}${key}: ${formatScalar(value)}`]
}

/**
 * 序列化 frontmatter 对象为 `---\n...\n---\n`；空对象返回 `''`。
 * 未修改的嵌套映射按保存的原始文本输出；被修改的键按标量/数组/嵌套块重新序列化。
 * @param {Record<string, unknown>} data
 */
export function serializeFrontmatter(data) {
  if (!isPlainObject(data)) return ''
  const keys = Object.keys(data).filter((key) => data[key] !== undefined)
  if (keys.length === 0) return ''
  const nested = data[NESTED_KEYS] instanceof Map ? data[NESTED_KEYS] : new Map()
  const lines = ['---']
  for (const key of keys) {
    const value = data[key]
    if (nested.has(key) && nested.get(key) === value) {
      lines.push(`${key}:`)
      lines.push(value)
      continue
    }
    lines.push(...serializeKeyValue(key, value, 0))
  }
  lines.push('---')
  return `${lines.join('\n')}\n`
}

// ── 正文辅助：标题 / 标签 / wikilink ──────────────────────────────────────

/** 首个 `# ` 一级标题，否则 null。 */
export function extractTitle(body) {
  const match = String(body).match(/^#[ \t]+(.+?)[ \t]*$/m)
  return match ? match[1].trim() : null
}

/**
 * 笔记标题解析优先级（Lead 决策，覆盖 SPEC §3 的 heading-first 旧规则）：
 * `frontmatter.title`（非空字符串）> 首个 `# ` 标题 > 文件名去掉 `.md`。
 * 非字符串 title（数字/布尔/数组等）视为未提供。
 */
export function resolveNoteTitle(frontmatter, body, relPath) {
  if (frontmatter && typeof frontmatter.title === 'string') {
    const value = frontmatter.title.replace(/\s+/g, ' ').trim()
    if (value !== '') return value
  }
  return extractTitle(body) || baseNameWithoutExt(relPath)
}

/** 提取正文内联 `#tag`（跳过代码围栏与行内代码）。 */
export function extractInlineTags(body) {
  const out = []
  let fence = ''
  for (const line of String(body).split('\n')) {
    const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = marker[0].repeat(3)
      else if (marker[0] === fence[0] && marker.length >= 3) fence = ''
      continue
    }
    if (fence) continue
    const cleaned = line.replace(/`[^`]*`/g, ' ')
    const regex = /(^|[\s([{>"'、，。；：])#([^\s#`'"()\[\]{}<>、，。；：!?！？]+)/gu
    let match
    while ((match = regex.exec(cleaned)) !== null) {
      let tag = match[2]
      tag = tag.replace(/[.,;:!?)\]}>]+$/, '')
      if (!tag) continue
      if (/^\d+$/.test(tag)) continue
      if (!/[\p{L}\p{N}_/-]/u.test(tag)) continue
      out.push(tag)
    }
  }
  return out
}

/** frontmatter 中 `tags` / `tag` 字段展开为字符串数组（去 `#`）。 */
export function frontmatterTags(data) {
  const out = []
  for (const key of ['tags', 'tag']) {
    const value = data ? data[key] : undefined
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) out.push(String(item))
    } else if (typeof value === 'string') {
      out.push(...value.split(/[,\s]+/))
    } else {
      out.push(String(value))
    }
  }
  return out.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean)
}

/** 归一化标签数组：去 `#`、去空白、去重（大小写不敏感，保留首次大小写）。 */
export function normalizeTags(tags) {
  const seen = new Set()
  const out = []
  for (const raw of tags) {
    const tag = String(raw).trim().replace(/^#+/, '').trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** 提取 wikilink 目标（去掉 alias 与 #heading 段），保序去重。 */
export function extractWikilinks(text) {
  const out = []
  const seen = new Set()
  const regex = /!?\[\[([^[\]\n]*?)\]\]/g
  let match
  while ((match = regex.exec(String(text))) !== null) {
    const inner = match[1]
    let target = inner.split('|')[0]
    target = target.split('#')[0].trim()
    if (!target) continue
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(target)
  }
  return out
}

// ── 日期格式化（daily 用） ───────────────────────────────────────────────

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * 支持的日期 token：`YYYY` `YY` `MM` `M` `DD` `D` `ddd` `dddd`；`[literal]` 原样输出。
 * @param {Date} date 本地时间
 * @param {string} format
 */
export function formatDate(date, format) {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const weekday = date.getDay()
  const pattern = String(format || 'YYYY-MM-DD')
  return pattern.replace(/\[([^\]]*)\]|dddd|ddd|YYYY|YY|MM|DD|M|D/g, (token, literal) => {
    if (literal !== undefined) return literal
    switch (token) {
      case 'YYYY':
        return String(year)
      case 'YY':
        return pad2(year % 100)
      case 'MM':
        return pad2(month)
      case 'M':
        return String(month)
      case 'DD':
        return pad2(day)
      case 'D':
        return String(day)
      case 'ddd':
        return WEEKDAY_SHORT[weekday]
      case 'dddd':
        return WEEKDAY_LONG[weekday]
      default:
        return token
    }
  })
}

function compactStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function stampWithMs(date) {
  return `${compactStamp(date)}-${String(date.getMilliseconds()).padStart(3, '0')}`
}

function parseDateArg(value, now) {
  if (value === undefined || value === null || value === '') return new Date(now.getTime())
  if (typeof value !== 'string') throw invalidPath(value, 'date 必须是 YYYY-MM-DD 字符串。')
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) throw invalidPath(value, 'date 必须形如 YYYY-MM-DD。')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw invalidPath(value, 'date 不是合法日期。')
  }
  return date
}

// ── 引擎 ─────────────────────────────────────────────────────────────────

/**
 * Vault 引擎。构造绝不抛错；vault 不可用时各方法抛 `vault-unavailable`。
 *
 * options: `{ vaultPath?, backupDir?, trashDir?, maxReadBytes?, maxFileBytes?,
 *             maxSearchFiles?, ignoreDirs?, now? }`
 */
export class Vault {
  constructor(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    const rawPath = typeof opts.vaultPath === 'string' ? opts.vaultPath.trim() : ''
    this._rawPath = rawPath ? resolve(rawPath) : null
    this._backupDirOption = typeof opts.backupDir === 'string' && opts.backupDir.trim() ? resolve(opts.backupDir.trim()) : null
    this._trashDirOption = typeof opts.trashDir === 'string' && opts.trashDir.trim() ? resolve(opts.trashDir.trim()) : null
    this._maxReadBytes = positiveInt(opts.maxReadBytes, DEFAULT_MAX_READ_BYTES)
    this._maxFileBytes = positiveInt(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES)
    this._maxSearchFiles = positiveInt(opts.maxSearchFiles, DEFAULT_MAX_SEARCH_FILES)
    const extraIgnore = Array.isArray(opts.ignoreDirs) ? opts.ignoreDirs : opts.ignoreDirs instanceof Set ? [...opts.ignoreDirs] : []
    this._ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...extraIgnore.map((name) => String(name))])
    this._now = typeof opts.now === 'function' ? opts.now : () => new Date()
  }

  /** vault 绝对路径（未配置时为 null）。 */
  get root() {
    return this._rawPath
  }

  /** vault 目录名。 */
  get name() {
    return this._rawPath ? basename(this._rawPath) : ''
  }

  /** vault 当前是否可用（目录存在且为目录）。 */
  get available() {
    if (!this._rawPath) return false
    try {
      return statSync(this._rawPath).isDirectory()
    } catch {
      return false
    }
  }

  _nowDate() {
    const value = this._now()
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date()
  }

  _ensureRoot() {
    if (!this.available) {
      const shown = this._rawPath || '（未配置）'
      throw new VaultError(
        'vault-unavailable',
        `Obsidian vault 不可用：${shown}。请在插件配置中设置 vaultPath，或设置环境变量 DSH_OBSIDIAN_VAULT。`,
      )
    }
    return this._rawPath
  }

  _unavailableMessage() {
    const shown = this._rawPath || '（未配置）'
    return `Obsidian vault 不可用：${shown}。请设置插件配置 vaultPath 或环境变量 DSH_OBSIDIAN_VAULT。`
  }

  /** 规范化公开路径（只做语法校验，不访问磁盘）。 */
  normalizePath(rawPath) {
    return normalizeRelativeFilePath(rawPath)
  }

  /** 规范化目录相对路径（允许 `''`）。 */
  normalizeDirPath(rawDir) {
    return normalizeRelativeDirPath(rawDir)
  }

  /**
   * 把相对路径解析为绝对路径，并做词法 + 真实路径双重 containment 校验。
   * 目标可不存在（写入场景）。
   */
  _resolve(relPath) {
    const root = this._ensureRoot()
    if (relPath === '') return root
    const abs = join(root, ...relPath.split('/'))
    const rel = relative(root, abs)
    if (rel === '') return root
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new VaultError('outside-vault', `路径超出 vault 根目录：${relPath}`)
    }
    this._assertRealContainment(abs, relPath)
    return abs
  }

  /** 对已存在目标（或最近的存在祖先）用 realpath 校验仍在 vault 内，防 symlink/junction 逃逸。 */
  _assertRealContainment(abs, relPath) {
    const root = this._rawPath
    let probe = abs
    while (!existsSync(probe)) {
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    let realTarget
    try {
      realTarget = realpathSync.native(probe)
    } catch {
      return
    }
    let realRoot
    try {
      realRoot = realpathSync.native(root)
    } catch {
      realRoot = root
    }
    const rel = relative(realRoot, realTarget)
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new VaultError('outside-vault', `路径经符号链接解析后超出 vault 根目录：${relPath}`)
    }
  }

  /** 解析已存在目录路径（不存在 → not-found）。 */
  _resolveDir(relDir) {
    const root = this._ensureRoot()
    if (relDir === '') return root
    const abs = this._resolve(relDir)
    let stat
    try {
      stat = statSync(abs)
    } catch (error) {
      throw mapFsError(error, relDir)
    }
    if (!stat.isDirectory()) throw new VaultError('not-found', `目录不存在：${relDir}`)
    return abs
  }

  /** 解析已存在文件路径（不存在 → not-found，目录 → not-a-file）。 */
  _resolveFile(relPath) {
    const abs = this._resolve(relPath)
    let stat
    try {
      stat = statSync(abs)
    } catch (error) {
      throw mapFsError(error, relPath)
    }
    if (!stat.isFile()) throw new VaultError('not-a-file', `目标不是文件：${relPath}`)
    return abs
  }

  _isIgnoredName(name) {
    return name.startsWith('.') || this._ignoreDirs.has(name)
  }

  _isIgnoredDirName(name) {
    return name.startsWith('.') || this._ignoreDirs.has(name)
  }

  /** 读取文件为文本（剥 BOM、换行归一 LF）。 */
  _readText(abs) {
    return stripBomAndNormalize(readFileSync(abs, 'utf8'))
  }

  /** 解析一个笔记文件为 read() 结构。 */
  _parseNote(abs, relPath, options = {}) {
    const stat = statSync(abs)
    if (!stat.isFile()) throw new VaultError('not-a-file', `目标不是文件：${relPath}`)
    const hardLimit = positiveInt(options.hardLimit, this._maxFileBytes)
    if (stat.size > hardLimit) {
      throw new VaultError('too-large', `文件过大（${stat.size} 字节 > 上限 ${hardLimit} 字节）：${relPath}`)
    }
    const rawBuffer = readFileSync(abs)
    const cap = positiveInt(options.cap, Number.MAX_SAFE_INTEGER)
    const truncated = rawBuffer.length > cap
    const text = stripBomAndNormalize((truncated ? rawBuffer.subarray(0, cap) : rawBuffer).toString('utf8'))
    const parsed = parseFrontmatter(text)
    const title = resolveNoteTitle(parsed.data, parsed.body, relPath)
    const tags = normalizeTags([...frontmatterTags(parsed.data), ...extractInlineTags(parsed.body)])
    const links = extractWikilinks(parsed.body)
    return {
      path: relPath,
      title,
      frontmatter: parsed.data,
      frontmatterRaw: parsed.raw,
      tags,
      links,
      content: parsed.body,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      truncated,
    }
  }

  /** 快速取标题（最多读 8 KiB）。 */
  _quickTitle(abs, relPath) {
    try {
      const buffer = readFileSync(abs)
      const text = stripBomAndNormalize(buffer.subarray(0, 8192).toString('utf8'))
      const parsed = parseFrontmatter(text)
      return resolveNoteTitle(parsed.data, parsed.body, relPath)
    } catch {
      return baseNameWithoutExt(relPath)
    }
  }

  /** 递归扫描笔记（忽略隐藏/忽略目录、符号链接）。 */
  _scanNotes(relDir = '', cap = this._maxSearchFiles) {
    const startAbs = this._resolveDir(relDir)
    const files = []
    let truncated = false
    const walk = (absDir, relPrefix) => {
      if (truncated) return
      let entries
      try {
        entries = readdirSync(absDir, { withFileTypes: true })
      } catch (error) {
        throw mapFsError(error, relPrefix)
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (truncated) return
        const name = entry.name
        if (this._isIgnoredName(name)) continue
        if (entry.isSymbolicLink()) continue
        const childAbs = join(absDir, name)
        const childRel = relPrefix ? `${relPrefix}/${name}` : name
        if (entry.isDirectory()) {
          walk(childAbs, childRel)
        } else if (/\.md$/i.test(name)) {
          if (files.length >= cap) {
            truncated = true
            return
          }
          files.push({ abs: childAbs, rel: childRel })
        }
      }
    }
    walk(startAbs, relDir)
    return { files, truncated }
  }

  // ── status ──────────────────────────────────────────────────────────────

  /**
   * vault 概览。vault 不可用时**不抛错**，返回 `available:false` + `error`，
   * 便于 HTTP /health、/status 与 `obsidian_status` 工具如实报告。
   */
  status() {
    const dailyDefaults = { folder: '', format: 'YYYY-MM-DD', template: '' }
    if (!this.available) {
      return {
        ok: true,
        available: false,
        vaultPath: this._rawPath,
        name: this.name,
        noteCount: 0,
        folderCount: 0,
        totalBytes: 0,
        daily: dailyDefaults,
        obsidianConfig: { appJson: null, corePlugins: null, dailyNotes: null },
        error: { code: 'vault-unavailable', message: this._unavailableMessage() },
      }
    }
    const root = this._rawPath
    let noteCount = 0
    let folderCount = 0
    let totalBytes = 0
    const walk = (absDir) => {
      let entries
      try {
        entries = readdirSync(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const name = entry.name
        if (this._isIgnoredName(name)) continue
        if (entry.isSymbolicLink()) continue
        const childAbs = join(absDir, name)
        if (entry.isDirectory()) {
          folderCount += 1
          walk(childAbs)
        } else if (/\.md$/i.test(name)) {
          noteCount += 1
          try {
            totalBytes += statSync(childAbs).size
          } catch {
            /* 忽略不可读文件 */
          }
        }
      }
    }
    walk(root)
    const dailyConfig = this._dailyConfig()
    return {
      ok: true,
      available: true,
      vaultPath: root,
      name: this.name,
      noteCount,
      folderCount,
      totalBytes,
      daily: dailyConfig,
      obsidianConfig: {
        appJson: this._readObsidianJson('app.json'),
        corePlugins: this._readObsidianJson('core-plugins.json'),
        dailyNotes: this._readObsidianJson('daily-notes.json'),
      },
    }
  }

  _readObsidianJson(fileName) {
    if (!this._rawPath) return null
    try {
      const text = stripBom(readFileSync(join(this._rawPath, '.obsidian', fileName), 'utf8'))
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  _dailyConfig() {
    const raw = this._readObsidianJson('daily-notes.json')
    const config = raw && typeof raw === 'object' ? raw : {}
    const folder = typeof config.folder === 'string' ? config.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : ''
    const format = typeof config.format === 'string' && config.format.trim() !== '' ? config.format.trim() : 'YYYY-MM-DD'
    const template = typeof config.template === 'string' ? config.template.replace(/\\/g, '/').replace(/^\/+/, '') : ''
    return { folder, format, template }
  }

  // ── list ────────────────────────────────────────────────────────────────

  list(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    const dir = normalizeRelativeDirPath(opts.dir ?? '')
    const depth = Math.min(10, Math.max(1, positiveInt(opts.depth, 2)))
    const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, positiveInt(opts.limit, 500)))
    const absDir = this._resolveDir(dir)
    const entries = []
    let truncated = false
    const walk = (absPath, relPrefix, level) => {
      if (truncated) return
      let dirents
      try {
        dirents = readdirSync(absPath, { withFileTypes: true })
      } catch (error) {
        throw mapFsError(error, relPrefix)
      }
      dirents.sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1
        const bDir = b.isDirectory() ? 0 : 1
        if (aDir !== bDir) return aDir - bDir
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      })
      for (const dirent of dirents) {
        if (truncated) return
        const name = dirent.name
        if (this._isIgnoredName(name)) continue
        if (dirent.isSymbolicLink()) continue
        const childAbs = join(absPath, name)
        const childRel = relPrefix ? `${relPrefix}/${name}` : name
        if (dirent.isDirectory()) {
          if (entries.length >= limit) {
            truncated = true
            return
          }
          entries.push({ path: childRel, name, type: 'folder' })
          if (level < depth) walk(childAbs, childRel, level + 1)
        } else if (/\.md$/i.test(name)) {
          if (entries.length >= limit) {
            truncated = true
            return
          }
          const entry = { path: childRel, name, type: 'note', title: this._quickTitle(childAbs, childRel) }
          try {
            const stat = statSync(childAbs)
            entry.size = stat.size
            entry.mtime = stat.mtime.toISOString()
          } catch {
            /* 忽略不可读文件元数据 */
          }
          entries.push(entry)
        }
      }
    }
    walk(absDir, dir, 1)
    return { dir, entries, truncated }
  }

  // ── read ────────────────────────────────────────────────────────────────

  read(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    if (opts.path === undefined) throw invalidPath('', '缺少 path 参数。')
    const relPath = normalizeRelativeFilePath(opts.path)
    const abs = this._resolveFile(relPath)
    let cap = this._maxReadBytes
    if (opts.maxBytes !== undefined && opts.maxBytes !== null && opts.maxBytes !== '') {
      const num = Number(opts.maxBytes)
      if (!Number.isFinite(num) || num <= 0) throw invalidPath(opts.maxBytes, 'maxBytes 必须是正整数。')
      cap = Math.floor(num)
    }
    return this._parseNote(abs, relPath, { cap })
  }

  // ── write ───────────────────────────────────────────────────────────────

  write(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    if (opts.path === undefined) throw invalidPath('', '缺少 path 参数。')
    const relPath = normalizeRelativeFilePath(opts.path)
    const mode = typeof opts.mode === 'string' && opts.mode !== '' ? opts.mode : 'overwrite'
    if (!['create', 'overwrite', 'append', 'prepend'].includes(mode)) {
      throw invalidPath(opts.mode, `不支持的写入模式：${opts.mode}（可用 create/overwrite/append/prepend）。`)
    }
    if (opts.content !== undefined && typeof opts.content !== 'string') {
      throw invalidPath(opts.content, 'content 必须是字符串。')
    }
    let content = stripBomAndNormalize(opts.content ?? '')
    const patch = opts.frontmatter
    if (patch !== undefined && patch !== null && !isPlainObject(patch)) {
      throw invalidPath(patch, 'frontmatter 必须是普通对象或 null。')
    }
    let tagsInput
    if (opts.tags !== undefined) {
      if (!Array.isArray(opts.tags)) throw invalidPath(opts.tags, 'tags 必须是字符串数组。')
      tagsInput = normalizeTags(opts.tags)
    }
    const createDirs = opts.createDirs !== false
    const wantBackup = opts.backup !== false

    const abs = this._resolve(relPath)
    const exists = existsSync(abs)
    if (exists) {
      let stat
      try {
        stat = statSync(abs)
      } catch (error) {
        throw mapFsError(error, relPath)
      }
      if (!stat.isFile()) throw new VaultError('not-a-file', `目标不是文件：${relPath}`)
    }
    if (mode === 'create' && exists) {
      throw new VaultError('exists', `笔记已存在：${relPath}（如需覆盖请用 overwrite 模式）。`)
    }

    // 读取旧内容（保留 frontmatter 用）
    let baseData = {}
    let oldBody = ''
    if (exists) {
      const text = this._readText(abs)
      const parsed = parseFrontmatter(text)
      baseData = parsed.data
      oldBody = parsed.body
    }

    // 若正文自带 frontmatter 块（create/overwrite 且未显式传 frontmatter），按 frontmatter 处理
    let contentData = null
    if ((mode === 'create' || mode === 'overwrite') && patch === undefined) {
      if (content.startsWith('---\n') || content === '---') {
        const parsed = parseFrontmatter(content)
        if (parsed.raw !== '' || content.startsWith('---\n')) {
          if (parsed.raw !== '' || /^---\n[\s\S]*?\n---(\n|$)/.test(content)) {
            contentData = parsed.data
            content = parsed.body
          }
        }
      }
    }

    // 计算最终 frontmatter
    let data
    if (patch === null) {
      data = {}
    } else {
      data = mode === 'append' || mode === 'prepend' || mode === 'overwrite' ? cloneFrontmatter(baseData) : {}
      if (contentData) {
        for (const key of Object.keys(contentData)) {
          data[key] = cloneValue(contentData[key])
          unmarkNested(data, key)
        }
      }
      if (isPlainObject(patch)) {
        for (const key of Object.keys(patch)) {
          const value = patch[key]
          if (value === undefined) continue
          if (value === null) {
            delete data[key]
            continue
          }
          data[key] = cloneValue(value)
          unmarkNested(data, key)
        }
      }
    }
    if (tagsInput !== undefined) {
      if (tagsInput.length > 0) {
        data.tags = tagsInput
        unmarkNested(data, 'tags')
      } else {
        delete data.tags
        unmarkNested(data, 'tags')
      }
    }

    // 计算最终正文
    let body
    if (mode === 'append') {
      body = `${ensureTrailingNewline(oldBody)}${ensureTrailingNewline(content)}`
    } else if (mode === 'prepend') {
      body = `${ensureTrailingNewline(content)}${oldBody}`
    } else {
      body = ensureTrailingNewline(content)
    }

    const finalText = serializeFrontmatter(data) + body
    const parentDir = dirname(abs)
    if (!existsSync(parentDir)) {
      if (!createDirs) throw new VaultError('not-found', `父目录不存在：${dirname(relPath)}`)
      try {
        mkdirSync(parentDir, { recursive: true })
      } catch (error) {
        throw mapFsError(error, relPath)
      }
    }

    // 备份旧内容
    let backupPath = null
    if (exists && wantBackup) {
      try {
        const backupAbs = join(this._backupRoot(), stampWithMs(this._nowDate()), ...relPath.split('/'))
        mkdirSync(dirname(backupAbs), { recursive: true })
        copyFileSync(abs, backupAbs)
        backupPath = backupAbs
      } catch (error) {
        if (error instanceof VaultError) throw error
        // 备份失败不阻断写入，但要如实报告
        backupPath = null
      }
    }

    // 原子写：同目录临时文件 + renameSync
    const tempName = `.dsh-obsidian-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.tmp`
    const tempAbs = join(parentDir, tempName)
    try {
      writeFileSync(tempAbs, finalText, 'utf8')
      renameWithRetry(tempAbs, abs)
    } catch (error) {
      try {
        if (existsSync(tempAbs)) unlinkSync(tempAbs)
      } catch {
        /* 清理失败忽略 */
      }
      throw mapFsError(error, relPath)
    }

    return {
      path: relPath,
      mode,
      created: !exists,
      bytes: Buffer.byteLength(finalText, 'utf8'),
      backupPath,
    }
  }

  _backupRoot() {
    if (this._backupDirOption) return this._backupDirOption
    const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
    return join(dshHome, 'obsidian-backups')
  }

  _trashRoot() {
    return this._trashDirOption || join(this._ensureRoot(), '.trash')
  }

  // ── search ──────────────────────────────────────────────────────────────

  search(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    const query = typeof opts.query === 'string' ? opts.query.trim() : opts.query === undefined || opts.query === null ? '' : String(opts.query).trim()
    const mode = typeof opts.mode === 'string' && opts.mode !== '' ? opts.mode : 'all'
    if (!['all', 'title', 'content', 'tag'].includes(mode)) {
      throw invalidPath(opts.mode, `不支持的搜索模式：${opts.mode}（可用 all/title/content/tag）。`)
    }
    const tagFilter = typeof opts.tag === 'string' ? opts.tag.trim().replace(/^#+/, '') : ''
    if (!query && !tagFilter) throw invalidPath(query, '搜索词 query 不能为空。')
    const dir = normalizeRelativeDirPath(opts.dir ?? '')
    const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, positiveInt(opts.limit, 50)))
    const context = Math.min(1000, Math.max(0, positiveInt(opts.context, 60)))
    const qLower = query.toLowerCase()
    const tagFilterLower = tagFilter.toLowerCase()
    const { files, truncated: scanTruncated } = this._scanNotes(dir)
    const results = []
    let total = 0

    for (const file of files) {
      let parsed
      let fullText
      try {
        const stat = statSync(file.abs)
        if (stat.size > this._maxFileBytes) continue
        fullText = this._readText(file.abs)
        parsed = parseFrontmatter(fullText)
      } catch {
        continue
      }
      const title = resolveNoteTitle(parsed.data, parsed.body, file.rel)
      const tags = normalizeTags([...frontmatterTags(parsed.data), ...extractInlineTags(parsed.body)])
      // 正文命中只在正文里找（frontmatter 的 tags 等已单独计分）；行号换算为整文件 1 基行号。
      const bodyLines = parsed.body.split('\n')
      const prefixLines = parsed.hasFrontmatter ? (parsed.raw === '' ? 2 : parsed.raw.split('\n').length + 2) : 0
      const titleLower = title.toLowerCase()
      const relLower = file.rel.toLowerCase()
      const tagsLower = tags.map((tag) => tag.toLowerCase())

      if (tagFilterLower) {
        const hasTag = tagsLower.some((tag) => tag === tagFilterLower)
        if (!hasTag) continue
      }

      const titleHit = qLower !== '' && titleLower.includes(qLower)
      const pathHit = qLower !== '' && relLower.includes(qLower)
      let tagHits = []
      if (qLower !== '') tagHits = tags.filter((tag) => tag.toLowerCase().includes(qLower))
      const tagHit = tagHits.length > 0
      let bodyHitLine = -1
      let bodyHitIndex = -1
      if (qLower !== '') {
        for (let index = 0; index < bodyLines.length; index += 1) {
          const lineLower = bodyLines[index].toLowerCase()
          if (lineLower.includes(qLower)) {
            bodyHitLine = index + 1 + prefixLines
            bodyHitIndex = index
            break
          }
        }
      }
      const contentHit = bodyHitIndex >= 0
      const tagOnlyFilterHit = !qLower && tagFilterLower !== ''

      let matched = false
      if (mode === 'all') matched = titleHit || tagHit || contentHit || pathHit || tagOnlyFilterHit
      else if (mode === 'title') matched = titleHit
      else if (mode === 'content') matched = contentHit
      else if (mode === 'tag') matched = tagHit || tagOnlyFilterHit
      if (!matched) continue

      total += 1
      const score = (titleHit ? 100 : 0) + (tagHit ? 60 : 0) + (contentHit ? 40 : 0) + (pathHit ? 30 : 0) + (tagOnlyFilterHit ? 60 : 0)
      let matchedField = 'path'
      if (titleHit) matchedField = 'title'
      else if (tagHit || tagOnlyFilterHit) matchedField = 'tag'
      else if (contentHit) matchedField = 'content'

      let line = bodyHitLine > 0 ? bodyHitLine : 1
      if (!contentHit && titleHit) {
        for (let index = 0; index < bodyLines.length; index += 1) {
          if (bodyLines[index].toLowerCase().includes(`# ${titleLower}`)) {
            line = index + 1 + prefixLines
            break
          }
        }
      }
      let snippetSource = ''
      if (bodyHitIndex >= 0) snippetSource = bodyLines[bodyHitIndex]
      else if (titleHit) snippetSource = `# ${title}`
      else if (tagHits.length > 0) snippetSource = `#${tagHits[0]}`
      else if (tagOnlyFilterHit) snippetSource = `#${tagFilter}`
      const snippet = this._makeSnippet(snippetSource, context, query)
      results.push({ path: file.rel, title, line, snippet, score, matched: matchedField })
    }

    results.sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const truncated = scanTruncated || total > limit
    return { total, truncated, results: results.slice(0, limit) }
  }

  _makeSnippet(line, context, query) {
    const clean = String(line).replace(/\s+/g, ' ').trim()
    if (!clean) return ''
    const grow = context === 0 ? 40 : context
    const q = String(query || '')
    let index = -1
    if (q) index = clean.toLowerCase().indexOf(q.toLowerCase())
    if (index < 0) {
      const head = clean.slice(0, grow * 2)
      return clean.length > grow * 2 ? `…${head}…` : head
    }
    const start = Math.max(0, index - grow)
    const end = Math.min(clean.length, index + q.length + grow)
    const slice = clean.slice(start, end)
    return `${start > 0 ? '…' : ''}${slice}${end < clean.length ? '…' : ''}`
  }

  // ── manage ──────────────────────────────────────────────────────────────

  manage(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    const action = typeof opts.action === 'string' ? opts.action.trim() : ''
    if (action === 'move') {
      if (opts.from === undefined) throw invalidPath('', 'move 需要 from 参数。')
      if (opts.to === undefined) throw invalidPath('', 'move 需要 to 参数。')
      const from = normalizeRelativeFilePath(opts.from)
      const to = normalizeRelativeFilePath(opts.to)
      const fromAbs = this._resolveFile(from)
      const toAbs = this._resolve(to)
      const targetExists = existsSync(toAbs)
      if (targetExists) {
        if (opts.overwrite !== true) {
          throw new VaultError('exists', `目标已存在：${to}（如需覆盖请传 overwrite: true）。`)
        }
        const stat = statSync(toAbs)
        if (!stat.isFile()) throw new VaultError('not-a-file', `目标不是文件：${to}`)
      }
      const parentDir = dirname(toAbs)
      if (!existsSync(parentDir)) {
        try {
          mkdirSync(parentDir, { recursive: true })
        } catch (error) {
          throw mapFsError(error, to)
        }
      }
      try {
        if (targetExists) unlinkSync(toAbs)
        renameWithRetry(fromAbs, toAbs)
      } catch (error) {
        throw mapFsError(error, to)
      }
      return { action: 'move', from, to }
    }
    if (action === 'trash') {
      if (opts.hard === true) {
        if (opts.path === undefined) throw invalidPath('', 'trash 需要 path 参数。')
        const relPath = normalizeRelativeFilePath(opts.path)
        const abs = this._resolveFile(relPath)
        try {
          unlinkSync(abs)
        } catch (error) {
          throw mapFsError(error, relPath)
        }
        return { action: 'trash', path: relPath, trashPath: null, hard: true, trashed: true }
      }
      if (opts.path === undefined) throw invalidPath('', 'trash 需要 path 参数。')
      const relPath = normalizeRelativeFilePath(opts.path)
      const abs = this._resolveFile(relPath)
      const trashRoot = this._trashRoot()
      try {
        mkdirSync(trashRoot, { recursive: true })
      } catch (error) {
        throw mapFsError(error, relPath)
      }
      const stamp = compactStamp(this._nowDate())
      const baseName = basename(relPath)
      let destination = join(trashRoot, `${stamp}-${baseName}`)
      let suffix = 1
      while (existsSync(destination) && suffix < 1000) {
        destination = join(trashRoot, `${stamp}-${suffix}-${baseName}`)
        suffix += 1
      }
      try {
        renameSync(abs, destination)
      } catch (error) {
        throw mapFsError(error, relPath)
      }
      const trashRel = relative(this._ensureRoot(), destination).replace(/\\/g, '/')
      return { action: 'trash', path: relPath, trashPath: trashRel, hard: false, trashed: true }
    }
    throw invalidPath(opts.action, `不支持的 manage action：${opts.action}（可用 move/trash）。`)
  }

  // ── daily ───────────────────────────────────────────────────────────────

  daily(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    const mode = typeof opts.mode === 'string' && opts.mode !== '' ? opts.mode : 'read'
    if (!['read', 'append', 'create'].includes(mode)) {
      throw invalidPath(opts.mode, `不支持的 daily 模式：${opts.mode}（可用 read/append/create）。`)
    }
    if (opts.content !== undefined && typeof opts.content !== 'string') {
      throw invalidPath(opts.content, 'content 必须是字符串。')
    }
    this._ensureRoot()
    const config = this._dailyConfig()
    const date = parseDateArg(opts.date, this._nowDate())
    const dateLabel = formatDate(date, config.format)
    const rawRel = config.folder ? `${config.folder}/${dateLabel}` : dateLabel
    const relPath = normalizeRelativeFilePath(rawRel)
    const abs = this._resolve(relPath)
    const exists = existsSync(abs)
    const content = stripBomAndNormalize(opts.content ?? '')

    if (mode === 'read') {
      if (!exists) {
        return { path: relPath, date: dateLabel, created: false, content: '', appended: false, bytes: 0 }
      }
      const note = this.read({ path: relPath })
      return { path: relPath, date: dateLabel, created: false, content: note.content, appended: false, bytes: note.size }
    }

    if (mode === 'create') {
      if (exists) {
        const note = this.read({ path: relPath })
        return { path: relPath, date: dateLabel, created: false, content: note.content, appended: false, bytes: note.size }
      }
      const body = this._dailyTemplateBody(config.template, date, dateLabel, relPath)
      this.write({ path: relPath, content: body, mode: 'create', createDirs: true, backup: false })
      const note = this.read({ path: relPath })
      return { path: relPath, date: dateLabel, created: true, content: note.content, appended: false, bytes: note.size }
    }

    // append
    const appended = content !== ''
    if (exists) {
      this.write({ path: relPath, content, mode: 'append', createDirs: true, backup: true })
      const note = this.read({ path: relPath })
      return { path: relPath, date: dateLabel, created: false, content: note.content, appended, bytes: note.size }
    }
    const templateBody = this._dailyTemplateBody(config.template, date, dateLabel, relPath)
    const body = content ? `${ensureTrailingNewline(templateBody)}${ensureTrailingNewline(content)}` : templateBody
    this.write({ path: relPath, content: body, mode: 'create', createDirs: true, backup: false })
    const note = this.read({ path: relPath })
    return { path: relPath, date: dateLabel, created: true, content: note.content, appended, bytes: note.size }
  }

  _dailyTemplateBody(templateRel, date, dateLabel, noteRelPath) {
    if (!templateRel) return ''
    let templateBody = ''
    try {
      // 模板路径可能不带 .md：规范化后只读正文
      const templatePath = normalizeRelativeFilePath(templateRel)
      const abs = this._resolveFile(templatePath)
      templateBody = this._readText(abs)
      templateBody = parseFrontmatter(templateBody).body
    } catch {
      return ''
    }
    const title = baseNameWithoutExt(noteRelPath)
    const now = this._nowDate()
    const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    return templateBody
      .replace(/\{\{\s*date\s*\}\}/g, dateLabel)
      .replace(/\{\{\s*time\s*\}\}/g, time)
      .replace(/\{\{\s*title\s*\}\}/g, title)
  }

  // ── tags ────────────────────────────────────────────────────────────────

  tags() {
    const { files, truncated } = this._scanNotes('')
    const aggregate = new Map()
    for (const file of files) {
      let parsed
      try {
        const stat = statSync(file.abs)
        if (stat.size > this._maxFileBytes) continue
        parsed = parseFrontmatter(this._readText(file.abs))
      } catch {
        continue
      }
      const tags = normalizeTags([...frontmatterTags(parsed.data), ...extractInlineTags(parsed.body)])
      for (const tag of tags) {
        let entry = aggregate.get(tag)
        if (!entry) {
          entry = { tag, count: 0, notes: [] }
          aggregate.set(tag, entry)
        }
        entry.count += 1
        if (entry.notes.length < 20) entry.notes.push(file.rel)
      }
    }
    const tags = [...aggregate.values()].sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    return { tags, total: tags.length, truncated }
  }

  // ── links ───────────────────────────────────────────────────────────────

  links(options = {}) {
    const opts = isPlainObject(options) ? options : {}
    if (opts.path === undefined) throw invalidPath('', '缺少 path 参数。')
    const relPath = normalizeRelativeFilePath(opts.path)
    const abs = this._resolveFile(relPath)
    const note = this._parseNote(abs, relPath)
    const outgoing = note.links
    const { files, truncated } = this._scanNotes('')

    const index = { byPath: new Map(), byBase: new Map() }
    for (const file of files) {
      const noExt = file.rel.replace(/\.md$/i, '')
      index.byPath.set(noExt.toLowerCase(), file.rel)
      const base = baseNameWithoutExt(file.rel).toLowerCase()
      if (!index.byBase.has(base)) index.byBase.set(base, [])
      index.byBase.get(base).push(file.rel)
    }

    const currentNoExt = relPath.replace(/\.md$/i, '').toLowerCase()
    const resolveTarget = (target) => {
      let normalized = String(target).trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (normalized === '') return []
      if (/\.md$/i.test(normalized)) normalized = normalized.replace(/\.md$/i, '')
      const lower = normalized.toLowerCase()
      if (index.byPath.has(lower)) return [index.byPath.get(lower)]
      const base = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower
      if (index.byBase.has(base)) return index.byBase.get(base)
      return []
    }

    const unresolved = []
    for (const target of outgoing) {
      if (resolveTarget(target).length === 0) unresolved.push(target)
    }

    const backlinks = []
    for (const file of files) {
      if (file.rel === relPath) continue
      let parsed
      try {
        const stat = statSync(file.abs)
        if (stat.size > this._maxFileBytes) continue
        parsed = parseFrontmatter(this._readText(file.abs))
      } catch {
        continue
      }
      const targets = extractWikilinks(parsed.body)
      for (const target of targets) {
        const resolved = resolveTarget(target)
        if (resolved.some((candidate) => candidate.replace(/\.md$/i, '').toLowerCase() === currentNoExt)) {
          backlinks.push(file.rel)
          break
        }
      }
    }

    return { path: relPath, outgoing, backlinks, unresolved, truncated }
  }
}

/**
 * 创建 Vault 实例（构造绝不抛错）。
 * @param {Record<string, unknown>} options
 * @returns {Vault}
 */
export function createVault(options) {
  return new Vault(options)
}
