/**
 * 面板服务（RPC 面）—— **只做注册与路由，不写业务**。
 *
 * ```
 * 客户端  ctx.remote.memoryBank.overview()
 *            │
 *            ▼  RPC endpoint `memoryBank/overview`
 * 服务端  MemoryBankService.overview()  ──▶  queries.js / mutations.js
 * ```
 *
 * ## `@Remote` 是装饰器 —— 这个仓库没有构建步骤，怎么办
 *
 * **实测结论（`@deepseek-ai/dsh-typert-protocol@0.2.1-rc.3`）：装饰器只是元数据。**
 *
 * `Remote` 的运行时效果只有一句：`addMarkerInitializer(context, { kind: 'direct' })`
 * （`lib/index.js:363-371`）。它把初始化器挂到 stage-3 装饰器上下文上；那个
 * 初始化器在**实例构造时**执行 `mark(prototype, method, invocation, options)`，
 * 而 `mark`（`lib/index.js:449-470`）做的事就是：
 *
 * ```js
 * Object.defineProperty(prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
 *   configurable: true,
 *   value: Object.freeze({ version: 1, methods: Object.freeze([...markers]) }),
 * })
 * ```
 *
 * **没有任何协议状态、没有 codegen、没有符号表。** 唯一读它的是公开导出的
 * `remoteMethods(service)`（`lib/index.js:424-428`）—— 也就是宿主的 SRC
 * 派发路径（`dsh-api-gateway` 的 `resolveSrcDescriptor` / `collectSrcClaims`）。
 *
 * **所以本仓库的做法是：直接调用公开导出的 `Remote`，喂一个人造的
 * stage-3 装饰器上下文，让它在构造时立刻把初始化器跑在 `this` 上。**
 * 这不是「绕过协议」—— 走的正是 `__esDecorate` 在编译产物里走的那条路
 * （`dsh-client-ui-plugin-manager/lib/index.js:1-43` 的 `_fastest_decorators`
 * + `__esDecorate(..., { kind: "method", name: "fastest", static: false,
 * private: false, ... }, null, _instanceExtraInitializers)`）。
 * 用 `Remote` 而不是自己 `Object.defineProperty`，是为了**描述符格式变化时
 * 跟着变**（版本号、`configurable`、去重规则都在 `mark` 里）。
 *
 * ### 为什么不用「严格描述符」（TYPERT manifest 里的 invocations）
 *
 * 严格派发要求 `codec.mode === 'strict'`，而网关的 `decode()` 会调
 * `codec.create().parse(value)`（`dsh-api-gateway/lib/index.js:1775-1790`）——
 * 也就是说**必须是 zod schema**。zod 不是本插件的依赖，`package.json` 也不在
 * 本次改动范围内。生成器（`@deepseek-ai/dsh-typert-generator`）能产出它，
 * 但这个仓库没有构建步骤、也没有装生成器。
 *
 * 所以：**走 SRC 回退路径**（`result: { mode: 'src-json' }`）。它的代价是
 * 参数只做 JSON 可序列化校验、不做 schema 校验；收益是**零依赖、零构建**，
 * 而且这条路是宿主官方支持的一等路径（`resolveSrcDescriptor` 就在网关里）。
 * `lib/typert.host.js` 因此如实声明 `invocations: []` —— 见那个文件。
 *
 * ## service 怎么知道「调用方在哪个仓库」
 *
 * **它不知道，而且拿不到。** 这是实测的：
 *
 *  - 网关为每次调用构造 `receiverContext`：`invocation.kind === 'direct'` 时
 *    就是 `this.ctx`（网关自己的 root），**不是**调用方的 session（`dsh-api-gateway`
 *    `prepareInvocation` → `resolveReceiverContext`）。服务实例上的 `ctx` 是
 *    插件自己的 fiber，拿不到 live Agent。
 *  - 真正的「按调用方投影」机制是 `RemoteScope('workspace')` + 宿主注册的
 *    Context provider（`ctx.typert.contexts.registerHost('workspace', ...)`）——
 *    那是**宿主级**集成，第三方插件注册不了（`contexts.getHost` 由宿主填充）。
 *    没有 provider 时 `resolveReceiverContext` 直接抛 `gateway/context-unavailable`。
 *
 * 结论：`root` 必须是**构造期**确定的，判据只有一份 —— `lib/root.js`。
 * 本类**不再自带镜像**（0.2.0 那份镜像和 `lib/index.js` 漂了，见下）。
 *
 * ### 0.2.0 的两个根目录缺陷（本文件 + `lib/index.js`）
 *
 * 1. 两边都读 `agent?.ctx?.workingDirectory` —— 那不是宿主的形状。宿主
 *    （`@deepseek-ai/dsh-working-directory@0.2.1-rc.3`）把服务挂在**插件自己的
 *    ctx** 上，且 cordis 对没 `inject` 的服务直接抛
 *    （`@deepseek-ai/cordis/lib/index.js:676`）；`get()` 收的也是 **Session**。
 *    于是每次必抛 → 被 `catch` 吞掉 → **静默**落到 `process.cwd()`
 *    （= DSH profile 目录）。后果：`memory_remember` 的每条文件锚点都过不了
 *    G4，记忆还会写进 profile。**这是「两份世界」的第二次复发。**
 * 2. `root()` 调 `this.resolveRoot()` **不传 agent**，所以即使注入了带会话
 *    分支的解析器，那一段也恒不命中。
 *
 * 修法：整条解析逻辑收到 `lib/root.js`（单一实现），`lib/index.js` 用
 * `ctx.inject(['workingDirectory'])` 把宿主服务交给它；面板面没有 live Agent，
 * 就复用「最近一次会话解析结果」，而不是编一个 `process.cwd()` 出来。
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { METHODS, NAMESPACE } from '../../shared/endpoints.js'
import { createConfigSource, plainConfig } from '../config/index.js'
import { createRootResolver } from '../root.js'

import { sharedGuards } from './guards.js'
import { createMutations } from './mutations.js'
import { createQueries } from './queries.js'

/**
 * 把线上方法名当成 `@Remote` 元数据装到原型上。
 *
 * 见文件头「`@Remote` 是装饰器」一节。`addInitializer` 是 stage-3 装饰器
 * 协议里「这段元数据要在实例构造时生效」的唯一入口 —— 这里同步调用它，
 * 于是 `mark()` 立刻把描述符写到 `Object.getPrototypeOf(service)` 上。
 *
 * 幂等：`mark` 遇到同一个方法上**完全相同**的 invocation 会直接返回
 * （`lib/index.js:458-462`），所以第二次构造实例、第二次调用本函数都安全。
 *
 * @template {object} T
 * @param {T} service 服务实例
 * @param {readonly string[]} [methods] 默认是 `shared/endpoints.js` 的全部方法
 * @returns {T} 同一个实例
 */
