// dsh-workspace-manager — 「运行时观察到的父子边 → 账本」提升测试
//
// 覆盖本次增强：平台自带的 `subagent` / `subagent_fork` 不走 `sessionRemoval.claim()` 登记，
// 它们的父子边只活在当前进程内存里。这里验证：
//   * 提升把观察到的边**落盘**（`source: 'observed'`、没有 owner、带时间戳）；
//   * 只用账本就能重建树（模拟重启：新 store / 新 tree，不喂运行时）；
//   * **登记优先**：观察到的边绝不改写已 claim 的 owner/parent（inventory 也照旧返回登记父）；
//   * 幂等（第二次提升不写盘、不产生重复条目，旧格式文件原样不动）；
//   * 防御与合成阶段同一套：自引用 / 环 / 父或子 id 不安全 一律不落盘；
//   * 历史会话（会话头没有 `parentSession`）**不会**被提升；
//   * `apply()` 在 `ctx.sessions.list()` 抛错时不崩；提升自身失败只告警、不影响 inventory。
//
// 全程写到临时 DSH_HOME（`test/tmp-runtime-promote`），绝不触碰真实 home 与真实会话。
//
// 运行：node test/runtime-promote.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, 'tmp-runtime-promote')

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
process.env.DSH_HOME = TMP // apply()/inventory/提升都只认这个 home

const { apply, createRpcHandler } = await import('../src/host/index.js')
const { CLAIMS_FILE_NAME, CLAIMS_VERSION, openClaimsStore } = await import('../src/host/claims-store.js')
const { buildSessionTree, createRuntimeEdgePromoter, promoteRuntimeEdges } = await import('../src/host/session-tree.js')

const CLAIMS_FILE = join(TMP, CLAIMS_FILE_NAME)
const PARENT = 'session-11111111-1111-4111-8111-111111111111'
const OTHER_PARENT = 'session-99999999-9999-4999-8999-999999999999'
const CHILD = '11111111-2222-4333-8444-555555555555' // 裸 UUID = 子会话
const GRAND = '22222222-3333-4444-8555-666666666666'
const LONE = '33333333-4444-4555-8666-777777777777' // 历史遗留：会话头里没有 parentSession

/** 临时账本文件（每个检查各用一个，互不串味）。 */
const claimsFile = (name) => join(TMP, `claims-${name}.json`)

/** 读回账本条目（不存在时返回 {}）。 */
function readClaims(file) {
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).claims : {}
}

/** 打开账本 + 统计"真的写盘"的次数（`setMany` 返回 true 的次数）。 */
function openStoreWithCounter(file) {
	const inner = openClaimsStore({ file })
	const calls = { setMany: 0, wrote: 0 }
	const store = {
		...inner,
		async setMany(list) {
			calls.setMany += 1
			const changed = await inner.setMany(list)
			if (changed) calls.wrote += 1
			return changed
		},
	}
	return { store, inner, calls }
}

/** 磁盘清点行（会话树只关心 id / workspaceId）。 */
const row = (id, workspaceId = 'ws-a') => ({ id, workspaceId, projectKey: '--E-tmp--' })

/** 在临时 home 里播种一个会话工件目录（清点能看得见它）。 */
function seedSession(id, projectKey = '--E-tmp--') {
	const dir = join(TMP, 'sessions', projectKey, id)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'session.jsonl.zstd'), 'x')
	return dir
}

/** 假 registry：本插件只用到 `list()`；没有写面 → canRestoreArchive=false，与本次无关。 */
const makeRegistry = () => ({
	get archivedSessionIds() {
		return []
	},
	list: () => [{ id: 'ws-a', title: 'alpha', path: 'E:/tmp/alpha', sessionIds: [] }],
})

/**
 * 假 ctx。
 * `headers` 是 `[id, parentSession?]` 列表（不给父 = 历史遗留会话，会话头里没有 parentSession）。
 */
function makeCtx({ headers = [], listThrows = false, registry = makeRegistry() } = {}) {
	const warnings = []
	const provided = {}
	const sessions = headers.map(([id, parentSession]) => ({
		id,
		header: parentSession === undefined ? { id } : { id, parentSession },
	}))
	const ctx = {
		logger: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
		workspaceRegistry: registry,
		agents: { get: () => undefined, list: () => [] },
		sessions: {
			get: () => undefined,
			list: () => {
				if (listThrows) throw new Error('sessions snapshot unavailable')
				return sessions
			},
		},
		connection: { rpc: { handle: () => () => {} } },
		effect(fn) {
			try {
				fn()
			} catch {
				/* 测试夹具：注册失败不影响断言 */
			}
			return () => {}
		},
		provide(name, value) {
			provided[name] = value
			return () => {
				delete provided[name]
			}
		},
	}
	return { ctx, warnings, provided }
}

