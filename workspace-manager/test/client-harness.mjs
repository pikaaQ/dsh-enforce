// dsh-workspace-manager — 客户端半区离线集成测试
//
// 把真实的 lib/client.js 载入 Node：用一个最小 DOM + 迷你 React（含 hooks 重渲染）
// 顶替浏览器环境，并把 `ctx.connection.rpc.call` 接到**真实的宿主 RPC 处理器**
// （src/host/index.js 的 createRpcHandler + 真实 closed-set 存储 + 假 registry）。
// 于是"点勾选 → RPC → 宿主状态 → 投影 → 重渲染"这条完整链路可以在没有浏览器的情况下
// 被断言，包括最脆的行菜单 DOM 注入契约。
//
// 不可替代的部分：真浏览器的 React fiber 由真实官方组件产生（这里按官方组件的
// props 形状手工构造），以及真实网络/帧时序。
//
// 运行：node test/client-harness.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, 'tmp-client')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

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

// ── 迷你 DOM ────────────────────────────────────────────────────────────────

class Element {
	constructor(tag, namespace = null) {
		this.tagName = String(tag).toUpperCase()
		this.namespaceURI = namespace
		this.childNodes = []
		this.parentNode = null
		this.attributes = new Map()
		this.style = {}
		this.className = ''
		this.textContent = ''
		this.listeners = new Map()
		this.rect = { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }
		this.disabled = false
		this.value = ''
	}
	get children() {
		return this.childNodes.filter((node) => node instanceof Element)
	}
	get firstElementChild() {
		return this.children[0] ?? null
	}
	get lastElementChild() {
		const children = this.children
		return children[children.length - 1] ?? null
	}
	setAttribute(name, value) {
		this.attributes.set(name, String(value))
	}
	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null
	}
	hasAttribute(name) {
		return this.attributes.has(name)
	}
	removeAttribute(name) {
		this.attributes.delete(name)
	}
	appendChild(node) {
		if (node.parentNode !== null) node.remove()
		node.parentNode = this
		this.childNodes.push(node)
		return node
	}
	append(...nodes) {
		for (const node of nodes) this.appendChild(node)
	}
	insertBefore(node, reference) {
		if (reference === undefined || reference === null) return this.appendChild(node)
		const at = this.childNodes.indexOf(reference)
		if (at < 0) return this.appendChild(node)
		if (node.parentNode !== null) node.remove()
		node.parentNode = this
		this.childNodes.splice(at, 0, node)
		return node
	}
	remove() {
		if (this.parentNode === null) return
		const at = this.parentNode.childNodes.indexOf(this)
		if (at >= 0) this.parentNode.childNodes.splice(at, 1)
		this.parentNode = null
	}
	cloneNode() {
		const copy = new Element(this.tagName, this.namespaceURI)
		copy.className = this.className
		for (const [name, value] of this.attributes) copy.attributes.set(name, value)
		return copy
	}
	getBoundingClientRect() {
		return this.rect
	}
	focus() {
		document.activeElement = this
	}
	matches(selector) {
		for (const part of selector.split(/(?=\[)/)) {
			const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part)
			if (attribute !== null) {
				const name = attribute[1]
				if (!this.attributes.has(name)) return false
				if (attribute[2] !== undefined && this.attributes.get(name) !== attribute[2]) return false
				continue
			}
			if (part !== '' && this.tagName !== part.toUpperCase()) return false
		}
		return true
	}
	closest(selector) {
		let node = this
		while (node !== null && node !== undefined) {
			if (node instanceof Element && node.matches(selector)) return node
			node = node.parentNode
		}
		return null
	}
	querySelector(selector) {
		for (const node of this.childNodes) {
			if (!(node instanceof Element)) continue
			if (node.matches(selector)) return node
			const nested = node.querySelector(selector)
			if (nested !== null) return nested
		}
		return null
	}
	querySelectorAll(selector) {
		const found = []
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (!(child instanceof Element)) continue
				if (child.matches(selector)) found.push(child)
				walk(child)
			}
		}
		walk(this)
		return found
	}
	addEventListener(type, listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set())
		this.listeners.get(type).add(listener)
	}
	removeEventListener(type, listener) {
		this.listeners.get(type)?.delete(listener)
	}
	dispatchEvent(event) {
		// 冒泡到 document，并先跑捕获阶段的 document 监听器（与浏览器一致：捕获先于目标）
		const path = []
		let node = this
		while (node !== null && node !== undefined) {
			path.push(node)
			node = node.parentNode
		}
		event.target = event.target ?? this
		const captureListeners = document.listeners.get(event.type)
		if (captureListeners !== undefined) for (const listener of [...captureListeners]) listener(event)
		for (const node2 of path) {
			const listeners = node2.listeners?.get(event.type)
			if (listeners !== undefined) for (const listener of [...listeners]) listener(event)
			if (event.propagationStopped === true) break
		}
		return true
	}
	click() {
		this.dispatchEvent(makeEvent('click', this))
	}
}

const makeEvent = (type, target) => ({
	type,
	target,
	preventDefault() {},
	stopPropagation() {
		this.propagationStopped = true
	},
})

/** 在真实 DOM 子树里收集元素。 */
function collectDom(node, predicate, found = []) {
	for (const child of node.childNodes ?? []) {
		if (!(child instanceof Element)) continue
		if (predicate(child)) found.push(child)
		collectDom(child, predicate, found)
	}
	return found
}

