// dsh-turing-balance — client 半区测试（离线；用 shell 同款加载协议把 bundle 跑在 Node 里）
//
// 覆盖：bundle 注册协议、槽位/字典、**取数策略（按 provider 缓存 5 分钟：切会话/重挂载不请求、
// 到 expiresAt 才自动重新获取、点击才强制刷新、非图灵 provider 不缓存不排期）**、以及
// 「与当前模型提供商挂钩」的显示规则（provider 未知 → 不显示；非图灵 → 不显示；切换不串台；
// 迟到响应丢弃；host 未确认身份时 fail closed）与各余额数据的渲染文案。
// 运行：npm test（或 node --test test/client.test.mjs）

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import react from "react";
import TestRenderer, { act } from "react-test-renderer";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 最小 document 替身（CSS 注入与 visibilitychange 监听用到）。 */
function stubDocument() {
	const listeners = new Map();
	return {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" }),
		visibilityState: "visible",
		addEventListener: (type, handler) => listeners.set(type, handler),
		removeEventListener: (type) => listeners.delete(type)
	};
}

/** 会话模型目录 store 的替身（结构对齐 ui-model-selection 的 ModelDirectory.store）。 */
function fakeDirectory(provider) {
	let current = provider === null ? null : { provider, model: "deepseek-v4-flash-0731" };
	const listeners = new Set();
	const directory = {
		loadCalls: 0,
		load: async () => {
			directory.loadCalls += 1;
		},
		store: {
			getSnapshot: () => ({ current, routable: true, groups: [], failures: [], status: current === null ? "idle" : "ready", error: null }),
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			update: () => {}
		},
		setProvider: (next) => {
			current = next === null ? null : { provider: next, model: "deepseek-v4-flash-0731" };
			for (const listener of [...listeners]) listener();
		}
	};
	return directory;
}

/** 假定时器：接住 bundle 的排期（经 `exports.__test.clock`），测试里手动触发。 */
function fakeClock(testSeam) {
	const timers = [];
	testSeam.clock.setTimeout = (callback, ms) => {
		timers.push({ callback, ms, cancelled: false });
		return timers.length;
	};
	testSeam.clock.clearTimeout = (id) => {
		const timer = timers[id - 1];
		if (timer !== undefined) timer.cancelled = true;
	};
	return {
		timers,
		/** 当前还没被取消的排期（业务上同时只有一个）。 */
		pending: () => timers.filter((timer) => timer.cancelled === false),
		/** 手动触发第 index 个排期（默认最后一个待触发项）。 */
		async fire(index) {
			const live = timers.filter((timer) => timer.cancelled === false);
			const timer = index === void 0 ? live[live.length - 1] : timers[index];
			if (timer === undefined) throw new Error("没有可触发的定时器");
			timer.cancelled = true; // 已触发 = 不再待触发（组件自身的 timer 句柄也会置空）
			await act(async () => {
				await timer.callback();
			});
		}
	};
}

/**
 * 按 shell 的懒加载协议跑一遍 client bundle，返回注册信息。
 * @returns {Promise<{exports: object, dictionaries: object, slot: object, Component: Function, test: object}>} 注册结果。
 */
async function loadClientBundle() {
	let definition;
	globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
	globalThis.document = stubDocument();
	await import(`../lib/client.js?test=${Date.now()}-${Math.random()}`);
	assert.ok(definition !== void 0, "bundle 应通过 window.__ModuleLoader__.load 注册");
	assert.equal(definition.id, "dsh-turing-balance");
	const exports = definition.factory((specifier) => {
		if (specifier === "react") return react;
		throw new Error(`unexpected require: ${specifier}`);
	});
	let dictionaries;
	let slot;
	const ctx = {
		effect: (callback) => callback(),
		locale: { register: (ns, dicts) => { dictionaries = { ns, dicts }; } },
		get: (key) => (key === "modelDirectories" ? { directoryFor: () => globalThis.__testDirectory } : void 0),
		slots: {
			inject: (name, callback) => {
				assert.equal(name, "conversation.session.header.actions");
				return callback();
			},
			register: (options, Component) => { slot = { options, Component }; }
		}
	};
	exports.apply(ctx);
	return { exports, dictionaries, slot, Component: slot.Component, test: exports.__test };
}

