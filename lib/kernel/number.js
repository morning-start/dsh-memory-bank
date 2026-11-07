/**
 * 参数归一化：把「可能来自 JSON / 环境变量 / 命令行」的值收进整数区间。
 *
 * ## 为什么统一到 `Number(value)` 强转版
 *
 * 这个函数原来有两份：`lib/tools.js` 只接受 `typeof value === 'number'`，
 * `lib/host/queries.js` 多一步 `Number(value)` 强转。两份的唯一差别是
 * **字符串 `"5"` 收不收**。
 *
 * 选强转版不是因为「宽松一点更友好」，而是因为**这个函数的全部调用方做的都是
 * 配置 / 参数归一化**。配置来自 `config.json`、环境变量、CLI 参数 ——
 * 这些来源里的数字，除了 JSON 数字字面量之外**每一处都是字符串**：
 *
 *     "quota": { "repo": "200" }        // 用户手写的 jsonc，引号是手滑
 *     MEMORY_LIMIT=5                    // 环境变量天然是字符串
 *     --limit 5                         // argv 天然是字符串
 *
 * 拒绝 `"5"` 不会让配置更安全，只会让上面每一种写法**静默退化成 fallback**：
 * 用户以为设了 5，实际拿到的是默认值 10，而且没有任何地方会告诉他。静默降级
 * 是 0.1.0 最贵的债（见 `lib/config/` 的 `problems` 设计）。
 *
 * 强转也没有放过任何本来就该拒绝的东西：`Number("abc")` 是 `NaN`，下面
 * `Number.isFinite` 一道就挡住；`Number(null)` 是 0，会被 `Math.max(min, …)`
 * 抬回 `min` —— 那是「没给」的合理形态，不是注入面。
 *
 * ## 三个边界一起看才是一个函数
 *
 *  1. **非有限值 → `fallback`**。`NaN` / `Infinity` / 非数字字符串都归这里。
 *     注意 `Infinity` 必须拦：`Math.floor(Infinity)` 还是 `Infinity`，
 *     夹取之后变成 `max`，于是一个坏参数会静默变成「要最多」。
 *  2. **小数向下取整**。`limit: 3.9` 是「3 条」，不是「4 条」——
 *     条数是离散的，向上取整等于多给一条。
 *  3. **夹在 `[min, max]` 之间**。上界由 `shared/endpoints.js` 的注释给出，
 *     不是这里图的方便。
 *
 * @param {unknown} value 原始值（可能是数字、字符串、`undefined`）
 * @param {{ min: number, max: number, fallback: number }} bounds
 * @returns {number}
 */
export function clampInt(value, { min, max, fallback }) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}
