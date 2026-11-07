#!/usr/bin/env node
/**
 * 自检：「这个插件在这个仓库里装好了吗？」
 *
 * ## 为什么要有它
 *
 * `memory_audit` 回答的是「**记忆**健康吗」—— 但它跑在插件**里面**：
 * 能跑就说明插件加载成功了，于是「装好了吗」这个问题它答不了。
 *
 * 而装不上有六种互相独立的方式，每一种的症状都是「什么都没发生」：
 *
 * | 断点 | 症状 |
 * |---|---|
 * | peer 依赖没链接 | `import` 直接抛，插件行不加载 |
 * | `lib/` 某个模块解析失败 | 同上，但只有那一条路径 |
 * | `.dsh-memory/` 布局缺项 | 写入失败 / 召回空 |
 * | 配置 JSON 坏了 | 静默降级成默认值 |
 * | 快照陈旧 | 召回到的是**上一次**的语料 |
 * | 客户端产物与源不一致 | 界面上看到的是旧代码 |
 *
 * 六种都**没有报错**。所以 doctor 的每一条都必须能给出「怎么修」。
 *
 * ## 纪律
 *
 * **只读。** 不 `ensureLayout`、不 `mkdir`、不写任何文件 —— 一个「自检」
 * 如果会改状态，那它就不能在被怀疑的时候跑。
 *
 * ## 用法
 *
 * ```
 * node scripts/doctor.mjs            # 人读
 * node scripts/doctor.mjs --json     # 机器读
 * ```
 *
 * 退出码：有 `error` → 1，否则 0（`warn` 不影响退出码）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { routeReport, summarizeRoutes } from '../lib/routes.js'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 插件行要求的最低 Node 版本（`package.json` 的 `engines`）。 */
const MIN_NODE = [20, 6, 0]

/** 三个 peer 依赖：少任何一个，插件行或面板行加载不了。 */
const PEERS = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/cordis']

/** `.dsh-memory/` 里**必须**存在的项（其余是派生的）。 */
const REQUIRED_LAYOUT = ['memories', 'trust', 'pending', 'inbox']

const ok = (id, label, detail, hint) => ({ id, label, level: 'ok', detail, hint })
const warn = (id, label, detail, hint) => ({ id, label, level: 'warn', detail, hint })
const fail = (id, label, detail, hint) => ({ id, label, level: 'error', detail, hint })
const skip = (id, label, detail, hint) => ({ id, label, level: 'skip', detail, hint })

/* ── 各项检查 ─────────────────────────────────────────────────────── */

function checkNode() {
  const current = process.versions.node.split('.').map(Number)
  const enough =
    current[0] > MIN_NODE[0] ||
    (current[0] === MIN_NODE[0] && (current[1] > MIN_NODE[1] || (current[1] === MIN_NODE[1] && current[2] >= MIN_NODE[2])))
  const label = `Node ≥ ${MIN_NODE.join('.')}`
  return enough
    ? ok('node', label, `v${process.versions.node}`)
    : fail('node', label, `v${process.versions.node}`, `升级 Node 到 ${MIN_NODE.join('.')} 以上`)
}

async function checkPeers() {
  const missing = []
  for (const peer of PEERS) {
    try {
      await import(peer)
    } catch {
      missing.push(peer)
    }
  }
  const label = `${PEERS.length} 个 peer 依赖可解析`
  if (missing.length === 0) return ok('peers', label, PEERS.join(' · '))
  return fail(
    'peers',
    label,
    `解析不到：${missing.join('、')}`,
    '这些由 DSH 安装提供。仓库里靠 junction 链接：\n' +
      '  mkdir node_modules\\@deepseek-ai\n' +
      '  cmd /c mklink /J "node_modules\\@deepseek-ai\\schemastery" "%USERPROFILE%\\.dsh\\profiles\\desktop\\node_modules\\@deepseek-ai\\schemastery"\n' +
      '  （其余两个同理；`node_modules/` 已在 .gitignore 里）',
  )
}

function collectModules(root) {
  const modules = []
  for (const dir of ['lib', 'shared']) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { recursive: true })) {
      const relative = String(entry).split('\\').join('/')
      if (!relative.endsWith('.js')) continue
      modules.push({ path: `${dir}/${relative}`, absolute: join(base, ...relative.split('/')) })
    }
  }
  return modules.sort((left, right) => left.path.localeCompare(right.path))
}

async function checkModules(root) {
  const modules = collectModules(root)
  const broken = []
  for (const module of modules) {
    try {
      await import(`file://${module.absolute.split('\\').join('/')}`)
    } catch (error) {
      broken.push({ path: module.path, message: String(error?.message ?? error).split('\n')[0] })
    }
  }
  const label = `${modules.length} 个模块可 import`
  if (broken.length === 0) return ok('modules', label, `${modules.length} 个`)
  return fail(
    'modules',
    label,
    broken.map((item) => `${item.path}: ${item.message}`).join('\n'),
    '语法通过不等于能解析（`check.mjs` 只做 `node --check`）。看上面第一条的 import 错误。',
  )
}

