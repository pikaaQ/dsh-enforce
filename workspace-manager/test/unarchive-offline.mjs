// 离线验证：移除 archivedSessionIds 里的 id 能否恢复被归档的会话。
//
// 这不是模拟实现——它 import 内核真实的 `WorkspaceRegistry` 类与真实的
// `workspaceDomainState` zod schema，喂进你机器上真实状态文件的副本，
// 并调用本插件将来真正要用的那份代码（src/host/archive-set.js）。
// 只有 storage domain 的落盘/广播换成等价假实现（真 storage 需要完整的
// cordis medium 与加锁），假实现严格照内核契约：先落盘 → 再换内存 → 再
// emit('domain/changed')（见 dsh-storage-domain/lib/index.js:87/205）。
//
// 运行：node test/unarchive-offline.mjs

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
	archiveSessionId,
	readArchivedSessionIds,
	supportsArchiveSetWrite,
	unarchiveSessionId,
} from '../src/host/archive-set.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, 'tmp')
// 内核入口：各人 node / dsh 的安装位置不同，用 $DSH_KERNEL 覆盖；
// 缺省值由 process.execPath 推导（假设 node 在 <root>/node.exe, 模块在 <root>/node_modules/）。
const KERNEL = process.env.DSH_KERNEL
	?? join(dirname(process.execPath), 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js')
// 默认 DSH_HOME 由 homedir() 推导（不写死某个人的用户目录）；$DSH_HOME 可覆盖。
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const REAL_STATE = join(DSH_HOME, 'storages', 'workspace.json')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

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
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

// ── 内核真实实现 ────────────────────────────────────────────────────────────
if (!existsSync(KERNEL)) {
	console.error(`内核入口不存在：${KERNEL}`)
	console.error('请用 $DSH_KERNEL 指向 <dsh 安装目录>/node_modules/@deepseek-ai/dsh-workspace/lib/index.js')
	process.exit(1)
}
const { WorkspaceRegistry, workspaceDomainState } = await import(pathToFileURL(KERNEL).href)
assert.equal(typeof WorkspaceRegistry, 'function', 'kernel WorkspaceRegistry must load')

// ── 真实状态文件的副本（绝不碰真文件） ──────────────────────────────────────
mkdirSync(TMP, { recursive: true })
const statePath = join(TMP, 'workspace.json')
copyFileSync(REAL_STATE, statePath)
const realFileHashBefore = sha256(REAL_STATE)
const real = JSON.parse(readFileSync(statePath, 'utf8'))
const document = structuredClone(real) // 假 storage 的"整份文档"
const ORIGINAL_IDS = [...real.global.archivedSessionIds]
const TARGET = ORIGINAL_IDS[0]

console.log('=== 0. 基线 ===')
console.log(`  状态文件   : ${REAL_STATE}`)
console.log(`  工作区数   : ${Object.keys(real.tables.workspaces).length}`)
console.log(`  已归档会话 : ${ORIGINAL_IDS.length}`)
console.log(`  目标会话   : ${TARGET}`)

// ── 等价假 storage + 最小 registry 实例 ─────────────────────────────────────
const changes = [] // 模拟 domain/changed 广播

const globalFace = {
	get: () => document.global,
	set: async (next) => {
		document.global = next // 契约顺序：先落盘、再换内存、再广播
		write(statePath, document)
		changes.push({ domain: 'workspace', table: '', operation: 'put', value: next })
	},
}

function fakeTable(records) {
	const map = new Map(Object.entries(records))
	let puts = 0
	return {
		get size() { return map.size },
		get: (key) => map.get(key),
		keys: () => map.keys(),
		entries: () => map.entries(),
		delete: async (key) => { map.delete(key) },
		put: async (key, value) => { puts += 1; map.set(key, value) },
		update: async (key, fn) => { puts += 1; map.set(key, fn(map.get(key))) },
		get puts() { return puts },
		toJSON: () => Object.fromEntries(map),
	}
}
const table = fakeTable(real.tables.workspaces)

const sessionsFace = {
	get: (id) => (id === TARGET ? { header: { id, cwd: 'E:/work/example-project', createdAt: 1 } } : undefined),
}
const persistenceFace = { list: async () => [] }

const registry = Object.create(WorkspaceRegistry.prototype)
Object.assign(registry, {
	ctx: {
		// 内核两种访问方式都用：ctx.get(name) 与 ctx.<name>（cordis Service 访问器）
		get: (name) => (name === 'sessions' ? sessionsFace : name === 'sessionPersistence' ? persistenceFace : undefined),
		sessions: sessionsFace,
		sessionPersistence: persistenceFace,
		logger: { warn: (...args) => console.log(`  [kernel warn] ${args.join(' ')}`), info: () => {} },
		effect: () => () => {},
	},
	table,
	global: globalFace,
	state: document.global,
	entities: new Map(),
	headers: new Map(),
	sessionPaths: new Map(),
	invalidSessionPaths: new Map(),
	operationTail: Promise.resolve(),
})

const logDir = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(SESSIONS_ROOT, entry.name, TARGET))
	.find((candidate) => existsSync(candidate))
const tablesBefore = JSON.stringify(table.toJSON())

