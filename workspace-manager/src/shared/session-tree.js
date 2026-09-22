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
export function isSubagentSessionId(value) {
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
export function isSameWorkspace(left, right) {
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
export function declaredParentId(row) {
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
export function childrenIndex(rows) {
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
export function topLevelRows(rows) {
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
export function hiddenByArchivedParentIds(rows, archivedIds) {
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