/** `inventory` 端点只要一个"关闭集合"假 store（真正的状态文件与本次无关）。 */
const fakeClosedStore = { prune: async () => {}, ids: () => [], file: join(TMP, 'fake.state.json') }

/** 轮询等待（启动提升是 fire-and-forget 的：apply 不能被它拖住）。 */
async function waitFor(predicate, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		let value
		try {
			value = await predicate()
		} catch {
			value = false
		}
		if (value) return value
		if (Date.now() > deadline) throw new Error('waitFor 超时：条件始终不成立')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

// ── 1. 提升本身（纯逻辑 + 临时账本文件）───────────────────────────────────────
console.log('=== A. 提升：观察到的边 → 账本 ===')

const observedFile = claimsFile('observed')
rmSync(observedFile, { force: true })

await check('提升把观察到的边落盘：source=observed、没有 owner、带时间戳', async () => {
	const { store } = openStoreWithCounter(observedFile)
	const promoter = createRuntimeEdgePromoter({ store })
	// LONE 的会话头里没有 parentSession（历史遗留）→ 不该产生任何条目。
	const { ctx } = makeCtx({ headers: [[LONE], [PARENT], [CHILD, PARENT]] })
	const report = await promoter.promote(ctx)
	assert.equal(report.ok, true)
	assert.deepEqual(report.promoted, [CHILD])
	assert.deepEqual(report.declined, [])
	assert.equal(report.wrote, true)
	const onDisk = JSON.parse(readFileSync(observedFile, 'utf8'))
	assert.equal(onDisk.version, CLAIMS_VERSION)
	assert.equal(onDisk.claims[CHILD].parentSessionId, PARENT)
	assert.equal(onDisk.claims[CHILD].source, 'observed')
	assert.equal(Object.hasOwn(onDisk.claims[CHILD], 'owner'), false, '观察条目没有 owner')
	assert.equal(typeof onDisk.claims[CHILD].observedAt, 'number')
	assert.equal(onDisk.claims[LONE], undefined, '会话头没有 parentSession → 不提升')
	assert.equal(onDisk.claims[PARENT], undefined, '普通会话不产生条目')
})

await check('历史会话（会话头没有 parentSession）不会被提升：连账本文件都不建、不追认', async () => {
	const file = claimsFile('historic')
	rmSync(file, { force: true })
	const { store, calls } = openStoreWithCounter(file)
	const promoter = createRuntimeEdgePromoter({ store })
	// 三个会话头都没有 parentSession（进程早已结束 / header 缺失的历史遗留会话）。
	const report = await promoter.promote(makeCtx({ headers: [[PARENT], [LONE], [CHILD]] }).ctx)
	assert.deepEqual(report.promoted, [])
	assert.deepEqual(report.declined, [])
	assert.deepEqual(report.skipped, [])
	assert.equal(report.candidates, 0, '没有一条边可提升')
	assert.equal(report.wrote, false)
	assert.equal(calls.setMany, 0, '没有任何边 → 账本都不碰')
	assert.equal(existsSync(file), false, '不为一堆历史会话凭空造出账本文件')
})

await check('模拟重启：只用账本重建树（新 store / 新 tree，不喂运行时）→ 子会话仍挂在父下面', async () => {
	const revived = openClaimsStore({ file: observedFile }) // 新实例：只能从磁盘读回
	await revived.ready
	const entries = revived.entries()
	assert.equal(entries.length, 1)
	assert.equal(entries[0].source, 'observed')
	const tree = buildSessionTree({ rows: [row(PARENT), row(CHILD)], claims: entries })
	assert.equal(tree.byId.get(CHILD).parentId, PARENT)
	assert.equal(tree.byId.get(CHILD).parentSource, 'observed')
	assert.equal(tree.byId.get(CHILD).kind, 'subagent')
	assert.deepEqual(tree.childrenOf(PARENT).map((node) => node.id), [CHILD])
})

await check('合成优先级：登记 > 运行时 > 账本里的观察边（提升不改变进程内看得见的关系）', async () => {
	const rows = [row(PARENT), row(OTHER_PARENT), row(CHILD)]
	// 账本里有一条观察边（child → 别的父），运行时说 child → PARENT：运行时赢。
	const live = buildSessionTree({
		rows,
		claims: [{ id: CHILD, parentSessionId: OTHER_PARENT, source: 'observed' }],
		runtime: [{ id: CHILD, parentId: PARENT, source: 'runtime' }],
	})
	assert.equal(live.byId.get(CHILD).parentId, PARENT, '运行时快照压过账本里的观察边')
	assert.equal(live.byId.get(CHILD).parentSource, 'runtime')
	// 运行时读不到（刚重启）→ 才用账本里的观察边兜底。
	const cold = buildSessionTree({ rows, claims: [{ id: CHILD, parentSessionId: OTHER_PARENT, source: 'observed' }] })
	assert.equal(cold.byId.get(CHILD).parentId, OTHER_PARENT)
	assert.equal(cold.byId.get(CHILD).parentSource, 'observed')
	// 登记压过两者。
	const claimed = buildSessionTree({
		rows,
		claims: [
			{ id: CHILD, parentSessionId: OTHER_PARENT, source: 'observed' },
			{ id: CHILD, owner: 'producer', parentSessionId: PARENT, source: 'claim' },
		],
		runtime: [{ id: CHILD, parentId: OTHER_PARENT, source: 'runtime' }],
	})
	assert.equal(claimed.byId.get(CHILD).parentId, PARENT)
	assert.equal(claimed.byId.get(CHILD).parentSource, 'claim')
})

await check('幂等：第二次提升既不写盘也不产生重复条目（连 setMany 都不再调用）', async () => {
	const file = claimsFile('idempotent')
	rmSync(file, { force: true })
	const { store, calls } = openStoreWithCounter(file)
	const promoter = createRuntimeEdgePromoter({ store })
	const { ctx } = makeCtx({ headers: [[CHILD, PARENT]] })
	const first = await promoter.promote(ctx)
	assert.deepEqual(first.promoted, [CHILD])
	assert.equal(first.wrote, true, '第一次：观察边落盘')
	const bytesBefore = readFileSync(file, 'utf8')
	const mtimeBefore = statSync(file).mtimeMs
	const setManyAfterFirst = calls.setMany
	const second = await promoter.promote(ctx)
	assert.deepEqual(second.promoted, [])
	assert.deepEqual(second.skipped.filter((entry) => entry.reason === 'already-promoted').map((entry) => entry.id), [CHILD])
	assert.equal(second.wrote, false)
	assert.equal(calls.setMany, setManyAfterFirst, '进程内缓存命中 → 连账本都不碰')
	assert.equal(calls.wrote, 1, '整个检查里只写盘一次')
	assert.equal(readFileSync(file, 'utf8'), bytesBefore, '文件一个字节都不变')
	assert.equal(statSync(file).mtimeMs, mtimeBefore, 'mtime 不变 = 没有写盘')
	assert.equal(Object.keys(readClaims(file)).length, 1, '不产生重复条目')
	// 不带缓存的一次性提升：内容没变时必须由账本自己判"无需写盘"。
	const stateless = await promoteRuntimeEdges(ctx, store)
	assert.equal(stateless.ok, true)
	assert.equal(stateless.wrote, false, '内容无变化 → 不重写文件')
	assert.equal(readFileSync(file, 'utf8'), bytesBefore)
})

await check('旧格式（v1，没有 source）读成 claim，且观察到的边绝不覆盖它 —— 文件连重写都不会', async () => {
	const file = claimsFile('legacy')
	// 老账本：没有 source 字段（v1）、owner 是别的插件、父指针是真的。
	const legacyText = `${JSON.stringify({ version: 1, claims: { [CHILD]: { owner: 'old-plugin', parentSessionId: PARENT } } })}\n`
	writeFileSync(file, legacyText)
	const { store, calls } = openStoreWithCounter(file)
	await store.ready
	assert.equal(store.get(CHILD).source, 'claim')
	assert.equal(store.get(CHILD).parentSessionId, PARENT)
	const report = await promoteRuntimeEdges({ sessions: { list: () => [{ id: CHILD, header: { id: CHILD, parentSession: OTHER_PARENT } }] } }, store, { logger: { warn: () => {} } })
	assert.deepEqual(report.promoted, [], '已有登记的 id 不该被"提升"成观察条目')
	assert.deepEqual(report.declined, [CHILD])
	assert.equal(report.wrote, false)
	assert.equal(calls.setMany, 1, '交给了账本，但账本判定无变化')
	const after = store.get(CHILD)
	assert.equal(after.owner, 'old-plugin')
	assert.equal(after.parentSessionId, PARENT, '登记优先：观察到的父不覆盖登记的父')
	assert.equal(after.source, 'claim')
	assert.equal(readFileSync(file, 'utf8'), legacyText, '无变化就不该重写文件（v1 原样留着）')
})

await check('登记落在纯观察条目上会把它升级成登记条目；没给父时保留已观察到的父', async () => {
	const file = claimsFile('upgrade')
	const { store } = openStoreWithCounter(file)
	await store.setMany([{ id: CHILD, parentSessionId: PARENT, source: 'observed', observedAt: 7 }])
	assert.equal(store.get(CHILD).owner, undefined)
	await store.setMany([{ id: CHILD, owner: 'dsh-vision-delegate', claimedAt: 8 }]) // 不带父
	const upgraded = store.get(CHILD)
	assert.equal(upgraded.source, 'claim')
	assert.equal(upgraded.owner, 'dsh-vision-delegate')
	assert.equal(upgraded.parentSessionId, PARENT, '没显式给父时，不把已观察到的边抹掉')
	const onDisk = readClaims(file)[CHILD]
	assert.equal(onDisk.source, 'claim')
	assert.equal(onDisk.owner, 'dsh-vision-delegate')
	assert.equal(onDisk.parentSessionId, PARENT)
})

await check('防御：自引用 / 环 / 父或子 id 不安全 一律不落盘（写盘之前就判掉）', async () => {
	const file = claimsFile('defenses')
	const warnings = []
	const { store } = openStoreWithCounter(file)
	const promoter = createRuntimeEdgePromoter({
		store,
		logger: { warn: (...args) => warnings.push(args.join(' ')) },
		// 直接用"注入的观察结果"：`collectRuntimeEdges` 自己就会丢掉自引用，
		// 这里要验证的是**提升阶段**也防得住（换 collect 实现 / 内核形状变化时）。
		collect: () => [
			{ id: CHILD, parentId: CHILD }, // 自引用
			{ id: 'a-cycle', parentId: 'c-cycle' }, // a→c→b→a
			{ id: 'b-cycle', parentId: 'a-cycle' },
			{ id: 'c-cycle', parentId: 'b-cycle' },
			{ id: GRAND, parentId: '../evil' }, // 父 id 不安全
			{ id: 'x/../y', parentId: PARENT }, // 子 id 不安全
			{ id: LONE, parentId: PARENT }, // 合法
		],
	})
	const report = await promoter.promote(makeCtx().ctx)
	assert.equal(report.ok, true)
	assert.deepEqual(report.promoted, ['b-cycle', 'c-cycle', LONE])
	assert.deepEqual(report.skipped.filter((entry) => entry.reason === 'self-reference').map((entry) => entry.id), [CHILD])
	assert.deepEqual(report.skipped.filter((entry) => entry.reason === 'unsafe-id').map((entry) => entry.id), [GRAND, 'x/../y'])
	// 环：确定性断开 id 最小的那条父边（与 buildSessionTree 同一规则）。
	assert.deepEqual(report.skipped.filter((entry) => entry.reason === 'cycle-broken').map((entry) => entry.id), ['a-cycle'])
	assert.equal(warnings.filter((line) => line.includes('环')).length, 1, '破环要留可诊断的告警')
	const onDisk = readClaims(file)
	assert.deepEqual(Object.keys(onDisk).sort(), ['b-cycle', 'c-cycle', LONE].sort())
	assert.equal(onDisk['a-cycle'], undefined, '环里 id 最小的那条父边不落盘')
	assert.equal(onDisk[GRAND], undefined)
	assert.equal(onDisk['x/../y'], undefined)
	assert.equal(onDisk['b-cycle'].parentSessionId, 'a-cycle')
	assert.equal(onDisk['c-cycle'].parentSessionId, 'b-cycle')
	// 破环之后写进账本的图一定是森林：buildSessionTree 不会再报环。
	const tree = buildSessionTree({
		rows: ['a-cycle', 'b-cycle', 'c-cycle', LONE, PARENT].map((id) => row(id)),
		claims: Object.entries(onDisk).map(([id, entry]) => ({ id, ...entry })),
	})
	assert.equal(tree.stats.cycleBroken, 0)
	assert.equal(tree.byId.get('b-cycle').parentId, 'a-cycle')
})

await check('提升失败（账本读不了/写不进）只告警、不抛：返回 ok:false', async () => {
	const warnings = []
	const broken = { ready: Promise.reject(new Error('claims unreadable')), get: () => undefined, setMany: async () => false }
	const report = await promoteRuntimeEdges(makeCtx().ctx, broken, { logger: { warn: (...args) => warnings.push(args.join(' ')) } })
	assert.equal(report.ok, false)
	assert.deepEqual(report.promoted, [])
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /提升运行时父子边失败/)
})

