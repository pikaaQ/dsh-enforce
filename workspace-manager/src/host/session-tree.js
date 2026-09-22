// dsh-workspace-manager — 会话树（宿主侧）：把"父子会话关系"合成一张图，并给出级联删除计划
//
// 来源与优先级（**登记 > 运行时 > 观察**；且**不推断历史遗留**）：
//   1. **持久化登记**（`source: 'claim'`：`sessionRemoval.claim(owner, ids, { parentSessionId })`
//      → 本插件自己的 `$DSH_HOME/dsh-workspace-manager.claims.json`）——权威来源，跨重启有效；
//   2. **运行时内存**（`ctx.sessions.list()` / `ctx.agents.list()` 的 session header 里的
//      `parentSession`）——尽力而为：0.1.5 的 header 确实带这个字段
//      （dsh-session/lib/types/types.d.ts:71），但拿不到时**不报错、不猜**，只是少一条边；
//   3. **提升进账本的观察边**（`source: 'observed'`：见下面的 {@link createRuntimeEdgePromoter}）
//      —— 它是**运行时快照的持久化镜像**：进程里还看得见这条边时以运行时为准（上面第 2 条），
//      运行时读不到时（刚重启）才用它兜底 —— 于是平台自带的 `subagent` / `subagent_fork`
//      （**不走** claim 登记）产出的子会话，重启后仍然挂得回父会话下面。
//
// 明确不做的事（边界，别在这里加回来）：
//   * **不解析会话日志兜底**：父子关系只覆盖"生产者登记过的"，以及"此刻在运行时列表里还看得到、
//     因而被提升进账本的"会话；历史遗留的裸 UUID 会话如果没有父指针，就按"子会话、父未知"显示
//     —— 不掉行、不报错、不推断。
//     （父日志里确实有据可查：v3 事件流里的 `subagent/catalog` 带 `data.childId`，
//      子会话自己的 v3 首事件带 `parentSession`；那是"将来若要追认"的路，本版本故意不走。）
//   * **不读锚定历史决定删谁**：级联的删除计划只建立在**磁盘清点行**（真实存在的会话）之上。
//
// 防御（都是纯计算，先于任何文件操作）：
//   * 自引用（`parentId === 自己`）→ 丢弃这条边并记 `self-reference`；
//   * 孤儿（声明了父但父行不在清点里）→ 记 `orphan`，父指针解析为 null（不掉行）；
//   * 环（甲→乙→甲）→ 确定性破环：环里 id 最小（字典序）的那个节点被摘掉父边，记 `cycle-broken`
//     并告警，保证图一定是森林（级联不会无限循环）；**提升也走同一套防御**（写盘之前）；
//   * 跨项目键（子会话的工件落在另一个项目键下）→ 照常建树（清点行里有它就够）；
//   * 跨工作区 → 建树，但**级联不连带**（见 planCascade 的 skipped）。

import { isSameWorkspace, isSubagentSessionId } from '../shared/session-tree.js'
import { isSafeSessionId } from './remove-session.js'

const isNonEmptyString = (value) => typeof value === 'string' && value !== ''

/**
 * 来源优先级（数字大者赢）：**登记 > 运行时 > 观察**。
 *
 * 观察条目刻意排在**运行时之后**：它是"运行时快照的持久化镜像"，只在运行时读不到时才顶上
 * （刚重启、会话还没进内存）。这样提升**不会改变**进程内 `inventory` 看得见的关系
 * （那仍然走"登记 > 运行时"），也堵掉了"账本里一条过期的观察边盖住当前运行时事实"的可能。
 */
const SOURCE_RANK = { observed: 0, runtime: 1, claim: 2 }

/** 条目声明的来源 → 树里的来源名（缺省 = 生产者登记，兼容没有 `source` 的老账本）。 */
const claimSourceOf = (entry) => (entry?.source === 'observed' ? 'observed' : 'claim')

/** 取一个会话对象上的 session header（`agent.session.header` / `session.header` 两种形状）。 */
function headerOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value.session?.header ?? value.header ?? value.session
  return candidate !== null && typeof candidate === 'object' ? candidate : undefined
}

