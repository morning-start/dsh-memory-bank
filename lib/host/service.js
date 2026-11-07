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
 * 结论：`root` 必须是**构造期**确定的。本类按下面的优先级解析
 * （与 `lib/index.js` 的 `createResolver` 一致；那个函数没导出，所以这里
 * 有一份镜像 —— 这是本次改动里唯一一处刻意的重复，判据必须一字不差）：
 *
 * ```
 * 行 config.root（必须是绝对路径）
 *   > DSH_MEMORY_ROOT
 *   > 会话工作目录（需要 live Agent —— 由 lib/index.js 注入 resolveRoot 时才有）
 *   > process.cwd()
 * ```
 *
 * **接线提示（本次改动范围外）**：`lib/index.js` 的 `apply()` 应当
 * `ctx.inject(['typert'], (c) => c.effect(() => new MemoryBankService(c, config, {
 *   resolveRoot, configSource, log })))` —— 把它自己那份 `resolveRoot` /
 * `configSource` 传进来，这样面板和 `/memory status` 永远在同一个仓库上。
 * 不传也能跑，只是会话工作目录那一段会退化成 cwd。
 */

import { isAbsolute } from 'node:path'

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { METHODS, NAMESPACE } from '../../shared/endpoints.js'
import { createConfigSource, plainConfig } from '../config/index.js'

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
 * `root` 解析器（`lib/index.js` 的 `createResolver` 镜像）。
 *
 * 那个函数是私有的，而 `lib/index.js` 不在本次改动范围内。两处的**优先级
 * 必须一致**，否则「面板看到的库」和「`/memory status` 看到的库」会分叉 ——
 * 那正是 `lib/command.js` 文件头警告过的「两份世界」。
 *
 * @param {object} portable 可移植层配置（默认值 + 环境变量 + 行配置）
 * @param {(message: string) => void} log
 */
export function createRootResolver(portable, log = () => {}) {
  let warned = false
  return function resolveRoot(agent) {
    if (portable?.root) {
      if (!isAbsolute(portable.root)) throw new Error(`memory-bank: root 必须是绝对路径，收到「${portable.root}」`)
      return portable.root
    }
    if (process.env.DSH_MEMORY_ROOT) return process.env.DSH_MEMORY_ROOT
    try {
      const service = agent?.ctx?.workingDirectory
      const session = agent?.session
      if (service && session) {
        const directory = service.get(session)
        if (typeof directory === 'string' && directory) return directory
      }
    } catch (error) {
      if (!warned) {
        warned = true
        log(`会话工作目录不可用，回退到进程 cwd：${error?.message ?? error}`)
      }
    }
    return process.cwd()
  }
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
    this.resolveRoot = options.resolveRoot ?? createRootResolver(configSource.portable(), log)

    installRemoteMarkers(this)
  }

  /** 本次调用落在哪个仓库。见文件头「service 怎么知道调用方在哪个仓库」。 */
  root() {
    return this.resolveRoot()
  }

  /* ── 只读 ─────────────────────────────────────────────────────── */

  async overview() {
    return this.queries.overview(this.root())
  }

  async pending(limit) {
    return this.queries.pending(this.root(), limit)
  }

  async memories(query, limit) {
    return this.queries.memories(this.root(), query, limit)
  }

  async drift() {
    return this.queries.drift(this.root())
  }

  async claims() {
    return this.queries.claims(this.root())
  }

  async ledger(limit) {
    return this.queries.ledger(this.root(), limit)
  }

  async config() {
    return this.queries.config(this.root())
  }

  async projectConfig() {
    return this.queries.projectConfig(this.root())
  }

  /* ── 写（全部走 mutations.js，与 `/memory` 命令同一个实现） ────── */

  async accept(id) {
    return this.mutations.accept(this.root(), id)
  }

  async reject(id, reason) {
    return this.mutations.reject(this.root(), id, reason)
  }

  async edit(id, patch) {
    return this.mutations.edit(this.root(), id, patch)
  }

  async retire(id, reason) {
    return this.mutations.retire(this.root(), id, reason)
  }

  async forget(id, confirm) {
    return this.mutations.forget(this.root(), id, confirm)
  }

  async dream() {
    return this.mutations.dream(this.root())
  }

  async promote(options) {
    return this.mutations.promote(this.root(), options ?? {})
  }

  async setProjectConfig(patch) {
    return this.mutations.setProjectConfig(this.root(), patch)
  }

  async resetProjectConfig() {
    return this.mutations.resetProjectConfig(this.root())
  }
}

export default MemoryBankService
