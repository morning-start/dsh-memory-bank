/**
 * 配置版本迁移。
 *
 * 为什么现在就要有：`.dsh-memory/config.json` 是**进 git** 的文件。它会跟着
 * 仓库一起被同事 clone、被 CI checkout、被半年后的你打开。格式一旦变过，
 * 旧文件必须还能读 —— 而「读不动就全部回退到默认值」等于**静默清空团队共识**。
 *
 * 约定：
 * - 迁移函数只做**加法**（补新键、改名、搬位置），不删用户数据；
 * - 每一次迁移都必须有测试（`test/config.test.mjs` 的「迁移」组）；
 * - 版本**高于**本插件认识的版本时**不猜**：原样保留 + 报一条 problem，
 *   让用户看见「这个文件是更新的版本写的」，而不是把它当垃圾覆盖。
 */

import { CONFIG_VERSION } from './defaults.js'

/**
 * 迁移表：`from` → 把 `from` 版原始对象变成 `from + 1` 版。
 *
 * 现在是空的（只有 v1）。加迁移时在这里加一条，并在 `test/config.test.mjs`
 * 里加一组「旧文件 → 新文件」的断言。
 *
 * @type {Map<number, (raw: object) => object>}
 */
export const MIGRATIONS = new Map()

/**
 * 把任意版本的原始配置迁到当前版本。
 *
 * @param {unknown} raw 从磁盘读出来的原始 JSON
 * @returns {{ value: object, version: number, migrated: boolean, problems: string[] }}
 */
export function migrateConfig(raw) {
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: {}, version: CONFIG_VERSION, migrated: false, problems: ['配置不是对象，已忽略'] }
  }

  let value = { ...raw }
  let version = Number.isInteger(value.version) ? value.version : 1

  if (version > CONFIG_VERSION) {
    problems.push(
      `配置文件版本 ${version} 高于本插件支持的 ${CONFIG_VERSION}（可能是更新的版本写的）；已原样保留，未做任何迁移`,
    )
    return { value, version, migrated: false, problems }
  }

  let migrated = false
  while (version < CONFIG_VERSION) {
    const step = MIGRATIONS.get(version)
    if (!step) {
      // 迁移表缺一环是**代码 bug**，不是用户数据问题。报出来，不要吞。
      problems.push(`缺少 v${version} → v${version + 1} 的迁移函数；已停止迁移`)
      break
    }
    value = step(value)
    version += 1
    migrated = true
  }

  if (value.version !== version) value.version = version
  return { value, version, migrated, problems }
}
