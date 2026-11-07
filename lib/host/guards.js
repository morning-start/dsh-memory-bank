/**
 * 写守卫：并发、乐观并发、破坏性二次确认。
 *
 * **这个文件存在的唯一理由是「两次点击不能产生两次写入」。**
 * 界面上的按钮没有幂等性 —— 用户双击、网络重试、两个标签页同时打开，
 * 都会把同一次「接受」发两遍。命令面没有这个问题（人一次只敲一条），
 * 但面板有，而面板是这次新加的东西。
 *
 * 三道闸，各挡一类：
 *
 *  1. **写锁（按 root）**：同一时刻只允许一次写入进入临界区。同一次调用栈里
 *     重入直接拒绝 —— 一个 `accept` 里再去 `accept` 是逻辑错误，不是并发。
 *  2. **revision 计数器（按 root）**：每次成功写入 +1。调用方带 `expectedRevision`
 *     时，对不上就整体拒绝（`stale-revision`），而不是「后写覆盖先写」。
 *  3. **`hard_delete` 二次确认**：**只认 `=== true`**。真值判断不够 ——
 *     `"false"` 字符串、`1`、`[]` 都会让「永久删除」在一个拼错的参数上发生。
 *
 * ## 为什么锁是同步的
 *
 * `lib/host/mutations.js` 里**每一个写操作都是同步的**（文件写入走
 * `writeFileAtomic`，没有 `await`）。所以「锁」不需要 Promise 队列：
 * Node 单线程下，一次同步调用天然不可分割。
 *
 * 但这条不变量必须**被检查**，不能靠约定 —— `withWriteLock` 看到回调返回
 * Promise 就抛 `AsyncMutationError`。否则将来某人给 `accept` 加一个 `await`，
 * 锁会在第一个 `await` 处松开，而**没有任何测试会红**。那正是「两道闸只剩一道」
 * 的经典事故。
 */

/** 写锁冲突：同一 root 上已有一次写入在进行中。 */
export class WriteLockedError extends Error {
  constructor(root) {
    super(`memory-bank: ${root} 上已有一次写入正在进行 —— 这次提交被丢弃，不会产生第二次写`)
    this.name = 'WriteLockedError'
    this.code = 'write-locked'
    this.root = root
  }
}

/**
 * 乐观并发冲突。
 *
 * 带 `expectedRevision` 的调用方（面板的 staged form）在别处已经写过之后
 * 会拿到它 —— 这时候**必须让用户看见新的值**，而不是静默覆盖。
 */
export class StaleRevisionError extends Error {
  constructor(expected, actual) {
    super(`memory-bank: 配置已被改过（期望 revision ${expected}，实际 ${actual}）—— 请刷新后重试，不要覆盖别人的保存`)
    this.name = 'StaleRevisionError'
    this.code = 'stale-revision'
    this.expected = expected
    this.actual = actual
  }
}

/**
 * 破坏性操作缺少确认。
 *
 * `code` 是给界面判断「要不要弹二次确认」用的 —— 类型契约里
 * `MutationResult.code` 就是这么用的（`shared/types.d.ts`）。
 */
export class ConfirmRequiredError extends Error {
  constructor(what) {
    super(`memory-bank: ${what} 需要显式确认（confirm: true）。这是**用户的确认**，不是调用方能自己给的`)
    this.name = 'ConfirmRequiredError'
    this.code = 'confirm-required'
    this.what = what
  }
}

/** 写操作返回了 Promise —— 锁会在 `await` 处松开，等于没有锁。 */
export class AsyncMutationError extends Error {
  constructor(operation) {
    super(`memory-bank: 写操作 ${operation} 返回了 Promise —— 本模块的写锁只对同步临界区有效。要改成异步，必须同时换成队列式锁，并补一条并发测试`)
    this.name = 'AsyncMutationError'
    this.code = 'async-mutation'
    this.operation = operation
  }
}

/**
 * 创建一套守卫。
 *
 * 默认应当**全局共享一份**（见文件末尾的 `sharedGuards`）：命令面和面板服务是
 * 两个写者，各自一份锁等于没有锁。
 *
 * @param {{ coalesceMs?: number }} [options] 保留参数（当前未使用，留给将来的双击合并）
 */
export function createGuards(options = {}) {
  void options
  /** @type {Map<string, number>} root -> 已完成的写入次数 */
  const revisions = new Map()
  /** @type {Set<string>} 正在写入的 root */
  const inFlight = new Set()

  return {
    /** 当前 revision。界面保存时要把它原样带回来。 */
    revision(root) {
      return revisions.get(root) ?? 0
    },

    /**
     * 进临界区。**同步**：回调必须同步完成，否则抛 `AsyncMutationError`。
     *
     * 锁**不管 revision** —— 失败的写（`{ ok: false }`）没有改变任何东西，
     * 不该让别人的乐观并发失效。`mutations.js` 的 `run()` 在 `ok === true`
     * 时显式调 `bump()`，这样「拒绝一条不存在的提案」不会平白让面板的
     * staged form 变脏。
     */
    withWriteLock(root, fn) {
      if (inFlight.has(root)) throw new WriteLockedError(root)
      inFlight.add(root)
      try {
        const result = fn()
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          // 注意：这里不能 `await` —— 那正是问题本身。丢弃这个 Promise 前先挂一个
          // 空 catch，否则它会变成 unhandled rejection，把真正的错误盖掉。
          result.then(undefined, () => {})
          throw new AsyncMutationError(String(fn?.name ?? 'mutation'))
        }
        return result
      } finally {
        inFlight.delete(root)
      }
    },

    /** 一次**成功**的写入之后调用。见 `withWriteLock` 的注释。 */
    bump(root) {
      revisions.set(root, (revisions.get(root) ?? 0) + 1)
    },

    /**
     * 乐观并发：`expectedRevision` 为 `undefined` / `null` 时**不做检查**
     * （面板的「直接保存」路径）；给了就必须对得上。
     */
    assertRevision(root, expectedRevision) {
      if (expectedRevision === undefined || expectedRevision === null) return
      const actual = revisions.get(root) ?? 0
      if (actual !== expectedRevision) throw new StaleRevisionError(expectedRevision, actual)
    },

    /** `hard_delete` 的第二次确认。**只认 `=== true`** —— 见文件头第 3 条。 */
    requireConfirm(confirm, what = 'hard_delete') {
      if (confirm !== true) throw new ConfirmRequiredError(what)
    },

    /** 测试用：清空全部状态。 */
    reset() {
      revisions.clear()
      inFlight.clear()
    },
  }
}

/**
 * 进程级共享守卫。
 *
 * 命令面（`lib/command.js`）与面板服务（`lib/host/service.js`）必须拿**同一份**：
 * 两份 lock 谁都不认识谁，于是「两个入口同时写」就真的能发生。
 */
export const sharedGuards = createGuards()
