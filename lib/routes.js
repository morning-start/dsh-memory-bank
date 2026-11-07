/**
 * 目录 README 路由层。
 *
 * ## 为什么要有这一层
 *
 * 召回（`lib/recall.js`）是**词面**匹配：exact / BM25F / ngram / fuzzy / graph
 * 五路全部依赖字面重合。于是「语义相关但词面不重合」的查询打不中 —— 这是
 * 语义通道**实测分离度 −0.139** 补不上的那个洞（`bench/embedding-experiment.mjs`：
 * 「相关但不同」比「同义改写」更相似，开闸召回的是噪声）。
 *
 * 一份人手写的目录 README 是**编译期的路由表**：不依赖运行时匹配，不需要模型，
 * 不需要网络，可以 diff、可以 review、可以 blame。
 *
 * ## 三条纪律
 *
 * 1. **纯读**。不写盘、不建目录 —— `lib/hooks.js` 的 prompt 装配路径会调它，
 *    而那条路径的契约是「零副作用」（见 `hooks.js` 的 `hasCorpus` 注释）。
 * 2. **只做一层**。不递归：对方的 `design-index-first-architecture.md:191-202`
 *    是试错后的结论 ——「两层足够，`glob` 兜底」。每多一层，维护成本线性增长，
 *    而 `glob("docs/**\/*.md")` 是零成本的兜底。
 * 3. **确定性**。同样的目录树 → 同样的报告；不依赖 `readdir` 的返回顺序。
 *
 * ## 三类问题（这就是「腐烂」的可检测形式）
 *
 * | 判决 | 含义 | 对应记忆侧的 |
 * |---|---|---|
 * | `missing-readme` | 目录里有 `.md` 但没有索引 | 无（结构性缺失） |
 * | `unlisted` | 有文件，README 没列 | `advisory`（目标还在，只是没登记） |
 * | `missing` | README 列了，文件没了 | `quarantined`（目标消失） |
 *
 * ## 为什么不放进 `lib/drift.js`
 *
 * `drift.js` 回答的是「**记忆**引用的锚点还在不在」。这里回答的是
 * 「**目录**里的文件登记了没有」。两者共享「目标消失 / 目标变了」的词表，
 * 但主语不同 —— 混进一个报告会让「这条记忆失效了吗」这个问题的答案变模糊。
 * 所以它们是**并列**的两份报告，在 `memory_audit` 里各占一节。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 目录索引的固定文件名。改它等于换一份约定。 */
export const ROUTE_INDEX_NAME = 'README.md'

/**
 * 不参与路由检查的目录。
 *
 * 判断的是**直接子目录名**，不是路径段 —— 我们只做一层，所以
 * `docs/` 里的 `node_modules` 这种东西不存在；这里的名单是为了让
 * 仓库根（`root` 自身也算一个目录）不被构建产物污染。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.tmp',
  'coverage',
  'dist',
  'build',
  '.dsh-memory',
  '.cache',
  '.next',
])

/**
 * 一个「干净的本地文件名」。
 *
 * 为什么需要这条：文档里合法地会提到**别的目录/别的仓库**的 `.md` 文件
 * （例如「对方的 `design-index-first-architecture.md:191-202`」）。
 * 把它当成「本目录登记了这个文件」会产生一条假的 `missing` —— 而假的
 * 失败会训练人忽略这个检查，**比没有检查更糟**。
 *
 * 判据：不含 `:`（行号后缀）、不以 `.` 开头（`**\/*.md` 的残片）、
 * 不含路径分隔符与 Windows 非法字符。
 */
const CLEAN_FILENAME = /^[^.\/\\:*?"<>|\s][^\/\\:*?"<>|\s]*\.md$/iu

/**
 * 把索引里的一个路径 token 归到「本目录的文件名」。
 *
 * 三种形态，缺一不可：
 *
 * | 写法 | 归属 | 理由 |
 * |---|---|---|
 * | `x.md` | 本目录 | 裸文件名 |
 * | `docs/x.md` | `docs/` 目录 | 带目录，只认**本目录** |
 * | `other/x.md` | **不是本目录的** | 别处的引用，不该算进本目录 |
 *
 * 第三条是关键：仓库根的 `README.md` 会列 `docs/01-….md`，如果按 `basename`
 * 折叠，根的索引就会声称自己登记了 `01-….md` —— 而那些文件不在根目录。
 * 假失败会训练人忽略检查，比没有检查更糟。
 *
 * @param {string} token
 * @param {string} dir 被检查的目录（仓库根是 `''`）
 * @returns {string | null} 本目录的文件名；`null` = 不属于本目录
 */
