/**
 * 面板服务（`lib/host/`）的**真实**测试：临时目录 + 真文件 + 真召回。
 *
 * 这一份补的是「面板和命令面是同一份实现」这条硬约束（`docs/07` §3 阶段 B +
 * §6 风险表最后一行）的可执行证明 —— 0.1.1 的教训是「两套实现」这类 bug
 * **不会有任何测试变红**，所以每条约束都必须有一条能独立复现的用例。
 *
 * ## 依赖分层
 *
 * | 组 | 依赖 | 没有依赖时 |
 * |---|---|---|
 * | 查询 / 写操作 / 守卫 | 只有 `lib/**` | 永远跑 |
 * | 面板服务 / Typert 派发 | `@deepseek-ai/dsh-typert-protocol`（peer） | **skip**，并说清缺什么 |
 *
 * 后三组和 `test/plugin.test.mjs` 对 `@deepseek-ai/schemastery` 的处理一样：
 * 它们是宿主在运行时提供的 peer 依赖，CI 上没有 profile 的机器不该因此变红。
 * 但**不要用替身骗过它** —— 那会把「Typert 接线是否成立」变成一句没人验证的
 * 断言。真实环境里的验收在 README 的清单里。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createMemoryCommand } from '../lib/command.js'
import { createConfigSource } from '../lib/config/index.js'
import { MUTATIONS, METHODS, NAMESPACE, QUERIES } from '../shared/endpoints.js'

import { AsyncMutationError, ConfirmRequiredError, StaleRevisionError, WriteLockedError, createGuards } from '../lib/host/guards.js'
import { createMutations } from '../lib/host/mutations.js'
import { createQueries, readQuotaState } from '../lib/host/queries.js'
import { ensureLayout, layout, readAll, readProposals, writeEntry, writeInbox, writeProposal } from '../lib/store.js'
import { createToolDefinitions } from '../lib/tools.js'

/* ── 可选 peer 依赖 ───────────────────────────────────────────────── */

/** 缺包时返回 `undefined`（而不是抛）—— 让「没装 profile」退化成 skip。 */
async function optionalImport(specifier) {
  try {
    return await import(specifier)
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  }
}

const protocol = await optionalImport('@deepseek-ai/dsh-typert-protocol')
const cordis = await optionalImport('@deepseek-ai/cordis')
const hostService = protocol && cordis ? await optionalImport('../lib/host/service.js') : undefined
const typertHost = await optionalImport('../lib/typert.host.js')
const typertRemoteClient = await optionalImport('../lib/typert.remote-client.js')
const typertLoader = await optionalImport('@deepseek-ai/dsh-typert-loader')
const apiGateway = await optionalImport('@deepseek-ai/dsh-api-gateway')

const PEER_REASON = '需要 @deepseek-ai/dsh-typert-protocol（宿主在运行时提供的 peer 依赖）'

/* ── 语料夹具 ─────────────────────────────────────────────────────── */

/** 六要素正文。G2 读标题，缺一个就 refuse —— 夹具必须能过协议。 */
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
    '生产环境（连接池按实例数缩放，不是固定值）。',
  ].join('\n')

const MEMORY_ID = 'staging_timeout_pool_cap'
const PROPOSAL_ID = 'p_test_0001'

function candidate(overrides = {}) {
  return {
    id: MEMORY_ID,
    title: 'staging 超时先查连接池上限',
    kind: 'pitfall',
    about: 'staging 部署健康检查超时的排查顺序',
    body: SIX('staging 部署健康检查超时，根因是连接池上限，不是 worker 数。'),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts:1' }],
    scope: ['repo:acme/api'],
    triggers: ['staging 健康检查超时', 'DB_POOL_MAX'],
    confidence: 'verified',
    actionRisk: 'R1',
    provenance: 'measured',
    ...overrides,
  }
}

let root
let configSource
let guards
let queries
let mutations