console.log('\n=== 1. 能力探测与内核不变量（基线，不写盘）===')
await check('supportsArchiveSetWrite(registry) 为真（enqueueOperation/requireState/setState 都在）', () => {
	assert.equal(supportsArchiveSetWrite(registry), true)
})
await check('读取归档集合成功', () => {
	assert.deepEqual(readArchivedSessionIds(registry), ORIGINAL_IDS)
})
await check('真实状态通过内核 validateStoredState（order/表/路径/记账一致性）', () => {
	registry.validateStoredState(registry.requireState())
})
await check('真实状态通过内核 workspaceDomainState zod schema', () => {
	workspaceDomainState.parse(registry.requireState())
})
await check('基线阶段没有任何写盘与广播', () => {
	assert.equal(changes.length, 0)
})
await check('目标会话的日志目录能在磁盘上找到（证明归档前它就有日志）', () => {
	assert.notEqual(logDir, undefined)
	assert.equal(existsSync(logDir), true)
})

console.log('\n=== 2. 移除一个 id（= 重新打开会话）===')
const result = await unarchiveSessionId(registry, TARGET)
await check('返回 { ok: true, changed: true }', () => {
	assert.deepEqual({ ok: result.ok, changed: result.changed }, { ok: true, changed: true })
})
await check('内存快照里已不含该 id', () => {
	assert.equal(registry.requireState().archivedSessionIds.includes(TARGET), false)
})
await check('落盘文件里已不含该 id', () => {
	assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).global.archivedSessionIds.includes(TARGET), false)
})
await check(`集合长度 ${ORIGINAL_IDS.length} -> ${ORIGINAL_IDS.length - 1}`, () => {
	assert.equal(registry.requireState().archivedSessionIds.length, ORIGINAL_IDS.length - 1)
})
await check('其余 id 与其相对顺序完全不变', () => {
	assert.deepEqual(registry.requireState().archivedSessionIds, ORIGINAL_IDS.slice(1))
})
await check('写后仍通过 validateStoredState', () => {
	registry.validateStoredState(registry.requireState())
})
await check('写后仍通过 workspaceDomainState schema', () => {
	workspaceDomainState.parse(registry.requireState())
})
await check('workspaces 表逐字节未变（工作区记账零影响）', () => {
	assert.equal(JSON.stringify(table.toJSON()), tablesBefore)
})
await check('table.puts === 0（没动任何工作区记录）', () => {
	assert.equal(table.puts, 0)
})
await check('会话日志目录仍在磁盘上（归档不是删除）', () => {
	assert.equal(existsSync(logDir), true)
})
await check('发出了 domain/changed 事件（客户端广播的来源）', () => {
	assert.equal(changes.length, 1)
	assert.deepEqual([changes[0].domain, changes[0].table, changes[0].operation], ['workspace', '', 'put'])
})
await check('api-proxy 的差异判定会认为集合变了 => 会推 host/archived-sessions-changed', () => {
	// 照抄 dsh-host-apiproxy/lib/index.js:3665 的判定式
	const after = changes[0].value.archivedSessionIds
	const differs = after.length !== ORIGINAL_IDS.length || after.some((id, index) => id !== ORIGINAL_IDS[index])
	assert.equal(differs, true)
})
await check('幂等：再次移除同一个 id 不写盘、不广播', async () => {
	const again = await unarchiveSessionId(registry, TARGET)
	assert.deepEqual({ ok: again.ok, changed: again.changed }, { ok: true, changed: false })
	assert.equal(changes.length, 1)
})
await check('拒绝空 id（bad-session-id，不写盘）', async () => {
	const bad = await unarchiveSessionId(registry, '   ')
	assert.deepEqual({ ok: bad.ok, reason: bad.reason }, { ok: false, reason: 'bad-session-id' })
	assert.equal(changes.length, 1)
})

console.log('\n=== 3. 放回去（= 归档，走内核官方 archiveSession）===')
const back = await archiveSessionId(registry, TARGET)
await check('返回 { ok: true, changed: true }', () => {
	assert.deepEqual({ ok: back.ok, changed: back.changed }, { ok: true, changed: true })
})
await check(`集合长度回到 ${ORIGINAL_IDS.length}`, () => {
	assert.equal(registry.requireState().archivedSessionIds.length, ORIGINAL_IDS.length)
})
await check('官方语义：追加到末尾（不是插回原位）', () => {
	const now = registry.requireState().archivedSessionIds
	assert.deepEqual(now.slice(0, ORIGINAL_IDS.length - 1), ORIGINAL_IDS.slice(1))
	assert.equal(now.at(-1), TARGET)
})
await check('写后仍通过 validateStoredState + schema', () => {
	registry.validateStoredState(registry.requireState())
	workspaceDomainState.parse(registry.requireState())
})
await check('未知会话被内核官方拒绝（WorkspaceUnknownSessionError）', async () => {
	let name = 'no-throw'
	let message = ''
	try {
		await archiveSessionId(registry, 'session-does-not-exist-0000')
	} catch (error) {
		name = error?.name ?? 'unknown'
		message = String(error?.message ?? '')
	}
	assert.equal(name, 'WorkspaceUnknownSessionError', `实际错误: ${name}: ${message}`)
})

console.log('\n=== 4. 安全边界 ===')
await check(`真实状态文件哈希不变（${realFileHashBefore.slice(0, 12)}…）`, () => {
	assert.equal(sha256(REAL_STATE), realFileHashBefore)
})
await check('方法缺失时降级：不支持的 registry 返回 ok:false', async () => {
	const crippled = { archivedSessionIds: [] }
	assert.equal(supportsArchiveSetWrite(crippled), false)
	const outcome = await unarchiveSessionId(crippled, 'session-x')
	assert.deepEqual({ ok: outcome.ok, reason: outcome.reason }, { ok: false, reason: 'unsupported-registry' })
})

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}  (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
