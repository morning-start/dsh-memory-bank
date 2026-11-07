/**
 * 捕获：草稿、草稿门、收件箱、起草器。
 *
 * 这一组的核心不变量：
 *   **自动捕获产出的是草稿，不是记忆。** 填不满的六要素必须留占位符，
 *   而占位符必须被 G2b 拦成 DEFER —— 把「我不知道」写成一句看起来像事实的话，
 *   是这个系统能犯的最严重的错。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { buildCandidate, detectSignals, foldTurn, hasPlaceholder, placeholderSections } from '../lib/capture.js'
import { resolveConfig } from '../lib/config/index.js'
import { createDrafter } from '../lib/draft.js'
import { gateDraft, review } from '../lib/gate.js'
import { collectOwners } from '../lib/gate.js'
import { markDirty } from '../lib/index-build.js'
import { inboxSize, readAll, readInbox, removeInbox, writeInbox } from '../lib/store.js'

let root
let cfg

const events = (userText, assistantText = '') => [
  ...(userText ? [{ type: 'user/message', data: { text: userText } }] : []),
  ...(assistantText ? [{ type: 'assistant/message', data: { text: assistantText } }] : []),
  { type: 'tool/call', data: { name: 'Edit', arguments: { file_path: 'src/a.ts' } } },
  { type: 'tool/result', data: { name: 'Edit', isError: false, text: 'ok' } },
]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-capture-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.dsh-memory', 'memories'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  cfg = resolveConfig({ autonomy: 'balanced' })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('折叠与信号', () => {
  it('foldTurn 提取用户/助手/编辑/命令', () => {
    const facts = foldTurn(events('记住：先查连接池。', '好的，先查连接池。'))
    assert.equal(facts.userTexts.length, 1)
    assert.equal(facts.assistantTexts.length, 1)
    assert.deepEqual(facts.editedFiles, ['src/a.ts'])
    assert.equal(facts.succeededCommands.length, 1)
  })

  it('S1 显式指令', () => {
    const facts = foldTurn(events('记住：先查连接池。'))
    assert.ok(detectSignals(facts).some((hit) => hit.id === 'S1'))
  })

  it('S2 纠错需要同时改了文件', () => {
    const withEdit = foldTurn(events('不对，应该先查连接池。'))
    assert.ok(detectSignals(withEdit).some((hit) => hit.id === 'S2'))
  })

  it('没有任何信号时 shouldCapture 为 false', async () => {
    const { shouldCapture } = await import('../lib/capture.js')
    const facts = foldTurn(events('今天天气不错'))
    assert.equal(shouldCapture(facts, { corpus: [], config: cfg }).capture, false)
  })
})

describe('草稿', () => {
  it('能填的段填实，填不了的留占位符', () => {
    const facts = foldTurn(events('记住：staging 超时先查 DB_POOL_MAX。', '明白了，先查连接池上限。'))
    facts.sessionId = 's'
    const candidate = buildCandidate(facts, { id: 'S1', kind: 'convention' })

    assert.match(candidate.body, /DB_POOL_MAX/) // 生效条件来自用户
    assert.match(candidate.body, /先查连接池上限/) // 执行来自助手
    assert.match(candidate.body, /src\/a\.ts/) // 子功能来自编辑
    assert.equal(hasPlaceholder(candidate.body), true) // 不适用条件必然填不了
    assert.deepEqual(placeholderSections(candidate.body), ['什么时候它不管用'])
  })

  it('「收到」不算执行步骤', () => {
    const facts = foldTurn(events('记住：X 要这样做。', '好的。'))
    facts.sessionId = 's'
    const candidate = buildCandidate(facts, { id: 'S1', kind: 'convention' })
    // 助手只说了「好的」，不能当成执行步骤
    assert.equal(placeholderSections(candidate.body).includes('怎么做'), true)
  })
})

describe('G2b 草稿门', () => {
  const complete = {
    id: 'x',
    title: 'x',
    kind: 'pitfall',
    about: 'x',
    body: '# 功能名\nx\n# 生效条件\ny\n# 子功能\nz\n# 执行\nw\n# 验证方式\nv\n# 不适用条件\nu',
    evidence: [{ kind: 'file', ref: 'src/a.ts' }],
    status: 'active',
  }

  it('没有占位符 → pass', () => {
    assert.equal(gateDraft(complete).kind, 'pass')
  })

  it('有占位符 → refuse，并列出缺哪几段', () => {
    const draft = { ...complete, body: complete.body.replace('\nu', '\n（待补：什么时候它不管用）') }
    const verdict = gateDraft(draft)
    assert.equal(verdict.kind, 'refuse')
    assert.equal(verdict.code, 'shape.draft')
    assert.deepEqual(verdict.detail.sections, ['什么时候它不管用'])
  })

  it('**草稿是 DEFER 不是 REJECT**', () => {
    const facts = foldTurn(events('记住：staging 超时先查 DB_POOL_MAX。', '明白了，先查连接池。'))
    facts.sessionId = 's'
    const candidate = buildCandidate(facts, { id: 'S1', kind: 'convention' })
    const verdict = review(candidate, { root, config: cfg, corpus: [], owners: collectOwners(root) })
    assert.equal(verdict.decision, 'DEFER')
    assert.ok(verdict.gates.some((gate) => gate.gate === 'G2b' && gate.code === 'shape.draft'))
  })

  it('软门不短路：G3–G8 仍然跑完并留下意见', () => {
    const facts = foldTurn(events('记住：staging 超时先查 DB_POOL_MAX。', '明白了，先查连接池。'))
    facts.sessionId = 's'
    const candidate = buildCandidate(facts, { id: 'S1', kind: 'convention' })
    const verdict = review(candidate, { root, config: cfg, corpus: [], owners: collectOwners(root) })
    const gates = verdict.gates.map((gate) => gate.gate)
    for (const name of ['G3', 'G3b', 'G4', 'G5', 'G7', 'G6', 'G8']) assert.ok(gates.includes(name), name)
  })
})

describe('收件箱', () => {
  const item = (id) => ({ id, sessionId: 's', turn: 1, hit: { id: 'S1', kind: 'convention' }, facts: { userTexts: ['x'] } })

  it('写入 → 读回 → 删除', () => {
    writeInbox(root, item('i1'))
    writeInbox(root, item('i2'))
    assert.equal(inboxSize(root), 2)

    const items = readInbox(root)
    assert.equal(items.length, 2)
    assert.equal(items[0].id, 'i1')

    removeInbox(root, 'i1')
    assert.equal(inboxSize(root), 1)
    assert.equal(readInbox(root)[0].id, 'i2')
  })

  it('自动分配 id', () => {
    const record = writeInbox(root, { sessionId: 's', hit: { id: 'S1' }, facts: {} })
    assert.match(record.id, /^i_/)
  })

  it('坏文件不拖垮整个收件箱', () => {
    writeInbox(root, item('good'))
    // 手工塞一个坏文件
    writeFileSync(join(root, '.dsh-memory', 'inbox', 'bad.json'), '{ not json', 'utf8')
    const items = readInbox(root)
    assert.equal(items.filter((entry) => entry.corrupt).length, 1)
    assert.equal(items.filter((entry) => !entry.corrupt).length, 1)
  })
})

describe('起草器', () => {
  const facts = () => {
    const folded = foldTurn(events('记住：staging 超时先查 DB_POOL_MAX。', '明白了，先查连接池。'))
    folded.sessionId = 's'
    // 子 Agent 需要 live parent；模板路径不需要
    folded.agent = { id: 's' }
    return folded
  }
  const hit = { id: 'S1', kind: 'convention' }

  it('默认走模板（不调模型）', async () => {
    const draft = createDrafter({ ctx: {}, getConfig: () => cfg, log: () => {} })
    const result = await draft({ facts: facts(), hit, id: 'x' })
    assert.equal(result.draftedBy, 'template')
    assert.equal(hasPlaceholder(result.candidate.body), true)
  })

  it('draft=subagent 但服务不可用 → 回退模板', async () => {
    const subagentCfg = resolveConfig({ capture: { draft: 'subagent' } })
    const logs = []
    const draft = createDrafter({ ctx: {}, getConfig: () => subagentCfg, log: (message) => logs.push(message) })
    const result = await draft({ facts: facts(), hit, id: 'x' })
    assert.equal(result.draftedBy, 'template')
    assert.ok(logs.some((line) => line.includes('回退模板')))
  })

  it('draft=subagent 且服务可用 → 用子 Agent 的成稿', async () => {
    const subagentCfg = resolveConfig({ capture: { draft: 'subagent' } })
    let disposed = false
    const ctx = {
      subagent: {
        async startActivation(spec) {
          assert.equal(spec.delivery, 'caller')
          assert.deepEqual(spec.outputSchema.required, ['name', 'when', 'components', 'how', 'verify', 'unless'])
          return {
            result: Promise.resolve({
              stopReason: 'completed',
              structured: {
                name: 'staging 超时先查连接池',
                when: 'staging 健康检查超时',
                components: 'src/db/pool.ts',
                how: '先看 DB_POOL_MAX',
                verify: 'kubectl exec … grep DB_POOL_MAX',
                unless: '生产环境按实例数缩放',
              },
            }),
            async dispose() {
              disposed = true
            },
          }
        },
      },
    }
    const draft = createDrafter({ ctx, getConfig: () => subagentCfg, log: () => {} })
    const result = await draft({ facts: facts(), hit, id: 'x' })
    assert.equal(result.draftedBy, 'subagent')
    assert.equal(hasPlaceholder(result.candidate.body), false, '成稿不该有占位符')
    assert.match(result.candidate.body, /先看 DB_POOL_MAX/)
    assert.equal(disposed, true, '必须释放 activation')
  })

  it('子 Agent 失败 → 回退模板，不抛', async () => {
    const subagentCfg = resolveConfig({ capture: { draft: 'subagent' } })
    const ctx = {
      subagent: {
        async startActivation() {
          throw new Error('provider unavailable')
        },
      },
    }
    const draft = createDrafter({ ctx, getConfig: () => subagentCfg, log: () => {} })
    const result = await draft({ facts: facts(), hit, id: 'x' })
    assert.equal(result.draftedBy, 'template')
  })

  it('子 Agent 只填了一部分 → 缺的段留占位符（不让 G2b 蒙混过关）', async () => {
    const subagentCfg = resolveConfig({ capture: { draft: 'subagent' } })
    const ctx = {
      subagent: {
        async startActivation() {
          return {
            result: Promise.resolve({ stopReason: 'completed', structured: { name: '只有名字' } }),
            async dispose() {},
          }
        },
      },
    }
    const draft = createDrafter({ ctx, getConfig: () => subagentCfg, log: () => {} })
    const result = await draft({ facts: facts(), hit, id: 'x' })
    assert.equal(result.draftedBy, 'subagent')
    assert.equal(hasPlaceholder(result.candidate.body), true)
    const sections = placeholderSections(result.candidate.body)
    assert.ok(sections.includes('什么时候它不管用'))
    assert.ok(sections.includes('怎么做'))

    // 而且必须被 G2b 拦成 DEFER —— 不能因为「成稿了」就跳过门
    const verdict = review(result.candidate, { root, config: cfg, corpus: [], owners: [] })
    assert.equal(verdict.decision, 'DEFER')
  })
})

describe('后台重建', () => {
  it('markDirty 立即返回（不同步重建索引）', () => {
    const started = process.hrtime.bigint()
    markDirty(root)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(ms < 5, `markDirty 花了 ${ms.toFixed(2)} ms —— 它必须是 O(1)`)
  })

  it('markDirty 不抛（即使 root 不存在）', () => {
    assert.doesNotThrow(() => markDirty(join(root, 'nope')))
  })
})

/* ── G1 归属门：owner 目录不写死 ──────────────────────────────────── */

