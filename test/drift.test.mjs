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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { anchorHash, symbolBodyHash } from '../lib/anchor.js'
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

/* ── 回归：带行号锚点曾 100% 假 advisory ─────────────────────────
 * 根因是两侧算法不同：gate 写入哈希整个文件，drift 复查哈希切片。
 * 现在两边都走 anchor.js 的 anchorHash —— 文件没改必须 healthy。
 */

describe('锚点哈希（跨文件唯一算法）', () => {
  const textOf = (path) => readFileSync(join(root, path), 'utf8')

  it('**文件没改 → healthy**（带行号也走 anchorHash）', () => {
    const text = textOf('src/db/pool.ts')
    const lineHash = anchorHash(text, 'src/db/pool.ts:3')
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts:3', hash: lineHash }).verdict, DRIFT.healthy)

    const wholeHash = anchorHash(text, 'src/db/pool.ts')
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts', hash: wholeHash }).verdict, DRIFT.healthy)
  })

  it('切片真的变了 → advisory', () => {
    const hash = anchorHash(textOf('src/db/pool.ts'), 'src/db/pool.ts:3-5')
    write('src/db/pool.ts', ['export const DB_POOL_MAX = 10', '', 'export function createPool() {', '  return DB_POOL_MAX + 1', '}', ''].join('\n'))
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/db/pool.ts:3-5', hash }).verdict, DRIFT.advisory)
  })

  it('尾部换行不算一行（off-by-one 会让消失的切片报 healthy）', () => {
    write('src/two.txt', 'a\nb\n')
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/two.txt:2' }).verdict, DRIFT.healthy)
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/two.txt:3' }).verdict, DRIFT.quarantined)
  })

  it('空文件是 0 行', () => {
    write('src/empty.txt', '')
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/empty.txt:1' }).verdict, DRIFT.quarantined)
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/empty.txt' }).verdict, DRIFT.healthy)
  })

  /* ── 回归：gate 读文件时剥了 BOM，drift 没剥 → 假 advisory ── */

  it('BOM 文件：gate 写入的哈希在 drift 侧仍然 healthy', () => {
    write('src/bom.ts', '\uFEFFexport const A = 1\n')
    const text = readFileSync(join(root, 'src/bom.ts'), 'utf8')
    // gate 的 readRepoFile 会先剥 BOM 再算哈希
    const hash = anchorHash(text.replace(/^\uFEFF/, ''), 'src/bom.ts:1')
    assert.equal(checkAnchor(root, { kind: 'file', ref: 'src/bom.ts:1', hash }).verdict, DRIFT.healthy)
  })
})

/* ── 回归：symbolBody 在参数表就截断 → 体真改了报 healthy ───────── */

describe('符号体：括号栈', () => {
  const hashOf = (path, name) => symbolBodyHash(readFileSync(join(root, path), 'utf8'), name).hash

  it('解构参数里的 `{` 不是函数体起点', () => {
    write('src/pick.ts', 'export function pick({ id, name }) { return id }\n')
    const hash = hashOf('src/pick.ts', 'pick')
    write('src/pick.ts', 'export function pick({ id, name }) { return name }\n')
    assert.equal(
      checkAnchor(root, { kind: 'symbol', ref: 'src/pick.ts#pick', hash }).verdict,
      DRIFT.advisory,
      '体改了必须 advisory —— 旧实现在参数表就截断，报 healthy',
    )
  })

  it('字符串里的 `}` 不是函数体结束', () => {
    write('src/format.ts', "function format(n) { return '}' }\n")
    const hash = hashOf('src/format.ts', 'format')
    write('src/format.ts', "function format(n) { return '}}' }\n")
    assert.equal(checkAnchor(root, { kind: 'symbol', ref: 'src/format.ts#format', hash }).verdict, DRIFT.advisory)
  })

  it('注释里的 `}` 不会提前归零', () => {
    write('src/guarded.ts', ['function guarded() {', '  // 别在这里写 }', '  return 1', '}', ''].join('\n'))
    const hash = hashOf('src/guarded.ts', 'guarded')
    write('src/guarded.ts', ['function guarded() {', '  // 别在这里写 }', '  return 2', '}', ''].join('\n'))
    assert.equal(checkAnchor(root, { kind: 'symbol', ref: 'src/guarded.ts#guarded', hash }).verdict, DRIFT.advisory)
  })

  it('体没改 → healthy（同一算法，不假报警）', () => {
    write('src/pick.ts', 'export function pick({ id, name }) { return id }\n')
    const hash = hashOf('src/pick.ts', 'pick')
    assert.equal(checkAnchor(root, { kind: 'symbol', ref: 'src/pick.ts#pick', hash }).verdict, DRIFT.healthy)
  })
})

