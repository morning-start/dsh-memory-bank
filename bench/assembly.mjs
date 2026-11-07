/**
 * 冷/热路径基准：证明缓存真的省了时间。
 *
 * 只测**装配路径**（每轮 prompt 都会跑的那条），不测一次性写入。
 * 数字用于判断「这个优化值不值得」，不作为性能承诺 —— 磁盘、杀毒软件、
 * 文件系统都会大幅改变绝对值。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config/index.js'
import { clearSnapshotCache, ensureSnapshot } from '../lib/index-build.js'
import { recall } from '../lib/recall.js'
import { clearStoreCache, invalidateCorpus, writeEntry } from '../lib/store.js'

const COUNT = 200
const ROUNDS = 20

const root = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
mkdirSync(join(root, 'src', 'db'), { recursive: true })
mkdirSync(join(root, '.dsh-memory', 'memories'), { recursive: true })

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
    '先看 `DB_POOL_MAX`。加 worker 只会让更多请求排在同样 10 个连接后面，健康检查反而更早超时。',
    '',
    '# 验证方式',
    '`kubectl -n staging exec deploy/api -- env | grep DB_POOL_MAX` 应返回 10。',
    '',
    '# 不适用条件',
    '生产环境（连接池按实例数缩放，不是固定值）。',
  ].join('\n')

console.log(`写入 ${COUNT} 条记忆…`)
for (let index = 0; index < COUNT; index += 1) {
  const id = `memory_${String(index).padStart(3, '0')}`
  writeEntry(root, {
    id,
    title: `第 ${index} 条 staging 超时排查笔记`,
    kind: 'pitfall',
    about: `staging 健康检查超时的第 ${index} 种成因与排查顺序`,
    body: SIX(`第 ${index} 条 staging 超时排查笔记。这一段正文足够长，让索引有东西可做。`),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:bench'],
    triggers: ['staging 健康检查超时', `笔记 ${index}`],
    provenance: 'self-concluded',
  })
}

const cfg = resolveConfig({ autonomy: 'balanced' })

const time = (label, fn) => {
  const started = process.hrtime.bigint()
  const value = fn()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(2)} ms`)
  return value
}

console.log('\n冷启动（无缓存）：')
clearStoreCache()
clearSnapshotCache()
const { snapshot } = time('ensureSnapshot', () => ensureSnapshot(root))

console.log('\n热路径（缓存命中，模拟每轮 prompt 装配）：')
const ensureTimes = []
const recallTimes = []
for (let round = 0; round < ROUNDS; round += 1) {
  let started = process.hrtime.bigint()
  ensureSnapshot(root)
  ensureTimes.push(Number(process.hrtime.bigint() - started) / 1e6)

  started = process.hrtime.bigint()
  recall('staging 健康检查 超时 连接池', snapshot, { config: cfg, limit: 3 })
  recallTimes.push(Number(process.hrtime.bigint() - started) / 1e6)
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor(values.length * p)]
console.log(`  ensureSnapshot                   p50 ${percentile(ensureTimes, 0.5).toFixed(2)} ms`)
console.log(`  recall（5 路 + RRF + MMR）        p50 ${percentile(recallTimes, 0.5).toFixed(2)} ms`)
console.log(
  `  每轮合计                          p50 ${(percentile(ensureTimes, 0.5) + percentile(recallTimes, 0.5)).toFixed(2)} ms · ` +
    `p95 ${(percentile(ensureTimes, 0.95) + percentile(recallTimes, 0.95)).toFixed(2)} ms`,
)

console.log('\n缓存失效后（改一条记忆）：')
const cold = []
for (let round = 0; round < 5; round += 1) {
  writeEntry(root, {
    id: `memory_${String(round).padStart(3, '0')}`,
    title: `第 ${round} 条 staging 超时排查笔记（改）`,
    kind: 'pitfall',
    about: `staging 健康检查超时的第 ${round} 种成因与排查顺序（改）`,
    body: SIX(`第 ${round} 条 staging 超时排查笔记。改过之后会重建索引。`),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:bench'],
    triggers: ['staging 健康检查超时'],
    provenance: 'self-concluded',
  })
  const started = process.hrtime.bigint()
  ensureSnapshot(root)
  cold.push(Number(process.hrtime.bigint() - started) / 1e6)
}
console.log(`  重建一次（200 条）               ${(cold.reduce((a, b) => a + b, 0) / cold.length).toFixed(2)} ms`)

console.log(`\n语料：${COUNT} 条 · 文档 ${snapshot.documents.length} 篇 · 词表 ${snapshot.postings.terms.length} 个`)
invalidateCorpus(root)
rmSync(root, { recursive: true, force: true })
