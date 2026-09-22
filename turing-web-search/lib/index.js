// dsh-turing-web-search — 独立插件（host 半区），loader 条目「turing-web-search」
//
// 为 ctx.web 注册一个搜索提供商：直连图灵网关（Turing）独立搜索端点（路径 B，
// 对照文档 https://live-turing-docs.cn.llm.tcljd.com/api-guides/capabilities/web-search/），
// 不走模型（无模型费），与 shipped 的 web-search-deepseek
// （Claude/DeepSeek /messages 模型路线）互斥可选 —— 启用哪个搜索插件，ctx.web
// 就用哪个方案（ctx.web 按“唯一可用提供商”选择；两个都启用会报歧义）。
//
// 引擎（settings 配置段 web-search-turing: 或条目 config 里 `engine` 字段，也可在
// 设置 → 插件 → 插件配置 的图灵卡片里选；值只认白名单，其余回落默认 baidu）：
//   - baidu（默认，仅中国区）：POST {baseURL}/proxy/baidu/search       {q, count}
//     → {code:0, data:{references:[{title,url,website,content,date,…}]}}
//   - tavily（全球，LLM-optimized）：POST {baseURL}/proxy/tavily/search {query, max_results}
//     → 透传 Tavily 官方 {results:[{title,url,content,score}]}
//   - firecrawl（全球，搜索与网页抓取）：POST {baseURL}/proxy/firecrawl/search {query, limit}
//     → {success, data:{web:[{url,title,description,…}]}}（只发 query/limit，表外字段会 422）
//   - cloudsway（搜索，中国区）：GET {baseURL}/proxy/cloudsway/search?q=…&count=…
//     → Bing 形状 {queryContext, webPages:{value:[{url,name,snippet,datePublished,…}]}}
//   - bing（Legacy Bing Proxy，自动路由 Baidu/Google）：POST {baseURL}/proxy/bing/v7.0/search {q, count}
//     → Bing 形状 webPages.value[]（历史接口，国内 Baidu / 国外 Google 自动路由）
// 条数参数各引擎不同：baidu 用 count、tavily 用 max_results、firecrawl 用 limit
// （上限 100）、cloudsway 用 count（上限 50）、bing 用 count（上限 25）。baseURL/apiKeyEnv 共用。
//
// 默认配置段命名空间：settings.yaml 的 `web-search-turing:`（settings-file 默认 watch，
// 热生效）；缺省 baseURL = 图灵 /api/v1，apiKeyEnv = TCL1_API_KEY（.credentials.yaml）。

import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/** Cordis 插件名（loader 诊断用）。 */
const name = "turing-web-search";
/** 本条目要求注入的服务：ctx.web（搜索缝）。settings 经 ctx.inject 惰性获取。 */
const inject = ["web"];

/** ctx.web 注册用的稳定提供商 id（用户可在 web.searchProvider 里指名）。 */
const PROVIDER_ID = "turing-search";

const DEFAULT_BASE_URL = "https://live-turing.cn.llm.tcljd.com/api/v1";
const DEFAULT_API_KEY_ENV = "TCL1_API_KEY";
const DEFAULT_ENGINE = "baidu";
const DEFAULT_COUNT = 10;

/**
 * 支持引擎白名单（settings 段 / 条目 config / UI 卡片共用同一组值；
 * 请求/解析差异见 {@link ENGINE_ROUTES}）。
 */
const ENGINES = Object.freeze(["baidu", "tavily", "firecrawl", "cloudsway", "bing"]);

