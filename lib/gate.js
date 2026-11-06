/**
 * 记忆审核协议（MRP v1）—— 八道门。
 *
 * 协议是**确定性**的：同样的候选 + 同样的仓库 + 同样的配置 → 同样的裁决。
 * 协议**不调用模型**。这是它敢自动跑的前提。
 *
 * 三值裁决：
 *   ACCEPT  全部 pass
 *   REJECT  某个硬门 refuse —— 回给模型（可机械判定、可修，必须带 next）
 *   DEFER   只有 G6 冲突 / G8 置信不足 —— 交用户裁决
 *
 * 合成规则：硬门任一 refuse 即 REJECT（短路）；否则任一 soft refuse 即 DEFER。
 * 只有「两条都成立但相互矛盾」和「说不清值不值得」需要人。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ID_PATTERN, actionRiskOf, validateEntry } from './model.js'
import { collapse, jaccard, levenshtein, ngrams, sha256, tokenize, truncate } from './util.js'

/** 硬门：refuse 即 REJECT。G6/G8 不在里面 —— 它们是 DEFER 的来源。 */
export const HARD_GATES = new Set(['G1', 'G2', 'G3', 'G3b', 'G4', 'G5', 'G7'])

export const INJECTION_OVERRIDE =
  /\b(?:ignore|override|bypass|disregard)\b.{0,24}?\b(?:system|developer|user)\b[\s-]{0,3}(?:instructions?|prompts?|messages?)\b|(?:忽略|无视|绕过|覆盖).{0,6}?(?:系统|开发者|用户).{0,4}?(?:指令|提示词|消息)/iu

/** 默认安全规则：高精度，宁可漏报也不误伤正常记忆。 */
export const DEFAULT_FORBIDDEN = Object.freeze([
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  '\\bsk-[A-Za-z0-9_\\-]{20,}',
  '\\bAKIA[0-9A-Z]{16}\\b',
  '\\bgh[pousr]_[A-Za-z0-9]{20,}\\b',
  '(?i)\\bapi[_-]?key\\s*[:=]\\s*[A-Za-z0-9_\\-]{16,}',
  '(?i)\\b(app[_-]?secret|appsecret|client[_-]?secret|secret[_-]?key|access[_-]?key)\\s*[:=]?\\s*[A-Za-z0-9]{16,}',
  '(?i)\\b(password|passwd|pwd|密码|口令)\\s*[:=：]\\s*\\S{6,}',
  '(?i)\\bBearer\\s+[A-Za-z0-9._\\-]{20,}',
  '[a-z][a-z0-9+.\\-]*://[^/\\s:@]+:[^/\\s@]+@',
  '\\btk_[0-9a-f]{8,}\\b',
  'mdcg1\\.[A-Za-z0-9._\\-]{20,}',
])

/* ── 裁决构造 ─────────────────────────────────────────────────────── */

const pass = (gate, note) => ({ gate, kind: 'pass', ...(note ? { note } : {}) })
const downgrade = (gate, code, detail, note) => ({ gate, kind: 'downgrade', code, detail, ...(note ? { note } : {}) })
const refuse = (gate, code, detail) => ({ gate, kind: 'refuse', code, detail })

/**
 * 合成八道门的意见。`next` 由调用方按 code 生成（协议只管裁决，不管措辞）。
 */
export function decide(verdicts) {
  const hard = verdicts.find((verdict) => verdict.kind === 'refuse' && HARD_GATES.has(verdict.gate))
  if (hard) return { decision: 'REJECT', code: hard.code, gate: hard.gate, detail: hard.detail, gates: verdicts }

  const soft = verdicts.find((verdict) => verdict.kind === 'refuse')
  if (soft) return { decision: 'DEFER', code: soft.code, gate: soft.gate, detail: soft.detail, gates: verdicts }

  return { decision: 'ACCEPT', gates: verdicts }
}

/* ── 归属语料 ─────────────────────────────────────────────────────── */

const OWNER_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTRIBUTING.md', '.cursorrules']
const OWNER_DIRS = ['docs']