/** 造一条待决提案（走 store 的**真实**写入路径，不是内联 JSON）。 */
function seedProposal(id = PROPOSAL_ID, overrides = {}) {
  writeProposal(root, {
    id,
    candidate: candidate(overrides),
    // 判不了的是 G8（置信门）—— 最常见的 DEFER 来源。
    gates: [{ gate: 'G8', kind: 'refuse', code: 'confidence.low', detail: { confidence: 0.5 } }],
    why: ['G8:confidence.low'],
    status: 'pending',
  })
  return id
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-host-'))
  mkdirSync(join(root, 'src', 'db'), { recursive: true })
  // G1 的「已有主人」文档 + G4 的锚点目标。少一个夹具就永远过不了硬门。
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n\n提交前跑 lint 和单测，不要跳过 hook。\n', 'utf8')
  writeFileSync(join(root, 'src', 'db', 'pool.ts'), 'export const DB_POOL_MAX = 10\n', 'utf8')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@acme/api' }, null, 2)}\n`, 'utf8')

  // `env: {}` 隔离真实环境变量 —— 否则开发机上的 `DSH_MEMORY_AUTONOMY`
  // 会让「默认值」的断言在一台机器上绿、另一台上红。
  configSource = createConfigSource({ rowConfig: {}, env: {} })
  guards = createGuards()
  queries = createQueries({ configSource })
  mutations = createMutations({ configSource, guards, log: () => {} })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/* ── 1 · 查询：数字必须与 /memory status 逐字一致 ─────────────────── */

describe('queries · 与 /memory status 同源', () => {
  it('overview 的每个数字都能在 /memory status 文本里找到', async () => {
    // 造出「各种都不为零」的语料，否则全 0 的断言证明不了同源。
    writeEntry(root, candidate({ claims: [{ kind: 'pull-request', ref: 'api#10', state: 'open', evidence: 'PR #10 is open' }] }))
    seedProposal()
    writeInbox(root, { id: 'i_one' })

    const overview = queries.overview(root)
    assert.equal(overview.root, root)
    assert.equal(overview.active, 1)
    assert.equal(overview.pending, 1)
    assert.equal(overview.inbox, 1)
    assert.equal(overview.problems, 0)
    assert.equal(overview.claims.open, 1)
    assert.equal(overview.quota.used, 1)
    assert.equal(overview.quota.mode, 'growth')

    const command = createMemoryCommand({ resolveRoot: () => root, configSource, log: () => {}, mutations })
    const status = await command.handler({ rawInput: 'status', agent: null })
    assert.equal(status.kind, 'success', status.text)

    assert.match(
      status.text,
      new RegExp(`活跃 ${overview.active} 条 · 待决 ${overview.pending} 条 · 后台队列 ${overview.inbox} 条 · 坏文件 ${overview.problems} 个`),
    )
    assert.match(
      status.text,
      new RegExp(
        `open ${overview.claims.open}（可行动 ${overview.claims.openActionable}）· contradicted ${overview.claims.contradicted} · unverified ${overview.claims.unverified}`,
      ),
    )
    assert.match(
      status.text,
      new RegExp(`休眠 ${overview.lifecycle.dormant} · 到期复查 ${overview.lifecycle.reviewDue} · 已过期 ${overview.lifecycle.expired}`),
    )
  })

  it('pending 最新在前，并按 limit 截断', () => {
    for (const id of ['p_test_0001', 'p_test_0002', 'p_test_0003']) seedProposal(id)
    const page = queries.pending(root, 2)
    assert.equal(page.total, 3)
    assert.deepEqual(
      page.items.map((item) => item.id),
      ['p_test_0003', 'p_test_0002'],
    )
    assert.equal(page.items[0].kind, 'candidate')
    assert.deepEqual(page.items[0].gates, ['G8'])
    assert.equal(page.items[0].confidence, 'verified')
  })

  it('memories 空查询退化为「最近更新」，非空查询走真实召回', () => {
    writeEntry(root, candidate())
    writeEntry(root, candidate({ id: 'other_memory', title: '连接池上限是十', about: '另一个话题', body: SIX('另一个话题') }))

    const recent = queries.memories(root, '', 10)
    assert.equal(recent.length, 2)
    // 最近更新的在前（两次写入时间可能相同 → 只断言集合与形状）
    assert.deepEqual(recent.map((item) => item.id).sort(), [MEMORY_ID, 'other_memory'].sort())
    assert.equal(recent[0].status, 'active')
    assert.equal(recent[0].lastRecalledAt, null, '从没被召回就是 null，不是空串')

    const recalled = queries.memories(root, 'staging 健康检查超时 连接池', 3)
    assert.ok(recalled.length >= 1)
    assert.equal(recalled[0].id, MEMORY_ID)
  })

  it('drift 把「目标消失」单独成桶（不是 healthy）', () => {
    writeEntry(
      root,
      candidate({
        id: 'missing_anchor',
        evidence: [{ kind: 'file', ref: 'src/does-not-exist.ts:1' }],
      }),
    )
    const report = queries.drift(root)
    assert.equal(report.counts.quarantined, 1)
    assert.equal(report.counts.advisory, 0)
    assert.equal(report.quarantined[0].id, 'missing_anchor')
    assert.equal(report.quarantined[0].bucket, 'quarantined')
    assert.match(report.quarantined[0].detail, /文件不存在/)
  })

  it('claims 把矛盾算成 open 的子集，不是第四类', () => {
    writeEntry(
      root,
      candidate({
        claims: [
          { kind: 'pull-request', ref: 'api#10', state: 'open', evidence: 'PR #10 is open' },
          { kind: 'issue', ref: 'api#11', state: 'unverified', evidence: 'issue #11' },
        ],
      }),
    )
    const claims = queries.claims(root)
    assert.equal(claims.open, 1)
    assert.equal(claims.unverified, 1)
    assert.equal(claims.resolved, 0)
    assert.equal(claims.total, 2)
    assert.equal(claims.contradicted, 0)
  })

  it('ledger 尾部按时间线读，且不丢非标准 kind', async () => {
    seedProposal()
    await mutations.accept(root, PROPOSAL_ID)
    const entries = queries.ledger(root, 10)
    assert.ok(entries.length >= 1)
    assert.equal(entries.at(-1).kind, 'resolve')
    assert.equal(entries.at(-1).decision, 'accepted')
    assert.equal(entries.at(-1).action, 'accept')
  })

  it('配额锁坏了降级回 growth —— 否则 limit=used，全库只读', () => {
    ensureLayout(root)
    writeFileSync(join(layout(root).base, 'quota.lock.json'), '{"mode":"ratchet"}\n', 'utf8')
    assert.equal(readQuotaState(root), null)
    assert.equal(queries.overview(root).quota.mode, 'growth')

    writeFileSync(join(layout(root).base, 'quota.lock.json'), '{"mode":"ratchet","maxActive":50}\n', 'utf8')
    assert.equal(readQuotaState(root)?.mode, 'ratchet')
    assert.equal(queries.overview(root).quota.limit, 50)
    assert.equal(queries.overview(root).quota.mode, 'ratchet')
  })
})

/* ── 2 · 配置快照：来源与可写性 ───────────────────────────────────── */

describe('queries · config 的来源 / 可写性', () => {
  const fieldOf = (snapshot, path) => snapshot.fields.find((field) => field.path === path)

  it('默认层：全部可写，仓库属性标 projectScoped', () => {
    const snapshot = queries.config(root)
    assert.ok(Array.isArray(snapshot.groups) && snapshot.groups.length === 6)
    assert.ok(snapshot.projectPath.endsWith(join('.dsh-memory', 'config.json')))
    assert.deepEqual(snapshot.problems, [])

    const autonomy = fieldOf(snapshot, 'autonomy')
    assert.equal(autonomy.source, 'default')
    assert.equal(autonomy.writable, true)
    assert.equal(autonomy.value, 'balanced')
    assert.equal(autonomy.projectScoped, false, 'autonomy 是用户偏好，不是仓库属性')

    const captureEnabled = fieldOf(snapshot, 'capture.enabled')
    assert.equal(captureEnabled.projectScoped, true, 'capture 是仓库属性（界面 3 的抽屉）')
    assert.equal(captureEnabled.projectWritable, true)
  })

  it('环境变量层：source=env 且 writable=false（改这里不生效）', () => {
    const envSource = createConfigSource({ rowConfig: {}, env: { DSH_MEMORY_AUTONOMY: 'manual' } })
    const snapshot = createQueries({ configSource: envSource }).config(root)
    const autonomy = fieldOf(snapshot, 'autonomy')
    assert.equal(autonomy.source, 'env')
    assert.equal(autonomy.value, 'manual')
    assert.equal(autonomy.writable, false, '环境变量任何文件都盖不住，输入框必须 disabled')
    assert.equal(autonomy.projectWritable, false)
  })

  it('项目层：写进去之后 source=project，且坏 JSON 会出现在 problems 里', async () => {
    const written = await mutations.setProjectConfig(root, { capture: { enabled: false } })
    assert.equal(written.ok, true, written.error)
    assert.ok(existsSync(join(layout(root).base, 'config.json')))

    const snapshot = queries.config(root)
    const captureEnabled = fieldOf(snapshot, 'capture.enabled')
    assert.equal(captureEnabled.source, 'project')
    assert.equal(captureEnabled.value, false)
    assert.equal(captureEnabled.writable, true)

    // 坏文件必须**可见**地降级，不能静默
    writeFileSync(join(layout(root).base, 'config.json'), '{ "capture": \n', 'utf8')
    configSource.invalidate(root)
    assert.ok(queries.config(root).problems.length > 0, 'config.json 坏了必须报 problems')
  })

  it('projectConfig 读的是原始文件，不经过合并', () => {
    const project = queries.projectConfig(root)
    assert.equal(project.exists, false)
    assert.equal(project.path, join(layout(root).base, 'config.json'))
  })
})

/* ── 3 · 写操作 ───────────────────────────────────────────────────── */

describe('mutations · 裁决', () => {
  it('accept 一条待决 → 文件出现，且 memory_recall 能召回', async () => {
    seedProposal()
    const result = await mutations.accept(root, PROPOSAL_ID)
    assert.equal(result.ok, true, result.error)
    assert.match(result.text, /已接受/)
    assert.equal(result.value.id, MEMORY_ID)

    assert.ok(existsSync(join(layout(root).memories, `${MEMORY_ID}.md`)), '记忆文件必须落盘')
    assert.deepEqual(readProposals(root), [], '待决队列必须清空')
    assert.equal(readAll(root).entries[0].status, 'active')

    // **跨面一致性**：工具面的 memory_recall 必须能召回面板接受的那条
    const tools = createToolDefinitions({ resolveRoot: () => root, configSource, log: () => {} })
    const recall = tools.find((tool) => tool.name === 'memory_recall')
    const text = await recall.run({ query: 'staging 健康检查超时 连接池' }, { agent: null })
    assert.match(text, /staging 超时先查连接池上限/)
  })

  it('reject → 进 pending/rejected/ 留档，不参与召回', async () => {
    seedProposal()
    const result = await mutations.reject(root, PROPOSAL_ID, '不成立')
    assert.equal(result.ok, true, result.error)
    assert.match(result.text, /已拒绝/)
    assert.ok(existsSync(join(layout(root).rejected, `${PROPOSAL_ID}.json`)))
    assert.deepEqual(readProposals(root), [])

    const archived = JSON.parse(readFileSync(join(layout(root).rejected, `${PROPOSAL_ID}.json`), 'utf8'))
    assert.ok(archived.rejectedAt, '留档必须带时间戳（「为什么没进来」的唯一答案）')
  })

  it('accept 不存在的提案 → ok:false + code not-found（不是抛）', async () => {
    const result = await mutations.accept(root, 'p_nope_0000')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-found')
    assert.match(result.error, /没有这条提案/)
  })

  it('edit 只认内容字段；身份 / 生命周期字段被丢掉', async () => {
    seedProposal()
    const result = await mutations.edit(root, PROPOSAL_ID, { title: '改过的标题', id: '别人的id', status: 'rejected' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.title, '改过的标题')
    assert.equal(result.value.id, MEMORY_ID, 'id 由系统管，patch 里的 id 必须被丢掉')
    assert.equal(result.value.status, 'active', 'status 由生命周期管')

    seedProposal('p_test_0002')
    const nothing = await mutations.edit(root, 'p_test_0002', { id: 'x' })
    assert.equal(nothing.ok, false)
    assert.equal(nothing.code, 'invalid-patch')
  })

  it('retire 转 deprecated，退出召回但正文保留', async () => {
    writeEntry(root, candidate())
    const result = await mutations.retire(root, MEMORY_ID, '过时了')
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.status, 'deprecated')

    const entries = readAll(root).entries
    assert.equal(entries.length, 1, '软删除不删文件')
    assert.equal(entries[0].status, 'deprecated')
  })

  it('**forget 不带 confirm 必须失败**，带了才删', async () => {
    writeEntry(root, candidate())
    const file = join(layout(root).memories, `${MEMORY_ID}.md`)

    for (const bad of [undefined, false, 'false', 1, 'true']) {
      const refused = await mutations.forget(root, MEMORY_ID, bad)
      assert.equal(refused.ok, false, `confirm=${JSON.stringify(bad)} 不能被当成确认`)
      assert.equal(refused.code, 'confirm-required')
      assert.ok(existsSync(file), '拒绝时不能删任何东西')
    }

    const deleted = await mutations.forget(root, MEMORY_ID, true)
    assert.equal(deleted.ok, true, deleted.error)
    assert.equal(existsSync(file), false)
  })

  it('dream 只暂存提案，不写记忆、不写关系', async () => {
    writeEntry(root, candidate())
    const before = readAll(root).entries.length
    const result = await mutations.dream(root)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.staged, 0, '一条孤立记忆不该凭空产生边')
    assert.equal(readAll(root).entries.length, before)
  })

  it('promote 只产出包，不写全局存储', async () => {
    writeEntry(root, candidate())
    const result = await mutations.promote(root, {})
    assert.equal(result.ok, true, result.error)
    assert.equal(typeof result.value.digest, 'string')
    assert.ok(Array.isArray(result.value.entries))
  })

  it('setProjectConfig / resetProjectConfig 走项目层文件', async () => {
    const written = await mutations.setProjectConfig(root, { quota: { repo: 50 } })
    assert.equal(written.ok, true, written.error)
    assert.match(written.text, /项目层/)

    const project = JSON.parse(readFileSync(join(layout(root).base, 'config.json'), 'utf8'))
    assert.equal(project.quota.repo, 50)

    const reset = await mutations.resetProjectConfig(root)
    assert.equal(reset.ok, true, reset.error)
    const after = JSON.parse(readFileSync(join(layout(root).base, 'config.json'), 'utf8'))
    assert.equal(after.quota, undefined, '重置写回只有文件头的文件（不是删文件）')
    assert.ok(existsSync(join(layout(root).base, 'config.json')))
  })
})