const document = {
	createElement: (tag) => new Element(tag),
	createElementNS: (namespace, tag) => new Element(tag, namespace),
	addEventListener(type, listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set())
		this.listeners.get(type).add(listener)
	},
	removeEventListener(type, listener) {
		this.listeners.get(type)?.delete(listener)
	},
	querySelectorAll(selector) {
		return document.body.querySelectorAll(selector)
	},
	listeners: new Map(),
	activeElement: null,
}
document.body = new Element('body')
document.head = new Element('head')

const window = {
	listeners: new Map(),
	addEventListener(type, listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set())
		this.listeners.get(type).add(listener)
	},
	removeEventListener(type, listener) {
		this.listeners.get(type)?.delete(listener)
	},
	dispatchEvent(event) {
		for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event)
		return true
	},
}

globalThis.window = window
globalThis.document = document
globalThis.Event = class Event {
	constructor(type) {
		this.type = type
	}
}
// Node 22 的 globalThis.navigator 只有 getter，必须用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
	value: { language: 'zh-CN', languages: ['zh-CN'] },
	configurable: true,
	writable: true,
})

/** 迷你 React：支持 hooks 与 setState 触发的同步重渲染，够跑设置页组件。 */
function createReact() {
	let hooks = []
	let cursor = 0
	let component = null
	let tree = null
	const react = {
		createElement(type, props, ...children) {
			const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)
			return { type, props: { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat } }
		},
		useState(initial) {
			const at = cursor++
			if (hooks.length <= at) hooks[at] = { value: typeof initial === 'function' ? initial() : initial }
			const set = (next) => {
				hooks[at].value = typeof next === 'function' ? next(hooks[at].value) : next
				render()
			}
			return [hooks[at].value, set]
		},
		useCallback(fn) {
			const at = cursor++
			if (hooks.length <= at) hooks[at] = { fn }
			return hooks[at].fn
		},
		useSyncExternalStore(_subscribe, getSnapshot) {
			cursor += 1
			return getSnapshot()
		},
		useEffect(fn) {
			const at = cursor++
			if (hooks.length <= at) hooks[at] = { ran: false }
			if (hooks[at].ran !== true) {
				hooks[at].ran = true
				fn()
			}
		},
	}
	function render() {
		if (component === null) return
		cursor = 0
		tree = component()
	}
	return {
		react,
		mount(renderFunction, props) {
			component = () => renderFunction(props)
			hooks = []
			render()
			return () => tree
		},
		getTree: () => tree,
	}
}

/** 深度优先收集元素节点（迷你 React 的元素树，不是 DOM）。 */
function collect(node, predicate, found = []) {
	if (node === null || node === undefined || typeof node !== 'object') return found
	if (Array.isArray(node)) {
		for (const item of node) collect(item, predicate, found)
		return found
	}
	if (predicate(node)) found.push(node)
	collect(node.props?.children, predicate, found)
	return found
}

// ── 加载真实的客户端 bundle ──────────────────────────────────────────────────
let registration
globalThis.window.__ModuleLoader__ = {
	load(value) {
		registration = value
	},
}
const mini = createReact()
const bundle = await import(`../lib/client.js?cachebust=${Date.now()}`)
void bundle

await check('客户端 bundle 以正确 id 注册到 __ModuleLoader__', () => {
	assert.equal(registration.id, 'dsh-workspace-manager')
	assert.equal(typeof registration.factory, 'function')
})

const moduleExports = registration.factory((specifier) => {
	if (specifier === 'react') return mini.react
	throw new Error(`unexpected require(${specifier})`)
})
const requestedSpecifiers = []
registration.factory((specifier) => {
	requestedSpecifiers.push(specifier)
	if (specifier === 'react') return mini.react
	throw new Error(`unexpected require(${specifier})`)
})

await check('模块导出 apply 与 inject，且 inject 声明了所需的 5 个客户端服务', () => {
	assert.equal(typeof moduleExports.apply, 'function')
	assert.deepEqual(moduleExports.inject, ['slots', 'workspaces', 'sessions', 'locale', 'connection'])
})
await check('工厂只 require 了 react（不依赖 primitives 等易漂移的包）', () => {
	assert.deepEqual(requestedSpecifiers, ['react'])
})

// ── 假宿主：真实 RPC 处理器 + 假 registry + 真实状态存储 ─────────────────────
const { openClosedStore } = await import('../src/host/closed-set.js')
const { createRpcHandler } = await import('../src/host/index.js')

