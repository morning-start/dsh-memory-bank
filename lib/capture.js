/**
 * 捕获：从一轮对话的 durable 事件里提取**候选**。
 *
 * 这是「知道自己什么时候该记」的落点。设计成**确定性信号 + 显式工具**双通道，
 * **不默认调模型** —— 零网络、零延迟、可复现。
 *
 * 五种「值得记」的形态：
 *   decision   决策（选 A 不选 B，且给了理由）
 *   pitfall    坑（同一失败 ≥2 次，修复可锚定）
 *   convention 约定（规则文件被改，或用户说「以后都」）
 *   correction 纠错（用户否定 + 做法改了）
 *   capability 能力（某入口存在且怎么跑）
 *
 * 其余一切（任务状态、临时结果、代码里已有的东西、由测试/规则拥有的东西）
 * 都不是记忆 —— 交给 G1 归属门拒掉。
 */

import { normalizeId } from './model.js'
import { collapse, isoNow, truncate } from './util.js'

/** 捕获信号：确定性、无模型调用。 */
export const SIGNALS = Object.freeze({
  S1: { id: 'S1', name: '显式指令', strength: 1, kind: 'convention' },
  S2: { id: 'S2', name: '纠错', strength: 1, kind: 'correction' },
  S3: { id: 'S3', name: '决策', strength: 0.6, kind: 'decision' },
  S4: { id: 'S4', name: '踩坑', strength: 0.6, kind: 'pitfall' },
  S5: { id: 'S5', name: '约定变更', strength: 0.6, kind: 'convention' },
  S6: { id: 'S6', name: '复发', strength: 0.6, kind: 'pitfall' },
  S7: { id: 'S7', name: '显式工具', strength: 0.7, kind: 'fact' },
})

const EXPLICIT =
  /(?:记住|记一下|记下来|以后都|以后不要|下次|改成|别再|不要再|牢记|remember|from now on|never again)/iu
const CORRECTION = /^(?:不对|不是|错了|别|停止|不要|其实|应该是|no,|nope|actually|wrong)/iu
const DECISION = /(?:决定|选|改成|不用|改用|而不是|因为.*所以|decided|chose|instead of|rather than)/iu
const CAPABILITY = /(?:怎么跑|如何运行|入口是|命令是|脚本是|how to run|the command is)/iu
const RULE_FILES = /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|README\.md)$/iu

/* ── 事件折叠 ─────────────────────────────────────────────────────── */

/**
 * 把一轮的 durable 事件折叠成「这一轮发生了什么」。
 * 只用宿主已经写进 session log 的事实，**不重扫 session.events**。
 */
export function foldTurn(events, { turn } = {}) {
  const facts = {
    turn: turn ?? null,
    userTexts: [],
    assistantTexts: [],
    toolCalls: [],
    toolResults: [],
    editedFiles: [],
    failedCommands: [],
    succeededCommands: [],
  }

  for (const event of events ?? []) {
    const type = event?.type ?? event?.event?.type
    const data = event?.data ?? event?.event?.data ?? {}
    switch (type) {
      case 'user/message': {
        const text = extractText(data)
        if (text) facts.userTexts.push(text)
        break
      }
      case 'assistant/message': {
        const text = extractText(data)
        if (text) facts.assistantTexts.push(text)
        break
      }
      case 'tool/call': {
        facts.toolCalls.push({ name: data.name, arguments: data.arguments })
        break
      }
      case 'tool/result': {
        const isError = data.isError === true || data.is_error === true
        const text = extractText(data)
        facts.toolResults.push({ name: data.name, isError, text })
        if (isError) facts.failedCommands.push({ name: data.name, text })
        else facts.succeededCommands.push({ name: data.name, text })
        break
      }
      case 'working-directory/change':
        break
      default:
        break
    }
  }

  // 编辑过的文件：从 tool/call 的参数里取（Edit/Write 的 file_path）
  for (const call of facts.toolCalls) {
    if (!['Edit', 'Write', 'apply_patch', 'str_replace_editor'].includes(call.name)) continue
    const raw = call.arguments
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      const path = parsed?.file_path ?? parsed?.path ?? parsed?.notebook_path
      if (path && !facts.editedFiles.includes(path)) facts.editedFiles.push(path)
    } catch {
      /* 参数不是 JSON，忽略 */
    }
  }

  return facts
}

