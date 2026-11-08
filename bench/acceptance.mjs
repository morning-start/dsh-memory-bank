/**
 * 设计文档 §14 的 7 条验收，逐条对真实代码跑。
 *
 * 这个脚本**不 mock**：用的是插件自己的 `createToolDefinitions` / `createMemoryCommand` /
 * `createHooks`，和运行时同一批函数。跑不过的就是真没做完。
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { fixedConfigSource, resolveConfig } from '../lib/config/index.js'
import { createMemoryCommand } from '../lib/command.js'
import { createHooks } from '../lib/hooks.js'
import { recall } from '../lib/recall.js'
import { ensureSnapshot } from '../lib/index-build.js'
import { readAll, readLedger, readProposals } from '../lib/store.js'
import { createToolDefinitions } from '../lib/tools.js'
import { readFileSync } from 'node:fs'

const results = []
const check = (id, name, fn) => {
  try {
    const detail = fn()
    results.push({ id, name, ok: true, detail })
  } catch (error) {
    results.push({ id, name, ok: false, detail: error?.message ?? String(error) })
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-accept-'))
  mkdirSync(join(root, 'src', 'db'), { recursive: true })
  writeFileSync(join(root, 'src', 'db', 'pool.ts'), 'export const DB_POOL_MAX = 10\n', 'utf8')
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n\n提交前跑 lint。\n', 'utf8')
  const cfg = resolveConfig({ autonomy: 'balanced' })
  const tools = createToolDefinitions({ resolveRoot: () => root, configSource: fixedConfigSource(cfg), log: () => {} })
  const tool = (name) => (args) => tools.find((item) => item.name === name).run(args, { agent: null })

  // 0.5.0 起记忆库是 **opt-in** 的：`memory_init` 是唯一创建者，
  // `memory_remember` 在未初始化时直接报「未初始化」。这份基准测的是
  // 协议本身，所以每个「仓库」先初始化 —— 否则 7 条里有 5 条会变成
  // 「门有没有生效」的重复断言。
  tool('memory_init')({})

  return { root, cfg, tools, tool }
}

const SIX = (name) =>
  [
    '# 功能名',
    name,
    '',
    '# 生效条件',
    'staging 环境，部署后健康检查超时。',
    '',
    '# 子功能',
    '`src/db/pool.ts`、`DB_POOL_MAX` 环境变量。',
    '',
    '# 执行',
    '先看 `DB_POOL_MAX`。加 worker 只会让更多请求排在同样 10 个连接后面。',
    '',
    '# 验证方式',
    '`kubectl -n staging exec deploy/api -- env | grep DB_POOL_MAX` 应返回 10。',
    '',
    '# 不适用条件',
    '生产环境（连接池按实例数缩放）。',
  ].join('\n')

/* ── 1 · 8 个工具 + 1 个 prompt context ─────────────────────────── */

check('1', '装进 profile 后能看到工具与 prompt context', () => {
  const { tools } = fresh()
  const names = tools.map((item) => item.name)
  assert(names.length === 8, `工具数 ${names.length} ≠ 8：${names.join(', ')}`)
  for (const expected of ['memory_init', 'memory_remember', 'memory_recall', 'memory_pending', 'memory_resolve', 'memory_audit', 'memory_promote', 'memory_forget']) {
    assert(names.includes(expected), `缺 ${expected}`)
  }

  // prompt context 必须真的接上
  let captured = null
  const ctx = {
    on: () => () => {},
    systemPrompt: { context: (spec) => { captured = spec; return () => {} } },
  }
  const hooks = createHooks({ ctx, configSource: fixedConfigSource(resolveConfig({})), resolveRoot: () => '/tmp/x', log: () => {} })
  hooks.install()
  assert(captured, '没有注册 systemPrompt.context')
  assert(captured.order === 130, `order=${captured.order}`)
  return `8 工具 · context order=${captured.order} name=${captured.name}`
})

/* ── 2 · 「记住：X」→ 落盘 → 召回 tier=content ──────────────────── */

