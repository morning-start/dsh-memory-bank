/**
 * 「记忆库是 opt-in 的」—— 这一条的全部可执行证明。
 *
 * ## 为什么需要这一份
 *
 * 0.4.3 之前，`.dsh-memory/` 由**五条代码路径**顺手建出来：`memory_remember`、
 * `promote --write`、`/memory recall`、后台捕获 drain、`reseed`。其中两条是
 * **自动**的（`system-prompt.context` 召回注入、`agent/turn-stopping` 自动捕获）。
 *
 * 后果：在一个从没用过记忆的仓库里跑几轮对话，就多出一个 `.dsh-memory/` ——
 * 用户没同意过。而这个目录**会被提交进 git**（它不是缓存，是仓库制品）。
 *
 * 所以这一版把「自动」和「显式」分开：
 *
 * | 路径 | 未初始化时 |
 * |---|---|
 * | 自动捕获（`agent/turn-stopping`） | **一个字节都不写**，连配置都不读 |
 * | 召回注入（`system-prompt.context`） | 早就如此（`isInitialized` 短路） |
 * | 只读（`memory_recall` / `memory_audit` / `memory_pending`） | 报「未初始化」，**不建目录** |
 * | 显式写（`memory_init` / `memory_remember`） | 建骨架（明确的意图） |
 *
 * 这份用例逐条锁住上面四行。**每一条都同时断言「没有创建 `.dsh-memory/`」** ——
 * 只断言返回值的话，一个「先建目录再返回提示」的实现也能全绿。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createMemoryCommand } from '../lib/command.js'
import { createConfigSource } from '../lib/config/index.js'
import { createHooks } from '../lib/hooks.js'
import { defaultConfig, ensureLayout, isInitialized, layout } from '../lib/store.js'
import { createToolDefinitions } from '../lib/tools.js'

let root

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-init-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 隔离真实环境变量 —— 否则开发机上的 `DSH_MEMORY_*` 会让断言一台绿一台红。 */
function configSourceFor() {
  return createConfigSource({ rowConfig: {}, env: {} })
}

function toolsFor() {
  return createToolDefinitions({ resolveRoot: () => root, configSource: configSourceFor(), log: () => {} })
}

/** 按名字取工具。名字写错要**立刻红**，不要静默 `undefined`。 */
function tool(name) {
  const found = toolsFor().find((definition) => definition.name === name)
  assert.ok(found, `找不到工具 ${name}`)
  return found
}

/** `.dsh-memory/` 里有没有东西 —— 「没创建」和「建了空的」要分开看。 */
const memoryDirExists = () => existsSync(layout(root).base)

/* ── 1 · 判据 ─────────────────────────────────────────────────────── */

describe('isInitialized · 「没装过」和「装了但空」是两件事', () => {
  it('新仓库 → false', () => {
    assert.equal(isInitialized(root), false)
  })

  it('`ensureLayout` 之后 → true（哪怕一条记忆都没写）', () => {
    ensureLayout(root)
    assert.equal(isInitialized(root), true)
  })

  it('目录被删掉之后 → 退回 false（用户撤销了 opt-in）', () => {
    ensureLayout(root)
    assert.equal(isInitialized(root), true)
    rmSync(layout(root).base, { recursive: true, force: true })
    assert.equal(isInitialized(root), false)
  })

  it('root 不是合法路径也不抛 —— 它不该让界面崩', () => {
    for (const bad of [null, undefined, 42, {}]) {
      assert.equal(isInitialized(bad), false, `isInitialized(${JSON.stringify(bad)}) 应该 false`)
    }
  })
})

/* ── 2 · 显式初始化 ───────────────────────────────────────────────── */

describe('memory_init · 建骨架，不写记忆', () => {
  it('建出 8 项，并逐项报出来', async () => {
    const text = await tool('memory_init').run({}, { agent: null })

    assert.match(text, /已初始化记忆库/)
    assert.equal(memoryDirExists(), true)

    const paths = layout(root)
    for (const [label, target] of [
      ['memories', paths.memories],
      ['trust', paths.trust],
      ['pending/rejected', paths.rejected],
      ['inbox', paths.inbox],
      ['index/snapshots', paths.snapshots],
      ['.gitignore', paths.gitignore],
      ['config.json', paths.config],
      ['trust/receipts.json', paths.receipts],
    ]) {
      assert.equal(existsSync(target), true, `缺 ${label}（${target}）`)
    }

    // 报告写的是**仓库相对路径**，不是绝对路径。
    assert.equal(text.includes(root), false, '工具输出里出现了绝对路径')
  })

  it('幂等：第二次不报「创建了」', async () => {
    const init = tool('memory_init')
    await init.run({}, { agent: null })
    const again = await init.run({}, { agent: null })
    assert.match(again, /已存在且完整/)
    assert.match(again, /没有改动任何文件/)
  })

  it('`dry_run` 只报告，不落盘', async () => {
    const text = await tool('memory_init').run({ dry_run: true }, { agent: null })
    assert.match(text, /未落盘/)
    assert.match(text, /memory_init|memories/)

    // **这一条是重点**：dry_run 之后磁盘上必须什么都没有。
    assert.equal(memoryDirExists(), false, 'dry_run 建出了 .dsh-memory/')
  })
})

