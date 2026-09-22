// dsh-workspace-manager — 宿主半区
//
// 一个插件自有 RPC 端点，三组能力：
//   state / setClosed      —— 「已关闭工作区」集合的读写（本插件自己的状态文件）
//   archive / unarchive    —— 会话归档（官方 archiveSession）与可逆恢复（注册表自己的写链）
//   inventory / remove     —— 会话清点（含"未分组"归属，以及会话树的 parentId/kind/orphan）
//                            与彻底移除（删掉磁盘工件；`cascade` 先子后父、只在同一工作区内连带）
//
// 外加一个**宿主服务** `sessionRemoval`（`ctx.provide`）：把上面那套测过的文件级删除
// 开放给别的插件调用。删除实现只有一个来源 —— `removeSessionWithContext()`，端点与
// 服务都走它，所以两侧行为不可能漂移。机制在这里，策略（谁该被删、什么时候删）在调用方，
// 详见 session-removal.js 顶部。
//
// 非侵入性：只注册一个 `authority: 'trusted-host'` 的 RPC 端点、只发布一个自有服务，
// 只读使用 `ctx.workspaceRegistry` / `ctx.sessionPersistence` / `ctx.sessions` / `ctx.agents`；
// 不替换、不 disabled、不 shadow 任何内核组件，也不接管任何槽位。

import { archiveSessionId, readArchivedSessionIds, supportsArchiveSetWrite, unarchiveSessionId } from './archive-set.js'
import { openClaimsStore } from './claims-store.js'
import { openClosedStore, resolveDshHome } from './closed-set.js'
import { SessionRemovalError, removeSessionFiles, sessionInventory } from './remove-session.js'
import { SESSION_REMOVAL_SERVICE, createSessionRemovalService } from './session-removal.js'
import { buildSessionTree, collectRuntimeEdges, createRuntimeEdgePromoter, planCascade } from './session-tree.js'
import { registerRpcChannel } from './transport.js'

export const name = 'dsh-workspace-manager'
// `webServer` 是**退回路径**需要的：0.1.5 起官方 `connection.rpc.handle` 会因为
// `dsh-client-connection` 自身 inject 里没有 webServer 而抛错（详见 transport.js 顶部说明），
// 那时本插件改为自己往 `webServer` 注册 prefix 路由。声明它对 0.1.1 无害（两版都提供 webServer）。
export const inject = ['connection', 'webServer', 'agents', 'sessions', 'sessionPersistence', 'workspaceRegistry']

const RPC_PATH = '/dsh-workspace-manager'

/** RPC 通道实际走的路（`connection` = 官方 `rpc.handle`；`webServer` = 本插件退回路由）。 */
let transportVia = 'unknown'
const activeTransport = () => transportVia

/** 结构化业务错误：客户端据此区分"用户操作问题"与"内核故障"。 */
export class WorkspaceManagerError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorkspaceManagerError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new WorkspaceManagerError(code, message)
}

const isId = (value) => typeof value === 'string' && value.trim() !== ''

/** 校验 payload 只含允许的字段（沿用原插件的严格风格，防止客户端漂移）。 */
function assertPayload(payload, allowed, required = allowed) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('bad-request', 'payload must be an object')
  }
  const keys = Object.keys(payload)
  const unknown = keys.find((key) => !allowed.includes(key))
  if (unknown !== undefined) fail('bad-request', `payload contains an unknown field ${JSON.stringify(unknown)}`)
  for (const key of required) {
    if (!Object.hasOwn(payload, key)) fail('bad-request', `payload is missing ${JSON.stringify(key)}`)
  }
}

/** 当前登记的会话列表（活会话 + 持久化），失败时返回空表而不是抛错。 */
async function listWorkspaces(ctx) {
  try {
    const workspaces = ctx.workspaceRegistry.list()
    return Array.isArray(workspaces) ? workspaces : []
  } catch {
    return []
  }
}