// ── 2. 调用点：apply() 启动一次 + 每次 inventory 增量一次 ──────────────────────
console.log('\n=== B. 调用点（apply 启动 / inventory）与端到端行为 ===')

await check('apply() 启动时提升一次：不阻塞、不抛，边照样落盘', async () => {
	rmSync(CLAIMS_FILE, { force: true })
	const { ctx, warnings } = makeCtx({ headers: [[PARENT], [CHILD, PARENT], [LONE]] })
	let threw
	try {
		apply(ctx)
	} catch (error) {
		threw = error
	}
	assert.equal(threw, undefined, String(threw))
	const claims = await waitFor(() => {
		const entries = readClaims(CLAIMS_FILE)
		return entries[CHILD]?.source === 'observed' ? entries : false
	})
	assert.equal(claims[CHILD].parentSessionId, PARENT)
	assert.equal(claims[LONE], undefined, '历史遗留会话（没有 parentSession）不追认')
	assert.deepEqual(warnings, [], '正常路径不该告警')
})

await check('apply() 在 ctx.sessions.list() 抛错时不崩：只缺少这次观察，服务与端点照常', async () => {
	const { ctx, warnings, provided } = makeCtx({ listThrows: true })
	let threw
	try {
		apply(ctx)
	} catch (error) {
		threw = error
	}
	assert.equal(threw, undefined, String(threw))
	assert.equal(typeof provided.sessionRemoval?.claim, 'function', 'sessionRemoval 服务照常发布')
	await new Promise((resolve) => setTimeout(resolve, 30)) // 等启动提升那一路走完（不该有未处理的 rejection）
	assert.equal(warnings.length, 0, '快照读不到是能力缺失，不是错误（不刷告警）')
	await provided.sessionRemoval.claim('probe-owner', [CHILD]).then(
		(result) => assert.deepEqual(result.claimed, [CHILD]),
		(error) => assert.fail(`服务不该因为会话快照读不到而失败：${String(error)}`),
	)
})

