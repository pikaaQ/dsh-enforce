// dsh-turing-balance — 独立插件（host 半区），loader 条目「turing-balance」
//
// 在 DSH Web 里显示图灵平台（Turing）的余额。余额就是 ai.eaglelab.tcl.com
// 「用量管理」页上的「本月剩余额度」，其数据源是同网关的
//   GET {baseURL}/users/me/usage        （Authorization: Bearer <API key>）
// 返回体（实测）：
//   { code:0, data:{ user_tier, tier_remaining_days, quota_per_month_in_usd,
//                    current_month_usage_in_usd, current_month_remaining_quota_in_usd,
//                    total_usage_in_usd, pools:[{pool_type, quota_per_month_in_usd, ...}] } }
// 其中 current_month_remaining_quota_in_usd 即「本月剩余额度」。同一个 key
// 也能读 GET {baseURL}/users/me（账号名/邮箱，用于确认这是谁的余额）。
//
// 本半区做两件事：
//   1) 注册 settings 段 `turing-balance:`（baseURL / apiKeyEnv / providerPrefix /
//      ttlSeconds，settings-file watch 热生效）；
//   2) 注册一条只读 HTTP 路由 GET /turing-balance（`?provider=<id>` 按「当前选中的模型
//      提供商」判定，`?refresh=1` 强制刷新），把上面的字段归一化成 JSON 给浏览器端徽章。
//
// 取数策略（省请求）：余额**按 provider 缓存**（一个 provider 一个账号 → 一条缓存），TTL
// 默认 300s（settings 段 ttlSeconds）；载荷带 `ttlSeconds` + `expiresAt`，浏览器端据此排期
// ——切会话/切回某个 provider/页面重挂载都直接吃缓存，只有**过期后**或**用户点击徽章**才重新
// 取数（点击走 `?refresh=1` 绕过缓存）。失败/陈旧值给较短的 expiresAt（≤120s）以便自动重试。
//
// **与模型提供商挂钩**：`?provider=<id>` 时先解出该 provider 的 baseURL（settings 里
// `llm-pi-ai.providers.<id>.baseURL`，经 llm 服务的 settingsNs/settingsPath 定位），
// 只有它以 `providerPrefix`（默认 https://live-turing.cn.llm.tcljd.com/）开头才去读余额，
// 并用**该 provider 自己的 apiKeyEnv**（不同 provider 可能是不同图灵账号）；否则返回
// `{ok:false, hidden:true, error:{code:"PROVIDER_NOT_TURING"}}`，浏览器端据此不显示徽章。
//
// 为什么走本机 HTTP 路由、而不是把 key 交给浏览器：API key 只在 host 侧经凭据
// 服务解析，浏览器只拿到数字；同源 fetch 不涉及 CORS，key 也不会出现在页面里。

import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

/** Cordis 插件名（loader 诊断用）。 */
const name = "turing-balance";
/** 本条目要求注入的服务：webServer（注册 /turing-balance 路由）。 */
const inject = ["webServer"];

/** 图灵网关默认地址（与 turing-web-search 同源；ai.eaglelab.tcl.com 控制台的 baseURL）。 */
const DEFAULT_BASE_URL = "https://live-turing.cn.llm.tcljd.com/api/v1";
/** 默认凭据引用（$DSH_HOME/.credentials.yaml 里的名字）。 */
const DEFAULT_API_KEY_ENV = "TCL1_API_KEY";
/**
 * 缓存 TTL 默认 5 分钟：切会话 / 刷新页面 / 切回某个 provider 都直接吃缓存，
 * 只有超时或用户点击刷新才重新请求（前端按载荷里的 expiresAt 排期，不做定时轮询）。
 */
const DEFAULT_TTL_SECONDS = 300;
/** 失败/陈旧值的最长自动重试间隔（避免坏上游被 5 分钟一次地干等）。 */
const STALE_RETRY_SECONDS = 120;
/**
 * 判定「当前模型提供商是不是图灵平台」的 baseURL 前缀：只有当前会话选中的
 * provider 的 baseURL 以它开头时，徽章才显示（否则该 provider 不是图灵平台提供方）。
 */