/** 与 shipped locale 服务同形的插值翻译（zh/en 用同一套键）。 */
function translator(dict, locale) {
	const table = dict[locale];
	return (key, params) => {
		const template = table[key];
		assert.ok(template !== void 0, `缺少 locale 键：${key}`);
		return params === void 0 ? template : template.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === void 0 ? match : String(params[name])));
	};
}

/** 造一个「刚取回来」的载荷：默认 5 分钟后过期（与 host 默认 TTL 一致）。 */
const READY_PAYLOAD = (provider, overrides = {}) => {
	const fetchedAt = Date.now();
	const ttlSeconds = 300;
	return {
		ok: true,
		stale: false,
		fetchedAt,
		ttlSeconds,
		expiresAt: fetchedAt + ttlSeconds * 1000,
		provider,
		providerBaseURL: "https://live-turing.cn.llm.tcljd.com/api/v1/",
		quotaPerMonthUsd: 100,
		monthRemainingUsd: 34.286361929600005,
		monthUsageUsd: 66.30427517439999,
		totalUsageUsd: 513.2408272470402,
		account: { username: "user_test", email: "USER@example.com", userId: "user_test" },
		pools: [],
		...overrides
	};
};

const HIDDEN_PAYLOAD = (provider) => ({
	ok: false,
	hidden: true,
	provider,
	providerBaseURL: "https://ai.docker.tcl.com/imaas/v1",
	error: { code: "PROVIDER_NOT_TURING", message: `当前模型提供商 "${provider}" 不属于图灵平台，不显示余额` }
});

/**
 * 渲染徽章：fetch 换成替身、定时器换成假定时器，返回渲染结果与记录。
 * @param options - { Component, dictionaries, test, provider, respond, locale, directory }
 * @returns 渲染结果、请求记录与假定时器。
 */
async function renderBadge({ Component, dictionaries, test: testSeam, provider = "tcl1", respond, locale = "zh", directory = fakeDirectory(provider) }) {
	globalThis.__testDirectory = directory;
	const clock = fakeClock(testSeam);
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const payload = await respond(String(url));
		if (payload === undefined) throw new Error("fetch stub: no payload");
		return { status: payload.__status ?? 200, json: async () => payload };
	};
	let renderer;
	const props = {
		sessionId: "ses_test",
		t: translator(dictionaries.dicts, locale),
		directory: directory.store,
		loadDirectory: () => {
			directory.load().catch(() => {});
		},
		directoryOf: () => directory
	};
	await act(async () => {
		renderer = TestRenderer.create(react.createElement(Component, props));
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	// 快照按需重算（切换 provider / 刷新后必须读到新的树，而不是首帧的那份）
	const snapshot = () => {
		const tree = renderer.toJSON();
		if (tree === null) return { json: null, button: null, label: null };
		const button = renderer.root.findByType("button");
		return { json: tree, button, label: button.findAllByType("span")[1].children.join("") };
	};
	return {
		renderer,
		directory,
		calls,
		clock,
		get json() {
			return snapshot().json;
		},
		get button() {
			return snapshot().button;
		},
		get label() {
			return snapshot().label;
		},
		/** 点击徽章（走 controlRef 的强制刷新）。 */
		click: () => act(async () => {
			snapshot().button.props.onClick();
			await Promise.resolve();
			await Promise.resolve();
		}),
		unmount: async () => {
			await act(async () => renderer.unmount());
		},
		settle: () => act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		}),
		restoreFetch: () => {
			globalThis.fetch = original;
		}
	};
}

test("bundle 与槽位注册：id / order / locale / 字典键集 / inject 形状 / 测试接缝", async () => {
	const { exports, dictionaries, slot, test: testSeam } = await loadClientBundle();
	assert.deepEqual(exports.inject, ["slots", "locale"]);
	assert.equal(dictionaries.ns, "dsh-turing-balance");
	assert.deepEqual(Object.keys(dictionaries.dicts.zh).sort(), Object.keys(dictionaries.dicts.en).sort(), "中英字典键集必须一致");
	assert.equal(slot.options.name, "conversation.session.header.actions");
	assert.equal(slot.options.id, "turing-balance");
	assert.equal(slot.options.locale, "dsh-turing-balance");
	assert.equal(typeof slot.options.order, "number");
	assert.equal(typeof slot.options.inject, "function");
	assert.equal(typeof slot.Component, "function");
	assert.equal(testSeam.balanceCache instanceof Map, true);
	assert.equal(typeof testSeam.clock.setTimeout, "function");
});

