/**
 * 记忆审核协议（MRP v1）—— 十道门。
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
import { join, resolve } from 'node:path'

import { anchorHash, lineCountOf, parseFileRef, symbolBodyHash } from './anchor.js'
import { PLACEHOLDER, placeholderSections } from './capture.js'
import { cosine } from './embedding.js'
import { actionRiskOf, validateEntry } from './model.js'
import { jaccard, ngrams, toRepoPath, tokenize, truncate } from './util.js'

/** 硬门：refuse 即 REJECT。G6/G8 不在里面 —— 它们是 DEFER 的来源。 */
export const HARD_GATES = new Set(['G1', 'G2', 'G3', 'G3b', 'G4', 'G5', 'G7'])

/**
 * 注入模式：**动词必须紧邻它寻址的那一层**。
 *
 * 上一版中文分支是 `(?:忽略|无视|绕过|覆盖).{0,6}?(?:系统|开发者|用户).{0,4}?(?:指令|提示词|消息)`，
 * 三段距离都松。于是「配置合并时会**覆盖用户**配置的**提示词**」这种描述配置
 * 合并语义的正常句子被判成「指挥宿主」，硬拒（G3b 是硬门，不可 DEFER）。
 * 「覆盖 + 用户 + 指令/提示词」是配置类记忆的高频三连词 —— 这一版把它收成
 * 「动词 + 被寻址层 + 可选的『的』 + 产物」，中间不再允许任何词。
 */
export const INJECTION_OVERRIDE =
  /\b(?:ignore|override|bypass|disregard)\b\s+(?:all\s+|the\s+|any\s+)?\b(?:system|developer|user)\b[\s-]{0,3}(?:instructions?|prompts?|messages?)\b|(?:忽略|无视|绕过|覆盖)\s*(?:掉|了)?\s*(?:系统|开发者|用户)\s*(?:的)?\s*(?:指令|提示词|消息)/iu

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

/**
 * 编译一条密钥规则。**支持开头的内联标志 `(?i)`**，因为规则表是从 Python
 * 实现的 OwnMem 抄过来的（Python 用 `(?i)` 内联，JS 用 `i` 标志）。
 *
 * 为什么必须显式处理：`new RegExp('(?i)...')` 在 JS 里是 **SyntaxError**，
 * 而调用方一律 `try { } catch { continue }` —— 于是这些规则**从来没生效过**。
 *
 * 一条永远不匹配的密钥规则比没有规则更糟：**它让「我们扫过密钥」这句话变成谎话。**
 * 而 G3 是整个协议里唯一不可协商的门。
 *
 * 导出给 `promote.js` 用 —— 两处必须用**同一个**编译器，否则又是一次漂移。
 */
export function compileRule(pattern) {
  const inline = /^\(\?([ims]+)\)/.exec(pattern)
  const source = inline ? pattern.slice(inline[0].length) : pattern
  return new RegExp(source, `${inline?.[1] ?? ''}u`)
}

/** 规则表里每一条都必须能编译 —— 装错一条就是静默失效一条。 */
export function assertRulesCompile(rules = DEFAULT_FORBIDDEN) {
  for (const [index, pattern] of rules.entries()) compileRule(pattern)
  return rules.length
}

/* ── 裁决构造 ─────────────────────────────────────────────────────── */

const pass = (gate, note) => ({ gate, kind: 'pass', ...(note ? { note } : {}) })
const downgrade = (gate, code, detail, note) => ({ gate, kind: 'downgrade', code, detail, ...(note ? { note } : {}) })
const refuse = (gate, code, detail) => ({ gate, kind: 'refuse', code, detail })

/**
 * 合成十道门的意见。`next` 由调用方按 code 生成（协议只管裁决，不管措辞）。
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
 *
 * 缓存：这条路径跑在 `turn-stopping` 上（宿主 await），而它要读 6 份文档
 * 并把每份全文过一遍 `semantic()` 正则。实测 2.5 ms —— 对「读几个没变过的文件」
 * 来说太贵了。用同样的**两段式戳**（目录 mtime 便宜戳 + 2 秒一次全量核对）。
 */
