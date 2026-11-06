/**
 * 接线冒烟：用假 ctx 跑一遍 `apply`，确认
 *   - 6 个工具注册（名字、schema 形状、output 声明）
 *   - 1 个 systemPrompt.context（order 130、required:false）
 *   - 2 个事件监听器
 *   - disposer 全部可调用（卸载不留残留）
 *
 * 这一层不碰 DSH 运行时，只钉住「插件行自己没写错」。
 *
 * `@deepseek-ai/schemastery` 是 peer 依赖，由 DSH profile 在运行时提供。
 * 在没有 profile 的机器上（例如 CI 只跑 lib/ 的单测）这一组**跳过**而不是失败 ——
 * 但不要用替身骗过它：`Config` 的形状是 Plugin Manager 的输入契约，
 * 真实验证必须在装了 profile 的环境里做（见 README 的验收清单）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

let apply
let Config
let peerMissing = false

try {
  ;({ apply, Config } = await import('../lib/index.js'))
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('schemastery')) {
    peerMissing = true
  } else {
    throw error
  }
}

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
    /**
     * 可选服务注入：宿主在有 `commands` 时才构建子 scope。
     * 假 ctx 里直接同步调用回调，并把回调里的 effect 一起收集。
     */
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
    logger: {
      warn(message) {
        logs.push(message)
      },
    },
    // 断言用的出口
    _tools: tools,
    _listeners: listeners,
    _contexts: contexts,
    _effects: effects,
    _logs: logs,
    _commands: commands,
  }

  return fake
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-smoke-'))
  process.env.DSH_MEMORY_ROOT = root
  ctx = createFakeContext()
})

afterEach(() => {
  delete process.env.DSH_MEMORY_ROOT
  rmSync(root, { recursive: true, force: true })
})

describe('插件行接线', { skip: peerMissing ? '@deepseek-ai/schemastery 未安装（需要 DSH profile）' : false }, () => {
  it('注册 6 个工具，名字与 output 契约正确', () => {
    apply(ctx, {})

    const names = ctx._tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'memory_audit',
      'memory_forget',
      'memory_pending',
      'memory_recall',
      'memory_remember',
      'memory_resolve',
    ])

    for (const tool of ctx._tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20, `${tool.name} 的描述太短`)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(tool.output.schema.type, 'object')
      assert.deepEqual(Object.keys(tool.output.schema.properties), ['text'])
      assert.equal(typeof tool.execute, 'function')
    }
  })

  it('注册 1 个 prompt context，位置与可抑制性正确', () => {
    apply(ctx, {})
    assert.equal(ctx._contexts.length, 1)
    const [context] = ctx._contexts
    assert.equal(context.name, 'memory:recall')
    assert.equal(context.order, 130) // 审批策略 115 之后、harness 源 200 之前
    assert.equal(context.required, false) // 用户可 suppressRuntimeContext 关掉
    assert.equal(typeof context.text, 'function')
  })

  it('监听 session/event 与 agent/turn-stopping', () => {
    apply(ctx, {})
    const events = ctx._listeners.map((item) => item.event).sort()
    assert.deepEqual(events, ['agent/turn-stopping', 'session/event'])
  })

  it('注册 /memory 斜杠命令（人机入口）', () => {
    apply(ctx, {})
    assert.equal(ctx._commands.length, 1)
    const [command] = ctx._commands
    assert.equal(command.name, 'memory')
    assert.equal(typeof command.handler, 'function')
    assert.ok(command.description.length > 10)
    assert.match(command.input.hint, /pending/)
  })

  it('/memory status 在空库上也能跑', async () => {
    apply(ctx, {})
    const [command] = ctx._commands
    const result = await command.handler({ rawInput: 'status', agent: null })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /记忆库/)
  })

  it('/memory 未知子命令给用法而不是崩', async () => {
    apply(ctx, {})
    const [command] = ctx._commands
    const result = await command.handler({ rawInput: 'nope', agent: null })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /用法|未知子命令/)
  })

  it('apply 返回后 disposer 全部可调用（卸载不留残留）', () => {
    apply(ctx, {})
    for (const dispose of ctx._effects) assert.equal(typeof dispose, 'function')
    for (const dispose of ctx._effects) assert.doesNotThrow(() => dispose())
  })

  it('日志打出解析后的配置', () => {
    apply(ctx, { autonomy: 'manual' })
    assert.ok(ctx._logs.some((line) => line.includes('autonomy=manual')))
  })

  it('非法 autonomy 直接抛（不静默回退到更激进的档位）', () => {
    assert.throws(() => apply(ctx, { autonomy: 'yolo' }), /autonomy/)
  })

  it('deferFloor 大于 autoAcceptFloor 抛错', () => {
    assert.throws(() => apply(ctx, { thresholds: { autoAcceptFloor: 0.3, deferFloor: 0.9 } }), /deferFloor/)
  })

  it('Config schema 存在（Plugin Manager 读它）', () => {
    assert.ok(Config)
    assert.notEqual(Config, undefined)
  })

  it('工具 execute 错误以抛出的形式离开（由宿主转 isError）', async () => {
    apply(ctx, {})
    const recallTool = ctx._tools.find((tool) => tool.name === 'memory_recall')
    await assert.rejects(() => recallTool.execute({ query: '' }, { signal: new AbortController().signal }))
  })
})