test("模型目录里还没有当前 provider：不渲染徽章，也不发请求", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: null, respond: () => READY_PAYLOAD("tcl1") });
	try {
		assert.equal(result.json, null);
		assert.equal(result.calls.length, 0, "provider 未知时不应请求余额");
		assert.equal(result.directory.loadCalls, 1, "应顺带催一次模型目录加载");
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("图灵 provider：首次取数走缓存友好路径（不带 refresh=1），并按 expiresAt 排期", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const payload = READY_PAYLOAD("tcl1");
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond: () => payload });
	try {
		assert.equal(result.label, "图灵 $34.29");
		assert.deepEqual(result.calls, ["/turing-balance?provider=tcl1"], "首次取数不应强制刷新");
		assert.match(result.button.props.title, /模型提供商：tcl1/u);
		assert.doesNotMatch(result.button.props.title, /缓存有效期至/u, "刚取回来的值不是缓存值，不标缓存行");
		const pending = result.clock.pending();
		assert.equal(pending.length, 1, "应只排一次到期重取");
		const expected = payload.expiresAt - Date.now() + 1000;
		assert.equal(Math.abs(pending[0].ms - expected) < 2_000, true, `排期应贴近 expiresAt（实际 ${pending[0].ms}ms，期望约 ${expected}ms）`);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("host 命中它自己的缓存时：标题标注缓存有效期", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const payload = READY_PAYLOAD("tcl1", { cached: true });
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond: () => payload });
	try {
		assert.match(result.button.props.title, /缓存有效期至/u);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("到期后自动重新获取（非强制），并更新数字与下一次排期", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	let round = 0;
	const result = await renderBadge({
		Component,
		dictionaries,
		test: testSeam,
		provider: "tcl1",
		respond: () => {
			round += 1;
			return round === 1
				? READY_PAYLOAD("tcl1", { expiresAt: Date.now() + 600 })
				: READY_PAYLOAD("tcl1", { monthRemainingUsd: 12.5 });
		}
	});
	try {
		assert.equal(result.label, "图灵 $34.29");
		assert.equal(result.clock.pending().length, 1);
		await result.clock.fire();
		assert.deepEqual(result.calls, ["/turing-balance?provider=tcl1", "/turing-balance?provider=tcl1"], "到期重取也不应强制刷新");
		assert.equal(result.label, "图灵 $12.50");
		assert.equal(result.clock.pending().length, 1, "重取后应重新排下一次");
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("切会话（卸载后重挂载同一个 provider）：命中前端缓存，零请求", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const respond = () => READY_PAYLOAD("tcl1", { monthRemainingUsd: 33.75 });
	const first = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond });
	try {
		assert.equal(first.label, "图灵 $33.75");
		assert.equal(first.calls.length, 1);
	} finally {
		await first.unmount();
	}
	// 换一个会话：同一个目录/provider，重新挂载（模拟切 session 导致的组件重建）
	const second = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond });
	try {
		assert.equal(second.label, "图灵 $33.75", "重挂载应立刻用保存下来的余额渲染");
		assert.deepEqual(second.calls, [], "缓存未过期时切会话不应再请求");
		assert.equal(second.clock.pending().length, 1, "仍按原 expiresAt 排下一次");
	} finally {
		await second.unmount();
		second.restoreFetch();
	}
});