/**
 * 运行时父子边（尽力而为，**绝不抛错**）。
 *
 * 只读两个内存快照：`ctx.sessions.list()`（内核会话存储，`list(): Session[]`）与
 * `ctx.agents.list()`（活代理注册表）。每条边取 header 上的 `parentSession`。
 * 拿不到（服务没装、形状变了、方法不存在）就返回空数组 —— 这是能力缺失，不是错误。
 * @param ctx - 宿主上下文。
 * @returns `[{ id, parentId, source: 'runtime' }]`。
 */
export function collectRuntimeEdges(ctx) {
  const edges = []
  const push = (childId, parentId) => {
    if (!isNonEmptyString(childId) || !isNonEmptyString(parentId) || childId === parentId) return
    edges.push({ id: childId, parentId, source: 'runtime' })
  }
  const fromList = (values) => {
    if (!Array.isArray(values)) return
    for (const value of values) {
      const header = headerOf(value)
      if (header === undefined) continue
      push(value?.id ?? value?.session?.id ?? header.id, header.parentSession)
    }
  }
  try {
    fromList(ctx?.sessions?.list?.())
  } catch {
    /* 快照读不到就少一条边（能力缺失，不是错误） */
  }
  try {
    fromList(ctx?.agents?.list?.())
  } catch {
    /* 同上 */
  }
  return edges
}

// ── 运行时观察到的边 → 账本（"提升"）──────────────────────────────────────────
//
// 为什么要有它：平台自带的 `subagent` / `subagent_fork` 工具（任何会话都能用）**不走**
// `sessionRemoval.claim()` —— 那是本插件的服务，内核不知道。于是这类子会话的父关系只活在
// **当前进程的内存**里，`dsh web` 一重启就没了（现场的 `claims.json` 根本不会生成）。
// 这里把"此刻在运行时列表里还看得到的"边学进账本（`source: 'observed'`），下一次冷启动
// 就能从账本里读到，而不是去改平台的 spawn 路径。
//
// 边界（与 README 一致）：**只有此刻读得到的边**才会被提升 —— 会话头里有 `parentSession`
// 就行，包括本功能上线**之前**产生、但此刻仍在运行时列表里的子会话；进程早已结束、header
// 已经读不到的会话**不追认**（不解析会话日志、不推断）。
//
// 防御与合成阶段同一套，且全部发生在**写盘之前**：自引用丢弃、id 形态不安全就跳过、
// 环确定性断开（与 buildSessionTree 同一规则：环里 id 最小的节点被摘掉父边）。
// 提升**只写"观察"条目**，绝不改已有登记（`mergeEntry` 保证：登记优先）。

/** 提升报告：`{ ok, candidates, promoted, declined, skipped, wrote }`（`ok: false` = 只告警，没落盘）。 */
const emptyReport = () => ({ ok: true, candidates: 0, promoted: [], declined: [], skipped: [], wrote: false })

/**
 * 从观察边里挑出"该写进账本"的那些（纯计算）。
 *
 * @param rawEdges - {@link collectRuntimeEdges} 的结果（或测试注入的同形数组）。
 * @param cache - `Map<子 id, 父 id>`：本进程内已经提升过的边（去重缓存，可为空）。
 * @param report - 就地累计 `candidates` / `skipped`。
 * @param logger - 破环时告警用。
 * @returns `[{ id, parentId }]`。
 */
function selectPromotableEdges(rawEdges, cache, report, logger) {
  // 同一个子会话可能在 `ctx.sessions` 与 `ctx.agents` 里各出现一次：取先出现的那条。
  const unique = new Map()
  for (const edge of Array.isArray(rawEdges) ? rawEdges : []) {
    if (!isNonEmptyString(edge?.id) || !isNonEmptyString(edge?.parentId)) continue
    if (!unique.has(edge.id)) unique.set(edge.id, edge)
  }
  const fresh = []
  for (const edge of unique.values()) {
    report.candidates += 1
    if (edge.id === edge.parentId) {
      report.skipped.push({ id: edge.id, parentId: edge.parentId, reason: 'self-reference' })
      continue
    }
    // 形态不安全（不能当目录名 / 含 `..`）的父子 id 一律不落盘 —— 账本只收安全 id。
    if (!isSafeSessionId(edge.id) || !isSafeSessionId(edge.parentId)) {
      report.skipped.push({ id: edge.id, parentId: edge.parentId, reason: 'unsafe-id' })
      continue
    }
    // 本进程内已经提升过这条边：不重复 diff、不重复写盘（父变了就不算"同一条"）。
    if (cache?.get(edge.id) === edge.parentId) {
      report.skipped.push({ id: edge.id, parentId: edge.parentId, reason: 'already-promoted' })
      continue
    }
    fresh.push({ id: edge.id, parentId: edge.parentId })
  }
  // 环：确定性断开（与 buildSessionTree 同一个受害者规则），保证写进账本的图一定是森林。
  const parentOf = new Map(fresh.map((edge) => [edge.id, edge.parentId]))
  const broken = []
  for (let guard = 0; guard <= parentOf.size; guard += 1) {
    const cycle = findCycle(parentOf)
    if (cycle === undefined) break
    const victim = [...cycle].sort()[0]
    parentOf.delete(victim)
    broken.push(victim)
  }
  if (broken.length > 0) {
    report.skipped.push(...broken.map((id) => ({ id, reason: 'cycle-broken' })))
    logger?.warn?.(
      'dsh-workspace-manager: 提升运行时父子边时发现环（父指针互相指向），已确定性断开：%s',
      broken.join(', '),
    )
  }
  return fresh.filter((edge) => parentOf.get(edge.id) === edge.parentId)
}

