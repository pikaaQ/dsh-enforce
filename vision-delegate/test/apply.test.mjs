// dsh-vision-delegate — apply() 接线测试（用假 ctx；不碰真实运行时）
//
// 目的：把"注册了什么、守卫拦谁"钉死。上次现场锁死正是因为 apply 里的守卫漏了工具名判断，
// 而当时只测了纯函数、没测接线——所以这里必须覆盖到 apply 本体。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, UNCONFIGURED_MESSAGE } from "../lib/config.js";

// ⚠️ 必须在**导入 lib/index.js 之前**把 home 指向临时目录：
//   * index.js 顶部的诊断探针（trace.js）在模块加载时就算好 trace 文件路径，
//     并在 `apply()` 里清空它；
//   * 临时会话账本也落在 `$DSH_HOME` 下。
// 测试绝不能碰真实 `$DSH_HOME`（用户数据）。
const TEST_HOME = mkdtempSync(join(tmpdir(), "dsh-vision-apply-"));
process.env.DSH_HOME = TEST_HOME;
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const { apply, name, inject, ROUTE_MODELS, ROUTE_STATUS } = await import("../lib/index.js");

const CONFIGURED = { enabled: true, provider: "tcl1", model: "deepseek-v4-flash-vision-exp" };
const LEDGER_FILE = "dsh-vision-delegate.state.json";

/** 轮询等待异步副作用（启动补删是 fire-and-forget）。 */
async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function fakeCtx({ config = DEFAULT_CONFIG, providers = ["spawn"], services = {}, logger } = {}) {
	const registeredTools = [];
	const guards = [];
	const routes = [];
	const sections = [];
	const effects = [];
	const starts = [];
	const injectCalls = [];

	// 模拟官方 settings 服务的行为：installSection 把"当前值来源"交给插件，
	// mutate 改了存储之后再让 source 读到新值（这正是"保存后无需重启即生效"的机制）。
	let settingsValue = { ...DEFAULT_CONFIG, ...(config ?? {}) };
	const settingsStub = {
		installSection(owner, ns, schema, entry, hooks) {
			sections.push({ owner, ns, schema, entry, hooks });
			hooks.setSource(() => settingsValue);
		},
		mutate(ns, ops) {
			sections.push({ mutate: { ns, ops } });
			const next = { ...settingsValue };
			for (const op of ops) {
				if (op?.op === "set" && Array.isArray(op.path)) next[op.path[0]] = op.value;
			}
			settingsValue = next;
			return Promise.resolve();
		},
	};
	const llmStub = {
		listProviders: async () => [{ id: "tcl1", name: "TCL-1" }],
		listModels: () => [{ id: "deepseek-v4-flash-vision-exp", name: "Vision", inputModalities: ["text", "image"] }],
	};

	const ctx = {
		config,
		registeredTools,
		guards,
		routes,
		sections,
		effects,
		starts,
		injectCalls,
		settings: settingsStub,
		llm: llmStub,
		listeners: [],
		on(event, listener) {
			ctx.listeners.push({ event, listener });
			return () => {};
		},
		// 图片字节 → durable 附件（工具用它构造 image block，子代理不需要 read_image）
		attachments: {
			saveImages: async (inputs) =>
				inputs.map((_, index) => ({ attachmentId: `att-${index}`, mediaType: "image/png", bytes: 1, width: 1, height: 1 }))
		},
		logger: logger ?? { info() {}, warn() {} },
		effect(fn, label) {
			const disposer = fn();
			effects.push({ label, disposer });
			return () => {
				if (typeof disposer === "function") disposer();
			};
		},
		inject(names, callback) {
			injectCalls.push(names);
			callback(this);
		},
		get(serviceName) {
			if (serviceName === "settings") return settingsStub;
			if (serviceName === "llm") return llmStub;
			if (serviceName === "sessionRemoval") return services.sessionRemoval;
			return void 0;
		},
		tools: {
			register(definition) {
				registeredTools.push(definition);
				return () => {};
			},
			guard(guard) {
				guards.push(guard);
				return () => {};
			},
			get(toolName, agent) {
				const found = registeredTools.find((definition) => definition.name === toolName);
				return agent === void 0 || found === void 0 ? found : found;
			},
		},
		subagents: {
			list: () => providers,
			start(provider, request) {
				starts.push({ provider, request });
				return Promise.resolve({
					id: "child",
					result: Promise.resolve({ output: [{ type: "text", text: "结论" }], stopReason: "completed" }),
					dispose: async () => {},
				});
			},
		},
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
	};
	return ctx;
}

