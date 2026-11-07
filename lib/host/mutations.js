/**
 * 面板 / 命令面 → 裁决域的**适配层**。
 *
 * ## 这个文件现在几乎是空的，这是设计目标
 *
 * 裁决逻辑住在 `lib/adjudicate.js`（**领域层**）。本文件只保留一个出口，
 * 让 `lib/host/service.js` / `lib/command.js` / 测试继续按原路径 import ——
 * 它们关心的是「拿到一套写操作」，不是「这套写在哪个目录下」。
 *
 * ## 为什么裁决域不留在 `host/` 下
 *
 * `host/` 的语义是「面板服务的 RPC 面」。工具面（`lib/tools.js`）也是裁决的
 * 一个入口，但它**不是面板**。把它写在 `host/` 下，等于承认「只有面板需要
 * 裁决」—— 而 0.3.x 的 `memory_resolve` 正是这么想的：它自己留了一份实现。
 *
 * 结果不是风格问题，是**数据丢失**：在面板上接受一条 merge 提案，提案被删掉、
 * 合并从未发生，界面报「已接受 merge 提议：undefined」。
 * 证据：`.tmp-audit/probe-merge-drift.mjs`。
 *
 * 所以：**裁决是领域能力，三个入口都是它的适配器。**
 *
 * | 入口 | 文件 | 只做的事 |
 * |---|---|---|
 * | 工具面 | `lib/tools.js` | 参数校验 + `MutationResult` → `MemoryError` |
 * | 命令面 | `lib/command.js` | 解析 + `MutationResult` → `{ kind, text }` |
 * | 面板面 | `lib/host/service.js` | `MutationResult` 原样过 RPC |
 */

export { EDITABLE_FIELDS, createAdjudicator as createMutations, pickClaimPatches, pickEditable } from '../adjudicate.js'