/* ── 4 · 面板 accept 与 /memory accept 是同一个函数 ──────────────── */

describe('双实现漂移：面板与命令面共用一份裁决', () => {
  it('命令面调用的就是面板注入的那个 mutations 对象', async () => {
    seedProposal()
    const command = createMemoryCommand({ resolveRoot: () => root, configSource, log: () => {}, mutations })

    let calls = 0
    const original = mutations.accept
    mutations.accept = function patched(...args) {
      calls += 1
      return original.apply(this, args)
    }

    const result = await command.handler({ rawInput: `accept ${PROPOSAL_ID}`, agent: null })
    assert.equal(calls, 1, '/memory accept 必须走共享实现')
    assert.equal(result.kind, 'success', result.text)
    assert.ok(existsSync(join(layout(root).memories, `${MEMORY_ID}.md`)))
  })

  it('/memory 的写子命令不再自己写盘（源码级断言）', () => {
    const source = readFileSync(new URL('../lib/command.js', import.meta.url), 'utf8')
    for (const forbidden of ['writeEntry(', 'appendReceipt(', 'removeProposal(', 'retireEntry(', 'writeProposal(']) {
      assert.equal(source.includes(forbidden), false, `lib/command.js 不该再直接调用 ${forbidden}—— 那是 mutations.js 的职责`)
    }
    assert.match(source, /from '\.\/host\/mutations\.js'/, 'lib/command.js 必须 import 共享实现')
  })
})

