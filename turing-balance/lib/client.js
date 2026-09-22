// dsh-turing-balance — client 半区（浏览器端）
//
// UI 位置：会话头部右侧动作区（conversation.session.header.actions）里的一枚余额徽章，
// 显示图灵平台（Turing）的「本月剩余额度」。
//
// **与当前模型提供商挂钩**：徽章只在「当前会话选中的 provider」的 baseURL 属于图灵平台
// （默认前缀 https://live-turing.cn.llm.tcljd.com/）时出现。判定在 host 侧做（provider 的
// baseURL/apiKeyEnv 在 settings 里，浏览器看不到），前端把 provider id 带上：
//   GET /turing-balance?provider=<id>
//     → ok:true                 当前 provider 是图灵 → 显示余额
//     → hidden:true（NOT_TURING / UNKNOWN） 不是图灵平台（或认不出）→ 不渲染徽章
// 切换 provider 时（宿主 RPC 选中新 provider → 共享的 ModelDirectory store 变更）会立刻
// 重新判定：非图灵 provider 的余额永远不会被短暂显示（数据必须自带同一个 provider id）。
//
// **取数策略（省请求）**：余额按 provider 存在前端内存里（`balanceCache`），host 载荷带
// `expiresAt`；切会话 / 切回某个 provider / 组件重挂载都直接复用缓存、**不发请求**，只有
// 「过期后」（按 expiresAt 排一次定时器）或「用户点击徽章」（`?refresh=1`）才重新取数。
// 非图灵 provider 既不显示也不排期（不产生任何后续请求）。
//
// 数据来源仍是同源 host 路由，API key 不进浏览器；本文件只 require 壳里预置的 react。

