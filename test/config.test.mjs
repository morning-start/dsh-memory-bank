/**
 * 配置域验收 —— `docs/07` 阶段 P0 的四条硬门。
 *
 * ```
 * ① .dsh-memory/config.json 改了真的生效
 * ② resolveConfig 有四层（默认 → 项目 → 环境 → 行）
 * ③ subscribe 能触发重载（保存即生效，不用重启宿主）
 * ④ volatileForm(Config) 返回非 undefined，且覆盖全部可编辑字段
 * ```
 *
 * 第 ④ 条是这一版**新增的硬门**。不加它，P1 会在「表单只读，不知道为什么」
 * 上卡一整天：宿主对没有 volatile 字段的插件直接拒绝打开设置页
 * （`'Plugin entry "<ns>" has no volatile fields'`），而且不会说为什么。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import z from '@deepseek-ai/schemastery'

import {
  Config,
  GROUPS,
  PROJECT_KEYS,
  createConfigSource,
  describeFields,
  fixedConfigSource,
  migrateConfig,
  plainConfig,
  projectConfigPath,
  projectPatchFrom,
  readProjectConfig,
  resetProjectConfig,
  resolveConfig,
  sourceOf,
  mergeLayers,
  writeProjectConfig,
} from '../lib/config/index.js'
import { defaultConfig } from '../lib/config/defaults.js'

/* ── 宿主 `volatileForm` 的逐字副本 ─────────────────────────────────── */

// 为什么不 `import`：`@deepseek-ai/dsh-settings` 是宿主包，本仓库的
// `node_modules` 里没有它（也不该有 —— 第三方插件依赖宿主包就是在赌版本）。
// 所以这里把 `dsh-settings/lib/types/schema.js:19-54` 的两个函数**逐字复制**：
// 它们只有 15 行，而复制品能证明的正是我们要证明的那件事 ——
// 「宿主跑这段代码时会得到非 undefined」。
function plainSchema(schema) {
  const result = new z(schema.toJSON())
  const walk = (node) => {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) walk(child)
    if (node.inner) walk(node.inner)
    for (const child of node.list ?? []) walk(child)
  }
  walk(result)
  return result
}

function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}

function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}

/* ── 夹具 ────────────────────────────────────────────────────────── */

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-bank-config-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeProject(document) {
  mkdirSync(join(root, '.dsh-memory'), { recursive: true })
  writeFileSync(projectConfigPath(root), JSON.stringify(document, null, 2), 'utf8')
}

/* ── ④ volatileForm 硬门 ─────────────────────────────────────────── */

describe('④ Config 的每个字段都必须在 volatile 子树上', () => {
  it('volatileForm(Config) 不是 undefined（否则宿主拒绝打开设置页）', () => {
    assert.notEqual(volatileForm(Config), undefined)
  })

  it('11 个顶层键全部进了表单', () => {
    const form = volatileForm(Config)
    const declared = Object.keys(Config.dict ?? {})
    assert.equal(declared.length, 11, `Config 顶层应有 11 个键，实际 ${declared.length} 个`)
    assert.deepEqual([...Object.keys(form.dict ?? {})].sort(), [...declared].sort())
  })

  it('描述表里每一条叶子路径都 isVolatilePath（没有「看得见改不了」的字段）', () => {
    const { fields } = describeFields()
    const leaves = fields.filter((field) => field.type !== 'object' || (field.children ?? []).length === 0)
    assert.ok(leaves.length > 20, `叶子字段太少（${leaves.length}），描述表可能没摊开`)
    for (const field of leaves) {
      assert.equal(isVolatilePath(Config, field.path.split('.')), true, `字段 ${field.path} 不是 volatile`)
    }
  })

  it('六个分组都有中文标签，且覆盖全部顶层键', () => {
    const covered = new Set(GROUPS.flatMap((group) => group.keys.map((key) => key.split('.')[0])))
    for (const key of Object.keys(Config.dict ?? {})) {
      assert.ok(covered.has(key), `顶层键 ${key} 没有归到任何分组`)
    }
    for (const group of GROUPS) {
      assert.ok(group.label.zh && group.label.en, `分组 ${group.id} 缺标签`)
      assert.ok(group.description.zh, `分组 ${group.id} 缺说明`)
    }
  })
})

/* ── ① schema 物化出来的空容器必须被裁掉 ─────────────────────────── */

