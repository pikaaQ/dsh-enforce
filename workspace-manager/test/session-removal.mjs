// dsh-workspace-manager — 「会话清理」宿主服务离线测试
//
// 覆盖 `ctx.provide('sessionRemoval', …)` 发布的服务的**行为与栅栏**：
//   服务面（claim/release/claimsOf/remove）、活跃拒绝、白名单（只能删自己登记的）、
//   与 RPC 端点同源（同一个删除实现、同样摘归档条目与工作区记账）、以及优雅降级。
// 另外覆盖 v2 的**父会话指针**：`claim(owner, ids, { parentSessionId })` 要落盘、
// 跨重启读得回来、不带父的重复 claim 不抹掉已知父、旧/损坏格式能容忍。
//
// 全程写到临时 DSH_HOME，绝不触碰真实状态文件与真实会话。
//
// 运行：node test/session-removal.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, 'tmp-session-removal')

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
process.env.DSH_HOME = TMP // apply() 与删除实现都只认这个 home

const { apply } = await import('../src/host/index.js')
const { SESSION_REMOVAL_SERVICE_VERSION } = await import('../src/host/session-removal.js')

// ── 夹具：四类痕迹各一份（含内容寻址附件 —— 任何删除都不得碰它）─────────────
function seed(relative, content) {
	const file = join(TMP, relative)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, content)
	return file
}
function fixture(ids) {
	const spec = {
		's-tmp1': { project: '--E-work-alpha--', bytes: 60 },
		's-tmp2': { project: '--E-orphan--', bytes: 30 },
		's-arch': { project: '--E-orphan--', bytes: 20 },
		's-a2': { project: '--E-work-alpha--', bytes: 12 },
	}
	for (const id of ids) {
		const { project, bytes } = spec[id]
		seed(`sessions/${project}/${id}/session.jsonl.zstd`, 'x'.repeat(bytes))
	}
	seed('storages/session_projcache/sessions/s-tmp1.json', '{}')
	seed('storages/session_projcache/sessions/s-arch.json', '{}')
	seed('attachments/v1/objects/ab/cdef', 'shared')
}
fixture(['s-tmp1', 's-tmp2', 's-arch', 's-a2'])

// ── 假 registry：实现本插件依赖的方法面 ─────────────────────────────────────
function makeRegistry(options = {}) {
	let state = { initialized: true, workspaceIds: ['ws-a'], archivedSessionIds: [...(options.archived ?? [])] }
	const workspaces = options.workspaces ?? [{ id: 'ws-a', title: 'alpha', path: 'E:/work/alpha', sessionIds: ['s-a2'] }]
	return {
		get archivedSessionIds() {
			return [...state.archivedSessionIds]
		},
		list: () => workspaces.map((workspace) => ({ ...workspace, detachSession: async () => {} })),
		enqueueOperation: (operation) => operation(),
		requireState: () => state,
		setState: async (next) => {
			state = next
		},
		debugState: () => state,
	}
}

/** 假 ctx：`provide` 捕获发布的服务；`active` 里的 id 被当成活跃会话（两种服务都命中）。 */
function makeCtx({ registry = makeRegistry(), active = [], withProvide = true } = {}) {
	const provided = {}
	const warnings = []
	const ctx = {
		logger: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
		workspaceRegistry: registry,
		agents: { get: (id) => (active.includes(id) ? {} : undefined) },
		sessions: { get: (id) => (active.includes(id) ? {} : undefined) },
		connection: { rpc: { handle: () => () => {} } },
		effect(fn) {
			fn()
			return () => {}
		},
	}
	if (withProvide) {
		ctx.provide = (name, value) => {
			provided[name] = value
			return () => {
				delete provided[name]
			}
		}
	}
	return { ctx, provided, warnings }
}

const ALPHA = 'app-owner' // 调用方自报的 owner（= 插件名，见 README 的依赖说明）

