// dsh-workspace-manager — 工作区列表投影（纯逻辑，无 React / 无 DOM 依赖）
//
// 这是"隐藏"生效的**唯一**机制：包装 `ctx.workspaces.list`（`SnapshotStore<WorkspaceListState>`）。
//
// 为什么一个接缝就够：
//   - 侧栏浏览器（占 `sidebar.workspaces`）与新会话选择器（占
//     `conversation.hero.workspace`）**都**通过 `useWorkspaces` 选择器读这个模型，
//     所以过滤 `items` 会让"已关闭的工作区"在两处同时消失；
//   - 归档集合 `archivedSessionIds` 由侧栏的 `sessionVisible()` 消费（分组树、
//     平铺列表、搜索结果三处），所以把会话并进去就会一起隐藏。
//   两者都只改这一个模型的对外快照，不注册槽位、不替换服务。
//
// 引用稳定性是硬要求：React 用 `useSyncExternalStore` 订阅 `getSnapshot()`，
// 每次返回新对象会导致无限重渲染。因此按 {原始快照对象身份, 关闭集合版本}
// 记忆化，两者都不变时返回**原对象本身**。

import { hiddenSessionIdsFor, unionArchivedSessionIds, visibleWorkspaceItems } from './hidden.js'

/**
 * 安装投影包装。
 *
 * @param model - `ctx.workspaces.list`（含 `getSnapshot()` / `subscribe()`）。
 * @param source - 隐藏来源：
 *   - `closedIds(): Set<string>` 当前已关闭的工作区 id；
 *   - `closedVersion(): number` 每次变更递增的版本号（**任何**影响隐藏集合的变化都要递增，
 *     包括"归档父会话"带来的额外隐藏项，否则记忆化会挡住重算）；
 *   - `subscribe(listener): () => void` 变更订阅；
 *   - `extraHiddenIds?(): string[]` **额外的**要隐藏的会话 id（本插件用它实现"子会话随父会话隐藏"，
 *     见 src/shared/session-tree.js 的 hiddenByArchivedParentIds）。
 * @returns `{ readRaw, subscribeRaw, dispose }`：
 *   `readRaw` 是**未过滤**快照的读取器（设置页要列出全部工作区，含已关闭的）。
 */
export function installWorkspaceProjection(model, source) {
  // 用 .call(model) 而不是 .bind(model)：这样 dispose 能把**原始函数引用**精确赋回去
  // （绑定副本行为相同，但引用不同，不便于验证"完全还原"）。
  const rawGetSnapshot = model.getSnapshot
  const rawSubscribe = model.subscribe
  let cache = { raw: undefined, version: -1, value: undefined }

  /** 投影一个快照：无变化时返回原对象，保证引用稳定。 */
  const project = (snapshot, version) => {
    if (cache.raw === snapshot && cache.version === version) return cache.value
    const closed = source.closedIds()
    const extra = typeof source.extraHiddenIds === 'function' ? source.extraHiddenIds() : []
    const extraIds = Array.isArray(extra) ? extra : []
    const items = visibleWorkspaceItems(snapshot.items, closed)
    const archivedSessionIds = unionArchivedSessionIds(
      snapshot.archivedSessionIds,
      // 关闭工作区名下的会话 ∪ 本插件额外要藏的会话（"随父归档隐藏"的子会话）。
      // 无额外项时保持原数组身份，引用稳定由 unionArchivedSessionIds 自己保证。
      extraIds.length === 0
        ? hiddenSessionIdsFor(snapshot.items, closed)
        : [...hiddenSessionIdsFor(snapshot.items, closed), ...extraIds],
    )
    // 最近工作区若已关闭，清掉它，避免"新建会话"落到看不见的工作区上。
    const recentWorkspaceId = closed.has(snapshot.recentWorkspaceId) ? undefined : snapshot.recentWorkspaceId
    const value = items === snapshot.items
      && archivedSessionIds === snapshot.archivedSessionIds
      && recentWorkspaceId === snapshot.recentWorkspaceId
      ? snapshot
      : { ...snapshot, items, archivedSessionIds, recentWorkspaceId }
    cache = { raw: snapshot, version, value }
    return value
  }

  model.getSnapshot = () => project(rawGetSnapshot.call(model), source.closedVersion())
  model.subscribe = (listener) => {
    const offRaw = rawSubscribe.call(model, listener)
    const offLocal = source.subscribe(listener)
    return () => {
      offRaw()
      offLocal()
    }
  }

  return {
    readRaw: () => rawGetSnapshot.call(model),
    subscribeRaw: (listener) => rawSubscribe.call(model, listener),
    /**
     * 还原这个模型。
     *
     * 注意：`createSnapshotStore()` 返回的是**对象字面量**
     * （`dsh-client-runtime/lib/client.js:5415`），`getSnapshot`/`subscribe` 是自有属性、
     * 没有原型可回退——所以这里必须把原函数**赋回去**，绝不能用 `delete`
     * （delete 之后 `getSnapshot` 会变成 undefined，任何仍在订阅的组件一读就崩）。
     */
    dispose() {
      model.getSnapshot = rawGetSnapshot
      model.subscribe = rawSubscribe
      cache = { raw: undefined, version: -1, value: undefined }
    },
  }
}