function extractText(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return payload
  if (typeof payload.text === 'string') return payload.text
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((block) => (typeof block === 'string' ? block : block?.text ?? ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof payload.message === 'string') return payload.message
  return ''
}

/* ── 信号检测 ─────────────────────────────────────────────────────── */

/**
 * 语料关键词集合：`corpus 数组 -> Set<token>`。
 *
 * S6（复发）要问「这条查询在既有语料里有没有命中」，而朴素写法对**每一条**
 * 既有记忆重新分词 —— 200 条记忆就是 200 次全量 `tokenize`，而这条路径跑在
 * `turn-stopping` 上（宿主 await）。挂在语料数组上（`readAll` 返回冻结数组，
 * 数组身份就是天然的失效信号）。
 */
const corpusTokenCache = new WeakMap()

function corpusTokens(corpus) {
  let tokens = corpusTokenCache.get(corpus)
  if (tokens) return tokens
  tokens = []
  for (const entry of corpus) {
    tokens.push(new Set(`${entry.title} ${entry.about}`.toLowerCase().match(/[\w\u4e00-\u9fff]{2,}/g) ?? []))
  }
  corpusTokenCache.set(corpus, tokens)
  return tokens
}

/** 检测这一轮命中的信号。返回 `[{ id, strength, kind, evidence }]`。 */
export function detectSignals(facts, { corpus = [], enabled = null } = {}) {
  const hits = []
  const userText = facts.userTexts.join('\n')
  const assistantText = facts.assistantTexts.join('\n')

  if (EXPLICIT.test(userText)) {
    hits.push({
      id: 'S1',
      strength: SIGNALS.S1.strength,
      kind: SIGNALS.S1.kind,
      evidence: truncate(collapse(userText), 160),
    })
  }

  if (CORRECTION.test(userText.trim()) && facts.editedFiles.length > 0) {
    hits.push({
      id: 'S2',
      strength: SIGNALS.S2.strength,
      kind: SIGNALS.S2.kind,
      evidence: truncate(collapse(userText), 160),
    })
  }

  if (DECISION.test(userText) || DECISION.test(assistantText)) {
    hits.push({ id: 'S3', strength: SIGNALS.S3.strength, kind: SIGNALS.S3.kind, evidence: '' })
  }

  // S4：同一工具失败 ≥2 次后成功 —— 坑
  const failureCounts = new Map()
  for (const failure of facts.failedCommands) {
    failureCounts.set(failure.name, (failureCounts.get(failure.name) ?? 0) + 1)
  }
  for (const [name, count] of failureCounts) {
    if (count < 2) continue
    const recovered = facts.succeededCommands.some((item) => item.name === name)
    if (!recovered) continue
    hits.push({ id: 'S4', strength: SIGNALS.S4.strength, kind: SIGNALS.S4.kind, evidence: name })
  }

  // S5：规则文件被改
  if (facts.editedFiles.some((file) => RULE_FILES.test(file))) {
    hits.push({ id: 'S5', strength: SIGNALS.S5.strength, kind: SIGNALS.S5.kind, evidence: '' })
  }

  // S6：复发 —— 当前查询在既有语料里已有命中
  if (corpus.length > 0 && userText) {
    const tokens = new Set(userText.toLowerCase().match(/[\w\u4e00-\u9fff]{2,}/g) ?? [])
    if (tokens.size > 0) {
      const recurrence = corpusTokens(corpus).some((entryTokens) => {
        let shared = 0
        for (const token of tokens) {
          if (entryTokens.has(token)) shared += 1
          if (shared >= 2) return true
        }
        return false
      })
      if (recurrence) hits.push({ id: 'S6', strength: SIGNALS.S6.strength, kind: SIGNALS.S6.kind, evidence: '' })
    }
  }

  const allowed = enabled ?? Object.keys(SIGNALS)
  return hits.filter((hit) => allowed.includes(hit.id))
}

/* ── 候选构造 ─────────────────────────────────────────────────────── */

const TEMPLATE_BODY = (parts) =>
  [
    '# 功能名',
    parts.name,
    '',
    '# 生效条件',
    parts.when,
    '',
    '# 子功能',
    parts.components,
    '',
    '# 执行',
    parts.how,
    '',
    '# 验证方式',
    parts.verify,
    '',
    '# 不适用条件',
    parts.unless,
  ].join('\n')

/** 占位符前缀。**「我不确定」必须是一等公民**，不能用一句像模像样的话盖过去。 */
export const PLACEHOLDER = '（待补：'

export const placeholder = (what) => `${PLACEHOLDER}${what}）`

export function hasPlaceholder(body) {
  return String(body ?? '').includes(PLACEHOLDER)
}

export function placeholderSections(body) {
  return [...String(body ?? '').matchAll(/（待补：([^）]*)）/g)].map((match) => match[1])
}

/** 一句「收到，我来看看」不是执行步骤。 */
const ACK_ONLY = /^(?:好的|明白了|收到|了解|ok|okay|sure|got it)[，,。.!！\s]*$/iu

function pick(...candidates) {
  for (const candidate of candidates) {
    const text = collapse(candidate ?? '')
    if (text && !ACK_ONLY.test(text)) return text
  }
  return null
}

/**
 * 由捕获事实构造**草稿**。
 *
 * 每一段都先尝试从这一轮的真实内容里填：
 *   生效条件 ← 用户那句话（他在描述什么时候管用）
 *   执行     ← 助手最后那段话（他实际是怎么做的）
 *   子功能    ← 编辑过的文件
 *   验证方式  ← 跑过的命令
 *
 * **填不了的才留占位符。** 占位符会被 G2b 拦住变成 DEFER ——
 * 自动捕获产出的是**草稿**，它没有资格替人写下「不适用条件」这种判断。
 */
export function buildCandidate(facts, hit, { id, scope = [], now = isoNow() } = {}) {
  const userText = collapse(facts.userTexts.join(' '))
  const assistantText = facts.assistantTexts.length > 0 ? facts.assistantTexts[facts.assistantTexts.length - 1] : ''
  const commands = [...new Set(facts.succeededCommands.map((item) => item.name))].filter(Boolean)
  const title = truncate(userText || hit.kind, 60)

  return {
    id: id ?? candidateId(title),
    title,
    kind: hit.kind,
    about: truncate(userText, 200),
    body: TEMPLATE_BODY({
      name: title,
      when: pick(userText) ?? placeholder('什么情况下适用'),
      components: facts.editedFiles.length ? facts.editedFiles.join('、') : placeholder('改了哪些东西'),
      how: pick(assistantText) ?? placeholder('怎么做'),
      verify: commands.length ? `跑过：${commands.join('、')}` : placeholder('怎么确认它还是对的'),
      unless: placeholder('什么时候它不管用'),
    }),
    evidence: facts.editedFiles.map((file) => ({ kind: 'file', ref: file })),
    scope,
    triggers: [],
    provenance: hit.id === 'S1' || hit.id === 'S2' ? 'user-asserted' : 'self-concluded',
    // 自动捕获是**观察**，不是背书 —— 只有 `memory_resolve` 的 accept 能写
    // `user-confirmed`（见 `model.AUTHORITIES`）。缺省也得显式写：
    // 不写会落成 `authority: null`，而 `contentHash` / 索引都按 `observed` 兜底，
    // 于是「文件里没有」和「文件里写着 observed」变成两种不同的哈希。
    authority: 'observed',
    origin: { sessionId: facts.sessionId ?? null, turn: facts.turn, signal: hit.id, capturedAt: now },
  }
}

/**
 * 候选 id。
 *
 * **必须走 `normalizeId`，不要自己再写一份。** 上一版这里是本地 `slug()`：
 * 先 `.replace(/[^\w\u4e00-\u9fff]+/g, '_')` 保留中文，再
 * `.replace(/[^\x00-\x7f]/g, '')` 把它们全删掉 —— 纯中文标题就塌成空串，
 * 兜底 `|| 'memory'`。于是**每一条**自动捕获的中文记忆 id 都是 `memory`，
 * 第二条静默覆盖第一条（`writeEntry` 用 `${id}.md` 当文件名）。
 *
 * 两套 id 算法本身就是这次审计里最贵的那类 bug：`normalizeId` 的守卫
 * 修好了，`slug()` 这边不知道。
 */
function candidateId(text) {
  return normalizeId(String(text ?? ''))
}

/**
 * 一轮结束时该不该产出候选？
 * 返回 `{ capture: boolean, hits, reason }` —— 稳定：同样的事实永远同样的答案。
 *
 * `mode` 决定信号窗口：
 *   strict（默认）  只看**当前轮**。噪声低，但「同一个工具失败 3 次」跨轮时不成立。
 *   steady          看**最近几轮**。捕捉反复踩的坑，代价是可能把一件跨轮的事说成一条记忆。
 */
export function shouldCapture(facts, options = {}) {
  const { corpus = [], config = {} } = options
  if (config?.capture?.enabled === false) return { capture: false, hits: [], reason: 'capture-disabled' }
  if (facts.userTexts.length === 0) return { capture: false, hits: [], reason: 'no-user-message' }

  const hits = detectSignals(facts, { corpus, enabled: config?.capture?.signals ?? null })
  if (hits.length === 0) return { capture: false, hits: [], reason: 'no-signal' }

  // steady 模式下「失败 ≥2 次后成功」只在**跨轮**才成立：单轮里那条已经在 S4 里了。
  // 这里只做一次降噪 —— 当前轮没有失败时，一条只有 S4 的命中是上一轮的残留。
  if (config?.capture?.mode === 'steady' && facts.failedCommands.length === 0) {
    const relevant = hits.filter((hit) => hit.id !== 'S4')
    if (relevant.length > 0) return { capture: true, hits: relevant, reason: relevant[0].id }
    return { capture: false, hits: [], reason: 'stale-signal' }
  }

  return { capture: true, hits, reason: hits[0].id }
}