// ── 1. 发布契约与优雅降级 ───────────────────────────────────────────────────
{
	const { ctx, provided } = makeCtx()
	apply(ctx)
	await check('apply() 用 ctx.provide 发布了 sessionRemoval 服务', () => {
		assert.ok(provided.sessionRemoval, '缺 sessionRemoval 服务')
		const service = provided.sessionRemoval
		for (const method of ['claim', 'release', 'claimsOf', 'remove']) {
			assert.equal(typeof service[method], 'function', `服务缺方法 ${method}`)
		}
		assert.equal(service.version, SESSION_REMOVAL_SERVICE_VERSION)
	})
	await check('服务与 RPC 端点共存（端点仍然注册、返回同样的错误信封）', () => {
		assert.equal(typeof ctx.connection.rpc.handle, 'function')
	})
}

{
	const { ctx, provided, warnings } = makeCtx({ withProvide: false })
	let threw
	try {
		apply(ctx)
	} catch (error) {
		threw = error
	}
	await check('ctx.provide 不可用时优雅降级：不抛错、只告警一次、端点照常', () => {
		assert.equal(threw, undefined, String(threw))
		assert.deepEqual(Object.keys(provided), [])
		assert.equal(warnings.filter((line) => line.includes('sessionRemoval')).length, 1)
	})
}

{
	// 服务名被别人占了：cordis 的 provide 会抛 "service has been registered"。
	// apply 必须只告警 —— 本插件自己的端点/设置页不能因为发布失败而失效。
	const registry = makeRegistry()
	const warnings = []
	const ctx = {
		logger: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
		workspaceRegistry: registry,
		agents: { get: () => undefined },
		sessions: { get: () => undefined },
		connection: { rpc: { handle: () => () => {} } },
		effect(fn) {
			fn()
			return () => {}
		},
		provide() {
			throw new Error(`service "sessionRemoval" has been registered at <someone-else>`)
		},
	}
	let threw
	try {
		apply(ctx)
	} catch (error) {
		threw = error
	}
	await check('服务名被占用时只告警，不抛（本插件功能不受影响）', () => {
		assert.equal(threw, undefined, String(threw))
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /sessionRemoval/)
	})
}

// ── 2. 服务行为（真实的 apply 接线，不做任何打桩）────────────────────────────
const { ctx: mainCtx, provided: mainServices } = makeCtx({ registry: makeRegistry({ archived: ['s-arch'] }) })
apply(mainCtx)
const service = mainServices.sessionRemoval

await check('remove 未登记的 id → not-claimed，且磁盘一个字节都不动', async () => {
	await assert.rejects(() => service.remove('s-tmp1', { owner: ALPHA }), (error) => error.code === 'not-claimed')
	assert.equal(existsSync(join(TMP, 'sessions', '--E-work-alpha--', 's-tmp1')), true)
	assert.equal(existsSync(join(TMP, 'storages', 'session_projcache', 'sessions', 's-tmp1.json')), true)
})

await check('owner 缺失 / 空 / 非字符串 → bad-request（没有 owner 就没有白名单）', async () => {
	for (const options of [undefined, {}, { owner: '' }, { owner: '  ' }, { owner: 42 }]) {
		await assert.rejects(
			() => service.remove('s-tmp1', options),
			(error) => error.code === 'bad-request',
			`${JSON.stringify(options)} 应被拒绝`,
		)
	}
	assert.equal(existsSync(join(TMP, 'sessions', '--E-work-alpha--', 's-tmp1')), true)
})

await check('claim 把 id 记到 owner 名下；重复 claim 幂等', async () => {
	const first = await service.claim(ALPHA, ['s-tmp1', 's-tmp2'])
	assert.deepEqual(first.claimed, ['s-tmp1', 's-tmp2'])
	assert.deepEqual(first.alreadyClaimed, [])
	assert.deepEqual(first.rejected, [])
	const second = await service.claim(ALPHA, ['s-tmp1'])
	assert.deepEqual(second.claimed, [])
	assert.deepEqual(second.alreadyClaimed, ['s-tmp1'])
	assert.deepEqual(service.claimsOf(ALPHA).sort(), ['s-tmp1', 's-tmp2'])
})

await check('claim 拒绝不安全的 id，并把它们原样报回来（不静默丢弃）', async () => {
	const result = await service.claim(ALPHA, ['../evil', 'a/b', '', 's-ok'])
	assert.deepEqual(result.rejected, [
		{ id: '../evil', reason: 'unsafe-id' },
		{ id: 'a/b', reason: 'unsafe-id' },
	])
	assert.deepEqual(result.claimed, ['s-ok'])
	await service.release(ALPHA, ['s-ok'])
})

