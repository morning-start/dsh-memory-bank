#!/usr/bin/env node
/**
 * 语法检查：`node --check` 跑遍 `lib/` `client/` `shared/` `test/` `bench/` `scripts/` 下**全部** `.js` / `.mjs`。
 *
 * ## 为什么是一个脚本，而不是 package.json 里的一行
 *
 * 原来写的是 `node --check lib/*.js`，靠 shell 展开通配符。Windows 的 cmd
 * **不展开**通配符 —— 于是它在 CI 上只检查一个名字里带星号的文件，然后报
 * 「检查通过」。**静默失效的检查比没有检查更糟。**
 *
 * ## 为什么必须递归
 *
 * 第一版改成 `readdirSync(root)` 之后不再有通配符问题，但**只扫顶层**。
 * 于是 `lib/config/` 一加进来，那 6 个模块一条都没被检查过 —— 而
 * `lib/config/` 恰好是这一版改动最大的地方。同一个坑在
 * `bench/acceptance.mjs` 第 7 条（零网络调用）也踩过一次：加了子目录，
 * 检查数字没变，看起来还是绿的。
 *
 * 所以这里的规则只有一条：**扫目录，递归，不列清单。**
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

import { routeReport } from '../lib/routes.js'

const roots = ['lib', 'client', 'shared', 'test', 'bench', 'scripts']
const SKIP = /^(node_modules|\.tmp|coverage|\.git)$/

let checked = 0
const failures = []

/** 递归收集一个根下的 `{ 相对路径, 绝对路径 }`。目录不存在就跳过（可选目录）。 */
function collect(root) {
  let entries
  try {
    entries = readdirSync(root, { recursive: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const relative = String(entry).split(sep).join('/')
    if (relative.split('/').some((segment) => SKIP.test(segment))) continue
    if (!/\.(mjs|js)$/.test(relative)) continue
    const absolute = join(root, ...relative.split('/'))
    try {
      if (!statSync(absolute).isFile()) continue
    } catch {
      continue
    }
    files.push({ relative: `${root}/${relative}`, absolute })
  }
  return files
}

for (const root of roots) {
  for (const file of collect(root)) {
    checked += 1
    try {
      execFileSync(process.execPath, ['--check', file.absolute], { stdio: 'pipe' })
    } catch (error) {
      failures.push({ file: file.relative, message: String(error?.stderr ?? error?.message ?? error).trim() })
    }
  }
}

for (const failure of failures) console.error(`✗ ${failure.file}\n${failure.message}\n`)

if (failures.length > 0) {
  console.error(`${failures.length} / ${checked} 个文件语法错误`)
  process.exitCode = 1
} else {
  console.log(`✓ ${checked} 个文件语法通过`)
}

/* ── 第二相：目录 README 路由层 ────────────────────────────────────
 *
 * 为什么是**硬门**而不是「维护条款」：条款是软的、会被跳过；CI 是硬的、
 * 不可绕过的。这一条差别决定了目录索引会不会腐烂 —— 而腐烂的索引比没有
 * 索引更糟（它**宣称**自己是路由）。
 *
 * 规则只有三条（见 `docs/README.md` 的「维护约定」）：
 *   1. 每个含 .md 的目录必须有 README.md
 *   2. README.md 必须列全该目录下的直接子 .md
 *   3. README.md 不能登记已经不存在的文件
 *
 * 只做一层 —— 不递归。理由见 `lib/routes.js` 文件头。
 */

const routeFailures = []
let routeReportResult = null
try {
  routeReportResult = routeReport(process.cwd())
} catch (error) {
  // 路由检查本身崩了不能静默通过 —— 那会让「检查过」变成谎话。
  routeFailures.push(`路由检查异常：${error?.message ?? error}`)
}

if (routeReportResult) {
  for (const dir of routeReportResult.missingReadme) {
    const label = dir || '仓库根'
    routeFailures.push(`${label}/ 缺少 README.md —— ${routeReportResult.folders.find((folder) => folder.dir === dir)?.files.length ?? 0} 个 .md 文件没有索引`)
  }
  for (const item of routeReportResult.unlisted) {
    routeFailures.push(`${item.dir || '仓库根'}/ 有文件未登记到 README.md：${item.file}`)
  }
  for (const item of routeReportResult.missing) {
    routeFailures.push(`${item.dir || '仓库根'}/README.md 登记了不存在的文件：${item.entry}`)
  }
}

for (const failure of routeFailures) console.error(`✗ ${failure}`)

if (routeFailures.length > 0) {
  console.error(`\n${routeFailures.length} 条目录路由问题。修法：给该目录补一行路由，或删掉失效的一行。`)
  process.exitCode = 1
} else {
  const count = routeReportResult?.folders.length ?? 0
  console.log(`✓ 目录路由：${count} 个文档目录全部有索引且列全`)
}

/* ── 第三相：有实现、无生产调用者 ────────────────────────────────
 *
 * 这是这个仓库**反复**栽的同一个坑：`pinned` 进了快照但召回不读、
 * `resolveClaim` 三个函数写了没人调、`syncClaims` 的判据因为一个字段
 * 没落盘而恒 false。三处都是「机制写好了、测过了、就是没接上」，
 * 而它们**没有任何一条测试会红**。
 *
 * 判据三级（**纯词边界扫描**，不做语法分析 —— 假阴性可接受，
 * 我们要挡的是假阳性）：
 *   1. 被 `lib/` 之外的文件引用        → 有外部消费者
 *   2. 只被 `lib/` 内其它文件引用      → 内部使用
 *   3. 只被定义文件自身引用（含无）     → 死导出
 *
 * 实测：291 个导出里 15 个死，**0 假阳性**（逐条 grep 核对过）。
 */

/**
 * 允许「有实现、无生产调用者」的导出。
 *
 * 每一条**必须**给理由 —— 这个名单存在的意义就是让「为什么它还在」有地方写。
 * 加一条之前先问：**它是不是该被接上（`docs/09` §4.4）而不是被豁免？**
 *
 * @type {Map<string, string>}
 */
const DEAD_EXPORT_ALLOWLIST = new Map([])

/** 抽 `export function name` / `export const name =` / `export class Name` / 具名 re-export。 */
function extractExportNames(text) {
  const names = new Map()
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.set(match[1], 'decl')
  }
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const [local, exported] = piece.split(/\s+as\s+/).map((value) => value.trim())
      const name = exported || local
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.set(name, 'named')
    }
  }
  return names
}