/**
 * 「事实文档放 `docs/`」是一条**规范**，不是一条保证 —— 保证来自 G1 归属门
 * 真的读到了那份文档。
 *
 * 上一版 `OWNER_DIRS = ['docs']`，而目录路由层（`lib/routes.js`）认的是
 * **所有**带 `.md` 的顶层目录。两份名单各写各的，后果很具体：
 * 在 `knowledge/foo.md` 里写过一条断言，`memory_remember` 还能再记一遍 ——
 * 两份副本开始漂移，而漂移正是 G1 存在的唯一理由（`docs/03` §G1）。
 *
 * 现在 owner 目录集合由 `routes.listDocFolders` 推导，建目录 + 放 `.md` 就够了，
 * 不需要改两处代码。
 */
describe('G1 归属门 · owner 目录由目录路由层推导', () => {
  /** 建一个自带文档目录的临时仓库。复用 `beforeEach` 的 `root`（每个用例全新）。 */
  const seed = () => {
    mkdirSync(join(root, 'knowledge'), { recursive: true })
    mkdirSync(join(root, 'design'), { recursive: true })
    mkdirSync(join(root, '.tmp-scratch'), { recursive: true })
    writeFileSync(
      join(root, 'knowledge', 'ops.md'),
      '# 运维\n\nstaging 部署健康检查超时先查 DB_POOL_MAX 连接池上限。\n',
      'utf8',
    )
    writeFileSync(join(root, 'design', 'arch.md'), '# 架构\n\n召回是五路融合。\n', 'utf8')
    writeFileSync(join(root, '.tmp-scratch', 'notes.md'), '# 草稿\n\n召回是五路融合。\n', 'utf8')
  }

  it('`knowledge/` 与 `design/` 里的文档被当成 owner', () => {
    seed()
    const refs = collectOwners(root).map((owner) => owner.ref)
    assert.ok(refs.includes('knowledge/ops.md'), `没读到 knowledge/，实际：${refs.join(', ')}`)
    assert.ok(refs.includes('design/arch.md'), `没读到 design/，实际：${refs.join(', ')}`)
  })

  it('**点开头 / 构建产物目录不算** owner（否则就是全仓扫描）', () => {
    seed()
    const refs = collectOwners(root).map((owner) => owner.ref)
    assert.ok(!refs.some((ref) => ref.startsWith('.')), `点目录被读进来了：${refs.join(', ')}`)
  })

  it('断言的 title 出现在 `knowledge/` 里 → refuse(owned-elsewhere)', () => {
    seed()
    const verdict = review(
      {
        id: 'staging_check_pool_cap',
        title: 'staging 部署健康检查超时先查 DB_POOL_MAX 连接池上限',
        kind: 'pitfall',
        about: 'staging 部署健康检查超时先查 DB_POOL_MAX 连接池上限',
        body: '# 功能名\nx\n# 生效条件\ny\n# 子功能\nz\n# 执行\nw\n# 验证方式\nv\n# 不适用条件\nu',
        evidence: [{ kind: 'file', ref: 'src/a.ts' }],
        provenance: 'measured',
        scope: ['repo:x'],
      },
      { root, config: cfg, corpus: [], owners: collectOwners(root) },
    )
    assert.equal(verdict.decision, 'REJECT')
    assert.equal(verdict.code, 'owned-elsewhere')
    assert.equal(verdict.detail.owner.ref, 'knowledge/ops.md')
  })
})
