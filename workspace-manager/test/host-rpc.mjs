// dsh-workspace-manager — 宿主 RPC 层离线测试
//
// 用最小假 ctx/假 registry 跑真实的 `apply()` 与端点分发，覆盖：
//   端点注册与 authority、状态读写、归档/恢复（含能力降级）、
//   payload 严格校验、错误码映射、以及"已删除工作区的关闭记录会被 prune"。
//
// 全程写到临时 DSH_HOME，绝不触碰真实状态文件。
//
// 运行：node test/host-rpc.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, 'tmp-rpc')

let passed = 0
let failed = 0
async function check(label, fn) {
	try {
		await fn()
		passed += 1
		console.log(`  PASS  ${label}`)
	} catch (error) {
		failed += 1
		console.log(`  FAIL  ${label}\n        ${String(error?.message ?? error)}`)
	}
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
process.env.DSH_HOME = TMP // apply() 会按默认路径建状态文件；这里指向临时目录

const { apply, createRpcHandler } = await import('../src/host/index.js')

// ── 假 registry：实现内核 registry 的真实方法面 ───────────────────────────────
function makeRegistry(options = {}) {
	let state = { initialized: true, workspaceIds: ['ws-a', 'ws-b'], archivedSessionIds: options.archived ?? ['s-host'] }
	const known = new Set(options.known ?? ['s1', 's2', 's-host'])
	const registry = {
		get archivedSessionIds() {
			return [...state.archivedSessionIds]
		},
		list: () => (options.workspaces ?? [
			{ id: 'ws-a', title: 'alpha', path: 'E:/tmp/alpha', sessionIds: ['s1', 's2'] },
			{ id: 'ws-b', title: 'beta', path: 'E:/tmp/beta', sessionIds: [] },
		]).map((workspace) => ({
			...workspace,
			detachSession: async () => {},
			attachSession: async () => {},
		})),
		get: (id) => (id === 'ws-a' ? { id: 'ws-a', title: 'alpha', path: 'E:/tmp/alpha' } : undefined),
		async archiveSession(sessionId) {
			if (!known.has(sessionId)) {
				const error = new Error(`cannot archive session '${sessionId}': unknown`)
				error.name = 'WorkspaceUnknownSessionError'
				throw error
			}
			if (state.archivedSessionIds.includes(sessionId)) return
			state = { ...state, archivedSessionIds: [...state.archivedSessionIds, sessionId] }
		},
		replaceHeaderIndex: async () => {},
		enqueueOperation(operation) {
			return operation()
		},
		requireState: () => state,
		async setState(next) {
			state = next
		},
		debugState: () => state,
	}
	if (options.cripple === true) {
		delete registry.enqueueOperation
		delete registry.requireState
		delete registry.setState
	}
	return registry
}

function makeCtx(registry) {
	const captured = {}
	const ctx = {
		logger: { warn: (...args) => console.log(`  [warn] ${args.join(' ')}`), info: () => {} },
		workspaceRegistry: registry,
		agents: { get: () => undefined },
		sessions: { get: () => undefined },
		sessionPersistence: {
			supportsRawArtifacts: true,
			readRaw: async () => undefined,
			list: async () => [
				{ id: 's1', cwd: 'E:/tmp/alpha', createdAt: 1 },
				{ id: 's2', cwd: 'E:/tmp/alpha', createdAt: 2 },
				{ id: 's3', cwd: 'E:/tmp/beta', createdAt: 3 },
			],
		},
		connection: {
			rpc: {
				handle(path, handler, options) {
					captured.path = path
					captured.handler = handler
					captured.options = options
					return () => { captured.disposed = true }
				},
			},
		},
		effect(fn) {
			captured.disposer = fn()
			return () => captured.disposer?.()
		},
	}
	return { ctx, captured }
}

// ── 1. apply() 的注册契约 ───────────────────────────────────────────────────
const registry = makeRegistry()
const { ctx, captured } = makeCtx(registry)
apply(ctx)

await check('apply() 只注册一个自有 RPC 端点', () => {
	assert.equal(captured.path, '/dsh-workspace-manager')
	assert.equal(typeof captured.handler, 'function')
})
await check('端点 authority 为 trusted-host', () => {
	assert.equal(captured.options?.authority, 'trusted-host')
})
await check('状态文件建在 DSH_HOME 下（沿用 dsh-<名字>.state.json 约定）', () => {
	assert.equal(existsSync(join(TMP, 'dsh-workspace-manager.state.json')), false, '未写之前不应存在')
})

const call = (endpoint, payload) => captured.handler(endpoint, payload)

// ── 2. 状态与开关 ───────────────────────────────────────────────────────────
await check('state 返回关闭集合/能力/归档集合/状态文件路径', async () => {
	const result = await call('state', {})
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.closedWorkspaceIds, [])
	assert.equal(result.value.canRestoreArchive, true)
	assert.deepEqual(result.value.archivedSessionIds, ['s-host'])
	assert.equal(result.value.statePath, join(TMP, 'dsh-workspace-manager.state.json'))
})
await check('close 关闭工作区并回显新状态', async () => {
	const result = await call('close', { workspaceId: 'ws-a' })
	assert.equal(result.ok, true)
	assert.equal(result.value.changed, true)
	assert.deepEqual(result.value.closedWorkspaceIds, ['ws-a'])
})
await check('close 落盘（文件里确实记下了）', () => {
	const onDisk = JSON.parse(readFileSync(join(TMP, 'dsh-workspace-manager.state.json'), 'utf8'))
	assert.deepEqual(onDisk.closedWorkspaceIds, ['ws-a'])
})
await check('close 幂等：第二次 changed=false', async () => {
	const result = await call('close', { workspaceId: 'ws-a' })
	assert.equal(result.value.changed, false)
	assert.deepEqual(result.value.closedWorkspaceIds, ['ws-a'])
})
await check('open 重新打开', async () => {
	const result = await call('open', { workspaceId: 'ws-a' })
	assert.equal(result.value.changed, true)
	assert.deepEqual(result.value.closedWorkspaceIds, [])
})
await check('setClosed 覆盖式设置', async () => {
	const result = await call('setClosed', { workspaceIds: ['ws-b', 'ws-a'] })
	assert.deepEqual(result.value.closedWorkspaceIds, ['ws-b', 'ws-a'])
})
await check('prune：已不存在的工作区记录被清掉，仍存在的保留', async () => {
	await call('setClosed', { workspaceIds: ['ws-a', 'ws-gone'] })
	const result = await call('state', {})
	assert.deepEqual(result.value.closedWorkspaceIds, ['ws-a'])
})