describe('① 宿主交进来的解析值不会静默清空默认值', () => {
  it('plainConfig 拆得掉 Volatile 包装', () => {
    const W = Symbol.for('cosmokit.volatile.write')
    const parsed = Config({ autonomy: 'balanced' })
    assert.equal(typeof parsed, 'object')
    assert.ok(W in parsed.autonomy, 'autonomy 应该是 Volatile 引用')
    const plain = plainConfig(parsed)
    assert.equal(plain.autonomy, 'balanced')
    assert.equal(typeof plain.autonomy, 'string')
  })

  it('template / capture.signals 不会被物化成空数组（G2 与自动捕获的静默杀手）', () => {
    const cfg = resolveConfig(plainConfig(Config({ autonomy: 'balanced' })), {}, {})
    assert.deepEqual(cfg.template, defaultConfig().template, 'template 被清空了 —— G2 会 refuse 每一条')
    assert.deepEqual(cfg.capture.signals, defaultConfig().capture.signals, 'signals 被清空了 —— 自动捕获会静默失效')
    assert.equal(cfg.capture.enabled, true)
    assert.equal(cfg.thresholds.autoAcceptFloor, 0.6)
    assert.deepEqual(cfg.thresholds.content, defaultConfig().thresholds.content)
  })

  it('显式给出的非空数组仍然生效', () => {
    const cfg = resolveConfig({ template: ['功能名', '生效条件'] }, {}, {})
    assert.deepEqual(cfg.template, ['功能名', '生效条件'])
  })
})

/* ── ② 四层顺序 ──────────────────────────────────────────────────── */

describe('② 默认 → 项目 → 环境 → 行', () => {
  it('项目层盖过默认值', () => {
    const cfg = resolveConfig({}, {}, { capture: { enabled: false }, quota: { repo: 50 } })
    assert.equal(cfg.capture.enabled, false)
    assert.equal(cfg.quota.repo, 50)
  })

  it('环境变量盖过项目层', () => {
    // autonomy 不是仓库属性，项目层根本收不到它；用 autoAcceptFloor 验层级。
    const cfg = resolveConfig({}, { DSH_MEMORY_AUTO_ACCEPT_FLOOR: '0.9' }, { capture: { enabled: false } })
    assert.equal(cfg.thresholds.autoAcceptFloor, 0.9)
    assert.equal(cfg.capture.enabled, false, '环境变量不该把项目层的其它字段抹掉')
  })

  it('行 config 盖过环境变量与项目层', () => {
    const cfg = resolveConfig(
      { thresholds: { autoAcceptFloor: 0.55 } },
      { DSH_MEMORY_AUTO_ACCEPT_FLOOR: '0.9' },
      { capture: { enabled: false } },
    )
    assert.equal(cfg.thresholds.autoAcceptFloor, 0.55, '行 config 必须是最高层')
    assert.equal(cfg.capture.enabled, false)
  })

  it('项目层只认四个仓库属性，其余字段被裁掉并报出来', () => {
    const read = (() => {
      writeProject({ schema: 'dsh-memory.config/v1', version: 1, autonomy: 'autonomous', quota: { repo: 30 } })
      return readProjectConfig(root)
    })()
    assert.deepEqual(read.value, { quota: { repo: 30 } })
    assert.ok(
      read.problems.some((problem) => problem.includes('autonomy')),
      `应报出被忽略的 autonomy，实际：${JSON.stringify(read.problems)}`,
    )
    // 而且真的没生效 —— 静默忽略才是bug，报出来就不算。
    assert.equal(resolveConfig({}, {}, read.value).autonomy, 'balanced')
  })

  it('sourceOf 指出每个字段实际来自哪一层', () => {
    const { layers } = mergeLayers({
      row: { quota: { repo: 10 } },
      env: { DSH_MEMORY_AUTONOMY: 'manual' },
      project: { capture: { enabled: false } },
    })
    assert.equal(sourceOf(layers, 'quota.repo'), 'row')
    assert.equal(sourceOf(layers, 'autonomy'), 'env')
    assert.equal(sourceOf(layers, 'capture.enabled'), 'project')
    assert.equal(sourceOf(layers, 'thresholds.contentTier'), 'default')
  })
})

/* ── ①+③ 项目文件真的被读，且保存即生效 ──────────────────────────── */