/** engine 规范化：只认 {@link ENGINES} 白名单；未知/拼错值回落默认 baidu。 */
function normalizeEngine(value) {
	return typeof value === "string" && ENGINES.includes(value) ? value : DEFAULT_ENGINE;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

/**
 * 每引擎路由表（对照图灵文档 web-search/<engine>/ 各页）：
 *   method/path —— 方法与端点路径；
 *   queryKey     —— 查询词字段（q 或 query）；
 *   countKey     —— 条数参数名（null 表示不传）；
 *   maxCount     —— 条数上限（请求前钳制）；
 *   kind         —— 响应解析：references（code+data.references）| results（Tavily）
 *                   | firecrawl（success+data.<source>[]）| bingShape（webPages.value[]）。
 */
const ENGINE_ROUTES = Object.freeze({
	baidu: { method: "POST", path: "/proxy/baidu/search", queryKey: "q", countKey: "count", maxCount: Number.POSITIVE_INFINITY, kind: "references" },
	tavily: { method: "POST", path: "/proxy/tavily/search", queryKey: "query", countKey: "max_results", maxCount: Number.POSITIVE_INFINITY, kind: "results" },
	firecrawl: { method: "POST", path: "/proxy/firecrawl/search", queryKey: "query", countKey: "limit", maxCount: 100, kind: "firecrawl" },
	cloudsway: { method: "GET", path: "/proxy/cloudsway/search", queryKey: "q", countKey: "count", maxCount: 50, kind: "bingShape" },
	bing: { method: "POST", path: "/proxy/bing/v7.0/search", queryKey: "q", countKey: "count", maxCount: 25, kind: "bingShape" }
});

/** 配置 schema（条目 config 与 settings 段共用；缺省字段由代码回退补齐）。 */
const Config = z.object({
	engine: z.string().role("engine").default(DEFAULT_ENGINE),
	baseURL: z.string().role("url"),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	count: z.number().step(1).min(1).default(DEFAULT_COUNT)
});

/**
 * 本提供商 settings 配置段的命名空间（settings.yaml 顶层键）。
 * DSH 0.1.5 起命名空间就是普通字符串：`settingsNamespace()` 那个纯校验函数连同
 * `installSettingsSection` 一起从 dsh-settings 的导出里删掉了，改由
 * `settings.installSection()` 自己校验（必须是小写连字符标识符）。
 */
const SETTINGS_NAMESPACE = "web-search-turing";

/** 图灵 /proxy/<engine>/… 的稳定错误（取消/服务错误）。 */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
function aborted(signal) {
	return signal?.aborted === true;
}
function abortError(signal, fallback) {
	return new WebError("turing-web-search aborted", "WEB_ABORTED", { cause: aborted(signal) ? signal.reason : fallback });
}
function throwIfAborted(signal) {
	if (aborted(signal)) throw abortError(signal);
}
function raceAbortable(operation, signal) {
	if (signal === void 0) return operation;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}

/** 按引擎路由构造 { endpoint, url, method, body? }（GET 把参数拼进 query）。 */
function buildSearchRequest(route, options, request) {
	const count = clamp(options.count, 1, route.maxCount);
	const endpoint = `${options.baseURL}${route.path}`;
	if (route.method === "GET") {
		const query = new URLSearchParams();
		query.set(route.queryKey, request.query);
		if (route.countKey !== void 0) query.set(route.countKey, String(count));
		return { endpoint, url: `${endpoint}?${query}`, method: "GET" };
	}
	const body = { [route.queryKey]: request.query };
	if (route.countKey !== void 0) body[route.countKey] = count;
	return { endpoint, url: endpoint, method: "POST", body };
}

/** 逐条构造 ctx.web source（跳过无 url 的条目）。 */
function pushSource(sources, item, fields) {
	if (item?.url == null || item.url.length === 0) return;
	sources.push({
		url: item.url,
		...fields.title != null && fields.title.length > 0 ? { title: fields.title } : {},
		...fields.snippet != null && fields.snippet.length > 0 ? { snippet: fields.snippet } : {},
		...fields.publishedAt != null && fields.publishedAt.length > 0 ? { publishedAt: fields.publishedAt } : {}
	});
}

/** 把图灵各引擎的响应映射为 ctx.web 的 { sources }（kind 见 {@link ENGINE_ROUTES}）。 */
function mapStandaloneResponse(kind, parsed) {
	if (kind === "results") {
		const results = Array.isArray(parsed?.results) ? parsed.results : [];
		const sources = [];
		for (const item of results) pushSource(sources, item, { title: item?.title, snippet: item?.content });
		return { sources, truncated: false };
	}
	if (kind === "firecrawl") {
		if (parsed?.success === false) {
			const detail = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message ?? parsed?.message;
			throw new WebError(detail ?? "firecrawl search error", "WEB_PROVIDER_ERROR");
		}
		const sources = [];
		for (const group of ["web", "news", "images"]) {
			const items = parsed?.data?.[group];
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				pushSource(sources, item, {
					title: item?.title ?? item?.name,
					snippet: item?.description ?? item?.snippet ?? (Array.isArray(item?.highlights) ? item.highlights.join(" ") : void 0)
				});
			}
		}
		return { sources, truncated: false };
	}
	if (kind === "bingShape") {
		const items = Array.isArray(parsed?.webPages?.value) ? parsed.webPages.value : [];
		const sources = [];
		for (const item of items) {
			pushSource(sources, item, {
				title: item?.name,
				snippet: item?.snippet,
				publishedAt: item?.datePublished
			});
		}
		return { sources, truncated: false };
	}
	// kind === "references"（baidu）
	if (parsed?.code !== 0) throw new WebError(parsed?.message ?? "search engine error", "WEB_PROVIDER_ERROR");
	const references = parsed?.data?.references ?? [];
	const sources = [];
	for (const item of references) {
		pushSource(sources, item, { title: item?.title, snippet: item?.content, publishedAt: item?.date });
	}
	return { sources, truncated: false };
}