// ── 3. payload 严格校验与错误映射 ────────────────────────────────────────────
await check('未知端点 -> bad-request', async () => {
	const result = await call('nope', {})
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'bad-request')
})
await check('未知字段 -> bad-request', async () => {
	const result = await call('close', { workspaceId: 'ws-a', extra: 1 })
	assert.equal(result.error.code, 'bad-request')
})
await check('缺字段 -> bad-request', async () => {
	const result = await call('close', {})
	assert.equal(result.error.code, 'bad-request')
})
await check('空 workspaceId -> bad-request', async () => {
	const result = await call('close', { workspaceId: '  ' })
	assert.equal(result.error.code, 'bad-request')
})
await check('workspaceIds 不是数组 -> bad-request', async () => {
	const result = await call('setClosed', { workspaceIds: 'ws-a' })
	assert.equal(result.error.code, 'bad-request')
})
await check('payload 不是对象 -> bad-request（state 端点无需 payload，故用 close 验证）', async () => {
	const result = await call('close', null)
	assert.equal(result.error.code, 'bad-request')
})
await check('state 端点忽略 payload（无入参语义）', async () => {
	const result = await call('state', null)
	assert.equal(result.ok, true)
	assert.ok(Array.isArray(result.value.closedWorkspaceIds))
})