function toLocalName(token, dir) {
  const posix = token.split('\\').join('/')
  const slash = posix.lastIndexOf('/')
  if (slash === -1) return posix
  const parent = posix.slice(0, slash).replace(/^\.\//, '').replace(/\/+$/, '')
  const name = posix.slice(slash + 1)
  if (!parent) return name
  return parent === dir ? name : null
}

/**
 * 从一段 Markdown 里抽出「被列出的**本目录** `.md` 文件名」。
 *
 * 保守实现：只要文件名作为**完整 token** 出现就算列出。这样三种常见写法
 * 全部命中，而不需要解析 Markdown 结构：
 *
 * - 表格：`` | [01-参考分析](01-参考分析.md) | ... | ``
 * - 反引号：`` `docs/01-参考分析.md` ``
 * - 裸列：`` - 01-参考分析.md ``
 *
 * @param {string} content
 * @param {string} [dir] 被检查的目录（仓库根是 `''`）
 * @returns {Set<string>}
 */
export function parseListedFiles(content, dir = '') {
  const listed = new Set()
  if (typeof content !== 'string' || !content) return listed
  // 文件名允许：字母数字、CJK、`.` `-` `_`，以及作为前缀的目录段（`/`）。
  // 排除的字符是 Markdown 结构符与空白 —— 它们不可能出现在文件名里。
  const token = /[^\s|()[\]`<>"'*]+\.md/gu
  let match
  while ((match = token.exec(content)) !== null) {
    /**
     * `x.md:191-202` 是**行号引用**，不是「列出了这个文件」。
     *
     * 正则的 `[^…]+` 会贪婪回溯到最后一个 `.md`，于是 `design-index-…md:191`
     * 会被切成 `design-index-…md` —— 行号被吃掉，然后被当成一条本地登记。
     * 判不了就**放过**：文档里所有跨目录/跨仓库的行号引用都会落到这一条。
     */
    if (/^:\d/.test(content.slice(match.index + match[0].length))) continue
    const name = toLocalName(match[0], dir)
    if (!name || name === ROUTE_INDEX_NAME) continue
    if (!CLEAN_FILENAME.test(name)) continue
    listed.add(name)
  }
  return listed
}

/** 安全地读一个文本文件；读不到返回 `null`（**不抛** —— 纯读路径）。 */
function readTextSafe(absolute) {
  try {
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

/** 安全地列一个目录；不存在或没权限返回 `[]`。 */
function listDirSafe(absolute) {
  try {
    return readdirSync(absolute, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 直接子目录名（**只一层**，跳过构建产物）。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listDocFolders(root) {
  return listDirSafe(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !SKIP_DIRS.has(name) && !name.startsWith('.'))
    .sort()
}

/**
 * 一个目录的路由状态。
 *
 * @param {string} root 仓库根
 * @param {string} dir 相对路径，仓库根用 `''`
 * @returns {{ dir: string, readme: string, hasReadme: boolean, files: string[], listed: string[], unlisted: string[], missing: string[] } | null}
 *   `null` = 这个目录里没有 `.md`，不参与路由（不是错误）。
 */
export function inspectFolder(root, dir) {
  const absolute = dir ? join(root, ...dir.split('/')) : root
  const entries = listDirSafe(absolute)
  if (entries.length === 0) return null

  const files = entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name) && entry.name !== ROUTE_INDEX_NAME)
    .map((entry) => entry.name)
    .sort()

  // 没有 .md 的目录不是「事实文档目录」，不参与检查。
  if (files.length === 0) return null

  const readme = dir ? `${dir}/${ROUTE_INDEX_NAME}` : ROUTE_INDEX_NAME
  const content = readTextSafe(join(absolute, ROUTE_INDEX_NAME))
  const hasReadme = content !== null
  const listed = hasReadme ? [...parseListedFiles(content, dir)].sort() : []
  const listedSet = new Set(listed)
  const fileSet = new Set(files)

  return {
    dir,
    readme,
    hasReadme,
    files,
    listed,
    // 有文件没登记
    unlisted: files.filter((name) => !listedSet.has(name)),
    // 登记了但文件没了
    missing: listed.filter((name) => !fileSet.has(name)),
  }
}

/* ── 缓存 ─────────────────────────────────────────────────────────── */

/**
 * 目录戳：`dir:mtimeMs` 的拼接。
 *
 * 为什么不能只看 `root` 的 mtime：在 `docs/` 里加文件改的是 `docs/` 的 mtime，
 * 不是 `root` 的。**只看根目录的缓存会对「新增文档」失明** —— 而新增文档
 * 恰恰是这条路由最常失效的时刻。
 *
 * @param {string} root
 * @returns {string}
 */
function folderStamp(root) {
  const parts = ['.']
  for (const dir of listDocFolders(root)) {
    let mtime = 0
    try {
      mtime = statSync(join(root, dir)).mtimeMs
    } catch {
      mtime = 0
    }
    parts.push(`${dir}:${mtime}`)
  }
  return parts.join('|')
}

/** root -> { stamp, report } */
const reportCache = new Map()

/** 测试用：清掉缓存（生产路径不需要，但缓存必须在测试之间隔离）。 */
export function clearRouteCache() {
  reportCache.clear()
}

/**
 * 全量路由报告。
 *
 * 纯读、确定性、带 mtime 缓存 —— 可以安全地放在 prompt 装配路径上
 * （`lib/hooks.js` 的 `memoryContext` 会调它，那条路径的预算是 < 5 ms）。
 *
 * @param {string} root
 * @param {{ useCache?: boolean }} [options]
 * @returns {{
 *   root: string,
 *   folders: Array<{ dir: string, readme: string, hasReadme: boolean, files: string[], listed: string[], unlisted: string[], missing: string[] }>,
 *   missingReadme: string[],
 *   unlisted: Array<{ dir: string, file: string }>,
 *   missing: Array<{ dir: string, entry: string }>,
 *   ok: boolean,
 * }}
 */
export function routeReport(root, options = {}) {
  const useCache = options.useCache !== false
  const stamp = folderStamp(root)
  if (useCache) {
    const cached = reportCache.get(root)
    if (cached && cached.stamp === stamp) return cached.report
  }

  const folders = []
  for (const dir of ['', ...listDocFolders(root)]) {
    const folder = inspectFolder(root, dir)
    if (folder) folders.push(folder)
  }
  // 仓库根排最前（`''`），其余按名字 —— `listDocFolders` 已排序，这里只保证根在前。
  folders.sort((left, right) => (left.dir === '' ? -1 : right.dir === '' ? 1 : left.dir.localeCompare(right.dir)))

  const missingReadme = folders.filter((folder) => !folder.hasReadme).map((folder) => folder.dir)
  const unlisted = folders.flatMap((folder) => folder.unlisted.map((file) => ({ dir: folder.dir, file })))
  const missing = folders.flatMap((folder) => folder.missing.map((entry) => ({ dir: folder.dir, entry })))

  const report = {
    root,
    folders,
    missingReadme,
    unlisted,
    missing,
    ok: missingReadme.length === 0 && unlisted.length === 0 && missing.length === 0,
  }

  if (useCache) reportCache.set(root, { stamp, report })
  return report
}

/**
 * 一行摘要（给 `memory_audit` 与 `check.mjs` 用）。
 *
 * @param {ReturnType<typeof routeReport>} report
 * @returns {string}
 */
export function summarizeRoutes(report) {
  if (report.ok) {
    return `目录路由健康：${report.folders.length} 个文档目录全部有索引且列全`
  }
  const parts = []
  if (report.missingReadme.length > 0) parts.push(`缺索引 ${report.missingReadme.length} 个`)
  if (report.unlisted.length > 0) parts.push(`未登记 ${report.unlisted.length} 个`)
  if (report.missing.length > 0) parts.push(`登记失效 ${report.missing.length} 个`)
  return `目录路由 ${parts.join(' · ')}（共 ${report.folders.length} 个文档目录）`
}

/**
 * 兜底提示：给 `abstain` 档用。
 *
 * 现在 `abstain` 只说「没找到」，**不说「那去哪找」**。这一句补上那个方向 ——
 * 而且给的是**确定性**的路径（读哪个 README、`glob` 什么），不是「试试别的查询」。
 *
 * @param {ReturnType<typeof routeReport> | null} report
 * @returns {string}
 */
export function routeFallbackHint(report) {
  const indexed = (report?.folders ?? []).filter((folder) => folder.hasReadme)
  if (indexed.length === 0) {
    return '> 兜底：这个仓库还没有文档索引。先 `glob("**/*.md")` 看有什么，再决定要不要建。'
  }
  const paths = indexed.slice(0, 3).map((folder) => `\`${folder.readme}\``)
  const more = indexed.length > 3 ? ` 等 ${indexed.length} 份` : ''
  return `> 兜底：先读 ${paths.join(' / ')}${more} —— 目录 README 按「你想做什么」索引到具体文件。`
}