/** 一次操作的配置快照（settings 段可在搜索之间变化，每次搜索各取一份）。 */
function resolveOptions(ctx, config) {
	const source = config ?? {};
	const apiKeyEnv = credentialRef(source.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
	return {
		engine: normalizeEngine(source.engine),
		baseURL: source.baseURL ?? DEFAULT_BASE_URL,
		apiKeyEnv,
		count: Number.isInteger(source.count) && source.count > 0 ? source.count : DEFAULT_COUNT,
		resolveApiKey: async () => {
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) return (await credentials.resolve(apiKeyEnv))?.value;
			const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv);
			return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
		},
		recordRequest: (request) => {
			// NOTE: do NOT write this into the durable session log. Out-of-repo
			// plugin event types ("web/turing-search-request") are outside the
			// harness build's known-event catalog and Session.append in this
			// build cannot stamp the envelope's `ignorable` marker, so any log
			// containing one refuses to load ("SessionFormatUnsupportedError"),
			// bricking that session's history. Diagnostics go to the cordis
			// logger instead (never throws, never breaks the search path).
			const logger = ctx.logger;
			try {
				if (typeof logger === "function") logger("dsh-turing-web-search").debug?.("Turing search request sent", request);
				else logger?.debug?.("Turing search request sent", request);
			} catch {
				// diagnostics must never break the search path
			}
		}
	};
}

/** 图灵独立搜索提供商（无模型调用）。 */
class TuringSearchProvider {
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
	}
	id = PROVIDER_ID;
	available() {
		const options = this.resolveOptions();
		return options.apiKeyEnv !== void 0 && URL.canParse(options.baseURL);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const route = ENGINE_ROUTES[options.engine];
		const apiKey = await this.apiKey(options, signal);
		throwIfAborted(signal);
		const built = buildSearchRequest(route, options, request);
		options.recordRequest?.({
			endpoint: built.endpoint,
			method: built.method,
			apiVersion: "2023-06-01",
			...built.body !== void 0 ? { body: built.body } : {},
			...built.url.includes("?") ? { query: built.url.slice(built.url.indexOf("?")) } : {}
		});
		throwIfAborted(signal);
		let response;
		try {
			response = await fetch(built.url, {
				method: built.method,
				redirect: "error",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"user-agent": "dsh-turing-web-search",
					...built.method === "POST" ? { "content-type": "application/json", "accept": "application/json" } : { "accept": "*/*" }
				},
				...built.method === "POST" ? { body: JSON.stringify(built.body) } : {},
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			if (aborted(signal) || isAbortError(error)) throw abortError(signal, error);
			throw new WebError(`Turing ${options.engine} search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Turing ${options.engine} API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
				if (typeof detail === "string" && detail.length > 0) message = detail;
				else if (typeof parsed?.error === "string") message = parsed.error;
			} catch (error) {
				if (aborted(signal) || isAbortError(error)) throw abortError(signal, error);
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapStandaloneResponse(route.kind, await response.json());
		} catch (error) {
			if (aborted(signal) || isAbortError(error)) throw abortError(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(`Turing returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
	async apiKey(options, signal) {
		throwIfAborted(signal);
		let resolved;
		try {
			resolved = await raceAbortable(options.resolveApiKey?.() ?? Promise.resolve(void 0), signal);
		} catch (error) {
			if (aborted(signal)) throw abortError(signal, error);
			throw new WebError(`turing-web-search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (resolved !== void 0 && resolved.length > 0) return resolved;
		throw new WebError(`turing-web-search has no API key for "${options.apiKeyEnv}"; store it through the credentials service, export it in the launching environment, or set apiKeyEnv in the web-search-turing settings section`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
}

/** 注册 ctx.web 搜索提供商（启用本条目的前提是 ctx.web 已注入）。 */
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
	ctx.web.registerSearchProvider(new TuringSearchProvider(() => resolveOptions(ctx, current())));
}

export { Config, PROVIDER_ID, SETTINGS_NAMESPACE, TuringSearchProvider, apply, inject, name };