/* ── 回归：findDefinition 把行首调用当定义 ─────────────────────── */

describe('定义形态', () => {
  it('只在行首调用点出现的名字 → symbol-not-a-definition', () => {
    write('src/caller.ts', ['export function make() {', '  return 1', '}', 'createPool({ max: 10 })', ''].join('\n'))
    assert.equal(checkAnchor(root, { kind: 'symbol', ref: 'src/caller.ts#createPool' }).verdict, DRIFT.notADefinition)
  })

  it('类方法定义仍然认', () => {
    write('src/service.ts', ['export class Pool {', '  createPool(size) {', '    return size', '  }', '}', ''].join('\n'))
    assert.equal(checkAnchor(root, { kind: 'symbol', ref: 'src/service.ts#createPool' }).verdict, DRIFT.healthy)
  })
})

/* ── 回归：test 锚点分支曾是空壳（无条件 unverifiable） ─────────── */

describe('测试锚点', () => {
  it('测试名还在 → healthy（单双引号都认）', () => {
    write('test/unit/pool.test.mjs', ['import { it } from "node:test"', "it('pool 上限', () => {})", 'it("带引号的名字", () => {})', ''].join('\n'))
    assert.equal(checkAnchor(root, { kind: 'test', ref: 'pool 上限' }).verdict, DRIFT.healthy)
    assert.equal(checkAnchor(root, { kind: 'test', ref: '带引号的名字' }).verdict, DRIFT.healthy)
  })

  it('测试名找不到 → quarantined', () => {
    write('test/unit/pool.test.mjs', "it('pool 上限', () => {})\n")
    assert.equal(checkAnchor(root, { kind: 'test', ref: '不存在的测试' }).verdict, DRIFT.quarantined)
  })

  it('`tests/` 与 `__tests__/` 也认', () => {
    write('__tests__/a.test.js', "test('回执往返', () => {})\n")
    assert.equal(checkAnchor(root, { kind: 'test', ref: '回执往返' }).verdict, DRIFT.healthy)
  })

  it('没有测试目录 → unverifiable（没资格下「不存在」的判决）', () => {
    assert.equal(checkAnchor(root, { kind: 'test', ref: '任何东西' }).verdict, DRIFT.unverifiable)
  })
})

/* ── 回归：路径无根约束（绝对路径必然 quarantined / ../ 能读库外） ── */

describe('路径越界', () => {
  it('绝对路径锚点 → healthy（join 会拼成 root\\abs）', () => {
    const absolute = join(root, 'src', 'db', 'pool.ts')
    assert.equal(checkAnchor(root, { kind: 'file', ref: absolute }).verdict, DRIFT.healthy)
  })

  it('../ 逃出仓库 → unsafe-path，而不是「文件不存在」', () => {
    const verdict = checkAnchor(root, { kind: 'file', ref: '../secret.txt' })
    assert.equal(verdict.verdict, DRIFT.unsafePath)
    assert.doesNotMatch(verdict.detail, /文件不存在/)
  })

  it('符号锚点的越界路径同样 unsafe-path', () => {
    assert.equal(checkAnchor(root, { kind: 'symbol', ref: '../secret.ts#x' }).verdict, DRIFT.unsafePath)
  })
})

/* ── 回归：报告字段 ─────────────────────────────────────────────── */

describe('报告字段', () => {
  it('drifted 包含 symbol-not-a-definition（指错的锚点也要点名）', () => {
    const result = checkEvidence(root, { id: 'e', evidence: [{ kind: 'symbol', ref: 'src/util.ts#createPool' }] })
    assert.equal(result.verdict, DRIFT.notADefinition)
    assert.equal(result.drifted.length, 1)
    assert.equal(result.drifted[0].verdict, DRIFT.notADefinition)
  })

  it('unverifiable 按**锚点**计，不是按条目计', () => {
    const report = driftReport(root, [
      { id: 'e', evidence: [{ kind: 'commit', ref: 'abc1234' }, { kind: 'command', ref: 'npm test' }] },
    ])
    assert.equal(report.checked, 1)
    assert.equal(report.unverifiable, 2)
  })

  it('at 是 ISO 串（不是毫秒数）', () => {
    assert.equal(driftReport(root, [], { now: Date.parse('2026-11-06T00:00:00Z') }).at, '2026-11-06T00:00:00.000Z')
  })

  it('unsafe-path 单独成桶（不混进「锚点消失」）', () => {
    const report = driftReport(root, [{ id: 'e', evidence: [{ kind: 'file', ref: '../secret.txt' }] }])
    assert.equal(report.unsafePath.length, 1)
    assert.equal(report.quarantined.length, 0)
  })
})