function checkLayout(root, layout) {
  const label = '.dsh-memory/ 布局'
  if (!existsSync(layout.base)) {
    return skip('layout', label, '这个仓库还没初始化记忆库（第一次 `memory_remember` 会建）')
  }
  const missing = REQUIRED_LAYOUT.filter((name) => !existsSync(join(layout.base, name)))
  if (missing.length === 0) return ok('layout', label, REQUIRED_LAYOUT.join(' · '))
  return fail(
    'layout',
    label,
    `缺：${missing.join('、')}`,
    '`memory_remember` 会 `ensureLayout` 补齐；如果它跑过还是缺，说明写盘被拦了（权限 / 只读挂载）。',
  )
}

function checkConfig(root, layout) {
  const label = '.dsh-memory/config.json 可解析'
  if (!existsSync(layout.config)) return skip('config', label, '没有项目层配置（走默认值）')
  try {
    const parsed = JSON.parse(readFileSync(layout.config, 'utf8'))
    const version = typeof parsed?.version === 'number' ? parsed.version : null
    if (version === null) {
      return warn('config', label, '能解析，但没有 `version` 字段', '旧格式；`/memory config` 保存一次会补上')
    }
    return ok('config', label, `version ${version}`)
  } catch (error) {
    return fail(
      'config',
      label,
      String(error?.message ?? error),
      '删掉或改名这个文件即可回退到默认值；插件自己会**静默降级**，所以坏文件不会报错。',
    )
  }
}

function checkSnapshot(root, layout, readSnapshot) {
  const label = '索引快照新鲜度'
  if (!existsSync(layout.memories)) return skip('snapshot', label, '没有记忆库')
  const snapshot = readSnapshot(root)
  if (!snapshot) return warn('snapshot', label, '还没编译（第一次召回会建）', '触发一次召回即可')

  const head = layout.head
  if (!existsSync(head)) return warn('snapshot', label, 'HEAD 指针不见了', '触发一次召回会重建')
  const compiledAt = statSync(head).mtimeMs

  let newest = 0
  for (const name of readdirSync(layout.memories)) {
    if (!name.endsWith('.md')) continue
    try {
      newest = Math.max(newest, statSync(join(layout.memories, name)).mtimeMs)
    } catch {
      /* 单个文件读不到不影响新鲜度判断 */
    }
  }

  if (newest <= compiledAt) {
    return ok('snapshot', label, `${snapshot.snapshotId?.slice(0, 8) ?? '?'} · ${snapshot.documents?.length ?? 0} 条`)
  }
  const lagSeconds = Math.round((newest - compiledAt) / 1000)
  return warn(
    'snapshot',
    label,
    `有记忆比快照新 ${lagSeconds} 秒`,
    '只在**后台**重建（`markDirty` 排的是 `setTimeout(0)`）。进程被杀过就会一直旧 —— 跑一次 `/memory status` 触发。',
  )
}

function checkInbox(layout) {
  const label = '捕获队列积压'
  if (!existsSync(layout.inbox)) return skip('inbox', label, '没有队列目录')
  const items = readdirSync(layout.inbox).filter((name) => name.endsWith('.json'))
  if (items.length === 0) return ok('inbox', label, '0 条')
  if (items.length < 20) return ok('inbox', label, `${items.length} 条（下次 turn 结束会自动 drain）`)
  return warn(
    'inbox',
    label,
    `${items.length} 条积压`,
    '它们已经**落盘**（重启不丢）。卡住通常是 drain 抛错 —— 看 `.dsh-memory/inbox/` 里有没有坏 JSON：坏项永远不会被移除。',
  )
}

function checkReceipts(root, layout, readAll, receiptStatus) {
  const label = '回执健康（抽样 10 条）'
  if (!existsSync(layout.memories)) return skip('receipts', label, '没有记忆库')
  let entries
  try {
    entries = readAll(root).entries
  } catch (error) {
    return fail('receipts', label, `读语料失败：${error?.message ?? error}`, '单个坏文件不该拖垮扫描 —— 这本身是个 bug')
  }
  if (entries.length === 0) return skip('receipts', label, '还没有记忆')

  const sample = entries.slice(0, 10)
  const bad = []
  for (const entry of sample) {
    try {
      const status = receiptStatus(root, entry)
      if (status !== 'ok') bad.push(`${entry.id}: ${status}`)
    } catch (error) {
      bad.push(`${entry.id}: ${error?.message ?? error}`)
    }
  }
  if (bad.length === 0) return ok('receipts', label, `${sample.length} 条全 ok`)
  return warn(
    'receipts',
    label,
    bad.join('\n'),
    '`needs-reseed` 是 0.1.1 之前的老哈希，重写这条记忆即可；`tampered` 说明正文被手改过 —— 回执就是干这个的。',
  )
}