describe('command · /memory init', () => {
  it('建骨架，幂等', async () => {
    const command = createMemoryCommand({ resolveRoot: () => root, configSource: configSourceFor(), log: () => {} })

    const created = await command.handler({ rawInput: 'init', agent: null })
    assert.equal(created.kind, 'success')
    assert.match(created.text, /已初始化记忆库/)
    assert.equal(memoryDirExists(), true)

    const again = await command.handler({ rawInput: 'init', agent: null })
    assert.match(again.text, /已存在且完整/)
  })

  it('`--dry-run` 不落盘', async () => {
    const command = createMemoryCommand({ resolveRoot: () => root, configSource: configSourceFor(), log: () => {} })
    const result = await command.handler({ rawInput: 'init --dry-run', agent: null })
    assert.match(result.text, /未落盘/)
    assert.equal(memoryDirExists(), false)
  })

  it('用法里列了 init（否则没人知道有这个子命令）', async () => {
    const command = createMemoryCommand({ resolveRoot: () => root, configSource: configSourceFor(), log: () => {} })
    const result = await command.handler({ rawInput: 'nope', agent: null })
    assert.match(result.text, /\/memory init/)
  })

  it('**斜杠命令面板的 hint 里 init 在最前面**', () => {
    // hint 是命令面板**唯一**看得见的那一行。少了 init，用户在没初始化过的
    // 仓库里敲 `/memory` 只会看到「0 条记忆」，不知道有一个动作能把记忆库
    // 建起来 —— 命令存在但不被发现，等于不存在。
    const command = createMemoryCommand({ resolveRoot: () => root, configSource: configSourceFor(), log: () => {} })
    assert.match(command.input.hint, /^init /, `hint 必须以 init 开头，实际是「${command.input.hint}」`)
  })
})

/* ── 3 · 自动捕获：未初始化时一个字节都不写 ───────────────────────── */

describe('自动捕获 · 未初始化时连配置都不读', () => {
  /**
   * 装一套钩子，并统计 `configSource.get` 被调了几次。
   *
   * 为什么盯这个而不是「有没有写盘」：`onTurnStopping` 里 `configSource.get`
   * 紧跟在门后面。它被调用了就说明**门在更后面**（或者根本没有门），
   * 那迟早会走到 `writeInbox`。盯「写盘」需要造一个真的会命中的信号，
   * 盯「配置读取」是等价的、而且更稳定。
   */
  function installSpyHooks() {
    const listeners = []
    const contexts = []
    let configReads = 0

    const base = configSourceFor()
    const configSource = {
      ...base,
      get: (target) => {
        configReads += 1
        return base.get(target)
      },
    }

    const ctx = {
      systemPrompt: {
        context: (spec) => {
          contexts.push(spec)
          return () => {}
        },
        section: () => () => {},
      },
      on: (event, listener) => {
        listeners.push({ event, listener })
        return () => {}
      },
      effect: (callback) => {
        callback()
        return () => {}
      },
      logger: { warn: () => {} },
    }

    const hooks = createHooks({ ctx, configSource, resolveRoot: () => root, log: () => {} })
    hooks.install()

    return {
      contexts,
      listeners,
      reads: () => configReads,
      stopping: () => listeners.find((item) => item.event === 'agent/turn-stopping')?.listener,
    }
  }

  it('**turn-stopping 在未初始化的仓库里直接 return**', async () => {
    const spy = installSpyHooks()
    const stopping = spy.stopping()
    assert.equal(typeof stopping, 'function', '没有注册 agent/turn-stopping')

    // 喂一轮「看起来值得记」的东西 —— 门必须在**判定之前**。
    await stopping({
      agent: { id: 'session-x' },
      turn: 1,
      events: [{ type: 'user', data: { text: '记住：部署前要跑 lint' } }],
    })

    assert.equal(spy.reads(), 0, '未初始化时走到了配置读取 —— 说明门在更后面（迟早会写盘）')
    assert.equal(memoryDirExists(), false, '自动捕获在未初始化的仓库里建出了 .dsh-memory/')
  })

  it('初始化之后同一条路径**会**继续（门不是把功能整个关掉）', async () => {
    ensureLayout(root)
    const spy = installSpyHooks()
    const stopping = spy.stopping()

    await stopping({ agent: { id: 'session-x' }, turn: 1, events: [] })

    assert.ok(spy.reads() > 0, '初始化之后自动捕获应该继续走到配置读取')
  })
})

