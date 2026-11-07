/**
 * 只读查询（面板的「读一半」）。
 *
 * **每一个数字都必须与 `/memory status` 逐字对得上。** 面板和命令面是
 * 同一个记忆库的两个窗口 —— 0.1.0 的教训是「两份世界，且没有任何测试会红」。
 * 所以这里**不重新定义任何判据**：
 *
 * | 概念 | 唯一实现 |
 * |---|---|
 * | 活跃条目 | `store.activeEntries`（**白名单**：只有 active / advisory） |
 * | 断言统计 | `claims.claimStats` |
 * | 漂移三桶 | `drift.driftReport` |
 * | 生命周期 | `lifecycle.lifecycleReport` |
 * | 快照 | `index-build.readSnapshot` |
 * | 四层配置 | `config/index.createConfigSource` |
 *
 * 0.1.1 刚修完「`gateQuota` 用黑名单、`activeEntries` 用白名单，两边对不上」——
 * 这里再写一份过滤条件就是同一个错误的第二次。
 *
 * ## 为什么每个函数都收 `root` 作为第一个参数
 *
 * 线上方法名是固定的（`shared/endpoints.js`），参数表也是固定的
 * （`pending` 只收 `limit`）。`root` **不上线** —— 它由 `service.js` 在调用
 * 之前解析好。把 `root` 塞进 RPC 参数会同时破坏两件事：端点的参数契约，
 * 以及「这个服务只写调用方自己的仓库」这条边界（虽然 RPC 目前只有 owner 能调）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { claimStats } from '../claims.js'
import { readProjectConfig } from '../config/index.js'
import { driftReport } from '../drift.js'
import { ensureSnapshot, readSnapshot } from '../index-build.js'
import { isDormant, isExpired, lifecycleReport } from '../lifecycle.js'
import { recall as runRecall } from '../recall.js'
import {
  activeEntries,
  inboxSize,
  layout,
  readAll,
  readLedger,
  readProposals,
  readStats,
} from '../store.js'

/** `limit` 的默认值与范围（与 `shared/endpoints.js` 的注释一致）。 */
const PENDING_LIMIT = { min: 1, max: 50, fallback: 10 }
const MEMORIES_LIMIT = { min: 1, max: 50, fallback: 10 }
const LEDGER_LIMIT = { min: 1, max: 500, fallback: 50 }

function clampInt(value, { min, max, fallback }) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/* ── 配额棘轮 ─────────────────────────────────────────────────────── */

/**
 * 读 `quota.lock.json`。
 *
 * **这是 `lib/tools.js` 私有 `readQuotaState` 的镜像。** 那个函数没导出，
 * 而 `lib/tools.js` 不在本次改动范围内（写作用域只有 `lib/host/**` +
 * `lib/command.js`）。两处读同一个文件，**判据必须一字不差**：
 *
 *   - 文件不存在 / 不是对象 → `null`（= growth 的默认态）；
 *   - `mode: 'ratchet'` 但没有可用的 `maxActive` → **降级回 `null`**。
 *     上一版原样返回，于是 `{"mode":"ratchet"}` 让 `limit = used`，
 *     `used < limit` 恒假 —— 每一次写入都被拒，包括空库。
 *
 * `tests/host.test.mjs` 有一条断言直接比对两处的分支（坏文件必须降级）。
 */
export function readQuotaState(root) {
  const file = join(layout(root).base, 'quota.lock.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const maxActive = Number(parsed.maxActive)
    const usable = Number.isInteger(maxActive) && maxActive > 0
    if (parsed.mode === 'ratchet' && !usable) return null
    return { ...parsed, maxActive: usable ? maxActive : null }
  } catch {
    return null
  }
}

/* ── 视图映射 ─────────────────────────────────────────────────────── */

/**
 * 存储状态 → 界面状态。
 *
 * `shared/types.d.ts` 的 `MemorySummary.status` 只有四个值，而
 * `model.LIFECYCLE_STATES` 有九个。`dormant` / `expired` **不是存储状态**
 * （它们是「多久没被召回」「`expiresAt` 到了吗」的推论），所以这里必须
 * 走 `lifecycle.isDormant` / `lifecycle.isExpired` —— 自己写一遍天数比较
 * 就是第三个「同一个问题有不同答案」。
 */
