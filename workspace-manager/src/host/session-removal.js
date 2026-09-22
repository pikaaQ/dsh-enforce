// dsh-workspace-manager — 「会话清理」宿主服务（给**别的插件**用）
//
// 为什么要有这个服务：彻底删除一个会话只能靠文件级删除（内核
// `dsh-session-persistence` 只有 create/open/stat/list/flush，官方 session RPC 里也没有删除动词），
// 而这份实现（remove-session.js）里全是踩出来的安全栅栏。与其让每个需要清理临时会话的插件
// 各自再写一份，不如把它作为**宿主服务**发布出去：
//
//     机制归本插件，策略归调用方。
//     本插件只负责"怎么安全地删"；"哪些会话是我的临时会话、什么时候算完事"只有调用方知道。
//
// 发布与获取（cordis 原语，也是本版本 DSH 里插件间共享服务的实际做法）：
//   提供方 `ctx.provide('sessionRemoval', api)`（宿主半区可用动词白名单里有 provide）；
//   消费方 `ctx.get('sessionRemoval')` **探测式**获取。
//   ⚠️ 消费方**不要**把这个名字写进模块级 `inject`：那样本插件不装（或版本不匹配）时，
//   cordis 会把消费方整行 parked，它的功能会跟着一起消失。探测式获取才能优雅降级。
//
// 服务面（所有方法都可能抛 `SessionRemovalError`，带 `code`）：
//   claim(owner, ids, { parentSessionId })  登记"这些会话是我产出的"（白名单）+ **父会话指针**
//                                           返回 claimed/alreadyClaimed/parentUpdated/rejected
//   release(owner, ids)   撤销登记（调用方放弃清理、或发现会话不是自己的时用）
//   claimsOf(owner)       某个 owner 当前登记着的 id（副本；同步视图，见下面的 ready 说明）
//   remove(id, { owner }) 删除一个**已由该 owner 登记**的会话
//
// 登记是**持久化**的（`$DSH_HOME/dsh-workspace-manager.claims.json`，见 claims-store.js）：
//   为什么必须落盘 —— 内核没有"谁是谁的子会话"这份数据（子会话投影缓存的 identity 里没有父字段），
//   而设置页的会话树、"删父会话连带子会话"都要跨重启仍然成立。
//   `parentSessionId` 只在**显式给出**时改写：补删路径（启动 sweep）重复 claim 时不带父，
//   因此不会把第一次记下的父指针抹掉。
//   账本里还会有本插件自己**观察**学到的条目（`source: 'observed'`，**没有 owner**）——
//   平台自带的 `subagent` / `subagent_fork` 不走 claim，那些边只能由运行时观察补上。
//   观察条目**不算"别人登记过"**：claim 会把它升级成登记条目（没给父时保留已观察到的父指针）。
//   ⚠️ 因为要落盘，`claim`/`release` 都是**异步**的（服务面版本因此升到 2）；但内存改动在
//   await 之前就已生效，所以调用方万一忘了 await，进程内的白名单判断依然正确。
//
// 安全栅栏（判定全部发生在触碰任何文件之前）：
//   1. `owner` 必填（非空字符串）：没有 owner 就没有白名单 → `bad-request`；
//   2. 只有**已由该 owner 登记**的 id 能被服务删除，否则 `not-claimed`——
//      防止"另一个插件顺手把自己不认识的会话删了"；
//   3. 活跃会话一律拒绝（`session-active`）：活会话的写句柄还持有工件，抽掉会写坏；
//   4. id 形态（`^[A-Za-z0-9][A-Za-z0-9._-]*$`、不含 `..`）、路径 containment、
//      `attachments/` 不可触碰等硬边界全部由 remove-session.js 保证（本文件不自己拼路径）；
//   5. 工件早就不在 → `session-not-found`：调用方按"已清理"处理即可，同时登记被释放。
//
// ⚠️ 诚实说明：`owner` 是**协作式栅栏**，不是安全边界——cordis 的服务调用不带调用方身份，
// 名字由调用方自报。它挡的是"插件之间的意外互删"，挡不住故意冒充。

import { openClaimsStore } from './claims-store.js'
import { SessionRemovalError, isSafeSessionId } from './remove-session.js'

/** 服务名（消费方按这个名字 `ctx.get()`）。 */
export const SESSION_REMOVAL_SERVICE = 'sessionRemoval'

/** 服务接口版本（未来若改语义，消费方可据此拒绝）。v2：claim/release 变为异步 + 支持父指针。 */
export const SESSION_REMOVAL_SERVICE_VERSION = 2