await check('每次 inventory 顺手增量提升：返回值仍走"登记 > 运行时"，账本同时被补上', async () => {
	rmSync(CLAIMS_FILE, { force: true })
	const childDir = seedSession(CHILD)
	const parentDir = seedSession(PARENT)
	const loneDir = seedSession(LONE)
	try {
		const { ctx } = makeCtx({ headers: [[PARENT], [CHILD, PARENT], [LONE]] })
		const handler = createRpcHandler(ctx, Promise.resolve(fakeClosedStore), openClaimsStore({ file: CLAIMS_FILE }))
		const result = await handler('inventory', {})
		assert.equal(result.ok, true)
		const child = result.value.sessions.find((session) => session.id === CHILD)
		assert.equal(child.parentId, PARENT, 'inventory 的父子关系来自运行时（本次就看得见）')
		assert.equal(child.kind, 'subagent')
		const lone = result.value.sessions.find((session) => session.id === LONE)
		assert.equal(lone.parentId, null, '没有父指针的历史会话不缩进、也不推断')
		assert.equal(lone.orphan, false)
		// 账本被补上了：下一个"冷启动"只读账本也挂得住。
		const claims = readClaims(CLAIMS_FILE)
		assert.equal(claims[CHILD].source, 'observed')
		const revived = openClaimsStore({ file: CLAIMS_FILE })
		await revived.ready
		const tree = buildSessionTree({ rows: result.value.sessions, claims: revived.entries() })
		assert.equal(tree.byId.get(CHILD).parentId, PARENT)
	} finally {
		rmSync(childDir, { recursive: true, force: true })
		rmSync(parentDir, { recursive: true, force: true })
		rmSync(loneDir, { recursive: true, force: true })
	}
})