export function installRemoteMarkers(service, methods = METHODS) {
  for (const method of methods) {
    Remote(undefined, {
      kind: 'method',
      name: method,
      static: false,
      private: false,
      addInitializer(initializer) {
        // 等价于 `__esDecorate` 在类定义结束后统一跑 `_instanceExtraInitializers`，
        // 只是我们把时机挪到了「手里已经有实例」的此刻。
        initializer.call(service)
      },
    })
  }
  return service
}

/**
 * 面板服务。
 *
 * 命名空间是 `memoryBank`（`shared/endpoints.js` 的 `NAMESPACE`）——
 * 改它等于换一份协议：`super(ctx, 'memoryBank')` + `async overview()` 得到
 * 线上方法 `memoryBank/overview`，客户端经 `ctx.remote.memoryBank.overview()` 调用。
 */
export class MemoryBankService extends TypertRemoteService {
  /**
   * @param {any} ctx Cordis 上下文
   * @param {object} [config] 行配置（`cordis.patch.yml` 里那一行）
   * @param {{
   *   resolveRoot?: (agent?: unknown) => string,
   *   configSource?: object,
   *   guards?: object,
   *   log?: (message: string) => void,
   * }} [options] 接线注入。生产上由 `lib/index.js` 传入它自己那份
   *   `resolveRoot` / `configSource` —— 这样面板和命令面共用一份缓存和一份锁。
   */
  constructor(ctx, config = {}, options = {}) {
    super(ctx, NAMESPACE)

    /**
     * `sessionId` → Agent。
     *
     * **不在这里碰 `ctx.agents`**：cordis 的 Service 访问需要 `inject`
     * 声明，没声明就抛（`lib/root.js` 文件头记着这条）。所以由
     * `lib/index.js` 用 `ctx.inject(['agents'], ...)` 拿到服务，再把一个
     * 纯函数传进来 —— 这一层只管「拿不到就 `undefined`」。
     *
     * 默认是「永远拿不到」：测试和 headless 组合里没有 `agents` 时，
     * 面板退回 `memo` / fallback，界面据此画来源徽标。
     *
     * @type {(sessionId?: string) => unknown}
     */
    this.agentOf = options.agentOf ?? (() => undefined)

    // **第一件事必须是拆 `Volatile`。** schema 的顶层分组都标了 `.volatile()`
    // （见 `config/schema.js` 文件头），宿主交进来的是引用对象。不拆的话
    // `deepMerge` 会把引用当普通对象遍历 —— 结果是空对象，全部字段静默丢成默认值。
    const rowConfig = plainConfig(config ?? {})
    const log = options.log ?? (() => {})
    const configSource = options.configSource ?? createConfigSource({ rowConfig })
    const guards = options.guards ?? sharedGuards

    this.configSource = configSource
    this.guards = guards
    this.queries = createQueries({ configSource })
    // `by: 'panel'` 只影响回执 / ledger 里的「谁裁的」这一列 ——
    // 裁决逻辑本身与命令面**同一个函数**（这是 docs/07 阶段 B 的硬约束）。
    this.mutations = createMutations({ configSource, guards, log, by: 'panel' })
    // 生产上由 `lib/index.js` 传它自己那份（带 `workingDirectory` 服务 +
    // 会话目录 memo）；**只有测试 / 裸构造**才走这个兜底 —— 它没有 live Agent，
    // 解析不到会话目录时会**抛** `RootUnresolvedError`，而不是编一个 cwd 出来。
    const fallbackResolver = createRootResolver({ rowConfig: configSource.portable(), log })
    const fallbackResolve = (agent) => fallbackResolver.resolve(agent)
    fallbackResolve.source = () => fallbackResolver.source
    this.resolveRoot = options.resolveRoot ?? fallbackResolve

    installRemoteMarkers(this)
  }

