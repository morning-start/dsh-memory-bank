/**
 * dsh-memory-bank —— 插件行（host 平面）。
 *
 * 分层（行入口只做接线）：
 *   config/        四层配置（默认 → 项目 → 环境 → 行）+ 项目层读写 + 热重载
 *   util.js        哈希、稳定序列化、原子写、分词、相似度（无依赖、可单测）
 *   model.js       MemoryEntry / TrustReceipt 类型 + 校验 + frontmatter 序列化
 *   store.js       目录布局、条目读写、审计日志、待决提案
 *   index-build.js 内容寻址快照编译（确定性、可回滚）
 *   gate.js        MRP v1 十道门 + 三值裁决
 *   capture.js     S1–S7 确定性捕获信号 + 候选构造
 *   recall.js      5 路召回 + RRF + 双相关性门 + 三级交付 + 渲染
 *   tools.js      7 个 memory_* 工具
 *   guard.js      写入口收口（`tools/pre-execute` 拦对 `.dsh-memory/` 的直写）
 *   hooks.js       召回注入（systemPrompt.context）+ 捕获（agent/turn-stopping）
 *   host/          面板服务（RPC 面）—— 只做路由与守卫，复用上面全部实现
 *
 * 生命周期：`ctx.tools.register` / `ctx.on` / `ctx.systemPrompt.context` 的 disposer
 * 都是 fiber-scoped，插件卸载自动清理。本行没有额外资源，不需要手动 teardown。
 */

import { createConfigSource, plainConfig } from './config/index.js'
import { createMemoryCommand } from './command.js'
import { installWriteGuard } from './guard.js'
import { createHooks } from './hooks.js'
import { createRootResolver } from './root.js'
import { createToolDefinitions } from './tools.js'
import { ensureLayout, onLedgerError } from './store.js'

/** Loader 行名，与 cordis.patch.yml 的 name 对应。 */
export const name = 'memory-bank'

/** 依赖的服务。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 行配置：宿主在激活时校验显式配置。
 *
 * **故意的两个「没有」**：
 *
 * 1. 不在 schema 里 `.default()` —— schema 填出的默认值与「用户显式配置」
 *    无法区分，会在 `resolveConfig` 里永久遮蔽环境变量回退。
 * 2. 不在这里写字段 —— 字段的**单一事实源**是 `config/schema.js`。
 *    这个仓库曾经因为「schema 有 10 个键、`defaultConfig()` 有 11 个」
 *    丢过 `thresholds.content`，而且不会有任何提示。
 */
export { Config } from './config/schema.js'

