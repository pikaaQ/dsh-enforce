// dsh-plugin-toggle — client 半区（浏览器端）
//
// UI 位置：设置 → 插件 → 插件列表 —— 不新增按钮，点击卡片行尾现有状态徽章
// （configTag，已启用/已停用）即切换（scripts/patch-plugins-inventory-bundle.mjs
// 打入 ui-settings-plugin-inventory），经 ctx.get("remote.pluginToggle") 调用。
// 本 client 只负责 $mount 这个 Remote 命名空间供补丁后的页面调用
// （模型提供商开关由独立插件 dsh-provider-manager 的 client 挂 providerToggle 提供）。
window.__ModuleLoader__.load({
	id: "dsh-plugin-toggle",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** Cordis 服务注入：remote（Typert 客户端）。 */
		const inject = ["remote"];

		/** 需要注入的客户端 Remote 描述符（客户端只做透传，校验在 Host 侧）。 */
		const passthrough = { parse: (value) => value };

		const CONTRIBUTION = {
			package: "dsh-plugin-toggle",
			descriptors: [{
				id: "dsh-plugin-toggle#pluginToggle/setEnabled",
				service: "pluginToggle",
				namespace: "pluginToggle",
				method: "setEnabled",
				invocation: { kind: "direct" },
				parameters: [{
					name: "request",
					wire: "request",
					source: "json",
					codec: {
						mode: "strict",
						typeSymbol: "dsh-plugin-toggle/types#SetEnabledRequest",
						schema: passthrough
					}
				}],
				result: {
					mode: "strict",
					typeSymbol: "dsh-plugin-toggle/types#SetEnabledResult",
					schema: passthrough
				}
			}, {
				id: "dsh-plugin-toggle#pluginToggle/protection",
				service: "pluginToggle",
				namespace: "pluginToggle",
				method: "protection",
				invocation: { kind: "direct" },
				parameters: [{
					name: "request",
					wire: "request",
					source: "json",
					codec: {
						mode: "strict",
						typeSymbol: "dsh-plugin-toggle/types#ProtectionRequest",
						schema: passthrough
					}
				}],
				result: {
					mode: "strict",
					typeSymbol: "dsh-plugin-toggle/types#ProtectionResult",
					schema: passthrough
				}
			}]
		};

		function apply(ctx) {
			const mounted = ctx.get("remote").$mount(CONTRIBUTION);
			Promise.resolve(mounted).then(
				() => void 0,
				(error) => { ctx.logger?.warn?.("dsh-plugin-toggle: $mount failed: %s", String(error?.message ?? error)); }
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
