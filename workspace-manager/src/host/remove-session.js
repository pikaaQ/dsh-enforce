// dsh-workspace-manager — 会话清点与「彻底移除」（宿主侧）
//
// 为什么是文件级删除：0.1.5 的 `dsh-session-persistence` 只有契约
// （create/open/stat/list/flush，且没有 raw 访问），官方 session RPC 也没有删除动词。
// 而一个会话的全部持久状态就是 `$DSH_HOME/sessions/<projectKey>/<sessionId>/` 这一个目录
// （外加一份可重建的投影缓存），注册表在下次扫描时自然就不再列出它 —— 所以「彻底移除」
// 等价于把这个目录删掉，不需要任何内核写面。
//
// 安全边界（全部在触碰任何文件之前判定，且都带单测）：
//   1. 活跃会话一律拒绝（内存里有 handle 或 agent 在跑）—— 判断在 index.js 的端点层，
//      因为它需要 ctx；
//   2. sessionId 必须是 `[A-Za-z0-9][A-Za-z0-9._-]*`、不含 `..`，并且解析后的路径必须仍然
//      位于 sessions 根之内（防目录穿越）；
//   3. 找不到工件 → session-not-found，绝不"猜一个路径"去删；
//   4. 只删本插件认识的三种东西：会话工件目录、该会话的投影缓存、以及**旧的第三方移动插件**
//      留下的同名备份目录（`session-workspace-backups/<id>`，不删它就会留下孤儿数据）。
//      `attachments/` 是内容寻址存储、可能被别的会话共用，**不碰**。

import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/** 允许的会话 id 形态（同时是安全的目录名）。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 结构化错误：客户端据此区分"用户操作问题"与"内核故障"。 */
export class SessionRemovalError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SessionRemovalError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new SessionRemovalError(code, message)
}

/** 会话 id 是否能安全地当作目录名使用。 */
export function isSafeSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) && !value.includes('..')
}

/**
 * dsh-workspace 的项目键：cwd 的分隔符与盘符冒号都变成 `-`，整体用 `--` 包起来。
 * 例：`E:\JavaScript\dsh-enforce` → `--E-JavaScript-dsh-enforce--`。
 */
export function projectKeyOf(cwd) {
  return `--${String(cwd).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '')}--`
}

/** 会话工件根目录。 */
export const sessionsRootOf = (home) => join(home, 'sessions')

/** 目录总字节数（只统计普通文件；读不到的条目按 0 计，不让清点因为一个坏文件整体失败）。 */
async function directoryBytes(dir) {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(full)
      continue
    }
    const info = await stat(full).catch(() => undefined)
    if (info !== undefined) total += info.size
  }
  return total
}

/**
 * 清点磁盘上的全部会话，并按项目键把它归到工作区名下。
 * @param home - DSH home。
 * @param workspaces - `[{ workspaceId, path }]`（来自注册表）。
 * @returns `{ sessionsRoot, sessions, totals }`，`workspaceId === null` 即「未分组」。
 */
export async function sessionInventory(home, workspaces = []) {
  const root = sessionsRootOf(home)
  const byKey = new Map()
  for (const workspace of workspaces) {
    if (typeof workspace?.path === 'string' && workspace.path !== '') {
      byKey.set(projectKeyOf(workspace.path), workspace.workspaceId)
    }
  }

  const sessions = []
  const projectDirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const projectPath = join(root, projectDir.name)
    const sessionDirs = await readdir(projectPath, { withFileTypes: true }).catch(() => [])
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const full = join(projectPath, sessionDir.name)
      const info = await stat(full).catch(() => undefined)
      if (info === undefined) continue
      sessions.push({
        id: sessionDir.name,
        projectKey: projectDir.name,
        dir: full,
        bytes: await directoryBytes(full),
        mtime: info.mtime.toISOString(),
        workspaceId: byKey.get(projectDir.name) ?? null,
        safeId: isSafeSessionId(sessionDir.name),
      })
    }
  }

  const ungrouped = sessions.filter((session) => session.workspaceId === null)
  return {
    sessionsRoot: root,
    sessions,
    totals: {
      sessions: sessions.length,
      bytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
      ungrouped: ungrouped.length,
      ungroupedBytes: ungrouped.reduce((sum, session) => sum + session.bytes, 0),
    },
  }
}

/**
 * 找到某个会话的全部工件目录（按目录名精确匹配，可能不止一个：同 id 出现在多个项目键下）。
 * @returns 目录路径数组；调用方负责保证 `sessionId` 已通过 `isSafeSessionId`。
 */
export async function findArtifactDirs(home, sessionId) {
  const root = resolve(sessionsRootOf(home))
  const found = []
  const projectDirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const candidate = resolve(root, projectDir.name, sessionId)
    // 目录名精确匹配 + 解析后仍在 sessions 根之内：两道防线，防穿越与防前缀误伤。
    if (candidate !== join(root, projectDir.name, sessionId)) continue
    if (!candidate.startsWith(root + sep)) continue
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isDirectory()) found.push(candidate)
  }
  return found
}

/**
 * 彻底移除一个会话在磁盘上的全部痕迹。
 * @returns `{ sessionId, removed, bytes, prunedProjects }`；`removed` 每项 `{ path, kind, bytes }`。
 * @throws SessionRemovalError `bad-request`（id 不安全）/ `session-not-found`（没有工件）。
 */
export async function removeSessionFiles(home, sessionId, options = {}) {
  if (!isSafeSessionId(sessionId)) {
    fail('bad-request', `session id ${JSON.stringify(sessionId)} is not a safe directory name`)
  }
  const includeLegacyBackups = options.includeLegacyBackups !== false
  const root = resolve(sessionsRootOf(home))

  const targets = []
  for (const dir of await findArtifactDirs(home, sessionId)) {
    targets.push({ path: dir, kind: 'artifact', bytes: await directoryBytes(dir) })
  }
  if (targets.length === 0) {
    fail('session-not-found', `session ${JSON.stringify(sessionId)} has no artifact under ${root}`)
  }

  const sidecars = [
    { path: join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), kind: 'projection-cache' },
  ]
  if (includeLegacyBackups) {
    sidecars.push({ path: join(home, 'session-workspace-backups', sessionId), kind: 'legacy-move-backup' })
  }
  for (const sidecar of sidecars) {
    const info = await stat(sidecar.path).catch(() => undefined)
    if (info === undefined) continue
    targets.push({ ...sidecar, bytes: info.isDirectory() ? await directoryBytes(sidecar.path) : info.size })
  }

  const removed = []
  for (const target of targets) {
    await rm(target.path, { recursive: true, force: true })
    removed.push(target)
  }

  // 顺手收掉因此变空的项目目录（只是 cwd 的分组壳，注册表需要时会自己重建）。
  const prunedProjects = []
  for (const projectDir of new Set(targets.filter((t) => t.kind === 'artifact').map((t) => dirname(t.path)))) {
    const left = await readdir(projectDir).catch(() => ['?'])
    if (left.length > 0) continue
    const done = await rmdir(projectDir).then(() => true, () => false)
    if (done) prunedProjects.push(projectDir)
  }

  return {
    sessionId,
    removed,
    bytes: removed.reduce((sum, target) => sum + target.bytes, 0),
    prunedProjects,
  }
}