window.__ModuleLoader__.load({
	id: "dsh-turing-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region constants
		/** host 半区注册的余额路由（同源；与 lib/index.js 的 ROUTE_PATH 一致）。 */
		const ENDPOINT = "/turing-balance";
		/** 本卡片的 locale 字典命名空间。 */
		const NS = "dsh-turing-balance";
		/** host 没给 expiresAt/ttlSeconds 时的兜底有效期（秒）。 */
		const FALLBACK_TTL_SECONDS = 300;
		/** host 没给 expiresAt 时的失败重试间隔（毫秒）。 */
		const FALLBACK_RETRY_MS = 120_000;
		/** 排期下限/上限（避免抖动与离谱值；上限防「系统时钟跳变」把定时器排到天荒地老）。 */
		const MIN_DELAY_MS = 5_000;
		const MAX_DELAY_MS = 30 * 60 * 1000;
		/** 到期后多等一会儿再取，确保 host 侧那条缓存已经过期。 */
		const EXPIRY_MARGIN_MS = 1_000;
		/** 低于本月额度的这个比例时徽章转为警示色。 */
		const LOW_RATIO = 0.1;
		/** 这些错误码表示「本 provider 不适用」：直接不显示徽章（不是错误）。 */
		const HIDDEN_CODES = Object.freeze(["PROVIDER_NOT_TURING", "PROVIDER_UNKNOWN"]);
		//#endregion

		//#region state
		/**
		 * 前端内存缓存：provider → { state, expiresAt }。
		 * 切会话/重挂载直接复用（这就是「把 provider 对应的余额保存下来」）；页面刷新后自然重取。
		 */
		const balanceCache = new Map();
		/** 定时器接缝（测试可替换，业务代码只用这两个函数排期）。 */
		const clock = {
			setTimeout: (callback, ms) => setTimeout(callback, ms),
			clearTimeout: (id) => clearTimeout(id)
		};
		//#endregion

		//#region locales
		const zh = {
			loading: "图灵 …",
			label: "图灵 {remaining}",
			unavailable: "图灵 —",
			titleHeader: "图灵平台用量（Turing）",
			titleLoading: "正在读取图灵余额…",
			titleProvider: "模型提供商：{provider}",
			titleRemaining: "本月剩余：{remaining} / {quota}（{percent}）",
			titleRemainingNoQuota: "本月剩余：{remaining}",
			titleMonthUsage: "本月已用：{amount}",
			titleTotalUsage: "累计已用：{amount}",
			titleAccount: "账号：{username}",
			titleUpdated: "更新于 {time}",
			titleCached: "缓存有效期至 {time}（过期或点击才重新获取）",
			titleStale: "数据为上次成功值，最近一次刷新失败：{error}",
			titleError: "读取失败：{error}",
			titleClickRefresh: "点击刷新",
			titleClickRetry: "点击重试"
		};
		const en = {
			loading: "Turing …",
			label: "Turing {remaining}",
			unavailable: "Turing —",
			titleHeader: "Turing platform usage",
			titleLoading: "Reading the Turing balance…",
			titleProvider: "Provider: {provider}",
			titleRemaining: "Left this month: {remaining} / {quota} ({percent})",
			titleRemainingNoQuota: "Left this month: {remaining}",
			titleMonthUsage: "Used this month: {amount}",
			titleTotalUsage: "Used in total: {amount}",
			titleAccount: "Account: {username}",
			titleUpdated: "Updated {time}",
			titleCached: "Cached until {time} (refetched on expiry or click)",
			titleStale: "Showing the last successful value; the last refresh failed: {error}",
			titleError: "Read failed: {error}",
			titleClickRefresh: "Click to refresh",
			titleClickRetry: "Click to retry"
		};
		//#endregion

		//#region styles
		const css = [
			".dtb_root{align-items:center;display:inline-flex;min-width:0}",
			".dtb_trigger{appearance:none;border:0;background:0 0;color:var(--dsw-alias-label-tertiary,rgba(230,232,234,.6));cursor:pointer;font:inherit;font-size:12px;line-height:18px;min-height:28px;border-radius:6px;align-items:center;gap:5px;padding:3px 6px;display:inline-flex;white-space:nowrap}",
			".dtb_trigger:hover,.dtb_trigger:focus-visible{color:var(--dsw-alias-label-secondary,rgba(230,232,234,.8));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}",
			".dtb_trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:-2px}",
			".dtb_dot{border-radius:50%;flex:none;width:6px;height:6px;background:var(--dsw-alias-state-business-primary,#4c8dff)}",
			".dtb_dotLow{background:var(--dsw-alias-label-warning,#e8a33d)}",
			".dtb_dotError{background:var(--dsw-alias-label-error,#f2555a)}",
			".dtb_text{font-variant-numeric:tabular-nums}",
			".dtb_low{color:var(--dsw-alias-label-warning,#e8a33d)}",
			".dtb_error{color:var(--dsw-alias-label-quaternary,rgba(230,232,234,.45))}"
		].join("");
		const tagId = "dsh-turing-balance/BalanceBadge.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-turing-balance";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const C = {
			root: "dtb_root",
			trigger: "dtb_trigger",
			dot: "dtb_dot",
			dotLow: "dtb_dotLow",
			dotError: "dtb_dotError",
			text: "dtb_text",
			low: "dtb_low",
			error: "dtb_error"
		};
		//#endregion

		//#region helpers
		/** 拼接 className（跳过假值）。 */
		function cx(...values) {
			let out = "";
			for (const value of values) {
				if (!value) continue;
				if (typeof value === "string") out = out.length === 0 ? value : `${out} ${value}`;
			}
			return out;
		}
		/** USD 金额，两位小数；缺失值显示破折号。 */
		function formatUsd(value) {
			return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "—";
		}
		/** 本地时间 hh:mm:ss。 */
		function formatClock(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		/** 一个「无事发生」的稳定状态（provider 未知/不适用时用）。 */
		function idleState() {
			return { provider: null, phase: "idle", data: null, error: null };
		}
		/** 载荷的有效期截止时刻（毫秒）：优先 host 给的 expiresAt，其次由 ttlSeconds/fetchedAt 推算。 */
		function expiryOf(payload) {
			if (typeof payload?.expiresAt === "number" && Number.isFinite(payload.expiresAt)) return payload.expiresAt;
			const ttl = typeof payload?.ttlSeconds === "number" && payload.ttlSeconds > 0 ? payload.ttlSeconds : FALLBACK_TTL_SECONDS;
			const from = typeof payload?.fetchedAt === "number" && Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : Date.now();
			return from + ttl * 1000;
		}
		/**
		 * 取一次余额：把 host 的响应折算成「下一个组件状态 + 下次该在什么时候再取」。
		 * @param providerId - 当前模型提供商 id。
		 * @param force - true = 忽略 host 缓存强刷（用户点击刷新走这条）。
		 * @returns {Promise<{state: object, expiresAt: number|null}>} 状态与下次取数时刻（null = 不排期）。
		 */
		async function fetchBalance(providerId, force) {
			try {
				const query = `provider=${encodeURIComponent(providerId)}${force ? "&refresh=1" : ""}`;
				const response = await fetch(`${ENDPOINT}?${query}`, {
					headers: { accept: "application/json" },
					cache: "no-store"
				});
				let payload = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				if (payload === null || typeof payload !== "object") {
					return { state: { provider: providerId, phase: "error", data: null, error: `HTTP ${response.status}` }, expiresAt: Date.now() + FALLBACK_RETRY_MS };
				}
				if (payload.ok === true) {
					// host 必须明确回报「这就是 <provider> 的余额」才显示：provider 缺失或不一致
					// （例如 host 半区还是旧版、或这是上一轮的迟到响应）一律当成「未确认」→ 不显示也不排期。
					if (payload.provider !== providerId) return { state: { provider: providerId, phase: "loading", data: null, error: null }, expiresAt: null };
					return { state: { provider: providerId, phase: "ready", data: payload, error: null }, expiresAt: expiryOf(payload) };
				}
				const code = payload.error?.code;
				if (payload.hidden === true || HIDDEN_CODES.includes(code)) {
					// 本 provider 不适用：不显示、不缓存、不排期（不产生任何后续请求）
					return { state: { provider: providerId, phase: "hidden", data: null, error: payload.error?.message ?? null }, expiresAt: null };
				}
				return {
					state: { provider: providerId, phase: "error", data: null, error: payload.error?.message ?? `HTTP ${response.status}` },
					expiresAt: payload.expiresAt !== void 0 ? expiryOf(payload) : Date.now() + FALLBACK_RETRY_MS
				};
			} catch (error) {
				return {
					state: { provider: providerId, phase: "error", data: null, error: String(error?.message ?? error) },
					expiresAt: Date.now() + FALLBACK_RETRY_MS
				};
			}
		}
		//#endregion

		//#region component
		/**
		 * 会话头部的图灵余额徽章：跟随当前模型提供商（非图灵平台不显示），悬停看明细、点击刷新。
		 * @param props - 槽位给的运行期 props（t 翻译函数、sessionId、`directory` 为模型目录 store）。
		 * @returns 徽章按钮元素，或 null（provider 未知 / 非图灵 / 尚无数据）。
		 */
		function BalanceBadge(props) {
			const t = props.t;
			// 模型目录 store（由槽位 inject 提供；缺失时用 directoryOf 兜底，再缺失就整块不显示）
			const directory = props.directory ?? props.directoryOf?.(props.sessionId)?.store;
			const provider = react.useSyncExternalStore(
				react.useCallback((notify) => (directory === void 0 ? () => {} : directory.subscribe(notify)), [directory]),
				react.useCallback(() => (directory === void 0 ? null : directory.getSnapshot().current?.provider ?? null), [directory])
			);
			const [state, setState] = react.useState(idleState);
			/** 当前展示值的过期时刻（null = 不排期）；可见性回调据此决定要不要补一次。 */
			const expiresRef = react.useRef(null);
			/** 本轮 effect 的控制器（点击刷新时用它强制取数并重排期）。 */
			const controlRef = react.useRef(null);
			// provider 一变就重新判定：命中前端缓存直接显示（不发请求），否则取一次并按 expiresAt 排期
			react.useEffect(() => {
				if (provider === null) {
					expiresRef.current = null;
					setState(idleState());
					return;
				}
				let cancelled = false;
				let timer = null;
				const commit = (next, expiresAt) => {
					if (cancelled) return;
					if (next.phase === "ready" || next.phase === "error") balanceCache.set(provider, { state: next, expiresAt });
					else balanceCache.delete(provider);
					expiresRef.current = expiresAt;
					setState((previous) => {
						// 迟到的旧响应（provider 不一致）或本轮只是后台刷新时，不覆盖已有展示
						if (previous.provider === next.provider && next.phase === "loading") return previous;
						return next;
					});
				};
				const schedule = (expiresAt) => {
					if (timer !== null) {
						clock.clearTimeout(timer);
						timer = null;
					}
					if (cancelled || expiresAt === null) return;
					const delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, expiresAt - Date.now() + EXPIRY_MARGIN_MS));
					timer = clock.setTimeout(async () => {
						timer = null;
						const next = await fetchBalance(provider, false);
						commit(next.state, next.expiresAt);
						schedule(next.expiresAt);
					}, delay);
				};
				const run = async (force) => {
					const next = await fetchBalance(provider, force);
					commit(next.state, next.expiresAt);
					schedule(next.expiresAt);
				};
				controlRef.current = { refresh: () => void run(true) };
				const cached = balanceCache.get(provider);
				if (cached !== void 0 && cached.expiresAt !== null && cached.expiresAt > Date.now()) {
					// 切会话/切回同一个 provider/重挂载：直接用保存下来的余额，一次请求都不发
					commit(cached.state, cached.expiresAt);
					schedule(cached.expiresAt);
				} else {
					balanceCache.delete(provider);
					setState({ provider, phase: "loading", data: null, error: null });
					void run(false);
				}
				const onVisibility = () => {
					if (document.visibilityState !== "visible") return;
					// 切回标签页：只在已过期（或没有排期）时补一次，未过期就不打扰上游
					if (expiresRef.current === null || Date.now() >= expiresRef.current) void run(false);
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					cancelled = true;
					controlRef.current = null;
					if (timer !== null) clock.clearTimeout(timer);
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, [provider]);

			// provider 目录尚未加载时主动拉一次（与 composer 的模型选择器共用同一份目录）
			react.useEffect(() => {
				if (provider === null) props.loadDirectory?.();
			}, [provider, props.loadDirectory, props.sessionId]);

			// 显示条件：provider 已知 + 结果属于同一个 provider + 不是「非图灵」+ 有数据/明确失败
			if (provider === null) return null;
			if (state.provider !== provider) return null;
			if (state.phase === "idle" || state.phase === "hidden") return null;
			if (state.phase === "error") {
				const errorTitle = [
					t("titleHeader"),
					t("titleProvider", { provider }),
					t("titleError", { error: state.error ?? "" }),
					t("titleClickRetry")
				].join("\n");
				return react.createElement("div", { className: C.root }, react.createElement("button", {
					type: "button",
					className: cx(C.trigger, C.error),
					title: errorTitle,
					"aria-label": errorTitle,
					onClick: () => {
						controlRef.current?.refresh();
					}
				}, [
					react.createElement("span", { className: cx(C.dot, C.dotError), key: "dot", "aria-hidden": "true" }),
					react.createElement("span", { className: C.text, key: "label" }, t("unavailable"))
				]));
			}
			const data = state.data;
			if (data === null) return null;
			const remaining = typeof data.monthRemainingUsd === "number" ? data.monthRemainingUsd : null;
			const quota = typeof data.quotaPerMonthUsd === "number" ? data.quotaPerMonthUsd : null;
			const low = remaining !== null && quota !== null && quota > 0 && remaining <= quota * LOW_RATIO;
			const label = t("label", { remaining: formatUsd(remaining) });
			const lines = [t("titleHeader"), t("titleProvider", { provider })];
			const remainingText = formatUsd(remaining);
			if (quota !== null && quota > 0 && remaining !== null) {
				lines.push(t("titleRemaining", { remaining: remainingText, quota: formatUsd(quota), percent: `${Math.round((remaining / quota) * 100)}%` }));
			} else {
				lines.push(t("titleRemainingNoQuota", { remaining: remainingText }));
			}
			if (typeof data.monthUsageUsd === "number") lines.push(t("titleMonthUsage", { amount: formatUsd(data.monthUsageUsd) }));
			if (typeof data.totalUsageUsd === "number") lines.push(t("titleTotalUsage", { amount: formatUsd(data.totalUsageUsd) }));
			if (data.account?.username) lines.push(t("titleAccount", { username: data.account.username }));
			lines.push(t("titleUpdated", { time: formatClock(data.fetchedAt) }));
			if (data.cached === true) lines.push(t("titleCached", { time: formatClock(data.expiresAt) }));
			if (data.stale === true) lines.push(t("titleStale", { error: data.staleError?.message ?? "" }));
			lines.push(t("titleClickRefresh"));
			const title = lines.join("\n");

			return react.createElement("div", { className: C.root }, react.createElement("button", {
				type: "button",
				className: cx(C.trigger, low && C.low),
				title,
				"aria-label": title,
				onClick: () => {
					controlRef.current?.refresh();
				}
			}, [
				react.createElement("span", { className: cx(C.dot, low && C.dotLow), key: "dot", "aria-hidden": "true" }),
				react.createElement("span", { className: C.text, key: "label" }, label)
			]));
		}
		//#endregion

		//#region apply
		/**
		 * 需要注入的服务。**故意不注入 `modelDirectories`**：它只用来读「当前 provider」，
		 * 缺了它徽章就不显示（宁可不显示，也不显示错账号的余额）。
		 */
		const inject = ["slots", "locale"];
		/** 按 sessionId 取该会话的模型目录（会话未就绪/寻址子代理会话时返回 undefined）。 */
		function directoryOf(ctx, sessionId) {
			try {
				return ctx.get("modelDirectories")?.directoryFor(sessionId);
			} catch {
				return void 0;
			}
		}
		/** 挂载：注册字典，并把徽章登记进会话头部动作槽（带模型目录与兜底解析）。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-turing-balance: dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "turing-balance",
				order: 10,
				locale: NS,
				inject: (sessionId) => {
					const directory = directoryOf(ctx, sessionId);
					return {
						directory: directory?.store,
						loadDirectory: directory === void 0 ? void 0 : () => {
							directory.load().catch(() => {});
						},
						directoryOf: (id) => directoryOf(ctx, id)
					};
				}
			}, BalanceBadge));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** 测试接缝：内存缓存、排期定时器、到期换算（运行时只由组件内部使用）。 */
		exports.__test = { balanceCache, clock, expiryOf };
		return module.exports;
	}
});