test("多个图灵 provider（不同账号）各自缓存；切回来不重复请求", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const respond = (url) => (url.includes("provider=tcl2") ? READY_PAYLOAD("tcl2", { monthRemainingUsd: 99.5 }) : READY_PAYLOAD("tcl1"));
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond });
	try {
		assert.equal(result.label, "图灵 $34.29");
		await act(async () => {
			result.directory.setProvider("tcl2");
		});
		await result.settle();
		assert.equal(result.label, "图灵 $99.50", "切到另一个图灵 provider 应显示它自己的余额");
		await act(async () => {
			result.directory.setProvider("tcl1");
		});
		await result.settle();
		assert.equal(result.label, "图灵 $34.29", "切回来应直接用缓存");
		assert.deepEqual(result.calls, ["/turing-balance?provider=tcl1", "/turing-balance?provider=tcl2"], "每个 provider 只请求一次");
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("非图灵 provider（host 回 hidden）：不渲染、不缓存、不排期", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "linxi", respond: () => HIDDEN_PAYLOAD("linxi") });
	try {
		assert.equal(result.json, null, "非图灵平台提供方不应显示徽章");
		assert.deepEqual(result.calls, ["/turing-balance?provider=linxi"]);
		assert.equal(result.clock.pending().length, 0, "不适用就不该有任何后续请求");
		assert.equal(result.test === void 0 ? testSeam.balanceCache.has("linxi") : testSeam.balanceCache.has("linxi"), false, "不缓存不适用结果");
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("PROVIDER_UNKNOWN（认不出 provider）同样不渲染", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({
		Component,
		dictionaries,
		test: testSeam,
		provider: "ghost",
		respond: () => ({ ok: false, hidden: true, provider: "ghost", error: { code: "PROVIDER_UNKNOWN", message: "定位不到配置" } })
	});
	try {
		assert.equal(result.json, null);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("点击徽章：强制刷新（refresh=1）并重排下一次", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	let round = 0;
	const result = await renderBadge({
		Component,
		dictionaries,
		test: testSeam,
		provider: "tcl1",
		respond: () => {
			round += 1;
			return READY_PAYLOAD("tcl1", { monthRemainingUsd: round === 1 ? 30 : 7.25 });
		}
	});
	try {
		assert.equal(result.label, "图灵 $30.00");
		await result.click();
		assert.equal(result.label, "图灵 $7.25");
		assert.deepEqual(result.calls, ["/turing-balance?provider=tcl1", "/turing-balance?provider=tcl1&refresh=1"]);
		assert.equal(result.clock.pending().length, 1, "刷新后应重排下一次到期重取");
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("切换 provider：先清空旧数字，再按新 provider 取数", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	let deferred = null;
	const result = await renderBadge({
		Component,
		dictionaries,
		test: testSeam,
		provider: "tcl1",
		respond: (url) => {
			if (url.includes("provider=tcl2")) return new Promise((resolve) => { deferred = () => resolve(READY_PAYLOAD("tcl2", { monthRemainingUsd: 12.5 })); });
			return READY_PAYLOAD("tcl1");
		}
	});
	try {
		assert.equal(result.label, "图灵 $34.29");
		await act(async () => {
			result.directory.setProvider("tcl2");
		});
		assert.equal(result.json, null, "切到新 provider 时不能继续显示上一个 provider 的余额");
		await act(async () => {
			deferred();
		});
		await result.settle();
		assert.equal(result.label, "图灵 $12.50");
		assert.deepEqual(result.calls, ["/turing-balance?provider=tcl1", "/turing-balance?provider=tcl2"]);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("图灵 → 非图灵：切过去后徽章消失", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({
		Component,
		dictionaries,
		test: testSeam,
		provider: "tcl1",
		respond: (url) => (url.includes("provider=linxi") ? HIDDEN_PAYLOAD("linxi") : READY_PAYLOAD("tcl1"))
	});
	try {
		assert.equal(result.label, "图灵 $34.29");
		await act(async () => {
			result.directory.setProvider("linxi");
		});
		await result.settle();
		assert.equal(result.json, null);
		assert.equal(result.clock.pending().length, 0);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("迟到响应（host 回报的 provider 与当前不一致）：不显示也不缓存", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl2", respond: () => READY_PAYLOAD("tcl1") });
	try {
		assert.equal(result.json, null, "provider 不一致的响应必须丢弃");
		assert.equal(testSeam.balanceCache.size, 0);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("host 未确认 provider 身份（旧版 host 半区）：宁可不显示（fail closed）", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const legacy = READY_PAYLOAD("tcl1");
	delete legacy.provider;
	delete legacy.providerBaseURL;
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "linxi", respond: () => legacy });
	try {
		assert.equal(result.json, null, "host 没确认这是当前 provider 的余额时，绝不能显示");
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("图灵 provider 但读取失败：显示错误徽章，并按 host 给的较短 expiresAt 自动重试", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const failedAt = Date.now();
	const result = await renderBadge({
		Component,
		dictionaries,
		test: testSeam,
		provider: "tcl1",
		respond: () => ({
			ok: false,
			hidden: false,
			provider: "tcl1",
			fetchedAt: failedAt,
			ttlSeconds: 120,
			expiresAt: failedAt + 120_000,
			error: { code: "CREDENTIAL_MISSING", message: "没有解析到凭据 \"TCL1_API_KEY\"" },
			__status: 503
		})
	});
	try {
		assert.equal(result.label, "图灵 —");
		assert.match(result.button.props.className, /dtb_error/u);
		assert.match(result.button.props.title, /读取失败：没有解析到凭据/u);
		const pending = result.clock.pending();
		assert.equal(pending.length, 1, "失败也应排一次重试");
		assert.equal(pending[0].ms <= 125_000, true, `失败重试应较短（实际 ${pending[0].ms}ms）`);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("英文 locale：同样的数据出英文文案", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond: () => READY_PAYLOAD("tcl1"), locale: "en" });
	try {
		assert.equal(result.label, "Turing $34.29");
		assert.match(result.button.props.title, /Provider: tcl1/u);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("额度偏低（≤10%）：徽章进入警示色", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond: () => READY_PAYLOAD("tcl1", { monthRemainingUsd: 8.5 }) });
	try {
		assert.equal(result.label, "图灵 $8.50");
		assert.match(result.button.props.className, /dtb_low/u);
		assert.match(result.button.props.title, /（9%）/u);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("陈旧数据：仍显示上次成功值并标注失败原因", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const payload = READY_PAYLOAD("tcl1", { stale: true, staleError: { code: "UPSTREAM_HTTP", message: "API key not exist" } });
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond: () => payload });
	try {
		assert.match(result.button.props.title, /上次成功值/u);
		assert.match(result.button.props.title, /API key not exist/u);
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("额度字段缺失：显示破折号而不是崩溃", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const result = await renderBadge({ Component, dictionaries, test: testSeam, provider: "tcl1", respond: () => READY_PAYLOAD("tcl1", { monthRemainingUsd: null, quotaPerMonthUsd: null }) });
	try {
		assert.equal(result.label, "图灵 —");
	} finally {
		await result.unmount();
		result.restoreFetch();
	}
});

test("槽位 inject 未给 directory 时，用 sessionId 兜底解析模型目录", async () => {
	const { Component, dictionaries, test: testSeam } = await loadClientBundle();
	const directory = fakeDirectory("tcl1");
	globalThis.__testDirectory = directory;
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { status: 200, json: async () => READY_PAYLOAD("tcl1") };
	};
	let renderer;
	try {
		await act(async () => {
			renderer = TestRenderer.create(react.createElement(Component, {
				sessionId: "ses_test",
				t: translator(dictionaries.dicts, "zh"),
				// 故意不给 directory / loadDirectory，只给兜底解析函数
				directoryOf: (id) => (id === "ses_test" ? directory : void 0)
			}));
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const button = renderer.root.findByType("button");
		assert.equal(button.findAllByType("span")[1].children.join(""), "图灵 $34.29");
		assert.deepEqual(calls, ["/turing-balance?provider=tcl1"]);
	} finally {
		await act(async () => renderer.unmount());
		globalThis.fetch = original;
		assert.equal(typeof testSeam.clock.setTimeout, "function");
	}
});

test("拿不到模型目录（服务缺失）：不渲染、不请求", async () => {
	let definition;
	globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
	globalThis.document = stubDocument();
	await import(`../lib/client.js?test=${Date.now()}-nodes`);
	const exports = definition.factory((specifier) => {
		if (specifier === "react") return react;
		throw new Error(`unexpected require: ${specifier}`);
	});
	let slot;
	const dictionaries = { dicts: void 0 };
	exports.apply({
		effect: (callback) => callback(),
		locale: { register: (ns, dicts) => { dictionaries.dicts = dicts; } },
		// 没有 modelDirectories 服务
		get: () => void 0,
		slots: {
			inject: (name, callback) => callback(),
			register: (options, Component) => { slot = { options, Component }; }
		}
	});
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		throw new Error("should not fetch");
	};
	let renderer;
	try {
		const injected = slot.options.inject("ses_test");
		assert.equal(injected.directory, void 0);
		await act(async () => {
			renderer = TestRenderer.create(react.createElement(slot.Component, {
				...injected,
				sessionId: "ses_test",
				t: translator(dictionaries.dicts, "zh")
			}));
		});
		await act(async () => {
			await Promise.resolve();
		});
		assert.equal(renderer.toJSON(), null);
		assert.equal(calls.length, 0);
	} finally {
		await act(async () => renderer.unmount());
		globalThis.fetch = original;
	}
});

test("client 半区不 require 任何 client 包（只依赖壳里的 react）", async () => {
	const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
	const specifiers = [...source.matchAll(/require\((["'])(.+?)\1\)/gu)].map((match) => match[2]);
	assert.deepEqual([...new Set(specifiers)], ["react"]);
});
