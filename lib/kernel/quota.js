/**
 * 配额棘轮状态 —— 面板与工具面共用的**唯一**读取实现。
 *
 * ## 为什么它在 `kernel/` 里
 *
 * 这个函数原来有两份：`lib/tools.js` 的私有版本，和 `lib/host/queries.js` 里
 * 一份注释里自认「这是 `lib/tools.js` 私有 `readQuotaState` 的镜像」的复制品。
 * 两处读的是**同一个** `quota.lock.json`，所以这里没有「两种语义各有道理」的
 * 借口 —— 只要一侧多改一个字节，`/memory status` 和面板就会对同一个仓库报出
 * 两个配额，而 `docs/08-代码审核.md` 的「双实现漂移」说的正是这个失败模式：
 * 一份改了一处、另一份没跟上，552 条测试全绿，界面静默地给错答案。
 *
 * ## 两个不变量（都来自真实踩过的坑，不是设计洁癖）
 *
 *  1. **路径走 `layout`,不手拼。** 上一版写 `${root}/.dsh-memory/quota.lock.json`，
 *     与目录布局各自为政 —— 改布局就静默失联，读到的永远是「文件不存在」，
 *     于是棘轮永不生效、写入永不设限。失联的失败方向是**静默放行**，最坏的一种。
 *
 *  2. **手写坏掉的锁文件不能把全库变成只读。** 校验不过必须降级回 `null`。
 *     原样返回的后果是：`{"mode":"ratchet"}`（没有 `maxActive`）让
 *     `limit = used`，而 `used < limit` 恒假 —— **每一次写入都被拒，包括空库**。
 *     用户手里只剩一个「删掉锁文件」的逃生口，而那时他已经不相信这个插件了。
 *
 * 返回值契约（调用方**必须**按这个理解，不要各读各的）：
 *
 *   - 文件不存在 / 不是对象 / JSON 坏掉 → `null`（= growth 的默认态）；
 *   - `mode: 'ratchet'` 但没有可用的 `maxActive` → `null`（降级，见上）；
 *   - 否则 `{ ...原样字段, maxActive: number | null }`。
 *
 * `maxActive: null` 在「`mode` 不是 `ratchet`」时是正常形态：`growth` 阶段
 * 还没有算出上限，上限由 `config.quota.repo` 兜底。
 *
 * @param {string} root 仓库根（绝对路径）
 * @returns {Record<string, unknown> | null}
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { layout } from '../store.js'

export function readQuotaState(root) {
  const file = join(layout(root).base, 'quota.lock.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    // `Number()` 而不是 `typeof === 'number'`：手写的锁文件里 `"maxActive": "200"`
    // 是常见形态（有人用编辑器改过），而拒绝它等于让棘轮静默失效。
    // 非整数（`200.5` / `NaN` / `""`）一律当「不可用」，见上面的降级规则。
    const maxActive = Number(parsed.maxActive)
    const usable = Number.isInteger(maxActive) && maxActive > 0
    if (parsed.mode === 'ratchet' && !usable) return null
    return { ...parsed, maxActive: usable ? maxActive : null }
  } catch {
    // 坏 JSON 走这里。**不能抛** —— 这个函数跑在每轮 prompt 装配路径上，
    // 一个手改坏的锁文件不该让整个会话起不来。
    return null
  }
}
