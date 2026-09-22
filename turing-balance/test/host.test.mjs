// dsh-turing-balance — host 半区离线测试（不联网：global.fetch 被替身接管）
//
// 覆盖：载荷归一化、正常读取、TTL 缓存、?force 强制刷新、上游失败回落上次成功值
// （stale）、无上次成功值时的错误载荷、凭据缺失、非法凭据引用名。
// 运行：npm test（或 node --test test/host.test.mjs）

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler, normalizeUsage, readBalance } from "../lib/index.js";

const USAGE_BODY = {
	code: 0,
	data: {
		user_tier: 10100,
		tier_remaining_days: null,
		quota_per_month_in_usd: 100,
		current_month_usage_in_usd: 66.3,
		current_month_remaining_quota_in_usd: 33.7,
		total_usage_in_usd: 513.24,
		pools: [{ pool_type: "api_key", quota_per_month_in_usd: 100, current_month_usage_in_usd: 66.3 }]
	}
};
const SELF_BODY = { code: 0, data: { username: "user_test", email: "USER@example.com", user_id: "user_test" } };

/** 造一个只提供 credentials 的假 ctx。 */
function fakeCtx(value) {
	const current = value === void 0 ? "sk-test" : value;
	return {
		get: (key) => (key === "credentials" ? { resolve: async () => (current === null ? void 0 : { value: current, source: "test" }) } : void 0)
	};
}

/** 带 llm + settings 的假 ctx：settings 里放 llm-pi-ai.providers.<id> 的生效配置。 */
function providerCtx(providers, { credentials = "sk-test", withLlm = true } = {}) {
	const value = { providers };
	const llm = {
		listConfigurableProviders: () => Object.keys(providers).map((provider) => ({
			provider,
			displayName: providers[provider].displayName ?? provider,
			settingsNs: "llm-pi-ai",
			settingsPath: ["providers", provider]
		}))
	};
	return {
		get: (key) => {
			if (key === "settings") return { describe: () => [{ ns: "llm-pi-ai", value }] };
			if (key === "llm") return withLlm ? llm : void 0;
			if (key === "credentials") return { resolve: async () => (credentials === null ? void 0 : { value: credentials, source: "test" }) };
			return void 0;
		}
	};
}

const TURING_BASE = "https://live-turing.cn.llm.tcljd.com/api/v1/";
const TURING_PROVIDERS = {
	tcl1: { displayName: "turing", apiKeyEnv: "TCL1_API_KEY", baseURL: TURING_BASE },
	tcl2: { displayName: "dong", apiKeyEnv: "TCL2_API_KEY", baseURL: TURING_BASE },
	linxi: { displayName: "linxi", apiKeyEnv: "LINXI_API_KEY", baseURL: "https://ai.docker.tcl.com/imaas/v1" }
};

/** 造一个按 URL 路径后缀分派的 fetch 替身（记录调用次数）。 */
function stubFetch(routes) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url: String(url), init });
		const pathname = new URL(String(url)).pathname;
		for (const [suffix, responder] of routes) {
			if (pathname.endsWith(suffix)) return responder();
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
	return { impl, calls };
}

function jsonResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	};
}

/** 最小 res 替身：记录 status/headers/body（HEAD 时 body 为空串）。 */
function fakeRes() {
	const captured = { status: 0, headers: null, body: "" };
	return {
		captured,
		writeHead: (status, headers) => {
			captured.status = status;
			captured.headers = headers;
		},
		end: (body) => {
			captured.body = body ?? "";
		}
	};
}

test("normalizeUsage 保留金额字段并把缺失值记为 null", () => {
	assert.deepEqual(normalizeUsage(USAGE_BODY.data), {
		quotaPerMonthUsd: 100,
		monthRemainingUsd: 33.7,
		monthUsageUsd: 66.3,
		totalUsageUsd: 513.24,
		userTier: 10100,
		tierRemainingDays: null,
		pools: [{ poolType: "api_key", quotaPerMonthUsd: 100, currentMonthUsageUsd: 66.3 }]
	});
	assert.deepEqual(normalizeUsage(void 0), {
		quotaPerMonthUsd: null,
		monthRemainingUsd: null,
		monthUsageUsd: null,
		totalUsageUsd: null,
		userTier: null,
		tierRemainingDays: null,
		pools: []
	});
	assert.deepEqual(normalizeUsage({ current_month_remaining_quota_in_usd: Number.NaN }).monthRemainingUsd, null);
});

