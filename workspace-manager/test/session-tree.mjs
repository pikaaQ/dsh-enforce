// dsh-workspace-manager — 会话树离线测试
//
// 覆盖两件事：
//   A. `src/shared/session-tree.js` 的纯规则（宿主级联与设置页缩进树共用同一份实现）；
//   B. `src/host/session-tree.js` 的合成与防御：两个来源（持久化登记 > 运行时内存）、
//      孤儿 / 自引用 / 环 / 跨项目键 / 跨工作区，以及 `planCascade` 的"先子后父、同工作区才连带"。
//
// 明确不覆盖：**父日志兜底**（本版本故意不做——历史遗留的子会话不追认，见 README 的边界说明）。
// 全程不写任何文件（这份模块是纯函数 + 只读的 ctx 探测）。
//
// 运行：node test/session-tree.mjs

import assert from 'node:assert/strict'
import {
	childrenIndex,
	declaredParentId,
	hiddenByArchivedParentIds,
	isSameWorkspace,
	isSubagentSessionId,
	topLevelRows,
} from '../src/shared/session-tree.js'
import { buildSessionTree, collectRuntimeEdges, planCascade } from '../src/host/session-tree.js'
import { CLAIMS_VERSION, parseClaims } from '../src/host/claims-store.js'

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

/** 一行清点数据（只保留会话树需要的字段）。 */
const row = (id, workspaceId = 'ws-a', extra = {}) => ({ id, workspaceId, projectKey: extra.projectKey ?? '--E-tmp--', ...extra })

const CHILD = '11111111-2222-4333-8444-555555555555'
const GRAND = '22222222-3333-4444-8555-666666666666'
const OTHER = '33333333-4444-4555-8666-777777777777'

console.log('=== A. 共享纯规则（src/shared/session-tree.js）===')

await check('子会话 id 形态：裸 UUID 是子会话；session-<uuid> 不是', () => {
	assert.equal(isSubagentSessionId(CHILD), true)
	assert.equal(isSubagentSessionId(CHILD.toUpperCase()), true)
	assert.equal(isSubagentSessionId(`session-${CHILD}`), false)
	assert.equal(isSubagentSessionId('not-a-uuid'), false)
	assert.equal(isSubagentSessionId(undefined), false)
})

await check('isSameWorkspace：null（未分组）彼此算同一工作区', () => {
	assert.equal(isSameWorkspace({ workspaceId: null }, { workspaceId: null }), true)
	assert.equal(isSameWorkspace({ workspaceId: 'ws-a' }, { workspaceId: 'ws-a' }), true)
	assert.equal(isSameWorkspace({ workspaceId: 'ws-a' }, { workspaceId: null }), false)
})

await check('childrenIndex：父行在、同工作区才建边', () => {
	const rows = [row('session-p'), row(CHILD, 'ws-a', { parentId: 'session-p' }), row(OTHER, 'ws-b', { parentId: 'session-p' })]
	const index = childrenIndex(rows)
	assert.deepEqual(index.get('session-p').map((entry) => entry.id), [CHILD])
	assert.equal(index.size, 1, '跨工作区的那一行不建边')
})

await check('childrenIndex：父行不在（孤儿）与自引用都不建边', () => {
	const rows = [row(CHILD, 'ws-a', { parentId: 'session-missing' }), row('session-self', 'ws-a', { parentId: 'session-self' })]
	assert.equal(childrenIndex(rows).size, 0)
})

await check('declaredParentId：只认非空字符串', () => {
	assert.equal(declaredParentId({ parentId: 'session-p' }), 'session-p')
	assert.equal(declaredParentId({ parentId: '' }), null)
	assert.equal(declaredParentId({}), null)
	assert.equal(declaredParentId(null), null)
})

await check('topLevelRows：树根 = 没有可解析父的行（含孤儿与跨工作区子会话，不掉行）', () => {
	const rows = [
		row('session-p'),
		row(CHILD, 'ws-a', { parentId: 'session-p' }),
		row(OTHER, 'ws-a', { parentId: 'session-missing' }),
		row('session-plain'),
	]
	assert.deepEqual(topLevelRows(rows).map((entry) => entry.id), ['session-p', OTHER, 'session-plain'])
})