function callRoute(handler, method, body, url) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url ?? ROUTE_STATUS;
	req.destroy = () => {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
		req.emit("end");
	});
	const res = {
		status: 0,
		headers: {},
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(chunk) {
			this.body = chunk === undefined ? "" : String(chunk);
		},
	};
	return handler(req, res).then(() => ({ status: res.status, json: res.body === "" ? void 0 : JSON.parse(res.body) }));
}

test("apply：注册了一个全局 subagent_vision 工具 + 一个全局守卫 + 两条路由 + 设置命名空间", () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);

	assert.equal(name, "dsh-vision-delegate");
	assert.deepEqual(inject, ["tools", "subagents", "settings", "webServer", "attachments", "llm"]);

	assert.equal(ctx.registeredTools.length, 1);
	assert.equal(ctx.registeredTools[0].name, "subagent_vision");
	assert.equal(typeof ctx.registeredTools[0].execute, "function");

	assert.equal(ctx.guards.length, 1);
	assert.equal(ctx.sections.length, 1);
	assert.equal(ctx.sections[0].ns, "vision-delegate");
	assert.equal(ctx.sections[0].entry.provider, "");
	assert.equal(typeof ctx.sections[0].hooks.validate, "function");

	assert.deepEqual(
		ctx.routes.map((route) => route.path).sort(),
		[ROUTE_STATUS, ROUTE_MODELS].sort()
	);
});

test("apply：未配置时守卫只拦 subagent_vision（回归：绝不能拦别的工具）", () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);
	const guard = ctx.guards[0];

	for (const toolName of ["pwsh", "read", "write", "edit", "glob", "grep", "ask_user_question", "todo_write"]) {
		assert.equal(guard({ name: toolName, agent: { id: "s1" } }), undefined, `${toolName} 不能被拦`);
	}
	assert.equal(guard({ name: "subagent_vision", agent: { id: "s1" } }), UNCONFIGURED_MESSAGE);
});

test("apply：配置在运行中变化（官方 setSource 回调）后守卫随之放行", () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);
	const guard = ctx.guards[0];
	assert.equal(guard({ name: "subagent_vision", agent: { id: "s1" } }), UNCONFIGURED_MESSAGE);

	// 模拟用户在设置卡片里保存 → 官方 installSection 回调 setSource
	ctx.sections[0].hooks.setSource(() => CONFIGURED);
	assert.equal(guard({ name: "subagent_vision", agent: { id: "s1" } }), undefined);

	// 再关掉（全局默认 false）
	ctx.sections[0].hooks.setSource(() => ({ ...CONFIGURED, enabled: false }));
	assert.match(guard({ name: "subagent_vision", agent: { id: "s1" } }), /已关闭/);
});

test("apply：hooks.validate 拒绝「启用但没选模型」", () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);
	assert.throws(() => ctx.sections[0].hooks.validate({ enabled: true, provider: "", model: "" }), /必须先选择视觉模型/);
	ctx.sections[0].hooks.validate({ enabled: false, provider: "", model: "" });
});

test("apply：状态路由返回三态与提示，POST 可写配置/会话覆盖", async () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);
	const statusRoute = ctx.routes.find((route) => route.path === ROUTE_STATUS);

	const anonymous = await callRoute(statusRoute.handler, "GET");
	assert.equal(anonymous.status, 200);
	assert.equal(anonymous.json.status, "unconfigured");
	assert.equal(anonymous.json.tool, "subagent_vision");
	assert.equal(anonymous.json.hint, UNCONFIGURED_MESSAGE);
	assert.equal(anonymous.json.providerAvailable, true);

	const withSession = await callRoute(statusRoute.handler, "GET", void 0, `${ROUTE_STATUS}?session=s1`);
	assert.equal(withSession.json.sessionOverride, null);

	// 写配置 → 走官方 settings.mutate
	const patched = await callRoute(statusRoute.handler, "POST", { patch: { provider: "tcl1", model: "m", enabled: true } });
	assert.equal(patched.json.provider, "tcl1");
	assert.equal(patched.json.status, "on");
	assert.equal(ctx.sections[1].mutate.ns, "vision-delegate");
	assert.deepEqual(ctx.sections[1].mutate.ops.map((op) => op.path[0]).sort(), ["enabled", "model", "provider"]);

	// 会话覆盖：本会话关掉
	const off = await callRoute(statusRoute.handler, "POST", { session: "s1", enabled: false });
	assert.equal(off.json.status, "off");
	assert.equal(off.json.sessionOverride, false);
	// 别的会话不受影响
	const other = await callRoute(statusRoute.handler, "GET", void 0, `${ROUTE_STATUS}?session=s2`);
	assert.equal(other.json.status, "on");
	// 复位
	const reset = await callRoute(statusRoute.handler, "POST", { session: "s1", resetSession: true });
	assert.equal(reset.json.sessionOverride, null);
});

