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
import { computeConfidence, gateConflict, gateConfidence } from '../lib/gate.js'
import { recall, renderRecall } from '../lib/recall.js'
import { ensureSnapshot } from '../lib/index-build.js'
import { MemoryError, createToolDefinitions } from '../lib/tools.js'
import { readAll, readProposals, layout } from '../lib/store.js'
import * as store from '../lib/store.js'

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

  /**
   * 升级路径：旧版本回执**不是篡改**。
   *
   * 0.1.1 把 `actionRisk` / `relations` / `provenance` / `confidence` / `status` /
   * `claims` 补进了 `contentHash`（漏了它们，把记忆改成 R5 之后索引永不重建）。
   * 哈希字段集一变，**所有旧回执都对不上** —— 而那些记忆一个字都没被改。
   *
   * 如果不管版本号，升级后的第一次 `memory_audit` 会把整库标成「正文被改」。
   * 那正是一次**虚假的篡改指控**，比没有回执更糟 —— 它训练用户忽略这个警告。
   */
  it('**旧版本回执报 needs-reseed，不报 tampered**', () => {
    const { appendReceipt, receiptStatus, writeEntry, findEntry } = store
    const entry = writeEntry(root, {
      id: 'legacy_receipt',
      title: '旧回执',
      kind: 'fact',
      about: '升级路径',
      body: SIX('旧回执的正文。'),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
      provenance: 'measured',
      actionRisk: 'R1',
    })
    appendReceipt(root, entry)
    const fresh = findEntry(root, 'legacy_receipt')
    assert.equal(receiptStatus(root, fresh), 'ok')

    // 把回执降级成 0.1.0 的形态（没有 hashVersion）
    const receiptsPath = layout(root).receipts
    const store_ = JSON.parse(readFileSync(receiptsPath, 'utf8'))
    for (const item of store_.receipts) delete item.hashVersion
    writeFileSync(receiptsPath, `${JSON.stringify(store_, null, 2)}\n`, 'utf8')

    assert.equal(receiptStatus(root, fresh), 'needs-reseed', '旧回执必须报 needs-reseed')
    assert.match(tool('memory_audit')({}), /回执待重签/, 'memory_audit 必须单独渲染 needs-reseed')
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

  /**
   * 回归：MMR 曾经把指纹算在**文档对象**上而不是内容上 ——
   * `tokenize({...})` 一律返回 `["object Object"]`，于是任意两条候选的相似度恒为 1.0，
   * 第一条之后全部被 suppress。症状是「召回永远只返回一条」。
   */
  it('多条相关记忆能一起召回（MMR 不吞掉第二条）', () => {
    const fixtures = [
      ['pool_cap', '连接池上限导致 staging 超时', 'staging 健康检查超时的根因是连接池上限'],
      ['worker_count', 'worker 数量与 staging 超时的关系', 'staging 超时排查里的 worker 数量环节'],
      ['healthcheck_timeout', '健康检查超时阈值在 staging 的配置', 'staging 健康检查超时阈值的取值'],
    ]
    for (const [id, title, about] of fixtures) {
      tool('memory_remember')({
        id,
        title,
        kind: 'pitfall',
        about,
        body: SIX(`${title}。${about}。这一段正文足够长，能让 G5 的特征数过门槛。`),
        evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
        triggers: ['staging 健康检查超时'],
      })
    }

    const { snapshot } = ensureSnapshot(root)
    const envelope = recall('staging 健康检查 超时 连接池 worker', snapshot, { config: cfg, limit: 3 })
    assert.equal(envelope.delivery.tier, 'content')
    assert.ok(
      envelope.results.length >= 2,
      `MMR 只留下 ${envelope.results.length} 条 —— 指纹算错了？${JSON.stringify(envelope.mmrSuppressed)}`,
    )
    // 结果按 rank 单调
    assert.deepEqual(
      envelope.results.map((result) => result.rank),
      envelope.results.map((_, index) => index + 1),
    )
  })
})