/**
 * 把运行时观察到的父子边"提升"进账本（一次性；`cache` 传同一个 Map 即可跨调用去重）。
 *
 * **永不抛错**：读账本 / 写盘失败都只告警并返回 `{ ok: false, ... }` —— 调用方在 `apply()`
 * 启动路径与 `inventory` 端点里都用它，绝不能让"学一条边"拖垮插件。
 *
 * @param ctx - 宿主上下文（只读 `ctx.sessions` / `ctx.agents`）。
 * @param store - {@link openClaimsStore} 的结果（或它的 Promise；`null`/`undefined` = no-op）。
 * @param options - `{ cache?, logger?, collect? }`；`collect` 默认 {@link collectRuntimeEdges}。
 * @returns `{ ok, candidates, promoted, declined, skipped, wrote }`：
 *   `promoted` 是**真的以观察条目落进账本**的 id；`declined` 是被账本按"登记优先"忽略的
 *   （那个 id 已经有生产者登记，观察到的边动不了它）；`wrote` = 这次真的写盘了。
 */
export async function promoteRuntimeEdges(ctx, store, options = {}) {
  const { cache, logger, collect = collectRuntimeEdges } = options
  const report = emptyReport()
  if (store === null || store === undefined) return report
  try {
    const target = await store
    await target.ready
    const edges = selectPromotableEdges(collect(ctx), cache, report, logger)
    if (edges.length === 0) return report
    const now = Date.now()
    const changed = await target.setMany(edges.map((edge) => ({
      id: edge.id,
      parentSessionId: edge.parentId,
      source: 'observed',
      observedAt: now,
    })))
    report.wrote = changed === true
    // 读回一次，区分"真的成了观察条目"与"被已有登记挡住了"（后者不该谎报成提升成功）。
    const canReadBack = typeof target.get === 'function'
    for (const edge of edges) {
      const entry = canReadBack ? target.get(edge.id) : undefined
      const accepted = !canReadBack || (entry?.source === 'observed' && entry.parentSessionId === edge.parentId)
      if (accepted) report.promoted.push(edge.id)
      else report.declined.push(edge.id)
    }
    if (cache instanceof Map) for (const edge of edges) cache.set(edge.id, edge.parentId)
  } catch (error) {
    report.ok = false
    logger?.warn?.(
      'dsh-workspace-manager: 提升运行时父子边失败（不影响清点与删除，只是这些边这次没落盘）：%s',
      String(error?.message ?? error),
    )
  }
  return report
}

/**
 * 提升器（**每个插件实例一个**）：持有进程内去重缓存，并把并发调用合并成一次。
 *
 * 为什么要缓存：设置页每次打开都会 `inventory` 一次，不能每次都重读账本、重写整个文件；
 * 缓存命中（同一条 子→父 边）就直接跳过。新出现的边（刚 spawn 的子会话）仍会被捕获。
 * 为什么是实例级：模块级缓存会在"新实例重新读了账本"时给出错误的跳过判断（测试与
 * 重挂载都会踩到）。
 *
 * @param options - `{ store, logger?, collect? }`。
 * @returns `{ promote }`；`promote(ctx)` 永不抛错，返回 {@link promoteRuntimeEdges} 的报告。
 */