test("apply：候选路由返回合并后的模型清单", async () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);
	const modelsRoute = ctx.routes.find((route) => route.path === ROUTE_MODELS);
	const response = await callRoute(modelsRoute.handler, "GET", void 0, ROUTE_MODELS);
	assert.equal(response.status, 200);
	assert.equal(response.json.ok, true);
	assert.deepEqual(response.json.current, { provider: "", model: "" });
	assert.equal(response.json.candidates.length >= 1, true);
	assert.equal(response.json.candidates[0].model, "deepseek-v4-flash-vision-exp");
	assert.equal(response.json.candidates[0].image, true);
});

test("apply：坏请求返回 400 且带原因（写配置时先本地校验）", async () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);
	const statusRoute = ctx.routes.find((route) => route.path === ROUTE_STATUS);
	const bad = await callRoute(statusRoute.handler, "POST", { patch: { enabled: true } });
	assert.equal(bad.status, 400);
	assert.match(bad.json.error.message, /必须先选择视觉模型/);
});

test("apply：spawn 未注册时状态里标出 unavailable", async () => {
	const ctx = fakeCtx({ providers: [] });
	apply(ctx, DEFAULT_CONFIG);
	const statusRoute = ctx.routes.find((route) => route.path === ROUTE_STATUS);
	const response = await callRoute(statusRoute.handler, "GET");
	assert.equal(response.json.providerAvailable, false);
});

// ── 临时会话清理（依赖 dsh-workspace-manager 的 sessionRemoval 服务）──────────

test("apply：sessionRemoval 是**可选**依赖 —— 用 ctx.inject 等它就绪，绝不写进模块级 inject", () => {
	const ctx = fakeCtx();
	apply(ctx, DEFAULT_CONFIG);
	assert.equal(inject.includes("sessionRemoval"), false, "写进 inject 会让对方缺席时整行 parked（视觉功能一起消失）");
	assert.deepEqual(ctx.injectCalls, [["sessionRemoval"]], "用 ctx.inject 等它出现（服务晚就绪也能补删）");
	assert.equal(ctx.registeredTools.length, 1, "服务不在也不影响工具注册");
});

test("apply：服务可用时启动补删 —— 账本里欠的 id 逐个交给服务（崩溃孤儿）", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-vision-sweep-"));
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		writeFileSync(join(home, LEDGER_FILE), JSON.stringify({ version: 1, pendingSessionIds: ["orphan-1", "orphan-2"] }));
		const removed = [];
		const service = {
			claim() {},
			async remove(sessionId, options) {
				removed.push({ sessionId, owner: options?.owner });
				if (sessionId === "orphan-2") throw Object.assign(new Error("gone"), { code: "session-not-found" });
				return { bytes: 1 };
			}
		};
		const ctx = fakeCtx({ services: { sessionRemoval: service } });
		apply(ctx, DEFAULT_CONFIG);

		assert.equal(await waitFor(() => removed.length === 2), true, "补删没有发生");
		assert.deepEqual(removed, [
			{ sessionId: "orphan-1", owner: "dsh-vision-delegate" },
			{ sessionId: "orphan-2", owner: "dsh-vision-delegate" }
		]);
		// session-not-found 也算清掉了 → 账本最终为空
		assert.equal(
			await waitFor(() => JSON.parse(readFileSync(join(home, LEDGER_FILE), "utf8")).pendingSessionIds.length === 0),
			true,
			"欠账没有被划掉"
		);
	} finally {
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("apply：服务缺席时启动补删只记一条日志、账本原样保留、视觉功能照常", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-vision-noservice-"));
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		writeFileSync(join(home, LEDGER_FILE), JSON.stringify({ version: 1, pendingSessionIds: ["orphan-1"] }));
		const warnings = [];
		const ctx = fakeCtx({ logger: { info() {}, warn: (...args) => warnings.push(args.join(" ")) } });
		apply(ctx, DEFAULT_CONFIG);

		assert.equal(await waitFor(() => warnings.length > 0), true, "服务缺席应该记一条日志");
		assert.equal(warnings.length, 1, "最多一条，不刷屏");
		assert.match(warnings[0], /sessionRemoval/);
		assert.equal(ctx.registeredTools.length, 1, "工具照常注册");
		assert.equal(ctx.routes.length, 2, "路由照常注册");
		assert.deepEqual(
			JSON.parse(readFileSync(join(home, LEDGER_FILE), "utf8")).pendingSessionIds,
			["orphan-1"],
			"账本原样保留：装上 workspace-manager 后下次启动补删"
		);
	} finally {
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
});