await check('claim 不抢占别人名下的 id（跨插件白名单的核心）', async () => {
	const stolen = await service.claim('other-plugin', ['s-tmp1'])
	assert.deepEqual(stolen.claimed, [])
	assert.deepEqual(stolen.rejected, [{ id: 's-tmp1', reason: 'claimed-by-other', owner: ALPHA }])
})

await check('remove 别人的 id → not-claimed，磁盘不动', async () => {
	await assert.rejects(() => service.remove('s-tmp1', { owner: 'other-plugin' }), (error) => error.code === 'not-claimed')
	assert.equal(existsSync(join(TMP, 'sessions', '--E-work-alpha--', 's-tmp1')), true)
})

await check('不安全的 id → bad-request（含穿越尝试），且不碰任何文件', async () => {
	for (const bad of ['../evil', 'a/b', 's-tmp1/../s-tmp2', 'a b', '.', '']) {
		await assert.rejects(
			() => service.remove(bad, { owner: ALPHA }),
			(error) => error.code === 'bad-request',
			`${JSON.stringify(bad)} 应被拒绝`,
		)
	}
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan--', 's-tmp2')), true)
})

await check('remove 删掉工件 + 投影缓存 + 收掉空的项目目录（与端点同一实现）', async () => {
	const report = await service.remove('s-tmp1', { owner: ALPHA })
	assert.equal(report.sessionId, 's-tmp1')
	assert.equal(report.bytes, 62, '工件 60 B + 投影缓存 2 B')
	assert.deepEqual(report.removed.map((entry) => entry.kind).sort(), ['artifact', 'projection-cache'])
	assert.equal(existsSync(join(TMP, 'sessions', '--E-work-alpha--', 's-tmp1')), false)
	assert.equal(existsSync(join(TMP, 'storages', 'session_projcache', 'sessions', 's-tmp1.json')), false)
	assert.equal(existsSync(join(TMP, 'attachments', 'v1', 'objects', 'ab', 'cdef')), true, 'attachments 绝不能碰')
})

await check('删成功后登记被释放（服务不替调用方记账、也不留残影）', () => {
	assert.deepEqual(service.claimsOf(ALPHA), ['s-tmp2'])
})

await check('活跃会话（sessions.get 命中）→ session-active，工件原封不动', async () => {
	const { ctx, provided } = makeCtx({ active: ['s-tmp2'] })
	apply(ctx)
	const live = provided.sessionRemoval
	await live.claim(ALPHA, ['s-tmp2'])
	await assert.rejects(() => live.remove('s-tmp2', { owner: ALPHA }), (error) => error.code === 'session-active')
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan--', 's-tmp2')), true)
	assert.deepEqual(live.claimsOf(ALPHA), ['s-tmp2'], '被拒后登记保留（调用方可下次再试）')
})

await check('活跃会话（agents.get 命中）同样拒绝', async () => {
	const { ctx, provided } = makeCtx({ active: ['s-tmp2'] })
	ctx.sessions = { get: () => undefined } // 只有 agents 认得出它
	apply(ctx)
	const live = provided.sessionRemoval
	await live.claim(ALPHA, ['s-tmp2'])
	await assert.rejects(() => live.remove('s-tmp2', { owner: ALPHA }), (error) => error.code === 'session-active')
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan--', 's-tmp2')), true)
})

await check('工件早就不在 → session-not-found，且登记被释放（调用方按"已清理"处理）', async () => {
	const { ctx, provided } = makeCtx()
	apply(ctx)
	const fresh = provided.sessionRemoval
	await fresh.claim(ALPHA, ['s-gone'])
	await assert.rejects(() => fresh.remove('s-gone', { owner: ALPHA }), (error) => error.code === 'session-not-found')
	// 登记表是**共享的**（同一个 DSH_HOME 下所有实例读同一个文件），所以这里只断言 s-gone 没留下。
	assert.equal(fresh.claimsOf(ALPHA).includes('s-gone'), false, '不存在的会话没有留登记的必要')
})

