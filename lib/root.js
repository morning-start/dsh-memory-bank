/**
 * 「会话 → 记忆库根目录」的**唯一实现**。
 *
 * ## 为什么必须抽出来
 *
 * 0.2.0 里有两份（`lib/index.js` 的 `createResolver` 与 `lib/host/service.js`
 * 的 `createRootResolver`），靠注释约定「判据必须一字不差」。而两份都写错了
 * 同一件事：**它们读的是 `agent.ctx.workingDirectory`，那不是宿主提供的形状。**
 *
 * 宿主实测（`@deepseek-ai/dsh-working-directory@0.2.1-rc.3`）：
 *
 *   - 服务键是 `workingDirectory`，**挂在插件自己的 ctx 上**，要靠 `inject` 拿到；
 *   - 访问没声明的服务，cordis 直接抛 `cannot get property "workingDirectory" without inject`
 *     （`@deepseek-ai/cordis/lib/index.js:676`）；
 *   - `get(session)` 收的是 **Session**，不是 Agent。
 *
 * 于是 `agent?.ctx?.workingDirectory` 每一次都抛，被 `catch` 吞掉，**静默**
 * 回退到 `process.cwd()` —— 在 DSH Web 宿主里那是 profile 目录
 * （`C:\Users\<user>\.dsh\profiles\desktop`）。后果不是「显示错了」：
 *
 *   1. `memory_remember` 的每条文件锚点都过不了 G4（锚点相对错误的根解析）；
 *   2. 即使过了 G4，记忆也写进了 **profile**，不是仓库 —— `.dsh-memory/` 进不了
 *      那个仓库的 git，`/memory status` 和仓库对不上。
 *
 * 这就是本插件自己在 `lib/command.js` 文件头警告的「两份世界」。
 *
 * ## 解析优先级
 *
 * ```
 * 行 config.root（必须绝对路径）
 *   > DSH_MEMORY_ROOT
 *   > 当前会话工作目录（workingDirectory.get —— 宿主唯一权威）
 *   > 会话创建时记录的 cwd（session.header.cwd）
 *   > 最近一次成功解析的会话目录（只给面板面用；它拿不到 live Agent）
 *   > 进程 cwd —— 而且**必须大声**
 * ```
 *
 * 最后一级不再静默：cwd 落在 `DSH_HOME` 里时**直接抛**。写进错误的仓库
 * 比报错坏得多，这条和 G4 的设计哲学一致。
 *
 * @module lib/root
 */

import { isAbsolute, sep } from 'node:path'

/** 根目录是怎么来的。界面 / 测试用它判断「这个仓库可不可信」。 */
export const ROOT_SOURCES = Object.freeze({
  /** 行配置（`cordis.patch.yml` 的 `config.root`）。 */
  CONFIG: 'config',
  /** 环境变量 `DSH_MEMORY_ROOT`。 */
  ENV: 'env',
  /** 当前会话工作目录（宿主唯一权威）。 */
  SESSION: 'session',
  /** 会话创建时记录的 `header.cwd`（用户 `cd` 过、或服务未注入时）。 */
  HEADER: 'header',
  /** 面板面无 live Agent 时，最近一次会话解析结果。 */
  MEMO: 'memo',
  /** 进程 cwd —— 不可信，必须让用户看见。 */
  FALLBACK: 'fallback',
})

/**
 * 解析不到可信根目录。
 *
 * **刻意是一个具名错误**：调用方（工具面 / 面板面）要能把它和「没有这条记忆」
 * 这类业务错误分开 —— 前者是环境问题，重试没有意义。
 */
export class RootUnresolvedError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'RootUnresolvedError'
    this.code = 'root-unresolved'
    this.directory = options.directory
  }
}

/** 去掉末尾分隔符，用于前缀比较（Windows 上 `\` 与 `/` 都可能出现）。 */
function trimTrailingSeparators(directory) {
  return String(directory).replace(/[\\/]+$/, '')
}

/** `directory` 是否落在 `base` 里面（含相等）。 */
function isInside(directory, base) {
  if (typeof base !== 'string' || base === '') return false
  const normalizedBase = trimTrailingSeparators(base)
  if (normalizedBase === '') return false
  const normalizedDirectory = trimTrailingSeparators(directory)
  if (normalizedDirectory === normalizedBase) return true
  return (
    normalizedDirectory.startsWith(`${normalizedBase}${sep}`) ||
    normalizedDirectory.startsWith(`${normalizedBase}/`) ||
    normalizedDirectory.startsWith(`${normalizedBase}\\`)
  )
}

/**
 * 创建根目录解析器。一个插件实例一个 —— 面板面和工具面共享它，
 * 于是「最近一次会话目录」这个兜底对两边是同一份。
 *
 * @param {{
 *   rowConfig?: { root?: string },
 *   env?: Record<string, string | undefined>,
 *   log?: (message: string) => void,
 *   cwd?: () => string,
 * }} [options]
 */