  /**
   * 本次调用落在哪个仓库。
   *
   * ## 为什么面板要自报 `sessionId`
   *
   * 面板是 `conversation.view`，scope 是 `session` —— 它显示的**必须**是当前
   * 会话所在仓库。但 RPC 面上没有 live Agent，只有 `lib/root.js` 的 `memo`
   * 可以兜底，而 `memo` 是**插件实例级**的：切到别的会话之后它还是上一个
   * 仓库，于是「换个仓库看记忆」要刷新一次才对。
   *
   * 客户端把 `sessionId` 一起传上来，这里用 `ctx.agents.get(sessionId)` 换回
   * Agent，再走**同一条** `resolveRoot(agent)` —— 和工具面、命令面完全一致。
   * 客户端只报「我是谁」，目录由宿主解析。
   *
   * @param {string} [sessionId] 调用方所在会话（面板面必传；命令面 / 工具面
   *   另有 live Agent，不需要）
   */
  root(sessionId) {
    return this.resolveRoot(this.agentOf(sessionId))
  }

  /**
   * 这个根是**怎么来的**：`config` / `env` / `session` / `header` / `memo` / `fallback`。
   *
   * 面板必须把它画出来。`fallback` 意味着「没有 live Agent，读的是进程 cwd」——
   * 那个目录里当然一条记忆都没有，界面显示 0 会被读成「这个仓库没有记忆」，
   * 而不是「读错了地方」。这正是它以前一直显示 0 却查不出来的原因。
   */
  rootSource() {
    const resolver = this.resolveRoot
    return typeof resolver?.source === 'function' ? resolver.source() : null
  }

  /* ── 只读 ─────────────────────────────────────────────────────── */

  async overview(sessionId) {
    const root = this.root(sessionId)
    return { ...this.queries.overview(root), rootSource: this.rootSource() }
  }

  async pending(limit, sessionId) {
    return this.queries.pending(this.root(sessionId), limit)
  }

  async memories(query, limit, sessionId) {
    return this.queries.memories(this.root(sessionId), query, limit)
  }

  async drift(sessionId) {
    return this.queries.drift(this.root(sessionId))
  }

  async claims(sessionId) {
    return this.queries.claims(this.root(sessionId))
  }

  async ledger(limit, sessionId) {
    return this.queries.ledger(this.root(sessionId), limit)
  }

  async config(sessionId) {
    return this.queries.config(this.root(sessionId))
  }

  async projectConfig(sessionId) {
    return this.queries.projectConfig(this.root(sessionId))
  }

  /* ── 写（全部走 mutations.js，与 `/memory` 命令同一个实现） ────── */

  async accept(id, sessionId) {
    return this.mutations.accept(this.root(sessionId), id)
  }

  async reject(id, reason, sessionId) {
    return this.mutations.reject(this.root(sessionId), id, reason)
  }

  async edit(id, patch, sessionId) {
    return this.mutations.edit(this.root(sessionId), id, patch)
  }

  async retire(id, reason, sessionId) {
    return this.mutations.retire(this.root(sessionId), id, reason)
  }

  async forget(id, confirm, sessionId) {
    return this.mutations.forget(this.root(sessionId), id, confirm)
  }

  async dream(sessionId) {
    return this.mutations.dream(this.root(sessionId))
  }

  async promote(options, sessionId) {
    return this.mutations.promote(this.root(sessionId), options ?? {})
  }

  async setProjectConfig(patch, sessionId) {
    return this.mutations.setProjectConfig(this.root(sessionId), patch)
  }

  async resetProjectConfig(sessionId) {
    return this.mutations.resetProjectConfig(this.root(sessionId))
  }
}

export default MemoryBankService
