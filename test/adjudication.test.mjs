/**
 * 裁决域的**单实现**不变量 —— 同一份提案，三个入口，逐字节相同。
 *
 * ## 这一组钉住的是一个真实的数据丢失
 *
 * 0.3.x 之前，「裁决一条提案」有两份实现：
 *
 *   - `lib/tools.js` 的 `memory_resolve`（工具面）
 *   - `lib/host/mutations.js` 的 `accept` / `reject` / `edit`（命令面 + 面板面）
 *
 * 两份都很「像」对的，各自也都有测试 —— 测试只测**自己那一份**，于是
 * 分叉永远不会变红。实测（`.tmp-audit/probe-adjudication-drift.mjs`、
 * `probe-merge-drift.mjs`）三处分叉，其中一处**提案被静默丢弃**：
 *
 * | 动作 | 命令 / 面板面 | 工具面 | 后果 |
 * |---|---|---|---|
 * | accept 记忆提案 | `authority: null` | `user-confirmed` | `authority` 进 `contentHash` → 同一个动作两个回执哈希；`promote` 按权威过滤，「哪些记忆值得推广」取决于你点的哪个按钮 |
 * | accept **merge** 提案 | 删掉提案，**合并从未发生**，还回「已接受 merge 提议：undefined」 | 真的合并 | **提案永久消失**，用户以为接受了 |
 * | `edit.claims` | 不识别（`invalid-patch`） | 支持 | 面板上关不掉一条断言 |
 *
 * 0.4.0 把裁决域提到 `lib/adjudicate.js`，三个入口都只是**适配器**。
 * 本文件是那个判断的**可执行证明**：不是「代码看起来只有一份」，
 * 而是「两个入口跑出来的**文件字节**一样」。
 *
 * ## 为什么断言「逐字节」而不是「字段相等」
 *
 * 字段相等会漏掉**新增字段**：将来谁给 `writeEntry` 加一个只有某条路径写的
 * 字段，`assert.deepEqual` 只在两边的键集恰好相同时也抓得住 —— 而 `contentHash`
 * 读的是**序列化后的全文**。字节相同才是真的相同。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { EDITABLE_FIELDS, createAdjudicator, pickClaimPatches, pickEditable } from '../lib/adjudicate.js'
import { createConfigSource } from '../lib/config/index.js'
import { createGuards } from '../lib/host/guards.js'
import { entryFile, findProposal, readAll, writeEntry, writeProposal } from '../lib/store.js'
import { createToolDefinitions } from '../lib/tools.js'

/* ── 夹具 ─────────────────────────────────────────────────────────── */

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
const PROPOSAL_ID = 'p_adjudicate_0001'

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

function makeRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), `dsh-adjudicate-${tag}-`))
  mkdirSync(join(root, 'src', 'db'), { recursive: true })
  // G1 的「已有主人」文档 + G4 的锚点目标。少一个夹具就永远过不了硬门。
  writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n\n提交前跑 lint 和单测，不要跳过 hook。\n', 'utf8')
  writeFileSync(join(root, 'src', 'db', 'pool.ts'), 'export const DB_POOL_MAX = 10\n', 'utf8')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@acme/api' }, null, 2)}\n`, 'utf8')
  return root
}

/** 造一条待决提案（走 store 的真实写入路径）。 */
function seedProposal(root, { id = PROPOSAL_ID, overrides = {}, gates } = {}) {
  writeProposal(root, {
    id,
    candidate: candidate(overrides),
    // 判不了的是 G8（置信门）—— 最常见的 DEFER 来源。
    gates: gates ?? [{ gate: 'G8', kind: 'refuse', code: 'confidence.low', detail: { confidence: 0.5 } }],
    why: ['G8:confidence.low'],
    status: 'pending',
  })
  return id
}

/** 一个入口的完整视图：面板面（adjudicator）或工具面（memory_resolve）。 */
function panelFace(root) {
  return createAdjudicator({ configSource: createConfigSource({ rowConfig: {}, env: {} }), guards: createGuards(), log: () => {} })
}

