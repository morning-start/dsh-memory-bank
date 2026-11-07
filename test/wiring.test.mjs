/**
 * 接线冒烟（**不需要 DSH profile**）。
 *
 * 为什么要有这一份：`test/plugin.test.mjs` 走的是 `apply()`，而 `apply` 的
 * `Config` schema 依赖 peer 依赖 `@deepseek-ai/schemastery` —— 没装 profile 的
 * 机器上整组 `describe` 被 **skip**。上一版就是让这组永久跳过，而它恰好是
 * **唯一**覆盖插件接线的测试：
 *
 *   - 工具从 6 个变成 7 个（`memory_promote` 加了但断言没改）；
 *   - `resolveRoot()` 不传 agent（七个工具全部写到 DSH 进程 cwd）；
 *   - `ctx.inject(['userQuestions'])` 整条路径没有测试。
 *
 * 三个都没被任何东西挡住 —— `npm test` 报 196 条全绿。
 *
 * 这一份直接调 `createToolDefinitions` / `createHooks` / `createMemoryCommand`，
 * 这三个都不碰 schemastery，所以**永远会跑**。`apply()` 那一层留给
 * `plugin.test.mjs`（它在装了 profile 的环境里仍然有价值）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createMemoryCommand } from '../lib/command.js'
import { createHooks } from '../lib/hooks.js'
import { createToolDefinitions } from '../lib/tools.js'
import { defaultConfig } from '../lib/store.js'

let root
let ctx

function createFakeContext() {
  const tools = []
  const listeners = []
  const contexts = []
  const effects = []
  const logs = []
  const commands = []

  const fake = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      context(entry) {
        contexts.push(entry)
        return () => {}
      },
      section() {
        return () => {}
      },
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    /** 可选服务注入：宿主在有该服务时才构建子 scope。假 ctx 里同步调用回调。 */
    inject(services, callback) {
      for (const service of services) {
        if (!fake[service]) return
      }
      const child = Object.create(fake)
      child.effect = (fn) => {
        const dispose = fn()
        effects.push(dispose)
        return dispose
      }
      callback(child)
    },
    userQuestions: {
      ask(question) {
        return question
      },
    },
    logger: {
      warn(message) {
        logs.push(message)
      },
    },
    _tools: tools,
    _listeners: listeners,
    _contexts: contexts,
    _effects: effects,
    _logs: logs,
    _commands: commands,
  }

  return fake
}

