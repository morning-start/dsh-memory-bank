/**
 * dsh-memory-bank —— 插件行（host 平面）。
 *
 * 分层（行入口只做接线）：
 *   config.js      默认值、行 config > 环境变量 > 默认值 的解析与 fail-fast 校验
 *   util.js        哈希、稳定序列化、原子写、分词、相似度（无依赖、可单测）
 *   model.js       MemoryEntry / TrustReceipt 类型 + 校验 + frontmatter 序列化
 *   store.js       目录布局、条目读写、审计日志、待决提案
 *   index-build.js 内容寻址快照编译（确定性、可回滚）
 *   gate.js        MRP v1 十道门 + 三值裁决
 *   capture.js     S1–S7 确定性捕获信号 + 候选构造
 *   recall.js      5 路召回 + RRF + 双相关性门 + 三级交付 + 渲染
 *   tools.js       6 个 memory_* 工具
 *   hooks.js       召回注入（systemPrompt.context）+ 捕获（agent/turn-stopping）
 *
 * 生命周期：`ctx.tools.register` / `ctx.on` / `ctx.systemPrompt.context` 的 disposer
 * 都是 fiber-scoped，插件卸载自动清理。本行没有额外资源，不需要手动 teardown。
 */

import { isAbsolute } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { resolveConfig } from './config.js'
import { createMemoryCommand } from './command.js'
import { createHooks } from './hooks.js'
import { createToolDefinitions } from './tools.js'
import { ensureLayout } from './store.js'

/** Loader 行名，与 cordis.patch.yml 的 name 对应。 */
export const name = 'memory-bank'

/** 依赖的服务。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 行配置：宿主在激活时校验显式配置。
 *
 * **故意不在 schema 里 `.default()`**：schema 填出的默认值与「用户显式配置」
 * 无法区分，会在 resolveConfig 里永久遮蔽环境变量回退。
 * 类型/范围在这里校验，默认值与回退只在 config.js。
 */
export const Config = z.object({
  root: z.string().description('记忆库的项目根目录（绝对路径）；默认取会话工作目录，可被 DSH_MEMORY_ROOT 回退覆盖'),
  autonomy: z
    .union([z.const('manual'), z.const('balanced'), z.const('autonomous')])
    .description('自主度：manual（全靠确认）/ balanced（默认，高置信自动）/ autonomous（全自动）'),
  thresholds: z
    .object({
      autoAcceptFloor: z.number().min(0).max(1).description('自动落盘的置信地板；默认 0.60'),
      deferFloor: z.number().min(0).max(1).description('低于这个值直接丢弃、不建提案；默认 0.35'),
      duplicate: z.number().min(0).max(1).description('近重复相似度阈值；默认 0.82'),
      coverageFloor: z.number().min(0).max(1).description('覆盖门地板；默认 0.45'),
    })
    .description('审核与召回阈值'),
  quota: z
    .object({
      repo: z.number().min(1).step(1).description('项目层硬上限；默认 200'),
      growthThreshold: z.number().min(1).step(1).description('growth → ratchet 的切换点；默认 50'),
    })
    .description('配额棘轮（**只有项目层** —— 本插件不做全局记忆）'),
  capture: z
    .object({
      enabled: z.boolean().description('是否启用自动捕获；默认 true'),
      mode: z.union([z.const('strict'), z.const('steady')]).description('信号窗口：strict 只看当前轮（默认）/ steady 看最近几轮'),
      draft: z
        .union([z.const('template'), z.const('subagent')])
        .description('正文起草：template 纯确定性（默认，填不满留占位符 → DEFER）/ subagent 后台跑一次模型'),
      draftProvider: z.string().description('draft=subagent 时使用的子 Agent provider；默认 in-process'),
      signals: z.array(z.string()).description('启用的捕获信号 S1–S7；默认全部'),
    })
    .description('捕获'),
  recall: z
    .object({
      inject: z.boolean().description('是否在每步注入召回结果；默认 true'),
      maxBytes: z.number().min(100).step(1).description('注入预算（字节）；默认 4000'),
      maxPointers: z.number().min(1).max(10).step(1).description('指针档最多几条；默认 3'),
    })
    .description('召回'),
  promote: z
    .object({
      format: z
        .union([z.const('markdown'), z.const('json'), z.const('both')])
        .description('推广包格式；默认 both'),
      minConfidence: z
        .union([z.const('verified'), z.const('inferred'), z.const('stale')])
        .description('进入推广包的置信地板；默认 verified'),
      includeProjectSpecific: z
        .boolean()
        .description('是否把「证据全指向项目内路径」的条目也放进包（会标注）；默认 true'),
    })
    .description('推广到全局记忆：**只产出包，不写全局存储**'),
  embedding: z
    .object({
      provider: z
        .union([z.const('none'), z.const('lexical'), z.const('http')])
        .description('none（默认，关闭）/ lexical（本地确定性，实测不足以做 G1 判决）/ http（OpenAI 兼容 /embeddings）'),
      model: z.string().description('http provider 的模型名；默认 text-embedding-3-small'),
      endpoint: z.string().description('http provider 的 /embeddings 地址；不填则降级为关闭'),
      timeoutMs: z.number().min(100).step(1).description('单次调用超时；默认 10000'),
      g1Threshold: z
        .number()
        .min(0)
        .max(1)
        .description('G1 用余弦判决的阈值；**null = 不参与判决**（只做诊断）。开闸前先跑 bench/embedding-experiment.mjs'),
    })
    .description('语义通道；**默认关**'),
})

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
  const cfg = resolveConfig(config ?? {})
  const log = (message) => {
    try {
      ctx.logger?.warn?.(`memory-bank: ${message}`)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  const resolveRoot = createResolver(cfg, log)

  // 工具：先注册，保证 memory_* 在任何一步都可用
  const definitions = createToolDefinitions({ resolveRoot, cfg, log })
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
  const hooks = createHooks({ ctx, cfg, resolveRoot, log })
  ctx.effect(() => hooks.install())

  // 斜杠命令：**可选**服务。没有命令运行时的 profile（headless / sdk）照常加载工具面，
  // 不用为了一个人机入口把整个插件变成不可用。
  ctx.inject(['commands'], (commandCtx) => {
    const command = createMemoryCommand({ resolveRoot, cfg, log })
    commandCtx.effect(() => commandCtx.commands.register(command))
  })

  log(
    `mounted ${definitions.length} tools (autonomy=${cfg.autonomy}, autoAccept=${cfg.thresholds.autoAcceptFloor}, ` +
      `quota=${cfg.quota.repo}, capture=${cfg.capture.enabled ? 'on' : 'off'})`,
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
