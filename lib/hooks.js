/**
 * 宿主钩子：召回注入（`system-prompt` context）+ 捕获（`agent/turn-stopping`）。
 *
 * 为什么写入**不**发生在 `agent/pre-step`：召回与写入是两条独立路径，
 * 共享同一份记忆模型与同一套证据解析器，但不共享时机。
 *
 * 为什么用 `systemPrompt.context` 而不是往 `pre-step` 的 messages 里塞：
 *   - context 是**运行时上下文**的正规位置（order 130，在审批策略之后、harness 源之前）；
 *   - 它标记 `required: false`，用户可以用 `suppressRuntimeContext()` 关掉；
 *   - 不需要手搓 `UserMessage` 形状 —— 那是宿主内部类型，插件不该复制。
 *
 * 纪律：
 *   - 钩子里**永不抛**：一个在用户按键上崩溃的钩子比没有钩子更糟；
 *   - 捕获走串行 `turn-stopping`，在返回前完成（否则 turn 关了记忆却没写）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { buildCandidate, foldTurn, shouldCapture } from './capture.js'
import { nextHint, review } from './gate.js'
import { ensureSnapshot } from './index-build.js'
import { normalizeId } from './model.js'
import { recall as runRecall, renderRecall } from './recall.js'
import { collectOwners } from './gate.js'
import {
  MEMORY_DIR_NAME,
  appendLedger,
  appendReceipt,
  ensureLayout,
  newProposalId,
  readAll,
  writeEntry,
  writeProposal,
} from './store.js'
import { collapse } from './util.js'

/** 每会话最多保留多少条事件（捕获只需要一轮）。 */
const EVENT_BUFFER = 400
/** 每会话最多保留多少个待注入的查询。 */
const QUERY_CACHE = 32

/**
 * 创建钩子。返回 `{ install, dispose, describe }` —— install 由 index.js 接到 Cordis。
 */
