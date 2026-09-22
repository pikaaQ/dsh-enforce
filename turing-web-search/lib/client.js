// dsh-turing-web-search — client 半区（浏览器端）
//
// 在 设置 → 插件 → 插件配置 的「图灵网页搜索」卡片里配置搜索端点：
//   - 搜索引擎 / 端点 下拉：baidu | tavily | firecrawl | cloudsway | bing
//     （五个预置只决定 /proxy/<engine>/search 与请求格式，baseURL 共用）；
//   - 接口地址（可选）文本框：留空 = 图灵默认网关。
// 保存走 settings scope 写入 settings 文档的 web-search-turing: 段（与 host 半区
// installSettingsSection 注册的命名空间同名），settings-file watch 热生效，
// 下一次 ctx.web 搜索即切换端点。
//
// 架构遵循 shipped ui-settings-plugins：插件配置 tab 按 settings 命名空间派发
// settings.plugin.item（keyed）槽位，插件自带 client 半区注册自己的卡片
// （register({ name, key: 命名空间, locale, inject })），tab 端只做交集配对。
// 本文件不依赖任何 client 包模块（只 require react 种子），服务通过 ctx 注入
// （slots/locale/settingsScope），因此无需本地构建/打包。

window.__ModuleLoader__.load({
	id: "dsh-turing-web-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region constants
		/** 本卡片编辑的 settings 命名空间（与 host 半区 settingsNamespace("web-search-turing") 同键）。 */
		const TURING_NS = "web-search-turing";
		/** 本卡片的 locale 字典命名空间（避免占用 shipped 的 settings.plugins）。 */
		const NS = "dsh-turing-web-search";
		/** host 侧 engine 白名单（两处需保持一致）。 */
		const ENGINES = Object.freeze(["baidu", "tavily", "firecrawl", "cloudsway", "bing"]);
		const DEFAULT_ENGINE = "baidu";
		const DEFAULT_BASE_URL = "https://live-turing.cn.llm.tcljd.com/api/v1";
		/** 下拉可选项（顺序与用户可见文案，中英双语一行）。 */
		const ENGINE_OPTIONS = [
			{ id: "baidu", label: "Baidu · 百度（仅中国区）" },
			{ id: "tavily", label: "Tavily · 全球（LLM-optimized）" },
			{ id: "firecrawl", label: "Firecrawl · 全球（搜索与网页抓取）" },
			{ id: "cloudsway", label: "Cloudsway · 搜索（中国区）" },
			{ id: "bing", label: "Legacy Bing Proxy · 自动路由 Baidu/Google" }
		];
		/** 端点预览用路由提示（方法/路径，与 host 侧 ENGINE_ROUTES 一致，仅供展示）。 */
		const ROUTE_HINTS = Object.freeze({
			baidu: { method: "POST", path: "/proxy/baidu/search" },
			tavily: { method: "POST", path: "/proxy/tavily/search" },
			firecrawl: { method: "POST", path: "/proxy/firecrawl/search" },
			cloudsway: { method: "GET", path: "/proxy/cloudsway/search" },
			bing: { method: "POST", path: "/proxy/bing/v7.0/search" }
		});
		//#endregion
		/** 端点预览文本：方法 + baseURL + 路由路径（GET 附加 ?q=… 示意）。 */
		function endpointHintText(engine, base) {
			const hint = ROUTE_HINTS[engine] ?? { method: "POST", path: `/proxy/${engine}/search` };
			const root = (base || DEFAULT_BASE_URL).replace(/\/+$/u, "");
			const url = `${root}${hint.path}`;
			return hint.method === "GET" ? `${hint.method} ${url}?q=…` : `${hint.method} ${url}`;
		}
		//#region locales
		const en = {
			title: "Turing web search",
			description: "Turing standalone search endpoints, model-free.",
			engineLabel: "Search engine / endpoint",
			engineHint: "Selects which Turing search endpoint and request shape is used.",
			endpointLabel: "Endpoint base URL (optional)",
			endpointHint: "Leave blank to use the Turing default gateway.",
			callPrefix: "Next request:",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			expand: "Show settings",
			collapse: "Hide settings",
			unsaved: "Unsaved",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			saveFailed: "The deployment did not accept these values; they were left for you to correct."
		};
		const zh = {
			title: "图灵网页搜索",
			description: "图灵独立搜索端点，不走模型、无模型费。",
			engineLabel: "搜索引擎 / 端点",
			engineHint: "决定走图灵的哪个独立搜索端点及其请求格式。",
			endpointLabel: "接口地址（可选）",
			endpointHint: "留空则使用图灵默认网关。",
			callPrefix: "下次请求：",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			expand: "展开设置",
			collapse: "收起设置",
			unsaved: "未保存",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
			saveFailed: "本部署没有接受这些值，已保留供你修改。"
		};
		//#endregion
		//#region styles
		// 逐条照抄官方卡片样式表：@deepseek-ai/dsh-client-ui-settings-plugins 的
		// PluginCard.module.css（.YyYd_a_*）+ fields.module.css（.At1oFq_*）。
		// 官方「插件配置」页只渲染插件注册进来的组件，卡片外壳与排版全由卡片自己负责，
		// 所以"跟官方一致"只能是搬同一套数值：16px 圆角 + 0.5px 描边、名称 15px 600 1.4、
		// 说明 13px 1.5、字段 padding 12px 0 + 字段间 0.5px 分隔线、标签 13px 500 1.5、
		// 控件 34px / 8px 圆角 / padding 0 12px、提示 12px 1.5、页脚右对齐 + 0.5px 分隔线、
		// 按钮 5px 14px / 13px 1.5（主按钮 = label-primary 底，次要 = 描边 + label-secondary）。
		const css = [
			".tws_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}",
			".tws_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".tws_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".tws_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".tws_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
			".tws_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".tws_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
			".tws_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
			".tws_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
			".tws_chevronOpen{transform:rotate(180deg)}",
			".tws_glyph{font-size:12px;line-height:1;display:inline-block}",
			".tws_pending{flex:none}",
			// 仅当官方 Tag 取不到时才用到的退路（正常路径下不会命中）。
			".tws_tagFallback{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
			".tws_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
			".tws_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
			".tws_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}",
			".tws_field+.tws_field{border-top:.5px solid var(--dsw-alias-border-l2)}",
			".tws_head{align-items:center;gap:8px;display:flex}",
			".tws_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
			".tws_badges{align-items:center;gap:8px;display:inline-flex}",
			".tws_badge{flex:none}",
			".tws_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}",
			".tws_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".tws_reset:disabled{cursor:default}",
			".tws_control{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);width:100%;height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}",
			".tws_control:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".tws_control:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".tws_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".tws_info{align-items:baseline;gap:6px;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;display:flex}",
			".tws_code{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:4px;padding:1px 6px;font-size:11px;line-height:16px;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
			".tws_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
			".tws_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}",
			".tws_discard,.tws_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
			".tws_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
			".tws_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
			".tws_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".tws_discard:disabled,.tws_save:disabled{opacity:.4;cursor:default}",
			".tws_discard:focus-visible,.tws_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}"
		].join("");
		const tagId = "dsh-turing-web-search/TuringSearchCard.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-turing-web-search";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const C = {
			card: "tws_card",
			cardOpen: "tws_cardOpen",
			header: "tws_header",
			headText: "tws_headText",
			name: "tws_name",
			description: "tws_description",
			chevron: "tws_chevron",
			chevronOpen: "tws_chevronOpen",
			pending: "tws_pending",
			glyph: "tws_glyph",
			tagFallback: "tws_tagFallback",
			body: "tws_body",
			readOnly: "tws_readOnly",
			field: "tws_field",
			head: "tws_head",
			label: "tws_label",
			badges: "tws_badges",
			badge: "tws_badge",
			reset: "tws_reset",
			control: "tws_control",
			hint: "tws_hint",
			info: "tws_info",
			code: "tws_code",
			footer: "tws_footer",
			failed: "tws_failed",
			discard: "tws_discard",
			save: "tws_save"
		};
		//#endregion
		//#region store glue
		function cx(...values) {
			let out = "";
			for (const value of values) {
				if (!value) continue;
				if (typeof value === "string") out = out.length === 0 ? value : `${out} ${value}`;
			}
			return out;
		}
		/**
		 * 官方 UI 原语：它们是 web 客户端的**平台 seed 模块**（dsh-web-frontend 的 staticModules：
		 * react / react-dom / cordis / dsh-client-store / dsh-client-ui-slots /
		 * dsh-client-ui-primitives / dsh-client-ui-dockkit），任何 client 插件的 factory 都能
		 * require，不需要进 boot graph。取不到就退回等价 DOM——原语缺失不该让整张卡片炸掉。
		 */
		let primitives = {};
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives") ?? {};
		} catch (error) {
			primitives = {};
		}
		/** 官方展开箭头：IconChevronDownOutline14，展开时 rotate(180deg)。 */
		function CardChevron({ open }) {
			const className = cx(C.chevron, open && C.chevronOpen);
			const Icon = primitives.IconChevronDownOutline14;
			if (typeof Icon === "function") return react.createElement(Icon, { className });
			return react.createElement("span", { className: cx(className, C.glyph), "aria-hidden": "true" }, "▾");
		}
		/** 官方 Tag 的封装（tone=neutral）：标题行的「未保存」、字段头的「已覆盖」都用它。 */
		function CardTag({ className, children }) {
			const Tag = primitives.Tag;
			if (typeof Tag === "function") return react.createElement(Tag, { tone: "neutral", className }, children);
			return react.createElement("span", { className: cx(className, C.tagFallback) }, children);
		}
		/** 微型快照 store：渲染端把 hooks 里的本对象当 observable（subscribe/getSnapshot）用。 */
		class TuringCardStore {
			constructor(scope) {
				this.scope = scope;
				this.staged = {};
				this.listeners = new Set();
				this.saving = false;
				this.failed = false;
				this.state = {
					available: false,
					writable: false,
					dirty: false,
					saving: false,
					failed: false,
					engine: { value: DEFAULT_ENGINE, overridden: false },
					baseURL: { text: "", overridden: false },
					endpoint: `${DEFAULT_BASE_URL}/proxy/${DEFAULT_ENGINE}/search`
				};
				scope.subscribe(() => this.publish());
				this.publish();
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			getSnapshot() {
				return this.state;
			}
			snap() {
				return this.scope.getSnapshot();
			}
			userHas(snapshot, field) {
				const user = snapshot.user;
				return user !== void 0 && user !== null && Object.hasOwn(user, field);
			}
			knownEngine(value) {
				return typeof value === "string" && ENGINES.includes(value) ? value : DEFAULT_ENGINE;
			}
			effectiveEngine(snapshot) {
				return this.knownEngine(snapshot.value?.engine);
			}
			baseEngine(snapshot) {
				return this.knownEngine(snapshot.base?.engine);
			}
			engineValue(snapshot) {
				const staged = this.staged.engine;
				if (staged !== void 0) return staged.mode === "set" ? staged.value : this.baseEngine(snapshot);
				return this.effectiveEngine(snapshot);
			}
			engineOverridden(snapshot) {
				const staged = this.staged.engine;
				if (staged !== void 0) return staged.mode === "set";
				return this.userHas(snapshot, "engine");
			}
			baseText(snapshot) {
				const staged = this.staged.baseURL;
				if (staged !== void 0) return staged.mode === "set" ? staged.text : "";
				return typeof snapshot.value?.baseURL === "string" ? snapshot.value.baseURL : "";
			}
			baseOverridden(snapshot) {
				const staged = this.staged.baseURL;
				if (staged !== void 0) return staged.mode === "set";
				return this.userHas(snapshot, "baseURL");
			}
			endpointOf(snapshot) {
				const engine = this.engineValue(snapshot);
				const base = this.baseText(snapshot) || DEFAULT_BASE_URL;
				return endpointHintText(engine, base);
			}
			/** 计划写入（镜像 shipped CardForm：与生效值相同则跳过；clear 仅在确有 user 层条目时写）。 */
			plan(snapshot) {
				const writes = [];
				const stagedEngine = this.staged.engine;
				if (stagedEngine !== void 0) {
					if (stagedEngine.mode === "set") {
						if (stagedEngine.value !== this.effectiveEngine(snapshot)) writes.push({
							kind: "set",
							field: "engine",
							value: stagedEngine.value,
							run: () => this.store("engine", stagedEngine.value)
						});
					} else if (this.userHas(snapshot, "engine")) {
						writes.push({ kind: "clear", field: "engine", run: () => this.clear("engine") });
					}
				}
				const stagedBase = this.staged.baseURL;
				if (stagedBase !== void 0) {
					const effective = typeof snapshot.value?.baseURL === "string" ? snapshot.value.baseURL : "";
					if (stagedBase.mode === "set") {
						if (stagedBase.text !== effective) writes.push({
							kind: "set",
							field: "baseURL",
							value: stagedBase.text,
							run: () => this.store("baseURL", stagedBase.text)
						});
					} else if (this.userHas(snapshot, "baseURL")) {
						writes.push({ kind: "clear", field: "baseURL", run: () => this.clear("baseURL") });
					}
				}
				return writes;
			}
			projection() {
				const snapshot = this.snap();
				const writes = this.plan(snapshot);
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable === true,
					dirty: writes.length > 0,
					saving: this.saving,
					failed: this.failed,
					engine: { value: this.engineValue(snapshot), overridden: this.engineOverridden(snapshot) },
					baseURL: { text: this.baseText(snapshot), overridden: this.baseOverridden(snapshot) },
					endpoint: this.endpointOf(snapshot)
				};
			}
			publish() {
				this.state = this.projection();
				for (const listener of this.listeners) listener();
			}
			stage(field, edit) {
				this.staged[field] = edit;
				this.failed = false;
				this.publish();
			}
			async store(field, value) {
				await this.scope.set(field, value);
				const user = this.snap().user;
				return user !== void 0 && user !== null && user[field] === value;
			}
			async clear(field) {
				await this.scope.unset(field);
				const user = this.snap().user;
				return user === void 0 || user === null || !Object.hasOwn(user, field);
			}
			async save() {
				const snapshot = this.snap();
				const writes = this.plan(snapshot);
				if (writes.length === 0 || this.saving) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const write of writes) {
					try {
						landed = await write.run() && landed;
					} catch (error) {
						landed = false;
					}
				}
				if (landed) this.staged = {};
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
			discard() {
				if ((this.staged.engine === void 0 && this.staged.baseURL === void 0) && !this.failed) return;
				this.staged = {};
				this.failed = false;
				this.publish();
			}
			actions() {
				return {
					edit: (field, value) => {
						if (field === "engine") this.stage("engine", { mode: "set", value });
						else if (field === "baseURL") this.stage("baseURL", value.length === 0 ? { mode: "clear" } : { mode: "set", text: value });
					},
					resetField: (field) => {
						if (field === "engine") this.stage("engine", { mode: "clear" });
						else if (field === "baseURL") this.stage("baseURL", { mode: "clear" });
					},
					save: () => this.save(),
					discard: () => this.discard()
				};
			}
			inject() {
				return {
					hooks: { turingSearch: this },
					...this.actions()
				};
			}
		}
		//#endregion
		//#region card component
		/** 设置 → 插件 → 插件配置 的「图灵网页搜索」卡片。 */
		function TuringSearchCard(props) {
			const { t } = props;
			const state = props.useTuringSearch((snapshot) => snapshot);
			const [open, setOpen] = react.useState(false);
			if (!state.available) return null;
			const disabled = !state.writable;
			const blocked = !state.dirty || state.saving;
			const title = t("title");
			const body = [
				!state.writable ? react.createElement("p", { className: C.readOnly, role: "status", key: "ro" }, t("readOnly")) : null,
				react.createElement("div", { className: C.field, key: "engine" }, [
					react.createElement("div", { className: C.head, key: "head" },
						react.createElement("label", { className: C.label, htmlFor: "turing-web-search-engine" }, t("engineLabel")),
						state.engine.overridden ? react.createElement("span", { className: C.badges }, [
							react.createElement(CardTag, { className: C.badge, key: "b" }, t("overridden")),
							react.createElement("button", { type: "button", className: C.reset, disabled, key: "r", onClick: () => props.resetField("engine") }, t("reset"))
						]) : null),
					react.createElement("select", {
						className: C.control,
						id: "turing-web-search-engine",
						key: "control",
						disabled,
						value: state.engine.value,
						onChange: (event) => props.edit("engine", event.target.value)
					}, ENGINE_OPTIONS.map((option) => react.createElement("option", { value: option.id, key: option.id }, option.label))),
					react.createElement("p", { className: C.hint, key: "hint" }, t("engineHint"))
				]),
				react.createElement("div", { className: C.field, key: "baseURL" }, [
					react.createElement("div", { className: C.head, key: "head" },
						react.createElement("label", { className: C.label, htmlFor: "turing-web-search-base-url" }, t("endpointLabel")),
						state.baseURL.overridden ? react.createElement("span", { className: C.badges }, [
							react.createElement(CardTag, { className: C.badge, key: "b" }, t("overridden")),
							react.createElement("button", { type: "button", className: C.reset, disabled, key: "r", onClick: () => props.resetField("baseURL") }, t("reset"))
						]) : null),
					react.createElement("input", {
						className: C.control,
						id: "turing-web-search-base-url",
						type: "text",
						key: "control",
						placeholder: DEFAULT_BASE_URL,
						disabled,
						value: state.baseURL.text,
						onChange: (event) => props.edit("baseURL", event.target.value)
					}),
					react.createElement("p", { className: C.hint, key: "hint" }, t("endpointHint")),
					// 端点预览：挂在同一个字段里（而不是字段之间单起一行），
					// 才和官方"标签 / 控件 / 提示"三段式的间距一致。
					react.createElement("p", { className: C.info, key: "endpoint" }, [
						t("callPrefix"),
						react.createElement("code", { className: C.code, key: "code" }, state.endpoint)
					])
				]),
				react.createElement("div", { className: C.footer, key: "footer" }, [
					state.failed ? react.createElement("p", { className: C.failed, role: "status", key: "failed" }, t("saveFailed")) : null,
					react.createElement("button", { type: "button", className: C.discard, disabled: !state.dirty || state.saving, key: "discard", onClick: props.discard }, t("discard")),
					react.createElement("button", { type: "button", className: C.save, disabled: blocked, key: "save", onClick: props.save }, t(state.saving ? "saving" : "save"))
				])
			];
			return react.createElement("li", {
				className: cx(C.card, open && C.cardOpen)
			}, [
				react.createElement("button", {
					type: "button",
					className: C.header,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					key: "header",
					onClick: () => setOpen(!open)
				}, [
					react.createElement("span", { className: C.headText, key: "text" }, [
						react.createElement("span", { className: C.name, key: "name" }, title),
						react.createElement("span", { className: C.description, key: "desc" }, t("description"))
					]),
					state.dirty ? react.createElement(CardTag, { className: C.pending, key: "pending" }, t("unsaved")) : null,
					react.createElement(CardChevron, { open, key: "chevron" })
				]),
				open ? react.createElement("div", { className: C.body, key: "body" }, body) : null
			]);
		}
		//#endregion
		//#region apply
		/** 需要注入的服务（与 dsh.client.inject 声明的包对应）。 */
		const inject = ["slots", "locale", "settingsScope"];
		/**
		 * 挂载卡片：注册本地化字典并把本卡片登记进插件配置 tab 的
		 * settings.plugin.item（keyed，key = web-search-turing 命名空间）。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-turing-web-search: card dictionaries");
			const card = new TuringCardStore(ctx.settingsScope.bind({ namespace: TURING_NS }));
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					key: TURING_NS,
					locale: NS,
					inject: () => card.inject()
				}, TuringSearchCard);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		/** 内部导出：给冒烟测试/调试看卡片结构与样式表用（loader 只取 apply/inject）。 */
		exports.__test = { TuringSearchCard, TuringCardStore, C, css, ENGINE_OPTIONS, TURING_NS, NS };
		return module.exports;
	}
});
