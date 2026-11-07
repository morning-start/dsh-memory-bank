/**
 * 根目录解析（`lib/root.js`）—— **真实体验的回归**。
 *
 * 这一份**永远会跑**（只依赖 `lib/root.js` 与 node 内置，不碰 schemastery）。
 *
 * ## 它钉住的是哪个 bug
 *
 * 0.2.0 里七个工具 / 命令面 / 面板面都调 `resolveRoot(exec.agent)`，而实现读的是
 * `agent?.ctx?.workingDirectory`。那不是宿主提供的形状：
 *
 *  - 宿主的服务键是 `workingDirectory`，靠 `inject` 拿，且 `get()` 收 **Session**；
 *  - 访问没声明的服务，cordis 直接抛 `cannot get property ... without inject`。
 *
 * 于是每次必抛 → 被 `catch` 吞掉 → **静默**回退到 `process.cwd()`
 * （DSH Web 宿主里就是 `C:\Users\<user>\.dsh\profiles\desktop`）。
 *
 * 真实后果（本机实测，2026-11-07）：
 *
 * ```
 * 记忆库：C:\Users\Hanes\.dsh\profiles\desktop
 * {"code":"evidence.unresolved","gate":"G4","ref":"plugin/src/core/ledger/ledger.ts"}
 * ```
 *
 * 仓库里那个文件**确实存在** —— 只是相对错误的根解析。于是「项目级记忆」
 * 功能整体不可用：G4 是硬门，而插件设计上要求至少一条文件锚点。
 *
 * 这一份测试用**宿主真实的 exec.agent 形状**断言：解析到的是仓库，不是 cwd。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { ROOT_SOURCES, RootUnresolvedError, createRootResolver } from '../lib/root.js'

let cwd
let project
const cleanups = []

/** 宿主 `WorkingDirectoryService` 的最小替身（形状照 `dsh-working-directory@0.2.1-rc.3`）。 */
function makeWorkingDirectory({ defaultDirectory = cwd, failOnGet = false } = {}) {
  return {
    defaultDirectory,
    get(session) {
      if (failOnGet) throw new Error('cannot get property "workingDirectory" without inject')
      // 宿主真实实现：`stateOf(session,'workingDirectory') ?? defaultDirectory`
      return stateOf.get(session?.id) ?? defaultDirectory
    },
  }
}

let stateOf

/** 宿主的 `exec.agent` 形状（`dsh-tools` 传进来的那个）。 */
function makeAgent({ headerCwd = null } = {}) {
  return {
    id: 'session-1',
    session: {
      id: 'session-1',
      header: headerCwd === null ? {} : { cwd: headerCwd },
    },
    // 宿主里确实有 `agent.ctx`（`dsh-agent` 的 `resolve: (id) => this.get(id)?.ctx`），
    // 但它**不等于**「能拿到 workingDirectory 服务」—— 访问未 inject 的服务会抛。
    ctx: new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        },
      },
    ),
  }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'mb-root-cwd-'))
  project = mkdtempSync(join(tmpdir(), 'mb-root-project-'))
  cleanups.push(cwd, project)
  stateOf = new Map()
})