/* ── 5 · 守卫 ─────────────────────────────────────────────────────── */

describe('guards', () => {
  it('同一次调用栈里重入写锁 → WriteLockedError', () => {
    assert.throws(
      () =>
        guards.withWriteLock(root, () => {
          guards.withWriteLock(root, () => 1)
        }),
      WriteLockedError,
    )
    // 抛错之后锁必须释放，否则这个仓库永久只读
    assert.equal(guards.withWriteLock(root, () => 'ok'), 'ok')
  })

  it('revision 只在**成功**写入后 +1，对不上就 stale', async () => {
    const before = guards.revision(root)
    guards.withWriteLock(root, () => guards.bump(root))
    assert.equal(guards.revision(root), before + 1)

    assert.throws(() => guards.assertRevision(root, before), StaleRevisionError)
    assert.doesNotThrow(() => guards.assertRevision(root, guards.revision(root)))
    assert.doesNotThrow(() => guards.assertRevision(root, undefined), '不带 revision 的调用不做乐观检查')

    // 领域失败（ok:false）不算写入 —— 否则「拒绝一条不存在的提案」会让
    // 面板的 staged form 变脏，用户重试永远撞 stale-revision。
    const stable = guards.revision(root)
    const refused = await mutations.accept(root, 'p_nope_0000')
    assert.equal(refused.ok, false)
    assert.equal(guards.revision(root), stable, '失败的写不该推进 revision')
  })

  it('失败的写入不推进 revision', () => {
    const before = guards.revision(root)
    assert.throws(() =>
      guards.withWriteLock(root, () => {
        throw new Error('磁盘满')
      }),
    )
    assert.equal(guards.revision(root), before)
  })

  it('异步写操作被拒绝 —— 锁会在 await 处松开', () => {
    // 同步抛：`withWriteLock` 在拿到 thenable 时立刻拒绝，不排队。
    // 这条断言存在的意义是「将来有人给 mutation 加 await，这里会红」。
    assert.throws(() => guards.withWriteLock(root, async () => 1), AsyncMutationError)
  })

  it('confirm 只认 === true', () => {
    for (const bad of [undefined, null, false, 0, '', 'true', 1, []]) {
      assert.throws(() => guards.requireConfirm(bad), ConfirmRequiredError)
    }
    assert.doesNotThrow(() => guards.requireConfirm(true))
  })
})

