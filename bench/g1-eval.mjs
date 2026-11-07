/**
 * G1 归属门：拿**本仓库自己的文档**当语料实测。
 *
 * 这是判断「这个插件有没有价值」的唯一判据 —— 如果它把你自己的设计文档
 * 判成「有主」，那前面所有提交都没意义。
 *
 * 三组用例，**判决方向不同**：
 *
 *   A 该拒（文档里已经说过）      —— 拒不到就是漏报（假阴性）
 *   B 该过（文档里没有，值得记）  —— 拒到了就是误伤（假阳性）
 *   C 改写（同义不同词）          —— G1 只认「完全包含」，**预期漏报**
 *
 * C 组必须单独列出来量化：设计文档自己写了「保守实现，误判方向偏向 ACCEPT」，
 * 意思是宁可漏报也不误伤。但漏报率如果不量，这句话就是空话。
 */

import { join } from 'node:path'

import { gateOwnership, collectOwners } from '../lib/gate.js'
import { review } from '../lib/gate.js'
import { resolveConfig } from '../lib/config/index.js'

const root = process.cwd()
const cfg = resolveConfig({ autonomy: 'balanced' })

console.log(`语料：${root}`)
const owners = collectOwners(root)
console.log(`owner 文档 ${owners.length} 份：${owners.map((owner) => `${owner.ref}(${owner.normalized.length}字)`).join(', ')}\n`)

const SIX = (name) =>
  [
    '# 功能名',
    name,
    '',
    '# 生效条件',
    '这个仓库里。',
    '',
    '# 子功能',
    '`lib/gate.js`。',
    '',
    '# 执行',
    '按文档说过的做。',
    '',
    '# 验证方式',
    '跑一遍就知道。',
    '',
    '# 不适用条件',
    '别的仓库。',
  ].join('\n')

const candidate = (id, title, about) => ({
  id,
  title,
  about,
  kind: 'convention',
  body: SIX(title),
  status: 'active',
  confidence: 'verified',
  provenance: 'file-derived',
  actionRisk: 'R1',
  evidence: [{ kind: 'file', ref: 'lib/gate.js' }],
  scope: ['repo:dsh-memory-bank'],
  triggers: [],
})

/* ── A · 该拒：文档里**逐字**说过的断言 ─────────────────────────── */

const SHOULD_REJECT = [
  ['a1', '记忆会过时，但正文永不改写', '一条说 PR 还开着的记忆是在做断言'],
  ['a2', '三值裁决，不是二值', 'ACCEPT REJECT DEFER 三档'],
  ['a3', '休眠不是腐烂', '90 天未被召回只报告绝不改 confidence'],
  ['a4', '不做云同步', '一个 brain，一个 SQLite/Markdown 目录，全本地'],
  ['a5', '不做 LLM-as-judge', '协议是纯算术，可复现'],
  ['a6', '不做自动删除', '唯一的移除路径是显式 memory_forget'],
  ['a7', 'dream 只提议结构，不写记忆', '三个图 pass 写进待决队列'],
  ['a8', '召回无关问题时 abstain 并说出拒的是哪道门', 'abstain 时点名门'],
  ['a9', '只做项目级记忆', '记忆是仓库级制品'],
  ['a10', '推广只产出包，不做全局记忆', 'memory_promote 只提名不搬运'],
]

/* ── B · 该过：文档里**没有**、但值得记的项目事实 ──────────────── */

const SHOULD_ACCEPT = [
  ['b1', 'Node 22 在 Windows 上 node --test 不能传目录', '必须用 test/*.test.mjs 通配符'],
  ['b2', '写文件前必须先 read', '否则 edit 工具报 file has not been read'],
  ['b3', 'PowerShell 里双引号会吃掉反引号', 'node -e 调试脚本要用 here-string'],
  ['b4', 'bench 目录不进 npm files', '发布时排除'],
  ['b5', '临时文件要用 .tmp- 前缀', '方便一次性清理'],
]

/* ── C · 改写：同义不同词（**预期漏报**） ──────────────────────── */

const PARAPHRASE = [
  ['c1', '记忆随仓库走，不随会话走', '每条记忆都是这个仓库的制品'],
  ['c2', '判定不依赖模型，同样的输入永远同样的结论', '协议是纯算术'],
  ['c3', '拿不准的时候交给人，机器不替人做价值判断', 'DEFER 是人的判断'],
  ['c4', '记忆正文一旦写下就不再改，世界变了另存', '正文永不改写'],
  ['c5', '跨项目的那一层不归这个插件管', '只做项目级记忆'],
]

/* ── 跑 ─────────────────────────────────────────────────────────── */

const evaluate = (cases, label, expectReject) => {
  const rows = []
  for (const [id, title, about] of cases) {
    const verdict = gateOwnership(candidate(id, title, about), { owners })
    const rejected = verdict.kind === 'refuse'
    rows.push({ id, title, rejected, owner: verdict.detail?.owner?.ref ?? null, matched: verdict.detail?.matched ?? null })
  }
  const hits = rows.filter((row) => row.rejected === expectReject).length
  return { label, rows, hits, total: rows.length, expectReject }
}

const a = evaluate(SHOULD_REJECT, 'A 该拒（文档逐字说过）', true)
const b = evaluate(SHOULD_ACCEPT, 'B 该过（文档没有）', false)
const c = evaluate(PARAPHRASE, 'C 改写（预期漏报）', true)

for (const group of [a, b, c]) {
  console.log(`\n${group.label}  ${group.hits}/${group.total}`)
  for (const row of group.rows) {
    const mark = row.rejected ? '拒' : '过'
    const ok = row.rejected === group.expectReject
    const extra = row.rejected ? ` ← ${row.owner}` : ''
    console.log(`  ${ok ? '✅' : '❌'} ${mark} ${row.id}  ${row.title}${extra}`)
  }
}

/* ── 终审：走完整 review（G1 只拒掉一部分，其余门也可能拒） ──── */

console.log('\n' + '='.repeat(74))
console.log('终审（完整十道门，看 G1 的判决会不会被别的门盖掉）\n')

let correct = 0
const detail = []
for (const [id, title, about] of [...SHOULD_REJECT.map((r) => [...r, true]), ...SHOULD_ACCEPT.map((r) => [...r, false])]) {
  const verdict = review(candidate(id, title, about), { root, config: cfg, owners, corpus: [] })
  const summary = verdict.decision === 'REJECT' ? `REJECT(${verdict.code})` : verdict.decision
  const expectReject = id.startsWith('a')
  const ok = expectReject ? verdict.decision === 'REJECT' : verdict.decision !== 'REJECT'
  if (ok) correct += 1
  detail.push({ id, title, summary, ok, expectReject })
}
for (const row of detail) {
  console.log(`  ${row.ok ? '✅' : '❌'} ${row.id}  ${row.summary.padEnd(28)} ${row.title}`)
}

console.log('\n' + '='.repeat(74))
console.log(`G1 单门   —— 真阳性 ${a.hits}/${a.total} · 假阳性 ${b.total - b.hits}/${b.total} · 改写漏报 ${c.total - c.hits}/${c.total}`)
console.log(`完整协议  —— 正确 ${correct}/${detail.length}`)
console.log(
  `\n精度 = ${((a.hits + b.hits) / (a.total + b.total) * 100).toFixed(1)}%   ` +
    `（该拒的拒 + 该过的过 / 总数，不含改写组）`,
)