/**
 * 把会话从所有列出它的工作区记账（`sessionIds`）里摘掉。
 *
 * 为什么必须做：会话归属记在注册表 `tables.workspaces[*].sessionIds` 里。删掉工件却不摘记账，
 * 设置页与侧栏会继续把它列出来 —— 标题退化成原始 id、而且（因为磁盘上没有工件）没有任何
 * 可点的操作，变成永远清不掉的幽灵行。
 *
 * 尽力而为：老版本注册表行上没有 `detachSession` 时只报告失败，不让删除本身失败。
 */
async function detachSessionFromWorkspaces(ctx, sessionId) {
  const detachedFrom = []
  const detachFailures = []
  for (const workspace of await listWorkspaces(ctx)) {
    const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
    if (!ids.includes(sessionId)) continue
    if (typeof workspace.detachSession !== 'function') {
      detachFailures.push({ workspaceId: workspace.id, reason: 'unsupported-detach' })
      continue
    }
    try {
      await workspace.detachSession(sessionId)
      detachedFrom.push(workspace.id)
    } catch (error) {
      detachFailures.push({ workspaceId: workspace.id, reason: String(error?.message ?? error) })
    }
  }
  return { detachedFrom, detachFailures }
}

async function managerState(ctx, store) {
  const workspaces = await listWorkspaces(ctx)
  // 关掉已经不存在的记录（被真正删除的工作区）；仍存在的工作区一定在列表里，
  // 因为"关闭"只是本插件的视图层概念，不影响内核注册表。
  await store.prune(workspaces.map((workspace) => workspace.id))
  return {
    closedWorkspaceIds: store.ids(),
    canRestoreArchive: supportsArchiveSetWrite(ctx.workspaceRegistry),
    archivedSessionIds: readArchivedSessionIds(ctx.workspaceRegistry) ?? [],
    statePath: store.file,
    // ── 诊断字段（用于跨 DSH 版本比对；也是"归档看到多少会话"的取证）──
    /** RPC 通道实际走的是官方 `connection.rpc.handle` 还是本插件的退回路由。 */
    transport: activeTransport(),
    /** 内核注册表记账里到底挂了多少会话 id —— 0 就说明新版换了记账方式。 */
    sessionAccounting: {
      workspaces: workspaces.length,
      withSessions: workspaces.filter((workspace) => (workspace.sessionIds ?? []).length > 0).length,
      totalSessionIds: workspaces.reduce((sum, workspace) => sum + (workspace.sessionIds ?? []).length, 0),
    },
  }
}

/** 活跃会话判定（端点与宿主服务共用同一算法）：内存里的 handle / agent 还在跑就算活跃。 */
function isActiveSession(ctx, sessionId) {
  return ctx.sessions.get(sessionId) !== undefined || ctx.agents.get(sessionId) !== undefined
}

/**
 * 删掉**一个**会话（不级联）—— 端点与宿主服务共用的唯一删除实现的最小单元。
 *
 * 顺序（与旧版单会话删除完全一致）：摘官方归档条目 → 删文件 → 摘工作区记账 → 清登记表。
 * 这里刻意不接收 payload，只接收**已验证过**的 sessionId（形态/白名单由调用方先判）。
 * @param ctx - 宿主上下文。
 * @param sessionId - 非空字符串（调用方已确保）。
 * @param options - `{ workspaces, claims?, tolerateMissing? }`：
 *   `workspaces` 是本次已经取过的注册表列表（避免级联时每个子孙都遍历一遍）；
 *   `claims` 是登记表（有就顺手清账本）；`tolerateMissing` 让"子孙的工件已经不在"不致命。
 * @returns `{ report, filesMissing, archiveCleared, detachedFrom, detachFailures }`。
 */