const DEFAULT_PROVIDER_PREFIX = "https://live-turing.cn.llm.tcljd.com/";
/** llm 服务缺失时，按 pi-ai 路由的约定读提供商配置。 */
const FALLBACK_PROVIDER_NS = "llm-pi-ai";
const FALLBACK_PROVIDER_PATH = "providers";
/** 本插件注册的 HTTP 路由（浏览器端徽章固定请求这个路径）。 */
const ROUTE_PATH = "/turing-balance";
const REQUEST_TIMEOUT_MS = 15_000;
const USAGE_ROUTE = "/users/me/usage";
const PROFILE_ROUTE = "/users/me";
/** 缓存条目上限（按 provider/账号分别缓存，超出丢最旧）。 */
const CACHE_LIMIT = 8;

/** 配置 schema（条目 config 与 settings 段共用；缺省字段由代码回退补齐）。 */
const Config = z.object({
	baseURL: z.string().role("url"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	providerPrefix: z.string().default(DEFAULT_PROVIDER_PREFIX),
	ttlSeconds: z.number().step(1).min(1).default(DEFAULT_TTL_SECONDS)
});

/**
 * 本插件 settings 配置段的命名空间（settings.yaml 顶层键）。
 * DSH 0.1.5 起命名空间就是普通字符串：`settingsNamespace()` 那个纯校验函数连同
 * `installSettingsSection` 一起从 dsh-settings 的导出里删掉了，改由
 * `settings.installSection()` 自己校验（必须是小写连字符标识符）。
 */
const SETTINGS_NAMESPACE = "turing-balance";

/** 带稳定机器码的余额读取失败（路由据此选 HTTP 状态码，浏览器据此显示文案）。 */
class BalanceError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "BalanceError";
		this.code = code;
	}
}

/** 凭据引用名语法（POSIX shell 标识符）；不合法时 credentialRef 会 throw。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 归一化图灵 /users/me/usage 的 data 段：字段名保持原样（USD 金额），缺字段为 null。
 * @param {unknown} data - 响应体的 data 段。
 * @returns {object} 浏览器徽章用的金额/套餐字段。
 */
function normalizeUsage(data) {
	const pools = Array.isArray(data?.pools)
		? data.pools.map((pool) => ({
			poolType: typeof pool?.pool_type === "string" ? pool.pool_type : null,
			quotaPerMonthUsd: finiteNumber(pool?.quota_per_month_in_usd),
			currentMonthUsageUsd: finiteNumber(pool?.current_month_usage_in_usd)
		}))
		: [];
	return {
		/** 套餐月度额度（USD）。 */
		quotaPerMonthUsd: finiteNumber(data?.quota_per_month_in_usd),
		/** 「本月剩余额度」——控制台用量管理页显示的那个数。 */
		monthRemainingUsd: finiteNumber(data?.current_month_remaining_quota_in_usd),
		/** 本月已用（USD）。 */
		monthUsageUsd: finiteNumber(data?.current_month_usage_in_usd),
		/** 累计已用（USD）。 */
		totalUsageUsd: finiteNumber(data?.total_usage_in_usd),
		/** 用户档位（图灵内部编号，仅透传展示）。 */
		userTier: finiteNumber(data?.user_tier),
		/** 档位剩余天数（可能为 null）。 */
		tierRemainingDays: finiteNumber(data?.tier_remaining_days),
		pools
	};
}

/**
 * 请求图灵接口并解析 JSON：HTTP 非 2xx 与业务 code≠0 都抛 {@link BalanceError}。
 * @param {string} url - 完整 URL。
 * @param {string} apiKey - API key（Bearer）。
 * @returns {Promise<object>} 解析后的响应体。
 */