test("正常读取：返回 ok 载荷、账号，并带上 ttlSeconds/expiresAt", async () => {
	const { impl, calls } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { status, payload } = await readBalance(fakeCtx(), { apiKeyEnv: "TEST_KEY", ttlSeconds: 30 }, { force: true });
		assert.equal(status, 200);
		assert.equal(payload.ok, true);
		assert.equal(payload.stale, false);
		assert.equal(payload.monthRemainingUsd, 33.7);
		assert.equal(payload.ttlSeconds, 30);
		assert.equal(payload.expiresAt, payload.fetchedAt + 30_000, "expiresAt = fetchedAt + ttlSeconds（前端据此排期）");
		assert.equal(payload.account.username, "user_test");
		assert.equal(calls.length, 2);
		assert.match(calls[0].init.headers.authorization, /^Bearer sk-test$/u);
	} finally {
		globalThis.fetch = original;
	}
});

test("默认 TTL 是 5 分钟（300s）：不配置时也按 5 分钟缓存", async () => {
	const { impl } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { payload } = await readBalance(fakeCtx(), { apiKeyEnv: "DEFAULT_TTL_KEY" }, { force: true });
		assert.equal(payload.ttlSeconds, 300);
		assert.equal(payload.expiresAt - payload.fetchedAt, 300_000);
	} finally {
		globalThis.fetch = original;
	}
});

test("TTL 内命中缓存：不再发起请求，且沿用原 expiresAt", async () => {
	const { impl, calls } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const config = { apiKeyEnv: "TTL_KEY", ttlSeconds: 300 };
		const first = await readBalance(fakeCtx(), config, { force: true });
		const before = calls.length;
		const { payload } = await readBalance(fakeCtx(), config, { force: false });
		assert.equal(calls.length, before, "缓存命中时不应再请求上游");
		assert.equal(payload.cached, true);
		assert.equal(payload.ttlSeconds, 300);
		assert.equal(payload.expiresAt, first.payload.expiresAt, "命中缓存要沿用原来那条缓存的到期时刻");
		assert.equal(payload.fetchedAt, first.payload.fetchedAt, "命中缓存不刷新 fetchedAt");
	} finally {
		globalThis.fetch = original;
	}
});

