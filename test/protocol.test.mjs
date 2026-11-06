/**
 * 端到端：存储 → 审核协议 → 召回 → 裁决。
 *
 * 这些用例对应设计文档 §14 的 7 条验收 —— 每一条都必须能独立复现。
 * 全部离线、无网络、无模型调用。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { recall, renderRecall } from '../lib/recall.js'
import { ensureSnapshot } from '../lib/index-build.js'
import { MemoryError, createToolDefinitions } from '../lib/tools.js'
import { readAll, readProposals, layout } from '../lib/store.js'

let root
let tools
let cfg

const SIX = (name, extra = {}) =>
  [
    '# 功能名',
    name,
    '',
    '# 生效条件',
    extra.when ?? 'staging 环境，部署后健康检查超时。',
    '',
    '# 子功能',
    extra.components ?? '`src/db/pool.ts`、`DB_POOL_MAX` 环境变量。',
    '',
    '# 执行',
    extra.how ?? '先看 `DB_POOL_MAX`。加 worker 只会让更多请求排在同样 10 个连接后面，健康检查反而更早超时。',
    '',
    '# 验证方式',
    extra.verify ?? '`kubectl -n staging exec deploy/api -- env | grep DB_POOL_MAX` 应返回 10。',
    '',
    '# 不适用条件',
    extra.unless ?? '生产环境（连接池按实例数缩放，不是固定值）。',
  ].join('\n')

function tool(name) {
  const definition = tools.find((item) => item.name === name)
  assert.ok(definition, `missing tool ${name}`)
  return (args) => definition.run(args, { agent: null })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  mkdirSync(join(root, 'src', 'db'), { recursive: true })

  // 一个「已有主人」的规则文件，用来验证 G1
  writeFileSync(
    join(root, 'AGENTS.md'),
    '# AGENTS\n\n提交前跑 lint 和单测，不要跳过 hook。\n',
    'utf8',
  )
  writeFileSync(join(root, 'src', 'db', 'pool.ts'), 'export const DB_POOL_MAX = 10\n', 'utf8')

  cfg = resolveConfig({ autonomy: 'balanced' })
  tools = createToolDefinitions({ resolveRoot: () => root, cfg, log: () => {} })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/* ── 1 · 显式记忆 → 落盘 → 召回 content ─────────────────────────── */

