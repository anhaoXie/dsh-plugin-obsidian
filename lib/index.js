// dsh-plugin-obsidian — DSH host 插件入口（SPEC §1.1）。
//
// 零依赖：不 import 任何 `@deepseek-ai/*` 包。
// vault 路径优先级：行 config.vaultPath > 环境变量 DSH_OBSIDIAN_VAULT > discoverVault()。
// apply() 在任何情况下都不抛错：vault 缺失由 status/health 如实报告。
import { readFileSync } from 'node:fs'
import { createVault, discoverVault } from './vault.js'
import { createTools } from './tools.js'
import { API_PREFIX, createApi } from './api.js'

/** 稳定插件名（必须等于包名 / cordis.patch.yml insert id）。 */
export const name = 'dsh-plugin-obsidian'

/** 顶层声明的服务。 */
export const inject = ['webServer']

function readPluginVersion() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (parsed && typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch {
    /* 打包环境可能没有 package.json：用回退版本号 */
  }
  return '0.1.0'
}

/** 读取行 config 值：兼容普通对象与 cordis Schema（`.get()`）两种形态。 */
function readConfigValue(config, key) {
  if (!config || typeof config !== 'object') return undefined
  const raw = config[key]
  if (raw && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      return raw.get()
    } catch {
      return undefined
    }
  }
  return raw
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 挂载插件。
 * @param {any} ctx cordis 上下文
 * @param {Record<string, any>} [config] 行 config（普通对象）
 */
export function apply(ctx, config = {}) {
  const version = readPluginVersion()
  /** HTTP /health 读取的共享状态；工具注册成功后写入。 */
  const state = { toolsRegistered: [], version }

  const getConfig = () => {
    try {
      return config && typeof config === 'object' ? config : {}
    } catch {
      return {}
    }
  }

  /** vault 路径优先级：config.vaultPath > DSH_OBSIDIAN_VAULT > 自动发现。 */
  const resolveVaultPath = () => {
    const fromConfig = nonEmptyString(readConfigValue(config, 'vaultPath'))
    if (fromConfig) return fromConfig
    const fromEnv = nonEmptyString(process.env.DSH_OBSIDIAN_VAULT)
    if (fromEnv) return fromEnv
    try {
      return discoverVault() || null
    } catch {
      return null
    }
  }

  let cachedVault = null
  let cachedPathKey = null

  /** 懒加载 vault；路径变化时重建（配置可在运行中修改）。 */
  const getVault = () => {
    const vaultPath = resolveVaultPath()
    const key = vaultPath ?? ''
    if (cachedVault !== null && cachedPathKey === key) return cachedVault
    cachedPathKey = key
    try {
      cachedVault = createVault({
        vaultPath: vaultPath ?? undefined,
        backupDir: nonEmptyString(readConfigValue(config, 'backupDir')) ?? undefined,
        trashDir: nonEmptyString(readConfigValue(config, 'trashDir')) ?? undefined,
        maxReadBytes: readConfigValue(config, 'maxReadBytes'),
        maxSearchFiles: readConfigValue(config, 'maxSearchFiles'),
        ignoreDirs: readConfigValue(config, 'ignoreDirs'),
      })
    } catch (error) {
      // 理论上 createVault 不抛错；这里兜底为“不可用 vault”，保证 getVault 永远返回实例。
      console.error('[dsh-plugin-obsidian] 创建 vault 引擎失败：', error)
      cachedVault = createVault({})
    }
    return cachedVault
  }

  // ── agent 工具 ──────────────────────────────────────────────────────────
  try {
    ctx.inject(['tools'], (toolCtx) => {
      try {
        const tools = createTools({ getVault, getConfig })
        const disposers = []
        for (const definition of tools) {
          try {
            const dispose = toolCtx.tools.register(definition)
            if (typeof dispose === 'function') disposers.push(dispose)
            state.toolsRegistered.push(definition.name)
          } catch (error) {
            console.error(`[dsh-plugin-obsidian] 工具 ${definition && definition.name} 注册失败：`, error)
          }
        }
        toolCtx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 已释放 */
            }
          }
          state.toolsRegistered.length = 0
        }, 'dsh-plugin-obsidian: agent tools')
        console.log(
          `[dsh-plugin-obsidian] 已注册 ${state.toolsRegistered.length}/${tools.length} 个 agent 工具。`,
        )
      } catch (error) {
        console.error('[dsh-plugin-obsidian] 工具注册失败：', error)
      }
    })
  } catch (error) {
    console.error('[dsh-plugin-obsidian] 无法注入 tools 服务：', error)
  }

  // ── HTTP API（前缀路由） ────────────────────────────────────────────────
  try {
    const api = createApi(ctx, {
      getVault,
      getConfig,
      getState: () => state,
      version,
    })
    ctx.effect(() => {
      let disposeRoute = null
      try {
        if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
          console.error('[dsh-plugin-obsidian] webServer 服务不可用，跳过 HTTP API 注册。')
          return () => {}
        }
        disposeRoute = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: api.handle })
      } catch (error) {
        console.error('[dsh-plugin-obsidian] HTTP API 注册失败：', error)
        return () => {}
      }
      return () => {
        try {
          if (typeof disposeRoute === 'function') disposeRoute()
        } catch (error) {
          console.error('[dsh-plugin-obsidian] 释放 HTTP API 路由失败：', error)
        } finally {
          api.dispose()
        }
      }
    }, 'dsh-plugin-obsidian: http api')
  } catch (error) {
    console.error('[dsh-plugin-obsidian] 无法注入 webServer 服务：', error)
  }
}
