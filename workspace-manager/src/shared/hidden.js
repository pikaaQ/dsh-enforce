// dsh-workspace-manager — 共享的纯函数：由"已关闭工作区"推导"应隐藏的会话"
//
// 这是本插件唯一的隐藏规则，宿主测试与客户端快照包装共用同一份实现
// （构建时由 scripts/build-client.mjs 内联进浏览器半区，避免两份逻辑漂移）。
//
// 为什么需要它：官方 ui-workspace 的 `groupByWorkspace()` 只统计**可见**工作区
// 名下的会话，其余全部塞进「未分组」。所以任何"只把工作区从列表里摘掉"的做法，
// 都会让它的会话变成一堆无主条目。这里按**当前**归属动态计算（而不是关闭那一刻
// 的快照），因此关闭期间新建的会话、以及后来出现在已关闭工作区名下的会话都不会变成孤儿。

/**
 * 收集一组工作区名下的全部会话 id。
 * @param items - 工作区视图数组（`WorkspaceListState.items`，每项含 `workspaceId` 与 `sessionIds`）。
 * @param closedWorkspaceIds - 已关闭的工作区 id 集合。
 * @returns 应被隐藏的会话 id 数组（去重，保持输入顺序）。
 */
export function hiddenSessionIdsFor(items, closedWorkspaceIds) {
  const closed = closedWorkspaceIds instanceof Set ? closedWorkspaceIds : new Set(closedWorkspaceIds ?? [])
  if (closed.size === 0) return []
  const seen = new Set()
  const out = []
  for (const item of items ?? []) {
    if (item === null || typeof item !== 'object') continue
    if (!closed.has(item.workspaceId)) continue
    for (const sessionId of item.sessionIds ?? []) {
      if (typeof sessionId !== 'string' || sessionId === '' || seen.has(sessionId)) continue
      seen.add(sessionId)
      out.push(sessionId)
    }
  }
  return out
}

/**
 * 从工作区列表中过滤掉已关闭的工作区。
 * @param items - 工作区视图数组。
 * @param closedWorkspaceIds - 已关闭的工作区 id 集合。
 * @returns 过滤后的数组（无关闭项时返回**原数组本身**，保持引用稳定）。
 */
export function visibleWorkspaceItems(items, closedWorkspaceIds) {
  const list = Array.isArray(items) ? items : []
  const closed = closedWorkspaceIds instanceof Set ? closedWorkspaceIds : new Set(closedWorkspaceIds ?? [])
  if (closed.size === 0) return list
  const kept = list.filter((item) => !closed.has(item?.workspaceId))
  return kept.length === list.length ? list : kept
}

/**
 * 把"我们自己要隐藏的会话"并入内核归档集合的客户端视图。
 *
 * 语义：官方 `archivedSessionIds` 是只增不减的宿主集合（内核没有反向动词），
 * 所以这里做**并集**——我们既不删除官方的成员，也不覆盖它，只是补上
 * "因工作区关闭而应当看不见"的那些会话。取消关闭后并集自然收缩回官方集合。
 *
 * @param hostIds - 宿主下发的归档集合（`WorkspaceListState.archivedSessionIds`）。
 * @param extraIds - 我们要额外隐藏的会话 id（见 {@link hiddenSessionIdsFor}）。
 * @returns 合并后的数组（无需合并时返回原数组本身，保持引用稳定）。
 */
export function unionArchivedSessionIds(hostIds, extraIds) {
  const base = Array.isArray(hostIds) ? hostIds : []
  const extra = Array.isArray(extraIds) ? extraIds : []
  if (extra.length === 0) return base
  const seen = new Set(base)
  const merged = [...base]
  for (const id of extra) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged.length === base.length ? base : merged
}