export function createHooks({ ctx, cfg, resolveRoot, log }) {
  /** sessionId -> 最近的 durable 事件（只保留尾部） */
  const eventsBySession = new Map()
  /** sessionId -> 最近一条用户消息（用于召回） */
  const queryBySession = new Map()
  /** sessionId -> 连续 DEFER 次数（升级为当场提问） */
  const deferStreak = new Map()

  function remember(map, key, value, cap) {
    map.set(key, value)
    while (map.size > cap) map.delete(map.keys().next().value)
  }

  /* ── 事件观察 ─────────────────────────────────────────────────── */

  function onSessionEvent(payload) {
    try {
      const sessionId = payload?.sessionId ?? payload?.session?.id
      const event = payload?.event ?? payload
      if (!sessionId || !event?.type) return

      const buffer = eventsBySession.get(sessionId) ?? []
      buffer.push(event)
      if (buffer.length > EVENT_BUFFER) buffer.splice(0, buffer.length - EVENT_BUFFER)
      eventsBySession.set(sessionId, buffer)

      if (event.type === 'user/message') {
        const text = textOf(event.data)
        if (text) remember(queryBySession, sessionId, text, QUERY_CACHE)
      }
    } catch (error) {
      log(`event observer failed: ${error?.message ?? error}`)
    }
  }

  /* ── 召回注入 ─────────────────────────────────────────────────── */

  /**
   * 为当前装配生成记忆上下文。**同步、纯读**：零网络、零模型调用。
   * 任何异常都降级为「不注入」，绝不打断这一轮。
   */
  function memoryContext(assembleContext) {
    try {
      if (cfg?.recall?.inject === false) return ''
      const sessionId = assembleContext?.agent?.id
      if (!sessionId) return ''

      const query = queryBySession.get(sessionId)
      if (!query || query.trim().length < 4) return ''

      const root = resolveRoot(assembleContext?.agent)

      // **不初始化**：没装过记忆库的项目一个字节都不该被创建。
      // 这一步是 prompt 装配路径，它的副作用必须为零。
      if (!hasCorpus(root)) return ''

      const { snapshot } = ensureSnapshot(root)
      if (!snapshot?.documents?.length) return ''

      const envelope = runRecall(query, snapshot, {
        limit: 3,
        maxTokens: cfg?.recall?.maxBytes ? Math.ceil(cfg.recall.maxBytes / 4) : 400,
        config: cfg,
      })

      return renderRecall(envelope)
    } catch (error) {
      log(`recall injection skipped: ${error?.message ?? error}`)
      return ''
    }
  }

  /* ── 捕获与自审 ───────────────────────────────────────────────── */

  function onTurnStopping(payload) {
    try {
      const sessionId = payload?.agent?.id
      if (!sessionId) return
      if (cfg?.capture?.enabled === false) return

      const events = eventsBySession.get(sessionId) ?? []
      // strict：只看当前轮（噪声低）。steady：看最近几轮（能捕捉跨轮反复踩的坑）。
      const turnEvents =
        cfg?.capture?.mode === 'steady'
          ? events.slice(-60)
          : events.filter((event) => (event.data?.turn ?? event.turn) === payload.turn || !payload.turn)
      const facts = foldTurn(turnEvents.length ? turnEvents : events.slice(-40), { turn: payload.turn })
      facts.sessionId = sessionId

      const root = resolveRoot(payload?.agent)
      ensureLayout(root)
      const { entries } = readAll(root)

      const decision = shouldCapture(facts, { corpus: entries, config: cfg })
      if (!decision.capture) return

      const hit = decision.hits[0]
      const candidate = buildCandidate(facts, hit, { id: normalizeId(truncate(facts.userTexts[0] ?? hit.kind, 60)) })

      const verdict = review(candidate, {
        root,
        config: cfg,
        corpus: entries,
        owners: collectOwners(root),
      })

      if (verdict.decision === 'ACCEPT' && cfg.autonomy !== 'manual') {
        const entry = writeEntry(root, {
          ...candidate,
          evidence: verdict.resolvedEvidence ?? candidate.evidence,
          actionRisk: verdict.actionRisk,
        })
        appendReceipt(root, entry)
        appendLedger(root, {
          kind: 'attempt',
          id: entry.id,
          decision: 'accepted',
          by: 'capture',
          signal: hit.id,
          confidence: verdict.confidence ?? null,
        })
        ensureSnapshot(root, { force: true })
        log(`captured ${entry.id} (${hit.id})`)
        return
      }

      if (verdict.decision === 'REJECT') {
        appendLedger(root, {
          kind: 'attempt',
          id: candidate.id,
          decision: 'rejected',
          by: 'capture',
          code: verdict.code,
          gate: verdict.gate,
          detail: verdict.code === 'secret' ? { rule: verdict.detail?.rule } : null,
        })
        return
      }

      // DEFER 或 manual 下的 ACCEPT → 进待决队列
      const proposal = writeProposal(root, {
        id: newProposalId(),
        candidate,
        gates: verdict.gates ?? [],
        deferredBy: (verdict.gates ?? []).filter((gate) => gate.kind === 'refuse').map((gate) => gate.gate),
        why: [
          ...(verdict.gates ?? []).filter((gate) => gate.kind === 'refuse').map((gate) => `${gate.gate}:${gate.code}`),
          ...(cfg.autonomy === 'manual' ? ['autonomy:manual'] : []),
        ],
        status: 'pending',
      })
      appendLedger(root, {
        kind: 'attempt',
        proposalId: proposal.id,
        id: candidate.id,
        decision: 'deferred',
        by: 'capture',
        signal: hit.id,
      })

      const streak = (deferStreak.get(sessionId) ?? 0) + 1
      deferStreak.set(sessionId, streak)
      if (cfg.autonomy === 'balanced' && streak >= 3) {
        deferStreak.set(sessionId, 0)
        log(`defer streak reached 3 — surfacing ${proposal.id} to the user`)
      }
    } catch (error) {
      log(`capture failed: ${error?.message ?? error}`)
    }
  }

  /* ── 安装 ─────────────────────────────────────────────────────── */

  function install() {
    const disposers = []

    disposers.push(ctx.on('session/event', (payload) => onSessionEvent(payload)))
    disposers.push(ctx.on('agent/turn-stopping', (payload) => onTurnStopping(payload)))

    disposers.push(
      ctx.systemPrompt.context({
        name: 'memory:recall',
        // 100 工作目录 · 110 沙箱 · 115 审批 · **130 记忆** · 200 harness 源
        order: 130,
        required: false,
        text: (assembleContext) => memoryContext(assembleContext),
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch (error) {
          log(`dispose failed: ${error?.message ?? error}`)
        }
      }
    }
  }

  return { install, describe: () => ({ sessions: eventsBySession.size, deferStreak: deferStreak.size }) }
}

function textOf(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return payload
  if (typeof payload.text === 'string') return payload.text
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((block) => (typeof block === 'string' ? block : block?.text ?? ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 项目里有没有装过记忆库？
 *
 * 只做一次 `existsSync`：**prompt 装配路径不能有任何副作用** ——
 * 一个从没用过记忆的项目，不该因为我们看过一眼就多出 `.dsh-memory/` 目录。
 */
function hasCorpus(root) {
  try {
    return existsSync(join(root, MEMORY_DIR_NAME, 'memories'))
  } catch {
    return false
  }
}

export { collapse, nextHint }