// ── 4. 归档 / 恢复 ──────────────────────────────────────────────────────────
await check('unarchive 把 id 从内核归档集合里去掉（走注册表写链）', async () => {
	const result = await call('unarchive', { sessionId: 's-host' })
	assert.equal(result.ok, true)
	assert.equal(result.value.changed, true)
	assert.deepEqual(result.value.archivedSessionIds, [])
	assert.deepEqual(registry.debugState().archivedSessionIds, [])
})
await check('unarchive 幂等：第二次 changed=false 且不重复写', async () => {
	const result = await call('unarchive', { sessionId: 's-host' })
	assert.equal(result.value.changed, false)
})
await check('unarchive 不影响工作区记账（只动归档集合一个字段）', () => {
	assert.deepEqual(registry.debugState().workspaceIds, ['ws-a', 'ws-b'])
	assert.equal(registry.debugState().initialized, true)
})
await check('archive 走内核官方 archiveSession', async () => {
	const result = await call('archive', { sessionId: 's1' })
	assert.equal(result.ok, true)
	assert.equal(result.value.changed, true)
	assert.deepEqual(registry.debugState().archivedSessionIds, ['s1'])
})
await check('archive 未知会话 -> 内核拒绝并映射错误码', async () => {
	const result = await call('archive', { sessionId: 's-nope' })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'internal', '未知会话的失败应落到 internal')
	assert.match(result.error.message, /s-nope/)
})

// ── 5. 能力降级（内核升级导致注册表内部方法消失） ─────────────────────────────
const crippled = makeRegistry({ cripple: true })
const crippledResult = await createRpcHandler(makeCtx(crippled).ctx, Promise.resolve(mockStore()))('state', {})
await check('缺写入面时 canRestoreArchive=false（设置页据此禁用开关）', () => {
	assert.equal(crippledResult.value.canRestoreArchive, false)
})
const crippledUnarchive = await createRpcHandler(makeCtx(crippled).ctx, Promise.resolve(mockStore()))('unarchive', { sessionId: 's-host' })
await check('缺写入面时 unarchive -> unsupported-dsh-version（并可退化为视图层）', () => {
	assert.equal(crippledUnarchive.ok, false)
	assert.equal(crippledUnarchive.error.code, 'unsupported-dsh-version')
})
function mockStore() {
	return { file: '(mock)', ids: () => [], prune: async () => false, setClosed: async () => false, close: async () => false, open: async () => false }
}

// ── 6. 失败也走统一错误信封（带 details.stack 便于定位）───────────────────────
await check('失败也走统一错误信封（带 details.stack 便于定位）', async () => {
	const result = await call('close', {})
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'bad-request')
	assert.equal(typeof result.error.message, 'string')
	assert.equal(result.error.details.code, 'bad-request')
	assert.equal(typeof result.error.details.stack, 'string')
})