await check('hiddenByArchivedParentIds：父归档 → 子孙（含多级）随父隐藏；未归档则空', () => {
	const rows = [
		row('session-p'),
		row(CHILD, 'ws-a', { parentId: 'session-p' }),
		row(GRAND, 'ws-a', { parentId: CHILD }),
		row(OTHER, 'ws-b', { parentId: 'session-p' }),
	]
	assert.deepEqual(hiddenByArchivedParentIds(rows, []), [])
	assert.deepEqual(hiddenByArchivedParentIds(rows, ['session-p']), [CHILD, GRAND])
	assert.deepEqual(hiddenByArchivedParentIds(rows, [CHILD]), [GRAND])
	// 跨工作区的子会话不随父隐藏（与级联边界一致）。父是 ws-a 时 OTHER 属于 ws-b → 不隐藏
	assert.equal(hiddenByArchivedParentIds(rows, ['session-p']).includes(OTHER.id), false)
})

await check('登记表解析（会话树的数据源）容忍旧/异形/损坏内容', () => {
	// 旧格式：没有 source、没有父字段（v1 历史登记）→ 当作 'claim' + “父未知”，登记本身保留。
	assert.deepEqual(parseClaims('{"version":1,"claims":{"s-old":{"owner":"p"}}}'), {
		version: CLAIMS_VERSION,
		claims: [{ id: 's-old', owner: 'p', parentSessionId: null, source: 'claim' }],
	})
	// 数组形态 + 更高 version + 多余字段：认得的字段照读。
	assert.deepEqual(parseClaims('{"version":99,"claims":[{"id":"s-a","owner":"p","parentSessionId":"session-p","x":1}]}').claims, [
		{ id: 's-a', owner: 'p', parentSessionId: 'session-p', source: 'claim' },
	])
	// 不安全 id / 不安全或自引用的父 / 缺 owner：能读多少读多少，绝不抛。
	assert.deepEqual(parseClaims('{"claims":{"../evil":{"owner":"p"},"s-self":{"owner":"p","parentSessionId":"s-self"},"s-noowner":{}}}'), {
		version: CLAIMS_VERSION,
		claims: [{ id: 's-self', owner: 'p', parentSessionId: null, source: 'claim' }],
	})
	// 纯观察条目（source: 'observed'，没有 owner）读得回来；没有父边的观察条目丢弃；
	// 认不出的 source（例如更高版本写的新值）按缺省处理 = 'claim'。
	assert.deepEqual(parseClaims('{"version":2,"claims":{"c-1":{"parentSessionId":"session-p","source":"observed","observedAt":7},"c-2":{"source":"observed"},"c-3":{"owner":"p","source":"weird"}}}'), {
		version: CLAIMS_VERSION,
		claims: [
			{ id: 'c-1', parentSessionId: 'session-p', source: 'observed', observedAt: 7 },
			{ id: 'c-3', owner: 'p', parentSessionId: null, source: 'claim' },
		],
	})
	assert.deepEqual(parseClaims('{ not json'), { version: CLAIMS_VERSION, claims: [] })
	assert.deepEqual(parseClaims('[1,2]'), { version: CLAIMS_VERSION, claims: [] })
})

console.log('\n=== B. 宿主侧合成与防御（src/host/session-tree.js）===')
await check('登记边合成父子图：parentId/kind/depth/childIds', () => {
	const rows = [row('session-p'), row(CHILD, 'ws-a', { parentId: undefined }), row(GRAND, 'ws-a')]
	const tree = buildSessionTree({
		rows,
		claims: [
			{ id: CHILD, owner: 'p', parentSessionId: 'session-p' },
			{ id: GRAND, owner: 'p', parentSessionId: CHILD },
		],
	})
	const parent = tree.byId.get('session-p')
	const child = tree.byId.get(CHILD)
	const grand = tree.byId.get(GRAND)
	assert.equal(child.parentId, 'session-p')
	assert.equal(child.kind, 'subagent')
	assert.equal(child.depth, 1)
	assert.equal(grand.parentId, CHILD)
	assert.equal(grand.depth, 2)
	assert.deepEqual(parent.childIds, [CHILD])
	assert.deepEqual(tree.childrenOf('session-p').map((node) => node.id), [CHILD])
	assert.deepEqual(tree.descendantsOf('session-p').map((node) => node.id), [CHILD, GRAND])
	assert.equal(parent.parentId, null)
	assert.equal(parent.kind, 'session', 'session-<uuid> 且无父指针 → 普通会话')
	assert.equal(tree.roots().length, 1)
	assert.deepEqual(tree.stats, { rows: 3, subagents: 2, linked: 2, runtimeLinks: 0, orphans: 0, cycleBroken: 0 })
})

await check('裸 UUID 即使没有父指针也算子会话（历史遗留：父未知，但不掉行、不报错）', () => {
	const tree = buildSessionTree({ rows: [row(CHILD)], claims: [] })
	const node = tree.byId.get(CHILD)
	assert.equal(node.kind, 'subagent')
	assert.equal(node.parentId, null)
	assert.equal(node.orphan, false, '没有父指针 ≠ 孤儿：本插件不推断')
	assert.deepEqual(node.childIds, [])
})