const fail = (code, message) => {
  throw new SessionRemovalError(code, message)
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** 规范化 id 列表：非字符串/空串丢弃，保留原顺序并去重（不安全 id 留给各方法自己拒绝）。 */
function normalizeIds(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (!isNonEmptyString(item)) continue
    if (!out.includes(item)) out.push(item)
  }
  return out
}

function assertOwner(owner) {
  if (!isNonEmptyString(owner)) {
    fail('bad-request', 'owner is required: a non-empty string identifying the calling plugin (it is the whitelist key)')
  }
  return owner
}

/**
 * 构造会话清理服务。
 * @param options - `{ ctx, performRemoval, claimsStore?, logger?, serviceName? }`
 *   - `ctx`：宿主上下文（只需要 `sessions.get` / `agents.get` 做活跃判定）；
 *   - `performRemoval`：`async (sessionId) => report`，**唯一的删除实现**（由 index.js 提供，
 *     与 RPC 端点共用同一个函数，所以两侧行为不可能漂移）；
 *   - `claimsStore`：登记表（见 claims-store.js）。**端点与这里必须传同一个实例**，
 *     否则"端点删完会话忘了登记"与服务内存里的登记会不一致；缺省时自己开一份默认路径的。
 *   - `serviceName`：默认 {@link SESSION_REMOVAL_SERVICE}。
 * @returns 服务对象。
 */