// ── 7. 磁盘清点（inventory）与彻底移除（remove）─────────────────────────────
// 夹具：ws-a 的路径是 E:/tmp/alpha、ws-b 是 E:/tmp/beta，项目键分别由 cwd 推出。
mkdirSync(join(TMP, 'sessions', '--E-tmp-alpha--', 's-a1'), { recursive: true })
mkdirSync(join(TMP, 'sessions', '--E-orphan--', 's-orphan'), { recursive: true })
mkdirSync(join(TMP, 'sessions', '--E-orphan--', 's-orphan-archived'), { recursive: true })
mkdirSync(join(TMP, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(TMP, 'sessions', '--E-tmp-alpha--', 's-a1', 'session.jsonl.zstd'), 'a'.repeat(100))
writeFileSync(join(TMP, 'sessions', '--E-orphan--', 's-orphan', 'session.jsonl.zstd'), 'b'.repeat(40))
writeFileSync(join(TMP, 'sessions', '--E-orphan--', 's-orphan-archived', 'session.jsonl.zstd'), 'c'.repeat(10))
writeFileSync(join(TMP, 'storages', 'session_projcache', 'sessions', 's-orphan.json'), '{}')

const invHandler = createRpcHandler(makeCtx(makeRegistry({ archived: ['s-orphan-archived'] })).ctx, Promise.resolve(mockStore()))
const inventory = await invHandler('inventory', {})
await check('inventory 把会话按项目键归到工作区，未分组的 workspaceId 为 null', () => {
	assert.equal(inventory.ok, true)
	const rows = inventory.value.sessions
	assert.equal(rows.length, 3)
	assert.equal(rows.find((row) => row.id === 's-a1').workspaceId, 'ws-a')
	assert.equal(rows.find((row) => row.id === 's-orphan').workspaceId, null)
})
await check('inventory 汇总体积与未分组计数', () => {
	assert.equal(inventory.value.totals.sessions, 3)
	assert.equal(inventory.value.totals.bytes, 150)
	assert.equal(inventory.value.totals.ungrouped, 2)
	assert.equal(inventory.value.totals.ungroupedBytes, 50)
})
await check('inventory 标出归档与活跃，并给出 removable', () => {
	const orphan = inventory.value.sessions.find((row) => row.id === 's-orphan')
	assert.equal(orphan.archived, false)
	assert.equal(orphan.active, false)
	assert.equal(orphan.removable, true)
	const archivedRow = inventory.value.sessions.find((row) => row.id === 's-orphan-archived')
	assert.equal(archivedRow.archived, true)
})
await check('remove 活跃会话 -> session-active（不触碰文件）', async () => {
	const activeCtx = makeCtx(makeRegistry()).ctx
	activeCtx.sessions = { get: (id) => (id === 's-orphan' ? {} : undefined) }
	activeCtx.agents = { get: () => undefined }
	const handler = createRpcHandler(activeCtx, Promise.resolve(mockStore()))
	const result = await handler('remove', { sessionId: 's-orphan' })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'session-active')
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan--', 's-orphan')), true, '活跃会话的工件必须原封不动')
})
await check('remove 不存在的会话 -> session-not-found', async () => {
	const result = await call('remove', { sessionId: 's-nope' })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'session-not-found')
})
await check('remove 不安全 id -> bad-request（防目录穿越）', async () => {
	for (const bad of ['../evil', 'a/b', '.', '', 'a b', 'x'.repeat(3) + '/../..']) {
		const result = await call('remove', { sessionId: bad })
		assert.equal(result.ok, false, `${bad} 应被拒绝`)
		assert.equal(result.error.code, 'bad-request')
	}
})
await check('remove 缺 sessionId -> bad-request', async () => {
	const result = await call('remove', {})
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'bad-request')
})
await check('remove 归档会话：删文件 + 从官方归档集合摘除', async () => {
	const registry = makeRegistry({ archived: ['s-orphan-archived'] })
	const handler = createRpcHandler(makeCtx(registry).ctx, Promise.resolve(mockStore()))
	const result = await handler('remove', { sessionId: 's-orphan-archived' })
	assert.equal(result.ok, true)
	assert.equal(result.value.archiveCleared, true)
	assert.equal(result.value.bytes, 10)
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan--', 's-orphan-archived')), false)
	assert.deepEqual(registry.debugState().archivedSessionIds, [])
	assert.deepEqual(result.value.archivedSessionIds, [])
})
await check('remove 未归档会话：archiveCleared=false 且删掉投影缓存', async () => {
	const result = await call('remove', { sessionId: 's-orphan' })
	assert.equal(result.ok, true)
	assert.equal(result.value.archiveCleared, false)
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan--', 's-orphan')), false)
	assert.equal(existsSync(join(TMP, 'storages', 'session_projcache', 'sessions', 's-orphan.json')), false)
})
await check('remove 之后再删同一个 -> session-not-found（幂等且不留残迹）', async () => {
	const result = await call('remove', { sessionId: 's-orphan' })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'session-not-found')
})
await check('remove 成功后会从工作区记账里摘掉该 id（否则设置页留下幽灵行）', async () => {
	mkdirSync(join(TMP, 'sessions', '--E-tmp-alpha--', 's-a2'), { recursive: true })
	writeFileSync(join(TMP, 'sessions', '--E-tmp-alpha--', 's-a2', 'session.jsonl.zstd'), 'a'.repeat(20))
	const registry = makeRegistry({
		workspaces: [{ id: 'ws-a', title: 'alpha', path: 'E:/tmp/alpha', sessionIds: ['s-a2'] }],
	})
	const handler = createRpcHandler(makeCtx(registry).ctx, Promise.resolve(mockStore()))
	const result = await handler('remove', { sessionId: 's-a2' })
	assert.equal(result.ok, true)
	assert.equal(result.value.filesMissing, false)
	assert.deepEqual(result.value.detachedFrom, ['ws-a'])
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', 's-a2')), false)
})
await check('工件已不在但注册表还记着 -> 只清记账，不报 session-not-found', async () => {
	const registry = makeRegistry({
		workspaces: [{ id: 'ws-b', title: 'beta', path: 'E:/tmp/beta', sessionIds: ['s-ghost'] }],
	})
	const handler = createRpcHandler(makeCtx(registry).ctx, Promise.resolve(mockStore()))
	const result = await handler('remove', { sessionId: 's-ghost' })
	assert.equal(result.ok, true)
	assert.equal(result.value.filesMissing, true)
	assert.equal(result.value.bytes, 0)
	assert.deepEqual(result.value.detachedFrom, ['ws-b'])
})

