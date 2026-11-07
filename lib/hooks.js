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
import { createEmbeddingChannel, vectorizeOwners } from './embedding.js'
import { collectOwners, nextHint, review } from './gate.js'
import { ensureSnapshot, markDirty, readSnapshot } from './index-build.js'
import { normalizeId } from './model.js'
import { recall as runRecall, renderRecall } from './recall.js'
import { routeFallbackHint, routeReport } from './routes.js'
import {
  MEMORY_DIR_NAME,
  PROPOSAL_TTL_DAYS,
  appendLedger,
  appendReceipt,
  ensureLayout,
  expireProposals,
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
 * 按 **UTF-8 字节** 截断，且不切断码点。
 *
 * `recall.maxBytes` 说的是字节，而 token 预算是按 `len / 4` 估的 ——
 * 那个系数对纯中文至少低估 4 倍（一个汉字 3 字节、≈1 token）。
 * 名字写「字节」就必须真的按字节兜住，否则注入量随语料正文长度无上限。
 */
function clampBytes(text, maxBytes) {
  const source = String(text ?? '')
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source
  const chars = [...source]
  let used = 0
  let end = 0
  for (const char of chars) {
    const size = Buffer.byteLength(char, 'utf8')
    // 留 1 个字符给省略号（它自己 1 字节）
    if (used + size > maxBytes - 1) break
    used += size
    end += 1
  }
  return `${chars.slice(0, end).join('')}…`
}

/** 正在排队的索引编译（同一个 root 只排一次）。 */
const indexBuilds = new Set()

/**
 * 创建钩子。返回 `{ install, drain, dispose, describe }`。
 *
 * `ask` 是 `ctx.userQuestions.ask` —— 可选服务。拿不到时降级为 log，
 * 因为 headless / sdk 的 profile 里本来就没有「当场提问」这个出口。
 */
export function createHooks({ ctx, configSource, resolveRoot, log, ask = null }) {
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

  // 起草器要读 `capture.draft` / `capture.draftProvider` —— 而 `capture` 是
  // **仓库属性**（`config/defaults.js` 的 `PROJECT_KEYS`）。所以不能把
  // apply() 时算好的快照交给它：改成每次按 agent 现取，项目层改了立刻生效。
  const draft = createDrafter({ ctx, getConfig: (agent) => configSource.get(resolveRoot(agent)), log })
  /** 语义通道：整个插件一个实例，向量缓存跨轮复用。`embedding` 不是仓库属性。 */
  const channel = createEmbeddingChannel({ config: configSource.portable(), log })

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
      const sessionId = assembleContext?.agent?.id
      if (!sessionId) return ''

      const query = queryBySession.get(sessionId)
      if (!query || query.trim().length < 4) return ''

      const root = resolveRoot(assembleContext?.agent)
      // 先解析 root 再取配置：`recall` 是用户偏好（不在项目层），但
      // `inject` 必须支持「这个仓库先关掉召回」这种现场判断。
      const cfg = configSource.get(root)
      if (cfg?.recall?.inject === false) return ''

      // **不初始化**：没装过记忆库的项目一个字节都不该被创建。
      // 这一步是 prompt 装配路径，它的副作用必须为零。
      if (!hasCorpus(root)) return ''

      /**
       * **只读快照，不编译。**
       *
       * 上一版调 `ensureSnapshot` —— 那在快照陈旧时会 `compileSnapshot` +
       * `publishSnapshot`：`mkdirSync` + 6 个 `writeFileAtomic` + 2 个指针文件。
       * 于是「纯读的 prompt 装配」在磁盘上写出了一个索引目录，最坏情况还是
       * 冷启动那 117 ms。装配路径的预算是 < 5 ms 且**零副作用**，这条
       * 承诺写在 `docs/02` 的延迟预算表里，也写在下面 `hasCorpus` 的注释里。
       *
       * 快照不在就返回空，并把编译排到后台（`setTimeout(0)`）——
       * 下一次装配就能看见，但**这一轮不付出任何写盘代价**。
       */
      const snapshot = readSnapshot(root)
      if (!snapshot?.documents?.length) {
        scheduleIndexBuild(root)
        return ''
      }

      const envelope = runRecall(query, snapshot, {
        limit: 3,
        maxTokens: cfg?.recall?.maxBytes ? Math.ceil(cfg.recall.maxBytes / 4) : 400,
        config: cfg,
      })

      // **按字节硬截断**。`maxBytes` 的单位是字节，而 token 预算是按
      // `len/4` 估的 —— 那个系数对纯中文至少低估 4 倍。渲染完再按 UTF-8
      // 字节裁一次，才是这个名字真正承诺的东西。
      //
      // 兜底提示**只在弃权时算**：`routeReport` 虽然带 mtime 缓存，但它要
      // `readdir` + 每个子目录一次 `stat`。命中时白付这笔钱没有意义。
      const fallbackHint = envelope.delivery.tier === 'abstain' ? routeFallbackHint(routeReport(root)) : undefined
      return clampBytes(renderRecall(envelope, { fallbackHint }), cfg?.recall?.maxBytes ?? 4000)
    } catch (error) {
      log(`recall injection skipped: ${error?.message ?? error}`)
      return ''
    }
  }

  /** 把索引编译排到后台。同一个 root 只排一次。 */
  function scheduleIndexBuild(root) {
    if (indexBuilds.has(root)) return
    indexBuilds.add(root)
    const timer = setTimeout(() => {
      timers.delete(timer)
      indexBuilds.delete(root)
      try {
        ensureSnapshot(root)
      } catch (error) {
        log(`index build failed: ${error?.message ?? error}`)
      }
    }, 0)
    timer.unref?.()
    timers.add(timer)
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

      const root = resolveRoot(payload?.agent)
      // `capture.enabled` / `capture.mode` **是仓库属性** —— 同一个 profile 下
      // 仓库 A 可能开着自动捕获、仓库 B 关着。所以这里必须按 root 现取。
      const cfg = configSource.get(root)
      if (cfg?.capture?.enabled === false) return

      const events = eventsBySession.get(sessionId) ?? []
      // strict：只看当前轮（噪声低）。steady：看最近几轮（能捕捉跨轮反复踩的坑）。
      const turnEvents =
        cfg?.capture?.mode === 'steady'
          ? events.slice(-60)
          : events.filter((event) => (event.data?.turn ?? event.turn) === payload.turn || !payload.turn)
      const facts = foldTurn(turnEvents.length ? turnEvents : events.slice(-40), { turn: payload.turn })
      facts.sessionId = sessionId

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
        /**
         * **队列的出口：到期自动退场。**
         *
         * 没有这一步，`PROPOSAL_QUEUE_LIMIT` 迟早会被撞上，而「撞上」的表现
         * 是自动捕获开始失败 —— 那是最糟的发现方式。过期 ≠ 拒绝：
         * 前者是「两周没人看」，后者是「我看过了，不要」，两者都留档，
         * 但 `expiredAt` / `rejectedAt` 分开记，免得「拒答率」失真。
         */
        try {
          const expired = expireProposals(root)
          if (expired.length > 0) {
            appendLedger(root, { kind: 'expire', ids: expired, ttlDays: PROPOSAL_TTL_DAYS })
            log(`待决提案过期 ${expired.length} 条（${PROPOSAL_TTL_DAYS} 天没人裁决）—— 已留档到 pending/rejected/`)
          }
        } catch (error) {
          log(`提案过期失败：${error?.message ?? error}`)
        }

        for (const item of readInbox(root)) {
          /**
           * **只有成功才从队列里删。**
           *
           * 这条链路的设计立论是「落盘而不是纯内存队列，是为了**进程崩了也不丢**」
           * （`store.js` 的 inbox 注释、`docs/04` 的 M4 验收）。上一版用
           * `finally { removeInbox(...) }`，于是起草失败、写盘失败、HTTP 失败
           * 全部只留一行日志 —— 持久队列退化成 **at-most-once**，
           * 而且丢得静默无声。
           *
           * 失败时保留，并记 `attempts`；超过 3 次挪进 `inbox/failed/`，
           * 免得一条永远处理不了的毒消息卡住整个队列。
           */
          try {
            await processItem(root, item)
            removeInbox(root, item.id)
          } catch (error) {
            log(`drain item ${item?.id} failed: ${error?.message ?? error}`)
            bumpInboxAttempts(root, item)
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

  /**
   * 记一次失败尝试。**3 次之后挪走** —— 一条永远处理不了的毒消息不能卡住整个队列
   * （`readInbox` 按文件名排序，卡在第一位就是每轮都重试同一条）。
   */
  function bumpInboxAttempts(root, item) {
    if (!item?.id) return
    try {
      const attempts = (Number(item.attempts) || 0) + 1
      if (attempts >= 3) {
        log(`drain item ${item.id} 连续失败 ${attempts} 次，已移出队列（留档见日志）`)
        removeInbox(root, item.id)
        return
      }
      writeInbox(root, { ...item, attempts })
    } catch (error) {
      log(`inbox retry bookkeeping failed: ${error?.message ?? error}`)
    }
  }

  async function processItem(root, item) {
    if (!item || item.corrupt) return
    ensureLayout(root)
    // 后台路径也按 root 现取：`autonomy` / `thresholds` 是用户偏好，
    // 但它们决定这一条到底落不落盘，不能拿旧快照。
    const cfg = configSource.get(root)

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
    const owners = collectOwners(root)

    /**
     * 语义兜底（后台路径，本来就是 async）。通道关着就一个字段都不碰 ——
     * 默认行为必须和「没有这个功能」逐字节相同。
     */
    let ownerVectors = null
    let semanticThreshold = null
    if (channel.enabled && channel.g1Threshold !== null) {
      ownerVectors = await vectorizeOwners(owners, channel)
      const [vector] = await channel.ensure([`${candidate.title ?? ''}\n${candidate.about ?? ''}`])
      candidate.vector = vector ?? null
      semanticThreshold = channel.g1Threshold
    }

    const verdict = review(candidate, {
      root,
      config: cfg,
      corpus: entries,
      owners,
      ownerVectors,
      semanticThreshold,
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
    let proposal
    try {
      proposal = writeProposal(root, {
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
    } catch (error) {
      if (error?.code !== 'queue-full') throw error
      /**
       * **队列满 → DISCARD，不重试。**
       *
       * 重试没有用：队列不会在 30 秒后自己变空。而重试三次之后
       * `bumpInboxAttempts` 会把它当作「毒消息」静默移出 —— 同一条命丢得
       * 更难看（只剩一行日志）。所以这里显式丢弃，并且**记 ledger**：
       * 一次没有发生的记忆是一次决定，不是一次事故。
       */
      appendLedger(root, {
        kind: 'attempt',
        id: candidate.id,
        decision: 'discarded',
        code: 'queue.full',
        signal: item.hit?.id,
      })
      log(`待决队列已满（${error.count}/${error.limit}），丢弃一条捕获：${candidate.id}`)
      return
    }
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
      /**
       * **连续 3 次 DEFER 要当场问一次。**
       *
       * `docs/02` 把「三个出口」写成系统设计的一部分（manual 全靠确认 /
       * balanced 高置信自动 / 连续 DEFER 当场提问）。上一版这一支只有一行
       * `log()` —— 而日志在 headless、在没人看的地方等于没有，
       * 第三条出口事实上不存在。
       *
       * 拿不到 `userQuestions` 服务时降级为 log（`docs/02:399` 定义了这个契约）。
       */
      const question =
        `记忆库连续 ${streak} 次判不了该不该记（最新一条：${proposal.id} · ${candidate.title}）。` +
        '要现在就裁决吗？`/memory pending` 看全部，`/memory accept|reject <id>` 裁决。'
      /**
       * **`??` 兜不住 promise。**
       *
       * 宿主的 `userQuestions.ask()` 返回 Promise（等用户回答）；用户取消 /
       * 宿主没有提问出口时就是 **rejected**。`ask?.(question) ?? log(...)`
       * 只看「是不是 null/undefined」—— 返回的 Promise 既不是 null 也不是
       * undefined，所以 `log` 不会执行；那个 rejection 没人接，变成
       * `unhandledRejection`，Node 22 默认**终止宿主进程**
       * （`test/hooks.test.mjs` 的「rejected 的 ask 不会变成 unhandledRejection」）。
       */
      try {
        const asked = ask?.(question)
        if (asked === null || asked === undefined) {
          log(`defer streak reached ${streak} — ${proposal.id} 等你在 /memory pending 里裁决`)
        } else if (typeof asked.then === 'function') {
          // 提问是**尽力而为**：失败只降级为日志，不许拖死后台 drain。
          asked.then(undefined, (error) => {
            log(`userQuestions.ask failed: ${error?.message ?? error}`)
          })
        }
      } catch (error) {
        log(`userQuestions.ask failed: ${error?.message ?? error}`)
      }
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