function viewStatus(entry, now) {
  const stored = entry.status ?? 'active'
  if (stored === 'deprecated' || stored === 'rejected' || stored === 'superseded') return 'retired'
  if (isExpired(entry, now)) return 'expired'
  if (isDormant(entry, now)) return 'dormant'
  return 'active'
}

function toMemorySummary(entry, stats, now) {
  const record = stats?.entries?.[entry.id]
  return {
    id: entry.id,
    title: entry.title ?? '',
    kind: entry.kind ?? 'fact',
    status: viewStatus(entry, now),
    confidence: entry.confidence ?? null,
    updatedAt: entry.modifiedAt ?? entry.lastVerifiedAt ?? entry.createdAt ?? null,
    accessCount: Number(record?.accessCount ?? 0),
    lastRecalledAt: record?.lastAccessed ?? null,
  }
}

/** 图提案没有人话标题 —— 按 kind 生成一句，与 `lib/tools.js` 的渲染一致。 */
function proposalLabel(proposal) {
  switch (proposal.kind) {
    case 'merge':
      return `合并 ${proposal.ids?.length ?? 0} 条记忆`
    case 'edge':
      return `连一条边 ${proposal.subjectId ?? '?'} ↔ ${proposal.objectId ?? '?'}`
    case 'cluster':
      return `一个记忆社群（${proposal.evidence?.members?.length ?? 0} 条）`
    case 'core':
      return `一条记忆是图中心 ${proposal.subjectId ?? '?'}`
    default:
      return String(proposal.kind ?? '（无标题）')
  }
}

/**
 * 判不了的门 id。
 *
 * 两个来源，优先级分明：新提案带 `gates`（完整 verdict 对象），旧提案只有
 * `why`（`'G5:duplicate'` 这样的字符串）。`why` 里也可能有 `dream:orphans`
 * 这种非门标记 —— 只保留 `G` 开头的，否则界面会画出一个不存在的门。
 */
function proposalGates(proposal) {
  const fromVerdicts = Array.isArray(proposal.gates)
    ? proposal.gates.filter((verdict) => verdict?.kind === 'refuse' && typeof verdict.gate === 'string').map((verdict) => verdict.gate)
    : []
  if (fromVerdicts.length > 0) return [...new Set(fromVerdicts)]
  return [
    ...new Set(
      (Array.isArray(proposal.why) ? proposal.why : [])
        .map((reason) => String(reason).split(':')[0])
        .filter((gate) => /^G\d+b?$/.test(gate)),
    ),
  ]
}

function toPendingProposal(proposal) {
  return {
    // 记忆提案没有自己的 kind —— 它的 kind 是**记忆的** kind（decision / pitfall …），
    // 而界面要区分的是「这是哪一类待决」，所以统一成 `candidate`。
    id: proposal.id,
    kind: proposal.candidate ? 'candidate' : (proposal.kind ?? 'candidate'),
    title: proposal.candidate?.title ?? proposalLabel(proposal),
    confidence: proposal.candidate?.confidence ?? null,
    actionRisk: proposal.candidate?.actionRisk ?? null,
    gates: proposalGates(proposal),
    why: Array.isArray(proposal.why) ? proposal.why.map(String) : [],
    createdAt: proposal.createdAt ?? null,
  }
}

function toDriftItem(entry, bucket) {
  const drifted = Array.isArray(entry.drifted) ? entry.drifted : []
  return {
    id: entry.id,
    bucket,
    // 类型契约里这一项叫 `code`；漂移的判决就存在 `verdict` 上（`healthy` 等）。
    // 这里不发明新词：把 verdict 原样交出去，界面按它上色。
    code: String(entry.verdict ?? 'unverifiable'),
    detail: drifted.map((anchor) => anchor.detail).filter(Boolean).join(' · ') || String(entry.verdict ?? ''),
    anchors: drifted.map((anchor) => `${anchor.kind}:${anchor.ref}`),
  }
}

