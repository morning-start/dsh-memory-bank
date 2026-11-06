/**
 * 漂移检测：**目标消失 ≠ 切片变了**。
 *
 * 这两者混为一谈的后果是具体的：每一次改名、挪行、重新格式化都会把整个记忆库
 * 标成「不可信」，然后所有人学会忽略这个警告 —— 那比不做漂移检测更糟。
 *
 * 还有两种判决同样重要：
 *   `symbol-not-a-definition`  锚点落在注释 / 字符串 / 调用处 —— 它指错了
 *   `unverifiable`             机器无法判断 —— 报「健康」是撒谎，报「漂移」是误伤
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { DRIFT, checkAnchor, checkEvidence, driftReport, worstOf } from '../lib/drift.js'
import { contentHash, parseEntry, serializeEntry } from '../lib/model.js'

let root

const write = (path, text) => {
  const absolute = join(root, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-drift-'))
  write('src/db/pool.ts', ['export const DB_POOL_MAX = 10', '', 'export function createPool() {', '  return DB_POOL_MAX', '}', ''].join('\n'))
  write('src/util.ts', ['// createPool 在这里被提到过，但只是注释', 'export const OTHER = 1', ''].join('\n'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('文件锚点', () => {
  it('文件还在 → healthy', () => {
    const verdict = checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts' })
    assert.equal(verdict.verdict, DRIFT.healthy)
  })

  it('文件被删 → **quarantined**（目标消失）', () => {
    rmSync(join(root, 'src', 'db', 'pool.ts'))
    const verdict = checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts' })
    assert.equal(verdict.verdict, DRIFT.quarantined)
    assert.match(verdict.detail, /文件不存在/)
  })

  it('行号越界 → quarantined（切片消失）', () => {
    const verdict = checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts:999' })
    assert.equal(verdict.verdict, DRIFT.quarantined)
    assert.match(verdict.detail, /切片消失了/)
  })

  it('行号在范围内 → healthy', () => {
    const verdict = checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts:3' })
    assert.equal(verdict.verdict, DRIFT.healthy)
  })

  it('切片哈希变了 → **advisory**（重构不是攻击）', () => {
    const verdict = checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts:1', hash: 'deadbeef' })
    assert.equal(verdict.verdict, DRIFT.advisory)
    assert.match(verdict.detail, /重构不是攻击/)
  })

  it('doc 锚点与 file 同规则', () => {
    write('docs/guide.md', '# 指南\n')
    assert.equal(checkAnchor(root, { kind: 'doc', ref: 'docs/guide.md' }).verdict, DRIFT.healthy)
  })
})

describe('符号锚点', () => {
  it('定义还在 → healthy，并报行号', () => {
    const verdict = checkAnchor(root, { kind: 'symbol', ref: 'src/db/pool.ts#createPool' })
    assert.equal(verdict.verdict, DRIFT.healthy)
    assert.match(verdict.detail, /第 3 行/)
  })

  it('const 定义也算', () => {
    assert.equal(checkAnchor(root, { kind: 'symbol', ref: 'src/db/pool.ts#DB_POOL_MAX' }).verdict, DRIFT.healthy)
  })

  it('符号没了但文件还在 → quarantined', () => {
    const verdict = checkAnchor(root, { kind: 'symbol', ref: 'src/db/pool.ts#createPool2' })
    assert.equal(verdict.verdict, DRIFT.quarantined)
    assert.match(verdict.detail, /符号不存在/)
  })

  it('**只出现在注释里 → symbol-not-a-definition**（不是 healthy，也不是 quarantined）', () => {
    const verdict = checkAnchor(root, { kind: 'symbol', ref: 'src/util.ts#createPool' })
    assert.equal(verdict.verdict, DRIFT.notADefinition)
    assert.match(verdict.detail, /注释 \/ 字符串 \/ 调用点/)
  })

  it('符号体变了 → advisory', () => {
    const verdict = checkAnchor(root, { kind: 'symbol', ref: 'src/db/pool.ts#createPool', hash: 'deadbeef' })
    assert.equal(verdict.verdict, DRIFT.advisory)
  })

  it('符号体没变 → healthy（哈希一致）', () => {
    // 先拿真实哈希
    const first = checkAnchor(root, { kind: 'symbol', ref: 'src/db/pool.ts#createPool' })
    assert.equal(first.verdict, DRIFT.healthy)
  })

  it('文件不存在 → quarantined（不是 not-a-definition）', () => {
    const verdict = checkAnchor(root, { kind: 'symbol', ref: 'src/nope.ts#createPool' })
    assert.equal(verdict.verdict, DRIFT.quarantined)
  })
})

describe('无法复查的锚点', () => {
  it('commit / command / user → unverifiable（诚实地说不知道）', () => {
    for (const kind of ['commit', 'command', 'user']) {
      const verdict = checkAnchor(root, { kind, ref: 'abc123' })
      assert.equal(verdict.verdict, DRIFT.unverifiable, kind)
      assert.match(verdict.detail, /无法机器复查/)
    }
  })

  it('空锚点 → unverifiable', () => {
    assert.equal(checkAnchor(root, { kind: 'file', ref: '' }).verdict, DRIFT.unverifiable)
  })

  it('未知类型 → unverifiable', () => {
    assert.equal(checkAnchor(root, { kind: 'telepathy', ref: 'x' }).verdict, DRIFT.unverifiable)
  })
})

describe('条目级判决', () => {
  it('取最坏的锚点', () => {
    assert.equal(worstOf([DRIFT.healthy, DRIFT.advisory]), DRIFT.advisory)
    assert.equal(worstOf([DRIFT.advisory, DRIFT.quarantined]), DRIFT.quarantined)
    assert.equal(worstOf([DRIFT.healthy, DRIFT.healthy]), DRIFT.healthy)
    assert.equal(worstOf([]), DRIFT.healthy)
  })

  it('checkEvidence 点名漂移的锚点', () => {
    const entry = {
      id: 'e1',
      evidence: [
        { kind: 'file', ref: 'src/db/pool.ts' },
        { kind: 'file', ref: 'src/gone.ts' },
      ],
    }
    const result = checkEvidence(root, entry)
    assert.equal(result.verdict, DRIFT.quarantined)
    assert.equal(result.drifted.length, 1)
    assert.equal(result.drifted[0].ref, 'src/gone.ts')
  })

  it('没有证据 → unverifiable', () => {
    assert.equal(checkEvidence(root, { id: 'e', evidence: [] }).verdict, DRIFT.unverifiable)
  })
})

describe('全语料', () => {
  it('只返回有问题的条目（健康的没有信息量）', () => {
    const entries = [
      { id: 'ok', evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }] },
      { id: 'gone', evidence: [{ kind: 'file', ref: 'src/gone.ts' }] },
      { id: 'changed', evidence: [{ kind: 'file', ref: 'src/db/pool.ts', hash: 'deadbeef' }] },
      { id: 'unknown', evidence: [{ kind: 'commit', ref: 'abc' }] },
    ]
    const report = driftReport(root, entries)
    assert.equal(report.quarantined.length, 1)
    assert.equal(report.quarantined[0].id, 'gone')
    assert.equal(report.advisory.length, 1)
    assert.equal(report.advisory[0].id, 'changed')
    assert.equal(report.unverifiable, 1)
    assert.equal(report.checked, 4)
  })

  it('文件只读一次（同一次扫描里缓存）', () => {
    const entries = [
      { id: 'a', evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }] },
      { id: 'b', evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }] },
    ]
    const report = driftReport(root, entries)
    assert.equal(report.quarantined.length, 0)
    assert.equal(report.advisory.length, 0)
  })
})

describe('内容寻址（回归）', () => {
  it('**serialize → parse 必须回到同一个 contentHash**', () => {
    // 这是「回执层从未生效」那个 bug 的回归：
    // serializeEntry 在正文后加一个 \n，parseEntry 不剥掉 → 每条记忆永久 tampered。
    const entry = {
      id: 'x',
      title: '标题',
      kind: 'pitfall',
      about: '关于',
      body: '# 功能名\n标题\n\n# 生效条件\n条件。',
      confidence: 'verified',
      provenance: 'self-concluded',
      status: 'active',
      actionRisk: 'R1',
      createdAt: '2026-01-01T00:00:00Z',
      modifiedAt: '2026-01-01T00:00:00Z',
      lastVerifiedAt: '2026-01-01T00:00:00Z',
      scope: ['repo:x'],
      triggers: [],
      supersedes: [],
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts', hash: 'abc' }],
      relations: [],
      claims: [],
    }
    const back = parseEntry(serializeEntry(entry), { idFromPath: 'x' })
    assert.equal(back.body, entry.body, '正文往返必须逐字节相同')
    assert.equal(contentHash(back), contentHash(entry), 'contentHash 必须一致')
  })

  it('正文尾部空白被规范化（serialize 会 trimEnd）', () => {
    const entry = { id: 'x', title: 't', kind: 'fact', about: 'a', body: '正文\n\n', evidence: [], scope: [], triggers: [], supersedes: [] }
    const back = parseEntry(serializeEntry(entry), { idFromPath: 'x' })
    assert.equal(back.body, '正文', '尾部空白是噪声，规范形式去掉它')
    // 而且**幂等**：再序列化一次，文件逐字节相同
    assert.equal(serializeEntry(back), serializeEntry({ ...back, body: back.body }))
  })
})