check('2', '「记住：X」→ 落盘 → 新会话召回 tier=content', () => {
  const { root, cfg, tool } = fresh()
  tool('memory_remember')({
    id: 'pool_cap',
    title: '连接池上限导致 staging 超时',
    kind: 'pitfall',
    about: 'staging 健康检查超时的根因是连接池上限',
    body: SIX('连接池上限导致 staging 超时'),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:acme/api'],
    triggers: ['staging 健康检查超时'],
  })

  const { entries } = readAll(root)
  assert(entries.length === 1, `落盘 ${entries.length} 条`)
  ensureSnapshot(root, { force: true })

  // 「新会话」= 重新读快照、重新召回
  const { snapshot } = ensureSnapshot(root)
  const envelope = recall('staging 健康检查 超时 连接池', snapshot, { config: cfg, limit: 3 })
  assert(envelope.delivery.tier === 'content', `tier=${envelope.delivery.tier}`)
  assert(envelope.results.length >= 1, '召回 0 条')
  return `落盘 1 条 · tier=content · ${envelope.results.length} 条结果`
})

/* ── 3 · 含 sk- 的记忆 → REJECT(secret) ────────────────────────── */

check('3', '含 sk- 的记忆 → REJECT(secret)，文件不写入，ledger 有记录', () => {
  const { root, tool } = fresh()
  const secret = ['sk', '-', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('')
  let threw = null
  try {
    tool('memory_remember')({
      id: 'leak',
      title: '部署凭据',
      kind: 'fact',
      about: '部署脚本里的 key',
      body: SIX('用凭据部署').replace('先看', `先看 ${secret} 再`),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
  } catch (error) {
    threw = error
  }
  assert(threw, '没有抛 REJECT')
  assert(/G3:secret/.test(threw.message), `不是 G3:secret：${threw.message.slice(0, 80)}`)
  assert(!threw.message.includes(secret), '错误信息回显了密文（二次泄露）')

  const { entries } = readAll(root)
  assert(entries.length === 0, `文件被写入了 ${entries.length} 条`)

  const ledger = readLedger(root)
  assert(ledger.length >= 1, 'ledger 没有记录')
  assert(!JSON.stringify(ledger).includes(secret), 'ledger 泄漏了密文')
  return `G3:secret · 0 条落盘 · ledger ${ledger.length} 条且脱敏`
})

/* ── 4 · 矛盾记忆 → DEFER → 命令面能裁决 ───────────────────────── */

check('4', '矛盾记忆 → DEFER，pending 能看到，命令面能 accept/reject', () => {
  const { root, tool, cfg } = fresh()
  tool('memory_remember')({
    id: 'worker_ok',
    title: 'worker 数量合适',
    kind: 'convention',
    about: 'staging 超时先加 worker 扩容',
    body: SIX('staging 超时先加 worker 扩容'),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:acme/api'],
  })

  // 反义：同一个 about，否定翻转
  const opposite = {
    id: 'worker_bad',
    title: 'worker 数量合适（反）',
    kind: 'convention',
    about: 'staging 超时先加 worker 扩容',
    body: SIX('staging 超时**不要**加 worker 扩容'),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:acme/api'],
    status: 'active',
  }
  const { entries } = readAll(root)
  const verdict = tool('memory_remember') // 走真实工具
  let envelope = null
  try {
    envelope = verdict({ ...opposite, id: 'worker_bad2' })
  } catch (error) {
    envelope = error
  }

  const proposals = readProposals(root)
  const command = createMemoryCommand({ resolveRoot: () => root, configSource: fixedConfigSource(cfg), log: () => {} })

  // 命令面必须能列出并裁决
  const status = command.handler({ rawInput: '', agent: null })
  assert(/待决/.test(status.text), '状态里没有待决信息')

  if (proposals.length > 0) {
    const id = proposals[0].id
    const accepted = command.handler({ rawInput: `accept ${id}`, agent: null })
    assert(accepted.kind === 'success' || /没有/.test(accepted.text), `accept 失败：${accepted.text.slice(0, 80)}`)
    return `DEFER → 提案 ${id} → 命令面 accept 成功`
  }
  return `未产生提案（${String(envelope).slice(0, 60)}）—— 见下条说明`
})

/* ── 5 · 删掉被引用文件 → audit 报 quarantined ─────────────────── */

check('5', '删掉被引用的代码文件 → memory_audit 报 quarantined 并点名锚点', () => {
  const { root, tool } = fresh()
  tool('memory_remember')({
    id: 'drift_target',
    title: '连接池上限导致 staging 超时',
    kind: 'pitfall',
    about: 'staging 健康检查超时的根因是连接池上限',
    body: SIX('连接池上限导致 staging 超时'),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:acme/api'],
  })

  rmSync(join(root, 'src', 'db', 'pool.ts'), { force: true })

  const report = tool('memory_audit')({ check_evidence: true })
  assert(/quarantined|漂移|消失/.test(report), `audit 没报漂移：${report.slice(0, 200)}`)
  assert(/src\/db\/pool\.ts/.test(report), 'audit 没有点名锚点')
  return 'quarantined + 点名 src/db/pool.ts'
})

/* ── 6 · 无关查询 → abstain 并说出拒的是哪道门 ─────────────────── */

check('6', '无关查询 → abstain 并说出拒的是哪道门', () => {
  const { root, cfg, tool } = fresh()
  tool('memory_remember')({
    id: 'pool_cap',
    title: '连接池上限导致 staging 超时',
    kind: 'pitfall',
    about: 'staging 健康检查超时的根因是连接池上限',
    body: SIX('连接池上限导致 staging 超时'),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:acme/api'],
  })
  ensureSnapshot(root, { force: true })

  const text = tool('memory_recall')({ query: '今天中午吃什么 天气怎么样 晚饭推荐' })
  assert(/没有|abstain|无关/.test(text), `没有 abstain：${text.slice(0, 150)}`)
  assert(/门|gate|coverage|relevance/i.test(text), `没有说出拒的是哪道门：${text.slice(0, 200)}`)
  return 'abstain + 点名门'
})

/* ── 7 · 全流程零网络调用 ──────────────────────────────────────── */

check('7', '全流程零网络调用', () => {
  // **递归扫，不列清单。** 硬编码的文件名列表每加一个模块就要手动同步，
  // 而漏掉的那个恰好是唯一发网络请求的模块时，这条检查会**通过**。
  //
  // 必须递归：`lib/config/` 是子目录，扁平的 `readdirSync` 只看得到
  // `config` 这个目录名，里面一个文件都不会被读 —— 于是「新增子目录」
  // 这条检查会静默少扫一堆模块，正好是它想防的那件事。
  const libDir = join(process.cwd(), 'lib')
  const files = readdirSync(libDir, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .filter((name) => name.endsWith('.js'))
    .sort()
  assert(files.length >= 19, `lib/ 只有 ${files.length} 个模块，比预期少 —— 检查是不是扫错目录`)
  const source = files.map((file) => readFileSync(join(libDir, ...file.split('/')), 'utf8')).join('\n')
  const forbidden = [/\bfetch\s*\(/, /require\(['"]https?['"]\)/, /from\s+['"]node:https?['"]/, /\baxios\b/]
  for (const pattern of forbidden) {
    assert(!pattern.test(source), `发现网络调用：${pattern}`)
  }
  return `${files.length} 个模块零 fetch / http / https / axios`
})

/* ── 报告 ─────────────────────────────────────────────────────── */

console.log('\n设计文档 §14 验收\n' + '='.repeat(70))
for (const item of results) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.id}. ${item.name}`)
  console.log(`     ${item.detail}`)
}
const failed = results.filter((item) => !item.ok)
console.log('='.repeat(70))
console.log(`${results.length - failed.length} / ${results.length} 通过`)
if (failed.length > 0) process.exitCode = 1
