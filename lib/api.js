// dsh-plugin-obsidian — host HTTP API（SPEC §5）。
//
// 单个 prefix 路由 `/dsh-obsidian/api`，内部再分发。所有响应为 JSON：
// 成功 `{ ok: true, ...payload }`，失败 `{ ok: false, error: { code, message } }`。
import { VaultError } from './vault.js'
import { openNoteInObsidian } from './tools.js'

/** 浏览器半区使用的 API 前缀。 */
export const API_PREFIX = '/dsh-obsidian/api'

/** JSON 请求体上限（字节）。 */
const MAX_BODY_BYTES = 1024 * 1024

/** VaultError.code / 路由错误码 → HTTP 状态码。 */
const CODE_STATUS = {
  'invalid-path': 400,
  'outside-vault': 400,
  'too-large': 400,
  'bad-request': 400,
  'not-found': 404,
  'exists': 409,
  'method-not-allowed': 405,
  'cross-site-request-rejected': 403,
  'vault-unavailable': 503,
}

function json(res, status, payload) {
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(JSON.stringify(payload))
  } catch {
    /* 连接已断开等：忽略 */
  }
}

function badRequest(message) {
  return new VaultError('bad-request', message)
}

/** 同源校验（照抄 dsh-skill-manager 的 fence 逻辑）。 */
function isSameOriginRequest(req) {
  const headers = req && req.headers ? req.headers : {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const host = headers.host
    if (typeof host !== 'string' || host === '') return false
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

/** 收集请求体并限制 1 MiB。 */
function collectBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    let settled = false
    const cleanup = () => {
      if (typeof req.removeListener === 'function') {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
      }
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(error)
    }
    const onData = (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        fail(badRequest(`请求体超过 ${MAX_BODY_BYTES} 字节（1 MiB）上限。`))
        try {
          if (typeof req.destroy === 'function') req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(Buffer.concat(chunks))
    }
    const onError = () => fail(badRequest('读取请求体失败。'))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    if (req.readableEnded === true) onEnd()
  })
}

/** 读取并解析 JSON 对象请求体；空体视为 `{}`，非法 JSON → 400 bad-request。 */
async function readJsonBody(req) {
  const headers = req && req.headers ? req.headers : {}
  const declared = headers['content-length']
  if (declared !== undefined) {
    const declaredSize = Number(declared)
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
      throw badRequest(`请求体超过 ${MAX_BODY_BYTES} 字节（1 MiB）上限。`)
    }
  }
  const raw = await collectBody(req)
  if (raw.length > MAX_BODY_BYTES) {
    throw badRequest(`请求体超过 ${MAX_BODY_BYTES} 字节（1 MiB）上限。`)
  }
  const text = raw.toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw badRequest('请求体不是合法 JSON。')
  }
  if (parsed === null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('请求体必须是 JSON 对象。')
  }
  return parsed
}

function optionalInt(searchParams, name) {
  if (!searchParams || typeof searchParams.get !== 'function') return undefined
  const raw = searchParams.get(name)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return Math.floor(value)
}

function mapError(error) {
  const code = error instanceof VaultError ? error.code : error && typeof error.code === 'string' ? error.code : null
  if (code && Object.prototype.hasOwnProperty.call(CODE_STATUS, code)) {
    return {
      status: CODE_STATUS[code],
      payload: { ok: false, error: { code, message: (error && error.message) || code } },
    }
  }
  return {
    status: 500,
    payload: {
      ok: false,
      error: {
        code: 'internal-error',
        message: error instanceof Error ? error.message : String(error),
      },
    },
  }
}

const UNAVAILABLE_DAILY = { folder: '', format: 'YYYY-MM-DD', template: '' }

/**
 * 创建 API 处理器。
 * @param {unknown} ctx cordis 上下文（当前未使用，保留接口形状）
 * @param {{
 *   getVault: () => any,
 *   getConfig?: () => Record<string, any>,
 *   getState?: () => { toolsRegistered?: string[] },
 *   version?: string,
 * }} options
 * @returns {{ handle: (req: any, res: any) => Promise<void>, dispose: () => void }}
 */