function toLedgerEntry(record) {
  return {
    at: record.ts ?? null,
    // `shared/types.d.ts` 的 kind 联合漏了 `forget` / `quota-transition` /
    // `consolidate` —— 原样透出，不为了迁就类型把真实记录丢掉。
    kind: record.kind ?? 'attempt',
    id: record.id ?? null,
    proposalId: record.proposalId ?? null,
    decision: record.decision ?? null,
    gate: record.gate ?? null,
    code: record.code ?? null,
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    action: record.action ?? null,
    reason: record.reason ?? null,
  }
}

/* ── 门面 ─────────────────────────────────────────────────────────── */

/**
 * @param {{ configSource: { get(root: string): object, describe(root: string): object, projectPath(root: string): string, problems(root: string): string[] } }} deps
 */
export function createQueries({ configSource }) {
  /** 每个查询都要的两样东西：那个仓库的**当前**配置。 */
  const cfgFor = (root) => configSource.get(root)

  return {
    /**
     * 健康概览 —— 界面 2 的顶部一行。
     *
     * 数字的口径与 `/memory status` 完全一致（见文件头的表）。`quota.used`
     * 就是活跃条目数：配额管的是「能注入多少条」，不是「磁盘上有多少文件」。
     */
    overview(root, { now = Date.now() } = {}) {
      const { entries, problems } = readAll(root)
      const active = activeEntries(entries)
      const claims = claimStats(entries)
      const life = lifecycleReport(active, { now })
      const snapshot = readSnapshot(root)
      const quota = readQuotaState(root)

      return {
        root,
        active: active.length,
        pending: readProposals(root).length,
        inbox: inboxSize(root),
        problems: problems.length,
        claims: {
          open: claims.open,
          openActionable: claims.openActionable,
          contradicted: claims.contradicted,
          unverified: claims.unverified,
          resolved: claims.resolved,
        },
        lifecycle: {
          dormant: life.dormant.length,
          reviewDue: life.reviewDue.length,
          expired: life.expired.length,
          suggestsDeprecation: life.suggestsDeprecation.length,
        },
        snapshot: snapshot
          ? {
              id: snapshot.snapshotId,
              compiledAt: snapshot.manifest?.createdAt ?? null,
              documents: Array.isArray(snapshot.documents) ? snapshot.documents.length : 0,
            }
          : null,
        quota: {
          used: active.length,
          limit: quota?.maxActive ?? cfgFor(root).quota?.repo ?? 200,
          mode: quota?.mode === 'ratchet' ? 'ratchet' : 'growth',
        },
      }
    },

    /**
     * 待决提案。**最新的在前** —— 默认 10 条的全部意义就是「昨天刚 defer 的那条」。
     * `readProposals` 按文件名升序（最旧在前），所以这里必须 reverse。
     */
    pending(root, limit) {
      const take = clampInt(limit, PENDING_LIMIT)
      const proposals = [...readProposals(root)].reverse()
      return {
        total: proposals.length,
        items: proposals.slice(0, take).map(toPendingProposal),
      }
    },

    /**
     * 记忆检索。`query` 为空串时退化成「最近的条目」—— 面板打开时列表不能是空的。
     *
     * 非空查询走**真实召回**（`recall.recall`），不是字符串包含：面板看到的
     * 排序必须和 Agent 看到的一致，否则「为什么这条排在后面」会有两个答案。
     * 召回会 `touchEntries` 记一次访问 —— 那正是「最后召回」这一列的数据源。
     */
    memories(root, query, limit, { now = Date.now() } = {}) {
      const take = clampInt(limit, MEMORIES_LIMIT)
      const text = typeof query === 'string' ? query.trim() : ''
      const stats = readStats(root)

      if (!text) {
        const { entries } = readAll(root)
        // `|| 0`：坏时间戳解析成 NaN 时，比较器返回 NaN 的排序是**实现定义**的
        // （V8 上等于保持原序，但不是规范）。归零让它退化成稳定排序，而不是
        // 「在这台机器上顺序不同」。
        const stamp = (entry) => Date.parse(entry.updatedAt ?? '') || 0
        return entries
          .map((entry) => toMemorySummary(entry, stats, now))
          .sort((left, right) => stamp(right) - stamp(left))
          .slice(0, take)
      }

      const { snapshot } = ensureSnapshot(root)
      if (!snapshot) return []
      const envelope = runRecall(text, snapshot, { limit: take, config: cfgFor(root), now: () => now })
      const ids = [
        ...envelope.results.map((result) => result.memoryId),
        ...envelope.pointers.map((pointer) => pointer.memoryId),
      ]
      const { entries } = readAll(root)
      const byId = new Map(entries.map((entry) => [entry.id, entry]))
      return [...new Set(ids)]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .slice(0, take)
        .map((entry) => toMemorySummary(entry, stats, now))
    },

    /**
     * 漂移三桶。**只返回有问题的条目** —— 健康的没有信息量，而面板是给人读的。
     *
     * `unsafePath` 单独成桶：它是「ref 逃出了仓库」，既不是「目标消失」
     * （quarantined）也不是「切片变了」（advisory）。混进任何一桶都是错误归因。
     */
    drift(root) {
      const active = activeEntries(readAll(root).entries)
      const report = driftReport(root, active)
      return {
        quarantined: report.quarantined.map((entry) => toDriftItem(entry, 'quarantined')),
        advisory: report.advisory.map((entry) => toDriftItem(entry, 'advisory')),
        unsafePath: report.unsafePath.map((entry) => toDriftItem(entry, 'unsafePath')),
        // `symbol-not-a-definition`（锚点落在注释 / 字符串 / 调用处）在类型契约里
        // **没有第四个桶**。它归 `quarantined`：锚点指错了，既不是「还健康」，
        // 也不是「重构导致切片变了」—— 归进 advisory 会把它当成噪音。
        // 但保留独立数组，界面可以单独点名（`memory_audit` 就是这么做的）。
        notADefinition: report.notADefinition.map((entry) => toDriftItem(entry, 'quarantined')),
        counts: {
          quarantined: report.quarantined.length,
          advisory: report.advisory.length,
          unsafePath: report.unsafePath.length,
          notADefinition: report.notADefinition.length,
        },
        checked: report.checked,
        unverifiable: report.unverifiable,
        at: report.at,
      }
    },

    /**
     * 断言对账。
     *
     * `total` = `open + resolved + unverified`。**`contradicted` 不在里面** ——
     * 矛盾的每一条同时是一条 open claim，加进去就是重复计数。界面上的
     * 「矛盾 N 条」是一个子集徽标，不是第四类。
     */
    claims(root) {
      const stats = claimStats(readAll(root).entries)
      return {
        open: stats.open,
        openActionable: stats.openActionable,
        contradicted: stats.contradicted,
        unverified: stats.unverified,
        resolved: stats.resolved,
        total: stats.open + stats.resolved + stats.unverified,
        sample: stats.sample,
        contradictions: stats.contradictions,
      }
    },

    /** 审计时间线（ledger 尾部）。只读。 */
    ledger(root, limit) {
      return readLedger(root, { limit: clampInt(limit, LEDGER_LIMIT) }).map(toLedgerEntry)
    },

    /**
     * 四层配置快照 + 每个字段的来源 / 可写性（界面 1 的数据源）。
     *
     * `describe` 已经把 `value` / `defaultValue` / `source` / `writable` /
     * `projectScoped` / `projectWritable` 算好了 —— 这里**只加路径与问题**，
     * 不再算第二遍。少算一遍就是少一处漂移。
     */
    config(root) {
      const described = configSource.describe(root)
      return {
        groups: described.groups,
        fields: described.fields,
        projectPath: configSource.projectPath(root),
        // 坏 JSON / 写错的键名必须显示出来 —— 静默降级是 0.1.0 最贵的债。
        problems: configSource.problems(root),
      }
    },

    /** 项目层配置（界面 3 的抽屉）。读的是原始文件，**不**经过合并。 */
    projectConfig(root) {
      const project = readProjectConfig(root)
      return {
        path: project.path,
        exists: project.exists,
        value: project.value,
        raw: project.raw,
        problems: project.problems,
        unknownKeys: project.unknownKeys,
      }
    },
  }
}
