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
import { readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

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
