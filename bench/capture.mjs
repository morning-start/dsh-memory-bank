/**
 * 捕获路径基准：`agent/turn-stopping` 是宿主 **await** 的路径 ——
 * 它花多少，用户就多等多少才看到回合结束。
 *
 * 对比：
 *   旧实现  同步跑完「八道门 + 写记忆 + 重建索引」
 *   新实现  只做「确定性判定 + 落盘入队」，处理交给后台 drain
 *
 * 注意：每一轮的候选必须**互不相同**，否则 G5 会把它们全部当重复，
 * 测出来的就是 G5 的拒绝成本而不是写入成本。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCandidate, foldTurn, shouldCapture } from '../lib/capture.js'
import { resolveConfig } from '../lib/config/index.js'
import { collectOwners, review } from '../lib/gate.js'
import { ensureSnapshot, markDirty } from '../lib/index-build.js'
import { normalizeId } from '../lib/model.js'
import {
  appendLedger,
  appendReceipt,
  ensureLayout,
  readAll,
  readInbox,
  removeInbox,
  writeEntry,
  writeInbox,
} from '../lib/store.js'

const COUNT = 200
const ROUNDS = 30
const root = mkdtempSync(join(tmpdir(), 'dsh-capture-bench-'))
mkdirSync(join(root, 'src', 'db'), { recursive: true })
mkdirSync(join(root, 'docs'), { recursive: true })
mkdirSync(join(root, '.dsh-memory', 'memories'), { recursive: true })

const longDoc = (title) =>
  `# ${title}\n\n` +
  Array.from({ length: 30 }, (_, index) => `## 小节 ${index}\n\n这是一段说明文字，用来模拟真实的文档体积。它包含一些技术细节与判据。\n`).join('\n')
writeFileSync(join(root, 'AGENTS.md'), longDoc('AGENTS'), 'utf8')
writeFileSync(join(root, 'README.md'), longDoc('README'), 'utf8')
for (let index = 0; index < 4; index += 1) {
  writeFileSync(join(root, 'docs', `0${index}-doc.md`), longDoc(`doc ${index}`), 'utf8')
}

const SIX = (name, topic) =>
  [
    '# 功能名',
    name,
    '',
    '# 生效条件',
    `${topic} 环境，部署后健康检查超时。`,
    '',
    '# 子功能',
    '`src/db/pool.ts`、`DB_POOL_MAX` 环境变量。',
    '',
    '# 执行',
    `${topic} 先看 DB_POOL_MAX。加 worker 只会让更多请求排在同样 10 个连接后面。`,
    '',
    '# 验证方式',
    '`kubectl exec deploy/api -- env | grep DB_POOL_MAX` 应返回 10。',
    '',
    '# 不适用条件',
    `${topic} 的生产环境。`,
  ].join('\n')

const TOPICS = ['staging', 'preview', 'canary', 'nightly', 'sandbox', 'review', 'qa', 'uat', 'perf', 'chaos']

for (let index = 0; index < COUNT; index += 1) {
  const topic = TOPICS[index % TOPICS.length]
  writeEntry(root, {
    id: `memory_${String(index).padStart(3, '0')}`,
    title: `第 ${index} 条 ${topic} 超时排查笔记`,
    kind: 'pitfall',
    about: `${topic} 健康检查超时的第 ${index} 种成因`,
    body: SIX(`第 ${index} 条 ${topic} 笔记。`, `${topic}-${index}`),
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:bench'],
    triggers: [`${topic} 超时`],
    provenance: 'self-concluded',
  })
}

// 语料已经 200 条，默认配额（growth 50 / repo 200）会让 G7 全部拒绝 ——
// 那样测的是「配额门拦下」的成本，不是「写入」的成本。这里放开配额。
const cfg = resolveConfig({
  autonomy: 'balanced',
  quota: { repo: 100_000, global: 100_000, growthThreshold: 100_000 },
})
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.floor(values.length * p)]

const eventsFor = (round) => {
  const topic = `${TOPICS[round % TOPICS.length]}-${round}`
  return [
    { type: 'user/message', data: { text: `记住：${topic} 的健康检查超时先查 DB_POOL_MAX，不要再加 worker 了。` } },
    { type: 'assistant/message', data: { text: `明白了，${topic} 我会先查连接池上限，不是加 worker。` } },
    { type: 'tool/call', data: { name: 'Edit', arguments: { file_path: 'src/db/pool.ts' } } },
    { type: 'tool/result', data: { name: 'Edit', isError: false, text: 'ok' } },
  ]
}

console.log(`语料 ${COUNT} 条 · owner 文档 6 份 · ${ROUNDS} 轮取中位数\n`)
ensureSnapshot(root)

/* ── 新：turn-stopping 只入队 ─────────────────────────────────── */