// ── 8. 会话树（inventory 的 parentId/kind/orphan）与级联删除（remove 的 cascade）──
// 父子关系来自**插件的持久化登记**（claim 的 parentSessionId）——内核没有这份数据。
// 这里把登记表写在临时 DSH_HOME 下，并按真路径建好工件，逐条验证落点。
const { openClaimsStore } = await import('../src/host/claims-store.js')

const UUID_CHILD = 'aaaaaaaa-1111-4111-8111-111111111111' // 同工作区（同一项目键）
const UUID_ORPHAN = 'bbbbbbbb-2222-4222-8222-222222222222' // 裸 UUID 但没有任何登记（历史遗留）
const UUID_GHOST = 'cccccccc-3333-4333-8333-333333333333' // 登记指向一个不存在的父（孤儿）
const UUID_CROSS = 'dddddddd-4444-4444-8444-444444444444' // 父在 ws-a，它在未分组（跨工作区）
const UUID_UNGROUP_A = 'eeeeeeee-5555-4555-8555-555555555555' // 未分组的父
const UUID_UNGROUP_B = 'ffffffff-6666-4666-8666-666666666666' // 它的子（另一个项目键，同为未分组）

function seedSession(projectKey, id, bytes) {
	mkdirSync(join(TMP, 'sessions', projectKey, id), { recursive: true })
	writeFileSync(join(TMP, 'sessions', projectKey, id, 'session.jsonl.zstd'), 'z'.repeat(bytes))
}

seedSession('--E-tmp-alpha--', 'session-cascade-p', 10)
seedSession('--E-tmp-alpha--', UUID_CHILD, 20)
seedSession('--E-tmp-alpha--', UUID_ORPHAN, 5)
seedSession('--E-orphan-a--', UUID_GHOST, 5)
seedSession('--E-orphan-a--', 'session-case-p', 10)
// 父在未分组（workspaceId null），它在 ws-b（E:/tmp/beta）→ 跨工作区。
seedSession('--E-tmp-beta--', UUID_CROSS, 5)
seedSession('--E-orphan-b--', UUID_UNGROUP_A, 10)
seedSession('--E-orphan-c--', UUID_UNGROUP_B, 7)

/** 写一份登记表并按它开一个 store；handler 与它共用（生产环境由 apply 保证同一个实例）。 */
async function treeHandler(claims, registry = makeRegistry()) {
	const file = join(TMP, 'claims-tree.json')
	rmSync(file, { force: true })
	writeFileSync(file, JSON.stringify({ version: 1, claims }))
	const claimsStore = openClaimsStore({ file })
	await claimsStore.ready
	return { handler: createRpcHandler(makeCtx(registry).ctx, Promise.resolve(mockStore()), claimsStore), claimsStore }
}

