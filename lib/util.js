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

/** 短哈希（16 hex），用于符号切片指纹。 */
export function shortHash(text) {
  return sha256(text).slice(0, 16)
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
  const out = {}
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[key] = sortKeys(value[key])
  }
  return out
}

/* ── 原子写 ───────────────────────────────────────────────────────── */

/**
 * 先写临时文件再 rename，读者永远看不到半个文件。
 * Windows 上 rename 到已存在文件会失败，所以先删目标（同目录，同一卷，不会跨设备）。
 */
export function writeFileAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  try {
    rmSync(filePath, { force: true })
  } catch {
    /* 目标本来就不存在 */
  }
  renameSync(tmp, filePath)
}

/* ── 路径 ─────────────────────────────────────────────────────────── */

/** 仓库相对 POSIX 路径；越界返回 null（证据路径不允许逃出仓库）。 */
export function toRepoPath(root, absolutePath) {
  const rel = relative(root, absolutePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** POSIX 规范化（去掉 ./、折叠 //）。 */
export function normalizeRef(ref) {
  return String(ref).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

/* ── 分词 ─────────────────────────────────────────────────────────── */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/
const WORD = /[a-z0-9]+/g
const CAMEL = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g

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

/** 标识符片段：camelCase / snake_case / kebab-case 拆开后的小写词。 */
export function identifierFragments(text) {
  const out = new Set()
  const raw = String(text ?? '')
  for (const piece of raw.split(/[^A-Za-z0-9]+/)) {
    if (!piece) continue
    for (const part of piece.match(CAMEL) ?? []) {
      if (part.length >= 2) out.add(part.toLowerCase())
    }
  }
  return [...out]
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

/** 有界 Levenshtein（超过 maxDistance 提前返回 maxDistance + 1）。 */
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
  return previous[t.length]
}

/* ── 时间 ─────────────────────────────────────────────────────────── */

/** ISO-8601 UTC，秒级（记忆不需要毫秒，秒级让 diff 稳定）。 */
export function isoNow(clock = Date.now) {
  return new Date(clock()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** `YYYY-MM-DD`。 */
export function isoDay(clock = Date.now) {
  return new Date(clock()).toISOString().slice(0, 10)
}

/** 两个 ISO 时间之间相差多少天（`to` 缺省为今天）。 */
export function daysBetween(fromIso, toIso = new Date().toISOString()) {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY
  return Math.max(0, (to - from) / 86_400_000)
}

/* ── 杂项 ─────────────────────────────────────────────────────────── */

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function uniq(items) {
  return [...new Set(items)]
}

/** 折叠空白，用于一行摘要。 */
export function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 截断到 n 个字符，超出加省略号。 */
export function truncate(text, n) {
  const s = String(text ?? '')
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`
}

export function joinLines(...parts) {
  return parts.filter((part) => typeof part === 'string' && part.length > 0).join('\n')
}

export { join, resolve }
