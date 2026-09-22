// dsh-provider-manager — client 半区（浏览器端）
//
// UI 位置（DSH 0.1.5 起）：设置 → 模型 页的 **footer 插槽**（官方扩展点
// `settings.models.footer`，list 型：id + order + label，无注册者时该区域不渲染任何东西）。
// 面板列出全部可停用/启用的模型提供商（host 的 `providerToggle.list()` 本就包含
// active / 已配置 / 本插件停用过的行，以及已从目录消失但被本插件停用过的行），
// 每行一个 停用/启用 按钮，按钮走本包的 Typert Remote `providerToggle.setEnabled`。
//
// 为什么不再打 bundle 补丁：0.1.1 时代 shipped 的 models 页没有任何扩展点，只能外科手术式
// 注入按钮（原 scripts/patch-models-bundle.mjs 的 v1/v2）；0.1.5 提供了官方插槽，于是改为注册
// 贡献——不碰官方 bundle、升级不会失配，且 host 侧 list() 早已覆盖"停用后从列表消失"的行，
// 所以原 v2 的"伪行"补丁逻辑不再需要。
//
// 本 client 还负责 $mount providerToggle Remote 命名空间（校验在 host 侧）。
window.__ModuleLoader__.load({
	id: "dsh-provider-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require("react");

		/** Cordis 服务注入：remote（Typert 客户端）+ slots（设置页插槽）。 */
		const inject = ["remote", "slots"];

		/** 需要注入的客户端 Remote 描述符（客户端只做透传，校验在 Host 侧）。 */
		const passthrough = { parse: (value) => value };

		const CONTRIBUTION = {
			package: "dsh-provider-manager",
			descriptors: [{
				id: "dsh-provider-manager#providerToggle/list",
				service: "providerToggle",
				namespace: "providerToggle",
				method: "list",
				invocation: { kind: "direct" },
				parameters: [],
				result: {
					mode: "strict",
					typeSymbol: "dsh-provider-manager/types#ProviderListResult",
					schema: passthrough
				}
			}, {
				id: "dsh-provider-manager#providerToggle/setEnabled",
				service: "providerToggle",
				namespace: "providerToggle",
				method: "setEnabled",
				invocation: { kind: "direct" },
				parameters: [{
					name: "request",
					wire: "request",
					source: "json",
					codec: {
						mode: "strict",
						typeSymbol: "dsh-provider-manager/types#ProviderSetEnabledRequest",
						schema: passthrough
					}
				}],
				result: {
					mode: "strict",
					typeSymbol: "dsh-provider-manager/types#ProviderSetEnabledResult",
					schema: passthrough
				}
			}]
		};

		const S = {
			panel: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" },
			title: { opacity: 0.7, fontSize: "12px" },
			list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" },
			row: { display: "flex", alignItems: "center", gap: "8px", justifyContent: "space-between" },
			name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			id: { opacity: 0.55, fontSize: "12px", marginLeft: "6px" },
			badge: { opacity: 0.7, fontSize: "12px" },
			button: { flex: "0 0 auto" }
		};

		/**
		 * 提供商 停用/启用 面板。
		 * `callToggle` 由 apply 注入（闭包持有 live ctx，所以 Remote 命名空间挂载完成后再取也拿得到）。
		 */
		function ProviderTogglePanel({ callToggle }) {
			const [state, setState] = react.useState({ status: "loading" });
			const [busy, setBusy] = react.useState(null);
			const [notice, setNotice] = react.useState(null);

			const reload = react.useCallback(() => {
				let alive = true;
				setState({ status: "loading" });
				Promise.resolve()
					.then(() => callToggle("list", {}))
					.then(
						(result) => {
							if (!alive) return;
							if (result?.ok !== true) {
								setState({ status: "error", message: `${result?.error?.code ?? "error"}: ${result?.error?.message ?? "未知错误"}` });
								return;
							}
							setState({ status: "ready", providers: result.value?.providers ?? [] });
						},
						(error) => {
							if (alive) setState({ status: "error", message: String(error?.message ?? error) });
						}
					);
				return () => {
					alive = false;
				};
			}, [callToggle]);

			react.useEffect(() => reload(), [reload]);

			if (state.status === "loading") {
				return react.createElement("p", { style: S.badge }, "正在读取模型提供商…");
			}
			if (state.status === "error") {
				return react.createElement("p", { style: S.badge }, `读取模型提供商失败：${state.message}`);
			}
			const providers = state.providers ?? [];
			if (providers.length === 0) return null;

			const toggle = (row) => {
				const enabled = row.disabled === true;
				setBusy(row.provider);
				setNotice(null);
				Promise.resolve()
					.then(() => callToggle("setEnabled", { provider: row.provider, enabled }))
					.then(
						(result) => {
							if (result?.ok !== true) {
								setNotice(`${result?.error?.code ?? "error"}: ${result?.error?.message ?? "未知错误"}`);
								return;
							}
							reload();
						},
						(error) => setNotice(String(error?.message ?? error))
					)
					.finally(() => setBusy(null));
			};

			return react.createElement(
				"div",
				{ style: S.panel, "data-dsh-provider-manager": "panel" },
				react.createElement("div", { style: S.title }, "模型提供商 停用/启用"),
				react.createElement(
					"ul",
					{ style: S.list },
					providers.map((row) =>
						react.createElement(
							"li",
							{ key: row.provider, style: S.row, "data-provider": row.provider },
							react.createElement(
								"span",
								{ style: S.name, title: row.provider },
								`${row.displayName ?? row.provider}`,
								react.createElement("span", { style: S.id }, row.provider),
								row.disabled === true ? react.createElement("span", { style: S.badge }, "（已停用）") : null
							),
							react.createElement(
								"button",
								{
									type: "button",
									style: S.button,
									disabled: busy === row.provider,
									onClick: () => toggle(row)
								},
								row.disabled === true ? "启用" : "停用"
							)
						)
					)
				),
				notice === null ? null : react.createElement("p", { style: S.badge }, `操作失败：${notice}`)
			);
		}

		function apply(ctx) {
			const mounted = ctx.get("remote").$mount(CONTRIBUTION);
			Promise.resolve(mounted).then(
				() => void 0,
				(error) => { ctx.logger?.warn?.("dsh-provider-manager: $mount failed: %s", String(error?.message ?? error)); }
			);

			/** 每次调用都从 live ctx 取命名空间：$mount 是异步的，注册时可能还没就绪。 */
			const callToggle = (method, payload) => {
				const namespace = ctx.get("remote")?.providerToggle;
				if (namespace === void 0) throw new Error("dsh-provider-manager 未挂载（请重启 dsh web）");
				return namespace[method](payload);
			};

			ctx.effect(
				() => ctx.slots.inject("settings.models.footer", () => ctx.slots.register({
					name: "settings.models.footer",
					id: "dsh-provider-manager",
					order: 100,
					label: "模型提供商 停用/启用",
					inject: () => ({ callToggle })
				}, ProviderTogglePanel)),
				"dsh-provider-manager: models footer slot"
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
