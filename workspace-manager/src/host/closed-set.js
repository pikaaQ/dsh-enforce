// dsh-workspace-manager — 「已关闭工作区」的宿主侧持久化
//
// 内核没有"关闭工作区"这个概念（只有 `workspace.delete`，那会摘掉注册记录并让
// 会话掉进「未分组」），所以这个集合必须由本插件自己保存。
//
// 存放位置沿用你现有插件的约定：`$DSH_HOME/dsh-workspace-manager.state.json`
//（与 `dsh-provider-toggle.state.json` 同级）。零依赖：DSH_HOME 直接读环境变量，
// 缺失时退回家目录下的 `.dsh`，与内核 `resolveDshHome()` 的行为一致。
//
// 写入是原子的（临时文件 + fsync + rename），并串行化，避免并发写互相覆盖。

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const FILE_NAME = 'dsh-workspace-manager.state.json'
const STATE_VERSION = 1

/** 解析 Harness home（与内核一致：DSH_HOME 优先，否则 `~/.dsh`）。 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(home, '.dsh')
}

/** 本插件的状态文件绝对路径。 */
export function defaultStatePath(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), FILE_NAME)
}

const isId = (value) => typeof value === 'string' && value.trim() !== ''

/** 解析状态文件内容；任何损坏都退化为空集合，绝不抛错阻断启动。 */
export function parseState(text) {
  try {
    const parsed = JSON.parse(text)
    const ids = parsed?.closedWorkspaceIds
    return { version: STATE_VERSION, closedWorkspaceIds: Array.isArray(ids) ? ids.filter(isId) : [] }
  } catch {
    return { version: STATE_VERSION, closedWorkspaceIds: [] }
  }
}

/**
 * 原子替换文件，并在 Windows 上对"瞬时占用"做有限重试。
 *
 * `rename` 在 Windows 上可能因为杀软/索引器/别的进程短暂持有目标句柄而报
 * `EPERM`/`EBUSY`/`EACCES`——这是几毫秒级的瞬时状态，重试即可成功（实测测试里偶发过一次）。
 * 只重试这几个明确的瞬时错误码，其它错误立即抛出；重试耗尽后仍抛原错误。
 * @param from - 临时文件路径。
 * @param to - 目标路径。
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
 * 打开（或创建）状态存储。
 * @param options - `{ file?, logger? }`；`file` 默认 {@link defaultStatePath}。
 * @returns 存储句柄。
 */
export async function openClosedStore(options = {}) {
  const file = options.file ?? defaultStatePath()
  const logger = options.logger
  let state = { version: STATE_VERSION, closedWorkspaceIds: [] }
  try {
    state = parseState(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`dsh-workspace-manager: 读取状态文件失败，按空集合处理：${String(error)}`)
  }

  let tail = Promise.resolve()

  /** 串行化所有写操作，避免并发覆盖。 */
  const enqueue = (operation) => {
    const result = tail.then(operation, operation)
    tail = result.then(() => {}, () => {})
    return result
  }

  async function persist() {
    const directory = dirname(file)
    await mkdir(directory, { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    const handle = await open(temporary, 'w', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`)
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

  /** 只在队列内做"读-改-写"：并发调用不会互相覆盖（读发生在入队之前会丢更新）。 */
  const mutate = (change) => enqueue(async () => {
    const next = change(state.closedWorkspaceIds)
    if (next === undefined) return false
    const same = next.length === state.closedWorkspaceIds.length
      && next.every((id, index) => id === state.closedWorkspaceIds[index])
    if (same) return false
    state = { version: STATE_VERSION, closedWorkspaceIds: next }
    await persist()
    return true
  })

  return {
    file,
    /** 当前已关闭的工作区 id（副本）。 */
    ids() {
      return [...state.closedWorkspaceIds]
    },
    /** 某个工作区是否已关闭。 */
    isClosed(workspaceId) {
      return state.closedWorkspaceIds.includes(workspaceId)
    },
    /**
     * 覆盖式设置关闭集合（只保留存在的 id，去重，保持传入顺序）。
     * @returns 是否真的发生了变化（未变化时不写盘）。
     */
    setClosed(workspaceIds) {
      const next = [...new Set((workspaceIds ?? []).filter(isId))]
      return mutate(() => next)
    },
    /** 关闭一个工作区（幂等）。 */
    close(workspaceId) {
      if (!isId(workspaceId)) return Promise.resolve(false)
      return mutate((current) => current.includes(workspaceId) ? undefined : [...current, workspaceId])
    },
    /** 重新打开一个工作区（幂等）。 */
    open(workspaceId) {
      if (!isId(workspaceId)) return Promise.resolve(false)
      return mutate((current) => {
        if (!current.includes(workspaceId)) return undefined
        return current.filter((id) => id !== workspaceId)
      })
    },
    /**
     * 清掉已经不存在的关闭记录（例如工作区被真正删除了）。
     *
     * 安全性：关闭是本插件自己的视图层概念，**不影响内核注册表**，
     * 所以一个仍然存在的工作区一定还在 `existingIds` 里；只有被真正删除的
     * 工作区 id 会被清掉，不会误删仍在使用的关闭记录。
     * @returns 是否发生了变化。
     */
    prune(existingIds) {
      const existing = existingIds instanceof Set ? existingIds : new Set(existingIds ?? [])
      return mutate((current) => {
        const kept = current.filter((id) => existing.has(id))
        return kept.length === current.length ? undefined : kept
      })
    },
    /** 内部状态快照（测试用）。 */
    debugState() {
      return JSON.parse(JSON.stringify(state))
    },
  }
}