/** 归一化：去空白与标点，只留语义字符。用于「完全包含」判定。 */
function semantic(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 收集「已有主人」的文档。**保守**：只读固定几个入口文件（+ docs 第一层），
 * 不做全仓扫描 —— 误判方向必须偏向 ACCEPT。
 */
export function collectOwners(root) {
  const owners = []
  const push = (absolutePath, relPath) => {
    try {
      if (!statSync(absolutePath).isFile()) return
      const text = readFileSync(absolutePath, 'utf8')
      if (!text.trim()) return
      owners.push({ ref: relPath, normalized: semantic(text), text })
    } catch {
      /* 读不到就当没有 */
    }
  }
  for (const name of OWNER_FILES) push(join(root, name), name)
  for (const dir of OWNER_DIRS) {
    const absolute = join(root, dir)
    if (!existsSync(absolute)) continue
    try {
      for (const name of readdirSync(absolute).slice(0, 50)) {
        if (!name.endsWith('.md')) continue
        push(join(absolute, name), `${dir}/${name}`)
      }
    } catch {
      /* 目录不可读 */
    }
  }
  return owners
}

/* ── G1 · 归属门 ──────────────────────────────────────────────────── */

/**
 * 这条断言是不是已经由规则文件 / 权威文档拥有？
 *
 * 判据是**完全包含**：候选的 title 或 about（去标点后 ≥8 字）出现在
 * 某个 owner 文档里。保守实现，宁可漏拒 —— 误判方向必须偏向 ACCEPT。
 */
export function gateOwnership(candidate, { owners = [] } = {}) {
  const targets = [candidate.title, candidate.about]
    .map(semantic)
    .filter((text) => text.length >= 8)
  if (targets.length === 0) return pass('G1')

  for (const owner of owners) {
    for (const target of targets) {
      if (!owner.normalized.includes(target)) continue
      return refuse('G1', 'owned-elsewhere', {
        owner: { kind: 'doc', ref: owner.ref },
        why: '该断言已由这份文档拥有；再进记忆只会多一份会漂移的副本',
        matched: truncate(target, 40),
      })
    }
  }
  return pass('G1')
}

/* ── G2 · 形态门 ──────────────────────────────────────────────────── */

const TEMPLATE_HEADINGS = ['功能名', '生效条件', '子功能', '执行', '验证方式', '不适用条件']

/** 一条记忆只讲一件事？必需要素齐？ */
export function gateShape(candidate, { template = TEMPLATE_HEADINGS } = {}) {
  const { ok, errors } = validateEntry(candidate)
  if (!ok) return refuse('G2', 'shape', { errors })

  const headings = [...candidate.body.matchAll(/^#{1,3}\s*(.+?)\s*$/gm)].map((match) => match[1])
  const missing = template.filter((heading) => !headings.some((found) => found.includes(heading)))
  if (missing.length > 0) {
    return refuse('G2', 'shape.template', {
      missing,
      hint: `正文必须含六要素标题：${template.join(' / ')}。缺「不适用条件」的记忆会污染所有它看起来相关的判断。`,
    })
  }
  if (headings.length > 6) {
    return refuse('G2', 'shape.multi-topic', {
      headings,
      hint: '一条记忆只讲一件事；拆成多条，或合并成一条。',
    })
  }
  return pass('G2')
}

/* ── G3 · 安全门 ──────────────────────────────────────────────────── */

/** 含密钥 / 令牌 / PII？命中即硬拒，且**不回显命中片段**。 */
export function gateSafety(candidate, { forbidden = DEFAULT_FORBIDDEN } = {}) {
  const haystack = `${candidate.title ?? ''}\n${candidate.about ?? ''}\n${candidate.body ?? ''}`
  for (const [index, pattern] of forbidden.entries()) {
    let regex
    try {
      regex = new RegExp(pattern, pattern.startsWith('(?i)') ? '' : 'u')
    } catch {
      continue
    }
    if (regex.test(haystack)) {
      // 只回规则序号，不回命中内容 —— 把命中片段回给模型是二次泄露
      return refuse('G3', 'secret', { rule: index + 1, hint: '凭据不入库。删掉密文后重写。' })
    }
  }
  return pass('G3')
}

/* ── G3b · 注入门 ─────────────────────────────────────────────────── */

/**
 * 这条记忆是不是在**指挥宿主**？
 *
 * 模式故意窄：三段必须相邻（动词 + 被寻址的层 + 它命名的产物）。
 * 上一版接受 `system|developer|instruction|policy|safety` 中任意一个，
 * 中文分支接受「规则」「安全」—— 实测在 356 条语料上永久屏蔽了 4 条记忆、
 * 一次真攻击也没抓到。精确性靠匹配器买，不靠软化后果。
 */
export function gateInjection(candidate, extraTexts = []) {
  const surfaces = [candidate.title, candidate.about, candidate.body, ...extraTexts]
  for (const text of surfaces) {
    if (typeof text === 'string' && INJECTION_OVERRIDE.test(text)) {
      return refuse('G3b', 'injection', {
        hint: '记忆不能指挥宿主。把它改写成对事实的陈述，而不是对系统的指令。',
      })
    }
  }
  return pass('G3b')
}

/* ── G4 · 证据门 ──────────────────────────────────────────────────── */

function readLineCount(absolutePath) {
  try {
    return readFileSync(absolutePath, 'utf8').split('\n').length
  } catch {
    return 0
  }
}

function fileHash(absolutePath) {
  try {
    return sha256(readFileSync(absolutePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 每条断言都有可解析锚点吗？锚点现在还对得上吗？
 *
 * 首写（无 hash）：解析锚点、计算 hash 写回。
 * 复查（有 hash）：一致 pass；不一致 downgrade；目标消失 refuse。
 *
 * `symbol` / `test` / `command` / `user` 这类锚点无法廉价解析：
 * 有文件锚点时降级为 advisory（`symbol-unverifiable`），无文件锚点则拒绝。
 */
export function gateEvidence(candidate, { root } = {}) {
  const evidence = candidate.evidence ?? []
  if (evidence.length === 0) return refuse('G4', 'evidence.none', { hint: '至少给一条可解析的锚点。' })

  const resolved = []
  let fileAnchors = 0

  for (const item of evidence) {
    const ref = String(item.ref ?? '').trim()
    if (!ref) return refuse('G4', 'evidence.invalid', { detail: '空的 ref' })

    if (item.kind === 'file' || item.kind === 'doc') {
      const [rawPath, rawLine] = ref.split(':')
      const absolute = join(root, rawPath)
      if (!existsSync(absolute)) {
        return refuse('G4', 'evidence.unresolved', { ref, hint: `路径不存在：${rawPath}` })
      }
      fileAnchors += 1
      const lineCount = readLineCount(absolute)
      if (rawLine && Number(rawLine) > lineCount) {
        return refuse('G4', 'evidence.unresolved', { ref, hint: `文件只有 ${lineCount} 行` })
      }
      const actual = fileHash(absolute)
      if (item.hash && actual && item.hash !== actual) {
        return downgrade('G4', 'evidence.drifted', {
          ref,
          hint: '锚点的内容变了（通常是重构）。重新核对后重写这条记忆。',
        })
      }
      resolved.push({ ...item, ref, hash: item.hash ?? actual ?? undefined })
      continue
    }

    if (item.kind === 'commit') {
      if (!/^[0-9a-f]{7,64}$/i.test(ref)) {
        return refuse('G4', 'evidence.invalid', { ref, hint: '提交锚点必须是 7-64 位十六进制' })
      }
      resolved.push({ ...item, ref })
      continue
    }

    // symbol / test / command / user：无法廉价验证
    resolved.push({ ...item, ref })
  }

  if (fileAnchors === 0) {
    return refuse('G4', 'evidence.unresolved', {
      hint: '至少要有一条可解析的文件/文档锚点；符号、测试或命令无法独立验证。',
    })
  }

  return { ...pass('G4'), resolvedEvidence: resolved }
}

/* ── G5 · 重复门 ──────────────────────────────────────────────────── */

function stripCodeBlocks(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, ' ')
}

function fingerprintFeatures(text) {
  const clean = stripCodeBlocks(text)
  const tokens = tokenize(clean)
  const tri = ngrams(tokens.join(' '), 3)
  const chars = [...clean.replace(/\s+/g, '')]
  const prefixes = new Set()
  for (let i = 0; i + 12 <= chars.length; i += 4) prefixes.add(`c12:${chars.slice(i, i + 12).join('')}`)
  return new Set([...tokens.map((token) => `t:${token}`), ...tri.map((gram) => `t3:${gram}`), ...prefixes])
}

/** SimHash 近似：用特征集合的 Jaccard 当代理（确定性、无需位运算）。 */
function simhashSimilarity(a, b) {
  return jaccard(a, b)
}

/** 近重复：**双阈值合取**。只用一个会在短条目上误报。 */
export function gateDuplicate(candidate, { corpus = [], threshold = 0.82 } = {}) {
  if ((candidate.body ?? '').length < 1) return pass('G5')
  const features = fingerprintFeatures(`${candidate.about ?? ''}\n${candidate.body ?? ''}`)
  if (features.size < 16) return pass('G5') // 特征太少，任何相似度都不稳定

  for (const existing of corpus) {
    if (existing.status !== 'active' && existing.status !== 'advisory') continue
    const other = fingerprintFeatures(`${existing.about ?? ''}\n${existing.body ?? ''}`)
    if (other.size < 16) continue
    const simhash = simhashSimilarity(features, other)
    const minhash = jaccard(
      new Set([...features].filter((f) => f.startsWith('t:'))),
      new Set([...other].filter((f) => f.startsWith('t:'))),
    )
    if (existing.id === candidate.id && (simhash > 0.95 || minhash > 0.95)) return pass('G5')
    if (simhash >= threshold && minhash >= 0.72) {
      return refuse('G5', 'duplicate', {
        existing: existing.id,
        similarity: Number(simhash.toFixed(3)),
        hint: `已存在 ${existing.id}。用 memory_remember 传 supersedes 覆盖，或改用 memory_resolve 编辑。`,
      })
    }
  }
  return pass('G5')
}

/* ── G6 · 冲突门（DEFER 来源） ───────────────────────────────────── */

const NEGATION = /\b(?:not|never|no|don't|do not)\b|不要|不能|别|禁止|永不/iu

function negates(text) {
  return NEGATION.test(String(text ?? ''))
}

/** 与既有条目矛盾？「谁对」是人的判断，所以是 DEFER。 */
export function gateConflict(candidate, { corpus = [] } = {}) {
  for (const existing of corpus) {
    if (existing.id === candidate.id) continue
    if (existing.status !== 'active' && existing.status !== 'advisory') continue

    // 6a：已有 contradicts 边
    const contradicts = (existing.relations ?? []).some(
      (rel) => rel.type === 'contradicts' && rel.target === candidate.id,
    )
    if (contradicts) {
      return refuse('G6', 'conflict', { with: existing.id, axis: 'explicit-edge' })
    }

    // 6b：同 kind + 同 about + 否定翻转
    if (existing.kind === candidate.kind) {
      const aboutSim = jaccard(tokenize(existing.about), tokenize(candidate.about))
      if (aboutSim >= 0.6 && negates(existing.body) !== negates(candidate.body)) {
        return refuse('G6', 'conflict', {
          with: existing.id,
          axis: 'negation-flip',
          aboutSimilarity: Number(aboutSim.toFixed(3)),
        })
      }
    }
  }
  return pass('G6')
}

/* ── G7 · 配额门（棘轮） ────────────────────────────────────────── */

/**
 * 配额是**棘轮**，不是配置：`growth` 达到阈值后一次性切 `ratchet`，此后只降不升。
 *
 * 为什么：一个每次绑定就被手工抬高的预算不是配额。
 * （OwnMem 的字节上限七周被手工抬高六次，然后被删掉了。）
 */
export function gateQuota(candidate, { corpus = [], quotaState = null, config = {} } = {}) {
  const growthThreshold = config?.quota?.growthThreshold ?? 50
  const defaultLimit = config?.quota?.repo ?? 200
  const active = corpus.filter((entry) => !['deprecated', 'rejected', 'superseded'].includes(entry.status))
  const used = active.length

  const state = quotaState ?? { mode: 'growth', growthThreshold, maxActive: null, transitionedAt: null }

  if (state.mode === 'growth' && used < Math.min(growthThreshold, defaultLimit)) return pass('G7')

  const limit = state.mode === 'ratchet' ? (state.maxActive ?? used) : Math.min(growthThreshold, defaultLimit)
  if (used < limit) return pass('G7')

  return refuse('G7', 'quota', {
    used,
    limit,
    mode: state.mode,
    weakest: weakestEntries(active, 5).map((entry) => entry.id),
    hint: '净值零增长：先 memory_forget 退休一条，或把两条合并。协议只列最弱候选，不替你挑。',
  })
}

/** 弱度：只用于排序，不用来做决定。 */
export function weakness(entry, { maxAccess = 1, now = Date.now() } = {}) {
  const confidenceScore = { verified: 1, inferred: 0.7, stale: 0.35, deprecated: 0 }[entry.confidence] ?? 0.7
  const days = entry.lastVerifiedAt ? Math.max(0, (now - Date.parse(entry.lastVerifiedAt)) / 86_400_000) : 365
  const staleness = Math.min(1, days / 365)
  const evidenceStrength =
    (entry.evidence ?? []).reduce(
      (max, item) => Math.max(max, { user: 1, test: 0.9, symbol: 0.8, file: 0.8, commit: 0.7, command: 0.6, doc: 0.5 }[item.kind] ?? 0.4),
      0,
    )
  const usage = Math.min(1, (entry.accessCount ?? 0) / Math.max(1, maxAccess))
  const degree = (entry.relations ?? []).length
  const orphan = degree === 0 ? 1 : 0
  return (
    0.35 * (1 - confidenceScore) +
    0.25 * staleness +
    0.2 * (1 - evidenceStrength) +
    0.1 * (1 - usage) +
    0.1 * orphan
  )
}

export function weakestEntries(entries, limit = 5) {
  const maxAccess = Math.max(1, ...entries.map((entry) => entry.accessCount ?? 0))
  return [...entries]
    .sort((a, b) => weakness(b, { maxAccess }) - weakness(a, { maxAccess }))
    .slice(0, limit)
}

/* ── G8 · 置信门（DEFER 来源） ──────────────────────────────────── */

const SIGNAL_STRENGTH = { S1: 1, S2: 1, S3: 0.6, S4: 0.6, S5: 0.6, S6: 0.6, S7: 0.7 }
const PROVENANCE_WEIGHT = { 'user-asserted': 1, measured: 0.9, 'file-derived': 0.8, 'self-concluded': 0.5 }
const EVIDENCE_WEIGHT = { user: 1, test: 0.9, symbol: 0.8, file: 0.8, commit: 0.7, command: 0.6, doc: 0.5 }

/** 综合置信：五项加权和，全部可解释。 */
export function computeConfidence(candidate, { corpus = [] } = {}) {
  const signal = SIGNAL_STRENGTH[candidate.origin?.signal] ?? 0.6
  const evidence =
    (candidate.evidence ?? []).reduce((max, item) => Math.max(max, EVIDENCE_WEIGHT[item.kind] ?? 0.3), 0) || 0
  const provenance = PROVENANCE_WEIGHT[candidate.provenance] ?? 0.5
  const candidateTokens = new Set(tokenize(`${candidate.about} ${candidate.title}`))
  const coverage =
    corpus.length === 0
      ? 0.5
      : Math.min(
          1,
          corpus.reduce((sum, entry) => sum + jaccard(candidateTokens, new Set(tokenize(entry.about))), 0) /
            Math.max(1, Math.min(corpus.length, 10)),
        )
  const scopeClarity = Array.isArray(candidate.scope) && candidate.scope.length > 0 ? 1 : 0.3

  const confidence =
    0.3 * signal + 0.25 * evidence + 0.2 * provenance + 0.15 * coverage + 0.1 * scopeClarity
  return Number(Math.min(1, Math.max(0, confidence)).toFixed(3))
}

/** 置信过线了吗？不过线就是 DEFER —— 「值不值得记」是人的判断。 */
export function gateConfidence(candidate, { corpus = [], thresholds = {} } = {}) {
  const confidence = candidate.confidence ?? computeConfidence(candidate, { corpus })
  const autoAcceptFloor = thresholds.autoAcceptFloor ?? 0.6
  const deferFloor = thresholds.deferFloor ?? 0.35

  if (confidence >= autoAcceptFloor) return { ...pass('G8'), confidence }
  if (confidence >= deferFloor) {
    return {
      ...refuse('G8', 'confidence', {
        confidence,
        autoAcceptFloor,
        hint: '置信不足：这条值得记，但协议不敢替你决定。已提交待决队列。',
      }),
      confidence,
    }
  }
  return { ...refuse('G8', 'confidence.low', { confidence, deferFloor }), confidence, discard: true }
}

/* ── 编排 ─────────────────────────────────────────────────────────── */

/**
 * 跑完整协议。返回 `{ decision, code, gate, detail, gates, confidence, candidate }`。
 *
 * 门是串行的，但**每道门都会跑完并留下意见**（用于提案展示与审计）。
 * 第一道硬拒短路；DEFER 不短路（收集全部 DEFER 理由）。
 */
export function review(candidate, context = {}) {
  const {
    root = process.cwd(),
    config = {},
    corpus = [],
    owners = [],
    quotaState = null,
    queryTexts = [],
  } = context

  const thresholds = config.thresholds ?? {}
  const template = config.template
  const forbidden = config.safety?.forbidden ?? DEFAULT_FORBIDDEN

  const gates = []
  const collect = (verdict) => {
    gates.push(verdict)
    return verdict
  }

  // 硬门（顺序会变结论：G1 必须先判「有主」，再判「重复」）
  const g1 = collect(gateOwnership(candidate, { owners }))
  if (g1.kind === 'refuse') return finish(g1)

  const g2 = collect(gateShape(candidate, { template }))
  if (g2.kind === 'refuse') return finish(g2)

  const g3 = collect(gateSafety(candidate, { forbidden }))
  if (g3.kind === 'refuse') return finish(g3)

  const g3b = collect(gateInjection(candidate, queryTexts))
  if (g3b.kind === 'refuse') return finish(g3b)

  const g4 = collect(gateEvidence(candidate, { root }))
  if (g4.kind === 'refuse') return finish(g4)

  const g5 = collect(gateDuplicate(candidate, { corpus, threshold: thresholds.duplicate ?? 0.82 }))
  if (g5.kind === 'refuse') return finish(g5)

  const g7 = collect(gateQuota(candidate, { corpus, quotaState, config }))
  if (g7.kind === 'refuse') return finish(g7)

  // soft 门（不短路）
  const g6 = collect(gateConflict(candidate, { corpus }))
  const g8 = collect(gateConfidence(candidate, { corpus, thresholds }))

  const decision = decide(gates)
  return {
    ...decision,
    confidence: g8.confidence,
    discard: g8.discard === true,
    resolvedEvidence: g4.resolvedEvidence,
    actionRisk: actionRiskOf(candidate),
  }

  function finish(verdict) {
    return {
      ...decide(gates),
      confidence: undefined,
      resolvedEvidence: undefined,
      actionRisk: actionRiskOf(candidate),
      verdict,
    }
  }
}

/* ── 拒绝措辞（next） ───────────────────────────────────────────── */

const NEXT_HINTS = {
  'owned-elsewhere': (detail) => `这条断言已由 ${detail?.owner?.ref ?? '现有文档'} 拥有。不要重复记录；要改就改那份文档。`,
  shape: (detail) => `形态不合格：${(detail?.errors ?? []).join('；')}。补齐后重写。`,
  'shape.template': (detail) => `正文缺少：${(detail?.missing ?? []).join(' / ')}。补齐六要素后重写 —— 这不是重试无用。`,
  'shape.multi-topic': () => '一条记忆只讲一件事。拆开，或合并成一条。',
  secret: () => '凭据不入库。删掉密文后重写；这条不会进入待决队列。',
  injection: (detail) => detail?.hint ?? '记忆不能指挥宿主。改写成对事实的陈述。',
  evidence: (detail) => `证据不足：${detail?.hint ?? '补一条可解析的锚点。'}`,
  duplicate: (detail) => detail?.hint ?? `与 ${detail?.existing} 重复，用 supersedes 覆盖。`,
  quota: (detail) => detail?.hint ?? '配额已满，先退休一条。',
}

/** 给模型的下一步。拒绝而不给下一步，模型会重试同一件事。 */
export function nextHint(code, detail) {
  return NEXT_HINTS[code]?.(detail) ?? '按协议拒绝。修好后重写，不要原样重试。'
}

export { levenshtein, collapse, ID_PATTERN }