function deadExportPhase(repoRoot) {
  const SCAN_ROOTS = ['lib', 'shared', 'test', 'bench', 'scripts', 'client']
  const SKIP = new Set(['node_modules', '.git', 'coverage', 'dist', 'build'])
  const texts = new Map()

  for (const root of SCAN_ROOTS) {
    let entries
    try {
      entries = readdirSync(join(repoRoot, root), { recursive: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const relative = String(entry).split(sep).join('/')
      if (!/\.(js|mjs)$/.test(relative)) continue
      if (relative.split('/').some((segment) => SKIP.has(segment))) continue
      const path = `${root}/${relative}`
      try {
        if (!statSync(join(repoRoot, ...path.split('/'))).isFile()) continue
        texts.set(path, readFileSync(join(repoRoot, ...path.split('/')), 'utf8'))
      } catch {
        continue
      }
    }
  }

  const word = (name) => new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`)
  const dead = []

  for (const [path, text] of texts) {
    if (!path.startsWith('lib/') && !path.startsWith('shared/')) continue
    for (const [name] of extractExportNames(text)) {
      if (DEAD_EXPORT_ALLOWLIST.has(`${path}#${name}`)) continue
      const pattern = word(name)
      let consumed = false
      for (const [other, otherText] of texts) {
        if (other === path) continue
        if (pattern.test(otherText)) {
          consumed = true
          break
        }
      }
      if (consumed) continue
      // 定义文件自身（除声明行之外）用过吗？
      const declaration = new RegExp(
        `^export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name.replace(/[$]/g, '\\$')}\\b`,
      )
      const selfUsed = text.split('\n').some((line) => pattern.test(line) && !declaration.test(line.trim()))
      if (!selfUsed) dead.push(`${path}#${name}`)
    }
  }

  return dead
}

const deadExports = deadExportPhase(process.cwd())
for (const item of deadExports) {
  console.error(`✗ 死导出：${item}`)
}
if (deadExports.length > 0) {
  console.error(
    `\n${deadExports.length} 个导出没有任何消费者。` +
      '修法：接上它（`docs/09` §4.4），或删掉它，或在 `DEAD_EXPORT_ALLOWLIST` 里写明理由。',
  )
  process.exitCode = 1
} else {
  console.log('✓ 死导出：全部导出都有消费者或定义文件内部使用')
}

