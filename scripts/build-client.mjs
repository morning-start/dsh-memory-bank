#!/usr/bin/env node
/**
 * 把 `client/` 下的普通脚本片段拼成 `client/client.js`。
 *
 * ## 为什么要一个构建步骤，而不是直接写一个大文件
 *
 * `client/client.js` 是 `window.__ModuleLoader__` 加载的**自包含 classic
 * script**：不能 `import`，`require` 只能解析平台种子表（`.tmp-api/CONTRACT.md`
 * §1.4）。一个 3000 行的单文件能跑，但没人愿意在 `apply` 里翻四十屏找
 * `Switch` 的定义。所以拆成「片段 + 固定顺序拼接」。
 *
 * ## 为什么产物要签入
 *
 * Loader 从磁盘读 `exports["./client"]` 指向的那个文件（`CONTRACT.md` §1.6
 * 第 4 条）。发布产物里没有构建步骤 —— 所以 `client/client.js` 必须进 git，
 * 而 `test/client.test.mjs` 保证「签入的那份」与「一次全新构建」**逐字节**
 * 一致。少了这条，签入的文件会静默变旧（改了 `views/` 忘了重新构建，
 * 测试全绿而界面没变）。
 *
 * ## 为什么结果必须是确定的
 *
 * 不写时间戳、不写版本号、不读 `process.env`。同样的输入永远产出同样的
 * 字节 —— 否则上面那条一致性测试会在两个时区之间来回红。
 *
 * 用法：
 * ```bash
 * node scripts/build-client.mjs           # 重新生成并写入
 * node scripts/build-client.mjs --check   # 只比对，不一致就退出 1
 * ```
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根目录。 */
export const ROOT = resolve(HERE, '..')

/** 构建产物。`package.json` 的 `exports["./client"]` 指着它。 */
export const OUTPUT = join(ROOT, 'client', 'client.js')

/**
 * 拼接顺序就是求值顺序：先字典、再样式，然后控件、视图，最后装配点。
 *
 * `client/index.js` 必须是最后一个 —— 它在 factory 体里调用 `injectStyles()`，
 * 那时 `CSS` 已经初始化。
 */
export const PARTS = Object.freeze([
  'client/locale.js',
  'client/styles/app.js',
  'client/views/dom.js',
  'client/views/config.js',
  'client/views/memory.js',
  'client/index.js',
])

/** Loader 认的注册壳。`id` 必须等于 `package.json` 的 `name`。 */
const HEADER = `/* 由 scripts/build-client.mjs 从 client/*.js 生成 —— 不要手改。 */
window.__ModuleLoader__.load({
  id: "dsh-memory-bank",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;
`

/** 每个 shipped bundle 都以这三条语句收尾（`CONTRACT.md` §1.3）。 */
const FOOTER = `    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
`

/**
 * 生成产物源码。纯函数：只读 `PARTS` 里的文件。
 * @returns {string}
 */
export function buildClient() {
  const body = PARTS.map((part) =>
    // 仓库 `.gitattributes` 是 `eol=lf`；构建也只产出 LF，否则 Windows 上
    // 「一次全新构建」和签入的文件永远不相等。
    readFileSync(join(ROOT, part), 'utf8').replace(/\r\n/g, '\n').trimEnd(),
  ).join('\n\n')
  return `${HEADER}\n${body}\n\n${FOOTER}`
}

/** 是不是被直接执行（而不是被 `import` 进来）。 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const next = buildClient()
  const check = process.argv.includes('--check')
  if (check) {
    let current = ''
    try {
      current = readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n')
    } catch {
      console.error(`✗ ${OUTPUT} 不存在；跑 node scripts/build-client.mjs`)
      process.exitCode = 1
    }
    if (process.exitCode !== 1 && current !== next) {
      console.error('✗ client/client.js 与一次全新构建不一致；跑 node scripts/build-client.mjs 重新生成')
      process.exitCode = 1
    } else if (process.exitCode !== 1) {
      console.log(`✓ client/client.js 与构建结果一致（${next.length} 字节）`)
    }
  } else {
    writeFileSync(OUTPUT, next, 'utf8')
    console.log(`✓ client/client.js 已生成（${next.length} 字节，${PARTS.length} 个片段）`)
  }
}
