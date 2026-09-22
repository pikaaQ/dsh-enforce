// dsh-workspace-manager — 「子会话登记」的宿主侧持久化
//
// 要解决什么：`sessionRemoval` 服务要知道"哪些会话是某个插件产出的子会话、它的父会话是谁"，
// 而这件事**内核没有落盘**（子会话的投影缓存 `record.identity` 里没有指向父的字段）。
// 所以父子关系只能由本插件自己记住，而且必须跨重启 —— 否则重启后设置页的树、以及
// 「删父会话时连带子会话」都会失去依据。
//
// 为什么**另开一个文件**（而不是塞进 closed-set 的 `dsh-workspace-manager.state.json`）：
//   1. `openClosedStore().persist()` 会把**它自己的内存副本**整篇写回。登记表若住在同一个
//      文件里，两个长期存活的写入者会互相覆盖（典型的丢更新），而两者谁都不该被对方拖住；
//   2. 两者的语义与消费者不同：关闭集合是整篇下发给客户端的视图状态（`state` 端点原样返回），
//      登记表是 `sessionRemoval` 服务自己的账本（逐条增删，给别的插件用）；
//   3. "容忍旧格式"因此变成免费：旧文件原样不动（`parseState` 本来就忽略未知字段），
//      新文件缺失即空表。
//
// 条目有**两种来源**（`source` 字段，v2 起）：
//   * `'claim'`：某个产出方插件调 `sessionRemoval.claim(owner, ids, { parentSessionId })` 登记的，
//     带 `owner`（白名单键）—— **权威来源**，"观察学到的"边永远不得改写它；
//   * `'observed'`：本插件从运行时 session header 观察到的父子边（见 session-tree.js 的
//     `createRuntimeEdgePromoter`）被"学"进账本，**没有 `owner`**（它不是任何人的产物）。
//     为什么需要它：平台自带的 `subagent` / `subagent_fork` 工具**不走** `claim()` 登记，
//     这类子会话的父关系只活在当前进程的内存里，一重启就没了 —— 落盘才跨重启存活。
//   * 缺 `source` 的条目（v1 老文件 / 手工编辑）一律按 `'claim'` 读：v1 只可能是登记写出来的。
//
// 目录与命名沿用同一约定：`$DSH_HOME/dsh-workspace-manager.claims.json`；
// 写入同样是原子的（临时文件 + fsync + rename），并在队列内串行化。

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isSafeSessionId } from './remove-session.js'

/** 登记表文件名（与 `dsh-workspace-manager.state.json` 同级、同约定）。 */
export const CLAIMS_FILE_NAME = 'dsh-workspace-manager.claims.json'

/**
 * 当前格式版本。v2 起每个条目多一个 `source` 字段（`'claim' | 'observed'`，见文件头）。
 * 读取时**不**因版本更高而拒绝（新版本多出来的字段被忽略即可）；反过来，读 v1 老文件时
 * 缺 `source` 的条目按 `'claim'` 处理。
 */
export const CLAIMS_VERSION = 2

/** 登记来源：生产者广播的登记（权威）。 */
export const CLAIM_SOURCE = 'claim'

/** 登记来源：本插件从运行时观察到的边（`parentSession`）学来的。 */
export const OBSERVED_SOURCE = 'observed'

/** 登记表绝对路径。 */
export function defaultClaimsPath(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  const base = typeof configured === 'string' && configured.trim() !== '' ? configured : join(home, '.dsh')
  return join(base, CLAIMS_FILE_NAME)
}

const isId = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * 规范化一条登记：id 必须合法；父指针与时间戳缺失/非法时降级。
 *
 * 两种来源（`source`）的合法性要求不同：
 *   * `'observed'`（运行时观察到的边）：**没有 `owner`**，且**必须有一条安全的父指针**
 *     （一条观察条目的全部意义就是那条边；没有父边就没什么可记的，直接丢弃）；
 *   * 其余（缺省 = `'claim'`）：`owner` 必填 —— 旧 v1 文件没有 `source` 字段，正是这一支。
 */
function normalizeEntry(id, raw) {
  if (!isSafeSessionId(id)) return undefined
  const parentSessionId = isSafeSessionId(raw?.parentSessionId) && raw.parentSessionId !== id ? raw.parentSessionId : null
  if (raw?.source === OBSERVED_SOURCE) {
    if (parentSessionId === null) return undefined
    const observedAt = Number.isFinite(raw?.observedAt) ? raw.observedAt : undefined
    return observedAt === undefined
      ? { id, parentSessionId, source: OBSERVED_SOURCE }
      : { id, parentSessionId, source: OBSERVED_SOURCE, observedAt }
  }
  const owner = raw?.owner
  if (!isId(owner)) return undefined
  const claimedAt = Number.isFinite(raw?.claimedAt) ? raw.claimedAt : undefined
  const entry = { id, owner, parentSessionId, source: CLAIM_SOURCE }
  return claimedAt === undefined ? entry : { ...entry, claimedAt }
}