const TREE_CLAIMS = {
	[UUID_CHILD]: { owner: 'tree-plugin', parentSessionId: 'session-cascade-p' },
	[UUID_GHOST]: { owner: 'tree-plugin', parentSessionId: 'session-ghost' },
	[UUID_CROSS]: { owner: 'tree-plugin', parentSessionId: 'session-case-p' },
	[UUID_UNGROUP_B]: { owner: 'tree-plugin', parentSessionId: UUID_UNGROUP_A },
}

const { handler: treeRpc } = await treeHandler(TREE_CLAIMS)

await check('inventory：同工作区的子会话带 parentId 与 kind=subagent', async () => {
	const result = await treeRpc('inventory', {})
	assert.equal(result.ok, true)
	const child = result.value.sessions.find((entry) => entry.id === UUID_CHILD)
	assert.equal(child.parentId, 'session-cascade-p')
	assert.equal(child.kind, 'subagent')
	assert.equal(child.orphan, false)
	const parent = result.value.sessions.find((entry) => entry.id === 'session-cascade-p')
	assert.equal(parent.parentId, null)
	assert.equal(parent.kind, 'session', 'session-<uuid> 且无父指针 → 普通会话')
})

await check('inventory：裸 UUID 没登记也算子会话（父未知，不推断、不掉行）', async () => {
	const result = await treeRpc('inventory', {})
	const orphanByShape = result.value.sessions.find((entry) => entry.id === UUID_ORPHAN)
	assert.equal(orphanByShape.kind, 'subagent')
	assert.equal(orphanByShape.parentId, null)
	assert.equal(orphanByShape.orphan, false, '没有父指针 ≠ 孤儿')
	assert.ok(result.value.sessions.some((entry) => entry.id === UUID_ORPHAN), '历史遗留的会话必须照常列出')
})

await check('inventory：登记指向不存在的父 → orphan=true 且父指针为 null', async () => {
	const result = await treeRpc('inventory', {})
	const ghost = result.value.sessions.find((entry) => entry.id === UUID_GHOST)
	assert.equal(ghost.orphan, true)
	assert.equal(ghost.parentId, null)
	assert.equal(ghost.kind, 'subagent')
})

await check('inventory：跨工作区的子会话仍报 parentId（可诊断），但级联不连带', async () => {
	const result = await treeRpc('inventory', {})
	const cross = result.value.sessions.find((entry) => entry.id === UUID_CROSS)
	assert.equal(cross.workspaceId, 'ws-b')
	// 父指针照样下发（"它声明了自己的父是谁"是可诊断的事实）；但**建树/级联**的边界是
	// "同一工作区"——客户端用同一份纯规则（src/shared/session-tree.js 的 childrenIndex）
	// 决定缩进，所以它不会缩进到另一个工作区的卡片里。
	assert.equal(cross.parentId, 'session-case-p')
	assert.equal(cross.kind, 'subagent')
	assert.equal(cross.orphan, false, '父确实存在，只是跨工作区')
})

await check('remove 不带 cascade：只删父，子会话原封不动（默认行为不变）', async () => {
	const { handler } = await treeHandler({ [UUID_CHILD]: TREE_CLAIMS[UUID_CHILD] })
	const result = await handler('remove', { sessionId: 'session-cascade-p' })
	assert.equal(result.ok, true)
	assert.equal(result.value.cascade, false)
	assert.deepEqual(result.value.removedIds, ['session-cascade-p'])
	assert.deepEqual(result.value.childrenRemoved, [])
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', 'session-cascade-p')), false)
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', UUID_CHILD)), true, '默认不级联')
})

await check('cascade 必须是 boolean（严格 payload 校验，含未知字段）', async () => {
	const bad = await treeRpc('remove', { sessionId: UUID_CHILD, cascade: 'yes' })
	assert.equal(bad.ok, false)
	assert.equal(bad.error.code, 'bad-request')
	const unknown = await treeRpc('remove', { sessionId: UUID_CHILD, deeper: true })
	assert.equal(unknown.ok, false)
	assert.equal(unknown.error.code, 'bad-request')
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', UUID_CHILD)), true)
})