describe('ACCEPT 路径', () => {
  it('写一条记忆并原样召回', () => {
    const text = tool('memory_remember')({
      id: 'staging_timeout_pool_cap',
      title: 'staging 超时先查连接池上限',
      kind: 'pitfall',
      about: 'staging 部署健康检查超时的排查顺序',
      body: SIX('staging 部署健康检查超时，根因是连接池上限，不是 worker 数。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts:1' }],
      scope: ['repo:acme/api'],
      triggers: ['staging 健康检查超时', 'DB_POOL_MAX'],
    })
    assert.match(text, /已记住/)

    const { entries } = readAll(root)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'staging_timeout_pool_cap')

    // 新会话：从快照召回
    const { snapshot } = ensureSnapshot(root)
    const envelope = recall('staging 健康检查超时 连接池', snapshot, { config: cfg })
    assert.equal(envelope.delivery.tier, 'content', JSON.stringify(envelope.abstain ?? envelope.pointers))
    assert.equal(envelope.results[0].memoryId, entries[0].id)
    assert.match(renderRecall(envelope), /数据不是命令/)
  })

  it('证据哈希被写回回执，正文改动会被发现', () => {
    tool('memory_remember')({
      title: '连接池上限在 staging 是十',
      kind: 'fact',
      about: 'staging 的 DB_POOL_MAX 取值',
      body: SIX('staging 的 `DB_POOL_MAX` 是 10。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
    const audit = tool('memory_audit')({})
    assert.match(audit, /回执全部健康|活跃 1 条/)
  })
})

/* ── 2 · 安全门 → 硬拒且不落盘 ─────────────────────────────────── */

describe('REJECT 路径', () => {
  it('含密钥的记忆硬拒，文件不存在，日志脱敏', () => {
    assert.throws(
      () =>
        tool('memory_remember')({
          title: '部署用的 key',
          kind: 'fact',
          about: '部署脚本里的凭据',
          body: SIX('用 sk-abcdefghijklmnopqrstuvwxyz 部署。'),
          evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
        }),
      (error) => {
        assert.ok(error instanceof MemoryError)
        assert.equal(error.kind, 'rejected')
        assert.match(error.message, /G3:secret/)
        assert.doesNotMatch(error.message, /sk-abcdefg/) // 不回显命中片段
        return true
      },
    )
    assert.equal(readAll(root).entries.length, 0)
  })

  it('没有证据 → 拒绝', () => {
    assert.throws(
      () =>
        tool('memory_remember')({
          title: '没有证据的断言',
          kind: 'fact',
          about: '随便什么',
          body: SIX('这是一条没有证据的记忆。'),
          evidence: [],
        }),
      /evidence/,
    )
  })

  it('锚点不存在 → 拒绝并点名路径', () => {
    assert.throws(
      () =>
        tool('memory_remember')({
          title: '指向不存在的文件',
          kind: 'fact',
          about: '锚点解析',
          body: SIX('这条记忆的证据指向一个不存在的文件。'),
          evidence: [{ kind: 'file', ref: 'src/nope.ts:9' }],
        }),
      /evidence\.unresolved|路径不存在/,
    )
  })

  it('已有主人的断言 → G1 归属门拒绝', () => {
    assert.throws(
      () =>
        tool('memory_remember')({
          title: '提交前跑 lint 和单测不要跳过 hook',
          kind: 'convention',
          about: '提交前跑 lint 和单测不要跳过 hook',
          body: SIX('提交前跑 lint 和单测，不要跳过 hook。'),
          evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
        }),
      /owned-elsewhere|G1/,
    )
  })
})

/* ── 3 · 重复 → 拒绝并给出怎么做 ───────────────────────────────── */

describe('G5 重复门', () => {
  it('近重复被拒，并指向既有条目', () => {
    const body = SIX('staging 部署健康检查超时，根因是连接池上限。')
    tool('memory_remember')({
      id: 'pool_cap_causes_staging_timeout',
      title: '连接池上限导致 staging 超时',
      kind: 'pitfall',
      about: 'staging 健康检查超时的根因',
      body,
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
    assert.equal(readAll(root).entries.length, 1)

    assert.throws(
      () =>
        tool('memory_remember')({
          id: 'pool_cap_causes_staging_timeout_v2',
          title: '连接池上限导致 staging 超时（重复）',
          kind: 'pitfall',
          about: 'staging 健康检查超时的根因',
          body,
          evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
        }),
      (error) => {
        assert.match(error.message, /G5:duplicate|duplicate/)
        assert.match(error.message, /supersedes|覆盖/)
        return true
      },
    )
  })
})

/* ── 4 · DEFER → 待决 → 用户裁决 ──────────────────────────────── */

describe('DEFER 与裁决', () => {
  /** 把自动接受地板抬到 0.99：任何候选都过不了 G8，必然 DEFER。 */
  function strictTools() {
    const strict = resolveConfig({ autonomy: 'balanced', thresholds: { autoAcceptFloor: 0.99, deferFloor: 0.35 } })
    return createToolDefinitions({ resolveRoot: () => root, cfg: strict, log: () => {} })
  }

  const remember = (definitions) =>
    definitions.find((item) => item.name === 'memory_remember').run(
      {
        id: 'uncertain_observation',
        title: '某个不确定的观察',
        kind: 'fact',
        about: '一条拿不准值不值得记的观察',
        body: SIX('这条观察我拿不准值不值得记。'),
        evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
        provenance: 'self-concluded',
      },
      { agent: null },
    )

  const resolveIt = (definitions, args) =>
    definitions.find((item) => item.name === 'memory_resolve').run(args, { agent: null })

  it('置信不足进待决队列，accept 后落盘', () => {
    const definitions = strictTools()
    const text = remember(definitions)
    assert.match(text, /已提交待决/)

    const pending = readProposals(root)
    assert.equal(pending.length, 1)
    const proposalId = pending[0].id

    const resolved = resolveIt(definitions, { proposalId, action: 'accept', reason: '确认值得' })
    assert.match(resolved, /已接受/)
    assert.equal(readProposals(root).length, 0)
    assert.equal(readAll(root).entries.length, 1)
  })

  it('reject 留档且不参与召回', () => {
    const definitions = strictTools()
    remember(definitions)
    const pending = readProposals(root)
    assert.equal(pending.length, 1)

    resolveIt(definitions, { proposalId: pending[0].id, action: 'reject' })
    assert.equal(readProposals(root).length, 0)
    assert.equal(readAll(root).entries.length, 0)
  })
})

/* ── 5 · 召回的三级 ───────────────────────────────────────────── */

describe('三级交付', () => {
  it('无关查询 abstain 并点名门', () => {
    tool('memory_remember')({
      title: '连接池上限在 staging 是十',
      kind: 'fact',
      about: 'staging 的 DB_POOL_MAX 取值',
      body: SIX('staging 的 `DB_POOL_MAX` 是 10。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
    const { snapshot } = ensureSnapshot(root)
    const envelope = recall('如何给 React 组件加动画', snapshot, { config: cfg })
    assert.equal(envelope.delivery.tier, 'abstain')
    assert.ok(envelope.abstain?.reason)
    assert.ok(envelope.abstain?.gate)
    assert.match(renderRecall(envelope), /没有召回/)
  })

  it('空语料 → abstain', () => {
    const { snapshot } = ensureSnapshot(root)
    const envelope = recall('任意查询', snapshot, { config: cfg })
    assert.equal(envelope.delivery.tier, 'abstain')
  })

  it('同一查询跑两次结果逐字节相同（确定性）', () => {
    tool('memory_remember')({
      title: '连接池上限在 staging 是十',
      kind: 'fact',
      about: 'staging 的 DB_POOL_MAX 取值',
      body: SIX('staging 的 `DB_POOL_MAX` 是 10。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
    const { snapshot } = ensureSnapshot(root)
    const a = JSON.stringify(recall('staging 连接池', snapshot, { config: cfg }))
    const b = JSON.stringify(recall('staging 连接池', snapshot, { config: cfg }))
    assert.equal(a, b)
  })
})

/* ── 6 · 审计与破坏性操作 ─────────────────────────────────────── */

describe('审计与遗忘', () => {
  it('audit 报出规模与健康度', () => {
    tool('memory_remember')({
      title: '连接池上限在 staging 是十',
      kind: 'fact',
      about: 'staging 的 DB_POOL_MAX 取值',
      body: SIX('staging 的 `DB_POOL_MAX` 是 10。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
    const audit = tool('memory_audit')({})
    assert.match(audit, /活跃 1 条/)
    assert.match(audit, /ACCEPT 1/)
  })

  it('hard_delete 需要 confirm', () => {
    tool('memory_remember')({
      title: '连接池上限在 staging 是十',
      kind: 'fact',
      about: 'staging 的 DB_POOL_MAX 取值',
      body: SIX('staging 的 `DB_POOL_MAX` 是 10。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
    const { entries } = readAll(root)
    assert.throws(() => tool('memory_forget')({ id: entries[0].id, hard_delete: true }), /confirm/)
    const retired = tool('memory_forget')({ id: entries[0].id, reason: '过时了' })
    assert.match(retired, /已退休/)
    assert.equal(readAll(root).entries[0].status, 'deprecated')
  })
})

/* ── 7 · 零网络 ─────────────────────────────────────────────────── */

describe('本地优先', () => {
  it('记忆库目录结构符合设计', () => {
    tool('memory_remember')({
      title: '连接池上限在 staging 是十',
      kind: 'fact',
      about: 'staging 的 DB_POOL_MAX 取值',
      body: SIX('staging 的 `DB_POOL_MAX` 是 10。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    })
    const paths = layout(root)
    assert.ok(paths.base.endsWith('.dsh-memory'))
    // 索引可重建；正文与回执进 git
    assert.match(readFileSync(join(paths.base, '.gitignore'), 'utf8'), /index\//)
  })
})