/** 两条条目在**语义上**是否相同（时间戳不参与比较：重复提升/重复 claim 不该反复写盘）。 */
function sameRegistration(left, right) {
  return (left.owner ?? null) === (right.owner ?? null)
    && (left.parentSessionId ?? null) === (right.parentSessionId ?? null)
    && (left.source ?? CLAIM_SOURCE) === (right.source ?? CLAIM_SOURCE)
}

/**
 * 合并一条新条目与账本里已有的条目。
 *
 * 来源优先级：`'claim'`（生产者登记）> `'observed'`（运行时观察）。
 *   * **登记优先**：观察到的边绝不改写已有登记条目 —— `owner` 是白名单键、`parentSessionId`
 *     是权威的父子关系，都不能被"看来的"覆盖（`undefined` = 原样不动）；
 *   * 观察 + 已有观察：父没变就原样（连时间戳都不动，重复提升不写盘）；父变了就更新
 *     （session header 是活的），并保留**第一次**学到这条边的时间；
 *   * 登记 + 已有观察：把条目**升级**成登记条目；这次没显式给父时保留已观察到的父指针
 *     （不把已知的边抹掉 —— 与 claim() "不带父的重复 claim 不抹父"同一条规矩）。
 * @returns 合并后的条目；`undefined` 表示"保持原样"。
 */
function mergeEntry(before, incoming) {
  if (before === undefined) return incoming
  const incomingSource = incoming.source ?? CLAIM_SOURCE
  const beforeSource = before.source ?? CLAIM_SOURCE
  if (incomingSource === OBSERVED_SOURCE) {
    if (beforeSource !== OBSERVED_SOURCE) return undefined
    if ((before.parentSessionId ?? null) === (incoming.parentSessionId ?? null)) return before
    return before.observedAt === undefined ? incoming : { ...incoming, observedAt: before.observedAt }
  }
  const merged = { ...incoming, parentSessionId: incoming.parentSessionId ?? before.parentSessionId ?? null }
  if (merged.claimedAt === undefined && before.claimedAt !== undefined) merged.claimedAt = before.claimedAt
  return merged
}

/**
 * 解析登记表内容。
 *
 * 容忍的旧/异形格式（任何一种都退化成"能读多少读多少"，绝不抛错阻断启动）：
 *   * 文件不存在 / JSON 损坏 / 根本不是对象 → 空表；
 *   * `{ version: 2, claims: { <id>: { owner, parentSessionId, source } } }` → 当前格式；
 *   * `{ claims: [ { id, owner, parentSessionId } ] }` → 数组形态（早期原型 / 手工编辑）；
 *   * `source` 缺失（v1 老文件 / 手工编辑）→ 当作 `'claim'`；
 *   * `source: 'observed'` 但没有合法父指针 → 丢弃（观察条目就是那条边，没有边就没有信息）；
 *   * `parentSessionId` 缺失或不安全 → 按"父未知"处理（子会话照常存在，只是不建树）；
 *   * `version` 更高 → 只挑认得的字段（向前兼容）。
 * @param text - 文件内容。
 * @returns `{ version, claims: [{ id, owner?, source, parentSessionId, claimedAt?, observedAt? }] }`。
 */
export function parseClaims(text) {
  const empty = { version: CLAIMS_VERSION, claims: [] }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const raw = parsed.claims
  const entries = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entry = normalizeEntry(item?.id, item)
      if (entry !== undefined) entries.push(entry)
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const [id, item] of Object.entries(raw)) {
      const entry = normalizeEntry(id, item)
      if (entry !== undefined) entries.push(entry)
    }
  }
  return { version: CLAIMS_VERSION, claims: entries }
}

/**
 * 原子替换文件，并对 Windows 上的"瞬时占用"做有限重试
 * （杀软/索引器/别的进程短暂持有句柄会报 EPERM/EBUSY/EACCES，重试即可成功）。
 */