export function createSessionRemovalService({ ctx, performRemoval, claimsStore, logger, serviceName = SESSION_REMOVAL_SERVICE } = {}) {
  if (typeof performRemoval !== 'function') {
    throw new TypeError('createSessionRemovalService 需要 performRemoval(sessionId) 作为唯一删除实现')
  }
  /** 登记表（持久化，跨重启有效）。父指针就存在这里 —— 内核没有这份数据。 */
  const store = claimsStore ?? openClaimsStore({ logger })
  /** 读盘完成前不读登记（否则会把"还没读完"当成"没有登记"）。 */
  const ready = store.ready

  /** 活跃会话判定（与端点同一算法）：内存里的 handle / agent 还在跑就先拒绝。 */
  const isActive = (sessionId) =>
    ctx?.sessions?.get?.(sessionId) !== undefined || ctx?.agents?.get?.(sessionId) !== undefined

  const assertSafeId = (sessionId) => {
    if (!isNonEmptyString(sessionId)) fail('bad-request', 'sessionId must be a non-empty string')
    if (!isSafeSessionId(sessionId)) {
      fail('bad-request', `session id ${JSON.stringify(sessionId)} is not a safe directory name`)
    }
    return sessionId
  }

  /**
   * 规范化可选的父指针。
   * 缺省 / null / 空串 = "没有父"（补删路径重复 claim 时会走到这里，不能把已知的父抹掉）；
   * 形态不安全 = `bad-request`（调用方传了垃圾要立刻知道，不能静默丢弃）。
   */
  function normalizeParent(value) {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') fail('bad-request', 'parentSessionId must be a string session id when provided')
    if (value.trim() === '') return null
    if (!isSafeSessionId(value)) fail('bad-request', `parentSessionId ${JSON.stringify(value)} is not a safe session id`)
    return value
  }

  /**
   * 登记一批 id 的产出者（+ 可选父会话指针）。已被**别人**登记的不抢占，只报告。
   *
   * 幂等语义：同一个 owner 重复 claim 已在册的 id → `alreadyClaimed`（不重复写盘）；
   * 这次**显式给了父**且与记住的不同 → 更新父指针并报进 `parentUpdated`。
   * 账本里只有**运行时观察**条目（`source: 'observed'`）时不算"别人登记过"：
   * 这次 claim 把它升级成登记条目并报进 `claimed`。
   * @param owner - 调用方自报的 owner（白名单键）。
   * @param sessionIds - id 数组（非字符串/空串丢弃，去重）。
   * @param options - `{ parentSessionId? }`。
   * @returns `{ owner, parentSessionId, claimed, alreadyClaimed, parentUpdated, rejected }`。
   */
  async function claim(owner, sessionIds, options = {}) {
    const who = assertOwner(owner)
    const parentSessionId = normalizeParent(options?.parentSessionId)
    await ready
    const claimed = []
    const alreadyClaimed = []
    const parentUpdated = []
    const rejected = []
    const writes = []
    const now = Date.now()
    for (const sessionId of normalizeIds(sessionIds)) {
      if (!isSafeSessionId(sessionId)) {
        rejected.push({ id: sessionId, reason: 'unsafe-id' })
        continue
      }
      // 自引用：树那边也会防御，但在登记处就拒掉 —— 这种父子关系没有任何意义。
      if (parentSessionId !== null && parentSessionId === sessionId) {
        rejected.push({ id: sessionId, reason: 'self-parent' })
        continue
      }
      const existing = store.get(sessionId)
      // 没有登记过，或账本里只有一条**运行时观察**学到的边（`source: 'observed'`，没有 owner）：
      // 观察条目不是任何人的登记，生产者 claim 把它**升级**成登记条目（登记优先于观察）。
      // 没显式给父时保留已观察到的父指针 —— 由 claims-store 的 mergeEntry 保证。
      if (existing === undefined || existing.source === 'observed') {
        writes.push({ id: sessionId, owner: who, parentSessionId, claimedAt: now })
        claimed.push(sessionId)
        continue
      }
      if (existing.owner !== who) {
        rejected.push({ id: sessionId, reason: 'claimed-by-other', owner: existing.owner })
        continue
      }
      alreadyClaimed.push(sessionId)
      // 只在这次显式给了父、且与记住的不同时才改：不带父的重复 claim 不会抹掉已知的父指针。
      if (parentSessionId !== null && existing.parentSessionId !== parentSessionId) {
        writes.push({ id: sessionId, owner: who, parentSessionId, claimedAt: existing.claimedAt ?? now })
        parentUpdated.push(sessionId)
      }
    }
    if (writes.length > 0) await store.setMany(writes)
    return { owner: who, parentSessionId, claimed, alreadyClaimed, parentUpdated, rejected }
  }

  /** 撤销登记：只撤自己登记的（别人的登记动不了）。 */
  async function release(owner, sessionIds) {
    const who = assertOwner(owner)
    await ready
    const released = []
    const notClaimed = []
    for (const sessionId of normalizeIds(sessionIds)) {
      const entry = store.get(sessionId)
      if (entry !== undefined && entry.owner === who) released.push(sessionId)
      else notClaimed.push(sessionId)
    }
    if (released.length > 0) await store.delete(released)
    return { owner: who, released, notClaimed }
  }

  /** 某个 owner 当前登记着的 id（副本）。**同步视图**：首次 `await`（或 `await service.ready`）后才反映磁盘内容。 */
  function claimsOf(owner) {
    return store.idsOf(assertOwner(owner))
  }

  /**
   * 删除一个会话（机制复用 remove-session.js，行为与 RPC 端点完全一致）。
   * @param sessionId - 会话 id（必须已由 `owner` 登记）。
   * @param options - `{ owner }`（必填）。
   * @returns 与端点 `remove` 相同的报告。
   */
  async function remove(sessionId, options = {}) {
    const owner = assertOwner(options?.owner)
    const id = assertSafeId(sessionId)
    await ready
    // ① 白名单：没登记过、或登记在别人名下 → 不碰文件。
    const entry = store.get(id)
    if (entry === undefined) {
      fail('not-claimed', `session ${JSON.stringify(id)} was not claimed by any owner; call claim(owner, [id]) first`)
    }
    if (entry.owner !== owner) {
      fail('not-claimed', `session ${JSON.stringify(id)} is claimed by ${JSON.stringify(entry.owner)}, not by ${JSON.stringify(owner)}`)
    }
    // ② 活跃会话：在删除之前判定（与端点同一算法，这里是显式的二次防线）。
    if (isActive(id)) {
      fail('session-active', `session ${JSON.stringify(id)} is active; switch away from it before removing it`)
    }
    // ③ 真正的删除（唯一实现）。
    let report
    try {
      report = await performRemoval(id)
    } catch (error) {
      // 工件早就不在：会话已经没了，登记也没必要留着。
      if (error instanceof SessionRemovalError && error.code === 'session-not-found') await store.delete([id])
      throw error
    }
    await store.delete([id])
    logger?.info?.('dsh-workspace-manager: sessionRemoval 服务删除了会话 %s（owner %s）', id, owner)
    return report
  }

  return {
    service: serviceName,
    version: SESSION_REMOVAL_SERVICE_VERSION,
    claim,
    release,
    claimsOf,
    remove,
    /** 读盘完成（测试用它保证读到的是磁盘内容而不是"还没读完"）。 */
    ready,
    /**
     * 当前全部登记（副本，含 `parentSessionId`）。**不是给外部插件的服务面** ——
     * 本插件自己的 `inventory` 用它合成会话树的父子关系（端点与这里共用同一个登记表实例）。
     */
    entries() {
      return store.entries()
    },
    /** 内部登记快照（测试用；形状沿用 v1 的 sessionId → owner）。 */
    debugClaims() {
      return Object.fromEntries(store.entries().map((entry) => [entry.id, entry.owner]))
    },
  }
}