async function requestJson(url, apiKey) {
	let response;
	try {
		response = await fetch(url, {
			method: "GET",
			redirect: "error",
			headers: {
				"authorization": `Bearer ${apiKey}`,
				"accept": "application/json",
				"user-agent": "dsh-turing-balance"
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		throw new BalanceError("UPSTREAM_UNREACHABLE", `请求图灵接口失败：${String(error?.message ?? error)}`);
	}
	let parsed;
	try {
		parsed = await response.json();
	} catch {
		parsed = void 0;
	}
	if (!response.ok) {
		const detail = parsed?.message ?? parsed?.detail ?? parsed?.error?.message ?? (typeof parsed?.error === "string" ? parsed.error : void 0);
		throw new BalanceError("UPSTREAM_HTTP", `图灵接口返回 HTTP ${response.status}${typeof detail === "string" && detail.length > 0 ? `：${detail}` : ""}`);
	}
	if (parsed === void 0 || parsed === null || typeof parsed !== "object") {
		throw new BalanceError("UPSTREAM_BODY", "图灵接口返回了无法解析的响应体");
	}
	if (parsed.code !== void 0 && parsed.code !== 0) {
		throw new BalanceError("UPSTREAM_CODE", `图灵接口返回 code=${String(parsed.code)}${typeof parsed.message === "string" ? `：${parsed.message}` : ""}`);
	}
	return parsed;
}

/**
 * 解析生效配置（settings 段可在两次读取之间变化，每次读取各取一份）。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 插件上下文。
 * @param {object} config - 生效配置源。
 * @returns {object} 规范化配置 + 凭据解析器。
 */
function resolveOptions(ctx, config) {
	const source = config ?? {};
	const apiKeyEnv = typeof source.apiKeyEnv === "string" && source.apiKeyEnv.length > 0 ? source.apiKeyEnv : DEFAULT_API_KEY_ENV;
	const baseURL = (typeof source.baseURL === "string" && source.baseURL.length > 0 ? source.baseURL : DEFAULT_BASE_URL).replace(/\/+$/u, "");
	const providerPrefix = typeof source.providerPrefix === "string" && source.providerPrefix.length > 0 ? source.providerPrefix : DEFAULT_PROVIDER_PREFIX;
	return {
		baseURL,
		apiKeyEnv,
		providerPrefix,
		ttlSeconds: Number.isInteger(source.ttlSeconds) && source.ttlSeconds > 0 ? source.ttlSeconds : DEFAULT_TTL_SECONDS,
		resolveApiKey: async (ref) => {
			const name = ref ?? apiKeyEnv;
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) {
				const resolved = await credentials.resolve(credentialRef(name));
				if (resolved !== void 0 && typeof resolved.value === "string" && resolved.value.length > 0) return resolved.value;
			}
			const ambient = launchEnvironmentOf(ctx).get(name);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		}
	};
}

/**
 * 读 settings 文档里某个 (ns, path) 处的**生效**值（无该段/路径不存在则 undefined）。
 * @param {object} settings - host `settings` 服务。
 * @param {string} ns - 配置命名空间（如 "llm-pi-ai"）。
 * @param {string[]} path - 段内路径。
 * @returns {unknown} 该处的生效值。
 */
function settingsValueAt(settings, ns, path) {
	let descriptor;
	try {
		for (const candidate of settings.describe?.() ?? []) {
			if (candidate.ns === ns) {
				descriptor = candidate;
				break;
			}
		}
	} catch {
		return void 0;
	}
	let node = descriptor?.value;
	for (const segment of path) {
		if (node === null || typeof node !== "object") return void 0;
		node = node[segment];
	}
	return node;
}

/**
 * 解析一个模型提供商的 `{ baseURL, apiKeyEnv }`（读 settings 里的生效配置）：
 * 先问 `llm` 服务这个 provider 的配置落在哪个 ns/路径（pi-ai 路由形如
 * `llm-pi-ai.providers.<id>`），拿不到就按 pi-ai 约定兜底。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 插件上下文。
 * @param {string} providerId - 模型提供商 id（会话当前选中的 provider）。
 * @returns {{baseURL: string|null, apiKeyEnv: string|null, ns: string, path: string[]}|undefined} 提供商配置；无法定位时 undefined。
 */
function resolveProviderProfile(ctx, providerId) {
	const settings = ctx.get("settings");
	if (settings === void 0) return void 0;
	let ns = FALLBACK_PROVIDER_NS;
	let path = [FALLBACK_PROVIDER_PATH, providerId];
	try {
		const entry = ctx.get("llm")?.listConfigurableProviders?.().find((row) => row.provider === providerId);
		if (entry !== void 0 && typeof entry.settingsNs === "string") {
			ns = entry.settingsNs;
			path = Array.isArray(entry.settingsPath) ? [...entry.settingsPath] : path;
		}
	} catch {
		// llm 服务不可用/未声明该 provider：按约定兜底
	}
	const profile = settingsValueAt(settings, ns, path);
	if (profile === null || typeof profile !== "object") return void 0;
	return {
		baseURL: typeof profile.baseURL === "string" && profile.baseURL.length > 0 ? profile.baseURL : null,
		apiKeyEnv: typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.length > 0 ? profile.apiKeyEnv : null,
		ns,
		path
	};
}

/** 该提供商的地址是否属于图灵平台（前缀判定，大小写与首尾空白已归一）。 */
function isTuringProvider(baseURL, prefix) {
	return typeof baseURL === "string" && baseURL.trim().startsWith(prefix);
}

/**
 * 「不该显示」的载荷：当前 provider 不是图灵平台提供方（或定位不到它的配置）。
 * HTTP 200 + `hidden:true`：这不是错误，而是「本 provider 不适用」。
 * @param {string} code - PROVIDER_NOT_TURING | PROVIDER_UNKNOWN。
 * @param {string} message - 说明文案（浏览器端在悬停里能看到原因）。
 * @param {object} extra - provider / providerBaseURL 等附加字段。
 * @returns {{status: number, payload: object}} 结果。
 */
function hiddenPayload(code, message, extra) {
	return {
		status: 200,
		payload: {
			ok: false,
			hidden: true,
			fetchedAt: Date.now(),
			...extra,
			error: { code, message }
		}
	};
}

/** 缓存：按 `baseURL|apiKeyEnv` 分别缓存（一个 provider 一个账号，即「按 provider 保存余额」）。 */
const cache = new Map();

/** 缓存条目的过期时刻（`at` 为写入时刻；TTL 用**当前**配置，改设置立刻生效）。 */
function expiresAtOf(at, ttlSeconds) {
	return at + ttlSeconds * 1000;
}

/** 读缓存（未过期才返回条目本身，调用方需要 `at` 来算 expiresAt）。 */
function cacheGet(cacheKey, ttlSeconds) {
	const entry = cache.get(cacheKey);
	if (entry === void 0) return void 0;
	if (Date.now() - entry.at >= ttlSeconds * 1000) return void 0;
	return entry;
}

/** 写缓存（超上限丢最旧）。 */
function cacheSet(cacheKey, payload) {
	cache.set(cacheKey, { at: Date.now(), payload });
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (oldest.done === true) break;
		cache.delete(oldest.value);
	}
}

/**
 * 读取一次余额。
 *
 * `request.provider` 非空时按「当前选中的模型提供商」判定：该 provider 的 baseURL
 * 必须以图灵前缀开头，否则返回 `hidden` 载荷（浏览器端据此不显示徽章）；命中时用
 * **该 provider 自己的 apiKeyEnv**（不同 provider 可能属于不同图灵账号）取余额。
 * 不传 provider 时退回插件自身配置的 baseURL/apiKeyEnv（便于命令行自查）。
 *
 * 命中缓存直接返回（并回报该值何时过期，前端据此排期）；失败时回落该 provider 的
 * 上次成功值并标记 stale。载荷一律带 `ttlSeconds` + `expiresAt`：浏览器端只在过期后
 * 或用户点击刷新时才会再来要数，不做定时轮询。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 插件上下文。
 * @param {object} config - 生效配置。
 * @param {{provider?: string|null, force?: boolean}} request - provider 与是否强制刷新。
 * @returns {Promise<{status: number, payload: object}>} HTTP 状态码与载荷。
 */
async function readBalance(ctx, config, request) {
	const options = resolveOptions(ctx, config);
	const settings = request ?? {};
	const providerId = typeof settings.provider === "string" && settings.provider.length > 0 ? settings.provider : null;
	const force = settings.force === true;

	let target = { baseURL: options.baseURL, apiKeyEnv: options.apiKeyEnv, provider: null, providerBaseURL: null };
	if (providerId !== null) {
		const profile = resolveProviderProfile(ctx, providerId);
		if (profile === void 0) {
			return hiddenPayload("PROVIDER_UNKNOWN", `定位不到模型提供商 "${providerId}" 的配置，无法判断它是不是图灵平台，不显示余额`, { provider: providerId });
		}
		if (!isTuringProvider(profile.baseURL, options.providerPrefix)) {
			return hiddenPayload(
				"PROVIDER_NOT_TURING",
				`当前模型提供商 "${providerId}" 的地址是 ${profile.baseURL ?? "(未配置 baseURL)"}，不属于图灵平台（应为 ${options.providerPrefix} 前缀），不显示余额`,
				{ provider: providerId, providerBaseURL: profile.baseURL }
			);
		}
		target = {
			baseURL: profile.baseURL.trim().replace(/\/+$/u, ""),
			apiKeyEnv: profile.apiKeyEnv ?? options.apiKeyEnv,
			provider: providerId,
			providerBaseURL: profile.baseURL
		};
	}

	const cacheKey = `${target.baseURL}|${target.apiKeyEnv}`;
	if (!force) {
		const hit = cacheGet(cacheKey, options.ttlSeconds);
		if (hit !== void 0) {
			return {
				status: 200,
				payload: {
					...hit.payload,
					cached: true,
					ttlSeconds: options.ttlSeconds,
					expiresAt: expiresAtOf(hit.at, options.ttlSeconds),
					provider: target.provider,
					providerBaseURL: target.providerBaseURL
				}
			};
		}
	}

	try {
		if (!REF_PATTERN.test(target.apiKeyEnv)) {
			throw new BalanceError("CONFIG_INVALID", `apiKeyEnv "${target.apiKeyEnv}" 不是合法的凭据引用名（应为 POSIX shell 标识符）`);
		}
		const apiKey = await options.resolveApiKey(target.apiKeyEnv);
		if (apiKey === void 0) {
			throw new BalanceError("CREDENTIAL_MISSING", `没有解析到凭据 "${target.apiKeyEnv}"（模型提供商 ${target.provider ?? "(默认)"} 用的引用）：请在 $DSH_HOME/.credentials.yaml 里配置，或把设置段的 apiKeyEnv 指向另一个引用`);
		}
		const [usage, self] = await Promise.all([
			requestJson(`${target.baseURL}${USAGE_ROUTE}`, apiKey),
			requestJson(`${target.baseURL}${PROFILE_ROUTE}`, apiKey).catch(() => void 0)
		]);
		const account = typeof self?.data?.username === "string"
			? {
				username: self.data.username,
				email: typeof self.data.email === "string" ? self.data.email : null,
				userId: typeof self.data.user_id === "string" ? self.data.user_id : null
			}
			: null;
		const fetchedAt = Date.now();
		const payload = {
			ok: true,
			stale: false,
			fetchedAt,
			ttlSeconds: options.ttlSeconds,
			expiresAt: expiresAtOf(fetchedAt, options.ttlSeconds),
			provider: target.provider,
			providerBaseURL: target.providerBaseURL,
			baseURL: target.baseURL,
			apiKeyEnv: target.apiKeyEnv,
			account,
			...normalizeUsage(usage?.data)
		};
		cacheSet(cacheKey, payload);
		return { status: 200, payload };
	} catch (error) {
		const code = error instanceof BalanceError ? error.code : "UNEXPECTED";
		const message = String(error?.message ?? error);
		const now = Date.now();
		// 失败/陈旧值：让前端在较短间隔后自动重试（但仍远低于一次点击一次的频率）
		const retrySeconds = Math.min(options.ttlSeconds, STALE_RETRY_SECONDS);
		const previous = cache.get(cacheKey);
		if (previous !== void 0) {
			return {
				status: 200,
				payload: {
					...previous.payload,
					cached: true,
					stale: true,
					staleError: { code, message },
					ttlSeconds: retrySeconds,
					expiresAt: expiresAtOf(now, retrySeconds),
					provider: target.provider,
					providerBaseURL: target.providerBaseURL
				}
			};
		}
		return {
			status: code === "CREDENTIAL_MISSING" ? 503 : 502,
			payload: {
				ok: false,
				hidden: false,
				fetchedAt: now,
				ttlSeconds: retrySeconds,
				expiresAt: expiresAtOf(now, retrySeconds),
				provider: target.provider,
				providerBaseURL: target.providerBaseURL,
				baseURL: target.baseURL,
				apiKeyEnv: target.apiKeyEnv,
				error: { code, message }
			}
		};
	}
}

/** 写一个 JSON 响应（HEAD 只发头）。 */
function respond(res, status, payload, headOnly) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(headOnly ? void 0 : body);
}