afterEach(() => {
  for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('根目录解析 · 优先级', () => {
  it('行 config.root 最优先，且必须是绝对路径', () => {
    const resolver = createRootResolver({ rowConfig: { root: project }, cwd: () => cwd })
    assert.equal(resolver.resolve(makeAgent({ headerCwd: project })), project)

    const bad = createRootResolver({ rowConfig: { root: 'relative/path' }, cwd: () => cwd })
    assert.throws(() => bad.resolve(null), RootUnresolvedError)
  })

  it('DSH_MEMORY_ROOT 盖过会话目录', () => {
    const resolver = createRootResolver({ env: { DSH_MEMORY_ROOT: project }, cwd: () => cwd })
    resolver.useWorkingDirectory(makeWorkingDirectory({}))
    stateOf.set('session-1', project)
    assert.equal(resolver.resolve(makeAgent({ headerCwd: cwd })), project)
  })

  it('会话工作目录（服务有记录）优先于 header.cwd', () => {
    const resolver = createRootResolver({ env: {}, cwd: () => cwd })
    resolver.useWorkingDirectory(makeWorkingDirectory({ defaultDirectory: cwd }))
    // 用户 `cd` 过：服务记的是 project，header 是创建时的 cwd。
    stateOf.set('session-1', project)
    assert.equal(resolver.resolve(makeAgent({ headerCwd: cwd })), project)
    assert.equal(resolver.source, ROOT_SOURCES.SESSION)
  })
})

describe('根目录解析 · 真实宿主形状（回归）', () => {
  it('**服务没有本会话记录时退化成 defaultDirectory —— 必须改用 header.cwd**', () => {
    // 这就是生产里的样子：`workingDirectory.get()` 返回它自己的 defaultDirectory
    // （= 进程 cwd = DSH profile 目录），而 session.header.cwd 才是仓库。
    const resolver = createRootResolver({ env: {}, cwd: () => cwd })
    resolver.useWorkingDirectory(makeWorkingDirectory({ defaultDirectory: cwd }))

    const root = resolver.resolve(makeAgent({ headerCwd: project }))
    assert.equal(root, project, '必须解析到仓库，不是进程 cwd')
    assert.notEqual(root, cwd)
    assert.equal(resolver.source, ROOT_SOURCES.HEADER)
  })

  it('**不再读 `agent.ctx.workingDirectory`** —— 那个 getter 抛也不影响', () => {
    const resolver = createRootResolver({ env: {}, cwd: () => cwd })
    resolver.useWorkingDirectory(makeWorkingDirectory({ defaultDirectory: cwd }))
    // makeAgent 的 ctx 访问任何属性都抛；能解析出仓库就证明这条路径没被走。
    assert.equal(resolver.resolve(makeAgent({ headerCwd: project })), project)
  })

  it('没有 workingDirectory 服务（headless / sdk）也能用 header.cwd', () => {
    const resolver = createRootResolver({ env: {}, cwd: () => cwd })
    assert.equal(resolver.resolve(makeAgent({ headerCwd: project })), project)
  })

  it('服务 `get` 抛错时降级到 header.cwd，而不是崩', () => {
    const logs = []
    const resolver = createRootResolver({ env: {}, cwd: () => cwd, log: (m) => logs.push(m) })
    resolver.useWorkingDirectory(makeWorkingDirectory({ failOnGet: true }))
    assert.equal(resolver.resolve(makeAgent({ headerCwd: project })), project)
    assert.ok(logs.some((line) => line.includes('workingDirectory.get')), '必须打出原因')
  })
})

describe('根目录解析 · 拿不到会话时不许静默', () => {
  it('面板面：没有 live Agent 时复用最近一次会话目录', () => {
    const resolver = createRootResolver({ env: {}, cwd: () => cwd })
    assert.equal(resolver.resolve(makeAgent({ headerCwd: project })), project)
    // 面板服务的 `root()` 就是不传 agent 调的。
    assert.equal(resolver.resolve(), project)
    assert.equal(resolver.resolve(undefined), project)
  })

  it('**cwd 落在 DSH_HOME 里 → 抛 RootUnresolvedError（不写 profile）**', () => {
    const resolver = createRootResolver({ env: { DSH_HOME: cwd }, cwd: () => cwd })
    assert.throws(
      () => resolver.resolve(null),
      (error) => {
        assert.equal(error.code, 'root-unresolved')
        assert.match(error.message, /DSH 安装目录/)
        assert.match(error.message, /DSH_MEMORY_ROOT/)
        return true
      },
    )
  })

  it('cwd 不可信但不在 DSH_HOME 里 → 回退 + 只警告一次', () => {
    const logs = []
    const resolver = createRootResolver({ env: {}, cwd: () => cwd, log: (m) => logs.push(m) })
    assert.equal(resolver.resolve(null), cwd)
    assert.equal(resolver.resolve(null), cwd)
    assert.equal(logs.filter((line) => line.includes('回退到进程 cwd')).length, 1)
  })

  it('cwd 回退**不会**被记成「这个仓库就是它」，但来源必须说出来', () => {
    const resolver = createRootResolver({ env: {}, cwd: () => cwd })
    assert.equal(resolver.resolve(null), cwd)
    assert.equal(resolver.memo, null, '一次 cwd 回退不该变成 memo —— 它不可信')
    // **但 `source` 必须说出真相。** 0.4.1 之前这里断言的是 `null`，理由是
    // 「回退不是解析出来的来源」—— 那个判断把「可信度」和「这次是哪种来源」
    // 混成了一件事。后果：界面上的回退警告条**永远不会出现**，面板安安静静
    // 显示着 profile 目录里的 0 条记忆，而路径看起来像一条正常的绝对路径。
    // 两个变量各管一件事：`memo` 记可信的根，`lastSource` 记这一次怎么来的。
    assert.equal(resolver.source, ROOT_SOURCES.FALLBACK, '回退必须能被界面看见')
  })
})

describe('根目录解析 · 端到端：文件锚点相对正确的根', () => {
  it('**真实复现**：项目里的文件锚点必须能过 G4', async () => {
    // 造一个「仓库」：src/db/pool.ts 存在。
    mkdirSync(join(project, 'src', 'db'), { recursive: true })
    writeFileSync(join(project, 'src', 'db', 'pool.ts'), 'export const DB_POOL_MAX = 10\n', 'utf8')

    const resolver = createRootResolver({ env: {}, cwd: () => cwd })
    resolver.useWorkingDirectory(makeWorkingDirectory({ defaultDirectory: cwd }))
    const root = resolver.resolve(makeAgent({ headerCwd: project }))

    assert.ok(isAbsolute(root))

    const { gateEvidence } = await import('../lib/gate.js')
    const candidate = {
      title: '连接池上限导致 staging 超时',
      kind: 'pitfall',
      about: 'staging 健康检查超时的根因是连接池上限',
      body: 'x'.repeat(120),
      evidence: [{ kind: 'file', ref: 'src/db/pool.ts' }],
    }

    // 修复后的根：G4 通过。
    assert.equal(gateEvidence(candidate, { root }).kind, 'pass')

    // 修复前的根（进程 cwd）上同一个锚点必然解析不到 —— 证明这条回归真的在测。
    assert.notEqual(gateEvidence(candidate, { root: cwd }).kind, 'pass')
  })
})
