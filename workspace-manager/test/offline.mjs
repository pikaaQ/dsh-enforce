// dsh-workspace-manager — 离线测试（宿主状态 + 隐藏规则 + 工作区投影）
//
// 覆盖三件事：
//   A. src/shared/hidden.js    —— 隐藏规则的纯函数（动态计算，不落快照）
//   B. src/shared/projection.js —— 包装 ctx.workspaces.list 的投影（引用稳定性是硬要求）
//   C. src/host/closed-set.js  —— 宿主 JSON 状态（原子写、幂等、容错、串行化）
//
// 不依赖 dsh 运行时、不联网、不碰真实状态文件（C 用临时目录）。
//
// 运行：node test/offline.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultStatePath, openClosedStore, parseState, resolveDshHome } from '../src/host/closed-set.js'
import { hiddenSessionIdsFor, unionArchivedSessionIds, visibleWorkspaceItems } from '../src/shared/hidden.js'
import { installWorkspaceProjection } from '../src/shared/projection.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, 'tmp')

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

const workspace = (workspaceId, title, sessionIds) => ({ workspaceId, title, path: `E:/tmp/${title}`, sessionIds })

console.log('=== A. 隐藏规则（src/shared/hidden.js）===')
const wsA = workspace('ws-a', 'alpha', ['s1', 's2'])
const wsB = workspace('ws-b', 'beta', ['s3'])
const items = [wsA, wsB]

await check('没有关闭项时 visibleWorkspaceItems 返回原数组本身（引用稳定）', () => {
	assert.equal(visibleWorkspaceItems(items, new Set()), items)
})
await check('关闭 ws-a 后 items 只剩 ws-b', () => {
	assert.deepEqual(visibleWorkspaceItems(items, new Set(['ws-a'])).map((item) => item.workspaceId), ['ws-b'])
})
await check('没有关闭项时 hiddenSessionIdsFor 返回空数组', () => {
	assert.deepEqual(hiddenSessionIdsFor(items, new Set()), [])
})
await check('关闭 ws-a 隐藏它名下的两个会话', () => {
	assert.deepEqual(hiddenSessionIdsFor(items, new Set(['ws-a'])), ['s1', 's2'])
})
await check('关闭两个工作区时按 items 顺序汇总', () => {
	assert.deepEqual(hiddenSessionIdsFor(items, new Set(['ws-a', 'ws-b'])), ['s1', 's2', 's3'])
})
await check('未知工作区 id 不产生影响', () => {
	assert.deepEqual(hiddenSessionIdsFor(items, new Set(['ws-zzz'])), [])
})
await check('动态性：关闭期间新加入的会话也会被隐藏（不产生孤儿）', () => {
	const grown = [workspace('ws-a', 'alpha', ['s1', 's2', 's-new']), wsB]
	assert.deepEqual(hiddenSessionIdsFor(grown, new Set(['ws-a'])), ['s1', 's2', 's-new'])
})
await check('动态性：从别处移动进来的会话同样被隐藏', () => {
	const moved = [workspace('ws-a', 'alpha', ['s1', 's2', 's3']), workspace('ws-b', 'beta', [])]
	assert.deepEqual(hiddenSessionIdsFor(moved, new Set(['ws-a'])), ['s1', 's2', 's3'])
})
await check('会话 id 去重', () => {
	const duplicated = [workspace('ws-a', 'alpha', ['s1', 's1'])]
	assert.deepEqual(hiddenSessionIdsFor(duplicated, new Set(['ws-a'])), ['s1'])
})
await check('items 缺 sessionIds 时不抛错', () => {
	assert.deepEqual(hiddenSessionIdsFor([{ workspaceId: 'ws-a' }], new Set(['ws-a'])), [])
})
await check('unionArchivedSessionIds 无新增时返回宿主数组本身（引用稳定）', () => {
	const host = ['x']
	assert.equal(unionArchivedSessionIds(host, []), host)
})
await check('并集保留宿主成员、追加新成员、去重', () => {
	assert.deepEqual(unionArchivedSessionIds(['x', 's1'], ['s1', 's2']), ['x', 's1', 's2'])
})
await check('并集不修改宿主数组', () => {
	const host = ['x']
	unionArchivedSessionIds(host, ['y'])
	assert.deepEqual(host, ['x'])
})

