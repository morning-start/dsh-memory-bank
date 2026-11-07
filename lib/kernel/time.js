/**
 * 时间原语：ISO 时间戳 → 「离 `now` 过去了几天」。
 *
 * ## 为什么它必须只有一份
 *
 * 这个函数原来在 `lib/lifecycle.js` 与 `lib/promote.js` 各有一份**逐字节相同**
 * 的复制品。它们回答的是同一个问题，但喂的是**两条不同的判据**：
 *
 *   - `lifecycle.isDormant` / `suggestsDeprecation` —— 90 / 180 天没被召回，
 *     决定一条记忆是「在安睡」还是「该弃用」；
 *   - `promote.buildPromotion` 的 `dormant` 标记 —— 决定一条记忆进推广包时
 *     要不要带「90 天未被召回，可能已经不再成立」的警告。
 *
 * 于是复制品的代价不是「多几行」：有人在一处把除数从 `86_400_000` 改成
 * 别的（或补一个时区偏移），**同一条记忆就会在 `memory_audit` 里休眠、
 * 在推广包里不标注** —— 同一个问题两个答案，而两条路径各自跑得通、
 * 各自的测试都绿。
 *
 * ## 两个刻意保留的边界
 *
 *  1. **解析不出来返回 `Infinity`，不是 0。**
 *     坏时间戳（手改坏了、旧格式迁移漏了）不能当成「刚刚」——
 *     `Infinity >= 90` 让它进「该复查」的桶，那是保守方向。
 *     归零会让一条锚点坏掉的记忆**永远看起来新鲜**，于是它永远不被检查。
 *     `test/lifecycle.test.mjs` 有一条用例专门钉这个（旧实现坏值 = Infinity）。
 *
 *  2. **负数夹到 0。**
 *     时钟回拨、时区写错、CI 机器时间被改，都会造出「未来」的时间戳。
 *     负的天数会让 `freshness` 的 `2 ** (-days/halfLife)` 算出 **> 1 的分数**，
 *     而分数是概率语义 —— 一个大于 1 的「新鲜度」会静默污染排序，
 *     且没有任何断言会注意到。
 *
 * 常量 `86_400_000` 是「一天」的毫秒数。不要换成 `24 * 60 * 60 * 1000`
 * 之类看起来更可读的写法：这两个数字必须是同一个，而多一次乘法就多一个
 * 有人写错一位的机会。
 *
 * @param {string | null | undefined} iso ISO-8601 时间戳（坏值不算错，返回 Infinity）
 * @param {number} now 当前时刻（毫秒）
 * @returns {number} 天数，非负；解析失败为 `Infinity`
 */
export function daysSince(iso, now) {
  const parsed = Date.parse(iso ?? '')
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - parsed) / 86_400_000)
}
