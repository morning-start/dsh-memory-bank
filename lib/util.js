/**
 * 纯工具：哈希、稳定序列化、原子写、分词、相似度。
 *
 * 这一层没有业务语义，也不 import 任何 DSH 包 —— 可直接被 node --test 跑。
 * 所有函数都是确定性的：同样的输入永远同样的输出（`now` 由调用方注入）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/* ── 哈希 ─────────────────────────────────────────────────────────── */

/** sha256 十六进制。 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/* ── 稳定序列化 ───────────────────────────────────────────────────── */

/**
 * 递归按 key 排序的 JSON。`JSON.stringify` 保序，而两个来源（磁盘 vs 内存）
 * 的 key 顺序不保证一致 —— 不归一化就会每次重建快照。
 */
export function stableJson(value, space = 0) {
  return JSON.stringify(sortKeys(value), null, space)
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  // `Object.create(null)` 而不是 `{}`：`out['__proto__'] = x` 在普通对象上改的是
  // 原型不是自有属性，那个键会**从输出里静默消失**。ledger / stats / receipts
  // 都靠这个函数保真，丢一个键就是丢一条审计记录。
  const out = Object.create(null)
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = sortKeys(value[key])
  }
  return out
}

/* ── 原子写 ───────────────────────────────────────────────────────── */

/**
 * 先写临时文件再 rename，读者永远看不到半个文件。
 *
 * **不要先 `rmSync` 目标再 rename。** 曾经这里写着「Windows 上 rename 到已存在
 * 文件会失败，所以先删目标」—— 那是错的：Node 的 `renameSync` 在 Windows 上走
 * `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`，直接覆盖是成功的。
 *
 * 而「先删」会平白造出一个**目标不存在**的窗口：进程崩在 rm 与 rename 之间，
 * 记忆文件就消失了，新内容还停在 `.tmp-*` 里。读者看到的不是「半个文件」，
 * 是「没有文件」—— 比半个更糟。
 *
 * 失败必须清掉 tmp：否则每次磁盘满 / 权限错都在目录里留一坨垃圾。
 */
export function writeFileAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  /**
   * 临时名必须**进程内唯一**，不能只靠 `Date.now()`。
   *
   * 毫秒精度意味着「同一毫秒、同一进程、同一目标」的两次写会算出**同一个**
   * 临时名 —— 于是第二个 `writeFileSync` 覆盖第一个的临时文件，两个
   * `rename` 里有一个搬走的是别人的内容。Windows 上后果更直接：`rename`
   * 撞上已被搬走的路径会 `EPERM`，而原子性已经在那之前没了。
   *
   * 用**单调计数器**而不是随机数：同一个进程里两次写的名字可预测，
   * 复现问题时不用猜。
   */
  tmpSeq = (tmpSeq + 1) % 0x1000000
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${tmpSeq.toString(36)}`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清不掉也只能算了，别盖住真正的错误 */
    }
    throw error
  }
}

/** 进程内单调的临时文件序号。见 `writeFileAtomic` 的注释。 */
let tmpSeq = 0

/* ── 路径 ─────────────────────────────────────────────────────────── */

/**
 * 这个平台**默认**大小写不敏感。
 *
 * 只在「判断两个路径是不是同一个文件」时用；判断「在不在仓库内」必须用
 * 原始大小写（见 `canonicalPath` 的注释）。
 */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/** 仓库相对 POSIX 路径；越界返回 null（证据路径不允许逃出仓库）。 */
export function toRepoPath(root, absolutePath) {
  const rel = relative(root, absolutePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * 路径**身份**：判断「是不是同一个文件」时唯一该用的函数。
 *
 * ## 与另外两个函数的分工（这是本文件里最容易搞混的三件事）
 *
 * | 函数 | 回答的问题 | 大小写 |
 * |---|---|---|
 * | `toRepoPath` | 在仓库内吗？ | **原样** —— 它同时用于读取，读取必须保留大小写 |
 * | `normalizeRef` | 怎么**展示**这条锚点？ | **原样** —— 序列化进 frontmatter 的形态 |
 * | `canonicalPath` | 是不是**同一个文件**？ | **按平台折叠** —— 只用于集合比对 |
 *
 * ## 为什么折叠必须按平台
 *
 * Linux 上 `src/Foo.ts` 与 `src/foo.ts` 是**两个文件**。无条件折叠会把
 * 两条不同的证据锚点合并成一条，制造假的「已读过」。
 *
 * 而 Windows / macOS 默认大小写不敏感 —— 不折叠就是对方
 * `learnings/2026-02-03-recovery-gate-case-mismatch.md` 那个死锁：
 * 存的时候是大写（`memory-bank/MEMORY.md`）、比的时候小写，
 * `Set.has()` 恒 false，**gate 永不解除**。
 *
 * 所以规则只有一条：**存和取必须用同一个函数**。想比路径，就调它。
 *
 * @param {string} root 仓库根（绝对路径）
 * @param {string} raw 绝对路径或相对 root 的路径
 * @returns {string | null} 折叠后的仓库相对 POSIX 路径；越界返回 `null`
 */
export function canonicalPath(root, raw) {
  if (typeof raw !== 'string' || raw === '') return null
  const absolute = isAbsolute(raw) ? raw : resolve(root, raw)
  const rel = toRepoPath(root, absolute)
  if (rel === null) return null
  return CASE_INSENSITIVE_FS ? rel.toLowerCase() : rel
}

/**
 * POSIX 规范化（去掉 `./` 开头的、折叠 `//`、折叠 `\`、去首尾空白）。
 *
 * **这是展示 / 序列化形态，不是身份形态** —— 它**不折叠大小写**。
 * 比路径请用 `canonicalPath`。
 *
 * `recall.js` 的 `exactNormalize` 曾经是它的**第二份实现**（多了
 * `toLowerCase`、少了 `//` 折叠）。两份实现漂移的代价不是「多几行」，
 * 而是「同一件事在两个地方有两个答案」—— 所以现在只有这一份，
 * 折叠大小写由调用方显式加。
 */