export function createRootResolver(options = {}) {
  const rowConfig = options.rowConfig ?? {}
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const cwd = options.cwd ?? (() => process.cwd())

  /** 宿主注入的 `workingDirectory` 服务（可选 —— headless / sdk 没有）。 */
  let workingDirectory = null
  /** 最近一次**可信**的会话目录。面板面拿不到 agent 时用它。 */
  let memo = null
  /**
   * 最近一次 `resolve()` 的**实际来源**，含 `fallback`。
   *
   * ## 为什么不能复用 `memo.source`
   *
   * `memo` 刻意**只**记「可信」的解析结果 —— cwd 回退不写进去，因为
   * 「这一次没有 live Agent」不等于「这个仓库就是进程 cwd」。那个判断是对的。
   *
   * 但 `source` 是**给界面画徽标用的**，它回答的是另一个问题：**这一次读到
   * 的根是怎么来的。** 复用 `memo.source` 的后果是 `fallback` 分支永远返回
   * `null` —— 于是 0.3.7 加的「回退警告条」**一次都不会出现**，面板安安静静
   * 显示着 profile 目录里的 0 条记忆。
   *
   * 这正是那个功能要治的病：**0 到底是「这个仓库没有记忆」还是「读错了
   * 地方」，无从判断。** 两个变量各管一件事，不合并。
   */
  let lastSource = null
  let warnedFallback = false

  /**
   * 会话目录。
   *
   * **`workingDirectory.get()` 有一个陷阱**：本会话没有记录时它退化成
   * 服务自己的 `defaultDirectory`（默认就是 `process.cwd()`）。那个值
   * 不是会话目录 —— 用它正好复现「写进 profile」这个 bug。所以要和
   * `defaultDirectory` 比一次，相同就说明「没有记录」。
   */
  function fromSession(session) {
    if (!session) return null

    const header =
      typeof session.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : null

    let current = null
    if (workingDirectory && typeof workingDirectory.get === 'function') {
      try {
        const value = workingDirectory.get(session)
        if (typeof value === 'string' && isAbsolute(value)) current = value
      } catch (error) {
        // 服务在调用方作用域里不可用不是致命错误 —— header.cwd 还在。
        log(`workingDirectory.get 不可用（${error?.message ?? error}）；改用会话 header.cwd`)
      }
    }

    // 服务声明的兜底目录；拿不到就当进程 cwd（两者在默认部署下相同）。
    const serviceDefault =
      typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory.length > 0
        ? workingDirectory.defaultDirectory
        : cwd()

    if (current !== null && current !== serviceDefault) {
      return { root: current, source: ROOT_SOURCES.SESSION }
    }
    if (header !== null) return { root: header, source: ROOT_SOURCES.HEADER }
    return null
  }

  /**
   * 最后一级兜底。**rapper 选择「大声」而不是「安静地写错地方」。**
   * @returns {{ root: string, source: string }}
   */
  function fallback() {
    const directory = cwd()
    const dshHome = env.DSH_HOME
    if (isInside(directory, dshHome)) {
      throw new RootUnresolvedError(
        `无法解析记忆库根目录：这次调用没有 live Agent（exec.agent 缺失），而进程 cwd「${directory}」` +
          `落在 DSH 安装目录（DSH_HOME）里 —— 写进去会污染 profile，不是你的仓库。\n` +
          '  修法（任选）：在会话里调一次工具（让 agent 传进来）、设 DSH_MEMORY_ROOT、' +
          '或在 .dsh-memory/config.json 里写 root。',
        { directory },
      )
    }
    if (!warnedFallback) {
      warnedFallback = true
      log(
        `无法解析会话工作目录（exec.agent 缺失），回退到进程 cwd「${directory}」—— ` +
          '这可能不是你正在工作的仓库。设 DSH_MEMORY_ROOT 可以消掉这条警告。',
      )
    }
    return { root: directory, source: ROOT_SOURCES.FALLBACK }
  }

  return {
    /**
     * 装上宿主的工作目录服务。由 `lib/index.js` 的 `ctx.inject(['workingDirectory'])`
     * 调用；卸载时传 `null`。
     */
    useWorkingDirectory(service) {
      workingDirectory = service ?? null
    },

    /** 最近一次**可信**解析结果（面板面的兜底来源，也可给界面画来源徽标）。 */
    get memo() {
      return memo
    },

    /**
     * 解析本次调用落在哪个仓库。
     *
     * @param {{ session?: { header?: { cwd?: string } } } | null | undefined} [agent]
     *   `exec.agent` / `invocation.agent`。缺失是**允许**的（面板面就没有），
     *   但缺失时不会静默编一个假仓库出来。
     * @returns {string} 绝对路径
     */
    resolve(agent) {
      if (rowConfig.root) {
        if (!isAbsolute(rowConfig.root)) {
          throw new RootUnresolvedError(`memory-bank: root 必须是绝对路径，收到「${rowConfig.root}」`, {
            directory: rowConfig.root,
          })
        }
        memo = { root: rowConfig.root, source: ROOT_SOURCES.CONFIG }
        lastSource = ROOT_SOURCES.CONFIG
        return rowConfig.root
      }

      if (typeof env.DSH_MEMORY_ROOT === 'string' && env.DSH_MEMORY_ROOT.length > 0) {
        memo = { root: env.DSH_MEMORY_ROOT, source: ROOT_SOURCES.ENV }
        lastSource = ROOT_SOURCES.ENV
        return env.DSH_MEMORY_ROOT
      }

      const session = fromSession(agent?.session)
      if (session !== null) {
        memo = session
        lastSource = session.source
        return session.root
      }

      // 面板面：没有 live Agent，但同一个插件实例刚刚为某个仓库服务过。
      if (memo !== null) {
        lastSource = memo.source
        return memo.root
      }

      const resolved = fallback()
      // **不写进 memo**：一次 cwd 回退不该被当成「这个仓库就是它」。
      // 但 `lastSource` 必须记下来 —— 界面要据此画「读错了地方」的警告。
      lastSource = resolved.source
      return resolved.root
    },

    /** 最近一次解析的来源（界面画徽标用；没有解析过就是 `null`）。 */
    get source() {
      return lastSource
    },
  }
}