export function createRuntimeEdgePromoter({ store, logger, collect } = {}) {
  /** 已提升过的边：子 id → 父 id。 */
  const cache = new Map()
  let inflight
  const promote = (ctx) => {
    // 启动提升与设置页清点可能撞在一起：合并成一次（同一份快照、同一次写盘）。
    if (inflight !== undefined) return inflight
    inflight = promoteRuntimeEdges(ctx, store, { cache, logger, collect }).finally(() => {
      inflight = undefined
    })
    return inflight
  }
  return { promote }
}

/** 在"子 → 父"映射里找第一个环，返回环上的 id 数组；无环返回 undefined。 */
function findCycle(resolved) {
  for (const start of resolved.keys()) {
    const seen = new Map()
    const chain = []
    let cursor = start
    while (cursor !== undefined) {
      if (seen.has(cursor)) return chain.slice(seen.get(cursor))
      seen.set(cursor, chain.length)
      chain.push(cursor)
      cursor = resolved.get(cursor)
    }
  }
  return undefined
}

/**
 * 合成会话树。
 *
 * @param options - `{ rows, claims, runtime, logger }`：
 *   `rows` 是磁盘清点行（必须有 `id`；`workspaceId` 用来判定"同一工作区"）；
 *   `claims` 是持久化账本条目 `[{ id, owner?, source?, parentSessionId }]`
 *   （`source: 'observed'` 的也走这里 —— 它们已经落盘，但优先级**低于**运行时快照，
 *   只在运行时读不到时兜底）；
 *   `runtime` 是 {@link collectRuntimeEdges} 的结果（只补账本里没有的边）。
 * @returns `{ nodes, byId, parentOf, childrenOf, descendantsOf, roots, stats }`；
 *   `nodes` 与 `rows` 同序，每项在原始行上追加
 *   `parentId`（解析成功的父，无则 null）、`declaredParentId`（声明的父，含孤儿）、
 *   `kind`（`'subagent' | 'session'`）、`orphan`、`flags`、`depth`、`childIds`、
 *   `parentSource`（`'claim' | 'observed' | 'runtime'`）。
 */
