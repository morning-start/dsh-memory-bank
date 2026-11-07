/**
 * 写入口收口：拦住对 `.dsh-memory/` 的**直接写入**。
 *
 * ## 为什么必须有
 *
 * 十道门（G1 / G2 / G2b / G3 / G3b / G4 / G5 / G6 / G7 / G8）全部只挂在
 * `memory_remember` 这**一条**工具路径上。模型完全可以绕过整套协议，直接
 * `write` 一个 `.dsh-memory/memories/foo.md`：
 *
 * | 断掉的东西 | 后果 |
 * |---|---|
 * | G1 归属 / G3 密钥 / G3b 注入 / G5 重复 / G6 冲突 / G7 配额 | 全部失效 |
 * | `trust/receipts.json` 回执 | 内容寻址链断，`memory_audit` 报缺回执 |
 * | `ledger.jsonl` | 审计断链，「谁在什么时候记了什么」不可复核 |
 * | `index-build` 的 `markDirty` | 不跑，下一个会话看到的是**旧**快照 |
 *
 * 这不是理论风险：长任务里「顺手写个记忆文件」是极常见的行为，
 * 而它会让「这个仓库的每条记忆都过了协议」这句话变成**假的**。
 *
 * ## 为什么是 `ask` 不是 `deny`
 *
 * 用户**应该**能手工修一条记忆 —— 回执损坏要重签、旧格式要迁移、批量导入
 * 要绕过门禁。硬 `deny` 会关掉这个逃生口，然后用户卸载插件。
 *
 * `ask` 保留了权威，同时把「你在绕过协议」**说出来**。DSH 的语义也支持这个
 * 选择：`PreToolDecision` 的 `ask` 分支在**没有审批能力**的宿主上会自动降级
 * 成拒绝（宿主源码原文：「missing approval support turns `ask` into denial」），
 * 我们不用自己判断宿主有没有审批面。
 *
 * ## 路径判定纪律：**用路径 API，不用正则**
 *
 * 对方的 `learnings/2026-01-31-bash-guard-aggressive-path-match.md` 就是
 * 正则 `/memory-bank/` 误伤了 `skills/memory-bank/` 打出来的 —— 一次假拦截
 * 会让整个守卫失去信任，而失去信任的守卫等于不存在。
 *
 * 这里所有**身份判定**都走 `util.canonicalPath`（`path.resolve` + 平台折叠）；
 * 正则只用来**预筛**（从补丁文本里切出候选路径、从命令里找写指示符）。
 * 这个分工是刻意的：预筛错了只是多一次判定，判定错了才是假拦截。
 *
 * ## 与 `lib/lifecycle.js` 的 `stripQuotedProse` 不是同一个函数（**刻意**）
 *
 * 两个模块都做「把引号里的内容换成空格」，但这不是同一件事，所以名字必须
 * 分开。同名不同义的两份实现，就是 `docs/08-代码审核.md` 里「一份改了一处、
 * 另一份没跟上」的温床：
 *
 * | | 本文件的 `stripShellQuoted` | `lifecycle.js` 的 `stripQuotedProse` |
 * |---|---|---|
 * | 输入 | shell 命令字符串 | 记忆的散文（title / about / body） |
 * | 定界符 | `'` `"` `` ` `` 三种 | 只有 `"` 和 `` ` `` |
 * | `\` 转义 | **必须处理** —— 否则 `echo \\>` 被当成重定向 | 不处理 |
 * | 长度 | **必须相等** —— 写指示符的下标要对齐 | 不保证 |
 * | 换行 | 逐字符走，换行照抄 | 不跨行（`[^"\n]*`） |
 *
 * 这里少认一个定界符就是漏拦一条 `rm -rf '.dsh-memory'`；
 * 散文那边少认一个 `'` 是**对的**（裸 `'` 更常是所有格：`Boomtastic's note`）。
 * 两边各自少认的那一个，方向是相反的 —— 所以它们不能共用一个名字。
 */

import { canonicalPath } from './util.js'

/** 记忆库目录名（与 `store.MEMORY_DIR_NAME` 同值；这里不 import 是为了不引入环）。 */
export const MEMORY_DIR_TOKEN = '.dsh-memory'

/**
 * 会**写文件**的工具名。
 *
 * 覆盖 DSH 与常见宿主的命名。不在表里的工具一律不管 —— 收紧这个名单
 * 比放开安全：漏一个只是少一次提醒，错一个会拦住正常编辑。
 */