async function renameWithRetry(from, to) {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= 4 || !retryable.has(error?.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

/**
 * 打开（或创建）登记表。
 *
 * 同步返回句柄（`apply()` 是同步的），首次异步操作前完成一次读取：`ready` 是这个 Promise。
 * 所有读写都先 `await ready`，因此"读到旧内容覆盖新登记"的竞态不会发生。
 *
 * @param options - `{ file?, logger? }`；`file` 默认 {@link defaultClaimsPath}，
 *   显式传 `null` 表示**纯内存**（测试/无 home 场景）。
 * @returns `{ file, ready, entries, get, idsOf, setMany, delete }`。
 */
export function openClaimsStore(options = {}) {
  const file = options.file === null ? null : (options.file ?? defaultClaimsPath())
  const logger = options.logger
  /** sessionId → `{ id, owner?, parentSessionId, source, claimedAt?, observedAt? }`。 */
  let claims = new Map()
  const ready = file === null
    ? Promise.resolve()
    : readFile(file, 'utf8').then(
      (text) => {
        const parsed = parseClaims(text)
        claims = new Map(parsed.claims.map((entry) => [entry.id, entry]))
      },
      (error) => {
        // 不存在 = 还没有任何登记；别的读取错误只告警（按空表处理，绝不阻断启动）。
        if (error?.code !== 'ENOENT') logger?.warn?.(`dsh-workspace-manager: 读取会话登记表失败，按空表处理：${String(error)}`)
      },
    )

  let tail = Promise.resolve()
  /** 串行化所有写操作（读-改-写必须在队列内，否则并发会互相覆盖）。 */
  const enqueue = (operation) => {
    const result = tail.then(operation, operation)
    tail = result.then(() => {}, () => {})
    return result
  }

  async function persist() {
    if (file === null) return
    const directory = dirname(file)
    await mkdir(directory, { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(temporary, 'w', 0o600)
    try {
      // 按 id 排序写出：内容稳定，人也能读（排查"树为什么长这样"时直接看这个文件）。
      const sorted = {}
      for (const id of [...claims.keys()].sort()) sorted[id] = claims.get(id)
      await handle.writeFile(`${JSON.stringify({ version: CLAIMS_VERSION, claims: sorted }, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await renameWithRetry(temporary, file)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  return {
    file,
    ready: ready.catch(() => {}),
    /** 当前条目（副本，按 id 排序）；含 `source`（`'claim' | 'observed'`）。 */
    entries() {
      return [...claims.values()].map((entry) => ({ ...entry }))
    },
    /** 某条条目（副本）。 */
    get(id) {
      const entry = claims.get(id)
      return entry === undefined ? undefined : { ...entry }
    },
    /** 某个 owner 名下的 id（按 id 排序）。观察条目没有 owner，因此永远不会出现在这里。 */
    idsOf(owner) {
      return [...claims.values()].filter((entry) => entry.owner === owner).map((entry) => entry.id).sort()
    },
    /**
     * 写入/覆盖一批条目（幂等）。**先改内存、再落盘**：即使调用方忘了 await，
     * 进程内的行为也已经生效（落盘只是跨重启的那一半）。
     *
     * 合并规则见 {@link mergeEntry}：**登记优先**（观察到的边绝不改写已有登记），
     * 登记落在纯观察条目上会把它升级成登记条目；内容没有真的变化时**不写盘**。
     * @param list - `[{ id, owner?, parentSessionId?, source?, claimedAt?, observedAt? }]`；
     *   `source: 'observed'` 的条目会丢掉 `owner`（观察条目没有 owner）。
     * @returns 是否真的发生了变化。
     */
    async setMany(list) {
      await ready
      const incoming = (Array.isArray(list) ? list : [list])
        .map((item) => normalizeEntry(item?.id, item))
        .filter((entry) => entry !== undefined)
      if (incoming.length === 0) return false
      // 只有内容真的变了才写盘（避免每次启动/重复 claim/重复提升都重写一遍同样的东西）。
      let changed = false
      for (const entry of incoming) {
        const before = claims.get(entry.id)
        const merged = mergeEntry(before, entry)
        if (merged === undefined) continue
        if (before !== undefined && sameRegistration(before, merged)) continue
        claims.set(entry.id, merged)
        changed = true
      }
      if (!changed) return false
      await enqueue(persist)
      return true
    },
    /**
     * 删掉一批登记（幂等）。
     * @param ids - id 数组（或单个 id）。
     * @returns 是否真的发生了变化。
     */
    async delete(ids) {
      await ready
      const outgoing = (Array.isArray(ids) ? ids : [ids]).filter(isId)
      if (outgoing.length === 0) return false
      let changed = false
      for (const id of outgoing) if (claims.delete(id)) changed = true
      if (!changed) return false
      await enqueue(persist)
      return true
    },
  }
}