/** 按 `apply()` 的顺序把三块接起来。 */
function wire({ config = {} } = {}) {
  const cfg = { ...defaultConfig(), ...config, thresholds: { ...defaultConfig().thresholds, ...(config.thresholds ?? {}) } }
  const log = (message) => ctx._logs.push(`memory-bank: ${message}`)
  const resolveRoot = (agent) => agent?.workingDirectory ?? root

  for (const definition of createToolDefinitions({ resolveRoot, cfg, log })) {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: { schema: { type: 'object', properties: { text: { type: 'string' } } } },
      execute: async (args, exec) => ({ text: await definition.run(args ?? {}, exec) }),
    })
  }

  const hooks = createHooks({ ctx, cfg, resolveRoot, log, ask: (q) => ctx.userQuestions.ask(q) })
  ctx.effect(() => hooks.install())

  const command = createMemoryCommand({ resolveRoot, cfg, log })
  ctx.commands.register(command)

  return { cfg, hooks, command }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring-'))
  ctx = createFakeContext()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('插件接线（不依赖 peer）', () => {
  it('注册 7 个工具，名字与 output 契约正确', () => {
    wire()

    assert.deepEqual(ctx._tools.map((tool) => tool.name).sort(), [
      'memory_audit',
      'memory_forget',
      'memory_pending',
      'memory_promote',
      'memory_recall',
      'memory_remember',
      'memory_resolve',
    ])

    for (const tool of ctx._tools) {
      assert.equal(typeof tool.description, 'string', `${tool.name} 缺描述`)
      assert.ok(tool.description.length > 20, `${tool.name} 的描述太短（模型看不出来该用哪一个）`)
      assert.equal(tool.parameters.type, 'object', `${tool.name} 的 parameters 必须是 object`)
      assert.deepEqual(tool.output.schema.properties, { text: { type: 'string' } })
      assert.equal(typeof tool.execute, 'function')
    }
  })

  it('每个工具的参数都有 additionalProperties: false（不给模型留自由字段）', () => {
    wire()
    for (const tool of ctx._tools) {
      assert.equal(tool.parameters.additionalProperties, false, `${tool.name} 的 parameters 允许未知字段`)
    }
  })

  it('注册 1 个 prompt context，位置与可抑制性正确', () => {
    wire()
    assert.equal(ctx._contexts.length, 1)
    const [context] = ctx._contexts
    assert.equal(context.name, 'memory:recall')
    assert.equal(context.order, 130) // 审批策略 115 之后、harness 源 200 之前
    assert.equal(context.required, false) // 用户可 suppressRuntimeContext 关掉
    assert.equal(typeof context.text, 'function')
  })

  it('监听 session/event 与 agent/turn-stopping', () => {
    wire()
    assert.deepEqual(ctx._listeners.map((item) => item.event).sort(), ['agent/turn-stopping', 'session/event'])
  })

  it('注册 /memory 斜杠命令（人机入口）', () => {
    wire()
    assert.equal(ctx._commands.length, 1)
    const [command] = ctx._commands
    assert.equal(command.name, 'memory')
    assert.equal(typeof command.handler, 'function')
    assert.ok(command.description.length > 10)
    assert.match(command.input.hint, /pending/)
  })

  it('disposer 全部可调用（卸载不留残留）', () => {
    wire()
    assert.ok(ctx._effects.length >= 1, '至少要有一个 effect')
    for (const dispose of ctx._effects) assert.equal(typeof dispose, 'function')
    for (const dispose of ctx._effects) assert.doesNotThrow(() => dispose())
  })

  /**
   * 七个工具都必须把 `exec.agent` 传到 `resolveRoot`。
   *
   * 上一版全部写 `resolveRoot()` —— 不带参数。于是 `createResolver` 里
   * 「会话工作目录」那一段是死代码：用户在 DSH 里对仓库 A 说「记住 X」，
   * 记忆写到 DSH 进程 cwd，而 `/memory status` 读的是仓库 A。
   * 两份世界，且没有任何测试会红。
   *
   * 每个工具喂「刚好能走到 resolveRoot」的最小参数 —— 之后的失败都是预期内的
   * （空库没有提案 / 没有那条记忆），我们只关心 resolveRoot 收到的是不是 agent。
   */
  it('**七个工具都把 exec.agent 传给 resolveRoot**', async () => {
    const seen = []
    const resolveRoot = (agent) => {
      seen.push(agent?.id ?? null)
      return root
    }
    const marker = { id: 'a1', workingDirectory: root }
    const tools = createToolDefinitions({ resolveRoot, cfg: defaultConfig(), log: () => {} })

    const argsFor = {
      memory_remember: { title: 't', kind: 'fact', about: 'a', body: 'b' },
      memory_recall: { query: 'q' },
      memory_pending: {},
      memory_resolve: { proposalId: 'p_nope', action: 'reject' },
      memory_audit: {},
      memory_promote: {},
      memory_forget: { id: 'nope' },
    }

    for (const definition of tools) {
      assert.ok(definition.name in argsFor, `${definition.name} 没有测试参数 —— 新工具请补上`)
      seen.length = 0
      try {
        await definition.run(argsFor[definition.name], { agent: marker })
      } catch {
        /* 预期：空库 / 没有这条提案 */
      }
      assert.ok(seen.length > 0, `${definition.name} 根本没调 resolveRoot`)
      assert.deepEqual(
        [...new Set(seen)],
        ['a1'],
        `${definition.name} 调 resolveRoot 时丢了 agent（收到 ${JSON.stringify(seen)}）`,
      )
    }
  })

  it('/memory status 在空库上也能跑', async () => {
    wire()
    const [command] = ctx._commands
    const result = await command.handler({ rawInput: 'status', agent: null })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /记忆库/)
  })

  it('/memory 未知子命令给用法而不是崩', async () => {
    wire()
    const [command] = ctx._commands
    const result = await command.handler({ rawInput: 'nope', agent: null })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /用法|未知子命令/)
  })

  it('工具 execute 错误以抛出的形式离开（由宿主转 isError）', async () => {
    wire()
    const recallTool = ctx._tools.find((tool) => tool.name === 'memory_recall')
    await assert.rejects(() => recallTool.execute({ query: '' }, { signal: new AbortController().signal }))
  })
})