const ownerCache = new Map()
const OWNER_FULL_CHECK_INTERVAL_MS = 2_000

function ownerCheapStamp(root) {
  try {
    const parts = [statSync(root).mtimeMs]
    for (const name of OWNER_FILES) {
      try {
        parts.push(statSync(join(root, name)).mtimeMs)
      } catch {
        parts.push(0)
      }
    }
    const docsDir = join(root, 'docs')
    try {
      parts.push(statSync(docsDir).mtimeMs)
    } catch {
      parts.push(0)
    }
    return parts.join(':')
  } catch {
    return 'missing'
  }
}

function ownerFullStamp(root) {
  const parts = []
  for (const name of [...OWNER_FILES, ...OWNER_DIRS]) {
    const absolute = join(root, name)
    try {
      const stat = statSync(absolute)
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`)
      if (stat.isDirectory()) {
        for (const child of readdirSync(absolute).slice(0, 50)) {
          try {
            const childStat = statSync(join(absolute, child))
            parts.push(`${name}/${child}:${childStat.mtimeMs}:${childStat.size}`)
          } catch {
            /* 文件在扫描中被删了 */
          }
        }
      }
    } catch {
      parts.push(`${name}:missing`)
    }
  }
  return parts.join('|')
}

/** 丢弃某个 root 的 owner 缓存（测试与写后调用）。 */
export function invalidateOwners(root) {
  ownerCache.delete(root)
}

export function collectOwners(root) {
  const cached = ownerCache.get(root)
  const now = Date.now()
  if (cached && now - cached.checkedAt < OWNER_FULL_CHECK_INTERVAL_MS) return cached.owners

  const cheap = ownerCheapStamp(root)
  if (cached && cached.cheap === cheap) {
    cached.checkedAt = now
    return cached.owners
  }
  const full = ownerFullStamp(root)
  if (cached && cached.full === full) {
    cached.cheap = cheap
    cached.checkedAt = now
    return cached.owners
  }

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

  const frozen = Object.freeze(owners)
  ownerCache.set(root, { cheap, full, owners: frozen, checkedAt: now })
  return frozen
}

/* ── G1 · 归属门 ──────────────────────────────────────────────────── */

/**
 * 这条断言是不是已经由规则文件 / 权威文档拥有？
 *
 * 判据是**完全包含**：候选的 title 或 about（去标点后 ≥8 字）出现在
 * 某个 owner 文档里。保守实现，宁可漏拒 —— 误判方向必须偏向 ACCEPT。
 */
export function gateOwnership(candidate, { owners = [], vectors = null, semanticThreshold = null } = {}) {
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

  /**
   * 语义兜底：**只有调用方预先算好向量、且显式给了阈值时才跑**。
   *
   * 为什么不是默认开：`bench/embedding-experiment.mjs` 在本仓库语料上实测
   * 「改写组最低分」只比「无关组最高分」高 **0.004** —— 那不是分离，是噪音。
   * 拿它开闸就是拿误伤换漏报，而且用户会以为自己买到了召回。
   *
   * 开闸标准写在 `lib/embedding.js` 的文件头：跑自己的语料，看 margin。
   * 门这里只负责「阈值给了就用」，不负责替用户判断该不该开。
   */
  if (vectors && typeof semanticThreshold === 'number' && candidate.vector) {
    let best = { score: 0, ref: null }
    for (const item of vectors) {
      if (!item?.vector) continue
      const score = cosine(candidate.vector, item.vector)
      if (score > best.score) best = { score, ref: item.ref }
    }
    if (best.score >= semanticThreshold) {
      return refuse('G1', 'semantic-owned-elsewhere', {
        owner: { kind: 'doc', ref: best.ref },
        why: '语义上这份文档已经拥有这个断言（不是逐字，是改写）',
        matched: Number(best.score.toFixed(3)),
        threshold: semanticThreshold,
      })
    }
  }

  return pass('G1')
}

/* ── G2 · 形态门 ──────────────────────────────────────────────────── */

const TEMPLATE_HEADINGS = ['功能名', '生效条件', '子功能', '执行', '验证方式', '不适用条件']

/**
 * 一条记忆只讲一件事？必需要素齐？
 *
 * **标题必须在「剥掉代码块之后」的正文上数。** 上一版直接跑在原始 body 上，
 * 于是一段 shell 注释（`# 启动依赖，不是标题`）被计成 Markdown 标题：
 * 一条六要素齐全的 capability 记忆标题数变成 7 > 6，被 `shape.multi-topic`
 * 硬拒 —— 理由完全错（「一条记忆只讲一件事」），而模型没有任何重试路径能过，
 * 因为它改不掉「这只是注释」这件事。
 *
 * `stripCodeBlocks` 就在本文件下面（G5 用它），这里复用同一份实现。
 */
export function gateShape(candidate, { template = TEMPLATE_HEADINGS } = {}) {
  const { ok, errors } = validateEntry(candidate)
  if (!ok) return refuse('G2', 'shape', { errors })

  const prose = stripCodeBlocks(candidate.body)
  const headings = [...prose.matchAll(/^#{1,3}\s*(.+?)\s*$/gm)].map((match) => match[1])
  const missing = template.filter((heading) => !headings.some((found) => found.includes(heading)))
  if (missing.length > 0) {
    return refuse('G2', 'shape.template', {
      missing,
      hint: `正文必须含六要素标题：${template.join(' / ')}。缺「不适用条件」的记忆会污染所有它看起来相关的判断。`,
    })
  }
  // 模板本身就是 6 个标题，所以「多主题」的门槛是 7：多出来的那个才是第二件事。
  if (headings.length > template.length) {
    return refuse('G2', 'shape.multi-topic', {
      headings,
      hint: '一条记忆只讲一件事；拆成多条，或合并成一条。',
    })
  }
  return pass('G2')
}

/* ── G2b · 草稿门（DEFER 来源） ─────────────────────────────────── */

/**
 * 正文里还有没填的六要素吗？
 *
 * **这是软门，不是硬门**：草稿值得记，只是还写不好。
 *
 * 为什么必须有这道门：自动捕获只产出草稿 —— 它从这一轮的真实内容里能填的
 * 就填（用户那句话 → 生效条件，助手最后那段话 → 执行，编辑过的文件 → 子功能，
 * 跑过的命令 → 验证方式），填不了的**必须留占位符**。
 *
 * 没有这道门时，一条 `# 执行\n（待补：怎么做）` 的草稿会通过 G2（标题都在）、
 * 通过 G8（锚点确实出现在正文里），然后**被当成一条真记忆写进去**。
 * 那是这个系统能犯的最严重的错：它把「我不知道」写成了一句看起来像事实的话。
 */
export function gateDraft(candidate) {
  const body = String(candidate.body ?? '')
  if (!body.includes(PLACEHOLDER)) return pass('G2b')
  const sections = placeholderSections(body)
  return refuse('G2b', 'shape.draft', {
    sections,
    hint: `正文还有 ${sections.length} 处没填：${sections.join('、')}。自动捕获只产出草稿 —— 补实后再写。`,
  })
}

/* ── G3 · 安全门 ──────────────────────────────────────────────────── */

/**
 * 含密钥 / 令牌 / PII？命中即硬拒，且**不回显命中片段**。
 *
 * haystack **必须包含 `evidence[].excerpt`**。上一版只拼 `title + about + body`，
 * 于是同一串 `sk-…` 放进正文会被拒、放进摘录字段就通过 —— 而 `excerpt` 是
 * `memory_remember` 工具 schema 里**公开可填**的字段。G3 是协议里唯一
 * 不可协商的门，漏一个字段就等于「我们扫过密钥」这句话是谎话。
 *
 * `ref` 不扫：它可能含合法路径（`src/a.ts:17`），误伤方向必须偏向 ACCEPT。
 */
export function gateSafety(candidate, { forbidden = DEFAULT_FORBIDDEN } = {}) {
  const excerpts = (Array.isArray(candidate.evidence) ? candidate.evidence : [])
    .map((item) => (item && typeof item.excerpt === 'string' ? item.excerpt : ''))
    .join('\n')
  const haystack = `${candidate.title ?? ''}\n${candidate.about ?? ''}\n${candidate.body ?? ''}\n${excerpts}`
  for (const [index, pattern] of forbidden.entries()) {
    let regex
    try {
      regex = compileRule(pattern)
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

/** 读一个仓库内文件。越界 / 读不了都返回 null —— 调用方决定报什么。 */
function readRepoFile(root, ref) {
  const parsed = parseFileRef(ref)
  if (!parsed) return null
  const absolute = resolve(root, parsed.path)
  if (toRepoPath(root, absolute) === null) return { unsafe: true, parsed, absolute }
  try {
    return { unsafe: false, parsed, absolute, text: readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '') }
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
 * **哈希算法只有一份**：`lib/anchor.js` 的 `anchorHash`（文件切片）与
 * `symbolBodyHash`（符号体）。上一版这里哈希整个文件、drift 那边哈希行切片，
 * 于是只要 ref 带行号，两侧哈希就永远对不上 —— 干净工作树上 100% 报假 advisory。
 *
 * `symbol` 锚点在这里**真的去算哈希**（上一版一律不带 hash，于是 drift 的
 * 「符号体变了 → advisory」那条分支对真实记忆不可达）。名字落不到定义上时
 * 降级为 `symbol-not-a-definition` —— 那正是这个判决存在的理由。
 */
export function gateEvidence(candidate, { root } = {}) {
  const evidence = candidate.evidence ?? []
  if (evidence.length === 0) return refuse('G4', 'evidence.none', { hint: '至少给一条可解析的锚点。' })

  const resolved = []
  let fileAnchors = 0
  let downgradeVerdict = null

  for (const item of evidence) {
    const ref = String(item.ref ?? '').trim()
    if (!ref) return refuse('G4', 'evidence.invalid', { detail: '空的 ref' })

    if (item.kind === 'file' || item.kind === 'doc') {
      const read = readRepoFile(root, ref)
      if (!read) return refuse('G4', 'evidence.unresolved', { ref, hint: `路径不存在：${parseFileRef(ref)?.path ?? ref}` })
      if (read.unsafe) {
        return refuse('G4', 'evidence.unsafe-path', { ref, hint: '锚点路径不能逃出仓库。' })
      }
      fileAnchors += 1
      const lineCount = lineCountOf(read.text)
      if (read.parsed.from !== null && read.parsed.from > lineCount) {
        return refuse('G4', 'evidence.unresolved', { ref, hint: `文件只有 ${lineCount} 行` })
      }
      const actual = anchorHash(read.text, ref)
      if (item.hash && actual && item.hash !== actual) {
        return downgrade('G4', 'evidence.drifted', {
          ref,
          hint: '锚点的内容变了（通常是重构）。重新核对后重写这条记忆。',
        })
      }
      resolved.push({ ...item, ref, hash: item.hash ?? actual ?? undefined })
      continue
    }

    if (item.kind === 'symbol') {
      // `path#Name`：`#` 之后是符号名。没有 `#` 的当整串是名字（在全仓找不到定义）
      const hashAt = ref.lastIndexOf('#')
      const path = hashAt > 0 ? ref.slice(0, hashAt) : ref
      const name = hashAt > 0 ? ref.slice(hashAt + 1) : ref
      const read = readRepoFile(root, path)
      if (!read || read.unsafe) {
        return refuse('G4', 'evidence.unresolved', { ref, hint: `路径不存在：${path}` })
      }
      const found = symbolBodyHash(read.text, name)
      if (!found) {
        // 名字没有定义形态：可能只在注释 / 调用点出现。**不重新签名**，
        // 也不假装健康 —— 报出来，让人决定。
        downgradeVerdict ??= downgrade('G4', 'symbol-not-a-definition', {
          ref,
          hint: `「${name}」在 ${path} 里找不到定义形态（可能只出现在注释或调用点）。`,
        })
        resolved.push({ ...item, ref })
        continue
      }
      fileAnchors += 1
      resolved.push({ ...item, ref, hash: item.hash ?? found.hash, symbol: name })
      continue
    }

    if (item.kind === 'commit') {
      if (!/^[0-9a-f]{7,64}$/i.test(ref)) {
        return refuse('G4', 'evidence.invalid', { ref, hint: '提交锚点必须是 7-64 位十六进制' })
      }
      resolved.push({ ...item, ref })
      continue
    }

    // test / command / user：写入时无法廉价验证（drift 那边有 test 的实现）
    resolved.push({ ...item, ref })
  }

  if (fileAnchors === 0) {
    return refuse('G4', 'evidence.unresolved', {
      hint: '至少要有一条可解析的文件/文档锚点；符号、测试或命令无法独立验证。',
    })
  }

  return { ...pass('G4'), ...(downgradeVerdict ?? {}), resolvedEvidence: resolved }
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

/**
 * 近重复指纹缓存：`corpus 数组 -> Map<entryId, Set>`。
 *
 * 为什么挂在数组上：`readAll` 现在返回**冻结的**同一个数组（带扫描缓存），
 * 所以数组身份就是最天然的失效信号 —— 语料一变，数组一换，缓存自然回收。
 * 没有它，每一次写入都要对全库重新分词 + 重算 3-gram。
 */
const fingerprintCache = new WeakMap()

function corpusFingerprints(corpus) {
  let fingerprints = fingerprintCache.get(corpus)
  if (fingerprints) return fingerprints
  fingerprints = new Map()
  for (const entry of corpus) {
    if (entry.status !== 'active' && entry.status !== 'advisory') continue
    const features = fingerprintFeatures(`${entry.about ?? ''}\n${entry.body ?? ''}`)
    if (features.size >= 16) fingerprints.set(entry.id, features)
  }
  fingerprintCache.set(corpus, fingerprints)
  return fingerprints
}

/** 近重复：**双阈值合取**。只用一个会在短条目上误报。 */
export function gateDuplicate(candidate, { corpus = [], threshold = 0.82 } = {}) {
  if ((candidate.body ?? '').length < 1) return pass('G5')
  const features = fingerprintFeatures(`${candidate.about ?? ''}\n${candidate.body ?? ''}`)
  if (features.size < 16) return pass('G5') // 特征太少，任何相似度都不稳定

  const lexical = new Set([...features].filter((feature) => feature.startsWith('t:')))
  const fingerprints = corpusFingerprints(corpus)

  for (const [id, other] of fingerprints) {
    // **`continue` 而不是 `return pass`。** 幂等重写只该豁免「这一对」，
    // 不该豁免整道门。上一版用 `return`，于是只要你更新的是自己
    // （同 id、相似 > 0.95 —— 正常更新必然成立），后面所有其他条目
    // 一个都不再比：把一条记忆更新成**另一条记忆的副本**就能悄悄过 G5。
    if (id === candidate.id && jaccard(features, other) > 0.95) continue
    const simhash = jaccard(features, other)
    if (simhash < threshold) continue
    const minhash = jaccard(lexical, new Set([...other].filter((feature) => feature.startsWith('t:'))))
    if (minhash < 0.72) continue
    return refuse('G5', 'duplicate', {
      existing: id,
      similarity: Number(simhash.toFixed(3)),
      hint: `已存在 ${id}。用 memory_remember 传 supersedes 覆盖，或改用 memory_resolve 编辑。`,
    })
  }
  return pass('G5')
}

/* ── G6 · 冲突门（DEFER 来源） ───────────────────────────────────── */

/**
 * 否定词。
 *
 * 中文分支**不用裸 `别`** —— 它会匹配「区别」「特别」「别人」，
 * 而 G6 的判据是「否定翻转」，一个假阳性会把两条本来一致的记忆报成矛盾。
 * 只认明确接动作的形态。
 */
const NEGATION =
  /\b(?:not|never|no|don't|do not|cannot|can't)\b|不要|不能|不会|别(?:再|用|把|做|改)|禁止|永不|切勿|避免/iu

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

/**
 * 锚点覆盖率：正文到底提没提到它引用的东西？
 *
 * **这是一个关于候选自身的信号，与语料规模无关。**
 *
 * 上一版把 coverage 算成「与既有语料的相似度平均」，于是：
 * 语料为空时回退 0.5、非空时按相似度打分 —— 结果是**第二条同类型记忆
 * 比第一条更难落盘**。那等于惩罚「积累」，而积累是这个系统唯一的目的。
 *
 * 更糟的是它不单调：同一个候选在不同大小的语料上得到不同裁决，
 * 而「同样的候选 + 同样的仓库 → 同样的裁决」是协议敢自动跑的前提。
 */
function anchorCoverage(candidate) {
  const refs = (candidate.evidence ?? []).map((item) => String(item.ref ?? '')).filter(Boolean)
  if (refs.length === 0) return 0
  const bodyTokens = new Set(
    tokenize(`${candidate.body ?? ''}\n${candidate.about ?? ''}\n${candidate.title ?? ''}`),
  )
  let hit = 0
  for (const ref of refs) {
    const tokens = tokenize(ref).filter((token) => token.length >= 2)
    if (tokens.length === 0) continue
    if (tokens.some((token) => bodyTokens.has(token))) hit += 1
  }
  return hit / refs.length
}

/** 综合置信：五项加权和，全部可解释、全部与语料规模无关。 */
export function computeConfidence(candidate) {
  const signal = SIGNAL_STRENGTH[candidate.origin?.signal] ?? 0.6
  const evidence =
    (candidate.evidence ?? []).reduce((max, item) => Math.max(max, EVIDENCE_WEIGHT[item.kind] ?? 0.3), 0) || 0
  const provenance = PROVENANCE_WEIGHT[candidate.provenance] ?? 0.5
  const anchored = anchorCoverage(candidate)
  const scopeClarity = Array.isArray(candidate.scope) && candidate.scope.length > 0 ? 1 : 0.3

  // 权重按「一条形态完备但来源不明的记忆刚好过 0.6 地板」反解：
  //   0.30·0.7 + 0.25·0.8 + 0.15·0.5 + 0.20·1 + 0.10·1 = 0.785
  // 而正文没提到锚点时掉到 0.585，正好低于地板 —— 引用了却不去看，是它唯一的错。
  const confidence = 0.3 * signal + 0.25 * evidence + 0.15 * provenance + 0.2 * anchored + 0.1 * scopeClarity
  return Number(Math.min(1, Math.max(0, confidence)).toFixed(3))
}

/**
 * 置信过线了吗？不过线就是 DEFER —— 「值不值得记」是人的判断。
 *
 * **`confidence` 这个字段名被两个东西共用**，必须分清：
 *
 *   条目上的 `confidence` 是**标签**（`verified` / `inferred` / `stale` / `deprecated`），
 *   进 frontmatter、给人读、给 G5 用。
 *
 *   门要的是**分数**（0–1），由 `computeConfidence` 从五项算出来。
 *
 * 上一版直接 `candidate.confidence ?? computeConfidence(...)` —— 只要调用方
 * 带了标签（schema 完全允许），比较就变成 `'verified' >= 0.6`，恒为 false，
 * 于是**每一条这样进来的候选都掉进 `confidence.low` 分支被丢弃**：
 * 不建提案、不落盘、只剩一行 `discard: true` 没人看。
 *
 * 静默丢弃一条本该记住的记忆，是这个系统最坏的失败方式。
 */
export function gateConfidence(candidate, { thresholds = {} } = {}) {
  const provided = typeof candidate.confidence === 'number' ? candidate.confidence : null
  const confidence = provided ?? computeConfidence(candidate)
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
    // 语义兜底：**调用方预先算好的向量**。没给就只走逐字包含。
    ownerVectors = null,
    semanticThreshold = null,
  } = context

  const thresholds = config.thresholds ?? {}
  const template = config.template
  /**
   * 用户规则**只增不减**：与 `DEFAULT_FORBIDDEN` 合并，不是替换。
   *
   * 替换语义的后果是一个空数组就能把整道密钥扫描关掉 —— 而 G3 是协议里
   * 唯一不可协商的门。多扫几条规则的代价是误伤，少扫一条的代价是密钥入库。
   */
  const extraForbidden = Array.isArray(config.safety?.forbidden) ? config.safety.forbidden : []
  const forbidden = [...DEFAULT_FORBIDDEN, ...extraForbidden]

  const gates = []
  const collect = (verdict) => {
    gates.push(verdict)
    return verdict
  }

  // 硬门（顺序会变结论：G1 必须先判「有主」，再判「重复」）
  const g1 = collect(gateOwnership(candidate, { owners, vectors: ownerVectors, semanticThreshold }))
  if (g1.kind === 'refuse') return finish(g1)

  const g2 = collect(gateShape(candidate, { template }))
  if (g2.kind === 'refuse') return finish(g2)

  // 草稿门是**软**的：不短路，让 G3–G8 继续跑完，提案里带上完整意见
  const g2b = collect(gateDraft(candidate))

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
  const g8 = collect(gateConfidence(candidate, { thresholds }))

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

/**
 * 拒绝码 → 下一步。
 *
 * **key 必须与 `refuse` / `downgrade` 实际产出的 code 一字不差。** 上一版只列了
 * `evidence`（而 G4 产出的是 `evidence.none` / `evidence.invalid` /
 * `evidence.unresolved` / `evidence.drifted`），于是 G4 这个最高频的拒绝门
 * 全部落到兜底文案「按协议拒绝」—— 而 `detail.hint` 里明明写着具体原因
 * （「路径不存在：src/a.js」「文件只有 54 行」），被原样丢掉了。
 *
 * `docs/03:578` 的纪律：拒绝而不给下一步，模型会重试同一件事。
 */
const NEXT_HINTS = {
  'owned-elsewhere': (detail) => `这条断言已由 ${detail?.owner?.ref ?? '现有文档'} 拥有。不要重复记录；要改就改那份文档。`,
  'semantic-owned-elsewhere': (detail) =>
    `这条断言与 ${detail?.owner?.ref ?? '现有文档'} 高度相似（语义兜底）。不要重复记录；要改就改那份文档。`,
  shape: (detail) => `形态不合格：${(detail?.errors ?? []).join('；')}。补齐后重写。`,
  'shape.template': (detail) => `正文缺少：${(detail?.missing ?? []).join(' / ')}。补齐六要素后重写 —— 这不是重试无用。`,
  'shape.multi-topic': () => '一条记忆只讲一件事。拆开，或合并成一条。',
  'shape.draft': (detail) => `草稿还有 ${(detail?.sections ?? []).length} 处没填。补实后再写。`,
  secret: () => '凭据不入库。删掉密文后重写；这条不会进入待决队列。',
  injection: (detail) => detail?.hint ?? '记忆不能指挥宿主。改写成对事实的陈述。',
  'evidence.none': () => '没有证据的断言就是猜测。补一条可解析的锚点（`path:line` / `Symbol.name` / 测试名 / sha / 命令）。',
  'evidence.invalid': (detail) => `锚点格式不对：${detail?.hint ?? detail?.detail ?? '检查 ref 的写法。'}`,
  'evidence.unresolved': (detail) => `锚点解析不到：${detail?.hint ?? '目标不存在。'}`,
  'evidence.unsafe-path': () => '锚点路径不能逃出仓库。改成 repo-relative 路径。',
  'evidence.drifted': (detail) => detail?.hint ?? '锚点内容变了（通常是重构）。重新核对后重写。',
  duplicate: (detail) => detail?.hint ?? `与 ${detail?.existing} 重复，用 supersedes 覆盖。`,
  quota: (detail) => detail?.hint ?? '配额已满，先退休一条。',
  confidence: (detail) => detail?.hint ?? '置信不足。补强证据后重写。',
  'confidence.low': (detail) =>
    `置信 ${Number(detail?.confidence ?? 0).toFixed(3)} 低于丢弃地板。补强证据后重写，否则不要记。`,
  conflict: (detail) => `与 ${detail?.with ?? '既有记忆'} 冲突。先解决矛盾（用 supersedes 或改写其中一条）。`,
}

/** 给模型的下一步。拒绝而不给下一步，模型会重试同一件事。 */
export function nextHint(code, detail) {
  return NEXT_HINTS[code]?.(detail) ?? '按协议拒绝。修好后重写，不要原样重试。'
}
