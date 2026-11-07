/**
 * host / client 的 RPC 类型契约。
 *
 * 运行时零开销（`shared/` 里只有 `.js` 会被 import，`.d.ts` 只给 IDE 用）。
 * 客户端拿不到这个文件 —— 它证明的是「宿主返回的形状」，不是「客户端能 import 的东西」。
 *
 * 唯一的用途：写 `lib/host/queries.js` 时知道每个方法该返回什么，
 * 以及**哪些字段是界面必须画出来的**（`source` / `writable` 不是可选的）。
 */

/** 配置字段的值实际来自哪一层。界面上的来源徽标直接用它。 */
export type ConfigOverlay = 'default' | 'project' | 'env' | 'row'

/**
 * 一条字段的「现值 + 从哪来 + 能不能改」。
 *
 * 这不是锦上添花：0.1.1 修的三个配置缺陷（环境变量全死、默认值遮蔽、
 * `config.json` 不读）本质都是**作用域不可见**。少了 `source`，
 * 用户会以为「改了没反应」是 bug。
 */
export interface ConfigField {
  /** 点分路径，如 `thresholds.content.natural`。 */
  readonly path: string
  /** 分组 id（`autonomy` / `thresholds` / `capture` / `recall` / `quota` / `advanced`）。 */
  readonly group: string
  /** schemastery 的类型：`string` / `number` / `boolean` / `array` / `union` / `object`。 */
  readonly type: string
  /** 枚举字段的全部取值（`union` of `const`）。 */
  readonly enum?: readonly unknown[]
  /** 数组元素的类型（`array` 才有）。 */
  readonly itemType?: string
  readonly min?: number
  readonly max?: number
  readonly step?: number
  /** 复用 `Config` 里已经写好的中文说明。 */
  readonly description: string
  /** 当前归一化后的值。 */
  readonly value: unknown
  /** 内置默认值（界面显示「默认 0.60」）。 */
  readonly defaultValue: unknown
  readonly source: ConfigOverlay
  /** `false` = 从环境变量来，改这里不生效。输入框必须 disabled。 */
  readonly writable: boolean
  /** 属于仓库属性（界面 3 的抽屉），不是用户偏好。 */
  readonly projectScoped: boolean
  /** 可以写进项目层（`env` / `row` 层盖住的字段不行）。 */
  readonly projectWritable: boolean
  readonly hidden?: boolean
}

export interface ConfigGroup {
  readonly id: string
  readonly label: { readonly zh: string; readonly en: string }
  readonly description: { readonly zh: string; readonly en: string }
  readonly keys: readonly string[]
}

/** `memoryBank/config` 的返回值。界面 1 的全部数据。 */
export interface ConfigSnapshot {
  readonly groups: readonly ConfigGroup[]
  readonly fields: readonly ConfigField[]
  /** 项目配置文件的绝对路径（界面 3 要显示它）。 */
  readonly projectPath: string
  /** 项目层的读取问题（坏 JSON、写错的键名）。**界面必须显示它。** */
  readonly problems: readonly string[]
}

/** 健康概览 —— 界面 2 的顶部一行。 */
export interface Overview {
  readonly root: string
  readonly active: number
  readonly pending: number
  readonly inbox: number
  readonly problems: number
  readonly claims: {
    readonly open: number
    readonly openActionable: number
    readonly contradicted: number
    readonly unverified: number
    readonly resolved: number
  }
  readonly lifecycle: {
    readonly dormant: number
    readonly reviewDue: number
    readonly expired: number
    readonly suggestsDeprecation: number
  }
  readonly snapshot: { readonly id: string; readonly compiledAt: string; readonly documents: number } | null
  readonly quota: { readonly used: number; readonly limit: number; readonly mode: 'growth' | 'ratchet' }
}

/** 待决提案。`gates` 是**没过的那几道**，界面据此写「改哪里」。 */
export interface PendingProposal {
  readonly id: string
  readonly kind: 'candidate' | 'merge' | 'edge' | 'cluster' | 'core'
  readonly title: string
  readonly confidence: string | null
  readonly actionRisk: string | null
  /** 判不了的门 id 列表（`G1`…`G8`）。 */
  readonly gates: readonly string[]
  readonly why: readonly string[]
  readonly createdAt: string | null
}

/** 记忆条目（列表用，正文不进列表）。 */
export interface MemorySummary {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly status: 'active' | 'dormant' | 'expired' | 'retired'
  readonly confidence: string | null
  readonly updatedAt: string | null
  readonly accessCount: number
  /** 最后召回时间；从没被召回是 `null`。 */
  readonly lastRecalledAt: string | null
}

export type DriftBucket = 'quarantined' | 'advisory' | 'unsafePath'

export interface DriftItem {
  readonly id: string
  readonly bucket: DriftBucket
  readonly code: string
  readonly detail: string
  readonly anchors: readonly string[]
}

export interface ClaimStats {
  readonly open: number
  readonly openActionable: number
  readonly contradicted: number
  readonly unverified: number
  readonly resolved: number
  readonly total: number
}

/** 审计时间线上的一条。只读。 */
export interface LedgerEntry {
  readonly at: string
  readonly kind: 'attempt' | 'resolve' | 'dream-accept' | 'discard'
  readonly id: string | null
  readonly proposalId: string | null
  readonly decision: string | null
  readonly gate: string | null
  readonly code: string | null
  readonly confidence: number | null
}

/**
 * 所有写操作的统一返回。
 *
 * `ok: false` 时 `error` 是**给人看的**一句话（命令面直接回显它）；
 * `code` 给界面判断要不要弹二次确认。
 */
export type MutationResult<T = unknown> =
  | { readonly ok: true; readonly value: T; readonly text: string }
  | { readonly ok: false; readonly error: string; readonly code?: string }

/** 客户端调用的返回信封（`connection.rpc.call` 的 `full.result`）。 */
export type RpcEnvelope<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
