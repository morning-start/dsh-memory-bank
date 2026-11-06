/**
 * 宿主钩子：召回注入（`system-prompt` context）+ 捕获（`agent/turn-stopping`）。
 *
 * 两条路径的**延迟预算完全不同**，这是本文件的全部设计：
 *
 *   `system-prompt.context`  每轮都跑，同步、纯读、**零副作用**。
 *                            目标 < 5 ms。做不到就是每轮卡用户。
 *
 *   `agent/turn-stopping`    宿主 **await** 它 —— 它花多少，用户就多等多少
 *                            才看到回合结束。所以它**只做确定性判定 + 落盘入队**
 *                            （~1 ms），真正的处理交给 drain。
 *
 * 为什么捕获必须落盘再处理：纯内存队列在进程崩掉时丢数据，而「这条记忆该记」
 * 是用户在那一轮里刚说出口的东西 —— 丢了就再也回不来了。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { foldTurn, shouldCapture } from './capture.js'
import { createDrafter } from './draft.js'
import { collectOwners, nextHint, review } from './gate.js'
import { ensureSnapshot, markDirty } from './index-build.js'
import { normalizeId } from './model.js'
import { recall as runRecall, renderRecall } from './recall.js'
import {
  MEMORY_DIR_NAME,
  appendLedger,
  appendReceipt,
  ensureLayout,
  newProposalId,
  readAll,
  readInbox,
  removeInbox,
  writeEntry,
  writeInbox,
  writeProposal,
} from './store.js'
import { collapse, truncate } from './util.js'

/** 每会话最多保留多少条事件（捕获只需要一轮）。 */
const EVENT_BUFFER = 400
/** 每会话最多保留多少个待注入的查询。 */
const QUERY_CACHE = 32
/** 兜底 drain 周期：入队时会立刻排一次，这个只是防止漏掉。 */
const DRAIN_INTERVAL_MS = 30_000

/**
 * 创建钩子。返回 `{ install, drain, dispose, describe }`。
 */
