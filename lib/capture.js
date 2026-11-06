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
      const recurrence = corpus.some((entry) => {
        const entryTokens = new Set(`${entry.title} ${entry.about}`.toLowerCase().match(/[\w\u4e00-\u9fff]{2,}/g) ?? [])
        let shared = 0
        for (const token of tokens) if (entryTokens.has(token)) shared += 1
        return shared >= 2
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

/**
 * 由信号构造候选。**只做形态**，置信与去重交给 G8/G5。
 *
 * 注意：这里生成的 body 是**草稿**，几乎必然过不了 G2（六要素需要人/模型填实）。
 * 这是刻意的 —— 自动捕获只该产出「值得记的那件事」，措辞由 Agent 补。
 * 所以 `autonomy: manual` 下，捕获只进待决队列，不落盘。
 */
export function buildCandidate(facts, hit, { id, scope = [], now = isoNow() } = {}) {
  const userText = collapse(facts.userTexts.join(' '))
  const title = truncate(userText || hit.kind, 60)

  return {
    id: id ?? slug(title),
    title,
    kind: hit.kind,
    about: truncate(userText, 200),
    body: TEMPLATE_BODY({
      name: title,
      when: '（待补：什么情况下适用）',
      components: facts.editedFiles.length ? facts.editedFiles.join('、') : '（待补）',
      how: '（待补：怎么做）',
      verify: '（待补：怎么确认它还是对的）',
      unless: '（待补：什么时候它不管用）',
    }),
    evidence: facts.editedFiles.map((file) => ({ kind: 'file', ref: file })),
    scope,
    triggers: [],
    provenance: hit.id === 'S1' || hit.id === 'S2' ? 'user-asserted' : 'self-concluded',
    origin: { sessionId: facts.sessionId ?? null, turn: facts.turn, signal: hit.id, capturedAt: now },
  }
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, '_')
      .replace(/[^\x00-\x7f]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 64) || 'memory'
  )
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

  // steady 模式下，「失败 ≥2 次后成功」只在**跨轮**才成立 —— 单轮里那条已经在 S4 里了。
  // 这里只做一次降噪：把只有 S4 且当前轮没失败的命中去掉，避免重复捕获同一件事。
  if (config?.capture?.mode === 'steady') {
    const currentTurn = facts.turn
    const relevant = hits.filter((hit) => hit.id !== 'S4' || facts.failedCommands.length > 0)
    if (relevant.length > 0) return { capture: true, hits: relevant, reason: relevant[0].id }
    void currentTurn
  }

  return { capture: true, hits, reason: hits[0].id }
}
