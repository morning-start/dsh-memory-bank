/**
 * 断言对账的**写入口**（`docs/09` 的 P0-4）。
 *
 * 这一组钉住的是一类**静默数据丢失**：
 *
 * 0.2.0 里 `resolveClaim` / `syncClaims` / `rederiveClaims` 三个函数写了、
 * 测了、**没有任何生产调用者**。于是「后来学到的东西」这条主线整条是只读的 ——
 * 更糟的是，**重写一条记忆会把已学到的对账结果直接抹掉**，而没有任何提示。
 *
 * 所以用例的重点不是「能不能写」，是「**会不会悄悄丢掉**」。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { extractionDrift } from '../lib/claims.js'
import { fixedConfigSource } from '../lib/config/index.js'
import { defaultConfig } from '../lib/config/defaults.js'
import { serializeEntry } from '../lib/model.js'
import { ensureLayout, invalidateCorpus, readAll, writeProposal } from '../lib/store.js'
import { createToolDefinitions } from '../lib/tools.js'

const BODY = (extra = '') =>
  [
    '# 功能名',
    '连接池上限排查',
    '',
    '# 生效条件',
    'staging 健康检查超时先看 DB_POOL_MAX。',
    '',
    '# 子功能',
    '`src/db/pool.ts` 里的连接数配置。',
    '',
    '# 执行',
    '加 worker 只会让更多请求排在同样 10 个连接后面。',
    extra,
    '',
    '# 验证方式',
    '`kubectl exec` 读环境变量。',
    '',
    '# 不适用条件',
    '生产环境（连接池按实例数缩放）。',
  ].join('\n')

const CANDIDATE = (overrides = {}) => ({
  id: 'pool_cap',
  title: 'staging 连接池上限排查',
  kind: 'pitfall',
  about: 'staging 健康检查超时时先看连接池上限',
  body: BODY('相关 PR #10 还开着。'),
  evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
  scope: ['repo:acme/api'],
  ...overrides,
})

let root
let tools

const tool = (name) => {
  const definition = tools.find((item) => item.name === name)
  assert.ok(definition, `missing tool ${name}`)
  return (args) => definition.run(args, { agent: null })
}

const entryOf = (id) => readAll(root).entries.find((entry) => entry.id === id)
const claimsOf = (id) => entryOf(id)?.claims ?? []

/** 直接改写落盘的 claim（模拟「昨天裁决过」），走**真实**序列化器。 */
function patchClaimOnDisk(id, patch) {
  const entry = entryOf(id)
  const claims = entry.claims.map((claim, index) => (index === 0 ? { ...claim, ...patch } : claim))
  // `entry.path` 是**仓库相对**路径 —— 拿它直接写会落到 cwd 上。
  writeFileSync(join(root, entry.path), serializeEntry({ ...entry, claims }), 'utf8')
  // 绕过 `writeEntry` 就必须手动失效扫描缓存 —— 否则下一次 `readAll` 拿到的是
  // **改之前**的那份，用例会「通过」而其实什么都没验证。
  invalidateCorpus(root)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-reconcile-'))
  mkdirSync(join(root, 'src', 'db'), { recursive: true })
  writeFileSync(join(root, 'src', 'db', 'pool.ts'), 'export const DB_POOL_MAX = 10\n', 'utf8')
  // `PR #10` 没有 repo 限定 —— `extractClaims` 的纪律是「无法限定就丢弃，不猜」
  // （`claims.js:289`）。所以测试仓库必须有名字，否则抽不出任何 claim，
  // 整组用例会变成「什么都没发生」的假绿。
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'acme' }), 'utf8')
  tools = createToolDefinitions({ resolveRoot: () => root, configSource: fixedConfigSource(defaultConfig()), log: () => {} })

  // 0.5.0 起记忆库是 **opt-in** 的：`memory_remember` 在未初始化时直接报
  // 「未初始化」。这组用例测的是 `syncClaims` 接线，所以先把骨架建起来。
  ensureLayout(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/* ── 写入路径：syncClaims 必须接线 ───────────────────────────────── */

describe('重写记忆不能抹掉对账结果', () => {
  it('正文未动时，resolution 三列保留', () => {
    tool('memory_remember')(CANDIDATE())
    assert.ok(claimsOf('pool_cap').length > 0, '正文里的 `PR #10` 没被抽成 claim')

    patchClaimOnDisk('pool_cap', { resolvedState: 'resolved', resolvedBy: 'alice', resolvedAt: '2026-01-01T00:00:00Z' })

    // 只改 scope 重写 —— 正文一个字节都没动
    tool('memory_remember')(CANDIDATE({ scope: ['repo:acme/api', 'repo:acme/web'] }))

    const after = claimsOf('pool_cap')
    assert.equal(
      after[0]?.resolvedState,
      'resolved',
      '**对账结果被抹掉了** —— 重写走的是 extractClaims 而不是 syncClaims',
    )
    assert.equal(after[0]?.resolvedBy, 'alice')
  })

  it('正文**变了**才丢弃 resolution（syncClaims 的另一半）', () => {
    tool('memory_remember')(CANDIDATE())
    patchClaimOnDisk('pool_cap', { resolvedState: 'resolved', resolvedBy: 'alice', resolvedAt: '2026-01-01T00:00:00Z' })

    tool('memory_remember')(CANDIDATE({ body: BODY('相关 PR #11 还开着。') }))

    const after = claimsOf('pool_cap')
    const pr11 = after.find((claim) => claim.ref.includes('11'))
    assert.ok(pr11, `没抽出 PR #11：${JSON.stringify(after)}`)
    assert.equal(pr11.resolvedState, undefined, '正文变了还保留 resolution，是**把旧结论盖在新断言上**')
  })
})

/* ── memory_resolve 的 claims 补丁 ──────────────────────────────── */

describe('memory_resolve 的 claims 补丁', () => {
  const seedProposal = () => {
    // 提案的 `candidate` 必须是**已落盘**的那条 —— 只有它带 `claims`。
    // 用原始 `CANDIDATE()` 的话 `memory_resolve` 会看到「这条记忆没有 claim」，
    // 于是整组用例测的是「ref 不存在」那条分支，而不是写入口。
    const entry = entryOf('pool_cap')
    writeProposal(root, {
      id: 'p_test',
      candidate: {
        id: entry.id,
        title: entry.title,
        kind: entry.kind,
        about: entry.about,
        body: entry.body,
        evidence: entry.evidence,
        scope: entry.scope,
        triggers: entry.triggers,
        claims: entry.claims,
        // `provenance` / `confidence` 是 G2 形态门的必填枚举 —— 少了它们
        // `memory_resolve` 会在重跑硬门时以 `G2:shape` 拒绝，用例就测不到
        // 对账那条路径。
        provenance: entry.provenance,
        confidence: entry.confidence,
      },
      gates: [],
      why: ['test'],
      status: 'pending',
    })
  }

  it('写 resolution 三列，`state` 永不改写', () => {
    tool('memory_remember')(CANDIDATE())
    seedProposal()

    const before = claimsOf('pool_cap')[0]
    tool('memory_resolve')({
      proposalId: 'p_test',
      action: 'edit',
      edit: { claims: [{ kind: before.kind, ref: before.ref, resolvedState: 'resolved' }] },
    })

    const after = claimsOf('pool_cap')[0]
    assert.equal(after.resolvedState, 'resolved')
    assert.equal(after.resolvedBy, 'memory_resolve', '来源没记 —— 审计追不到是谁裁决的')
    assert.ok(after.resolvedAt, '没记裁决时间')
    assert.equal(after.state, before.state, '**`state` 被改写了** —— 散文是诚实的历史，不能改')
  })

  it('ref 不存在时**整次失败**，不写任何东西', () => {
    tool('memory_remember')(CANDIDATE())
    seedProposal()
    const before = JSON.stringify(claimsOf('pool_cap'))

    assert.throws(
      () =>
        tool('memory_resolve')({
          proposalId: 'p_test',
          action: 'edit',
          edit: { claims: [{ kind: 'pull-request', ref: 'PR #999 不存在', resolvedState: 'resolved' }] },
        }),
      /不存在/,
      '没命中的 ref 必须报错 —— 静默丢弃等于给别的断言盖章',
    )
    assert.equal(JSON.stringify(claimsOf('pool_cap')), before, '失败了却写进去了')
  })

  it('`edit.claims` 里塞 `state` 会被丢弃（白名单只留三列）', () => {
    tool('memory_remember')(CANDIDATE())
    seedProposal()
    const before = claimsOf('pool_cap')[0]

    tool('memory_resolve')({
      proposalId: 'p_test',
      action: 'edit',
      edit: { claims: [{ kind: before.kind, ref: before.ref, state: 'resolved', resolvedState: 'resolved' }] },
    })

    assert.equal(claimsOf('pool_cap')[0].state, before.state, '`state` 从 edit 漏进来了')
  })
})

/* ── extractionDrift ────────────────────────────────────────────── */

describe('extractionDrift', () => {
  const options = { namespaceDefaultRepo: 'acme' }

  it('没有 claim 的记忆不产生条目', () => {
    assert.deepEqual(extractionDrift([{ id: 'a', body: '没有断言' }], options), [])
  })

  it('是**报告**不是修复：不修改输入', () => {
    const entry = {
      id: 'a',
      body: '相关 PR #10 还没合并。',
      claims: [{ kind: 'pull-request', ref: 'acme#10', state: 'open' }],
    }
    const snapshot = JSON.stringify(entry)
    extractionDrift([entry], options)
    assert.equal(JSON.stringify(entry), snapshot, 'extractionDrift 改了输入 —— 它必须是纯读的')
  })

  it('存下来的 state 与重新抽取不一致时报告出来', () => {
    const entry = {
      id: 'a',
      body: '相关 PR #10 还没合并。',
      claims: [{ kind: 'pull-request', ref: 'acme#10', state: 'resolved' }],
    }
    const report = extractionDrift([entry], options)
    assert.equal(report.length, 1)
    assert.equal(report[0].id, 'a')
    assert.equal(report[0].changed[0].stored, 'resolved')
    assert.equal(report[0].changed[0].fresh, 'open')
  })
})