console.log('\n=== B. 工作区投影（src/shared/projection.js）===')
/**
 * 最小 SnapshotStore 替身——**刻意做成对象字面量**，忠实还原
 * `createSnapshotStore()`（dsh-client-runtime/lib/client.js:5415）的形状：
 * getSnapshot/subscribe 都是自有属性、没有原型可回退。
 */
function createFakeStore(snapshot) {
	const listeners = new Set()
	return {
		snapshot,
		rawGetSnapshot: undefined, // 由测试填充，用于验证 dispose 是"赋回"而不是 delete
		getSnapshot() {
			return this.snapshot
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		publish(next) {
			this.snapshot = next
			for (const listener of [...listeners]) listener()
		},
	}
}

function makeSource(initialClosed = []) {
	const state = { closed: new Set(initialClosed), version: 0 }
	const listeners = new Set()
	return {
		state,
		closedIds: () => state.closed,
		closedVersion: () => state.version,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		setClosed(ids) {
			state.closed = new Set(ids)
			state.version += 1
			for (const listener of [...listeners]) listener()
		},
	}
}

const baseSnapshot = Object.freeze({
	items,
	archivedSessionIds: Object.freeze(['host-1']),
	state: 'idle',
	phase: 'ready',
	error: null,
	baselinesReady: true,
	recentWorkspaceId: 'ws-b',
})

const model = createFakeStore(baseSnapshot)
const originalGetSnapshot = model.getSnapshot
const originalSubscribe = model.subscribe
const source = makeSource()
const projection = installWorkspaceProjection(model, source)

await check('关闭集合为空时返回原始快照对象本身', () => {
	assert.equal(model.getSnapshot(), baseSnapshot)
})
await check('getSnapshot 连续调用返回同一对象（React 引用稳定性）', () => {
	assert.equal(model.getSnapshot(), model.getSnapshot())
})
await check('包装后用自有属性覆盖原始实现（字面量对象，无原型可回退）', () => {
	assert.equal(Object.hasOwn(model, 'getSnapshot'), true)
	assert.notEqual(model.getSnapshot, originalGetSnapshot)
	assert.notEqual(model.subscribe, originalSubscribe)
})
await check('readRaw() 仍返回未过滤快照（设置页要列出全部工作区）', () => {
	assert.equal(projection.readRaw(), baseSnapshot)
	assert.deepEqual(projection.readRaw().items.map((item) => item.workspaceId), ['ws-a', 'ws-b'])
})

source.setClosed(['ws-a'])
await check('关闭 ws-a 后 items 里不再有它', () => {
	assert.deepEqual(model.getSnapshot().items.map((item) => item.workspaceId), ['ws-b'])
})
await check('关闭 ws-a 后它名下的会话并入 archivedSessionIds（含宿主原有成员）', () => {
	assert.deepEqual(model.getSnapshot().archivedSessionIds, ['host-1', 's1', 's2'])
})
await check('投影结果是新对象，但未改动原始快照', () => {
	assert.notEqual(model.getSnapshot(), baseSnapshot)
	assert.deepEqual(baseSnapshot.items.map((item) => item.workspaceId), ['ws-a', 'ws-b'])
	assert.deepEqual([...baseSnapshot.archivedSessionIds], ['host-1'])
})
await check('投影后再取快照仍是同一对象（记忆化命中）', () => {
	assert.equal(model.getSnapshot(), model.getSnapshot())
})
await check('其余字段原样透传', () => {
	const snapshot = model.getSnapshot()
	assert.equal(snapshot.state, 'idle')
	assert.equal(snapshot.baselinesReady, true)
	assert.equal(snapshot.error, null)
})

// recentWorkspaceId 指向被关闭的工作区
const model2 = createFakeStore({ ...baseSnapshot, recentWorkspaceId: 'ws-a' })
const source2 = makeSource(['ws-a'])
const projection2 = installWorkspaceProjection(model2, source2)
await check('recentWorkspaceId 指向已关闭工作区时被清空（新建会话不会落到看不见的工作区）', () => {
	assert.equal(model2.getSnapshot().recentWorkspaceId, undefined)
})
await check('recentWorkspaceId 未被关闭时保持原值', () => {
	assert.equal(model.getSnapshot().recentWorkspaceId, 'ws-b')
})

// 订阅行为
const model3 = createFakeStore(baseSnapshot)
const source3 = makeSource()
installWorkspaceProjection(model3, source3)
let rawNotifications = 0
let localNotifications = 0
const off = model3.subscribe(() => { rawNotifications += 1 })
source3.subscribe(() => { localNotifications += 1 })
model3.publish({ ...baseSnapshot, phase: 'reloading' })
await check('原始快照变化会通知订阅者', () => assert.equal(rawNotifications, 1))
source3.setClosed(['ws-b'])
await check('订阅者同时接收两个来源：关闭集合变化也会通知（本地变更立刻重绘）', () => assert.equal(rawNotifications, 2))
off()
model3.publish({ ...baseSnapshot, phase: 'ready' })
source3.setClosed(['ws-a'])
await check('取消订阅后两个来源都不再通知', () => assert.equal(rawNotifications, 2))
await check('两个来源（原始 + 本地）都收到了各自的变更', () => assert.equal(localNotifications, 2))

// 关闭期间底层新增会话
const model4 = createFakeStore(baseSnapshot)
const source4 = makeSource(['ws-a'])
installWorkspaceProjection(model4, source4)
const beforeGrow = model4.getSnapshot()
await check('关闭期间底层把新会话记到该工作区，隐藏集合随之更新', () => {
	const grown = [workspace('ws-a', 'alpha', ['s1', 's2', 's-new']), wsB]
	model4.publish({ ...baseSnapshot, items: grown })
	assert.deepEqual(model4.getSnapshot().archivedSessionIds, ['host-1', 's1', 's2', 's-new'])
	assert.notEqual(model4.getSnapshot(), beforeGrow)
})

// dispose：必须是"把原函数赋回去"，绝不能 delete（字面量对象没有原型可回退）
const model5 = createFakeStore(baseSnapshot)
const originalGet5 = model5.getSnapshot
const originalSub5 = model5.subscribe
const projection5 = installWorkspaceProjection(model5, makeSource(['ws-a']))
await check('dispose 前确实在过滤', () => {
	assert.deepEqual(model5.getSnapshot().items.map((item) => item.workspaceId), ['ws-b'])
})
projection5.dispose()
await check('dispose 后原始实现被赋回（不是被 delete 成 undefined）', () => {
	assert.equal(model5.getSnapshot, originalGet5)
	assert.equal(model5.subscribe, originalSub5)
	assert.equal(typeof model5.getSnapshot, 'function')
	assert.equal(typeof model5.subscribe, 'function')
})
await check('dispose 后不再过滤（幂等回退到官方行为）', () => {
	assert.deepEqual(model5.getSnapshot().items.map((item) => item.workspaceId), ['ws-a', 'ws-b'])
})
await check('dispose 后仍可安全调用 subscribe（不会因缺方法而崩）', () => {
	let hits = 0
	const off = model5.subscribe(() => { hits += 1 })
	model5.publish({ ...baseSnapshot, phase: 'x' })
	off()
	assert.equal(hits, 1)
})

console.log('\n=== C. 宿主状态（src/host/closed-set.js）===')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const statePath = join(TMP, 'state.json')

await check('DSH_HOME 优先于家目录', () => {
	assert.equal(resolveDshHome({ DSH_HOME: 'D:/custom' }, 'C:/Users/x'), 'D:/custom')
	assert.equal(resolveDshHome({}, 'C:/Users/x'), join('C:/Users/x', '.dsh'))
})
await check('默认状态文件位于 DSH_HOME 下，且沿用 dsh-<名字>.state.json 约定', () => {
	const path = defaultStatePath({ DSH_HOME: 'D:/custom' }, 'C:/Users/x')
	assert.equal(path, join('D:/custom', 'dsh-workspace-manager.state.json'))
})

const store = await openClosedStore({ file: statePath })
await check('初始为空', () => assert.deepEqual(store.ids(), []))
await check('close() 返回 true 表示发生了变化', async () => {
	assert.equal(await store.close('ws-a'), true)
})
await check('重复 close() 幂等，返回 false', async () => {
	assert.equal(await store.close('ws-a'), false)
})
await check('open() 移除该项', async () => {
	assert.equal(await store.open('ws-a'), true)
	assert.deepEqual(store.ids(), [])
})
await check('open() 不存在的项返回 false', async () => {
	assert.equal(await store.open('ws-zzz'), false)
})
await check('非法 id 被忽略', async () => {
	assert.equal(await store.close('   '), false)
	assert.equal(await store.close(undefined), false)
	assert.deepEqual(store.ids(), [])
})
await check('setClosed 去重并保持传入顺序', async () => {
	await store.setClosed(['ws-b', 'ws-a', 'ws-b'])
	assert.deepEqual(store.ids(), ['ws-b', 'ws-a'])
})
await check('状态已落盘（文件存在且内容正确）', () => {
	const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
	assert.deepEqual(onDisk.closedWorkspaceIds, ['ws-b', 'ws-a'])
	assert.equal(onDisk.version, 1)
})
await check('目录里没有残留 .tmp 文件（原子写收尾干净）', () => {
	assert.equal(readdirSync(TMP).filter((name) => name.endsWith('.tmp')).length, 0)
})
await check('重新打开后状态保持（持久化生效）', async () => {
	const reopened = await openClosedStore({ file: statePath })
	assert.deepEqual(reopened.ids(), ['ws-b', 'ws-a'])
})
await check('并发写入被串行化，最终一致', async () => {
	const concurrent = await openClosedStore({ file: join(TMP, 'concurrent.json') })
	await Promise.all([
		concurrent.close('w1'),
		concurrent.close('w2'),
		concurrent.close('w3'),
	])
	assert.deepEqual([...concurrent.ids()].sort(), ['w1', 'w2', 'w3'])
})
await check('prune 只清掉已不存在的记录', async () => {
	await store.prune(new Set(['ws-b']))
	assert.deepEqual(store.ids(), ['ws-b'])
})
await check('prune 无变化时不写盘（返回 false）', async () => {
	assert.equal(await store.prune(new Set(['ws-b'])), false)
})
await check('损坏的状态文件退化为空集合且不抛错', async () => {
	const broken = join(TMP, 'broken.json')
	writeFileSync(broken, '{ this is not json')
	const recovered = await openClosedStore({ file: broken })
	assert.deepEqual(recovered.ids(), [])
	writeFileSync(broken, JSON.stringify({ version: 1, closedWorkspaceIds: ['ok', 42, null, ''] }))
	const filtered = await openClosedStore({ file: broken })
	assert.deepEqual(filtered.ids(), ['ok'])
})
await check('parseState 对缺字段/错类型都安全', () => {
	assert.deepEqual(parseState('{}').closedWorkspaceIds, [])
	assert.deepEqual(parseState('null').closedWorkspaceIds, [])
	assert.deepEqual(parseState('{"closedWorkspaceIds":"nope"}').closedWorkspaceIds, [])
})
await check('文件不存在时按空集合启动（首次使用）', async () => {
	const fresh = await openClosedStore({ file: join(TMP, 'nope', 'state.json') })
	assert.deepEqual(fresh.ids(), [])
	assert.equal(existsSync(join(TMP, 'nope', 'state.json')), false)
})

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}  (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
