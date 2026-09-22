// dsh-workspace-manager — 归档集合的读写（宿主侧）
//
// 背景（已在真机源码里核对）：
//   - 内核 `WorkspaceRegistry.archiveSession(id)` 只做一件事：把 id 追加进
//     `archivedSessionIds`，然后 setState 落盘。它**不删日志、不改工作区记账**，
//     归档集合的存在意义就是"隐藏标记 + 保留位置"（类注释原话：
//     "an archived session keeps its sessionIds slot so unarchiving restores its position"）。
//   - 但内核**没有任何反向动词**（0.1.1-rc.2 全仓库搜不到 unarchive），所以
//     官方 UI 一旦归档就再也够不着。
//   - `setState` 的实现就是 `global.set(state)` + 换内存快照；而 storage domain
//     的写入路径是"先落盘、再改内存、再 emit('domain/changed')"，
//     api-proxy 订阅该事件并在 `archivedSessionIds` 变化时推
//     `host/archived-sessions-changed` 帧给所有客户端。
//     => 用 Registry 自己的写入路径去掉一个 id，所有客户端都会同步恢复显示。
//
// 因此本模块只用 Registry 自身的公开类方法（enqueueOperation / requireState /
// setState），不替换、不 disabled、不 shadow 任何组件；并带能力守卫，
// dsh 升级导致这些内部方法改名时自动降级（调用方据此回退到纯视图层集合）。

/** Registry 上我们依赖的三个方法（都不是 Service Definition 的成员，故需守卫）。 */
function registryWriteFace(registry) {
  if (registry === null || typeof registry !== 'object') return undefined
  const { enqueueOperation, requireState, setState } = registry
  if (typeof enqueueOperation !== 'function') return undefined
  if (typeof requireState !== 'function') return undefined
  if (typeof setState !== 'function') return undefined
  return { enqueueOperation, requireState, setState }
}

/**
 * 这套 Registry 是否具备"可逆归档"所需的写入面。
 * @param registry - `ctx.workspaceRegistry`（宿主侧服务）。
 * @returns 可用时为 true；不可用时调用方降级为纯视图层集合。
 */
export function supportsArchiveSetWrite(registry) {
  return registryWriteFace(registry) !== undefined
}

/** 读取当前归档集合（不可用时返回 undefined，与"空集合"区分开）。 */
export function readArchivedSessionIds(registry) {
  const ids = registry?.archivedSessionIds
  return Array.isArray(ids) ? [...ids] : undefined
}

/**
 * 把一个会话移出内核归档集合（= "重新打开"）。
 *
 * 全程走 Registry 自己的写链（enqueueOperation 串行化 + setState 落盘），
 * 因此不会与并发的 archive/记账写入竞争，落盘后由宿主自动广播给所有客户端。
 *
 * @param registry - `ctx.workspaceRegistry`。
 * @param sessionId - 要恢复的会话 id。
 * @returns `{ ok, changed, reason? }`：
 *   - ok=false 表示这套 Registry 不支持该写法（调用方降级）；
 *   - changed=false 表示该 id 本来就不在归档集合里（幂等，不写盘）。
 */
export async function unarchiveSessionId(registry, sessionId) {
  const face = registryWriteFace(registry)
  if (face === undefined) return { ok: false, changed: false, reason: 'unsupported-registry' }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, changed: false, reason: 'bad-session-id' }
  }
  // 必须用 registry 作为接收者：enqueueOperation 依赖 this.operationTail 串行化写链。
  return face.enqueueOperation.call(registry, async () => {
    const state = face.requireState.call(registry)
    const current = state?.archivedSessionIds
    if (!Array.isArray(current)) return { ok: false, changed: false, reason: 'no-archive-set' }
    if (!current.includes(sessionId)) return { ok: true, changed: false }
    const next = current.filter((id) => id !== sessionId)
    // 只改归档集合这一个字段，其余字段（workspaceIds / initialized / pendingMutation）
    // 原样保留 —— 写前校验见 test/unarchive-offline.mjs。
    await face.setState.call(registry, { ...state, archivedSessionIds: next })
    return { ok: true, changed: true }
  })
}

/**
 * 把一个会话放回内核归档集合（= "归档"）。
 *
 * 优先用内核官方的 `archiveSession`：它会先 `sessionKnown()` 校验会话确实存在
 * （活会话或持久化里有），拒绝未知 id —— 这是官方语义，我们不重复实现。
 * 官方方法缺失时才退回直接写集合。
 *
 * @param registry - `ctx.workspaceRegistry`。
 * @param sessionId - 要归档的会话 id。
 * @returns `{ ok, changed, reason? }`。
 */
export async function archiveSessionId(registry, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, changed: false, reason: 'bad-session-id' }
  }
  if (typeof registry?.archiveSession === 'function') {
    const before = readArchivedSessionIds(registry) ?? []
    await registry.archiveSession(sessionId)
    return { ok: true, changed: !before.includes(sessionId) }
  }
  const face = registryWriteFace(registry)
  if (face === undefined) return { ok: false, changed: false, reason: 'unsupported-registry' }
  return face.enqueueOperation.call(registry, async () => {
    const state = face.requireState.call(registry)
    const current = state?.archivedSessionIds
    if (!Array.isArray(current)) return { ok: false, changed: false, reason: 'no-archive-set' }
    if (current.includes(sessionId)) return { ok: true, changed: false }
    await face.setState.call(registry, { ...state, archivedSessionIds: [...current, sessionId] })
    return { ok: true, changed: true }
  })
}