export function buildSessionTree({ rows = [], claims = [], runtime = [], logger } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row !== null && typeof row === 'object' && isNonEmptyString(row.id))
  const byId = new Map()
  for (const row of list) if (!byId.has(row.id)) byId.set(row.id, row)

  /** 子 id → { parentId, source }；按"来源优先级"取强者（登记 > 运行时 > 观察）。 */
  const edges = new Map()
  const addEdge = (childId, parentId, source) => {
    if (!isNonEmptyString(childId) || !isNonEmptyString(parentId)) return
    if (!byId.has(childId)) return // 磁盘上没有这个子会话：不进树（不让幽灵行挂到父节点下面）
    const existing = edges.get(childId)
    if (existing !== undefined && SOURCE_RANK[existing.source] >= SOURCE_RANK[source]) return
    edges.set(childId, { parentId, source })
  }
  for (const entry of Array.isArray(runtime) ? runtime : []) addEdge(entry?.id, entry?.parentId, 'runtime')
  for (const entry of Array.isArray(claims) ? claims : []) addEdge(entry?.id, entry?.parentSessionId, claimSourceOf(entry))

  const resolved = new Map()
  const declared = new Map()
  const flags = new Map()
  const mark = (id, flag) => {
    const current = flags.get(id)
    if (current === undefined) flags.set(id, [flag])
    else current.push(flag)
  }
  for (const [childId, edge] of edges) {
    declared.set(childId, edge.parentId)
    if (edge.parentId === childId) {
      mark(childId, 'self-reference')
      continue
    }
    if (!byId.has(edge.parentId)) {
      // 声明了父、但父行不在清点里：孤儿。父子关系保留在 declaredParentId 里（可诊断），
      // 但**不建边** —— 于是它照常显示在顶层，级联也不会从别处波及它。
      mark(childId, 'orphan')
      continue
    }
    resolved.set(childId, edge.parentId)
  }

  // 破环：确定性挑"环里 id 最小"的那个节点摘掉父边，重复到无环（图必然是森林）。
  const cycleBroken = []
  for (let guard = 0; guard <= resolved.size; guard += 1) {
    const cycle = findCycle(resolved)
    if (cycle === undefined) break
    const victim = [...cycle].sort()[0]
    mark(victim, 'cycle-broken')
    cycleBroken.push(victim)
    resolved.delete(victim)
  }
  if (cycleBroken.length > 0) {
    logger?.warn?.(
      'dsh-workspace-manager: 会话树里发现环（父指针互相指向），已确定性断开：%s',
      cycleBroken.join(', '),
    )
  }

  const children = new Map()
  for (const row of list) {
    const parentId = resolved.get(row.id)
    if (parentId === undefined) continue
    const bucket = children.get(parentId)
    if (bucket === undefined) children.set(parentId, [row.id])
    else bucket.push(row.id)
  }

  /** 到根的距离（破环之后图是森林，所以这次游走一定终止）。 */
  const depthOf = (id) => {
    const seen = new Set([id])
    let depth = 0
    let cursor = resolved.get(id)
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      depth += 1
      cursor = resolved.get(cursor)
    }
    return depth
  }

  const nodes = list.map((row) => {
    const parentId = resolved.get(row.id) ?? null
    const declaredParentId = declared.get(row.id) ?? null
    const nodeFlags = flags.get(row.id) ?? []
    const childIds = children.get(row.id) ?? []
    return {
      ...row,
      parentId,
      declaredParentId,
      // 「子会话」的判定：裸 UUID 形态，或**有父指针**（登记/运行时）——后者能覆盖未来换了 id 形态的子会话。
      kind: parentId !== null || declaredParentId !== null || isSubagentSessionId(row.id) ? 'subagent' : 'session',
      orphan: nodeFlags.includes('orphan'),
      flags: nodeFlags,
      depth: depthOf(row.id),
      childIds,
      parentSource: edges.get(row.id)?.source ?? null,
    }
  })

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const childrenOf = (id) => (children.get(id) ?? []).map((childId) => nodeById.get(childId)).filter(Boolean)
  const descendantsOf = (id) => {
    const out = []
    const seen = new Set([id])
    const stack = [...(children.get(id) ?? [])].reverse()
    while (stack.length > 0) {
      const next = stack.pop()
      if (seen.has(next)) continue
      seen.add(next)
      const node = nodeById.get(next)
      if (node !== undefined) out.push(node)
      const grand = children.get(next)
      if (grand !== undefined) for (let index = grand.length - 1; index >= 0; index -= 1) stack.push(grand[index])
    }
    return out
  }

  return {
    nodes,
    byId: nodeById,
    parentOf: (id) => {
      const parentId = resolved.get(id)
      return parentId === undefined ? undefined : nodeById.get(parentId)
    },
    childrenOf,
    descendantsOf,
    roots: () => nodes.filter((node) => node.parentId === null),
    stats: {
      rows: nodes.length,
      subagents: nodes.filter((node) => node.kind === 'subagent').length,
      linked: nodes.filter((node) => node.parentId !== null).length,
      runtimeLinks: nodes.filter((node) => node.parentSource === 'runtime').length,
      orphans: nodes.filter((node) => node.orphan).length,
      cycleBroken: cycleBroken.length,
    },
  }
}

/**
 * 级联删除计划（纯计算，先于任何文件操作）。
 *
 * 语义：**先删子、后删父**，且只在**同一工作区内**连带（`workspaceId` 相同，含都是 null 的
 * 「未分组」桶）。跨工作区的子孙不删，逐个记进 `skipped`（原因 `different-workspace`）。
 * 孤儿从不属于任何子树，因此永远不会被别人的级联波及。
 *
 * @param tree - {@link buildSessionTree} 的结果。
 * @param rootId - 要删除的（父）会话 id。
 * @returns `{ rootId, deleteOrder, skipped, descendantIds }`：
 *   `deleteOrder` 是子孙的删除顺序（深度大的先删，保证任何节点都晚于它的子会话）；
 *   父会话本身不在这里 —— 由调用方最后删（先子后父）。
 */
export function planCascade(tree, rootId) {
  const root = tree?.byId?.get?.(rootId)
  if (root === undefined) return { rootId, deleteOrder: [], skipped: [], descendantIds: [] }
  const descendants = tree.descendantsOf(rootId)
  const eligible = []
  const skipped = []
  for (const node of descendants) {
    if (!isSameWorkspace(root, node)) {
      skipped.push({ id: node.id, reason: 'different-workspace' })
      continue
    }
    eligible.push(node)
  }
  eligible.sort((left, right) => right.depth - left.depth)
  return {
    rootId,
    deleteOrder: eligible.map((node) => node.id),
    skipped,
    descendantIds: descendants.map((node) => node.id),
  }
}