/* ── 6 · Typert 接线（需要 peer 依赖） ───────────────────────────── */

describe('typert · 宿主面清单', { skip: typertHost ? false : '需要 lib/typert.host.js 可加载' }, () => {
  it('TYPERT 清单通过宿主校验器，且成员与 METHODS 同位', () => {
    const { TYPERT } = typertHost
    assert.equal(TYPERT.package, 'dsh-memory-bank')
    assert.equal(TYPERT.face, 'host')
    assert.deepEqual(TYPERT.invocations, [], '本包走 SRC 回退：没有严格 invocations（见 lib/typert.host.js 文件头）')

    const [service] = TYPERT.model.services
    assert.equal(service.key, NAMESPACE)
    assert.equal(service.exportName, 'default')
    assert.deepEqual(
      service.members.map((member) => member.name),
      [...METHODS],
    )

    if (typertLoader) {
      assert.doesNotThrow(() => typertLoader.validateTypertManifest('dsh-memory-bank', TYPERT))
    }
  })
})

describe('typert · 客户端面清单', { skip: typertRemoteClient ? false : '需要 lib/typert.remote-client.js 可加载（zod + remote-info）' }, () => {
  it('每个线上方法都有描述符，且 invoke 走「命名空间 → 方法」', async () => {
    const { TYPERT_REMOTE } = typertRemoteClient
    assert.equal(TYPERT_REMOTE.descriptors.length, METHODS.length)

    const remote = { [NAMESPACE]: { overview: async () => ({ active: 1 }), pending: async (limit) => ({ limit }) } }
    assert.deepEqual(await TYPERT_REMOTE.methods[`${NAMESPACE}/overview`].invoke(remote, {}), { active: 1 })
    assert.deepEqual(await TYPERT_REMOTE.methods[`${NAMESPACE}/pending`].invoke(remote, { limit: 5 }), { limit: 5 })
  })
})