async function removeSingleSession(ctx, sessionId, options = {}) {
  const workspaces = options.workspaces ?? (await listWorkspaces(ctx))
  const claims = options.claims
  // 注册表是否还记着它：决定"工件已不在"时是报错、还是只清理记账。
  const listed = workspaces.some((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
  // 官方归档集合里的 id 要先摘掉，否则会留下指向已删会话的孤儿条目。
  const archived = readArchivedSessionIds(ctx.workspaceRegistry) ?? []
  let archiveCleared = false
  if (archived.includes(sessionId)) {
    const outcome = await unarchiveSessionId(ctx.workspaceRegistry, sessionId)
    archiveCleared = outcome.ok === true && outcome.changed === true
  }
  let report
  let filesMissing = false
  try {
    report = await removeSessionFiles(resolveDshHome(), sessionId)
  } catch (error) {
    const missing = error instanceof SessionRemovalError && error.code === 'session-not-found'
    // 工件早就不在了（先前删过、或手工删掉）：
    //   * 注册表还留着记账 → 只清记账；
    //   * 级联的子孙（tolerateMissing）→ 目标状态"它已经没了"已经达成，不因此让整棵删到一半；
    //   * 其余情况（用户单删一个不存在的会话）才报 session-not-found。
    if (!missing || (!listed && options.tolerateMissing !== true)) throw error
    filesMissing = true
    report = { sessionId, removed: [], bytes: 0, prunedProjects: [] }
  }
  // 删完必须摘记账，否则会话会以"注册表认得、磁盘上没有"的幽灵行留在列表里。
  const detach = await detachSessionFromWorkspaces(ctx, sessionId)
  // 会话没了，登记（白名单 + 父指针）也没有留着的意义；否则 claims 文件会一路长下去。
  // 账本清理失败不影响删除结果（下次 claim/删除时还会再清一遍）。
  if (claims !== undefined && typeof claims.delete === 'function') {
    try {
      await claims.delete([sessionId])
    } catch (error) {
      ctx.logger?.warn?.(`dsh-workspace-manager: 清理会话登记失败（不影响删除结果）：${String(error?.message ?? error)}`)
    }
  }
  return { report, filesMissing, archiveCleared, detachedFrom: detach.detachedFrom, detachFailures: detach.detachFailures }
}

/**
 * 彻底移除一个会话 —— **端点与宿主服务共用的唯一实现**。
 *
 * 抽出来只为一件事：`sessionRemoval` 服务必须与用户在设置页点「彻底删除」走完全相同的
 * 判定与善后（活跃拒绝 → 摘归档条目 → 删文件 → 摘工作区记账），否则两条路会各自漂移。
 * 这里刻意不接收 payload，只接收**已验证过**的 sessionId（形态/白名单由调用方先判）。
 *
 * **级联（cascade，默认关）**：设置页可以在删父会话时一并删掉它的子会话。
 *   * 删除顺序是**先子后父**（`planCascade` 按"深度大的先删"排序，保证任何节点都晚于它的子会话）；
 *   * **任一子孙活跃就整体拒绝**（`session-active`，一个字节都不删）——半个级联比不级联更难收场；
 *   * **只在同一工作区内连带**：跨工作区的子孙留在磁盘上，逐个记进 `skipped`（原因 `different-workspace`）；
 *   * 计划只建立在磁盘清点行 + 登记表之上，做计划时不碰任何文件。
 * 宿主服务（`sessionRemoval.remove`）**永远**走非级联路径 —— 它删的是"某个插件自己的临时会话"，
 * 顺手连带一串别人不认识的会话是危险的。
 *
 * @param ctx - 宿主上下文。
 * @param store - `openClosedStore()` 的结果。
 * @param sessionId - 非空字符串（调用方已确保）。
 * @param options - `{ cascade?, claims? }`；`claims` 是登记表（用来合成树 + 删完清账本）。
 * @returns 与端点 `remove` 相同的报告（级联时含 `removedIds` / `childrenRemoved` / `skipped`）。
 */
async function removeSessionWithContext(ctx, store, sessionId, options = {}) {
  const cascade = options.cascade === true
  const claims = options.claims
  // 活跃会话的写句柄还持有这个工件，先拒绝（判定在任何删除之前）。
  if (isActiveSession(ctx, sessionId)) {
    fail('session-active', `session ${JSON.stringify(sessionId)} is active; switch away from it before removing it`)
  }
  const workspaces = await listWorkspaces(ctx)

  // ── 级联计划（纯计算；这一步不碰任何文件，所以"拒绝"就不会留下半个级联）──
  let plan = { deleteOrder: [], skipped: [] }
  if (cascade) {
    const inventory = await sessionInventory(
      resolveDshHome(),
      workspaces.map((workspace) => ({ workspaceId: workspace.id, path: workspace.path })),
    )
    const tree = buildSessionTree({
      rows: inventory.sessions,
      claims: claims === undefined ? [] : await claims.entries(),
      runtime: collectRuntimeEdges(ctx),
      logger: ctx.logger,
    })
    plan = planCascade(tree, sessionId)
    const blocker = plan.deleteOrder.find((id) => isActiveSession(ctx, id))
    if (blocker !== undefined) {
      fail(
        'session-active',
        `descendant ${JSON.stringify(blocker)} of ${JSON.stringify(sessionId)} is active; `
        + 'switch away from the whole tree before removing it (nothing was deleted)',
      )
    }
  }

  // ── 先子、后父 ──
  const results = []
  const removedIds = []
  for (const id of [...plan.deleteOrder, sessionId]) {
    results.push(await removeSingleSession(ctx, id, {
      workspaces,
      claims,
      // 子孙：工件在计划之后消失（并发/手工删）不算失败——它已经没了，目标状态达成。
      tolerateMissing: id !== sessionId,
    }))
    removedIds.push(id)
  }
  const flat = (pick) => results.flatMap((result) => pick(result))
  return {
    sessionId,
    cascade,
    removedIds,
    childrenRemoved: removedIds.filter((id) => id !== sessionId),
    skipped: plan.skipped,
    removed: flat((result) => result.report.removed),
    bytes: results.reduce((sum, result) => sum + result.report.bytes, 0),
    prunedProjects: [...new Set(flat((result) => result.report.prunedProjects))],
    // 级联时是"任一目标没有工件"；单删时与旧语义逐字相同。
    filesMissing: results.some((result) => result.filesMissing),
    archiveCleared: results.some((result) => result.archiveCleared),
    detachedFrom: [...new Set(flat((result) => result.detachedFrom))],
    detachFailures: flat((result) => result.detachFailures),
    ...(await managerState(ctx, store)),
  }
}

/**
 * 建立 RPC 处理器。
 * @param ctx - 宿主上下文。
 * @param storePromise - `openClosedStore()` 的结果。
 * @param claimsPromise - `openClaimsStore()` 的结果（或它的 Promise）。缺省时按默认路径自己开一份
 *   —— 端点的 `inventory`/`remove` 都要登记表（合成会话树、删完清账本）。生产环境由 `apply`
 *   传入**与宿主服务共用**的那一份，两侧不会各自记账。
 * @param promoter - `createRuntimeEdgePromoter()` 的结果（可选）。`inventory` 每次都会顺手
 *   提升一次"运行时观察到的父子边"；缺省时按同一份账本现建一个（缓存只活在本处理器内）。
 * @returns 端点处理器。
 */
export function createRpcHandler(ctx, storePromise, claimsPromise, promoter) {
  let claimsPending = claimsPromise
  /** 登记表（instance 或 promise 都接受）；只在这里创建一次，**并等它读完盘**再交出去。 */
  const claimsStore = async () => {
    if (claimsPending === undefined) claimsPending = openClaimsStore({ logger: ctx?.logger })
    const store = await claimsPending
    // `entries()` 是同步视图：不等 ready 就会把"还没读完"当成"没有登记"。
    await store.ready
    return store
  }
  // 运行时边的提升器：没被传一个时，按同一份账本现建一个（去重缓存只在本处理器内）。
  const runtimePromoter = promoter ?? createRuntimeEdgePromoter({ store: claimsStore(), logger: ctx?.logger })
  /** 提升（观察到的边 → 账本）：**永不**让失败影响清点/删除，只告警。 */
  const promoteQuietly = async () => {
    try {
      await runtimePromoter.promote(ctx)
    } catch (error) {
      ctx?.logger?.warn?.(
        'dsh-workspace-manager: 提升运行时父子边失败（不影响清点）：%s',
        String(error?.message ?? error),
      )
    }
  }
  return async (endpoint, payload) => {
    try {
      const store = await storePromise
      switch (endpoint) {
        case 'state':
          return { ok: true, value: await managerState(ctx, store) }

        case 'setClosed': {
          assertPayload(payload, ['workspaceIds'])
          if (!Array.isArray(payload.workspaceIds)) fail('bad-request', 'workspaceIds must be an array')
          const changed = await store.setClosed(payload.workspaceIds)
          return { ok: true, value: { changed, ...(await managerState(ctx, store)) } }
        }

        case 'close':
        case 'open': {
          assertPayload(payload, ['workspaceId'])
          if (!isId(payload.workspaceId)) fail('bad-request', 'workspaceId must be a non-empty string')
          const changed = endpoint === 'close'
            ? await store.close(payload.workspaceId)
            : await store.open(payload.workspaceId)
          return { ok: true, value: { changed, ...(await managerState(ctx, store)) } }
        }

        case 'archive':
        case 'unarchive': {
          assertPayload(payload, ['sessionId'])
          if (!isId(payload.sessionId)) fail('bad-request', 'sessionId must be a non-empty string')
          const outcome = endpoint === 'archive'
            ? await archiveSessionId(ctx.workspaceRegistry, payload.sessionId)
            : await unarchiveSessionId(ctx.workspaceRegistry, payload.sessionId)
          if (!outcome.ok) {
            const code = outcome.reason === 'unsupported-registry' ? 'unsupported-dsh-version' : 'bad-request'
            fail(code, outcome.reason ?? 'archive operation failed')
          }
          return { ok: true, value: { changed: outcome.changed, ...(await managerState(ctx, store)) } }
        }

        case 'inventory': {
          // 磁盘清点 + 归属判定 + 会话树。只读：不写任何文件，也不碰内核服务。
          const snapshot = await managerState(ctx, store)
          const archived = new Set(snapshot.archivedSessionIds)
          const workspaces = await listWorkspaces(ctx)
          const inventory = await sessionInventory(
            resolveDshHome(),
            workspaces.map((workspace) => ({ workspaceId: workspace.id, path: workspace.path })),
          )
          // 父子关系：持久化登记（优先）+ 运行时快照（尽力而为）。历史遗留不追认 ——
          // 没有父指针的裸 UUID 会话就是"子会话、父未知"，不掉行、不报错、不推断。
          const claims = await claimsStore()
          // 顺手做一次**增量提升**：设置页每次打开都会清点，这是最自然的捕获时机 ——
          // 把此刻运行时还看得到的父子边学进账本（平台自带的 subagent/subagent_fork 不走登记），
          // 于是下一次冷启动也读得到。**不影响**下面返回的父子关系：合成仍然走
          // "登记 > 运行时 > 观察"（观察边只在运行时读不到时兜底），提升只是让"跨重启的那一半"也成立。
          await promoteQuietly()
          const tree = buildSessionTree({
            rows: inventory.sessions,
            claims: await claims.entries(),
            runtime: collectRuntimeEdges(ctx),
            logger: ctx.logger,
          })
          return {
            ok: true,
            value: {
              ...inventory,
              sessions: inventory.sessions.map((session) => {
                const node = tree.byId.get(session.id)
                const active = isActiveSession(ctx, session.id)
                return {
                  ...session,
                  // 会话树（设置页据此缩进显示、删除确认框据此算"连带几个子会话"）。
                  parentId: node?.parentId ?? null,
                  kind: node?.kind ?? 'session',
                  orphan: node?.orphan === true,
                  archived: archived.has(session.id),
                  active,
                  // 客户端据此决定「彻底删除」按钮是否可点；reason 直接给用户看。
                  removable: session.safeId === true && !active,
                  reason: session.safeId !== true ? 'unsafe-id' : active ? 'session-active' : undefined,
                }
              }),
            },
          }
        }

        case 'remove': {
          // `cascade` 可选、默认 false（保持旧行为）；给了就必须是 boolean（沿用严格校验风格）。
          assertPayload(payload, ['sessionId', 'cascade'], ['sessionId'])
          if (!isId(payload.sessionId)) fail('bad-request', 'sessionId must be a non-empty string')
          if (payload.cascade !== undefined && typeof payload.cascade !== 'boolean') {
            fail('bad-request', 'cascade must be a boolean when provided')
          }
          return {
            ok: true,
            value: await removeSessionWithContext(ctx, store, payload.sessionId, {
              cascade: payload.cascade === true,
              claims: await claimsStore(),
            }),
          }
        }

        default:
          fail('bad-request', `unknown dsh-workspace-manager endpoint ${JSON.stringify(endpoint)}`)
      }
    } catch (error) {
      // 表面化真实失败：原插件同样的做法（[local debug override]）。
      console.error('[dsh-workspace-manager] request failed:', error)
      const code = error instanceof WorkspaceManagerError
        ? error.code
        : error instanceof SessionRemovalError ? error.code : 'internal'
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: {
          code,
          message,
          details: { code, message, stack: error instanceof Error ? String(error.stack) : null },
        },
      }
    }
  }
}

export function apply(ctx) {
  const storePromise = openClosedStore({ logger: ctx.logger })
  // 会话登记表（父子关系 + 白名单）：**端点与宿主服务共用同一个实例** —— 否则端点删完会话
  // 忘了登记、服务那边还留着，两边会不一致。名字/目录约定见 claims-store.js。
  const claimsStore = openClaimsStore({ logger: ctx.logger })
  // 运行时观察到的父子边的"提升"器：平台自带的 `subagent` / `subagent_fork` 不走
  // `sessionRemoval.claim()` 登记，它们的父关系本来只活在当前进程的内存里 —— 把此刻读得到的
  // 边学进账本，下一次冷启动也能挂回父会话下面。**端点与启动提升共用同一个实例**，
  // 去重缓存与并发合并才不会各算各的（见 session-tree.js）。
  const promoter = createRuntimeEdgePromoter({ store: claimsStore, logger: ctx.logger })
  ctx.effect(
    () => {
      const channel = registerRpcChannel(ctx, RPC_PATH, createRpcHandler(ctx, storePromise, claimsStore, promoter))
      transportVia = channel.via
      return channel.dispose
    },
    'dsh-workspace-manager: rpc',
  )

  // 会话清理的宿主服务：把 remove-session.js 的机制开放给别的插件（策略仍在调用方）。
  // 消费方用 `ctx.get('sessionRemoval')` 探测式获取；这里用 `ctx.provide`（cordis 原语，
  // 随本插件的 fiber 一起卸载）。缺 `provide`（极老的 cordis / 受限 ctx）时只告警，
  // 不影响本插件自己的端点。
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide(
        SESSION_REMOVAL_SERVICE,
        createSessionRemovalService({
          ctx,
          logger: ctx.logger,
          // 同一个登记表实例：端点的 inventory/remove 看到的就是服务记下的父子关系。
          claimsStore,
          // 与端点同一个实现 —— 两侧行为不可能漂移。**不级联**：服务删的是调用方自己的临时会话，
          // 顺手连带一串它不认识的会话是危险的（级联只在设置页的显式操作里发生）。
          performRemoval: async (sessionId) => removeSessionWithContext(ctx, await storePromise, sessionId),
        }),
      )
    } catch (error) {
      // 服务名被别人占了（cordis 会抛 "service ... has been registered"）：只告警，
      // 绝不因此让本插件自己的端点/设置页失效。
      ctx.logger?.warn?.(
        'dsh-workspace-manager: 发布 %s 服务失败（名字可能已被占用），其它插件将无法清理会话：%s',
        SESSION_REMOVAL_SERVICE,
        String(error?.message ?? error),
      )
    }
  } else {
    ctx.logger?.warn?.('dsh-workspace-manager: ctx.provide 不可用，sessionRemoval 服务未发布（其它插件将无法清理会话）')
  }

  // 启动时提升一次（**不 await**，apply 是同步的、启动不能被它拖住）：把此刻运行时还看得到的
  // 父子边学进账本，于是重启后冷启动也能从账本读到 —— 包括平台自带 subagent 工具产出的、
  // 以及本功能上线之前产生但此刻仍在运行时列表里的子会话。
  // 提升自己**永不抛错**（失败只告警），catch 只是最后一道保险：绝不能让它影响插件 apply。
  promoter.promote(ctx).catch((error) => {
    ctx.logger?.warn?.(
      'dsh-workspace-manager: 启动时提升运行时父子边失败（不影响插件功能）：%s',
      String(error?.message ?? error),
    )
  })
}
