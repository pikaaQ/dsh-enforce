// dsh-workspace-manager v0.1.0 — 由 scripts/build-client.mjs 生成，请勿手改。
// 源：src/shared/hidden.js + src/shared/session-tree.js + src/shared/projection.js + src/client/body.js
window.__ModuleLoader__.load({
  id: "dsh-workspace-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

// ── 内联：src/shared/hidden.js ──────────────────────────────────────────────
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
function hiddenSessionIdsFor(items, closedWorkspaceIds) {
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
function visibleWorkspaceItems(items, closedWorkspaceIds) {
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
function unionArchivedSessionIds(hostIds, extraIds) {
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

// ── 内联：src/shared/session-tree.js ────────────────────────────────────────
// dsh-workspace-manager — 共享的纯函数：会话树（父会话 → 子会话）
//
// 为什么这份规则要共享：同一套"谁是父、谁是子"的判定必须同时用在两个半区，否则两边会漂移：
//   * 宿主半区：`inventory` 每行的 `parentId` / `kind` / `orphan`、`remove({ cascade })` 的删除计划；
//   * 浏览器半区：设置页的缩进树与折叠、删除确认框里的子会话计数、归档父会话时"随父隐藏"。
// 所以纯规则放这里（宿主侧 src/host/session-tree.js 在此之上做多来源合成与环/孤儿防御），
// 浏览器侧由 scripts/build-client.mjs 原样内联（见该脚本顶部）。
//
// 事实依据（本仓库已核）：
//   * 子代理会话 id 是**裸 UUID**（`subagents.start("spawn", …)` 的 `run.id`，官方契约保证它就是
//     已发布的子会话 id）；交互会话 id 形如 `session-<uuid>`。
//   * 父子关系**不在**磁盘清点里，只能来自插件的持久化登记（见 src/host/claims-store.js）
//     或运行时内存（ctx.sessions / ctx.agents 的 session header）。
//
// 本文件没有 import、没有副作用：只依赖入参。

/** 子代理会话 id 的形态：裸 UUID（大小写不敏感）。 */
const SUBAGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 这个 id 是不是"子会话"形态（裸 UUID）。**只是形态**：历史遗留的子会话没有父指针，
 * 本插件不追认、不推断 —— 它们按"子会话但父未知"显示（见 {@link declaredParentId}）。
 * @param value - 候选 id。
 * @returns 是否裸 UUID。
 */
function isSubagentSessionId(value) {
  return typeof value === 'string' && SUBAGENT_ID_PATTERN.test(value)
}

/**
 * 是否属于同一个工作区（级联/建树的边界）。
 *
 * `workspaceId === null` 是「未分组」桶，**同一个桶也算同一个工作区**：未分组里的父子
 * （典型：临时目录里的会话）与工作区里的父子行为一致。
 * @param left - 行（含 `workspaceId`）。
 * @param right - 行（含 `workspaceId`）。
 * @returns 两个行是否同一工作区。
 */
function isSameWorkspace(left, right) {
  return (left?.workspaceId ?? null) === (right?.workspaceId ?? null)
}

/**
 * 行上**声明的**父会话 id。
 *
 * `inventory` 的行只有解析成功（父行确实存在且同工作区）时才有 `parentId`；
 * 声明了父但解析不到的（孤儿）在宿主侧的树上另记为 `orphan` 并保留 `declaredParentId`。
 * @param row - 清点行。
 * @returns 非空字符串或 null。
 */
function declaredParentId(row) {
  const value = row?.parentId
  return typeof value === 'string' && value !== '' ? value : null
}

/** 规范化一个行数组（丢掉非对象项）。 */
function rowList(rows) {
  return Array.isArray(rows) ? rows.filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string') : []
}

/**
 * 由清点行建立"父 id → 直接子行"的索引（保持输入顺序）。
 *
 * 三条规则与宿主侧级联**完全一致**：
 *   1. 父指针存在（`row.parentId` 非空）且不等于自己；
 *   2. 父行也在 `rows` 里（父行不在 = 孤儿，不建边）；
 *   3. 父与子同一工作区（跨工作区不建树、不连带）。
 * @param rows - 清点行数组。
 * @returns `Map<parentId, row[]>`。
 */
function childrenIndex(rows) {
  const list = rowList(rows)
  const byId = new Map()
  for (const row of list) if (!byId.has(row.id)) byId.set(row.id, row)
  const index = new Map()
  for (const row of list) {
    const parentId = declaredParentId(row)
    if (parentId === null || parentId === row.id) continue
    const parent = byId.get(parentId)
    if (parent === undefined) continue
    if (!isSameWorkspace(parent, row)) continue
    const bucket = index.get(parentId)
    if (bucket === undefined) index.set(parentId, [row])
    else bucket.push(row)
  }
  return index
}

/**
 * `rows` 里"不作为本集合中任何一行的子会话"的那些行（= 树的根）。
 * 孤儿与跨工作区的子会话都在这里 —— **不掉行**：它们照常显示，只是不缩进。
 * @param rows - 清点行数组。
 * @returns 顶层行数组（保持输入顺序）。
 */
function topLevelRows(rows) {
  const list = rowList(rows)
  const nested = new Set()
  for (const bucket of childrenIndex(list).values()) for (const row of bucket) nested.add(row.id)
  return list.filter((row) => !nested.has(row.id))
}

/**
 * 父会话已归档时，"随父隐藏"的**全部子孙** id（多级：级联删除会整棵删，视图上也整棵藏）。
 *
 * 语义与级联一致：归档不是删除，所以这里只影响客户端把它并入 `archivedSessionIds`
 * （侧栏的 `sessionVisible()` 据此隐藏）；取消归档后并集自然收缩、子会话重新出现。
 * 官方的 `archiveSession` 不会被调用 —— 子会话通常不在注册表 `sessionIds` 里，会被内核拒绝。
 * @param rows - 清点行数组。
 * @param archivedIds - 已归档会话 id（内核归档集合 ∪ 磁盘清点的 `archived`）。
 * @returns 应隐藏的 id 数组（保持输入顺序，去重）。
 */
function hiddenByArchivedParentIds(rows, archivedIds) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set(archivedIds ?? [])
  if (archived.size === 0) return []
  const list = rowList(rows)
  const index = childrenIndex(list)
  const hidden = new Set()
  let grew = true
  while (grew) {
    grew = false
    for (const [parentId, bucket] of index) {
      if (!archived.has(parentId) && !hidden.has(parentId)) continue
      for (const row of bucket) {
        if (hidden.has(row.id)) continue
        hidden.add(row.id)
        grew = true
      }
    }
  }
  return list.filter((row) => hidden.has(row.id)).map((row) => row.id)
}

// ── 内联：src/shared/projection.js ──────────────────────────────────────────
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
function installWorkspaceProjection(model, source) {
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

// ── 内联：src/client/body.js ────────────────────────────────────────────────
// dsh-workspace-manager — 客户端半区（浏览器）
//
// 三件事，全部走"不接管任何槽位"的路线：
//   1) 工作区行菜单注入「关闭」——DOM 注入（官方行菜单没有第三方行操作接缝）；
//      关闭 = 写本插件自己的宿主状态，随后由下面的快照包装立刻生效。
//   2) 设置页「工作区/会话」——注册 `settings.section`（list 槽，新增一项，
//      不碰任何已有设置项），列出全部工作区 + 打开开关 + 可展开会话 + 归档开关。
//
// 隐藏机制（关键）：包装 `ctx.workspaces.list` 这一个模型。
//   侧栏浏览器（sidebar.workspaces）与新会话选择器（conversation.hero.workspace）
//   都通过 `useWorkspaces` 读它，所以过滤 `items` 会同时让"关闭的工作区"在两处消失；
//   而把"关闭工作区名下的会话"并入 `archivedSessionIds`，会让它们从侧栏的
//   分组树/平铺列表/搜索三处一起消失（官方自己的 sessionVisible() 负责过滤）。
//   我们不写内核归档集合、不替换服务、不 shadow 槽位。
//
// 归档开关读写的是**内核官方**归档集合（宿主侧走 archiveSession +
// 注册表自己的写链做反向操作），因此与 dsh 语义完全一致、跨浏览器一致。

/** 由 scripts/build-client.mjs 内联：src/shared/hidden.js 的三个纯函数。 */
/** 由 scripts/build-client.mjs 提供工厂参数：`require` 与 `module`/`exports`。 */

// react 是 dsh 客户端模块系统的 platform seed word，第三方 bundle 直接 require 即可
// （内核自己的 client bundle 也是这么做的）。页面用 React.createElement 手写，
// 不引 @deepseek-ai/dsh-client-ui-primitives，避免其 API 漂移带来的耦合。
const React = require('react')

const NS = 'dsh-workspace-manager'
const RPC_PATH = '/dsh-workspace-manager'

const zh = {
  'nav.label': '工作区/会话',
  'menu.close': '关闭',
  'menu.close.done': '已关闭「{title}」，可在 设置 → 工作区/会话 里重新打开',
  'page.title': '工作区 / 会话',
  'page.intro': '取消勾选「打开」即从侧栏与新会话选择器隐藏该工作区（可在本页随时恢复，不删除任何数据）。勾选「归档」即把会话收进归档，取消勾选即重新打开。',
  'page.empty': '还没有登记任何工作区。',
  'page.open': '打开',
  'page.archived': '归档',
  'page.sessions': '{n} 个会话',
  'page.noSessions': '没有会话',
  'page.hiddenByWorkspace': '随工作区隐藏',
  'page.subagent': '子会话',
  'page.hiddenByParent': '随父归档隐藏',
  'page.children': '{n} 个子会话',
  'page.ungrouped': '未分组',
  'page.ungroupedHint': '这些会话的目录没有被登记为工作区（旧仓库路径、临时目录等）。彻底删除会同时清掉它们的投影缓存。',
  'page.remove': '彻底删除',
  'page.detach': '移除记账',
  'page.removeUnsupported': '会话仍活跃（或 id 不能安全地当目录名），先切走再删。',
  'page.totals': '磁盘上共 {n} 个会话、{size}；其中未分组 {ungrouped} 个（{ungroupedSize}）。',
  'page.loading': '正在清点会话…',
  'confirm.title': '彻底删除会话',
  'confirm.body': '将永久删除「{title}」在磁盘上的全部数据（约 {size}），不可恢复。归档不等于删除 —— 要真正移除就得在这里删。',
  'confirm.children': '将一并删除 {n} 个子会话（约 {size}）。',
  'confirm.cancel': '取消',
  'confirm.delete': '确认删除',
  'confirm.deleting': '正在删除…',
  'confirm.done': '已彻底删除「{title}」，释放 {size}',
  'confirm.archiveCleared': '（同时从官方归档集合里摘除）',
  'error.remove': '删除失败：{message}',
  'error.inventory': '无法清点会话：{message}',
  'page.restoreUnsupported': '当前 DSH 版本不暴露可逆归档所需的注册表写入面，归档开关已禁用（只读展示）。',
  'page.statePath': '状态文件：{path}',
  'page.failed': '操作失败：{message}',

}

const en = {
  'nav.label': 'Workspaces / Sessions',
  'menu.close': 'Close',
  'menu.close.done': 'Closed "{title}" — reopen it under Settings → Workspaces / Sessions',
  'page.title': 'Workspaces / Sessions',
  'page.intro': 'Unchecking "Open" hides a workspace from the sidebar and the new-session picker (reversible here; nothing is deleted). Checking "Archive" files a session away; unchecking it reopens the session.',
  'page.empty': 'No workspace is registered yet.',
  'page.open': 'Open',
  'page.archived': 'Archive',
  'page.sessions': '{n} sessions',
  'page.noSessions': 'No sessions',
  'page.hiddenByWorkspace': 'hidden with workspace',
  'page.subagent': 'subagent',
  'page.hiddenByParent': 'hidden with parent',
  'page.children': '{n} subagent session(s)',
  'page.ungrouped': 'Ungrouped',
  'page.ungroupedHint': 'These sessions live in directories that are not registered as workspaces (old repo paths, temp dirs). Removing one also clears its projection cache.',
  'page.remove': 'Delete',
  'page.removeUnsupported': 'The session is still active (or its id is not a safe directory name); switch away first.',
  'page.totals': '{n} sessions on disk, {size}; {ungrouped} ungrouped ({ungroupedSize}).',
  'page.loading': 'Scanning sessions…',
  'confirm.title': 'Delete session permanently',
  'confirm.body': 'This permanently deletes all data of "{title}" on disk (~{size}) and cannot be undone. Archiving is not deleting — remove it here to actually get rid of it.',
  'confirm.children': 'This also deletes {n} subagent session(s) (~{size}).',
  'confirm.cancel': 'Cancel',
  'confirm.delete': 'Delete',
  'confirm.deleting': 'Deleting…',
  'confirm.done': 'Deleted "{title}", freed {size}',
  'confirm.archiveCleared': ' (also removed from the official archive set)',
  'error.remove': 'Delete failed: {message}',
  'error.inventory': 'Could not scan sessions: {message}',
  'page.restoreUnsupported': 'This DSH build does not expose the registry write face required for reversible archiving, so the archive switch is disabled (read-only).',
  'page.statePath': 'State file: {path}',
  'page.failed': 'Operation failed: {message}',

}

const inject = ['slots', 'workspaces', 'sessions', 'locale', 'connection']

const isId = (value) => typeof value === 'string' && value.trim() !== ''
const MARK = 'data-dsh-workspace-manager'

/**
 * 从元素沿 React fiber 向上找某个 props 键（对象）。
 *
 * 官方行组件把数据放在 props 里：工作区行 `<ProjectRowItem({ group, ... })>`、
 * 会话行 `<SessionNodeItem({ node, ... })>`（见 dsh-client-ui-workspace/lib/client.js:454/692）。
 * 找不到时说明官方 DOM/fiber 契约变了——这时候要**留下可诊断的痕迹**，而不是静默什么都不做。
 */
function fiberPropObject(element, propName) {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'))
  let fiber = key === undefined ? undefined : element[key]
  for (let depth = 0; fiber !== undefined && fiber !== null && depth < 64; depth += 1) {
    let value
    try {
      value = fiber.memoizedProps?.[propName]
    } catch {
      value = undefined
    }
    if (value !== undefined && value !== null && typeof value === 'object') return value
    fiber = fiber.return
  }
  return undefined
}

const warned = new Set()
/** 每个页面加载每种行只提示一次，避免刷屏。 */
function warnOnce(kind, element) {
  if (warned.has(kind)) return
  warned.add(kind)
  console.warn(
    `[${NS}] 无法从${kind === 'workspace' ? '工作区' : '会话'}行解析 id：官方行组件契约可能已变，`
    + `行菜单项不会出现（设置页不受影响）。请对照 dsh-client-ui-workspace 的 `
    + `${kind === 'workspace' ? 'ProjectRowItem({ group })' : 'SessionNodeItem({ node })'} 检查。`,
    element,
  )
}

/** 工作区行的 workspaceId：`group.workspaceId` 为 undefined 时是「未分组」桶（正常，不注入也不告警）。 */
const workspaceIdOf = (row) => {
  const group = fiberPropObject(row, 'group')
  if (group === undefined) {
    warnOnce('workspace', row)
    return undefined
  }
  return isId(group.workspaceId) ? group.workspaceId : undefined
}

function nearestMenu(anchor) {
  const anchorRect = anchor.getBoundingClientRect()
  return Array.from(document.querySelectorAll('[role="menu"]'))
    .filter((menu) => {
      const rect = menu.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && menu.querySelector('[role="menuitem"]') !== null
    })
    .sort((left, right) => {
      const a = left.getBoundingClientRect()
      const b = right.getBoundingClientRect()
      const aDistance = Math.abs(a.left - anchorRect.left) + Math.abs(a.top - anchorRect.bottom)
      const bDistance = Math.abs(b.left - anchorRect.left) + Math.abs(b.top - anchorRect.bottom)
      return aDistance - bDistance
    })[0]
}

function svgElement(name, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  return node
}

function iconFor(kind) {
  const svg = svgElement('svg', { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' })
  // close：一只闭眼的文件夹
  svg.appendChild(svgElement('path', { d: 'M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }))
  svg.appendChild(svgElement('path', { d: 'M5.6 9.4h4.8', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }))
  return svg
}

/** 同步抑制标志：见 mountMenuItem 里对被点菜单项的处置。 */
let suppressing = false

/**
 * 把一项插入当前打开的菜单（克隆第一个 menuitem 的外观，保证风格一致）。
 * @returns 是否已经插入或此前已插入。
 */
function mountMenuItem(anchor, kind, label, onSelect) {
  const menu = nearestMenu(anchor)
  if (menu === undefined) return false
  const existing = menu.querySelector(`[${MARK}="${kind}"]`)
  if (existing !== null) return true
  const template = menu.querySelector('[role="menuitem"]')
  if (template === null) return false
  const item = template.cloneNode(false)
  item.setAttribute(MARK, kind)
  const icon = document.createElement('span')
  icon.className = template.firstElementChild?.className ?? ''
  icon.appendChild(iconFor(kind))
  const text = document.createElement('span')
  text.className = template.lastElementChild?.className ?? ''
  text.textContent = label
  item.append(icon, text)
  item.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    // 点这一项同时要收起菜单：再点一次锚按钮即可。HTMLElement.click() 是**同步**派发的，
    // 所以用同步标志挡住这次派发触发的注入尝试就够了（不用时间窗，免得误伤此刻新开的菜单）。
    suppressing = true
    try {
      anchor.click()
    } finally {
      suppressing = false
    }
    void onSelect()
  })
  menu.insertBefore(item, template.nextSibling)
  window.dispatchEvent(new Event('resize'))
  return true
}

/**
 * 安装工作区行菜单注入。
 * 判别依据取自官方组件：工作区行是 `[role="treeitem"][aria-expanded]`（`ProjectRowItem`）。
 */
function installRowMenus(ctx, manager, t) {
  const onClick = (event) => {
    if (suppressing) return
    const target = event.target
    if (typeof target?.closest !== 'function') return
    const button = target.closest('button')
    if (button === null) return
    const row = button.closest('[role="treeitem"]')
    if (row === null) return

    if (row.hasAttribute('aria-expanded')) {
      const workspaceId = workspaceIdOf(row)
      if (workspaceId === undefined) return
      const attempt = (tries) => {
        if (mountMenuItem(button, 'close', t('menu.close'), () => manager.closeWorkspace(workspaceId))) return
        if (tries < 5) setTimeout(() => attempt(tries + 1), 20)
      }
      setTimeout(() => attempt(0), 0)
      return
    }

  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

function dialogElement(name, style, text) {
  const node = document.createElement(name)
  if (style !== undefined) Object.assign(node.style, style)
  if (text !== undefined) node.textContent = text
  return node
}

function toast(className, message) {
  const node = dialogElement('div', {
    position: 'fixed', right: '20px', bottom: '20px', zIndex: '1350', maxWidth: 'min(420px,calc(100vw - 40px))',
    padding: '11px 14px', border: '1px solid var(--dsw-alias-border-l2,#d9d9d9)', borderRadius: '8px',
    background: 'var(--dsw-specific-menu,#fff)', color: 'inherit', boxShadow: '0 8px 24px rgba(0,0,0,.2)',
  }, message)
  node.className = className
  node.setAttribute('role', 'status')
  document.body.appendChild(node)
  setTimeout(() => node.remove(), 4000)
}

/** 人类可读体积（设置页与确认对话框共用）。 */
function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

// ── 管理器状态（已关闭集合 + 归档操作的镜像） ────────────────────────────────

function createManager(ctx, t) {
  let closed = new Set()
  let version = 0
  let canRestoreArchive = true
  let statePath
  /** 宿主归档集合的最近一次快照（`state`/`archive`/`unarchive` 的回包都带它）。 */
  let hostArchived = new Set()
  /** 最近一次磁盘清点的行（会话树的数据源：parentId/kind/archived/bytes）。 */
  let inventoryRows = []
  /** 「随父归档隐藏」的子会话 id（投影据此把它们并入 archivedSessionIds）。 */
  let hiddenByParent = []
  const listeners = new Set()
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.warn('dsh-workspace-manager: listener failed', error)
      }
    }
  }
  /**
   * 重算"随父归档隐藏"。
   *
   * 为什么放在客户端：官方归档集合只认识注册表里的会话，而子会话通常**不在**注册表
   * `sessionIds` 里（内核 `archiveSession` 会直接拒），所以"归档父会话 → 子会话一起看不见"
   * 只能走本插件现成的隐藏机制（把 id 并进 `archivedSessionIds`，官方 `sessionVisible()` 负责过滤）。
   * 取消归档后这次计算自然不再包含它们，子会话立刻恢复显示。
   */
  const recomputeHiddenByParent = () => {
    const archived = new Set(hostArchived)
    for (const row of inventoryRows) if (row?.archived === true) archived.add(row.id)
    hiddenByParent = hiddenByArchivedParentIds(inventoryRows, archived)
  }
  /** 版本号是投影记忆化的键：**任何**影响隐藏集合的变化都要走这里。 */
  const bump = () => {
    version += 1
    recomputeHiddenByParent()
    notify()
  }
  const adopt = (value) => {
    if (Array.isArray(value?.closedWorkspaceIds)) closed = new Set(value.closedWorkspaceIds)
    if (Array.isArray(value?.archivedSessionIds)) hostArchived = new Set(value.archivedSessionIds)
    if (typeof value?.canRestoreArchive === 'boolean') canRestoreArchive = value.canRestoreArchive
    if (typeof value?.statePath === 'string') statePath = value.statePath
    bump()
  }
  const call = async (endpoint, payload) => {
    const result = await ctx.connection.rpc.call(RPC_PATH, endpoint, payload ?? {})
    if (!result?.ok) throw new Error(result?.error?.message ?? 'unknown error')
    adopt(result.value)
    return result.value
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    closedVersion: () => version,
    closedIds: () => closed,
    /** 除"随工作区隐藏"之外还要隐藏的会话（子会话随父归档隐藏）。 */
    extraHiddenIds: () => hiddenByParent,
    canRestoreArchive: () => canRestoreArchive,
    statePath: () => statePath,
    async refresh() {
      try {
        adopt(await call('state'))
      } catch (error) {
        console.warn('dsh-workspace-manager: state refresh failed', error)
      }
    },
    async closeWorkspace(workspaceId) {
      // 标题必须在关闭**之前**取：RPC 返回后投影会立刻把该工作区从 items 里过滤掉，
      // 那时候再查就只能拿到 id 了（提示会变成一串 id）。
      const title = ctx.workspaces.list.getSnapshot().items
        .find((item) => item.workspaceId === workspaceId)?.title ?? workspaceId
      await call('close', { workspaceId })
      toast('dswm-toast', t('menu.close.done', { title }))
    },
    async openWorkspace(workspaceId) {
      await call('open', { workspaceId })
    },
    async setClosed(workspaceIds) {
      await call('setClosed', { workspaceIds })
    },
    async archive(sessionId) {
      await call('archive', { sessionId })
    },
    async unarchive(sessionId) {
      await call('unarchive', { sessionId })
    },
    /** 磁盘清点（只读）。返回 { sessions, totals, sessionsRoot }；同时记住会话树（parentId）。 */
    async inventory() {
      const result = await ctx.connection.rpc.call(RPC_PATH, 'inventory', {})
      if (!result?.ok) throw new Error(result?.error?.message ?? 'unknown error')
      // 不 adopt（它不是宿主状态快照），但要 bump 一次版本：清点结果同时是"随父归档隐藏"的
      // 数据源（parentId + archived），归档/取消归档后必须让侧栏投影立刻重算。
      inventoryRows = Array.isArray(result.value?.sessions) ? result.value.sessions : []
      bump()
      return result.value
    },
    /**
     * 彻底移除：删磁盘工件 + 摘掉官方归档条目。
     * @param sessionId - 会话 id。
     * @param options - `{ cascade? }`：为 true 时宿主**先删子、后删父**（只在同一工作区内连带；
     *   任一子孙活跃则整体拒绝）。默认 false，与旧行为逐字相同。
     */
    async removeSession(sessionId, options = {}) {
      return call('remove', options.cascade === true ? { sessionId, cascade: true } : { sessionId })
    },
  }
}

/**
 * 把关闭集合接上共享的投影实现（`src/shared/projection.js`，离线测试覆盖同一份代码）。
 * 投影只包装 `ctx.workspaces.list` 这一个模型，引用稳定性由那边保证。
 */
function installProjection(ctx, manager) {
  return installWorkspaceProjection(ctx.workspaces.list, {
    closedIds: () => manager.closedIds(),
    closedVersion: () => manager.closedVersion(),
    extraHiddenIds: () => manager.extraHiddenIds(),
    subscribe: (listener) => manager.subscribe(listener),
  })
}

// ── 设置页「工作区 / 会话」 ──────────────────────────────────────────────────

const S = {
  root: { maxWidth: '760px', color: 'var(--dsw-alias-label-primary,#1f1f1f)' },
  title: { margin: '0 0 4px', fontSize: '20px', fontWeight: '600' },
  intro: { margin: '0 0 16px', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary,#888)' },
  card: { border: '1px solid var(--dsw-alias-border-l2,#e3e3e3)', borderRadius: '10px', marginBottom: '8px', overflow: 'hidden' },
  row: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px' },
  rowClosed: { opacity: '.6' },
  text: { minWidth: '0', flex: '1' },
  name: { fontSize: '14px', lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  path: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary,#888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toggle: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', whiteSpace: 'nowrap', flex: 'none' },
  expander: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', width: '20px', padding: '0', fontSize: '12px' },
  sub: { borderTop: '1px solid var(--dsw-alias-border-l2,#eee)', padding: '6px 12px 10px 42px' },
  sessionRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' },
  sessionName: { flex: '1', minWidth: '0', fontSize: '13px', lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: { fontSize: '11px', padding: '1px 6px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2,#ddd)', color: 'var(--dsw-alias-label-tertiary,#888)', flex: 'none' },
  note: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary,#888)', marginTop: '12px' },
  error: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary,#d03050)', marginTop: '8px' },
  danger: { flex: 'none', padding: '2px 9px', fontSize: '12px', lineHeight: '18px', borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--dsw-alias-state-error-primary,#d03050)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary,#d03050)' },
  dangerOff: { opacity: '.4', cursor: 'not-allowed' },
  size: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary,#888)', flex: 'none' },
  overlay: { position: 'fixed', inset: '0', zIndex: '1300', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', background: 'rgba(0,0,0,.48)' },
  dialog: { boxSizing: 'border-box', width: 'min(460px,100%)', padding: '20px', border: '1px solid var(--dsw-alias-border-l2,#d9d9d9)', borderRadius: '12px', background: 'var(--dsw-specific-menu,#fff)', color: 'var(--dsw-alias-label-primary,#1f1f1f)', boxShadow: '0 12px 32px rgba(0,0,0,.24)', font: 'inherit' },
  dialogTitle: { margin: '0', fontSize: '18px', lineHeight: '26px' },
  dialogBody: { margin: '6px 0 0', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary,#666)' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' },
  confirm: { minWidth: '96px', minHeight: '36px', padding: '8px 13px', fontSize: '13px', font: 'inherit', borderRadius: '8px', cursor: 'pointer', border: '1px solid var(--dsw-alias-state-error-primary,#d03050)', background: 'var(--dsw-alias-state-error-primary,#d03050)', color: '#fff' },
  cancel: { minWidth: '80px', minHeight: '36px', padding: '8px 13px', fontSize: '13px', font: 'inherit', borderRadius: '8px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2,#d9d9d9)', background: 'transparent', color: 'inherit' },
}

function installSettingsSection(ctx, manager, projection, t) {
  const h = React.createElement
  const useSyncExternalStore = React.useSyncExternalStore

  function useClosed() {
    const subscribe = React.useCallback((listener) => manager.subscribe(listener), [])
    const getSnapshot = React.useCallback(() => manager.closedVersion(), [])
    useSyncExternalStore(subscribe, getSnapshot)
    return manager.closedIds()
  }
  function useRawWorkspaces() {
    const subscribe = React.useCallback((listener) => projection.subscribeRaw(listener), [projection])
    const getSnapshot = React.useCallback(() => projection.readRaw(), [projection])
    return useSyncExternalStore(subscribe, getSnapshot)
  }
  function useSessions() {
    const store = ctx.sessions.list
    const subscribe = React.useCallback((listener) => store.subscribe(listener), [store])
    const getSnapshot = React.useCallback(() => store.getSnapshot(), [store])
    return useSyncExternalStore(subscribe, getSnapshot)
  }

  function SettingsSection() {
    const [expanded, setExpanded] = React.useState({})
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(undefined)
    const [pendingArchive, setPendingArchive] = React.useState({})
    const [inventory, setInventory] = React.useState(undefined)
    const [inventoryError, setInventoryError] = React.useState(undefined)
    const [confirming, setConfirming] = React.useState(undefined)
    // 子会话折叠状态（默认折叠：父会话一行 + 一个展开箭头）。以**会话 id** 为键，
    // 与工作区卡的展开状态分开，避免一个工作区里多个父会话互相干扰。
    const [expandedChildren, setExpandedChildren] = React.useState({})
    const closed = useClosed()
    const workspaces = useRawWorkspaces()
    const sessions = useSessions()

    const archivedHost = new Set(workspaces.archivedSessionIds ?? [])
    const canRestore = manager.canRestoreArchive()

    const loadInventory = React.useCallback(async () => {
      try {
        setInventory(await manager.inventory())
        setInventoryError(undefined)
      } catch (failure) {
        setInventoryError(failure instanceof Error ? failure.message : String(failure))
      }
    }, [])
    React.useEffect(() => {
      void loadInventory()
    }, [loadInventory])

    const run = async (operation) => {
      setBusy(true)
      setError(undefined)
      try {
        await operation()
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusy(false)
      }
    }

    /**
     * 勾选框"此刻显示的值"：本地待写覆盖 > 磁盘清点 > 客户端快照。
     *
     * 为什么不能只看客户端快照：官方注册表这次变更不会重新发布客户端快照，快照里的
     * archivedSessionIds 会落后于磁盘清点的 row.archived —— 拿它算"下一个状态"会算出
     * 反方向（想取消归档反而又归档一次），用户看到的就是"点了没反应，刷新才变"。
     */
    const archivedShown = (sessionId) => {
      if (pendingArchive[sessionId] !== undefined) return pendingArchive[sessionId]
      const row = diskById.get(sessionId)
      return row === undefined ? archivedHost.has(sessionId) : row.archived === true
    }

    const toggleArchive = (sessionId) => {
      const target = !archivedShown(sessionId)
      setPendingArchive((previous) => ({ ...previous, [sessionId]: target }))
      void run(async () => {
        try {
          if (target) await manager.archive(sessionId)
          else await manager.unarchive(sessionId)
          // 成功之后必须自己刷新清点：否则覆盖值一清掉，勾选框就退回旧值。
          await loadInventory()
        } finally {
          setPendingArchive((previous) => {
            const next = { ...previous }
            delete next[sessionId]
            return next
          })
        }
      })
    }

    const removeSession = (session) => {
      void run(async () => {
        // 有子会话就显式级联（宿主先子后父）；没有就保持旧 payload（默认不级联）。
        const report = await manager.removeSession(session.sessionId, { cascade: (session.children?.length ?? 0) > 0 })
        setConfirming(undefined)
        toast('dswm-toast', t('confirm.done', { title: session.label, size: formatBytes(report?.bytes ?? session.bytes) })
          + (report?.archiveCleared === true ? t('confirm.archiveCleared') : ''))
        await loadInventory()
      })
    }

    // 会话来源优先用**磁盘清点**：注册表的 sessionIds 只认得本次运行见过的会话，
    // 设置页要列出"磁盘上真实存在的全部会话"（含未分组的），否则没法删。
    const disk = inventory?.sessions
    const diskById = new Map((disk ?? []).map((row) => [row.id, row]))
    const byWorkspace = new Map()
    for (const row of disk ?? []) {
      if (row.workspaceId === null) continue
      const list = byWorkspace.get(row.workspaceId) ?? []
      list.push(row)
      byWorkspace.set(row.workspaceId, list)
    }
    const ungrouped = (disk ?? []).filter((row) => row.workspaceId === null)

    // ── 会话树（父会话 → 子会话）────────────────────────────────────────────────
    // 父子关系由宿主下发（`row.parentId`，来源见 src/host/session-tree.js：持久化登记优先、
    // 运行时内存兜底）；**历史遗留不追认** —— 没有父指针的裸 UUID 会话就是"子会话、父未知"，
    // 照常留在顶层显示，只是行尾带「子会话」标记。
    // 缩进/计数用的纯规则与宿主级联是同一份实现（src/shared/session-tree.js，构建时内联），
    // 所以"页面上看到几个子会话"与"实际会删掉几个"不可能漂移。
    const archivedForTree = new Set(archivedHost)
    for (const row of disk ?? []) if (row.archived === true) archivedForTree.add(row.id)
    for (const [id, value] of Object.entries(pendingArchive)) {
      if (value === true) archivedForTree.add(id)
      else archivedForTree.delete(id)
    }
    const hiddenByParent = new Set(hiddenByArchivedParentIds(disk ?? [], archivedForTree))

    /**
     * 级联会一并删掉的子孙（**与宿主 planCascade 同一规则**：同一工作区、只沿着真实存在的
     * 清点行往下走）。删除确认框的"将一并删除 N 个子会话"就是它。
     */
    const cascadeRowsOf = (row) => {
      if (row === undefined) return []
      const out = []
      const seen = new Set([row.id])
      const stack = [row]
      while (stack.length > 0) {
        const current = stack.pop()
        for (const candidate of disk ?? []) {
          if (seen.has(candidate.id) || candidate.parentId !== current.id) continue
          if (candidate.workspaceId !== row.workspaceId) continue
          seen.add(candidate.id)
          out.push(candidate)
          stack.push(candidate)
        }
      }
      return out
    }

    const sessionLine = (session, options = {}) => {
      const summary = sessions.byId?.[session.id]
      const label = summary?.label ?? summary?.title ?? session.id
      const row = diskById.get(session.id)
      const archived = row === undefined ? archivedHost.has(session.id) : row.archived
      const shown = pendingArchive[session.id] ?? archived
      const removable = row === undefined ? false : row.removable === true
      const blocked = row !== undefined && row.removable !== true
      const depth = options.depth ?? 0
      const childCount = options.childCount ?? 0
      const expandedKids = options.expanded === true
      // 展开箭头（没有子会话时用等宽占位，保证同层左右对齐）。
      const marker = childCount === 0
        ? h('span', { key: 'pad', style: S.expander })
        : h('button', {
          key: 'exp',
          type: 'button',
          style: S.expander,
          'aria-expanded': expandedKids,
          title: t('page.children', { n: childCount }),
          onClick: options.onToggle,
        }, expandedKids ? '▾' : '▸')
      return h('div', {
        key: session.id,
        style: depth === 0 ? S.sessionRow : { ...S.sessionRow, paddingLeft: `${depth * 18}px` },
      }, [
        marker,
        h('span', { key: 'name', style: S.sessionName, title: session.id }, label),
        row !== undefined && row.bytes > 0 ? h('span', { key: 'size', style: S.size }, formatBytes(row.bytes)) : null,
        row?.kind === 'subagent' ? h('span', { key: 'kind', style: S.badge }, t('page.subagent')) : null,
        session.hiddenWithWorkspace === true ? h('span', { key: 'hidden', style: S.badge }, t('page.hiddenByWorkspace')) : null,
        hiddenByParent.has(session.id) ? h('span', { key: 'hiddenParent', style: S.badge }, t('page.hiddenByParent')) : null,
        h('label', { key: 'archive', style: S.toggle }, [
          h('input', {
            key: 'cb',
            type: 'checkbox',
            checked: shown,
            disabled: busy || !canRestore,
            onChange: () => toggleArchive(session.id),
          }),
          t('page.archived'),
        ]),
        // 磁盘上没有工件的行（注册表还记着、工件已被删）也要给按钮：宿主会走"只清理记账"
        // 的路径。否则这类残留行会一直显示、又没有任何可点的操作 —— 幽灵行正是这么来的。
        h('button', {
          key: 'remove',
          type: 'button',
          style: { ...S.danger, ...(row === undefined || (removable && !busy) ? {} : S.dangerOff) },
          disabled: busy || (row === undefined ? false : !removable),
          title: blocked ? t('page.removeUnsupported') : undefined,
          onClick: () => {
            const children = cascadeRowsOf(row)
            setConfirming({
              sessionId: session.id,
              label,
              bytes: row?.bytes ?? 0,
              children,
              childrenBytes: children.reduce((sum, child) => sum + (Number(child.bytes) || 0), 0),
            })
          },
        }, row === undefined ? t('page.detach') : t('page.remove')),
      ])
    }

    /**
     * 把一组会话条目渲染成树：父会话在上、子会话缩进在它下面（**默认折叠**）。
     *
     * 只有"父也在这一组条目里"的条目才缩进；孤儿（父已不在）与跨工作区的子会话照常留在顶层
     * —— 不掉行、不报错。`rendered` 兼作环的兜底：万一宿主下发了环（页面拿到旧回包），
     * 没被走到的条目最后原样平铺出来。
     */
    const renderEntries = (entries) => {
      const ids = new Set(entries.map((entry) => entry.id))
      const parentIdOf = (entry) => {
        const row = diskById.get(entry.id)
        const parentId = row?.parentId
        if (typeof parentId !== 'string' || parentId === entry.id || !ids.has(parentId)) return undefined
        return parentId
      }
      const rendered = new Set()
      /** 已被某个父会话"认领"的条目：父折叠着也不能在最后被平铺出来（那是"隐藏"而不是"折叠"）。 */
      const claimed = new Set()
      const nodes = []
      const walk = (entry, depth) => {
        if (rendered.has(entry.id)) return
        rendered.add(entry.id)
        const kids = entries.filter((candidate) => parentIdOf(candidate) === entry.id)
        const expandedKids = expandedChildren[entry.id] === true
        nodes.push(sessionLine(entry, {
          depth,
          childCount: kids.length,
          expanded: expandedKids,
          onToggle: kids.length === 0 ? undefined : () => setExpandedChildren((previous) => ({ ...previous, [entry.id]: previous[entry.id] !== true })),
        }))
        for (const kid of kids) claimed.add(kid.id)
        if (!expandedKids) return
        for (const kid of kids) walk(kid, depth + 1)
      }
      for (const entry of entries) if (parentIdOf(entry) === undefined) walk(entry, 0)
      for (const entry of entries) if (!rendered.has(entry.id) && !claimed.has(entry.id)) walk(entry, 0)
      return nodes
    }

    const rows = (workspaces.items ?? []).map((workspace) => {
      const isClosed = closed.has(workspace.workspaceId)
      const registryIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      const fromDisk = byWorkspace.get(workspace.workspaceId) ?? []
      // 磁盘上有的按磁盘列（带体积与删除按钮）；磁盘上没有的（例如已归档且被移出目录的）仍按注册表列出来。
      const known = new Set(fromDisk.map((row) => row.id))
      const list = [
        ...fromDisk.map((row) => ({ id: row.id })),
        ...registryIds.filter((id) => !known.has(id)).map((id) => ({ id, hiddenWithWorkspace: isClosed })),
      ]
      const isExpanded = expanded[workspace.workspaceId] === true
      const children = [
        h('div', { key: 'head', style: { ...S.row, ...(isClosed ? S.rowClosed : {}) } }, [
          h('button', {
            key: 'exp',
            type: 'button',
            style: S.expander,
            'aria-expanded': isExpanded,
            'aria-label': isExpanded ? 'collapse' : 'expand',
            onClick: () => setExpanded((previous) => ({ ...previous, [workspace.workspaceId]: !isExpanded })),
          }, isExpanded ? '▾' : '▸'),
          h('div', { key: 'text', style: S.text }, [
            h('div', { key: 'name', style: S.name }, workspace.title ?? workspace.path),
            h('div', { key: 'path', style: S.path }, `${workspace.path} · ${t('page.sessions', { n: list.length })}`),
          ]),
          h('label', { key: 'open', style: S.toggle }, [
            h('input', {
              key: 'cb',
              type: 'checkbox',
              checked: !isClosed,
              disabled: busy,
              onChange: (event) => {
                const open = event.target.checked
                void run(() => (open ? manager.openWorkspace(workspace.workspaceId) : manager.closeWorkspace(workspace.workspaceId)))
              },
            }),
            t('page.open'),
          ]),
        ]),
      ]
      if (isExpanded) {
        children.push(h('div', { key: 'sub', style: S.sub }, list.length === 0
          ? [h('div', { key: 'none', style: S.path }, t('page.noSessions'))]
          : renderEntries(list)))
      }
      return h('div', { key: workspace.workspaceId, style: S.card }, children)
    })

    const ungroupedCard = ungrouped.length === 0 ? null : h('div', { key: 'ungrouped', style: S.card }, [
      h('div', { key: 'head', style: S.row }, [
        h('button', {
          key: 'exp',
          type: 'button',
          style: S.expander,
          'aria-expanded': expanded.__ungrouped === true,
          onClick: () => setExpanded((previous) => ({ ...previous, __ungrouped: previous.__ungrouped !== true })),
        }, expanded.__ungrouped === true ? '▾' : '▸'),
        h('div', { key: 'text', style: S.text }, [
          h('div', { key: 'name', style: S.name }, t('page.ungrouped')),
          h('div', { key: 'path', style: S.path }, `${t('page.sessions', { n: ungrouped.length })} · ${formatBytes(ungrouped.reduce((sum, row) => sum + row.bytes, 0))}`),
        ]),
      ]),
      expanded.__ungrouped === true ? h('div', { key: 'sub', style: S.sub }, [
        h('div', { key: 'hint', style: S.note }, t('page.ungroupedHint')),
        ...renderEntries(ungrouped.map((row) => ({ id: row.id }))),
      ]) : null,
    ])

    const totals = inventory?.totals
    const confirm = confirming === undefined ? null : h('div', { key: 'confirm', style: S.overlay }, [
      h('section', { key: 'dialog', role: 'dialog', 'aria-modal': 'true', style: S.dialog }, [
        h('h2', { key: 'title', style: S.dialogTitle }, t('confirm.title')),
        h('p', { key: 'body', style: S.dialogBody }, t('confirm.body', { title: confirming.label, size: formatBytes(confirming.bytes) })
          // 有子会话时必须先说清楚会连带删掉什么（数量与体积），再让用户点确认。
          + ((confirming.children?.length ?? 0) === 0
            ? ''
            : ` ${t('confirm.children', { n: confirming.children.length, size: formatBytes(confirming.childrenBytes) })}`)),
        h('div', { key: 'actions', style: S.actions }, [
          h('button', {
            key: 'cancel',
            type: 'button',
            style: S.cancel,
            disabled: busy,
            onClick: () => setConfirming(undefined),
          }, t('confirm.cancel')),
          h('button', {
            key: 'ok',
            type: 'button',
            style: S.confirm,
            disabled: busy,
            onClick: () => removeSession(confirming),
          }, busy ? t('confirm.deleting') : t('confirm.delete')),
        ]),
      ]),
    ])

    return h('div', { style: S.root }, [
      h('h2', { key: 'title', style: S.title }, t('page.title')),
      h('p', { key: 'intro', style: S.intro }, t('page.intro')),
      totals !== undefined
        ? h('p', { key: 'totals', style: S.note }, t('page.totals', { n: totals.sessions, size: formatBytes(totals.bytes), ungrouped: totals.ungrouped, ungroupedSize: formatBytes(totals.ungroupedBytes) }))
        : h('p', { key: 'totals', style: S.note }, t('page.loading')),
      inventoryError !== undefined ? h('p', { key: 'invError', style: S.error }, t('error.inventory', { message: inventoryError })) : null,
      !canRestore ? h('p', { key: 'caps', style: S.error }, t('page.restoreUnsupported')) : null,
      (workspaces.items ?? []).length === 0 ? h('p', { key: 'empty', style: S.intro }, t('page.empty')) : null,
      ...rows,
      ungroupedCard,
      error !== undefined ? h('p', { key: 'error', style: S.error }, t('page.failed', { message: error })) : null,
      manager.statePath() !== undefined ? h('p', { key: 'path', style: S.note }, t('page.statePath', { path: manager.statePath() })) : null,
      confirm,
    ])
  }

  return ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'workspace-manager',
    order: 19,
    label: () => ctx.locale.bind(NS)('nav.label'),
    locale: NS,
  }, SettingsSection))
}

function apply(ctx) {
  const t = (key, vars) => {
    const bound = ctx.locale.bind(NS)
    return bound(key, vars)
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: locale`)

  const manager = createManager(ctx, t)
  const projection = installProjection(ctx, manager)
  ctx.effect(() => () => projection.dispose(), `${NS}: projection`)
  ctx.effect(() => installRowMenus(ctx, manager, t), `${NS}: row menus`)
  ctx.effect(() => installSettingsSection(ctx, manager, projection, t), `${NS}: settings section`)

  // 首次拉取 + 窗口重新聚焦时对账（多标签页/多窗口的最终一致）
  void manager.refresh()
  const onFocus = () => void manager.refresh()
  window.addEventListener('focus', onFocus)
  ctx.effect(() => () => window.removeEventListener('focus', onFocus), `${NS}: focus refresh`)
}

exports.apply = apply
exports.inject = inject


    // 内核 loader 取的是**工厂的返回值**（dsh-client-modules: exports: registered(makeRequire(...))），
    // 所以这里必须显式返回 module.exports。
    return module.exports;
  }
});