export const FILE_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'multi_edit',
  'apply_patch',
  'patch',
  'str_replace_editor',
  'create_file',
])

/** 会**执行命令**的工具名。 */
export const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'run_command'])

/** 单值路径参数可能叫这些名字（不同宿主的命名习惯）。 */
const PATH_KEYS = ['path', 'filePath', 'file_path', 'filename', 'file', 'target', 'dest', 'destination']

/** 补丁文本参数可能叫这些名字。 */
const PATCH_KEYS = ['patch', 'patchText', 'patch_text', 'diff', 'input']

/**
 * 补丁文本里的目标路径。
 *
 * 两种格式都要认：
 * - unified diff 头：`+++ b/src/x.ts` / `--- a/src/x.ts`
 * - OpenAI patch：`*** Update File: src/x.ts`（`Add` / `Delete` / `Move to` 同理）
 *
 * 只用于**预筛** —— 切出来的字符串还要过 `canonicalPath` 才算数。
 */
const PATCH_PATTERNS = [
  /^(?:\+\+\+|---)\s+[ab]\/(.+)$/gm,
  /^\*\*\*\s+(?:Add|Update|Delete|Move to:?)\s+(?:File:\s*)?(.+)$/gm,
]

/**
 * shell 命令里的**写**指示符。
 *
 * 全都在「剥掉引号后的命令」上跑 —— 否则 `echo "a > b"` 会被当成重定向，
 * 而那条命令一个字节都不写。
 */
const SHELL_WRITE_INDICATORS = [
  // 重定向。`(?<![0-9&])` 排除 `2>&1` / `&>`；`(?!&)` 排除 `>&`。
  /(?<![0-9&])>{1,2}(?!&)/,
  // 管道 tee
  /\|\s*tee\b/,
  // 文件系统写操作
  /\b(?:cp|mv|rm|rmdir|truncate|dd|shred|unlink|install|ln)\b/,
  // 原地编辑
  /\bsed\b[^|;&]*\s-[a-zA-Z]*i/,
  /\b(?:perl|ruby|node|python3?)\b[^|;&]*\s(?:-i|-e)\b/,
  // 包管理器的「写锁文件」不算 —— 它们不碰 .dsh-memory
]

/**
 * 把命令里的**引号内容**替换成空格，只留结构。
 *
 * 处理 `'` `"` 反引号与 `\` 转义。返回同长度的字符串（索引可对齐），
 * 这样「写指示符」的判定不会被字符串字面量骗到。
 *
 * 名字里的 `Shell` 是**消歧**，不是装饰：`lifecycle.js` 的
 * `stripQuotedProse` 做的是同一类动作，但定界符集合、转义规则、长度保证
 * 全不同（见文件头的对照表）。两个不同的判决不该共用一个名字 ——
 * 读代码的人会以为它们等价，然后只改一处。
 *
 * @param {string} command
 * @returns {string}
 */
export function stripShellQuoted(command) {
  const text = String(command ?? '')
  let out = ''
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote === null && char === '\\') {
      out += ' '
      index += 1
      out += ' '
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      out += ' '
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += ' '
      continue
    }
    out += char
  }
  return out
}

/**
 * 命令里所有**看起来指向记忆库**的 token（已去引号）。
 *
 * 只做字符串切割，**不做判定** —— 判定在 `inspectToolCall` 里过 `canonicalPath`。
 *
 * @param {string} command
 * @returns {string[]}
 */