/**
 * 构造 /turing-balance 的处理器（只读；GET/HEAD）。
 * @param {import("@deepseek-ai/cordis").Context} ctx - 插件上下文。
 * @param {() => object} config - 取当前生效配置。
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>} 处理器。
 */
function createHandler(ctx, config) {
	return async (req, res) => {
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") {
			respond(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支持 GET / HEAD" } }, false);
			return;
		}
		let url;
		try {
			url = new URL(req.url ?? ROUTE_PATH, "http://localhost");
		} catch {
			respond(res, 400, { ok: false, error: { code: "BAD_REQUEST", message: "无法解析请求 URL" } }, false);
			return;
		}
		const force = url.searchParams.get("refresh") === "1";
		const provider = url.searchParams.get("provider");
		let result;
		try {
			result = await readBalance(ctx, config(), { provider, force });
		} catch (error) {
			result = {
				status: 500,
				payload: { ok: false, fetchedAt: Date.now(), error: { code: "UNEXPECTED", message: String(error?.message ?? error) } }
			};
		}
		respond(res, result.status, result.payload, method === "HEAD");
	};
}

/** 注册设置段与 /turing-balance 路由。 */
function apply(ctx, config) {
	let current = () => config;
	// settings 是可选服务：按官方 0.1.5 的写法惰性注入，注册成功后再把它当配置来源，
	// settings 缺席（或稍后卸载）时继续用条目自带的 composition config。
	ctx.inject(["settings"], (settingsCtx) => {
		const hooks = {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {}
		};
		// 0.1.5 的官方写法（provider 上的 installSection）。
		if (typeof settingsCtx.settings?.installSection === "function") {
			settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, hooks);
			return;
		}
		// 更早的 DSH 没有 installSection：用同一个 provider 的 register() 达到等价效果
		// （旧版的 installSettingsSection 内部就是这两步）。目的只是别让一次注册把整棵插件树
		// 拖挂、导致 dsh web 起不来，同时设置段仍然生效。
		const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, Config, { base: config });
		hooks.setSource(() => scope.get());
	});
	ctx.effect(
		() => ctx.webServer.register({ kind: "exact", path: ROUTE_PATH, handler: createHandler(ctx, () => current()) }),
		"turing-balance: /turing-balance route"
	);
}

export { Config, DEFAULT_PROVIDER_PREFIX, ROUTE_PATH, SETTINGS_NAMESPACE, apply, createHandler, inject, isTuringProvider, name, normalizeUsage, readBalance, resolveProviderProfile };