await check('冷启动（重启后会话不在运行时列表里）：父子关系靠账本，仍然缩进', async () => {
	const coldDir = seedSession(CHILD)
	const coldParent = seedSession(PARENT)
	const coldLone = seedSession(LONE)
	try {
		// 会话头里**没有**任何 parentSession（模拟"重启后这些会话读不到了"），只有账本。
		const { ctx } = makeCtx({ headers: [[PARENT], [CHILD], [LONE]] })
		const handler = createRpcHandler(ctx, Promise.resolve(fakeClosedStore), openClaimsStore({ file: CLAIMS_FILE }))
		const result = await handler('inventory', {})
		assert.equal(result.ok, true)
		const child = result.value.sessions.find((session) => session.id === CHILD)
		assert.equal(child.parentId, PARENT, '账本里的观察边让父关系跨重启存活')
		assert.equal(child.kind, 'subagent')
		const lone = result.value.sessions.find((session) => session.id === LONE)
		assert.equal(lone.parentId, null)
		assert.equal(lone.orphan, false)
	} finally {
		rmSync(coldDir, { recursive: true, force: true })
		rmSync(coldParent, { recursive: true, force: true })
		rmSync(coldLone, { recursive: true, force: true })
	}
})

await check('inventory 里"登记优先"不变：登记父 ≠ 运行时父 → 返回登记父，观察边被拒且账本不动', async () => {
	const file = claimsFile('inventory-priority')
	rmSync(file, { force: true })
	const childDir = seedSession(CHILD)
	const parentDir = seedSession(PARENT)
	try {
		await openClaimsStore({ file }).setMany([{ id: CHILD, owner: 'producer', parentSessionId: PARENT, source: 'claim', claimedAt: 1 }])
		// 运行时现在说它的父是别的会话（账本里的登记更权威）。
		const { ctx } = makeCtx({ headers: [[PARENT], [CHILD, OTHER_PARENT]] })
		const handler = createRpcHandler(ctx, Promise.resolve(fakeClosedStore), openClaimsStore({ file }))
		const result = await handler('inventory', {})
		assert.equal(result.ok, true)
		assert.equal(result.value.sessions.find((session) => session.id === CHILD).parentId, PARENT)
		const onDisk = readClaims(file)[CHILD]
		assert.equal(onDisk.owner, 'producer')
		assert.equal(onDisk.parentSessionId, PARENT)
		assert.equal(onDisk.source, 'claim')
	} finally {
		rmSync(childDir, { recursive: true, force: true })
		rmSync(parentDir, { recursive: true, force: true })
	}
})