export function createApi(ctx, options = {}) {
  const getVaultFn = typeof options.getVault === 'function' ? options.getVault : () => null
  const getConfigFn = typeof options.getConfig === 'function' ? options.getConfig : () => ({})
  const getStateFn = typeof options.getState === 'function' ? options.getState : () => ({ toolsRegistered: [] })
  const version = typeof options.version === 'string' && options.version ? options.version : '0.1.0'
  let closed = false

  const readVault = () => {
    try {
      return getVaultFn() || null
    } catch {
      return null
    }
  }
  const getConfig = () => {
    try {
      return getConfigFn() || {}
    } catch {
      return {}
    }
  }
  const requireVault = () => {
    const vault = readVault()
    if (!vault) {
      throw new VaultError('vault-unavailable', 'Obsidian vault 未配置或不可用：请设置插件配置 vaultPath 或环境变量 DSH_OBSIDIAN_VAULT。')
    }
    return vault
  }
  const safeStatus = () => {
    const vault = readVault()
    if (vault && typeof vault.status === 'function') {
      try {
        return vault.status()
      } catch {
        /* 落到下面的兜底 */
      }
    }
    return {
      ok: true,
      available: false,
      vaultPath: null,
      name: '',
      noteCount: 0,
      folderCount: 0,
      totalBytes: 0,
      daily: { ...UNAVAILABLE_DAILY },
      obsidianConfig: { appJson: null, corePlugins: null, dailyNotes: null },
      error: {
        code: 'vault-unavailable',
        message: 'Obsidian vault 未配置或不可用：请设置插件配置 vaultPath 或环境变量 DSH_OBSIDIAN_VAULT。',
      },
    }
  }
  const health = () => {
    const vault = readVault()
    const state = (() => {
      try {
        return getStateFn() || {}
      } catch {
        return {}
      }
    })()
    return {
      ok: true,
      vaultPath: vault && typeof vault.root === 'string' ? vault.root : null,
      vaultAvailable: Boolean(vault && vault.available),
      toolsRegistered: Array.isArray(state.toolsRegistered) ? [...state.toolsRegistered] : [],
      version,
    }
  }

  const routes = [
    {
      path: '/health',
      methods: ['GET'],
      run: () => health(),
    },
    {
      path: '/status',
      methods: ['GET'],
      run: () => ({ ok: true, ...safeStatus() }),
    },
    {
      path: '/tree',
      methods: ['GET'],
      run: ({ query }) => ({
        ok: true,
        ...requireVault().list({
          dir: query.get('dir') ?? '',
          depth: optionalInt(query, 'depth'),
          limit: optionalInt(query, 'limit'),
        }),
      }),
    },
    {
      path: '/note',
      methods: ['GET'],
      run: ({ query }) => ({
        ok: true,
        note: requireVault().read({ path: query.get('path') ?? '', maxBytes: optionalInt(query, 'maxBytes') }),
      }),
    },
    {
      path: '/note',
      methods: ['POST'],
      run: ({ body }) => ({ ok: true, result: requireVault().write(body) }),
    },
    {
      path: '/search',
      methods: ['GET'],
      run: ({ query }) => ({
        ok: true,
        ...requireVault().search({
          query: query.get('q') ?? '',
          mode: query.get('mode') ?? 'all',
          dir: query.get('dir') ?? '',
          tag: query.get('tag') ?? '',
          limit: optionalInt(query, 'limit'),
          context: optionalInt(query, 'context'),
        }),
      }),
    },
    {
      path: '/manage',
      methods: ['POST'],
      run: ({ body }) => ({ ok: true, result: requireVault().manage(body) }),
    },
    {
      path: '/daily',
      methods: ['GET'],
      run: ({ query }) => ({ ok: true, daily: requireVault().daily({ date: query.get('date') ?? '', mode: 'read' }) }),
    },
    {
      path: '/daily',
      methods: ['POST'],
      run: ({ body }) => ({ ok: true, daily: requireVault().daily(body) }),
    },
    {
      path: '/tags',
      methods: ['GET'],
      run: () => ({ ok: true, ...requireVault().tags() }),
    },
    {
      path: '/links',
      methods: ['GET'],
      run: ({ query }) => ({ ok: true, ...requireVault().links({ path: query.get('path') ?? '' }) }),
    },
    {
      path: '/open',
      methods: ['POST'],
      run: ({ body }) => {
        const vault = requireVault()
        return { ok: true, result: openNoteInObsidian(vault, getConfig(), body && body.path) }
      },
    },
  ]

  async function dispatch(req, res) {
    if (!isSameOriginRequest(req)) {
      return json(res, 403, {
        ok: false,
        error: { code: 'cross-site-request-rejected', message: '已拒绝跨站请求（同源校验失败）。' },
      })
    }
    if (closed) {
      return json(res, 503, {
        ok: false,
        error: { code: 'vault-unavailable', message: '插件已卸载，API 已停止服务。' },
      })
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      return json(res, 400, { ok: false, error: { code: 'bad-request', message: '请求 URL 非法。' } })
    }
    const pathname = url.pathname
    if (!pathname.startsWith(API_PREFIX)) {
      return json(res, 404, { ok: false, error: { code: 'not-found', message: `未知路由：${pathname}` } })
    }
    let sub = pathname.slice(API_PREFIX.length) || '/'
    if (sub.length > 1 && sub.endsWith('/')) sub = sub.slice(0, -1)
    const method = String(req.method || 'GET').toUpperCase()
    const pathMatches = routes.filter((candidate) => candidate.path === sub)
    if (pathMatches.length === 0) {
      return json(res, 404, { ok: false, error: { code: 'not-found', message: `未知路由：${pathname}` } })
    }
    const route = pathMatches.find((candidate) => candidate.methods.includes(method))
    if (!route) {
      const allowed = [...new Set(pathMatches.flatMap((candidate) => candidate.methods))]
      return json(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: `方法 ${method} 不被 ${sub} 支持（可用：${allowed.join(', ')}）。` },
      })
    }
    try {
      const body = method === 'POST' ? await readJsonBody(req) : {}
      const payload = await route.run({ query: url.searchParams, body })
      json(res, 200, payload)
    } catch (error) {
      const mapped = mapError(error)
      json(res, mapped.status, mapped.payload)
    }
  }

  const handle = (req, res) => dispatch(req, res)

  return {
    handle,
    dispose() {
      closed = true
    },
  }
}