await check('release 撤销自己的登记；撤不了别人的登记', async () => {
	const { ctx, provided } = makeCtx()
	apply(ctx)
	const own = provided.sessionRemoval
	await own.claim('plugin-a', ['s-x'])
	await own.claim('plugin-b', ['s-y'])
	assert.deepEqual(await own.release('plugin-a', ['s-x', 's-y']), { owner: 'plugin-a', released: ['s-x'], notClaimed: ['s-y'] })
	assert.deepEqual(own.claimsOf('plugin-a'), [])
	assert.deepEqual(own.claimsOf('plugin-b'), ['s-y'])
})

await check('归档中的会话：删文件的同时把它从内核归档集合里摘掉', async () => {
	const registry = makeRegistry({ archived: ['s-arch'] })
	const { ctx, provided } = makeCtx({ registry })
	apply(ctx)
	const svc = provided.sessionRemoval
	await svc.claim(ALPHA, ['s-arch'])
	const report = await svc.remove('s-arch', { owner: ALPHA })
	assert.equal(report.archiveCleared, true)
	assert.deepEqual(registry.debugState().archivedSessionIds, [])
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan--', 's-arch')), false)
})

await check('工作区记账也会被摘掉（否则设置页留下"注册表认得、磁盘上没有"的幽灵行）', async () => {
	const registry = makeRegistry({ workspaces: [{ id: 'ws-a', title: 'alpha', path: 'E:/work/alpha', sessionIds: ['s-a2'] }] })
	const { ctx, provided } = makeCtx({ registry })
	apply(ctx)
	const svc = provided.sessionRemoval
	await svc.claim(ALPHA, ['s-a2'])
	const report = await svc.remove('s-a2', { owner: ALPHA })
	assert.deepEqual(report.detachedFrom, ['ws-a'])
	assert.equal(report.filesMissing, false)
	assert.equal(existsSync(join(TMP, 'sessions', '--E-work-alpha--', 's-a2')), false)
})

// ── 3. 父会话指针与登记持久化（会话树 / 级联删除的数据源）────────────────────
const CLAIMS_FILE = join(TMP, 'dsh-workspace-manager.claims.json')
const CHILD = '11111111-2222-4333-8444-555555555555' // 子会话 id 是**裸 UUID**
/** 重新 apply：等价于"进程重启后插件又装了一次"，登记表实例是新的（只能从磁盘读回）。 */
async function relaunch() {
	const { ctx, provided } = makeCtx()
	apply(ctx)
	const revived = provided.sessionRemoval
	await revived.ready
	return revived
}

await check('claim 带 parentSessionId：父指针**落盘**（跨重启读回的唯一依据）', async () => {
	rmSync(CLAIMS_FILE, { force: true })
	const svc = await relaunch()
	const result = await svc.claim(ALPHA, [CHILD], { parentSessionId: 'session-parent-1' })
	assert.deepEqual(result.claimed, [CHILD])
	assert.equal(result.parentSessionId, 'session-parent-1')
	const onDisk = JSON.parse(readFileSync(CLAIMS_FILE, 'utf8'))
	assert.equal(onDisk.claims[CHILD].owner, ALPHA)
	assert.equal(onDisk.claims[CHILD].parentSessionId, 'session-parent-1')
	assert.equal(typeof onDisk.claims[CHILD].claimedAt, 'number')
})

await check('重启后父指针仍在（新实例从磁盘读回，不是靠内存）', async () => {
	const revived = await relaunch()
	const entries = revived.entries()
	assert.equal(entries.length, 1)
	assert.equal(entries[0].id, CHILD)
	assert.equal(entries[0].owner, ALPHA)
	assert.equal(entries[0].parentSessionId, 'session-parent-1')
	assert.deepEqual(revived.claimsOf(ALPHA), [CHILD])
})

await check('不带父的重复 claim 不会抹掉已知父指针（启动补删路径正是这么重登记的）', async () => {
	const revived = await relaunch()
	const again = await revived.claim(ALPHA, [CHILD])
	assert.deepEqual(again.alreadyClaimed, [CHILD])
	assert.deepEqual(again.parentUpdated, [])
	assert.equal(revived.entries()[0].parentSessionId, 'session-parent-1')
})

