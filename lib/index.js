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
 *   hooks.js       召回注入（systemPrompt.context）+ 捕获（agent/turn-stopping）
 *   host/          面板服务（RPC 面）—— 只做路由与守卫，复用上面全部实现
 *
 * 生命周期：`ctx.tools.register` / `ctx.on` / `ctx.systemPrompt.context` 的 disposer
 * 都是 fiber-scoped，插件卸载自动清理。本行没有额外资源，不需要手动 teardown。
 */

import { isAbsolute } from 'node:path'

import { createConfigSource, plainConfig } from './config/index.js'
import { createMemoryCommand } from './command.js'
import { createHooks } from './hooks.js'
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

/**
 * 解析记忆库根目录。
 *
 * 优先级：行 config > 环境变量 > 会话工作目录 > 进程 cwd。
 * 会话工作目录是**正确答案**（记忆是仓库级制品），但它需要 live Agent；
 * 拿不到时回退，并且不让回退静默 —— apply 时会打出最终解析到的路径。
 */
function createResolver(cfg, log) {
  let warned = false
  return function resolveRoot(agent) {
    if (cfg.root) {
      if (!isAbsolute(cfg.root)) throw new Error(`memory-bank: root 必须是绝对路径，收到「${cfg.root}」`)
      return cfg.root
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

  const resolveRoot = createResolver(portable, log)

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

  // 面板服务（RPC 面）：**可选**服务。没有 typert 的 profile 照常跑工具面。
  // 服务类在 lib/host/service.js，注册细节见 docs/07 阶段 B。

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