function toolFace(root) {
  const definitions = createToolDefinitions({
    resolveRoot: () => root,
    configSource: createConfigSource({ rowConfig: {}, env: {} }),
    log: () => {},
  })
  return definitions.find((definition) => definition.name === 'memory_resolve')
}

function fileText(root, id = MEMORY_ID) {
  const file = entryFile(root, id)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

let roots = []
function rootFor(tag) {
  const root = makeRoot(tag)
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

/* ── 1 · 同一份提案，两个入口，逐字节相同 ─────────────────────────── */

describe('裁决域 · 两个入口落盘逐字节相同', () => {
  it('accept：面板面与工具面写出的记忆文件一个字节都不差', () => {
    const panelRoot = rootFor('accept-panel')
    seedProposal(panelRoot)
    const panelResult = panelFace(panelRoot).accept(panelRoot, PROPOSAL_ID)
    assert.equal(panelResult.ok, true, panelResult.error)

    const toolRoot = rootFor('accept-tool')
    seedProposal(toolRoot)
    toolFace(toolRoot).run({ proposalId: PROPOSAL_ID, action: 'accept' }, { agent: null })

    const panelText = fileText(panelRoot)
    const toolText = fileText(toolRoot)
    assert.ok(panelText, '面板面没有落盘')
    assert.ok(toolText, '工具面没有落盘')
    assert.equal(
      panelText,
      toolText,
      '同一条提案经两个入口落盘不同 —— 裁决域又变成两份实现了。\n' +
        '修法：任何「写记忆」的判断都只许在 lib/adjudicate.js 里做，两个入口只做形状转换。',
    )
  })

  it('accept 把权威抬到 `user-confirmed` —— **两个入口都抬**', () => {
    // 0.3.x 只有工具面抬。面板面留 `null`，而 `authority` 进 contentHash，
    // 于是「同一个用户动作」产出两个回执哈希，`promote` 的过滤结果还不同。
    for (const [face, run] of [
      ['面板面', (root) => panelFace(root).accept(root, PROPOSAL_ID)],
      ['工具面', (root) => toolFace(root).run({ proposalId: PROPOSAL_ID, action: 'accept' }, { agent: null })],
    ]) {
      const root = rootFor(`authority-${face}`)
      seedProposal(root)
      const result = run(root)
      assert.ok(result.ok !== false, `${face} 裁决失败：${result.error ?? ''}`)
      const entry = readAll(root).entries[0]
      assert.equal(entry.authority, 'user-confirmed', `${face}没有留下「人签过字」的痕迹`)
    }
  })

  it('候选没给 `confidence` 时，两个入口都算出门的置信 —— 不是一边 `null`', () => {
    const panelRoot = rootFor('confidence-panel')
    seedProposal(panelRoot, { overrides: { confidence: undefined } })
    panelFace(panelRoot).accept(panelRoot, PROPOSAL_ID)

    const toolRoot = rootFor('confidence-tool')
    seedProposal(toolRoot, { overrides: { confidence: undefined } })
    toolFace(toolRoot).run({ proposalId: PROPOSAL_ID, action: 'accept' }, { agent: null })

    const panelConfidence = readAll(panelRoot).entries[0].confidence
    const toolConfidence = readAll(toolRoot).entries[0].confidence
    assert.equal(typeof panelConfidence, 'string', '面板面落盘的 confidence 是空值')
    assert.equal(panelConfidence, toolConfidence, '两个入口算出的置信不同 —— 排序与推广过滤会分叉')
  })
})

/* ── 2 · 图提案：两个入口都**真的**合并 ───────────────────────────── */

describe('裁决域 · 图提案（merge）', () => {
  function seedMerge(root) {
    writeEntry(root, candidate({ id: 'pool_cap_a', title: 'staging 连接池 A' }))
    writeEntry(root, candidate({ id: 'pool_cap_b', title: 'staging 连接池 B' }))
    writeProposal(root, {
      id: 'p_merge_0001',
      kind: 'merge',
      ids: ['pool_cap_a', 'pool_cap_b'],
      score: 0.91,
      why: ['consolidation:similar'],
      status: 'pending',
    })
  }

  function state(root) {
    const { entries } = readAll(root)
    return {
      active: entries.filter((entry) => entry.status === 'active').map((entry) => entry.id).sort(),
      deprecated: entries.filter((entry) => entry.status === 'deprecated').map((entry) => entry.id).sort(),
      pending: findProposal(root, 'p_merge_0001') ? 'still-there' : 'gone',
    }
  }

  it('**面板面接受 merge 提案真的合并**（0.3.x 是删掉提案、合并从未发生）', () => {
    const root = rootFor('merge-panel')
    seedMerge(root)
    const result = panelFace(root).accept(root, 'p_merge_0001')
    assert.equal(result.ok, true, result.error)

    const after = state(root)
    assert.deepEqual(after.active, [], '合并后仍留下活跃条目')
    assert.deepEqual(after.deprecated, ['pool_cap_a', 'pool_cap_b'], '原始条目没有退休')
    assert.equal(after.pending, 'gone', '提案没有出队')
    // 合并产物必须存在 —— 0.3.x 面板面只删提案，什么也没合并。
    const merged = readAll(root).entries.filter((entry) => !['pool_cap_a', 'pool_cap_b'].includes(entry.id))
    assert.equal(merged.length, 1, '没有产出合并后的条目 —— 提案被静默丢弃了')
    assert.ok(merged[0].id, '合并条目没有 id')
  })

  it('两个入口的合并结果**集合**相同（id 由内容寻址决定，因此也相同）', () => {
    const panelRoot = rootFor('merge-eq-panel')
    seedMerge(panelRoot)
    panelFace(panelRoot).accept(panelRoot, 'p_merge_0001')

    const toolRoot = rootFor('merge-eq-tool')
    seedMerge(toolRoot)
    toolFace(toolRoot).run({ proposalId: 'p_merge_0001', action: 'accept' }, { agent: null })

    assert.deepEqual(
      readAll(panelRoot).entries.map((entry) => `${entry.id}:${entry.status}`).sort(),
      readAll(toolRoot).entries.map((entry) => `${entry.id}:${entry.status}`).sort(),
      '两个入口合并出的条目集合不同',
    )
  })

  it('回显里不再是 `undefined` —— merge 提案没有 `subjectId`', () => {
    const root = rootFor('merge-text')
    seedMerge(root)
    const result = panelFace(root).accept(root, 'p_merge_0001')
    assert.doesNotMatch(result.text, /undefined/, `裁决回显里有 undefined：${result.text}`)
    assert.match(result.text, /已合并 2 条/)
  })

  it('`edit` 对图提案给 `not-editable`，不是当成 accept', () => {
    const root = rootFor('merge-edit')
    seedMerge(root)
    const result = panelFace(root).edit(root, 'p_merge_0001', { title: '换个标题' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-editable')
    assert.equal(state(root).pending, 'still-there', '失败的 edit 不该动提案')
  })
})

/* ── 3 · 对账补丁：只有一条路径 ─────────────────────────────────── */

describe('裁决域 · 对账补丁（claims）', () => {
  function seedWithClaim(root) {
    writeEntry(
      root,
      candidate({
        claims: [{ kind: 'pull-request', ref: 'api#10', state: 'open', evidence: 'PR #10 is open' }],
      }),
    )
    const entry = readAll(root).entries[0]
    writeProposal(root, {
      id: PROPOSAL_ID,
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
        provenance: entry.provenance,
        confidence: entry.confidence,
      },
      gates: [],
      why: ['test'],
      status: 'pending',
    })
  }

  it('面板面也能写 resolution 三列（0.3.x 只有工具面能）', () => {
    const root = rootFor('claims-panel')
    seedWithClaim(root)
    const result = panelFace(root).edit(root, PROPOSAL_ID, null, {
      claimPatches: [{ kind: 'pull-request', ref: 'api#10', resolvedState: 'resolved' }],
    })
    assert.equal(result.ok, true, result.error)
    const [claim] = readAll(root).entries[0].claims
    assert.equal(claim.resolvedState, 'resolved')
  })

  it('ref 不存在时整次失败，且**不写任何东西**', () => {
    const root = rootFor('claims-miss')
    seedWithClaim(root)
    const before = fileText(root)
    const result = panelFace(root).edit(root, PROPOSAL_ID, null, {
      claimPatches: [{ kind: 'pull-request', ref: 'api#999 不存在', resolvedState: 'resolved' }],
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'claim-miss')
    assert.equal(fileText(root), before, '失败了却写进去了')
    assert.equal(findProposal(root, PROPOSAL_ID)?.id, PROPOSAL_ID, '失败了却把提案出队了')
  })

  it('`edit` 只给 `claims` 也能过 —— 补丁不是「内容字段」的附属品', () => {
    const root = rootFor('claims-only')
    seedWithClaim(root)
    const result = panelFace(root).edit(root, PROPOSAL_ID, null, {
      claimPatches: [{ kind: 'pull-request', ref: 'api#10', resolvedState: 'resolved' }],
    })
    assert.equal(result.ok, true, result.error)
  })

  it('只给 `claims` 且 ref 不存在 → 失败（不是「没内容字段」的假错误）', () => {
    const root = rootFor('claims-bad-only')
    seedWithClaim(root)
    const result = panelFace(root).edit(root, PROPOSAL_ID, null, {
      claimPatches: [{ kind: 'pull-request', ref: 'nope', resolvedState: 'resolved' }],
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'claim-miss', '报错了但错在「没有内容字段」上 —— 诊断会指错方向')
  })

  it('`edit` 什么都不给 → `invalid-patch`，不是静默 accept', () => {
    const root = rootFor('claims-empty')
    seedWithClaim(root)
    const result = panelFace(root).edit(root, PROPOSAL_ID, {})
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid-patch')
  })
})

/* ── 4 · 白名单是**一份** ─────────────────────────────────────────── */

describe('裁决域 · 可编辑字段白名单', () => {
  it('`claims` 在表里，但 `pickEditable` 跳过它（走补丁语义）', () => {
    assert.ok(EDITABLE_FIELDS.includes('claims'), 'claims 不在白名单里 —— 面板面就写不了对账')
    const picked = pickEditable({ title: 'x', claims: [{ kind: 'a', ref: 'b' }] })
    assert.deepEqual(picked, { title: 'x' }, 'claims 被当成普通内容字段 spread 了')
  })

  it('身份与生命周期字段一概筛掉', () => {
    const picked = pickEditable({ id: '别人的id', status: 'rejected', createdAt: '2000-01-01', title: 'ok' })
    assert.deepEqual(picked, { title: 'ok' })
  })

  it('补丁只留 resolution 三列，`state` 进不来', () => {
    const patches = pickClaimPatches([{ kind: 'pull-request', ref: 'PR #1', state: 'closed', resolvedState: 'resolved' }])
    assert.deepEqual(patches, [{ kind: 'pull-request', ref: 'PR #1', resolvedState: 'resolved' }])
  })
})

/* ── 5 · 未知动作不许被当成 accept ────────────────────────────────── */

describe('裁决域 · 未知动作', () => {
  it('工具面对 `action: "destroy"` 报错，不落盘', () => {
    const root = rootFor('unknown-action')
    seedProposal(root)
    assert.throws(
      () => toolFace(root).run({ proposalId: PROPOSAL_ID, action: 'destroy' }, { agent: null }),
      /未知裁决动作/,
    )
    assert.equal(fileText(root), null, '未知动作却落盘了')
  })
})