await check('同一个 owner 显式换父 → parentUpdated 并落盘', async () => {
	const revived = await relaunch()
	const updated = await revived.claim(ALPHA, [CHILD], { parentSessionId: 'session-parent-2' })
	assert.deepEqual(updated.parentUpdated, [CHILD])
	assert.equal(JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')).claims[CHILD].parentSessionId, 'session-parent-2')
})

await check('自引用父指针被拒（reason=self-parent），不落盘', async () => {
	const revived = await relaunch()
	const self = await revived.claim(ALPHA, ['session-self'], { parentSessionId: 'session-self' })
	assert.deepEqual(self.rejected, [{ id: 'session-self', reason: 'self-parent' }])
	assert.deepEqual(self.claimed, [])
	assert.deepEqual(revived.claimsOf(ALPHA), [CHILD], '不该多出 session-self')
})

await check('父指针形态不安全 / 非字符串 → bad-request（不静默丢弃）', async () => {
	const revived = await relaunch()
	for (const bad of ['../evil', 'a/b', '..']) {
		await assert.rejects(
			() => revived.claim(ALPHA, ['s-p1'], { parentSessionId: bad }),
			(error) => error.code === 'bad-request',
			`${JSON.stringify(bad)} 应被拒绝`,
		)
	}
	await assert.rejects(() => revived.claim(ALPHA, ['s-p1'], { parentSessionId: 42 }), (error) => error.code === 'bad-request')
	assert.deepEqual(revived.claimsOf(ALPHA), [CHILD], '被拒的 id 一个都不该进登记表')
})

await check('release 把登记从磁盘上抹掉（撤销不是"只改内存"）', async () => {
	const svc = await relaunch()
	await svc.claim('plugin-r', ['s-r1'], { parentSessionId: 'session-p' })
	assert.equal(JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')).claims['s-r1'].parentSessionId, 'session-p')
	await svc.release('plugin-r', ['s-r1'])
	assert.equal(JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')).claims['s-r1'], undefined)
})

await check('删除成功的会话，登记也从磁盘上清掉（账本不会一路长下去）', async () => {
	seed('sessions/--E-work-alpha--/s-persist/session.jsonl.zstd', 'x'.repeat(8))
	const svc = await relaunch()
	await svc.claim(ALPHA, ['s-persist'], { parentSessionId: 'session-parent-1' })
	await svc.remove('s-persist', { owner: ALPHA })
	assert.equal(JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')).claims['s-persist'], undefined)
})

await check('容忍旧格式：老登记没有父字段 → 父指针读成 null（不抛错、不丢登记）', async () => {
	writeFileSync(CLAIMS_FILE, JSON.stringify({ version: 1, claims: { 's-legacy': { owner: 'old-plugin' } } }))
	const legacy = await relaunch()
	assert.deepEqual(legacy.claimsOf('old-plugin'), ['s-legacy'])
	assert.equal(legacy.entries()[0].parentSessionId, null)
})

await check('容忍异形格式：claims 是数组、version 更高、字段多余', async () => {
	writeFileSync(CLAIMS_FILE, JSON.stringify({ claims: [{ id: 's-arr', owner: 'arr-plugin', parentSessionId: 'session-p' }] }))
	assert.equal((await relaunch()).entries()[0].parentSessionId, 'session-p')
	writeFileSync(CLAIMS_FILE, JSON.stringify({
		version: 99,
		claims: { 's-future': { owner: 'future', parentSessionId: 'session-p', somethingNew: true } },
	}))
	const future = await relaunch()
	assert.equal(future.entries()[0].id, 's-future')
	assert.equal(future.entries()[0].parentSessionId, 'session-p')
})

await check('登记表损坏 / 缺文件 → 空表且不抛错（绝不阻断启动）', async () => {
	writeFileSync(CLAIMS_FILE, '{ not json at all')
	assert.deepEqual((await relaunch()).entries(), [])
	rmSync(CLAIMS_FILE, { force: true })
	const fresh = await relaunch()
	assert.deepEqual(fresh.entries(), [])
	assert.deepEqual(fresh.claimsOf(ALPHA), [])
})

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}  (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