function makeRegistry() {
	let state = { initialized: true, workspaceIds: ['ws-a', 'ws-b'], archivedSessionIds: [] }
	// `known` 只影响 archiveSession 是否被内核拒绝：把下面的会话树夹具父会话也放进来。
	const known = new Set(['s1', 's2', 's3', 'session-tree-parent'])
	return {
		get archivedSessionIds() {
			return [...state.archivedSessionIds]
		},
		list: () => [
			{ id: 'ws-a', title: 'alpha', path: 'E:/tmp/alpha', sessionIds: ['s1', 's2'], detachSession: async () => {}, attachSession: async () => {} },
			{ id: 'ws-b', title: 'beta', path: 'E:/tmp/beta', sessionIds: ['s3'], detachSession: async () => {}, attachSession: async () => {} },
		],
		get: (id) => (id === 'ws-a' ? { id: 'ws-a' } : undefined),
		async archiveSession(sessionId) {
			if (!known.has(sessionId)) throw new Error(`unknown session ${sessionId}`)
			if (!state.archivedSessionIds.includes(sessionId)) state.archivedSessionIds = [...state.archivedSessionIds, sessionId]
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
}

const hostRegistry = makeRegistry()
const store = await openClosedStore({ file: join(TMP, 'state.json') })
const rpcCalls = []
// 夹具 home：让 inventory/remove 打在这个临时目录上，绝不碰真实 $DSH_HOME。
process.env.DSH_HOME = TMP
// 两个会话都放在**未分组**的项目键下，这样不会抢占 ws-a / ws-b 的会话列表
// （那两个工作区的会话仍由假注册表的 s1/s2/s3 提供，原有设置页用例不受影响）。
mkdirSync(join(TMP, 'sessions', '--E-orphan-dir--', 's-fixture-orphan'), { recursive: true })
mkdirSync(join(TMP, 'sessions', '--E-orphan-dir--', 's-fixture-active'), { recursive: true })
mkdirSync(join(TMP, 'storages', 'session_projcache', 'sessions'), { recursive: true })
writeFileSync(join(TMP, 'sessions', '--E-orphan-dir--', 's-fixture-orphan', 'session.jsonl.zstd'), 'c'.repeat(4096))
writeFileSync(join(TMP, 'sessions', '--E-orphan-dir--', 's-fixture-active', 'session.jsonl.zstd'), 'b'.repeat(64))
writeFileSync(join(TMP, 'storages', 'session_projcache', 'sessions', 's-fixture-orphan.json'), '{}')

const hostHandlerCtx = {
	workspaceRegistry: hostRegistry,
	// 真实运行时这些服务由 inject 保证存在（inject: connection/agents/sessions/sessionPersistence/workspaceRegistry）
	// s-fixture-active 造出一个活跃会话，用来验证删除按钮会被禁用。
	sessions: { get: (id) => (id === "s-fixture-active" ? { header: { id } } : undefined) },
	agents: { get: () => undefined },
	sessionPersistence: {
		supportsRawArtifacts: true,
		readRaw: async () => undefined,
		list: async () => [
			{ id: 's1', cwd: 'E:/tmp/alpha', createdAt: 1 },
			{ id: 's2', cwd: 'E:/tmp/alpha', createdAt: 2 },
			{ id: 's3', cwd: 'E:/tmp/beta', createdAt: 3 },
		],
	},
	logger: { warn: () => {}, info: () => {} },
}
// `let`：文件末尾会用一份**带登记表**的处理器重挂设置页（子会话树那一节）。
let hostHandler = createRpcHandler(hostHandlerCtx, Promise.resolve(store))

// ── 假客户端 ctx ────────────────────────────────────────────────────────────
/** 忠实还原 createSnapshotStore 的形状：对象字面量 + 自有属性方法。 */
function createFakeStore(snapshot) {
	const listeners = new Set()
	return {
		snapshot,
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

const workspacesModel = createFakeStore({
	items: [
		{ workspaceId: 'ws-a', title: 'alpha', path: 'E:/tmp/alpha', sessionIds: ['s1', 's2'] },
		{ workspaceId: 'ws-b', title: 'beta', path: 'E:/tmp/beta', sessionIds: ['s3'] },
	],
	archivedSessionIds: [],
	state: 'idle',
	phase: 'ready',
	error: null,
	baselinesReady: true,
	recentWorkspaceId: 'ws-a',
})

const sections = []
const ctx = {
	logger: { warn: (...args) => console.log(`  [client warn] ${args.join(' ')}`), info: () => {} },
	locale: {
		register: () => () => {},
		bind: () => (key, vars) => {
			const zh = {
				'nav.label': '工作区/会话',
				'menu.close': '关闭',
				'menu.close.done': '已关闭「{title}」，可在 设置 → 工作区/会话 里重新打开',
				'page.ungrouped': '未分组',
				'page.ungroupedHint': '说明',
				'page.remove': '彻底删除',
				'page.detach': '移除记账',
				'page.removeUnsupported': '仍活跃',
				'page.totals': '磁盘上共 {n} 个会话、{size}；其中未分组 {ungrouped} 个（{ungroupedSize}）。',
				'page.loading': '正在清点会话…',
				'confirm.title': '彻底删除会话',
				'confirm.body': '将永久删除「{title}」（约 {size}），不可恢复。',
				'confirm.cancel': '取消',
				'confirm.delete': '确认删除',
				'confirm.deleting': '正在删除…',
				'confirm.done': '已彻底删除「{title}」，释放 {size}',
				'confirm.archiveCleared': '（同时从官方归档集合里摘除）',
				'error.remove': '删除失败：{message}',
				'error.inventory': '无法清点会话：{message}',
				'page.title': '工作区 / 会话',
				'page.open': '打开',
				'page.archived': '归档',
				'page.sessions': '{n} 个会话',
				'page.hiddenByWorkspace': '随工作区隐藏',
				'page.subagent': '子会话',
				'page.hiddenByParent': '随父归档隐藏',
				'page.children': '{n} 个子会话',
				'confirm.children': '将一并删除 {n} 个子会话（约 {size}）。',
				'page.statePath': '状态文件：{path}',
				'page.intro': '说明',
				'page.empty': '空',
				'page.failed': '操作失败：{message}',
			}
			const template = zh[key] ?? key
			return vars === undefined ? template : template.replace(/\{(\w+)\}/g, (_all, name) => String(vars[name] ?? ''))
		},
	},
	slots: {
		inject(name, callback) {
			return callback()
		},
		register(options, component) {
			if (options.name === 'settings.section') sections.push({ options, component })
			return () => {}
		},
	},
	workspaces: { list: workspacesModel },
	sessions: {
		list: createFakeStore({ ids: ['s1', 's2', 's3'], byId: { s1: { id: 's1', title: '第一个会话' }, s2: { id: 's2', title: '第二个会话' }, s3: { id: 's3', title: '第三个会话' } }, current: undefined }),
		get: (id) => (id === 's-fixture-active' ? { header: { id } } : undefined),
	},
	agents: { get: () => undefined },
	connection: {
		rpc: {
			async call(path, endpoint, payload) {
				rpcCalls.push({ path, endpoint, payload })
				const result = await hostHandler(endpoint, payload)
				// 模拟真实客户端收到 `host/archived-sessions-changed` 帧后引擎刷新快照
				// （证据：dsh-host-apiproxy/lib/index.js:3644-3671 对比前后集合后推帧）。
				const hostArchived = [...hostRegistry.debugState().archivedSessionIds]
				const current = workspacesModel.snapshot // 未经投影包装的原始快照
				if (JSON.stringify(current.archivedSessionIds) !== JSON.stringify(hostArchived)) {
					workspacesModel.publish({ ...current, archivedSessionIds: hostArchived })
				}
				return result
			},
		},
	},
	effect(fn) {
		const disposer = fn()
		return () => disposer?.()
	},
}

moduleExports.apply(ctx)
// 宿主 RPC 背后有真实文件 I/O（open/write/fsync/rename），setImmediate 等不到它，
// 所以这里按真实时间放行几轮宏任务。
const flush = async () => {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 4))
}
await flush()

// ── 断言：注册契约 ──────────────────────────────────────────────────────────
await check('只注册了一个 settings.section 项', () => {
	assert.equal(sections.length, 1)
	assert.equal(sections[0].options.name, 'settings.section')
	assert.equal(sections[0].options.id, 'workspace-manager')
	assert.equal(sections[0].options.order, 19)
	assert.equal(sections[0].options.locale, 'dsh-workspace-manager')
})
await check('导航标题经 locale 解析为「工作区/会话」', () => {
	assert.equal(sections[0].options.label(), '工作区/会话')
})
await check('apply 时拉取了一次宿主状态（RPC state）', () => {
	assert.equal(rpcCalls.filter((entry) => entry.endpoint === 'state').length, 1)
	assert.equal(rpcCalls[0].path, '/dsh-workspace-manager')
})
await check('没有关闭项时投影不改变快照（返回原对象）', () => {
	assert.equal(workspacesModel.getSnapshot().items.length, 2)
})

// ── 断言：设置页首屏渲染 ────────────────────────────────────────────────────
const Section = sections[0].component
const render = mini.mount(Section, {})
const checkboxes = () => collect(mini.getTree(), (node) => node.type === 'input' && node.props.type === 'checkbox')
const labels = () => collect(mini.getTree(), (node) => node.type === 'label')

await check('渲染出「工作区 / 会话」标题与两个工作区', () => {
	const texts = JSON.stringify(mini.getTree())
	assert.match(texts, /工作区 \/ 会话/)
	assert.match(texts, /alpha/)
	assert.match(texts, /beta/)
})
await check('每个工作区一个「打开」勾选框，默认都勾选', () => {
	const boxes = checkboxes()
	assert.equal(boxes.length, 2)
	assert.equal(boxes[0].props.checked, true)
	assert.equal(boxes[1].props.checked, true)
})
await check('状态文件路径提示已渲染（用真实存储路径）', () => {
	assert.match(JSON.stringify(mini.getTree()), /状态文件：E:\\\\JavaScript.*state\.json/)
})

// ── 断言：取消勾选「打开」= 关闭工作区（端到端：UI → RPC → 宿主 → 投影） ─────
checkboxes()[0].props.onChange({ target: { checked: false } })
await flush()
await flush()

await check('取消勾选后宿主状态文件记下了 ws-a', () => {
	assert.deepEqual(store.ids(), ['ws-a'])
})
await check('侧栏投影里 ws-a 消失（items 只剩 ws-b）', () => {
	assert.deepEqual(workspacesModel.getSnapshot().items.map((item) => item.workspaceId), ['ws-b'])
})
await check('关闭工作区时它的会话被并入 archivedSessionIds（不会掉进「未分组」）', () => {
	assert.deepEqual([...workspacesModel.getSnapshot().archivedSessionIds], ['s1', 's2'])
})
await check('仅关闭工作区**不会**写内核归档集合（视图层与内核状态分离）', () => {
	assert.deepEqual([...hostRegistry.debugState().archivedSessionIds], [])
})
await check('recentWorkspaceId 指向已关闭工作区时被清空', () => {
	assert.equal(workspacesModel.getSnapshot().recentWorkspaceId, undefined)
})
await check('设置页仍列出已关闭的工作区（读的是未过滤快照）', () => {
	const texts = JSON.stringify(mini.getTree())
	assert.match(texts, /alpha/)
	assert.match(texts, /beta/)
	assert.equal(checkboxes()[0].props.checked, false)
})

// ── 断言：展开工作区 + 会话「归档」开关 ─────────────────────────────────────
const expanders = () => collect(mini.getTree(), (node) => node.type === 'button' && node.props['aria-label'] === 'expand')
expanders()[1].props.onClick()
await check('展开 ws-b 后出现它的会话行', () => {
	const texts = JSON.stringify(mini.getTree())
	assert.match(texts, /第三个会话/)
	assert.equal(checkboxes().length, 3, '2 个打开开关 + 1 个归档开关')
})
const archiveBox = () => checkboxes()[2]
await check('归档开关初始未勾选（宿主归档集合为空）', () => {
	assert.equal(archiveBox().props.checked, false)
})
archiveBox().props.onChange()
await flush()
await flush()
await check('勾选归档 → 走内核官方 archiveSession，宿主集合变为 [s3]', () => {
	assert.deepEqual([...hostRegistry.debugState().archivedSessionIds], ['s3'])
	assert.equal(rpcCalls.some((entry) => entry.endpoint === 'archive' && entry.payload.sessionId === 's3'), true)
})
await check('归档后被隐藏的会话集合是"内核归档 ∪ 随工作区隐藏"', () => {
	assert.deepEqual([...workspacesModel.getSnapshot().archivedSessionIds], ['s3', 's1', 's2'])
})
await check('归档开关复选后 UI 显示为已勾选', () => {
	assert.equal(archiveBox().props.checked, true)
})
await check('不再渲染「官方归档」标签（归档就是官方归档，无需额外标注）', () => {
	const texts = JSON.stringify(mini.getTree())
	assert.doesNotMatch(texts, /page\.hostArchived/)
	assert.doesNotMatch(texts, /官方归档/)
})
archiveBox().props.onChange()
await flush()
await flush()
await check('取消勾选 → 从内核归档集合移除（可逆恢复）', () => {
	assert.deepEqual([...hostRegistry.debugState().archivedSessionIds], [])
	assert.equal(rpcCalls.some((entry) => entry.endpoint === 'unarchive' && entry.payload.sessionId === 's3'), true)
})
await check('恢复后仅剩"随工作区隐藏"的会话', () => {
	assert.deepEqual([...workspacesModel.getSnapshot().archivedSessionIds], ['s1', 's2'])
})

// ── 断言：重新打开工作区 ────────────────────────────────────────────────────
checkboxes()[0].props.onChange({ target: { checked: true } })
await flush()
await flush()
await check('勾回「打开」→ 宿主集合清空、侧栏恢复两个工作区', () => {
	assert.deepEqual(store.ids(), [])
	assert.deepEqual(workspacesModel.getSnapshot().items.map((item) => item.workspaceId), ['ws-a', 'ws-b'])
	assert.deepEqual([...workspacesModel.getSnapshot().archivedSessionIds], [])
})

// ── 断言：行菜单 DOM 注入（工作区「关闭」）──────────────────────────────────
/** 捕获客户端半区的告警（契约变化时的可诊断性测试）。 */
const warnings = []
const realConsoleWarn = console.warn
console.warn = (...args) => {
	warnings.push(String(args[0]))
}
void realConsoleWarn

function buildRow({ role, attribute, props }) {
	const row = document.createElement('div')
	row.setAttribute('role', role)
	row.setAttribute(attribute, 'true')
	row.rect = { width: 200, height: 30, left: 10, top: 10, right: 210, bottom: 40 }
	const button = document.createElement('button')
	button.rect = { width: 20, height: 20, left: 180, top: 15, right: 200, bottom: 35 }
	row.appendChild(button)
	document.body.appendChild(row)
	// 官方 ProjectRowItem / SessionNodeItem 的 fiber props 形状
	// （dsh-client-ui-workspace/lib/client.js:454 的 group、:692 的 node）
	row[`__reactFiber$test${Math.random()}`] = {
		memoizedProps: props ?? {},
		return: { memoizedProps: {}, return: null },
	}
	return { row, button }
}

function buildMenu() {
	const menu = document.createElement('div')
	menu.setAttribute('role', 'menu')
	menu.rect = { width: 160, height: 80, left: 180, top: 40, right: 340, bottom: 120 }
	const item = document.createElement('div')
	item.setAttribute('role', 'menuitem')
	const icon = document.createElement('span')
	icon.className = 'icon-slot'
	const text = document.createElement('span')
	text.className = 'text-slot'
	text.textContent = '重命名'
	item.append(icon, text)
	menu.appendChild(item)
	document.body.appendChild(menu)
	return { menu, item }
}

const workspaceRow = buildRow({ role: 'treeitem', attribute: 'aria-expanded', props: { group: { workspaceId: 'ws-b', label: 'beta' } } })
const workspaceMenu = buildMenu()
workspaceRow.button.click()
await new Promise((resolve) => setTimeout(resolve, 30))

const injected = () => workspaceMenu.menu.querySelector('[data-dsh-workspace-manager="close"]')
await check('工作区行菜单里被注入了「关闭」项', () => {
	assert.notEqual(injected(), null)
	assert.equal(injected().lastElementChild.textContent, '关闭')
	assert.equal(injected().getAttribute('data-dsh-workspace-manager'), 'close')
})
await check('注入项复用了官方菜单项的外观类名', () => {
	assert.equal(injected().firstElementChild.className, 'icon-slot')
	assert.equal(injected().lastElementChild.className, 'text-slot')
})
await check('注入项插在第一个菜单项之后（重命名、关闭、删除）', () => {
	const roles = workspaceMenu.menu.children.map((child) => child.lastElementChild?.textContent)
	assert.deepEqual(roles, ['重命名', '关闭'])
})
injected().click()
await flush()
await flush()
await check('点击「关闭」→ 调 RPC close 且宿主状态已记录 ws-b', () => {
	assert.equal(rpcCalls.some((entry) => entry.endpoint === 'close' && entry.payload.workspaceId === 'ws-b'), true)
	assert.deepEqual(store.ids(), ['ws-b'])
})
await check('关闭后出现提示（toast 渲染到 body）', () => {
	const toasts = document.body.children.filter((node) => node.getAttribute('role') === 'status')
	assert.equal(toasts.length >= 1, true)
	assert.match(toasts.at(-1).textContent, /已关闭/)
})
await check('提示里是工作区**标题**而不是 id（标题必须在关闭前取）', () => {
	const toasts = document.body.children.filter((node) => node.getAttribute('role') === 'status')
	assert.match(toasts.at(-1).textContent, /「beta」/)
	assert.doesNotMatch(toasts.at(-1).textContent, /「ws-b」/)
})
// 模拟官方菜单随点击收起（真实环境里 portal 节点会被卸载），让后续的几何选择确定
workspaceMenu.menu.remove()
workspaceRow.row.remove()

await check('「未分组」桶不会注入（group.workspaceId 为 undefined 时跳过）', async () => {
	const ungroupedRow = buildRow({ role: 'treeitem', attribute: 'aria-expanded', props: { group: { label: '未分组' } } })
	const menu = buildMenu()
	ungroupedRow.button.click()
	await new Promise((resolve) => setTimeout(resolve, 30))
	assert.equal(menu.menu.querySelector('[data-dsh-workspace-manager="close"]'), null)
	assert.equal(warnings.filter((text) => text.includes('工作区行')).length, 0, '「未分组」是正常情况，不该告警')
	menu.menu.remove()
	ungroupedRow.row.remove()
})

// ── 断言：官方契约万一变化时，失败要可诊断（而不是静默什么都不做）────────────
await check('工作区行 fiber 里取不到 group → 不注入且告警一次', async () => {
	const brokenRow = buildRow({ role: 'treeitem', attribute: 'aria-expanded', props: { somethingElse: 1 } })
	const menu = buildMenu()
	brokenRow.button.click()
	await new Promise((resolve) => setTimeout(resolve, 30))
	assert.equal(menu.menu.querySelector('[data-dsh-workspace-manager="close"]'), null)
	assert.equal(warnings.filter((text) => text.includes('工作区行')).length, 1)
	assert.match(warnings.find((text) => text.includes('工作区行')), /ProjectRowItem/)
	menu.menu.remove()
	brokenRow.row.remove()
})
await check('同类行再次失败不重复告警（不刷屏）', async () => {
	const again = buildRow({ role: 'treeitem', attribute: 'aria-expanded', props: { nope: true } })
	const menu = buildMenu()
	again.button.click()
	await new Promise((resolve) => setTimeout(resolve, 30))
	assert.equal(warnings.filter((text) => text.includes('工作区行')).length, 1)
	menu.menu.remove()
	again.row.remove()
})

// ── 断言：会话行不再注入任何菜单项（跨工作区移动已彻底移除）──────────────────
const sessionRow = buildRow({ role: 'treeitem', attribute: 'aria-selected', props: { node: { id: 's1' } } })
const sessionMenu = buildMenu()
const rpcBefore = rpcCalls.length
sessionRow.button.click()
await new Promise((resolve) => setTimeout(resolve, 30))
await check('会话行菜单里没有任何本插件的项', () => {
	assert.equal(sessionMenu.menu.querySelector('[data-dsh-workspace-manager]'), null)
})
await check('点击会话行不发起任何 RPC（移动端点已删除）', () => {
	assert.equal(rpcCalls.length, rpcBefore)
	assert.equal(rpcCalls.some((entry) => entry.endpoint === 'moveState' || entry.endpoint === 'move'), false)
})
await check('会话行契约变化也不再告警（已不解析会话行）', () => {
	assert.equal(warnings.filter((text) => text.includes('会话行')).length, 0)
})
sessionMenu.menu.remove()
sessionRow.row.remove()
// ── 断言：磁盘清点 / 未分组 / 彻底删除（端到端：真实宿主端点 + 临时 home 夹具）──
await flush()
const textOf = (node) => {
	if (node === null || node === undefined || typeof node === 'boolean') return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map(textOf).join(' ')
	return textOf(node.props?.children)
}
const treeText = () => textOf(mini.getTree())
const buttonsSaying = (label) => collect(mini.getTree(), (node) => node.type === 'button' && textOf(node.props?.children) === label)

await check('设置页给出磁盘总量（含未分组计数）', () => {
	assert.match(treeText(), /磁盘上共 2 个会话/)
	assert.match(treeText(), /未分组 2 个/)
})
await check('未分组分组列出会话；活跃那个的删除按钮被禁用并带原因', () => {
	assert.match(treeText(), /未分组/)
	// 未分组分组默认折叠（列表里只有它的标题），点开才看得到会话行。
	assert.equal(buttonsSaying('彻底删除').length, 0)
	const expanders = collect(mini.getTree(), (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined)
	expanders[expanders.length - 1].props.onClick()
	assert.match(treeText(), /s-fixture-orphan/)
	const buttons = buttonsSaying('彻底删除')
	assert.equal(buttons.length, 2)
	const disabled = buttons.filter((button) => button.props.disabled === true)
	assert.equal(disabled.length, 1, '活跃会话不可删')
	assert.equal(disabled[0].props.title, '仍活跃')
})
await check('点删除 → 弹确认对话框并报出体积', () => {
	const enabled = buttonsSaying('彻底删除').filter((button) => button.props.disabled !== true)
	assert.equal(enabled.length, 1, '唯一可点的应是未分组那个')
	enabled[0].props.onClick()
	assert.match(treeText(), /彻底删除会话/)
	assert.match(treeText(), /s-fixture-orphan/)
	assert.match(treeText(), /4\.0 KB/)
	assert.equal(buttonsSaying('确认删除').length, 1)
})
await check('确认删除 → 走真实 remove 端点，磁盘工件与缓存一起消失', async () => {
	buttonsSaying('确认删除')[0].props.onClick()
	// 真实 fs 删除是异步 I/O：固定 20ms 的 flush 在冷缓存下等不完，会偶发红。
	// 这里轮询等目标消失（最多 2s），再断言 RPC 记录与"别的会话没被动"。
	const waitGone = async (path) => {
		for (let attempt = 0; attempt < 80; attempt += 1) {
			if (!existsSync(path)) return true
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		return false
	}
	assert.equal(await waitGone(join(TMP, 'sessions', '--E-orphan-dir--', 's-fixture-orphan')), true, '工件目录应被删掉')
	assert.equal(await waitGone(join(TMP, 'storages', 'session_projcache', 'sessions', 's-fixture-orphan.json')), true, '投影缓存应被删掉')
	await flush()
	assert.equal(rpcCalls.some((entry) => entry.endpoint === 'remove' && entry.payload.sessionId === 's-fixture-orphan'), true)
	assert.equal(existsSync(join(TMP, 'sessions', '--E-orphan-dir--', 's-fixture-active')), true, '别的会话必须原封不动')
})
await check('删除后清点已刷新：总量变 1，未分组只剩活跃那个', async () => {
	await flush()
	assert.doesNotMatch(treeText(), /s-fixture-orphan/)
	assert.match(treeText(), /磁盘上共 1 个会话/)
	assert.match(treeText(), /s-fixture-active/)
})

await check('告警里带设置页不受影响的说明（便于用户判断影响面）', () => {
	for (const text of warnings) assert.match(text, /设置页不受影响/)
})

// ── 断言：子会话树（缩进显示 / 默认折叠 / 删除确认框 / 归档随父隐藏）────────────
// 夹具：ws-a 的项目键（E:/tmp/alpha → --E-tmp-alpha--）下放一个父会话 + 一个**裸 UUID 子会话**，
// 并写一份**登记表** —— 父子关系只来自插件登记（内核没有这份数据，也不解析日志兜底）。
// 然后换一个读这份登记表的宿主处理器、重挂设置页（等价于"重启后再打开设置页"）。
const TREE_PARENT = 'session-tree-parent'
const TREE_CHILD = 'aaaa1111-2222-4333-8444-555555555555'
const TREE_PARENT_DIR = join(TMP, 'sessions', '--E-tmp-alpha--', TREE_PARENT)
const TREE_CHILD_DIR = join(TMP, 'sessions', '--E-tmp-alpha--', TREE_CHILD)
mkdirSync(TREE_PARENT_DIR, { recursive: true })
mkdirSync(TREE_CHILD_DIR, { recursive: true })
writeFileSync(join(TREE_PARENT_DIR, 'session.jsonl.zstd'), 'p'.repeat(2048))
writeFileSync(join(TREE_CHILD_DIR, 'session.jsonl.zstd'), 'k'.repeat(1024))
const { openClaimsStore } = await import('../src/host/claims-store.js')
const claimsPath = join(TMP, 'claims-harness.json')
writeFileSync(claimsPath, JSON.stringify({
	version: 1,
	claims: { [TREE_CHILD]: { owner: 'dsh-vision-delegate', parentSessionId: TREE_PARENT } },
}))
const harnessClaims = await openClaimsStore({ file: claimsPath })
hostHandler = createRpcHandler(hostHandlerCtx, Promise.resolve(store), harnessClaims)

mini.mount(Section, {})
await flush()
await flush()

/** 按会话 id 找到那一行的 React 元素（行内的名字 span 带 `title=id`）。 */
const rowNode = (id) => collect(mini.getTree(), (node) => node.type === 'div'
	&& Array.isArray(node.props?.children)
	&& node.props.children.some((child) => child?.props?.title === id))[0]
const inRow = (node, predicate) => collect(node, predicate)[0]
const sessionExpander = (id) => inRow(rowNode(id), (node) => node.type === 'button' && node.props['aria-expanded'] !== undefined)
const cardExpanders = () => collect(mini.getTree(), (node) => node.type === 'button' && node.props['aria-label'] === 'expand')
const removeButtonOf = (id) => inRow(rowNode(id), (node) => node.type === 'button' && textOf(node.props?.children) === '彻底删除')
const archiveBoxOf = (id) => inRow(rowNode(id), (node) => node.type === 'input' && node.props.type === 'checkbox')

await check('重挂后 ws-a 卡片默认折叠（会话树的折叠状态与工作区卡分开）', () => {
	assert.equal(cardExpanders().length >= 2, true)
	assert.doesNotMatch(treeText(), new RegExp(TREE_PARENT))
})
cardExpanders()[0].props.onClick()
await check('展开 ws-a：父会话行在，**子会话默认折叠**（先不出现，但不是隐藏）', () => {
	assert.match(treeText(), new RegExp(TREE_PARENT))
	assert.doesNotMatch(treeText(), new RegExp(TREE_CHILD))
})
await check('父会话行有自己的展开箭头，标题报出子会话数量', () => {
	const expander = sessionExpander(TREE_PARENT)
	assert.notEqual(expander, undefined)
	assert.equal(expander.props['aria-expanded'], false)
	assert.equal(expander.props.title, '1 个子会话')
})
sessionExpander(TREE_PARENT).props.onClick()

await check('展开后子会话缩进显示在父会话下面，并带「子会话」标记', () => {
	assert.match(treeText(), new RegExp(TREE_CHILD))
	const childRow = rowNode(TREE_CHILD)
	assert.notEqual(childRow, undefined)
	assert.equal(childRow.props.style.paddingLeft, '18px', '缩进一级')
	assert.equal(rowNode(TREE_PARENT).props.style.paddingLeft, undefined, '父会话不缩进')
	assert.match(textOf(childRow.props.children), /子会话/)
})
await check('折叠回去：子会话重新收起（父行的展开状态可逆）', () => {
	sessionExpander(TREE_PARENT).props.onClick()
	assert.doesNotMatch(treeText(), new RegExp(TREE_CHILD))
	sessionExpander(TREE_PARENT).props.onClick()
	assert.match(treeText(), new RegExp(TREE_CHILD))
})

await check('删除确认框列出「将一并删除 N 个子会话 / X MB」', () => {
	removeButtonOf(TREE_PARENT).props.onClick()
	const text = treeText()
	assert.match(text, /彻底删除会话/)
	assert.match(text, new RegExp(TREE_PARENT))
	assert.match(text, /将一并删除 1 个子会话（约 1\.0 KB）/)
})

await check('确认删除 → RPC remove 带 cascade:true，父与子一起消失', async () => {
	// 上一条检查已经把确认框打开了，这里直接点确认。
	buttonsSaying('确认删除')[0].props.onClick()
	const waitGone = async (path) => {
		for (let attempt = 0; attempt < 80; attempt += 1) {
			if (!existsSync(path)) return true
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		return false
	}
	assert.equal(await waitGone(TREE_CHILD_DIR), true, '子会话工件应被删掉')
	assert.equal(await waitGone(TREE_PARENT_DIR), true, '父会话工件应被删掉')
	await flush()
	const call = rpcCalls.find((entry) => entry.endpoint === 'remove' && entry.payload.sessionId === TREE_PARENT)
	assert.notEqual(call, undefined)
	assert.equal(call.payload.cascade, true)
	await flush()
	assert.doesNotMatch(treeText(), new RegExp(TREE_PARENT))
})

await check('归档父会话：子会话随父隐藏（并进 archivedSessionIds），但**不**对子会话调用 archiveSession', async () => {
	// 重建夹具（上面刚删掉，登记也在删除时被清了）+ 重新登记父子关系，再重挂设置页。
	mkdirSync(TREE_PARENT_DIR, { recursive: true })
	mkdirSync(TREE_CHILD_DIR, { recursive: true })
	writeFileSync(join(TREE_PARENT_DIR, 'session.jsonl.zstd'), 'p'.repeat(2048))
	writeFileSync(join(TREE_CHILD_DIR, 'session.jsonl.zstd'), 'k'.repeat(1024))
	await harnessClaims.setMany([{ id: TREE_CHILD, owner: 'dsh-vision-delegate', parentSessionId: TREE_PARENT }])
	mini.mount(Section, {})
	await flush()
	await flush()
	cardExpanders()[0].props.onClick()

	const archiveBox = archiveBoxOf(TREE_PARENT)
	assert.notEqual(archiveBox, undefined)
	assert.equal(archiveBox.props.checked, false)
	archiveBox.props.onChange()
	await flush()
	await flush()
	assert.deepEqual([...hostRegistry.debugState().archivedSessionIds], [TREE_PARENT])
	const hidden = [...workspacesModel.getSnapshot().archivedSessionIds]
	assert.equal(hidden.includes(TREE_PARENT), true)
	assert.equal(hidden.includes(TREE_CHILD), true, '子会话随父隐藏')
	assert.equal(hostRegistry.debugState().archivedSessionIds.includes(TREE_CHILD), false, '子会话不进内核归档集合')
	assert.equal(rpcCalls.some((entry) => entry.endpoint === 'archive' && entry.payload.sessionId === TREE_CHILD), false, '不对子会话调 archiveSession')
})

await check('取消归档父会话 → 子会话随之恢复显示（隐藏集合收缩）', async () => {
	archiveBoxOf(TREE_PARENT).props.onChange()
	await flush()
	await flush()
	const hidden = [...workspacesModel.getSnapshot().archivedSessionIds]
	assert.equal(hidden.includes(TREE_PARENT), false)
	assert.equal(hidden.includes(TREE_CHILD), false, '父取消归档后子会话恢复')
})

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}  (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