await check('孤儿（声明了父但父行不在清点里）：父指针解析为 null、orphan=true、declaredParentId 保留', () => {
	const tree = buildSessionTree({ rows: [row(CHILD)], claims: [{ id: CHILD, owner: 'p', parentSessionId: 'session-gone' }] })
	const node = tree.byId.get(CHILD)
	assert.equal(node.parentId, null)
	assert.equal(node.orphan, true)
	assert.equal(node.declaredParentId, 'session-gone')
	assert.deepEqual(node.flags, ['orphan'])
	assert.equal(tree.stats.orphans, 1)
	// 孤儿不属于任何子树：别人的级联不会波及它。
	const parentTree = buildSessionTree({ rows: [row('session-p'), row(CHILD)], claims: [{ id: CHILD, owner: 'p', parentSessionId: 'session-gone' }] })
	assert.deepEqual(planCascade(parentTree, 'session-p').deleteOrder, [])
})

await check('跨项目键：子会话的工件落在别的项目键下，照样建树（清点行里有它就够）', () => {
	const rows = [
		row('session-p', 'ws-a', { projectKey: '--E-alpha--' }),
		row(CHILD, 'ws-a', { projectKey: '--E-other--' }),
	]
	const tree = buildSessionTree({ rows, claims: [{ id: CHILD, owner: 'p', parentSessionId: 'session-p' }] })
	assert.equal(tree.byId.get(CHILD).parentId, 'session-p')
	assert.deepEqual(planCascade(tree, 'session-p').deleteOrder, [CHILD])
})

await check('自引用防御：claim 指向自己 → 不建边并记 self-reference', () => {
	const tree = buildSessionTree({ rows: [row('session-a')], claims: [{ id: 'session-a', owner: 'p', parentSessionId: 'session-a' }] })
	const node = tree.byId.get('session-a')
	assert.equal(node.parentId, null)
	assert.deepEqual(node.flags, ['self-reference'])
	assert.deepEqual(tree.childrenOf('session-a'), [])
})

await check('环防御：甲→乙→丙→甲 被确定性断开（id 最小的那条父边），遍历一定终止', () => {
	const rows = [row('session-a'), row('session-b'), row('session-c')]
	const warnings = []
	const tree = buildSessionTree({
		rows,
		claims: [
			{ id: 'session-a', owner: 'p', parentSessionId: 'session-c' },
			{ id: 'session-b', owner: 'p', parentSessionId: 'session-a' },
			{ id: 'session-c', owner: 'p', parentSessionId: 'session-b' },
		],
		logger: { warn: (...args) => warnings.push(args.join(' ')) },
	})
	// id 字典序最小的是 session-a → 断开它指向 session-c 的父边。
	assert.equal(tree.byId.get('session-a').parentId, null)
	assert.deepEqual(tree.byId.get('session-a').flags, ['cycle-broken'])
	assert.equal(tree.byId.get('session-b').parentId, 'session-a')
	assert.equal(tree.byId.get('session-c').parentId, 'session-b')
	assert.equal(tree.stats.cycleBroken, 1)
	assert.equal(warnings.filter((line) => line.includes('环')).length, 1, '破环要留可诊断的告警')
	const descendants = tree.descendantsOf('session-a').map((node) => node.id)
	assert.deepEqual(descendants, ['session-b', 'session-c'])
	assert.deepEqual(planCascade(tree, 'session-a').deleteOrder, ['session-c', 'session-b'])
})

await check('两个来源：登记优先于运行时；运行时只补登记没覆盖的边', () => {
	const rows = [row('session-p'), row('session-q'), row(CHILD), row(GRAND)]
	const tree = buildSessionTree({
		rows,
		claims: [{ id: CHILD, owner: 'p', parentSessionId: 'session-p' }],
		runtime: [
			{ id: CHILD, parentId: 'session-q', source: 'runtime' }, // 登记赢
			{ id: GRAND, parentId: 'session-q', source: 'runtime' }, // 登记没有 → 用运行时
		],
	})
	assert.equal(tree.byId.get(CHILD).parentId, 'session-p')
	assert.equal(tree.byId.get(CHILD).parentSource, 'claim')
	assert.equal(tree.byId.get(GRAND).parentId, 'session-q')
	assert.equal(tree.byId.get(GRAND).parentSource, 'runtime')
	assert.equal(tree.stats.runtimeLinks, 1)
})