function checkRoutes(root) {
  const label = '目录 README 路由'
  try {
    const report = routeReport(root, { useCache: false })
    if (report.ok) return ok('routes', label, summarizeRoutes(report))
    const problems = []
    for (const dir of report.missingReadme) problems.push(`${dir || '仓库根'}/ 缺 README.md`)
    for (const item of report.unlisted.slice(0, 5)) problems.push(`${item.dir || '仓库根'}/${item.file} 未登记`)
    for (const item of report.missing.slice(0, 5)) problems.push(`${item.dir || '仓库根'}/README.md 登记了不存在的 ${item.entry}`)
    return warn('routes', label, problems.join('\n'), '`node scripts/check.mjs` 会以非零退出码拦它（这是 CI 硬门）')
  } catch (error) {
    return warn('routes', label, `检查失败：${error?.message ?? error}`, '路由检查自己崩了；不要静默通过')
  }
}

function checkClient(root) {
  const label = '客户端产物与源一致'
  const script = join(root, 'scripts', 'build-client.mjs')
  if (!existsSync(script)) return skip('client', label, '没有构建脚本')
  try {
    execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe', cwd: root })
    return ok('client', label, '一致')
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]
    return fail('client', label, message, '跑 `node scripts/build-client.mjs` 重新生成并提交产物 —— 界面上看到的可能是旧代码')
  }
}

/* ── 编排 ─────────────────────────────────────────────────────────── */

/**
 * 跑一遍自检。
 *
 * **只读**：不建目录、不写文件、不改配置。
 *
 * @param {string} [root] 仓库根；默认本脚本所在仓库
 * @param {{ only?: string[], skip?: string[] }} [options]
 * @returns {Promise<{ checks: Array<{ id: string, label: string, level: string, detail: string|null, hint: string|null }>, ok: boolean, errors: number, warnings: number }>}
 */
export async function runDoctor(root = REPO_ROOT, options = {}) {
  const only = options.only ? new Set(options.only) : null
  const skipIds = new Set(options.skip ?? [])
  const checks = []

  /**
   * 懒加载 `lib/` —— doctor 要在**插件加载失败时**也能跑。
   * 顶层 import 一个坏模块会让「检查器」和「被检查的东西」一起挂掉。
   */
  const load = async () => {
    const store = await import('../lib/store.js')
    const indexBuild = await import('../lib/index-build.js')
    return { layout: store.layout(root), readAll: store.readAll, receiptStatus: store.receiptStatus, readSnapshot: indexBuild.readSnapshot }
  }

  const peers = await checkPeers()
  checks.push(peers)
  const peersOk = peers.level === 'ok'

  checks.push(checkNode())
  checks.push(await checkModules(root))

  if (peersOk) {
    const lib = await load()
    checks.push(checkLayout(root, lib.layout))
    checks.push(checkConfig(root, lib.layout))
    checks.push(checkSnapshot(root, lib.layout, lib.readSnapshot))
    checks.push(checkInbox(lib.layout))
    checks.push(checkReceipts(root, lib.layout, lib.readAll, lib.receiptStatus))
  } else {
    for (const id of ['layout', 'config', 'snapshot', 'inbox', 'receipts']) {
      checks.push(skip(id, id, 'peer 依赖没解析 —— 这一项没法跑'))
    }
  }

  checks.push(checkRoutes(root))
  checks.push(checkClient(root))

  const filtered = checks.filter((check) => (!only || only.has(check.id)) && !skipIds.has(check.id))
  const errors = filtered.filter((check) => check.level === 'error').length
  const warnings = filtered.filter((check) => check.level === 'warn').length
  return { checks: filtered, ok: errors === 0, errors, warnings }
}

const GLYPH = { ok: '✓', warn: '⚠', error: '✗', skip: '·' }
const LABEL = { ok: 'ok', warn: 'warn', error: 'FAIL', skip: 'skip' }

/** 渲染成人类可读的文本（`--json` 走 `JSON.stringify`）。 */
export function renderDoctor(report) {
  const lines = []
  for (const check of report.checks) {
    lines.push(`${GLYPH[check.level]} ${check.label} — ${LABEL[check.level]}`)
    if (check.detail) {
      for (const line of String(check.detail).split('\n')) lines.push(`    ${line}`)
    }
    if (check.hint) {
      for (const line of String(check.hint).split('\n')) lines.push(`    → ${line}`)
    }
  }
  lines.push('')
  if (report.ok) {
    lines.push(
      report.warnings > 0
        ? `自检通过（${report.warnings} 条警告）。警告不影响退出码，但每一条都对应一个「什么都没发生」的失败模式。`
        : '自检通过，全部正常。',
    )
  } else {
    lines.push(`自检失败：${report.errors} 条错误。上面每一条都给了修法。`)
  }
  return lines.join('\n')
}

/* ── 入口 ─────────────────────────────────────────────────────────── */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const report = await runDoctor(REPO_ROOT)
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(renderDoctor(report))
  process.exitCode = report.ok ? 0 : 1
}