export function memoryTokens(command) {
  const text = String(command ?? '')
  if (!text.includes(MEMORY_DIR_TOKEN)) return []
  const tokens = text.split(/[\s;|&()<>`'"]+/u)
  // `>=` 而不是 `>`：`rm -rf .dsh-memory` 里那个**裸目录**是最该拦的一种，
  // 写成 `>` 会把它漏掉 —— 而漏掉的是「整个记忆库」。
  return [...new Set(tokens.filter((token) => token.includes(MEMORY_DIR_TOKEN) && token.length >= MEMORY_DIR_TOKEN.length))]
}

/**
 * 从一个工具的参数里抽出**全部**目标路径。
 *
 * @param {Record<string, unknown>} args
 * @returns {string[]}
 */
export function extractWritePaths(args) {
  if (!args || typeof args !== 'object') return []
  const paths = []

  for (const key of PATH_KEYS) {
    if (typeof args[key] === 'string' && args[key]) paths.push(args[key])
  }

  // 多文件工具：`edits: [{ path, ... }]`
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== 'object') continue
      for (const key of PATH_KEYS) {
        if (typeof edit[key] === 'string' && edit[key]) paths.push(edit[key])
      }
    }
  }

  // 补丁文本
  for (const key of PATCH_KEYS) {
    const value = args[key]
    if (typeof value !== 'string' || !value) continue
    for (const pattern of PATCH_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(value)) !== null) paths.push(match[1].trim())
    }
  }

  return [...new Set(paths.filter(Boolean))]
}

/**
 * 这个 shell 命令**会写**记忆库吗？
 *
 * 两段：先剥引号找写指示符（便宜且能排除 `echo "a > b"`），
 * 再切 token。两段都过才返回 true —— **假拦截比漏拦截更贵**。
 *
 * @param {string} command
 * @returns {boolean}
 */
export function shellWritesMemory(command) {
  if (typeof command !== 'string' || !command.includes(MEMORY_DIR_TOKEN)) return false
  const structure = stripShellQuoted(command)
  if (!SHELL_WRITE_INDICATORS.some((pattern) => pattern.test(structure))) return false
  return memoryTokens(command).length > 0
}

/** 仓库相对的 POSIX 路径是否落在记忆库里。 */
function isMemoryPath(relative) {
  return relative === MEMORY_DIR_TOKEN || relative.startsWith(`${MEMORY_DIR_TOKEN}/`)
}

/**
 * 判定一次工具调用。返回 `PreToolDecision` 或 `null`（放行）。
 *
 * **纯函数**：只吃 `(exec, { root })`，不读配置、不写盘、不缓存 ——
 * 这样它可以被 `node --test` 直接钉住，不需要假宿主。
 *
 * @param {{ name?: string, arguments?: Record<string, unknown> }} exec
 * @param {{ root: string }} context
 * @returns {{ kind: 'ask', reason: string, displayReason: { en: string, zh: string } } | null}
 */
export function inspectToolCall(exec, { root }) {
  if (!root) return null
  const tool = String(exec?.name ?? '')
  const args = exec?.arguments ?? exec?.args ?? {}

  if (FILE_WRITE_TOOLS.has(tool)) {
    const targets = extractWritePaths(args)
      .map((raw) => canonicalPath(root, raw))
      .filter((relative) => relative !== null && isMemoryPath(relative))
    if (targets.length === 0) return null
    return askDecision(tool, targets)
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = [args.command, args.cmd, args.script].find((value) => typeof value === 'string')
    if (!shellWritesMemory(command)) return null
    // 切出来的 token 过了 `canonicalPath` 才算数 —— 否则
    // `rm -rf .dsh-memory-evil/` 会因为**子串**含 `.dsh-memory` 被误拦。
    const targets = memoryTokens(command)
      .map((raw) => canonicalPath(root, raw))
      .filter((relative) => relative !== null && isMemoryPath(relative))
    if (targets.length === 0) return null
    return askDecision(tool, targets)
  }

  return null
}

function askDecision(tool, targets) {
  const list = targets.slice(0, 3).join('、')
  const more = targets.length > 3 ? ` 等 ${targets.length} 个文件` : ''
  const zh =
    `[memory-bank] 直接写 \`${list}\`${more} 会**绕过十道门**：没有回执、不进审计日志、索引不知道。` +
    '用 `memory_remember` 记这条；如果这是一次手工修复（重签回执 / 迁移旧格式），确认即可。'
  const en =
    `[memory-bank] Writing \`${list}\`${more} directly **bypasses the MRP gates**: no receipt, ` +
    'no audit log, index unaware. Use `memory_remember`; approve only for a manual repair.'
  return {
    kind: 'ask',
    reason: `[memory-bank] ${tool} 直接写记忆库（${list}${more}）会绕过审核协议`,
    displayReason: { en, zh },
  }
}

/**
 * 把守卫挂到 `tools/pre-execute` 上。
 *
 * **失败时放行**（`next()`），不是拒绝。理由：守卫自己崩了是**我们的** bug，
 * 不该由用户来承担「什么都做不了」。但要记日志 —— 静默降级等于没有守卫。
 *
 * @param {{ on: (event: string, handler: Function) => () => void }} ctx
 * @param {{ resolveRoot: (agent: unknown) => string, log: (message: string) => void }} deps
 * @returns {() => void} disposer
 */
export function installWriteGuard(ctx, { resolveRoot, log }) {
  return ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const root = resolveRoot(exec?.agent)
      return inspectToolCall(exec, { root }) ?? (await next())
    } catch (error) {
      log(`write guard failed (allowing): ${error?.message ?? error}`)
      return next()
    }
  })
}