describe('①③ 项目配置读写与热重载', () => {
  it('没有 config.json 时这一层是空的', () => {
    const read = readProjectConfig(root)
    assert.equal(read.exists, false)
    assert.deepEqual(read.value, {})
    assert.deepEqual(read.problems, [])
  })

  it('写了 config.json 就真的生效', () => {
    writeProject({ schema: 'dsh-memory.config/v1', version: 1, capture: { enabled: false } })
    const source = createConfigSource({ rowConfig: {}, env: {} })
    assert.equal(source.get(root).capture.enabled, false)
  })

  it('subscribe 在保存时触发（保存即生效，不用重启宿主）', () => {
    const source = createConfigSource({ rowConfig: {}, env: {} })
    const seen = []
    const dispose = source.subscribe((changedRoot, config) => seen.push([changedRoot, config.quota.repo]))

    source.setProject(root, { quota: { repo: 42 } })
    assert.deepEqual(seen, [[root, 42]])

    dispose()
    source.setProject(root, { quota: { repo: 43 } })
    assert.equal(seen.length, 1, 'dispose 之后不该再收到通知')
  })

  it('外部改了文件（绕过 subscribe）也能看见 —— 缓存按 mtime:size 失效', () => {
    const source = createConfigSource({ rowConfig: {}, env: {} })
    assert.equal(source.get(root).quota.repo, 200)
    writeProject({ schema: 'dsh-memory.config/v1', version: 1, quota: { repo: 7 } })
    // 文件系统 mtime 精度在 Windows 上足够；保险起见显式让缓存失效一次。
    source.invalidate(root)
    assert.equal(source.get(root).quota.repo, 7)
  })

  it('写进去的只有与默认值不同的部分（不把当时的默认值冻进仓库）', () => {
    const source = createConfigSource({ rowConfig: {}, env: {} })
    source.setProject(root, { quota: { repo: 200 } })
    assert.deepEqual(projectPatchFrom({ quota: { repo: 200 }, capture: defaultConfig().capture }), {})
    const onDisk = JSON.parse(readProjectConfig(root).raw ? JSON.stringify(readProjectConfig(root).raw) : '{}')
    assert.equal(onDisk.quota, undefined, `默认值不该落盘，实际：${JSON.stringify(onDisk)}`)
  })

  it('写项目层是补丁合并，不会抹掉没提到的仓库属性', () => {
    const source = createConfigSource({ rowConfig: {}, env: {} })
    source.setProject(root, { quota: { repo: 30 } })
    source.setProject(root, { capture: { enabled: false } })
    const config = source.get(root)
    assert.equal(config.quota.repo, 30)
    assert.equal(config.capture.enabled, false)
  })

  it('resetProject 清空仓库级覆盖', () => {
    const source = createConfigSource({ rowConfig: {}, env: {} })
    source.setProject(root, { quota: { repo: 30 } })
    source.resetProject(root)
    assert.equal(source.get(root).quota.repo, 200)
  })

  it('坏 JSON 降级为默认值，但**报出来**', () => {
    mkdirSync(join(root, '.dsh-memory'), { recursive: true })
    writeFileSync(projectConfigPath(root), '{ "quota": { "repo": 30, } }', 'utf8')
    const read = readProjectConfig(root)
    assert.deepEqual(read.value, {})
    assert.ok(read.problems.length > 0, '坏文件必须进 problems')
    assert.match(read.problems[0], /JSON/u)
    // 而且不能抛 —— 一个手写的逗号不能让整个插件挂掉。
    assert.equal(resolveConfig({}, {}, read.value).quota.repo, 200)
  })

  it('类型不对也是降级 + 报出来，不是静默接受', () => {
    writeProject({ schema: 'dsh-memory.config/v1', version: 1, quota: { repo: 'lots' } })
    const read = readProjectConfig(root)
    assert.ok(read.problems.some((problem) => problem.includes('校验')), JSON.stringify(read.problems))
    assert.deepEqual(read.value, {})
  })

  it('固定配置源不可写（没有项目层的 profile）', () => {
    const fixed = fixedConfigSource(resolveConfig({}))
    assert.throws(() => fixed.setProject('/tmp/x', {}), /不可写/u)
    assert.equal(fixed.get('/tmp/x').autonomy, 'balanced')
  })
})