export function normalizeRef(ref) {
  return String(ref ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
}

/* ── 分词 ─────────────────────────────────────────────────────────── */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/
const WORD = /[a-z0-9]+/g

/**
 * 分词：CJK 逐字（不查词典）+ 拉丁词（小写）+ 标识符片段。
 * 确定性、无依赖；中文靠字级 n-gram 补形态。
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return []
  const out = []
  const lower = text.toLowerCase()
  let m
  WORD.lastIndex = 0
  while ((m = WORD.exec(lower)) !== null) out.push(m[0])
  for (const ch of text) {
    if (CJK.test(ch)) out.push(ch)
  }
  return out
}

/** 字符 3-gram（用于中文与拼写近似）。 */
export function ngrams(text, n = 3) {
  const chars = [...String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()]
  if (chars.length < n) return chars.length ? [chars.join('')] : []
  const out = new Set()
  for (let i = 0; i + n <= chars.length; i += 1) out.add(chars.slice(i, i + n).join(''))
  return [...out]
}

/* ── 相似度 ───────────────────────────────────────────────────────── */

/** Jaccard。两集合都空视为 0（"都不像"不是"完全一样"）。 */
export function jaccard(a, b) {
  const setA = a instanceof Set ? a : new Set(a)
  const setB = b instanceof Set ? b : new Set(b)
  if (setA.size === 0 && setB.size === 0) return 0
  let intersection = 0
  for (const item of setA) if (setB.has(item)) intersection += 1
  return intersection / (setA.size + setB.size - intersection)
}

/**
 * 有界 Levenshtein。
 *
 * 返回值契约：**大于 `maxDistance` 时一律返回 `maxDistance + 1`**（截断值），
 * 只有 ≤ `maxDistance` 时才返回真距离。
 *
 * 曾经两条提前返回走 `maxDistance + 1`、而「跑完全程」那条返回真距离 ——
 * 于是 `levenshtein("aa","bbbb",2)` 返回 4。当前唯一调用方对两种结果都 `continue`
 * 所以没出事，但任何将来写 `if (d === maxDistance + 1)` 的代码都会错。
 */
export function levenshtein(a, b, maxDistance = 2) {
  const s = [...String(a ?? '')]
  const t = [...String(b ?? '')]
  if (Math.abs(s.length - t.length) > maxDistance) return maxDistance + 1
  let previous = Array.from({ length: t.length + 1 }, (_, i) => i)
  for (let i = 1; i <= s.length; i += 1) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      current.push(value)
      if (value < rowMin) rowMin = value
    }
    if (rowMin > maxDistance) return maxDistance + 1
    previous = current
  }
  return Math.min(previous[t.length], maxDistance + 1)
}

/* ── 时间 ─────────────────────────────────────────────────────────── */

/** ISO-8601 UTC，秒级（记忆不需要毫秒，秒级让 diff 稳定）。 */
export function isoNow(clock = Date.now) {
  return new Date(clock()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/* ── 杂项 ─────────────────────────────────────────────────────────── */

/** 折叠空白，用于一行摘要。 */
export function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 截断到 n 个字符，超出加省略号。
 *
 * 按**码点**切，不按 UTF-16 码元：`s.slice(0, n-1)` 会把 emoji 切成孤立代理项，
 * 产出的字符串在注入 prompt / 写进 JSON 时是非法 UTF-16。
 */
export function truncate(text, n) {
  const chars = [...String(text ?? '')]
  return chars.length <= n ? chars.join('') : `${chars.slice(0, Math.max(0, n - 1)).join('')}…`
}

export { join, resolve }