/* ── 4 · 显式写也要 opt-in（0.5.0 起更严格） ────────────────────── */

describe('memory_remember · 显式写也要 opt-in', () => {
  const CANDIDATE = {
    title: '部署前要跑 lint',
    kind: 'convention',
    about: '提交前检查',
    body: '# 功能名\n部署前跑 lint\n\n# 生效条件\n任何提交\n\n# 子功能\n无\n\n# 执行\n跑 npm run lint\n\n# 验证方式\nCI 通过\n\n# 不适用条件\n无',
    evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    scope: ['repo:acme/api'],
  }

  it('**未初始化时写记忆被拒，且不建目录**', async () => {
    // 0.4.4 这里是「显式写会顺手建骨架」—— 那让 init 这道门只挡住了一半：
    // 模型依然可以在任何仓库里写出一条记忆，顺手把目录建出来。而
    // `.dsh-memory/` **会被提交进 git**，创建它等于一次提交。
    const text = await tool('memory_remember').run(CANDIDATE, { agent: null })

    assert.match(text, /还没初始化记忆库/, '未初始化时 memory_remember 应该报「未初始化」')
    assert.equal(memoryDirExists(), false, 'memory_remember 在未初始化的仓库里建出了 .dsh-memory/')
  })

  it('初始化之后同一条路径能走完协议（不再报「未初始化」）', async () => {
    // 造出证据锚点 —— 否则会先被 G4 拦下，测的就不是这道门了。
    mkdirSync(join(root, 'src', 'db'), { recursive: true })
    writeFileSync(join(root, 'src', 'db', 'pool.ts'), 'export const DB_POOL_MAX = 10\n', 'utf8')
    ensureLayout(root)

    // 走完十道门可能 ACCEPT / REJECT / DEFER —— 那都是协议在说话。
    // 唯一不能出现的是「还没初始化记忆库」。
    // `run()` 默认**同步返回 string**，只在语义通道开着时才返回 Promise ——
    // 所以不能 `.then()`，用 try/await 两种都吃。
    let outcome
    try {
      outcome = await tool('memory_remember').run(CANDIDATE, { agent: null })
    } catch (error) {
      outcome = `REJECT: ${error?.message ?? error}`
    }
    assert.equal(/还没初始化记忆库/.test(String(outcome)), false, `初始化之后仍然被门挡住：${outcome}`)
  })

  it('/memory 的写子命令也遵守同一道门', async () => {
    const command = createMemoryCommand({ resolveRoot: () => root, configSource: configSourceFor(), log: () => {} })
    for (const rawInput of ['accept p_1', 'reject p_1', 'retire m_1', 'reseed', 'promote --write']) {
      const result = await command.handler({ rawInput, agent: null })
      assert.equal(result.kind, 'error', `/memory ${rawInput} 未初始化时应该报错`)
      assert.match(result.text, /还没初始化记忆库/, `/memory ${rawInput} 没报「未初始化」`)
    }
    assert.equal(memoryDirExists(), false, '写子命令在未初始化时建出了 .dsh-memory/')
  })
})

/* ── 5 · 只读工具不替用户 opt-in ─────────────────────────────────── */

describe('只读工具 · 报「未初始化」，且不建目录', () => {
  const cases = [
    ['memory_recall', { query: '任何东西' }],
    ['memory_pending', {}],
    ['memory_audit', {}],
    ['memory_promote', {}],
  ]

  for (const [name, args] of cases) {
    it(`${name} 未初始化时给出可操作的话，不落盘`, async () => {
      const text = await tool(name).run(args, { agent: null })

      assert.match(text, /还没初始化记忆库/, `${name} 没报「未初始化」`)
      assert.match(text, /memory_init/, `${name} 没给初始化入口`)
      // **返回值对了不代表没写盘** —— 一起断言。
      assert.equal(memoryDirExists(), false, `${name} 顺手建出了 .dsh-memory/`)
    })
  }

  it('初始化之后同一个工具恢复正常（不是恒返回提示）', async () => {
    ensureLayout(root)
    const text = await tool('memory_pending').run({}, { agent: null })
    assert.equal(text, '没有待决提案。')
  })

  it('提示里**不许**再出现「顺手建骨架」（0.4.x 的遗物）', async () => {
    // 0.5.0 起 `memory_remember` 不再建骨架。提示里留着那句话，模型就会以为
    // 有第二条路 —— **一句不再成立的提示比没有提示更糟**。
    const text = await tool('memory_recall').run({ query: '任何东西' }, { agent: null })
    assert.equal(/顺手建骨架/.test(text), false, '还在暗示 memory_remember 能自动建骨架')
    assert.match(text, /所有写入在初始化之前都不会执行/, '提示没说清「写也不通」')
  })
})