export function createHooks({ ctx, cfg, resolveRoot, log }) {
  /** sessionId -> 最近的 durable 事件（只保留尾部） */
  const eventsBySession = new Map()
  /** sessionId -> 最近一条用户消息（用于召回） */
  const queryBySession = new Map()
  /** sessionId -> 连续 DEFER 次数（升级为当场提问） */
  const deferStreak = new Map()
  /** 后台工作的取消信号：turn 的 signal 在 turn-stopping 返回后就 abort 了。 */
  const lifecycle = new AbortController()
  const timers = new Set()
  let draining = false
  let drainAgain = false

  const draft = createDrafter({ ctx, cfg, log })

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

  /* ── 召回注入（同步、零副作用） ───────────────────────────────── */

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

  /* ── 捕获：入队（快） ─────────────────────────────────────────── */

  /**
   * **只做确定性判定 + 落盘**。不跑门、不写记忆、不重建索引。
   * 目标 < 2 ms —— 这是宿主 await 的路径。
   */
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
      // 留住 live Agent：drain 里起草要用它当 parent。JSON 存不了活对象，
      // 所以入队时顺手记在内存里（有界，进程重启后起草回退模板）。
      if (payload?.agent) remember(agentsBySession, sessionId, payload.agent, 16)

      const { entries } = readAll(root)
      const decision = shouldCapture(facts, { corpus: entries, config: cfg })
      if (!decision.capture) return

      const hit = decision.hits[0]
      writeInbox(root, {
        // agent 不能进 JSON（循环引用 + 一个巨大的活对象）—— 只留 id，drain 时重取
        sessionId,
        turn: payload.turn ?? null,
        hit,
        facts: {
          turn: facts.turn,
          userTexts: facts.userTexts,
          assistantTexts: facts.assistantTexts,
          editedFiles: facts.editedFiles,
          failedCommands: facts.failedCommands.map((item) => ({ name: item.name })),
          succeededCommands: facts.succeededCommands.map((item) => ({ name: item.name })),
        },
        candidateId: normalizeId(truncate(facts.userTexts[0] ?? hit.kind, 60)),
      })
      scheduleDrain()
    } catch (error) {
      log(`capture enqueue failed: ${error?.message ?? error}`)
    }
  }

  /* ── 捕获：drain（后台，可以使用模型） ───────────────────────── */

  function scheduleDrain() {
    const timer = setTimeout(() => {
      timers.delete(timer)
      void drain()
    }, 0)
    timer.unref?.()
    timers.add(timer)
  }

  /** 处理收件箱。**永不抛**：一条处理失败不能让其余的记忆卡住。 */
  async function drain() {
    if (draining) {
      drainAgain = true
      return
    }
    draining = true
    try {
      const roots = new Set()
      // 收件箱是按项目分的，但 drain 是全局的 —— 用最近见过的 root 兜住
      for (const root of knownRoots()) roots.add(root)

      for (const root of roots) {
        for (const item of readInbox(root)) {
          try {
            await processItem(root, item)
          } catch (error) {
            log(`drain item ${item?.id} failed: ${error?.message ?? error}`)
          } finally {
            removeInbox(root, item.id)
          }
        }
      }
    } catch (error) {
      log(`drain failed: ${error?.message ?? error}`)
    } finally {
      draining = false
      if (drainAgain) {
        drainAgain = false
        scheduleDrain()
      }
    }
  }

  /** drain 需要知道有哪些 root。入队时记下来，进程重启后按需重新发现。 */
  const rootsSeen = new Set()
  function knownRoots() {
    return [...rootsSeen]
  }

  async function processItem(root, item) {
    if (!item || item.corrupt) return
    ensureLayout(root)

    // 重建 facts（含 agent 引用），因为 agent 不能进 JSON
    const facts = {
      ...item.facts,
      sessionId: item.sessionId,
      turn: item.turn,
      agent: resolveAgent(item.sessionId),
    }

    // 起草：template 是纯算术；subagent 会在这里跑一次模型（后台，不阻塞任何人）
    const { candidate, draftedBy } = await draft({
      facts,
      hit: item.hit,
      id: item.candidateId,
      signal: lifecycle.signal,
    })

    const { entries } = readAll(root)
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
        draftedBy,
        signal: item.hit?.id,
        confidence: verdict.confidence ?? null,
      })
      markDirty(root)
      log(`captured ${entry.id} (${item.hit?.id}, ${draftedBy})`)
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
      draftedBy,
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
      signal: item.hit?.id,
      draftedBy,
    })

    const streak = (deferStreak.get(item.sessionId) ?? 0) + 1
    deferStreak.set(item.sessionId, streak)
    if (cfg.autonomy === 'balanced' && streak >= 3) {
      deferStreak.set(item.sessionId, 0)
      log(`defer streak reached 3 — ${proposal.id} 等你在 /memory pending 里裁决`)
    }
  }

  /** 按 sessionId 找回 live Agent。拿不到就是 null —— 起草会回退模板。 */
  const agentsBySession = new Map()
  function resolveAgent(sessionId) {
    return agentsBySession.get(sessionId) ?? null
  }

  /* ── 安装 ─────────────────────────────────────────────────────── */

  function install() {
    const disposers = []

    disposers.push(ctx.on('session/event', (payload) => onSessionEvent(payload)))
    disposers.push(
      ctx.on('agent/turn-stopping', (payload) => {
        // 记下这个 root，drain 才知道该扫哪里
        try {
          rootsSeen.add(resolveRoot(payload?.agent))
        } catch {
          /* 解析失败就算了 */
        }
        onTurnStopping(payload)
      }),
    )

    disposers.push(
      ctx.systemPrompt.context({
        name: 'memory:recall',
        // 100 工作目录 · 110 沙箱 · 115 审批 · **130 记忆** · 200 harness 源
        order: 130,
        required: false,
        text: (assembleContext) => memoryContext(assembleContext),
      }),
    )

    // 兜底：入队时会立刻排一次 drain，这个只防漏
    const interval = setInterval(() => void drain(), DRAIN_INTERVAL_MS)
    interval.unref?.()
    timers.add(interval)

    return () => {
      lifecycle.abort()
      for (const timer of timers) {
        clearTimeout(timer)
        clearInterval(timer)
      }
      timers.clear()
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch (error) {
          log(`dispose failed: ${error?.message ?? error}`)
        }
      }
    }
  }

  return {
    install,
    drain,
    describe: () => ({ sessions: eventsBySession.size, deferStreak: deferStreak.size, draining }),
  }
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
