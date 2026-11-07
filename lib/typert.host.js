/**
 * 宿主面的 Typert 清单（`package.json` 的 `exports["./typert"]`）。
 *
 * ## 这个文件是**手写**的，不是生成器产物
 *
 * `@deepseek-ai/dsh-typert-generator` 会把一个 `FaceModel` 编译成两份产物
 * （`typert.host.js` + `typert.remote-client.js`）。本仓库**没有构建步骤**，
 * 也没有装生成器，所以这两份是手写的。
 *
 * 手写能成立的前提是：清单的**校验**（`@deepseek-ai/dsh-typert-loader` 的
 * `validateTypertManifest`）只检查结构，不检查编译器指纹。逐条实测过：
 *
 * | 字段 | 校验 | 我们的值 |
 * |---|---|---|
 * | `package` | 必须等于包名 | `dsh-memory-bank` |
 * | `face` | 必须是 `'host'` | `'host'` |
 * | `schemas` | 数组，每项有 `name` + `create()` | `[]`（本包不贡献全局 schema） |
 * | `invocations` | 数组，每项过 `requireInvocation` | `[]` —— **见下** |
 * | `model.services/events/objects` | 数组 + 文档形状 | 见 `MODEL` |
 *
 * ## `invocations: []` 是**如实的**，不是偷懒
 *
 * 网关有两条派发路径（`dsh-api-gateway/lib/index.js`）：
 *
 *  1. **严格**：`ctx.typert.local.get(endpoint)`。描述符来自本清单的
 *     `invocations`，且 `codec.mode` 必须是 `'strict'`；网关的 `decode()`
 *     会对它调 `codec.create().parse(value)` —— 也就是说**必须是 zod schema**。
 *  2. **SRC 回退**：`resolveSrcDescriptor()`。它读服务的 `typertRemote` 绑定
 *     + 原型上的 `@Remote` 标记（`remoteMethods()`），参数只做 JSON 校验。
 *
 * 走严格路径要给本包加一条 `zod` 依赖，而 `package.json` 不在本次改动范围内；
 * 更关键的是，这个仓库的设计是「零构建、零 codegen」（`docs/07` §0 结论 4）。
 * 所以本包走 **SRC 回退**，清单如实声明「没有严格 invocations」。
 *
 * 代价说清楚：**参数没有 schema 校验**（只有 JSON 可序列化 + 字段名精确匹配，
 * 后者由网关的 `assertExactArguments` 做），**返回值也没有 schema 校验**。
 * 收益是零依赖，而且这条路是宿主官方支持的一等路径。
 *
 * 见 `lib/host/service.js` 文件头的完整调查报告。
 */

import { METHODS } from '../shared/endpoints.js'

/** 包名 —— 必须与 `package.json` 的 `name` 一字不差（loader 会比对）。 */
export const PACKAGE_NAME = 'dsh-memory-bank'

/** 每个线上方法的签名（给 `dsh-tool-cordis` 的 API 目录用，不参与派发）。 */
const SIGNATURES = Object.freeze({
  overview: '@Remote async overview(): Promise<Overview>',
  pending: '@Remote async pending(limit?: number): Promise<{ total: number, items: PendingProposal[] }>',
  memories: '@Remote async memories(query?: string, limit?: number): Promise<MemorySummary[]>',
  drift: '@Remote async drift(): Promise<{ quarantined: DriftItem[], advisory: DriftItem[], unsafePath: DriftItem[], counts: object }>',
  claims: '@Remote async claims(): Promise<ClaimStats>',
  ledger: '@Remote async ledger(limit?: number): Promise<LedgerEntry[]>',
  config: '@Remote async config(): Promise<ConfigSnapshot>',
  projectConfig: '@Remote async projectConfig(): Promise<{ path: string, exists: boolean, value: object, problems: string[] }>',
  accept: '@Remote async accept(id: string): Promise<MutationResult>',
  reject: '@Remote async reject(id: string, reason?: string): Promise<MutationResult>',
  edit: '@Remote async edit(id: string, patch: object): Promise<MutationResult>',
  retire: '@Remote async retire(id: string, reason?: string): Promise<MutationResult>',
  forget: '@Remote async forget(id: string, confirm: boolean): Promise<MutationResult>',
  dream: '@Remote async dream(): Promise<MutationResult>',
  promote: '@Remote async promote(options?: object): Promise<MutationResult>',
  setProjectConfig: '@Remote async setProjectConfig(patch: object): Promise<MutationResult>',
  resetProjectConfig: '@Remote async resetProjectConfig(): Promise<MutationResult>',
})

/**
 * 方法与签名的漂移检查。
 *
 * 少一条签名 = API 目录里少一个方法，而**没有任何东西会红** —— 这正是
 * `shared/endpoints.js` 文件头说的那类 bug（`gateQuota` 黑名单 vs
 * `activeEntries` 白名单）。所以在这里装一道路由期的断言：`METHODS` 里
 * 多一条、少一条都直接让模块加载失败。
 */
function members() {
  const missing = METHODS.filter((method) => typeof SIGNATURES[method] !== 'string')
  const extra = Object.keys(SIGNATURES).filter((method) => !METHODS.includes(method))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `typert: SIGNATURES 与 shared/endpoints.js 的 METHODS 不一致（缺 ${JSON.stringify(missing)}，多 ${JSON.stringify(extra)}）—— ` +
        '两边必须同位，否则 API 目录会描述一个不存在的方法',
    )
  }
  return METHODS.map((method) => ({
    kind: 'method',
    name: method,
    signature: SIGNATURES[method],
    summary: `memoryBank/${method}`,
  }))
}

/** 生成的产物里的 `model`：反射元数据，不参与派发。 */
const MODEL = Object.freeze({
  services: [
    {
      key: 'memoryBank',
      exportName: 'default',
      description: '记忆库的 RPC 面：只读查询（overview / pending / memories / drift / claims / ledger / config）与写操作（裁决、退休、删除、dream、推广、项目层配置）。',
      summary: 'Memory bank RPC face',
      tags: ['memory', 'settings', 'plugin'],
      jsDoc: '/**\n * 记忆库的 RPC 面。只做路由 —— 全部实现复用 `lib/store.js` / `lib/gate.js` / `lib/drift.js` / `lib/config/index.js`。\n */',
      members: members(),
      types: [],
    },
  ],
  events: [],
  objects: [],
})

/**
 * Typert 宿主面清单。
 *
 * `invocations` 为空是**有意的** —— 本包走 SRC 回退路径，理由见文件头。
 */
export const TYPERT = Object.freeze({
  package: PACKAGE_NAME,
  face: 'host',
  schemas: Object.freeze([]),
  invocations: Object.freeze([]),
  model: MODEL,
})

export default TYPERT
