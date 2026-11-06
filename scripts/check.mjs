#!/usr/bin/env node
/**
 * 语法检查：`node --check` 跑遍 `lib/**`。
 *
 * 为什么不写在 package.json 里：`node --check lib/*.js` 靠 shell 展开，
 * 而 Windows 的 cmd 不展开通配符 —— 于是这个脚本在 CI 上会静默只检查
 * 一个名字里带星号的文件，然后报「检查通过」。**静默失效的检查比没有检查更糟。**
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['lib', 'test', 'bench', 'scripts']
let checked = 0
const failures = []

for (const root of roots) {
  let names
  try {
    names = readdirSync(root)
  } catch {
    continue
  }
  for (const name of names) {
    if (!/\.(mjs|js)$/.test(name)) continue
    const file = join(root, name)
    if (!statSync(file).isFile()) continue
    checked += 1
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      failures.push({ file, message: String(error?.stderr ?? error?.message ?? error).trim() })
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