await check('提升写盘失败时 inventory 照样成功（只告警，绝不把清点拖垮）', async () => {
	const failingStore = {
		ready: Promise.resolve(),
		entries: () => [],
		get: () => undefined,
		setMany: async () => {
			throw new Error('disk full')
		},
	}
	const dir = seedSession(CHILD)
	const parentDir = seedSession(PARENT)
	try {
		const { ctx, warnings } = makeCtx({ headers: [[CHILD, PARENT]] })
		const promoter = createRuntimeEdgePromoter({ store: failingStore, logger: ctx.logger })
		const handler = createRpcHandler(ctx, Promise.resolve(fakeClosedStore), failingStore, promoter)
		const result = await handler('inventory', {})
		assert.equal(result.ok, true, '提升失败不能影响清点')
		assert.equal(result.value.sessions.find((session) => session.id === CHILD).parentId, PARENT, '本次仍然看得见运行时那条边')
		assert.equal(warnings.filter((line) => line.includes('提升')).length >= 1, true, '失败要留下可诊断的告警')
	} finally {
		rmSync(dir, { recursive: true, force: true })
		rmSync(parentDir, { recursive: true, force: true })
	}
})

await check('sessionRemoval.claim() 不把纯观察条目当成"别人登记过"：直接升级成登记条目', async () => {
	rmSync(CLAIMS_FILE, { force: true })
	const dir = seedSession(CHILD)
	try {
		const { ctx, provided } = makeCtx({ headers: [[CHILD, PARENT]] })
		apply(ctx)
		await waitFor(() => readClaims(CLAIMS_FILE)[CHILD]?.source === 'observed')
		const service = provided.sessionRemoval
		const result = await service.claim('dsh-vision-delegate', [CHILD])
		assert.deepEqual(result.claimed, [CHILD])
		assert.deepEqual(result.rejected, [])
		const entry = service.entries().find((item) => item.id === CHILD)
		assert.equal(entry.source, 'claim')
		assert.equal(entry.owner, 'dsh-vision-delegate')
		assert.equal(entry.parentSessionId, PARENT, '升级时保留已观察到的父指针')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}  (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