/* ── 第四相：跨模块重名 —— 「双实现漂移」的机械判据 ────────────────
 *
 * 这是这个仓库**最贵**的一类 bug，而且它有一个恶劣的性质：**两份实现各自
 * 都有测试，所以永远不会变红**。
 *
 * 实证（0.3.x 修掉之前，全部在本仓库里）：
 *
 * | 重名 | 两份的差别 | 后果 |
 * |---|---|---|
 * | `readQuotaState` | `tools.js` 私有版 / `host/queries.js`「镜像」版 | 面板与 `/memory status` 可以报出两个配额 |
 * | `clampInt` | 严格版（只收 number）/ 强转版（`Number()`） | 同一个旋钮在工具面和面板面语义不同 |
 * | `tokenize` | 词 + CJK 单字 / 词 + CJK 二字组 | 检索通道与语义通道对同一段文本切出不同词项 |
 * | `stripQuoted` | shell 状态机（处理 `\`）/ 正则替换（散文） | 同名不同义，读代码的人会以为它们是同一个函数 |
 * | `pickEditable` | 8 项（含 `claims`）/ 7 项（不含） | 「哪些字段可编辑」取决于你从哪个入口点进来 |
 *
 * 判据：**同一个顶层函数名 / 顶层 const 名不得出现在两个 `lib/` 模块里。**
 *
 * ## 为什么这是一条硬门而不是维护条款
 *
 * 条款会被跳过 —— 而这个坑的特点是**跳过的时候全绿**。写代码的人复制一份
 * 出来改，测试仍然过，界面继续给错答案。只有 CI 红着，复制这个动作才会
 * 在 review 里被看见。
 *
 * ## 误报怎么办
 *
 * `DUPLICATE_NAME_ALLOWLIST` 里**必须写明理由**。加一条之前先问：
 * 这两个函数真的需要同名吗？重命名（`tokenizeSemantic` / `stripShellQuoted`）
 * 几乎总是更好的答案 —— 同名不同义本身就是债。
 *
 * **同类但不同名不算**：`renderRecall` 与 `renderProposal` 都在渲染，
 * 但名字已经说明了区别。本门只挡「同名」。
 */

/**
 * 允许「两个模块各有一个同名顶层函数」的位置。
 *
 * 键是 `名字`，值是**为什么必须同名**。没有值的条目会在下一次检查时
 * 变成红色 —— 这个名单存在的意义就是让「为什么它还在」有地方写。
 *
 * @type {Map<string, string>}
 */
const DUPLICATE_NAME_ALLOWLIST = new Map([])

/**
 * 收集 `lib/` 下每个模块的**顶层**声明名。
 *
 * 只认顶层：`  function x()`（缩进）是内部实现，重名不构成双实现 ——
 * 两个模块各有一个 `render()` 内部辅助是正常的。判据是「导出的 / 顶层的
 * 那一份」，因为它才是被别处 import 的那一份。
 */
function duplicateNamePhase(repoRoot) {
  const libDir = join(repoRoot, 'lib')
  let entries
  try {
    entries = readdirSync(libDir, { recursive: true })
  } catch {
    return []
  }

  /** @type {Map<string, string[]>} 名字 -> 定义它的文件 */
  const owners = new Map()

  for (const entry of entries) {
    const relative = String(entry).split(sep).join('/')
    if (!/\.(js|mjs)$/.test(relative)) continue
    const path = `lib/${relative}`
    let text
    try {
      if (!statSync(join(repoRoot, ...path.split('/'))).isFile()) continue
      text = readFileSync(join(repoRoot, ...path.split('/')), 'utf8')
    } catch {
      continue
    }

    const names = new Set()
    // 顶层函数：`function name(` / `export function name(` / `async function name(`
    for (const match of text.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      names.add(match[1])
    }
    // 顶层 const / let 箭头函数：`const name = (` / `const name = async (`
    for (const match of text.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/gm)) {
      names.add(match[1])
    }

    for (const name of names) {
      if (!owners.has(name)) owners.set(name, [])
      const list = owners.get(name)
      if (!list.includes(path)) list.push(path)
    }
  }

  const duplicates = []
  for (const [name, files] of [...owners].sort()) {
    if (files.length < 2) continue
    if (DUPLICATE_NAME_ALLOWLIST.has(name)) continue
    duplicates.push({ name, files: files.sort() })
  }
  return duplicates
}

const duplicateNames = duplicateNamePhase(process.cwd())
for (const item of duplicateNames) {
  console.error(`✗ 跨模块重名：${item.name}  →  ${item.files.join('  +  ')}`)
}
if (duplicateNames.length > 0) {
  console.error(
    `\n${duplicateNames.length} 个顶层函数名出现在多个 lib 模块里。` +
      '这是本仓库最贵的一类 bug（双实现漂移：两份各有测试，永远不变红）。\n' +
      '修法（按优先级）：\n' +
      '  1. **重命名消歧** —— `tokenize` → `tokenizeSemantic` / `stripQuoted` → `stripShellQuoted`；\n' +
      '  2. **抽到单一事实源** —— 搬到 `lib/kernel/` 或 `lib/adjudicate.js`，两边 import；\n' +
      '  3. 确实必须同名 → 在 `DUPLICATE_NAME_ALLOWLIST` 里写明理由。',
  )
  process.exitCode = 1
} else {
  console.log('✓ 跨模块重名：每个顶层函数名只有一个实现')
}
