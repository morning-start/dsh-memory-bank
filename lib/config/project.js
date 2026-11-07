/**
 * 项目层配置：`<repo>/.dsh-memory/config.json` 的读写。
 *
 * ## 为什么这一层必须存在
 *
 * DSH 的插件配置是 **profile 级**的（`~/.dsh/profiles/...`），而记忆库是
 * **仓库级**的（`<repo>/.dsh-memory/`）。把「这个仓库要不要开自动捕获」写进
 * profile，换仓库就串味。
 *
 * 0.1.1 之前 `layout()` 声明了这个路径，**全仓没有任何代码读或写它** ——
 * 用户按文档改 `config.json` 完全不生效，也没有任何提示。这个文件就是那个洞。
 *
 * ## 坏文件不静默
 *
 * 手写 JSON 会写错。读坏了降级为默认值是必须的（否则一个逗号让整个插件挂掉），
 * 但**必须报 `problems`** —— 让界面能把「你的 config.json 第 3 行少了逗号」
 * 显示出来。静默降级是 0.1.0 最贵的债。
 */

import { readFileSync, statSync } from 'node:fs'

import { CONFIG_SCHEMA, CONFIG_VERSION, PROJECT_KEYS, defaultConfig, projectPatchFrom } from './defaults.js'
import { projectLayer } from './layers.js'
import { migrateConfig } from './migrate.js'
import { Config } from './schema.js'
import { layout } from '../store.js'
import { stableJson, writeFileAtomic } from '../util.js'

/** 项目配置文件的绝对路径。 */
export function projectConfigPath(root) {
  return layout(root).config
}

/** 只允许出现在项目文件里的顶层键。 */
const ALLOWED = new Set(PROJECT_KEYS)

/** 文件指纹，用来做读缓存失效（`mtime:size`）。文件不存在返回 `null`。 */
export function projectStamp(root) {
  try {
    const stat = statSync(projectConfigPath(root))
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

/**
 * 读项目层。
 *
 * **永不抛**：任何读取/解析/校验失败都降级为「这一层是空的」，并把原因放进
 * `problems`。插件不能因为一个手写的 JSON 文件挂掉。
 *
 * @param {string} root 仓库根目录
 * @returns {{
 *   path: string,
 *   exists: boolean,
 *   value: object,
 *   raw: object,
 *   problems: string[],
 *   stamp: string | null,
 *   unknownKeys: string[],
 * }}
 */
export function readProjectConfig(root) {
  const path = projectConfigPath(root)
  const problems = []
  const empty = { path, exists: false, value: {}, raw: {}, problems, stamp: null, unknownKeys: [] }

  const stamp = projectStamp(root)
  if (stamp === null) return empty

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    problems.push(`读不了 ${path}：${error?.message ?? error}`)
    return { ...empty, stamp }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // JSON 的报错位置对用户最有用，原样带上。
    problems.push(`config.json 不是合法 JSON：${error?.message ?? error}`)
    return { ...empty, exists: true, stamp }
  }

  const migration = migrateConfig(parsed)
  problems.push(...migration.problems)
  const raw = migration.value

  const unknownKeys = Object.keys(raw).filter(
    (key) => !ALLOWED.has(key) && !['schema', 'version'].includes(key),
  )
  if (unknownKeys.length > 0) {
    // 不静默：写错了键名（以及本该是「用户偏好」的字段）必须说出来。
    problems.push(
      `config.json 里的 ${unknownKeys.map((key) => `「${key}」`).join('、')} 不是仓库属性，已忽略；` +
        `只有 ${PROJECT_KEYS.join(' / ')} 可以按仓库配置（其余请写在插件配置文件里）`,
    )
  }

  // 用 schema 校验裁剪后的层。裁剪会去掉多余键，所以校验只看类型。
  let value
  try {
    value = projectLayer(raw)
    Config(value)
  } catch (error) {
    problems.push(`config.json 校验失败，这一层按空处理：${error?.message ?? error}`)
    return { ...empty, exists: true, stamp, raw, unknownKeys }
  }

  return { path, exists: true, value, raw, problems, stamp, unknownKeys }
}

/**
 * 写项目层。
 *
 * 语义是**补丁合并**而不是整体替换：只传 `{ capture: { enabled: false } }`
 * 不会把 `quota` 抹掉。写进去之前会裁掉与默认值相同的部分 —— 否则第一次保存
 * 就把当时的默认值永久冻进仓库，以后改默认值对这个仓库再也不生效。
 *
 * @param {string} root
 * @param {object} patch 要合并进去的补丁（只认 `PROJECT_KEYS`）
 * @returns {{ path: string, written: object, value: object, problems: string[] }}
 */
export function writeProjectConfig(root, patch) {
  const current = readProjectConfig(root)
  const defaults = defaultConfig()
  const merged = {}
  for (const key of PROJECT_KEYS) {
    const base = current.value?.[key] ?? defaults[key]
    const over = patch?.[key]
    if (over === undefined) {
      merged[key] = base
      continue
    }
    merged[key] =
      base && typeof base === 'object' && !Array.isArray(base) && over && typeof over === 'object' && !Array.isArray(over)
        ? { ...base, ...over }
        : over
  }

  const written = projectPatchFrom(merged)
  const document = { schema: CONFIG_SCHEMA, version: CONFIG_VERSION, ...written }
  writeFileAtomic(projectConfigPath(root), `${stableJson(document, 2)}\n`)

  return { path: projectConfigPath(root), written, value: projectLayer(document), problems: current.problems }
}

/**
 * 重置项目层（清空所有仓库级覆盖）。
 *
 * 写回一个只有文件头的文件 —— 不是删文件。删文件会让 `git status` 显示
 * 一个 deletion，而用户以为「只是重置」。
 */
export function resetProjectConfig(root) {
  const document = { schema: CONFIG_SCHEMA, version: CONFIG_VERSION }
  writeFileAtomic(projectConfigPath(root), `${stableJson(document, 2)}\n`)
  return { path: projectConfigPath(root), value: {}, written: {} }
}
