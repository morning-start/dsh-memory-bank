/**
 * 实验：**改写召回能不能不靠模型救回来？**
 *
 * G1 现在只做「归一化后完全包含」—— 逐字 10/10，改写 0/5。
 * 在给 `embedding` 通道写任何代码之前，先回答一个问题：
 * **加权向量（TF-IDF over 词 + 字符 bigram）能不能把 C 组和 B 组分开？**
 *
 * ## 为什么第一版度量是错的
 *
 * 第一版用**余弦**比候选与被稀释的 60 字窗口，得到 A 最低 0.079 —— 逐字的
 * 候选怎么会这么低？因为余弦被窗口长度惩罚：5 个 token 的候选对上 50 个
 * token 的窗口，`dot ≈ 1/√50 ≈ 0.14`。**分数低不代表不包含，只代表窗口长。**
 *
 * 这里要问的问题是「这段文档**拥有**这条断言吗」，是**包含**关系，不是相似关系。
 * 所以用非对称的加权包含度：
 *
 *     containment(a, b) = Σ_{t∈a} w_a[t] · [t ∈ b] / Σ_{t∈a} w_a[t]
 *
 * 值域 [0,1]，1.0 当且仅当候选的每个 token 都在窗口里。idf 权重让
 * 「的记忆」这种高频词压不过「仓库」「判断」这种内容词。
 *
 * 判据不是「C 的分数高」，而是 **C 的最低分 > B 的最高分** —— 只有那样才有阈值可用。
 * 如果两组重叠，那么任何阈值都是拿误伤换漏报，这个通道就不该开。
 */

import { collectOwners } from '../lib/gate.js'

const owners = collectOwners(process.cwd())

const A = [
  '记忆会过时，但正文永不改写',
  '三值裁决，不是二值',
  '休眠不是腐烂',
  '不做云同步',
  '不做 LLM-as-judge',
  '不做自动删除',
  'dream 只提议结构，不写记忆',
  '召回无关问题时 abstain 并说出拒的是哪道门',
  '只做项目级记忆',
  '推广只产出包，不做全局记忆',
]
const B = [
  'Node 22 在 Windows 上 node --test 不能传目录',
  '写文件前必须先 read',
  'PowerShell 里双引号会吃掉反引号',
  'bench 目录不进 npm files',
  '临时文件要用 .tmp- 前缀',
]
const C = [
  '记忆随仓库走，不随会话走',
  '判定不依赖模型，同样的输入永远同样的结论',
  '拿不准的时候交给人，机器不替人做价值判断',
  '记忆正文一旦写下就不再改，世界变了另存',
  '跨项目的那一层不归这个插件管',
]

/* ── 分词：英文按词，中文按字符 bigram ─────────────────────────────── */

const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '个', '这', '那', '有', '不', '要', '会', '把', '被', '从', '到', '为', '以', '一个', '我们', '你', '它', 'to', 'a', 'the', 'of', 'is', 'in', 'and', 'or',
])

function tokenize(text) {
  const out = []
  const lowered = String(text ?? '').toLowerCase()
  for (const match of lowered.matchAll(/[a-z][a-z0-9_+#.-]{1,}/g)) out.push(match[0])
  for (const match of lowered.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length === 1) {
      if (!STOP.has(run)) out.push(run)
      continue
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const gram = run.slice(index, index + 2)
      if (!STOP.has(gram)) out.push(gram)
    }
  }
  return out
}

/* ── 加权包含度 ───────────────────────────────────────────────────── */

const docTokens = owners.map((owner) => tokenize(owner.normalized))
const df = new Map()
for (const tokens of docTokens) for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1)
const idf = (token) => Math.log((owners.length + 1) / ((df.get(token) ?? 0) + 1)) + 1

function weighted(tokens) {
  const counts = new Map()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  const out = new Map()
  let total = 0
  for (const [token, count] of counts) {
    const weight = (1 + Math.log(count)) * idf(token)
    out.set(token, weight)
    total += weight
  }
  return { weights: out, total: total || 1 }
}

/** a 的权重有多少落在 b 里。 */
function containment(a, bTokens) {
  const present = new Set(bTokens)
  let hit = 0
  for (const [token, weight] of a.weights) if (present.has(token)) hit += weight
  return hit / a.total
}

/* ── 滑窗 ─────────────────────────────────────────────────────────── */

const WIDTHS = [24, 40, 64, 96, 160]

function bestPassage(candidateTokens) {
  const a = weighted(candidateTokens)
  let best = { score: 0, ref: null, text: '', width: 0 }

  for (const [index, owner] of owners.entries()) {
    const text = owner.normalized
    const allTokens = docTokens[index]
    for (const width of WIDTHS) {
      // 按 token 位置切窗口（比按字符切稳 —— 字符窗口会把 bigram 切断）
      for (let start = 0; start < allTokens.length; start += 2) {
        const slice = allTokens.slice(start, start + width)
        if (slice.length < 2) continue
        const score = containment(a, slice)
        if (score > best.score) {
          best = { score, ref: owner.ref, text: text.slice(start * 0.8, start * 0.8 + width * 2), width }
        }
      }
    }
  }
  return best
}

/* ── 跑 ───────────────────────────────────────────────────────────── */

const group = (label, list) => {
  const rows = list.map((title) => ({ title, ...bestPassage(tokenize(title)) }))
  rows.sort((a, b) => a.score - b.score)
  console.log(`\n${label}   min ${rows[0].score.toFixed(3)}  max ${rows.at(-1).score.toFixed(3)}`)
  for (const row of rows) console.log(`  ${row.score.toFixed(3)}  w=${String(row.width).padEnd(4)} ${String(row.ref ?? '—').padEnd(20)} ${row.title}`)
  return rows
}

console.log(`语料：${owners.length} 份 owner 文档 · ${docTokens.reduce((sum, t) => sum + t.length, 0)} token · 词表 ${df.size}`)
const a = group('A 逐字（该拒）', A)
const b = group('B 无关（该过）', B)
const c = group('C 改写（该拒）', C)

console.log('\n' + '='.repeat(74))
console.log(`A 最低 ${a[0].score.toFixed(3)}   B 最高 ${b.at(-1).score.toFixed(3)}   C 最低 ${c[0].score.toFixed(3)}`)
const margin = c[0].score - b.at(-1).score
console.log(`分离（C 最低 - B 最高）= ${margin.toFixed(3)}`)
if (margin > 0.05) {
  console.log(`✅ 可分离 —— 阈值取 ${((c[0].score + b.at(-1).score) / 2).toFixed(3)}`)
} else {
  console.log('❌ 不可分离 —— 任何阈值都是拿误伤换漏报')
}