describe('typert · 面板服务', { skip: hostService ? false : PEER_REASON }, () => {
  /** 每个用例一个独立 Context —— Cordis 的 service key 是 per-root 的。 */
  function createService() {
    const service = new hostService.MemoryBankService(new cordis.Context(), {}, { resolveRoot: () => root, configSource, guards })
    return service
  }

  it('super(ctx, memoryBank) + async 方法 → 原型上装好 @Remote 标记', () => {
    const service = createService()
    assert.equal(service.name, NAMESPACE)
    assert.equal(service.typertRemote.namespace, NAMESPACE)
    assert.equal(service.typertRemote.serviceKey, NAMESPACE)
    assert.equal(service.typertRemote.service, service)

    const markers = protocol.remoteMethods(service)
    assert.deepEqual(
      markers.map((marker) => marker.method),
      [...METHODS],
      '方法顺序 = shared/endpoints.js 的 METHODS 顺序',
    )
    for (const marker of markers) assert.deepEqual(marker.invocation, { kind: 'direct' })
  })

  it('实例化两次不会重复标记 / 不会抛（mark 幂等）', () => {
    createService()
    assert.doesNotThrow(() => createService())
  })

  it('17 个线上方法全部可调用，且写操作返回 MutationResult', async () => {
    const service = createService()
    seedProposal()

    assert.equal((await service.overview()).root, root)
    assert.equal((await service.pending(5)).total, 1)
    assert.deepEqual(await service.memories('staging 健康检查超时 连接池', 3), [])
    assert.equal((await service.drift()).counts.quarantined, 0)
    assert.equal((await service.claims()).open, 0)
    assert.ok(Array.isArray(await service.ledger(5)))
    assert.ok(Array.isArray((await service.config()).fields))
    // `ensureLayout` 会写一份默认模板，所以「存在」是正常的 —— 关键是路径与形状。
    assert.match((await service.projectConfig()).path, /config\.json$/u)

    const accepted = await service.accept(PROPOSAL_ID)
    assert.equal(accepted.ok, true, accepted.error)
    assert.equal(accepted.value.id, MEMORY_ID)

    seedProposal('p_test_0009')
    assert.equal((await service.reject('p_test_0009', '不成立')).ok, true)

    writeEntry(root, candidate({ id: 'editable_memory' }))
    assert.equal((await service.retire('editable_memory', '过时了')).ok, true)
    assert.equal((await service.forget('editable_memory', false)).code, 'confirm-required')
    assert.equal((await service.forget('editable_memory', true)).ok, true)

    assert.equal((await service.dream()).ok, true)
    assert.equal((await service.promote({})).ok, true)
    assert.equal((await service.setProjectConfig({ quota: { repo: 60 } })).ok, true)
    assert.equal((await service.resetProjectConfig()).ok, true)
  })

  it('网关的 SRC 派发真的能解析出每个端点（端到端，不是自证）', () => {
    if (!apiGateway) return // 没有网关包时退化为「标记形状」断言
    const service = createService()
    const fake = {
      ctx: {
        reflect: { props: { [NAMESPACE]: { type: 'service' } } },
        get: (key) => (key === NAMESPACE ? service : undefined),
        typert: { lookups: { definitions: () => [] }, contexts: { getHost: () => undefined } },
      },
      srcDescriptor: apiGateway.TypertGatewayService.prototype.srcDescriptor,
    }

    for (const method of METHODS) {
      const endpoint = `${NAMESPACE}/${method}`
      const descriptor = apiGateway.TypertGatewayService.prototype.resolveSrcDescriptor.call(fake, NAMESPACE, method, endpoint)
      assert.equal(descriptor.service, NAMESPACE)
      assert.equal(descriptor.namespace, NAMESPACE)
      assert.equal(descriptor.method, method)
      assert.equal(descriptor.result.mode, 'src-json')
      // 参数名必须与 shared/endpoints.js 的 args 一字不差 —— 网关按 wire 字段名
      // 精确匹配（`assertExactArguments`），差一个字母客户端就会被拒。
      const expected = [...Object.values(QUERIES), ...Object.values(MUTATIONS)].find((entry) => entry.method === method)?.args ?? []
      assert.deepEqual(
        descriptor.parameters.map((parameter) => parameter.wire),
        [...expected],
        `${endpoint} 的线上参数名漂移了`,
      )
    }
  })
})

/* ── 7 · 命令面回归（防止重构时丢掉旧行为） ────────────────────── */

describe('command · 薄壳之后行为不变', () => {
  it('status / 未知子命令 / 空库都不崩', async () => {
    const command = createMemoryCommand({ resolveRoot: () => root, configSource, log: () => {}, mutations })
    assert.equal((await command.handler({ rawInput: 'status', agent: null })).kind, 'success')
    assert.equal((await command.handler({ rawInput: 'nope', agent: null })).kind, 'error')
    assert.equal((await command.handler({ rawInput: 'pending', agent: null })).text, '没有待决提案。')
    assert.match((await command.handler({ rawInput: 'accept', agent: null })).text, /用法/)
  })

  it('accept 不存在的提案回错误而不是抛', async () => {
    const command = createMemoryCommand({ resolveRoot: () => root, configSource, log: () => {}, mutations })
    const result = await command.handler({ rawInput: 'accept p_nope_0000', agent: null })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /没有这条提案/)
  })
})