/* ── 6 · G8 置信 ──────────────────────────────────────────────── */

describe('G8 置信', () => {
  const base = {
    id: 'x',
    title: '连接池上限',
    kind: 'pitfall',
    about: 'staging 超时的根因',
    body: 'staging 超时先看 `src/db/pool.ts` 里的 DB_POOL_MAX。',
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:x'],
    provenance: 'self-concluded',
    status: 'active',
    origin: { signal: 'S7' },
  }

  it('与语料规模无关（同样的候选永远同样的分）', () => {
    // 上一版把 coverage 算成「与既有语料的相似度」，导致**第二条同类型记忆
    // 比第一条更难落盘** —— 那等于惩罚「积累」，而积累是这个系统唯一的目的。
    assert.equal(computeConfidence(base), computeConfidence({ ...base }))
    assert.ok(computeConfidence(base) >= 0.6, `实际 ${computeConfidence(base)}`)
  })

  it('正文没提到的锚点 → 覆盖率 0 → 分数掉下去', () => {
    const unanchored = { ...base, body: 'staging 超时先看环境变量。' }
    assert.ok(computeConfidence(unanchored) < computeConfidence(base))
    assert.ok(computeConfidence(unanchored) < 0.6)
  })

  it('user-asserted 比 self-concluded 高', () => {
    assert.ok(computeConfidence({ ...base, provenance: 'user-asserted' }) > computeConfidence(base))
  })

  it('有 scope 比没 scope 高（适用面清楚是质量信号）', () => {
    assert.ok(computeConfidence(base) > computeConfidence({ ...base, scope: [] }))
  })

  it('中文否定词不误伤「区别」「特别」', () => {
    // G6 的判据是「否定翻转」，假阳性会把两条一致的记忆报成矛盾
    const a = { ...base, id: 'a', body: '这两者的区别在于连接池上限。' }
    const b = { ...base, id: 'b', body: '这两者的特别之处在于连接池上限。' }
    assert.equal(gateConflict(a, { corpus: [b] }).kind, 'pass')
  })

  it('**带 `confidence` 标签的候选不会被静默丢弃**', () => {
    // `confidence` 这个字段名被两个东西共用：
    //   条目上是**标签**（verified / inferred / stale），进 frontmatter；
    //   门要的是**分数**（0–1），由 computeConfidence 算。
    //
    // 上一版直接 `candidate.confidence ?? computeConfidence(...)` —— 只要调用方
    // 带了标签（schema 完全允许），比较就变成 `'verified' >= 0.6`，恒为 false，
    // 于是每一条这样进来的候选都掉进 `confidence.low` 分支被**丢弃**：
    // 不建提案、不落盘、只剩一行 `discard: true` 没人看。
    //
    // 静默丢弃一条本该记住的记忆，是这个系统最坏的失败方式。
    for (const label of ['verified', 'inferred', 'stale']) {
      const verdict = gateConfidence({ ...base, confidence: label })
      assert.equal(verdict.kind, 'pass', `标签 ${label} 被判成了 ${verdict.kind}:${verdict.code ?? ''}`)
      assert.equal(typeof verdict.confidence, 'number', 'verdict.confidence 必须是分数')
    }
  })

  it('数值 confidence 仍然被尊重（内部调用方用分数）', () => {
    assert.equal(gateConfidence({ ...base, confidence: 0.9 }).kind, 'pass')
    assert.equal(gateConfidence({ ...base, confidence: 0.4 }).kind, 'refuse')
    assert.equal(gateConfidence({ ...base, confidence: 0.1 }).discard, true)
  })

  it('真的否定翻转仍然报冲突', () => {
    const a = { ...base, id: 'a', body: '不要改连接池上限。' }
    const b = { ...base, id: 'b', body: '改连接池上限。' }
    const verdict = gateConflict(a, { corpus: [b] })
    assert.equal(verdict.kind, 'refuse')
    assert.equal(verdict.code, 'conflict')
  })
})

/* ── 7 · 审计与破坏性操作 ─────────────────────────────────────── */
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