test("上游失败且有上次成功值：回落为 stale 载荷（HTTP 200），并按 ≤120s 重试", async () => {
	let failing = false;
	const { impl } = stubFetch([
		["/users/me/usage", () => (failing ? jsonResponse({ code: 1304, message: "API key not exist" }, 401) : jsonResponse(USAGE_BODY))],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		await readBalance(fakeCtx(), { apiKeyEnv: "STALE_KEY", ttlSeconds: 300 }, { force: true });
		failing = true;
		const before = Date.now();
		const { status, payload } = await readBalance(fakeCtx(), { apiKeyEnv: "STALE_KEY", ttlSeconds: 300 }, { force: true });
		assert.equal(status, 200);
		assert.equal(payload.ok, true);
		assert.equal(payload.stale, true);
		assert.equal(payload.monthRemainingUsd, 33.7);
		assert.equal(payload.staleError.code, "UPSTREAM_HTTP");
		assert.match(payload.staleError.message, /API key not exist/u);
		assert.equal(payload.ttlSeconds, 120, "陈旧值用较短的重试窗口");
		assert.equal(payload.expiresAt >= before + 120_000, true);
	} finally {
		globalThis.fetch = original;
	}
});

test("上游失败且无缓存：返回 ok:false 与 502，并给出较短的重试 expiresAt", async () => {
	const { impl } = stubFetch([
		["/users/me/usage", () => jsonResponse({ detail: "boom" }, 500)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const before = Date.now();
		const { status, payload } = await readBalance(fakeCtx(), { apiKeyEnv: "FRESH_FAIL_KEY" }, { force: true });
		assert.equal(status, 502);
		assert.equal(payload.ok, false);
		assert.equal(payload.error.code, "UPSTREAM_HTTP");
		assert.match(payload.error.message, /HTTP 500/u);
		assert.equal(payload.ttlSeconds, 120);
		assert.equal(payload.expiresAt >= before + 120_000 && payload.expiresAt <= Date.now() + 120_000, true);
	} finally {
		globalThis.fetch = original;
	}
});

test("业务 code≠0 也算失败", async () => {
	const { impl } = stubFetch([
		["/users/me/usage", () => jsonResponse({ code: 999, message: "quota unavailable" })],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { status, payload } = await readBalance(fakeCtx(), { apiKeyEnv: "CODE_KEY" }, { force: true });
		assert.equal(status, 502);
		assert.equal(payload.error.code, "UPSTREAM_CODE");
		assert.match(payload.error.message, /quota unavailable/u);
	} finally {
		globalThis.fetch = original;
	}
});

test("凭据缺失：503 + CREDENTIAL_MISSING（且不联网）", async () => {
	const { impl, calls } = stubFetch([["/users/me", () => jsonResponse(SELF_BODY)]]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { status, payload } = await readBalance(fakeCtx(null), { apiKeyEnv: "ABSENT_KEY" }, { force: true });
		assert.equal(status, 503);
		assert.equal(payload.error.code, "CREDENTIAL_MISSING");
		assert.equal(calls.length, 0);
	} finally {
		globalThis.fetch = original;
	}
});

test("非法凭据引用名：CONFIG_INVALID", async () => {
	const { status, payload } = await readBalance(fakeCtx(), { apiKeyEnv: "not a ref" }, { force: true });
	assert.equal(status, 502);
	assert.equal(payload.error.code, "CONFIG_INVALID");
});

test("/users/me 失败不影响余额（账号信息降级为 null）", async () => {
	const { impl } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse({ detail: "nope" }, 404)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { status, payload } = await readBalance(fakeCtx(), { apiKeyEnv: "NO_SELF_KEY" }, { force: true });
		assert.equal(status, 200);
		assert.equal(payload.account, null);
		assert.equal(payload.monthRemainingUsd, 33.7);
	} finally {
		globalThis.fetch = original;
	}
});

// ── 与「当前模型提供商」挂钩 ────────────────────────────────────────────────

test("图灵 provider：按该 provider 自己的 apiKeyEnv 读余额，并回报 provider 身份", async () => {
	const { impl, calls } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { status, payload } = await readBalance(providerCtx(TURING_PROVIDERS), { apiKeyEnv: "PLUGIN_DEFAULT_KEY" }, { provider: "tcl2", force: true });
		assert.equal(status, 200);
		assert.equal(payload.ok, true);
		assert.equal(payload.provider, "tcl2");
		assert.equal(payload.apiKeyEnv, "TCL2_API_KEY", "用 provider 自己的引用，而不是插件默认引用");
		assert.equal(payload.monthRemainingUsd, 33.7);
		assert.match(calls[0].url, /^https:\/\/live-turing\.cn\.llm\.tcljd\.com\/api\/v1\/users\/me\/usage$/u);
	} finally {
		globalThis.fetch = original;
	}
});

test("非图灵 provider（linxi）：不联网、返回 hidden + PROVIDER_NOT_TURING", async () => {
	const { impl, calls } = stubFetch([["/users/me", () => jsonResponse(SELF_BODY)]]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { status, payload } = await readBalance(providerCtx(TURING_PROVIDERS), {}, { provider: "linxi", force: true });
		assert.equal(status, 200);
		assert.equal(payload.ok, false);
		assert.equal(payload.hidden, true);
		assert.equal(payload.error.code, "PROVIDER_NOT_TURING");
		assert.equal(payload.provider, "linxi");
		assert.equal(payload.providerBaseURL, "https://ai.docker.tcl.com/imaas/v1");
		assert.equal(calls.length, 0, "非图灵 provider 不应该打图灵接口");
	} finally {
		globalThis.fetch = original;
	}
});

test("前缀判定：只有以 providerPrefix 开头的 baseURL 才算图灵平台", async () => {
	const { impl, calls } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	const providers = {
		...TURING_PROVIDERS,
		lookalike: { apiKeyEnv: "X_KEY", baseURL: "https://live-turing.cn.llm.tcljd.com.evil.example/api/v1" },
		proxy: { apiKeyEnv: "X_KEY", baseURL: "https://my-proxy.internal/live-turing/forward" },
		blank: { apiKeyEnv: "X_KEY" }
	};
	try {
		for (const provider of ["lookalike", "proxy", "blank"]) {
			const { payload } = await readBalance(providerCtx(providers), {}, { provider, force: true });
			assert.equal(payload.hidden, true, `${provider} 不应被判为图灵平台`);
			assert.equal(payload.error.code, "PROVIDER_NOT_TURING");
		}
		// 大小写/首尾空白归一后仍算图灵
		const spaced = { tclX: { apiKeyEnv: "TCL1_API_KEY", baseURL: "  https://live-turing.cn.llm.tcljd.com/api/v1/  " } };
		const { payload } = await readBalance(providerCtx(spaced), {}, { provider: "tclX", force: true });
		assert.equal(payload.ok, true);
		assert.equal(payload.baseURL, "https://live-turing.cn.llm.tcljd.com/api/v1");
		assert.equal(calls.length > 0, true);
	} finally {
		globalThis.fetch = original;
	}
});

test("providerPrefix 可配置：换成别的网关前缀后判定跟着变", async () => {
	const { impl } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const config = { providerPrefix: "https://ai.docker.tcl.com/" };
		const turing = await readBalance(providerCtx(TURING_PROVIDERS), config, { provider: "tcl1", force: true });
		assert.equal(turing.payload.hidden, true, "默认图灵网关在新前缀下不再匹配");
		const linxi = await readBalance(providerCtx(TURING_PROVIDERS), config, { provider: "linxi", force: true });
		assert.equal(linxi.payload.ok, true, "linxi 在新前缀下匹配");
	} finally {
		globalThis.fetch = original;
	}
});

test("定位不到 provider 配置：hidden + PROVIDER_UNKNOWN（不猜）", async () => {
	const { impl, calls } = stubFetch([["/users/me", () => jsonResponse(SELF_BODY)]]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const { status, payload } = await readBalance(providerCtx(TURING_PROVIDERS), {}, { provider: "ghost", force: true });
		assert.equal(status, 200);
		assert.equal(payload.hidden, true);
		assert.equal(payload.error.code, "PROVIDER_UNKNOWN");
		assert.equal(calls.length, 0);
		// settings 服务缺失时同样认不出 → 不显示
		const noSettings = await readBalance(fakeCtx(), {}, { provider: "tcl1", force: true });
		assert.equal(noSettings.payload.error.code, "PROVIDER_UNKNOWN");
	} finally {
		globalThis.fetch = original;
	}
});

test("provider 未配置 apiKeyEnv：回落到插件默认引用（仍按图灵账号取数）", async () => {
	const { impl, calls } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		const providers = { tclBare: { baseURL: TURING_BASE } };
		const { payload } = await readBalance(providerCtx(providers), { apiKeyEnv: "PLUGIN_DEFAULT_KEY" }, { provider: "tclBare", force: true });
		assert.equal(payload.ok, true);
		assert.equal(payload.apiKeyEnv, "PLUGIN_DEFAULT_KEY");
		assert.equal(calls.length, 2);
	} finally {
		globalThis.fetch = original;
	}
});