export function apply(ctx, config) {
  // **第一件事必须是拆 `Volatile`。** schema 的顶层分组都标了 `.volatile()`
  // （见 config/schema.js 文件头），宿主交给我们的 `config` 里它们是引用对象。
  // 不拆的话 `deepMerge` 会把引用当普通对象遍历 —— 结果是空对象，全部字段
  // 静默丢成默认值，而且没有任何报错。
  const rowConfig = plainConfig(config ?? {})

  const log = (message) => {
    try {
      ctx.logger?.warn?.(`memory-bank: ${message}`)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  /**
   * 配置源。**热重载的唯一入口** —— 所有消费者拿 `configSource.get(root)`，
   * 不再持有 apply() 的闭包快照。项目层按 `mtime:size` 失效，所以外部
   * 编辑器改了 `.dsh-memory/config.json` 也能看见。
   */
  const configSource = createConfigSource({ rowConfig })
  const portable = configSource.portable()

  /**
   * 根目录解析器。**工具面 / 命令面 / 面板面 / 钩子面共享同一个实例** ——
   * 「最近一次会话目录」这个面板兜底必须是同一份，否则面板和工具又变成
   * 两份世界。
   *
   * ## 为什么必须 `ctx.inject(['workingDirectory'])`
   *
   * 宿主的 `workingDirectory` 服务**挂在插件自己的 ctx 上**，而且 cordis 对
   * 没在 `inject` 里声明的服务直接抛 `cannot get property ... without inject`
   * （`@deepseek-ai/cordis/lib/index.js:676`）。0.2.0 读的是
   * `agent?.ctx?.workingDirectory` —— 那条路每次必抛，被 `catch` 吞掉后
   * **静默**回退到 `process.cwd()`（= DSH profile 目录），于是
   * `memory_remember` 的每条文件锚点都过不了 G4，记忆还会写进 profile。
   *
   * **可选**注入：headless / sdk 的 profile 里没有这个服务，那时保留
   * `session.header.cwd` 这条路，不让一个人机入口把工具面拖死。
   */
  const rootResolver = createRootResolver({ rowConfig: portable, log })
  ctx.inject(['workingDirectory'], (directoryCtx) => {
    directoryCtx.effect(() => {
      rootResolver.useWorkingDirectory(directoryCtx.workingDirectory)
      return () => rootResolver.useWorkingDirectory(null)
    })
  })

  /** 七个工具 / 命令 / 钩子 / 面板都走它 —— 单一是刻意的。 */
  const resolveRoot = (agent) => rootResolver.resolve(agent)
  // 面板要画「这个根是怎么来的」徽标。把来源一并挂出去，而不是让界面
  // 再猜一次 —— 猜错的版本会把 fallback 画成 session（见 lib/root.js 文件头）。
  resolveRoot.source = () => rootResolver.source

  // 工具：先注册，保证 memory_* 在任何一步都可用
  const definitions = createToolDefinitions({ resolveRoot, configSource, log })
  for (const definition of definitions) {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: TEXT_OUT,
      execute: async (args, exec) => {
        try {
          return { text: await definition.run(args ?? {}, exec) }
        } catch (error) {
          // 领域错误直接抛：宿主 registry 会转成 isError 结构化的 tool result。
          // 不返回「看起来成功」的 {text} 来装错误。
          throw error
        }
      },
    })
  }

  // 写入口收口：`tools/pre-execute` 拦对 `.dsh-memory/` 的**直接写入**。
  //
  // 为什么必须在工具注册之后、钩子之前：它和七个工具是**同一条不变量**的两半 ——
  // 工具保证「经协议写入有一条唯一路径」，守卫保证「没有第二条」。少了守卫，
  // 前半句就是假的（模型可以 `write` 一个 `.dsh-memory/memories/x.md`
  // 绕过全部门、没有回执、不走 ledger、索引不知道）。
  //
  // `ask` 而不是 `deny`：用户应该能手工修一条记忆。见 `lib/guard.js` 文件头。
  ctx.effect(() => installWriteGuard(ctx, { resolveRoot, log }))

  // 钩子：召回注入 + 捕获
  //
  // `userQuestions` 是**可选**服务。balanced 自主度的第三条出口是「连续 3 次
  // DEFER 当场问一次」，而 headless / sdk 的 profile 里没有这个出口 ——
  // 拿不到就降级为日志，不能让整个插件因为一个人机入口变成不可用。
  let ask = null
  ctx.inject(['userQuestions'], (questionCtx) => {
    questionCtx.effect(() => {
      ask = (question) => questionCtx.userQuestions?.ask?.(question)
      return () => {
        ask = null
      }
    })
  })
  const hooks = createHooks({ ctx, configSource, resolveRoot, log, ask: (question) => ask?.(question) })
  ctx.effect(() => hooks.install())

  // ledger 写失败必须可见（设计第 7 条：静默失败比不记忆更糟）
  onLedgerError((message) => log(message))

  // 斜杠命令：**可选**服务。没有命令运行时的 profile（headless / sdk）照常加载工具面，
  // 不用为了一个人机入口把整个插件变成不可用。
  ctx.inject(['commands'], (commandCtx) => {
    const command = createMemoryCommand({ resolveRoot, configSource, log })
    commandCtx.effect(() => commandCtx.commands.register(command))
  })

  // 面板服务（RPC 面）。
  //
  // **不 `inject(['typert'], ...)`** —— 实测 `TypertRemoteService` 的基类只做两件事：
  // `super(ctx, serviceKey)` 把服务注册到 Cordis，`bindTypertRemote()` 在原型上留
  // 一个 `{ service, serviceKey, namespace }` 绑定（`dsh-typert-protocol/lib/index.js:326-351`）。
  // 网关是按**源码模式扫描**发现它的，不依赖任何 `typert` 服务 —— 所以构造出来就够了。
  //
  // ## 为什么是 `import()` 而不是顶部的静态 import
  //
  // 静态 import 会让整个插件**加载期**就失败，而失败的是**一个人机入口**。
  // `@deepseek-ai/dsh-typert-protocol` 与 `@deepseek-ai/cordis` 是**随 dsh 发布**的
  // 包 —— 但本机实测：`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/` 下
  // **只有 schemastery**，没有这两个。也就是说它们能不能从 profile 目录解析出来，
  // 取决于宿主是不是自己注入了 resolver，**这一点无法在仓库里证明**。
  //
  // 一个「面板没出来」绝不该等于「工具全没了」。所以：动态 import + 兜住，
  // 失败就降级成只有工具面 —— 但**不静默**，打出原因。
  //
  // 判据 `ctx.reflect.provide` 同理：cordis 的 `Service` 构造函数里唯一的外部依赖
  // 就是它（`cordis/lib/index.js:1770-1780`）。headless / sdk 的 profile、以及
  // 测试里的假上下文都没有 `ctx.reflect` —— 那些地方面板面不存在是正常的。
  //
  // 传进去的 `resolveRoot` / `configSource` 是**插件自己那一份**：面板和
  // `/memory status` 必须永远落在同一个仓库、同一份配置缓存上。各建一份就是
  // `lib/command.js` 文件头警告过的「两份世界」。
  ctx.effect(() => {
    let disposed = false
    // **惰性 import，不用顶层静态 import。**
    //
    // `@deepseek-ai/dsh-typert-protocol` 是**随 dsh 发布**的包，本机实测
    // `~/.dsh/profiles/*/node_modules/@deepseek-ai/` 下**没有它**（只有
    // schemastery）。静态 import 失败 = 整个插件加载失败 = 7 个工具一起没了 ——
    // 为了一个人机入口。所以失败降级成「只有工具面」，并且**不静默**。
    import('./host/service.js')
      .then(({ MemoryBankService }) => {
        if (disposed) return
        if (typeof ctx?.reflect?.provide !== 'function') {
          log('面板服务未挂载：当前上下文没有 ctx.reflect.provide（不是 Cordis Context，面板面不存在）')
          return
        }
        new MemoryBankService(ctx, rowConfig, { resolveRoot, configSource, log })
      })
      .catch((error) => {
        log(`面板服务未挂载：${error?.message ?? error}`)
      })
    return () => {
      disposed = true
    }
  }, 'memory-bank: panel service')

  log(
    `mounted ${definitions.length} tools (autonomy=${portable.autonomy}, autoAccept=${portable.thresholds.autoAcceptFloor}, ` +
      `quota=${portable.quota.repo}, capture=${portable.capture.enabled ? 'on' : 'off'})`,
  )
}

/** 所有工具统一 `{ text }` 输出。 */
const TEXT_OUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export { ensureLayout }