const enqueueTimes = []
for (let round = 0; round < ROUNDS; round += 1) {
  const started = process.hrtime.bigint()
  const facts = foldTurn(eventsFor(round), { turn: round })
  facts.sessionId = 'bench'
  const { entries } = readAll(root)
  const decision = shouldCapture(facts, { corpus: entries, config: cfg })
  if (decision.capture) {
    writeInbox(root, {
      sessionId: 'bench',
      turn: round,
      hit: decision.hits[0],
      facts: {
        turn: facts.turn,
        userTexts: facts.userTexts,
        assistantTexts: facts.assistantTexts,
        editedFiles: facts.editedFiles,
        failedCommands: [],
        succeededCommands: facts.succeededCommands.map((item) => ({ name: item.name })),
      },
      candidateId: normalizeId(facts.userTexts[0].slice(0, 40)),
    })
  }
  enqueueTimes.push(Number(process.hrtime.bigint() - started) / 1e6)
}

/* ── 旧：turn-stopping 同步跑完整条链 ─────────────────────────── */

const legacyTimes = []
for (let round = 0; round < 5; round += 1) {
  const started = process.hrtime.bigint()
  const facts = foldTurn(eventsFor(500 + round), { turn: round })
  facts.sessionId = 'legacy'
  const { entries } = readAll(root)
  const decision = shouldCapture(facts, { corpus: entries, config: cfg })
  if (decision.capture) {
    const candidate = buildCandidate(facts, decision.hits[0], { id: `legacy_${round}` })
    const verdict = review(candidate, { root, config: cfg, corpus: entries, owners: collectOwners(root) })
    const entry = writeEntry(root, { ...candidate, evidence: verdict.resolvedEvidence ?? candidate.evidence })
    appendReceipt(root, entry)
    appendLedger(root, { kind: 'attempt', id: entry.id, decision: verdict.decision })
    ensureSnapshot(root, { force: true })
  }
  legacyTimes.push(Number(process.hrtime.bigint() - started) / 1e6)
}

/* ── 后台：drain 各项 ─────────────────────────────────────────── */

const drainTimes = []
const outcomes = {}
for (const item of readInbox(root)) {
  const started = process.hrtime.bigint()
  ensureLayout(root)
  const facts = { ...item.facts, sessionId: item.sessionId, turn: item.turn, agent: null }
  const candidate = buildCandidate(facts, item.hit, { id: `${item.candidateId}_${item.turn}` })
  const { entries } = readAll(root)
  const verdict = review(candidate, { root, config: cfg, corpus: entries, owners: collectOwners(root) })
  outcomes[verdict.decision] = (outcomes[verdict.decision] ?? 0) + 1
  if (verdict.decision === 'ACCEPT') {
    const entry = writeEntry(root, { ...candidate, evidence: verdict.resolvedEvidence ?? candidate.evidence })
    appendReceipt(root, entry)
    appendLedger(root, { kind: 'attempt', id: entry.id, decision: 'accepted' })
    markDirty(root)
  }
  removeInbox(root, item.id)
  drainTimes.push(Number(process.hrtime.bigint() - started) / 1e6)
}

console.log('旧实现（同步跑完整条链，阻塞回合）：')
console.log(`  回合关闭等待              p50 ${pct(legacyTimes, 0.5).toFixed(2)} ms\n`)
console.log('新实现：')
console.log(`  turn-stopping（入队）      p50 ${pct(enqueueTimes, 0.5).toFixed(2)} ms   ← 宿主 await 这条`)
console.log(`  后台 drain（跑门 + 写入）  p50 ${pct(drainTimes, 0.5).toFixed(2)} ms   ← 用户看不到`)
console.log(`\n回合关闭少等：${(pct(legacyTimes, 0.5) - pct(enqueueTimes, 0.5)).toFixed(1)} ms`)
console.log(`drain 结果：${Object.entries(outcomes).map(([key, value]) => `${key} ${value}`).join(' · ')}`)

rmSync(root, { recursive: true, force: true })