await check('remove 活跃子孙 → 整体拒绝 session-active，一个字节都不删（父也留着）', async () => {
	// 让子会话"活跃"：sessions.get 认得它。
	const { handler } = await treeHandler({ [UUID_CHILD]: TREE_CLAIMS[UUID_CHILD] }, makeRegistry())
	const activeCtx = makeCtx(makeRegistry()).ctx
	activeCtx.sessions = { get: (id) => (id === UUID_CHILD ? {} : undefined) }
	const activeHandler = createRpcHandler(activeCtx, Promise.resolve(mockStore()), await (async () => {
		const file = join(TMP, 'claims-active.json')
		rmSync(file, { force: true })
		writeFileSync(file, JSON.stringify({ version: 1, claims: { [UUID_CHILD]: TREE_CLAIMS[UUID_CHILD] } }))
		return openClaimsStore({ file })
	})())
	seedSession('--E-tmp-alpha--', 'session-cascade-p', 10)
	const result = await activeHandler('remove', { sessionId: 'session-cascade-p', cascade: true })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'session-active')
	assert.match(result.error.message, new RegExp(UUID_CHILD))
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', UUID_CHILD)), true)
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', 'session-cascade-p')), true, '父也不该被删（半个级联更糟）')
	void handler
})

await check('remove cascade：先子后父，removedIds/childrenRemoved 可核对，文件都消失', async () => {
	const { handler } = await treeHandler({ [UUID_CHILD]: TREE_CLAIMS[UUID_CHILD] })
	const result = await handler('remove', { sessionId: 'session-cascade-p', cascade: true })
	assert.equal(result.ok, true)
	assert.equal(result.value.cascade, true)
	assert.deepEqual(result.value.removedIds, [UUID_CHILD, 'session-cascade-p'], '子先、父后')
	assert.deepEqual(result.value.childrenRemoved, [UUID_CHILD])
	assert.equal(result.value.bytes, 30, '20 + 10')
	assert.deepEqual(result.value.skipped, [])
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', UUID_CHILD)), false)
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-alpha--', 'session-cascade-p')), false)
})

await check('remove cascade：跨工作区的子孙不连带，逐个进 skipped 且留在磁盘上', async () => {
	const result = await treeRpc('remove', { sessionId: 'session-case-p', cascade: true })
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedIds, ['session-case-p'])
	assert.deepEqual(result.value.skipped, [{ id: UUID_CROSS, reason: 'different-workspace' }])
	assert.equal(existsSync(join(TMP, 'sessions', '--E-tmp-beta--', UUID_CROSS)), true, '跨工作区不连带')
})

await check('remove cascade：跨项目键但同一（未分组）工作区的子会话照常连带', async () => {
	const result = await treeRpc('remove', { sessionId: UUID_UNGROUP_A, cascade: true })
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedIds, [UUID_UNGROUP_B, UUID_UNGROUP_A], '子先、父后')
	assert.deepEqual(result.value.skipped, [])
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan-c--', UUID_UNGROUP_B)), false, '工件在别的项目键下也要删掉')
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan-b--', UUID_UNGROUP_A)), false)
})

await check('remove cascade：删完把子孙的登记也从登记表里清掉（账本不留残影）', async () => {
	const { handler, claimsStore } = await treeHandler({ [UUID_CHILD]: TREE_CLAIMS[UUID_CHILD] })
	seedSession('--E-tmp-alpha--', 'session-cascade-p', 10)
	seedSession('--E-tmp-alpha--', UUID_CHILD, 20)
	const result = await handler('remove', { sessionId: 'session-cascade-p', cascade: true })
	assert.equal(result.ok, true)
	assert.deepEqual(result.value.removedIds, [UUID_CHILD, 'session-cascade-p'])
	assert.equal(claimsStore.get(UUID_CHILD), undefined)
	assert.equal(claimsStore.get('session-cascade-p'), undefined)
	// 登记表也要落盘清掉（不是只改内存）。
	assert.equal(JSON.parse(readFileSync(join(TMP, 'claims-tree.json'), 'utf8')).claims[UUID_CHILD], undefined)
})

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}  (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