await check('登记/运行时里提到、但磁盘上没有的 id 不进树（不让幽灵行挂到父下面）', () => {
	const tree = buildSessionTree({
		rows: [row('session-p')],
		claims: [{ id: CHILD, owner: 'p', parentSessionId: 'session-p' }],
		runtime: [{ id: OTHER, parentId: 'session-p', source: 'runtime' }],
	})
	assert.equal(tree.byId.has(CHILD), false)
	assert.deepEqual(tree.byId.get('session-p').childIds, [])
	assert.equal(tree.stats.rows, 1)
})

await check('planCascade：先子后父（深度大的先删），父不入选', () => {
	const rows = [row('session-p'), row(CHILD), row(GRAND)]
	const tree = buildSessionTree({
		rows,
		claims: [
			{ id: CHILD, owner: 'p', parentSessionId: 'session-p' },
			{ id: GRAND, owner: 'p', parentSessionId: CHILD },
		],
	})
	const plan = planCascade(tree, 'session-p')
	assert.deepEqual(plan.deleteOrder, [GRAND, CHILD])
	assert.equal(plan.deleteOrder.includes('session-p'), false)
	assert.deepEqual(plan.descendantIds, [CHILD, GRAND])
	assert.deepEqual(plan.skipped, [])
})

await check('planCascade：跨工作区的子孙不连带，逐个进 skipped', () => {
	const rows = [row('session-p', 'ws-a'), row(CHILD, 'ws-a'), row(OTHER, 'ws-b')]
	const tree = buildSessionTree({
		rows,
		claims: [
			{ id: CHILD, owner: 'p', parentSessionId: 'session-p' },
			{ id: OTHER, owner: 'p', parentSessionId: 'session-p' },
		],
	})
	const plan = planCascade(tree, 'session-p')
	assert.deepEqual(plan.deleteOrder, [CHILD])
	assert.deepEqual(plan.skipped, [{ id: OTHER, reason: 'different-workspace' }])
})

await check('planCascade：未分组的父子（都是 workspaceId null）算同一工作区，照常连带', () => {
	const rows = [row('session-p', null), row(CHILD, null)]
	const tree = buildSessionTree({ rows, claims: [{ id: CHILD, owner: 'p', parentSessionId: 'session-p' }] })
	assert.deepEqual(planCascade(tree, 'session-p').deleteOrder, [CHILD])
})

await check('planCascade：目标不在树里 → 空计划（不猜、不抛）', () => {
	const tree = buildSessionTree({ rows: [row('session-p')] })
	assert.deepEqual(planCascade(tree, 'session-none').deleteOrder, [])
	assert.deepEqual(planCascade(tree, undefined).skipped, [])
})

await check('collectRuntimeEdges：读 ctx.sessions / ctx.agents 的 header.parentSession', () => {
	const edges = collectRuntimeEdges({
		sessions: { list: () => [{ id: 'session-p', header: { id: 'session-p' } }, { id: CHILD, header: { id: CHILD, parentSession: 'session-p' } }] },
		agents: { list: () => [{ id: GRAND, session: { header: { id: GRAND, parentSession: CHILD } } }] },
	})
	assert.deepEqual(edges, [
		{ id: CHILD, parentId: 'session-p', source: 'runtime' },
		{ id: GRAND, parentId: CHILD, source: 'runtime' },
	])
})

await check('collectRuntimeEdges：拿不到（服务没装 / 方法抛错 / 形状变了）→ 空数组，绝不抛', () => {
	assert.deepEqual(collectRuntimeEdges(undefined), [])
	assert.deepEqual(collectRuntimeEdges({}), [])
	assert.deepEqual(collectRuntimeEdges({ sessions: { list: () => { throw new Error('boom') } }, agents: {} }), [])
	assert.deepEqual(collectRuntimeEdges({ sessions: { list: () => 'nope' }, agents: { list: () => [{ id: CHILD }] } }), [])
	// 自引用与空串一律丢弃。
	assert.deepEqual(collectRuntimeEdges({ sessions: { list: () => [{ id: CHILD, header: { id: CHILD, parentSession: CHILD } }, { id: '', header: { parentSession: 'session-p' } }] } }), [])
})

await check('运行时边经 buildSessionTree 落进图里（无登记时的兜底来源）', () => {
	const rows = [row('session-p'), row(CHILD)]
	const runtime = collectRuntimeEdges({ sessions: { list: () => [{ id: CHILD, header: { parentSession: 'session-p' } }] } })
	const tree = buildSessionTree({ rows, runtime })
	assert.equal(tree.byId.get(CHILD).parentId, 'session-p')
	assert.deepEqual(planCascade(tree, 'session-p').deleteOrder, [CHILD])
})

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}  (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