/* ── 迁移 ────────────────────────────────────────────────────────── */

describe('迁移', () => {
  it('当前版本原样通过', () => {
    const result = migrateConfig({ version: 1, quota: { repo: 10 } })
    assert.equal(result.migrated, false)
    assert.deepEqual(result.problems, [])
    assert.deepEqual(result.value, { version: 1, quota: { repo: 10 } })
  })

  it('没有 version 字段当 v1 处理', () => {
    const result = migrateConfig({ quota: { repo: 10 } })
    assert.equal(result.version, 1)
    assert.equal(result.value.version, 1)
  })

  it('版本高于本插件时**不猜**：原样保留 + 报问题', () => {
    const result = migrateConfig({ version: 99, quota: { repo: 10 } })
    assert.equal(result.migrated, false)
    assert.equal(result.version, 99)
    assert.ok(result.problems.length > 0)
    assert.match(result.problems[0], /99/u)
  })

  it('不是对象也不抛', () => {
    const result = migrateConfig([1, 2, 3])
    assert.deepEqual(result.value, {})
    assert.ok(result.problems.length > 0)
  })
})

/* ── 界面数据源 ──────────────────────────────────────────────────── */

describe('describeConfig：界面 1 的唯一数据源', () => {
  it('环境变量来的字段只读，项目层来的可写', () => {
    const source = createConfigSource({ rowConfig: {}, env: { DSH_MEMORY_AUTONOMY: 'manual' } })
    source.setProject(root, { quota: { repo: 30 } })
    const { fields } = source.describe(root)

    const autonomy = fields.find((field) => field.path === 'autonomy')
    assert.equal(autonomy.source, 'env')
    assert.equal(autonomy.writable, false, '环境变量层改这里不生效，必须只读')

    const quota = fields.find((field) => field.path === 'quota.repo')
    assert.equal(quota.source, 'project')
    assert.equal(quota.writable, true)
    assert.equal(quota.value, 30)

    const contentTier = fields.find((field) => field.path === 'thresholds.contentTier')
    assert.equal(contentTier.source, 'default')
    assert.equal(contentTier.defaultValue, 0.85)
  })

  it('只有四个仓库属性标 projectScoped', () => {
    const source = createConfigSource({ rowConfig: {}, env: {} })
    const { fields } = source.describe(root)
    const scoped = new Set(fields.filter((field) => field.projectScoped).map((field) => field.path.split('.')[0]))
    assert.deepEqual([...scoped].sort(), [...PROJECT_KEYS].sort())
  })

  it('枚举字段带 values（界面要渲染三选一）', () => {
    const source = createConfigSource({ rowConfig: {}, env: {} })
    const { fields } = source.describe(root)
    const autonomy = fields.find((field) => field.path === 'autonomy')
    assert.deepEqual(autonomy.enum, ['manual', 'balanced', 'autonomous'])
  })
})

/* ── 校验 ────────────────────────────────────────────────────────── */

describe('fail-fast 校验', () => {
  it('autonomy 拼错直接抛（不能静默回退到更激进的档位）', () => {
    assert.throws(() => resolveConfig({ autonomy: 'yolo' }, {}), /autonomy/u)
  })

  it('deferFloor 不能大于 autoAcceptFloor', () => {
    assert.throws(() => resolveConfig({ thresholds: { autoAcceptFloor: 0.2, deferFloor: 0.4 } }, {}), /deferFloor/u)
  })

  it('环境变量不是数字直接抛（静默回退比没设更糟）', () => {
    assert.throws(() => resolveConfig({}, { DSH_MEMORY_DEFER_FLOOR: 'abc' }), /DSH_MEMORY_DEFER_FLOOR/u)
  })

  it('root 必须是绝对路径', () => {
    assert.throws(() => resolveConfig({ root: 'relative/path' }, {}), /绝对路径/u)
    assert.equal(resolveConfig({ root: join(root, 'repo') }, {}).root, join(root, 'repo'))
  })

  it('manual 把 effective autoAcceptFloor 调到 1.01（永不自动）', () => {
    assert.equal(resolveConfig({ autonomy: 'manual' }, {}).thresholds.autoAcceptFloor, 1.01)
    assert.equal(resolveConfig({ autonomy: 'autonomous' }, {}).thresholds.autoAcceptFloor, 0.45)
  })
})