test("不同 provider 分别缓存（换回上一个 provider 立刻命中，不串台）", async () => {
	const { impl, calls } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	const ctx = providerCtx(TURING_PROVIDERS);
	try {
		const config = { ttlSeconds: 300 };
		await readBalance(ctx, config, { provider: "tcl1", force: true });
		await readBalance(ctx, config, { provider: "tcl2", force: true });
		const before = calls.length;
		const back = await readBalance(ctx, config, { provider: "tcl1", force: false });
		assert.equal(calls.length, before, "换回 tcl1 应命中它自己的缓存");
		assert.equal(back.payload.cached, true);
		assert.equal(back.payload.provider, "tcl1");
		assert.equal(back.payload.apiKeyEnv, "TCL1_API_KEY");
	} finally {
		globalThis.fetch = original;
	}
});

test("路由层：query 解析（provider / refresh）、HEAD 无体、非 GET/HEAD 405", async () => {
	const { impl, calls } = stubFetch([
		["/users/me/usage", () => jsonResponse(USAGE_BODY)],
		["/users/me", () => jsonResponse(SELF_BODY)]
	]);
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	const handler = createHandler(providerCtx(TURING_PROVIDERS), () => ({ ttlSeconds: 300 }));
	const send = async (method, url) => {
		const res = fakeRes();
		await handler({ method, url }, res);
		return res.captured;
	};
	try {
		const ok = await send("GET", "/turing-balance?provider=tcl1");
		assert.equal(ok.status, 200);
		assert.equal(JSON.parse(ok.body).provider, "tcl1");
		assert.equal(ok.headers["cache-control"], "no-store");
		assert.match(ok.headers["content-type"], /application\/json/u);

		const before = calls.length;
		const cached = await send("GET", "/turing-balance?provider=tcl1");
		assert.equal(JSON.parse(cached.body).cached, true);
		assert.equal(calls.length, before, "第二次请求应命中 TTL 缓存");

		const refreshed = await send("GET", "/turing-balance?provider=tcl1&refresh=1");
		assert.equal(JSON.parse(refreshed.body).cached, undefined, "refresh=1 应跳过缓存");
		assert.equal(calls.length > before, true);

		const hidden = await send("GET", "/turing-balance?provider=linxi");
		const hiddenPayload = JSON.parse(hidden.body);
		assert.equal(hidden.status, 200);
		assert.equal(hiddenPayload.hidden, true);
		assert.equal(hiddenPayload.error.code, "PROVIDER_NOT_TURING");

		const head = await send("HEAD", "/turing-balance?provider=tcl1");
		assert.equal(head.status, 200);
		assert.equal(head.body, "", "HEAD 不带响应体");
		assert.equal(Number(head.headers["content-length"]) > 0, true);

		const post = await send("POST", "/turing-balance");
		assert.equal(post.status, 405);
		assert.equal(JSON.parse(post.body).error.code, "METHOD_NOT_ALLOWED");
	} finally {
		globalThis.fetch = original;
	}
});
