/**
 * 配置解析：行 config > 环境变量 > 内置默认值。
 *
 * **唯一事实源**。`Config` schema 故意不填默认值 —— schema 填出的默认值
 * 与「用户显式配置」无法区分，会在解析时永久遮蔽环境变量回退。
 * 类型/范围在 schema 里校验，默认值与回退只在这里。
 */

import { defaultConfig } from './store.js'

/** 环境变量回退表。 */
const ENV = Object.freeze({
  autonomy: 'DSH_MEMORY_AUTONOMY',
  root: 'DSH_MEMORY_ROOT',
  home: 'DSH_MEMORY_HOME',
  autoAcceptFloor: 'DSH_MEMORY_AUTO_ACCEPT_FLOOR',
  deferFloor: 'DSH_MEMORY_DEFER_FLOOR',
  quota: 'DSH_MEMORY_QUOTA',
})

const AUTONOMY = ['manual', 'balanced', 'autonomous']

function numberOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function deepMerge(base, override) {
  if (override === undefined || override === null) return base
  if (Array.isArray(override)) return override
  if (typeof override !== 'object') return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = key in base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])
      ? deepMerge(base[key], value)
      : value
  }
  return out
}

/**
 * 解析配置。`rowConfig` 是 cordis.patch.yml 那一行的 `config`。
 * 非法值**不静默降级**：autonomy 不在枚举里直接抛 —— 一个拼写错误
 * 绝不能悄悄回退到更激进的档位。
 */
export function resolveConfig(rowConfig = {}, env = process.env) {
  const defaults = defaultConfig()
  const merged = deepMerge(defaults, rowConfig)

  const autonomy = merged.autonomy ?? env[ENV.autonomy] ?? defaults.autonomy
  if (!AUTONOMY.includes(autonomy)) {
    throw new Error(`memory-bank: autonomy 只能是 ${AUTONOMY.join(' / ')}，收到「${autonomy}」`)
  }

  const autoAcceptFloor = numberOr(
    merged.thresholds?.autoAcceptFloor ?? env[ENV.autoAcceptFloor],
    defaults.thresholds.autoAcceptFloor,
  )
  const deferFloor = numberOr(merged.thresholds?.deferFloor ?? env[ENV.deferFloor], defaults.thresholds.deferFloor)

  if (autoAcceptFloor <= 0 || autoAcceptFloor > 1) {
    throw new Error(`memory-bank: autoAcceptFloor 必须在 (0, 1]，收到 ${autoAcceptFloor}`)
  }
  if (deferFloor > autoAcceptFloor) {
    throw new Error('memory-bank: deferFloor 不能大于 autoAcceptFloor')
  }

  // autonomy 调制 autoAcceptFloor（manual 永不自动，全靠确认）
  const effectiveAutoAccept =
    autonomy === 'manual' ? 1.01 : autonomy === 'autonomous' ? Math.min(autoAcceptFloor, 0.45) : autoAcceptFloor

  return {
    ...merged,
    autonomy,
    root: merged.root ?? env[ENV.root] ?? null,
    home: merged.home ?? env[ENV.home] ?? null,
    thresholds: {
      ...defaults.thresholds,
      ...merged.thresholds,
      autoAcceptFloor: effectiveAutoAccept,
      deferFloor,
      content: { ...defaults.thresholds.content, ...(merged.thresholds?.content ?? {}) },
    },
    quota: { ...defaults.quota, ...(merged.quota ?? {}) },
    capture: { ...defaults.capture, ...(merged.capture ?? {}) },
    recall: { ...defaults.recall, ...(merged.recall ?? {}) },
  }
}

export { AUTONOMY, ENV }
