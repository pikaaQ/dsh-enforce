// dsh-vision-delegate — client 半区（浏览器端）
//
// 两个官方插槽：
//   1. `conversation.input.right`（session 作用域，composer 提交键之前的紧凑控件）
//      —— 三态开关：未配置 / 关 / 自动。未配置时**点击不切换**，就地弹提示告诉用户去配置。
//   2. `settings.plugin.item`（root keyed，key = settings 命名空间）
//      —— 「视觉委派」配置卡片：选择视觉大模型 + 启用开关。官方插件页按命名空间分发卡片，
//         所以 key 必须等于 host 半区注册的 `vision-delegate`。
//
// 数据都走本包 host 半区注册的同源路由（GET 读状态/候选，POST 写配置或本会话开关），
// 不依赖 Typert 远程命名空间。
//
// 卡片外观**与官方 shipped 的插件卡片（终端 / 网页搜索 / Subagent…）逐条对齐**：官方「插件配置」
// 页只渲染插件注册进来的组件，卡片外壳（<li> + 可点标题行 + 可折叠正文 + 右对齐页脚）和排版全部
// 由卡片自己负责，所以只有搬官方同一套样式数值 + 官方 UI 原语（chevron 图标 / Tag / Switch），
// 才不会出现"展开按钮、确认按钮位置、文案行间距"这类显示差异。
window.__ModuleLoader__.load({
	id: "dsh-vision-delegate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require("react");

		/** Cordis 服务注入：只要插槽。 */
		const inject = ["slots"];

		const STATUS_URL = "/vision-delegate";
		const MODELS_URL = "/vision-delegate/models";
		/** 必须等于 host 半区注册的 settings 命名空间。 */
		const NAMESPACE = "vision-delegate";

		const STATUS_UNCONFIGURED = "unconfigured";
		const STATUS_OFF = "off";
		const STATUS_ON = "on";

		/** composer 三态胶囊的样式（不是官方卡片，按胶囊观感，不参与卡片对齐）。 */
		const S = {
			wrap: { position: "relative", display: "inline-flex", alignItems: "center" },
			chip: {
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				padding: "2px 8px",
				borderRadius: "999px",
				border: "1px solid currentColor",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "12px",
				lineHeight: "1.6",
				cursor: "pointer",
				opacity: 0.85,
				whiteSpace: "nowrap"
			},
			chipOff: { opacity: 0.45, textDecoration: "line-through" },
			chipWarn: { opacity: 0.6, borderStyle: "dashed" },
			chipBusy: { cursor: "progress", opacity: 0.5 },
			dot: { width: "6px", height: "6px", borderRadius: "999px", background: "currentColor", display: "inline-block" },
			popover: {
				position: "absolute",
				bottom: "calc(100% + 6px)",
				right: 0,
				zIndex: 20,
				width: "300px",
				padding: "8px 10px",
				borderRadius: "10px",
				border: "0.5px solid var(--dsw-alias-border-l4)",
				background: "var(--dsw-alias-bg-layer-3)",
				color: "var(--dsw-alias-label-primary)",
				fontSize: "12px",
				lineHeight: "1.6",
				boxShadow: "0 6px 20px rgba(0,0,0,0.18)"
			}
		};

		// -------------------------------------------------------------------------
		// 卡片样式：以下规则逐条照抄官方插件卡片的样式表
		//   @deepseek-ai/dsh-client-ui-settings-plugins → PluginCard.module.css
		//   （.YyYd_a_*）、fields.module.css（.At1oFq_*）、
		//   SubagentModelSelectionCard.module.css（.vCGm7G_*），类名换成 vdc_ 前缀避免撞车。
		// 对照的官方数值：16px 圆角 + 0.5px 描边、标题行 padding 14px 16px / gap 12px、
		// 名称 15px 600 1.4、说明 13px 1.5、字段 padding 12px 0 + 字段间 0.5px 分隔线、
		// 标签 13px 500 1.5、控件 34px 高 / 8px 圆角 / padding 0 12px、提示 12px 1.5、
		// 页脚右对齐 / 顶部 0.5px 分隔线 / padding 12px 0 4px、按钮 5px 14px / 13px 1.5。
		// 内联 style 表达不了 :hover / :focus-visible / :disabled，所以跟官方一样注入 <style>，
		// 并按官方约定登记 data-plugin / data-plugin-css（HMR 回收 <style> 时靠它认领）。
		// -------------------------------------------------------------------------
		const CARD_CSS_ID = "dsh-vision-delegate/VisionDelegateCard.css";
		const CARD_CSS = [
			".vdc_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}",
			".vdc_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".vdc_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".vdc_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".vdc_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
			".vdc_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".vdc_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
			".vdc_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
			".vdc_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
			".vdc_chevronOpen{transform:rotate(180deg)}",
			".vdc_pending{flex:none}",
			".vdc_glyph{font-size:12px;line-height:1;display:inline-block}",
			// 仅当官方 Tag 取不到时才用到的退路（正常路径下不会命中）。
			".vdc_tagFallback{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
			".vdc_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
			".vdc_alert{color:var(--dsw-alias-label-error);margin:12px 0 0;font-size:12px;line-height:1.5}",
			".vdc_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}",
			".vdc_field+.vdc_field{border-top:.5px solid var(--dsw-alias-border-l2)}",
			".vdc_head{align-items:center;gap:8px;display:flex}",
			".vdc_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
			".vdc_control{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);width:100%;height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}",
			".vdc_control:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".vdc_control:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".vdc_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".vdc_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}",
			".vdc_toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}",
			".vdc_toggleLabel{flex:1;min-width:0}",
			".vdc_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
			".vdc_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}",
			".vdc_notice{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}",
			".vdc_discard,.vdc_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
			".vdc_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
			".vdc_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
			".vdc_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".vdc_discard:disabled,.vdc_save:disabled{opacity:.4;cursor:default}",
			".vdc_discard:focus-visible,.vdc_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}"
		].join("");
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(CARD_CSS_ID)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-vision-delegate";
			tag.dataset.pluginCss = CARD_CSS_ID;
			tag.textContent = CARD_CSS;
			document.head.appendChild(tag);
		}

		/** 上面那张样式表的类名（与官方卡片的类一一对应）。 */
		const C = {
			card: "vdc_card",
			cardOpen: "vdc_cardOpen",
			header: "vdc_header",
			headText: "vdc_headText",
			name: "vdc_name",
			description: "vdc_description",
			chevron: "vdc_chevron",
			chevronOpen: "vdc_chevronOpen",
			pending: "vdc_pending",
			glyph: "vdc_glyph",
			tagFallback: "vdc_tagFallback",
			body: "vdc_body",
			alert: "vdc_alert",
			field: "vdc_field",
			head: "vdc_head",
			label: "vdc_label",
			control: "vdc_control",
			hint: "vdc_hint",
			invalid: "vdc_invalid",
			toggleRow: "vdc_toggleRow",
			toggleLabel: "vdc_toggleLabel",
			footer: "vdc_footer",
			failed: "vdc_failed",
			notice: "vdc_notice",
			discard: "vdc_discard",
			save: "vdc_save"
		};

		function cx(...values) {
			let out = "";
			for (const value of values) {
				if (value === false || value === null || value === void 0 || value === "") continue;
				out = out.length === 0 ? String(value) : `${out} ${String(value)}`;
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

		const CARD_TITLE = "视觉委派";
		const CARD_DESCRIPTION = "当前模型不能看图时，把图片分析交给固定的视觉模型子代理";
		const SELECT_ID = "dsh-vision-delegate-model";
		const TOGGLE_LABEL = "新会话默认打开「视觉」胶囊";
		const TOGGLE_HINT_ON =
			"只决定「新会话」开出时胶囊的初始状态（等同于在会话里 Shift+点击胶囊）。是否调用视觉模型，完全由每个会话里 composer 右下角的「视觉」胶囊决定：" +
			"胶囊开着才会用，关着就不用——把它设成关，也不会妨碍你在任何一个会话里点开胶囊。";
		const TOGGLE_HINT_OFF = "先选择视觉模型，才能设置新会话的默认状态。";
		/** 卡片按钮与展开控件的文案，与官方 zh 字典一致。 */
		const T = {
			expand: "展开设置",
			collapse: "收起设置",
			unsaved: "未保存",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改"
		};

		/** 展开箭头：官方是同款图标 IconChevronDownOutline14 + 展开时 rotate(180deg)。 */
		function CardChevron({ open }) {
			const className = cx(C.chevron, open && C.chevronOpen);
			const Icon = primitives.IconChevronDownOutline14;
			if (typeof Icon === "function") return react.createElement(Icon, { className });
			return react.createElement("span", { className: cx(className, C.glyph), "aria-hidden": "true" }, "▾");
		}

		/** 标题行右侧的「未保存」标签：官方是同款 Tag（tone=neutral）。 */
		function PendingTag({ children }) {
			const Tag = primitives.Tag;
			if (typeof Tag === "function") return react.createElement(Tag, { tone: "neutral", className: C.pending }, children);
			return react.createElement("span", { className: cx(C.pending, C.tagFallback) }, children);
		}

		/** 开关：官方是同款 Switch（role=switch 的按钮，onChange 收到下一个布尔值）。 */
		function Toggle({ checked, disabled, label, onChange }) {
			const Switch = primitives.Switch;
			if (typeof Switch === "function") return react.createElement(Switch, { checked, disabled, label, onChange });
			return react.createElement("input", {
				type: "checkbox",
				checked,
				disabled,
				"aria-label": label,
				onChange: (event) => onChange(event.target.checked)
			});
		}

		async function callJson(url, init) {
			const response = await fetch(url, init);
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = { ok: false, error: { message: `HTTP ${response.status}` } };
			}
			if (payload?.ok !== true) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
			return payload;
		}

		function sessionQuery(sessionId) {
			return typeof sessionId === "string" && sessionId !== "" ? `?session=${encodeURIComponent(sessionId)}` : "";
		}

		function chipLabel(payload) {
			if (payload.providerAvailable === false) return "视觉 不可用";
			if (payload.status === STATUS_UNCONFIGURED) return "视觉 未配置";
			return payload.status === STATUS_ON ? "视觉 自动" : "视觉 关";
		}

		function chipHint(payload) {
			if (payload.providerAvailable === false) return "宿主没有注册 spawn 子代理提供方，视觉委派暂不可用。";
			if (payload.status === STATUS_UNCONFIGURED) {
				return "视觉委派未配置：请先在 设置 → 插件 → 插件配置 → 「视觉委派」卡片里选择视觉模型。";
			}
			if (payload.status === STATUS_ON) {
				return `视觉委派：自动（${payload.provider}/${payload.model}）。本会话的图片分析会交给视觉子代理——点一下关闭本会话。Shift+点击改所有新会话的默认值。`;
			}
			return "视觉委派：本会话已关闭。点一下打开本会话，或 Shift+点击改所有新会话的默认值。";
		}

		/** composer 里的三态开关。 */
		function VisionChip({ sessionId }) {
			const [state, setState] = react.useState({ status: "loading" });
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);

			const load = react.useCallback(() => {
				let alive = true;
				callJson(`${STATUS_URL}${sessionQuery(sessionId)}`).then(
					(payload) => {
						if (alive) setState({ status: "ready", payload });
					},
					(error) => {
						if (alive) setState({ status: "error", message: String(error?.message ?? error) });
					}
				);
				return () => {
					alive = false;
				};
			}, [sessionId]);

			react.useEffect(() => load(), [load]);

			const write = react.useCallback(
				(body, successNotice) => {
					setBusy(true);
					setNotice(null);
					callJson(STATUS_URL + sessionQuery(sessionId), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ...body, session: sessionId })
					})
						.then(
							(payload) => {
								setState({ status: "ready", payload });
								if (successNotice !== undefined) setNotice(successNotice);
							},
							(error) => setNotice(`操作失败：${String(error?.message ?? error)}`)
						)
						.finally(() => setBusy(false));
				},
				[sessionId]
			);

			if (state.status === "loading") {
				return react.createElement("span", { style: S.wrap }, react.createElement("button", { type: "button", style: { ...S.chip, ...S.chipBusy }, disabled: true, "data-dsh-vision-delegate": "loading" }, "视觉 …"));
			}
			if (state.status === "error") {
				return react.createElement(
					"span",
					{ style: S.wrap },
					react.createElement(
						"button",
						{
							type: "button",
							style: { ...S.chip, ...S.chipWarn },
							title: `dsh-vision-delegate 读取失败：${state.message}`,
							"data-dsh-vision-delegate": "error",
							onClick: () => {
								setState({ status: "loading" });
								load();
							}
						},
						"视觉 ?"
					)
				);
			}

			const payload = state.payload;
			const off = payload.status === STATUS_OFF;
			const blocked = payload.status === STATUS_UNCONFIGURED || payload.providerAvailable === false;

			const onClick = (event) => {
				if (blocked) {
					setNotice(notice === null ? chipHint(payload) : null);
					return;
				}
				if (event?.shiftKey === true) {
					write({ patch: { enabled: payload.enabled !== true } }, "已更新所有新会话的默认值");
					return;
				}
				write({ enabled: payload.status !== STATUS_ON });
			};

			return react.createElement(
				"span",
				{ style: S.wrap },
				react.createElement(
					"button",
					{
						type: "button",
						style: { ...S.chip, ...(off ? S.chipOff : null), ...(blocked ? S.chipWarn : null), ...(busy ? S.chipBusy : null) },
						disabled: busy,
						title: chipHint(payload),
						"aria-pressed": payload.status === STATUS_ON ? "true" : "false",
						"data-dsh-vision-delegate": blocked ? "blocked" : off ? STATUS_OFF : STATUS_ON,
						onClick
					},
					react.createElement("span", { style: S.dot }),
					chipLabel(payload)
				),
				notice === null ? null : react.createElement("div", { style: S.popover, "data-dsh-vision-delegate": "notice" }, notice)
			);
		}

		/**
		 * 卡片正文：官方 ValueField / 开关行的结构（字段 = 12px 上下留白 + 标签 / 控件 / 提示，
		 * 字段之间 0.5px 分隔线），页脚固定在正文末尾并右对齐。
		 *
		 * 表单状态由卡片持有（官方也是这么分的：PluginCard 持 open，slot 把表单状态注入进来），
		 * 这里只呈现并回调。
		 */
		function VisionDelegateBody(props) {
			const { state, draft, dirty, busy, notice, failed } = props;

			if (state.status === "loading") {
				return react.createElement(
					"div",
					{ className: C.field, "data-dsh-vision-delegate": "loading" },
					react.createElement("p", { className: C.hint, role: "status" }, "正在读取视觉委派配置…")
				);
			}

			if (state.status === "error") {
				return react.createElement(
					react.Fragment,
					null,
					react.createElement(
						"div",
						{ className: C.field, "data-dsh-vision-delegate": "error" },
						react.createElement("div", { className: C.head }, react.createElement("span", { className: C.label }, CARD_TITLE)),
						react.createElement("p", { className: C.invalid, role: "alert" }, `读取失败：${state.message}`)
					),
					react.createElement(
						"div",
						{ className: C.footer },
						react.createElement("button", { type: "button", className: C.discard, onClick: props.onRetry }, "重试")
					)
				);
			}

			const candidates = state.candidates ?? [];
			const groups = [];
			for (const row of candidates) {
				let group = groups.find((item) => item.provider === row.provider);
				if (group === void 0) {
					group = { provider: row.provider, name: row.providerName ?? row.provider, rows: [] };
					groups.push(group);
				}
				group.rows.push(row);
			}
			const selected = candidates.find((row) => row.provider === draft.provider && row.model === draft.model);
			const configured = draft.provider !== "" && draft.model !== "";
			const dirtyNow = dirty === true;
			const buttonsBlocked = busy === true || !dirtyNow;
			const modelHint = configured
				? "子代理会固定跑这个模型；它必须在 设置 → 模型 里声明了图片输入（input: [text, image]），否则拿不到图片。"
				: "先选一个视觉模型；未配置时，composer 右下角的「视觉」胶囊打不开。";

			return react.createElement(
				react.Fragment,
				null,
				state.providerAvailable === false
					? react.createElement(
							"p",
							{ className: C.alert, role: "status" },
							"宿主没有注册 spawn 子代理提供方（@deepseek-ai/dsh-subagent-spawn-in-process），视觉委派无法工作。"
						)
					: null,
				react.createElement(
					"div",
					{ className: C.field, "data-dsh-vision-delegate": "model" },
					react.createElement(
						"div",
						{ className: C.head },
						react.createElement("label", { className: C.label, htmlFor: SELECT_ID }, "视觉模型")
					),
					react.createElement(
						"select",
						{
							id: SELECT_ID,
							className: C.control,
							disabled: busy === true,
							value: `${draft.provider}\u0000${draft.model}`,
							onChange: props.onSelect
						},
						react.createElement("option", { value: "\u0000" }, "（未选择 —— 未配置时开关不可用）"),
						groups.map((group) =>
							react.createElement(
								"optgroup",
								{ key: group.provider, label: group.name },
								group.rows.map((row) =>
									react.createElement(
										"option",
										{ key: `${row.provider}\u0000${row.model}`, value: `${row.provider}\u0000${row.model}` },
										`${row.name}${row.image ? "" : "（未声明图片输入）"}`
									)
								)
							)
						)
					),
					selected !== void 0 && selected.image !== true
						? react.createElement(
								"p",
								{ className: C.invalid },
								"该模型没有声明 input: [text, image]，子代理可能收不到图片；请在 设置 → 模型 里给它补上该声明，或换一个视觉模型。"
							)
						: react.createElement("p", { className: C.hint }, modelHint)
				),
				react.createElement(
					"div",
					{ className: C.field, "data-dsh-vision-delegate": "default" },
					react.createElement(
						"div",
						{ className: C.toggleRow },
						react.createElement("span", { className: C.toggleLabel }, TOGGLE_LABEL),
						react.createElement(Toggle, {
							checked: draft.enabled === true,
							disabled: !configured || busy === true,
							label: TOGGLE_LABEL,
							onChange: props.onToggle
						})
					),
					react.createElement("p", { className: C.hint }, configured ? TOGGLE_HINT_ON : TOGGLE_HINT_OFF)
				),
				react.createElement(
					"div",
					{ className: C.footer },
					failed !== null && failed !== void 0
						? react.createElement("p", { className: C.failed, role: "alert" }, failed)
						: notice !== null && notice !== void 0
							? react.createElement("p", { className: C.notice, role: "status" }, notice)
							: null,
					react.createElement("button", { type: "button", className: C.discard, disabled: buttonsBlocked, onClick: props.onDiscard }, T.discard),
					react.createElement("button", { type: "button", className: C.save, disabled: buttonsBlocked, onClick: props.onSave }, busy === true ? T.saving : T.save)
				)
			);
		}

		/**
		 * 官方「插件配置」页里的卡片：结构、类名、文案与官方 PluginCard 一一对应
		 * （<li> + 唯一的展开控件是标题行 + 可折叠正文 + 右对齐页脚）。
		 *
		 * 与官方一致的行为：
		 *   - 默认收起（"哪张卡片是打开的"是阅读手势，官方把它当卡片本地状态）；
		 *   - 草稿脏时标题行右侧出现官方「未保存」Tag，保存/放弃后消失；
		 *   - 页脚按钮右对齐：放弃修改（次要，描边）在左、保存（主要，实心）在右；
		 *   - 失败信息留在页脚左侧（官方 .failed 的位置），成功提示同位置、用提示色；
		 *   - 保存成功后（不再脏且没失败）卡片自动收起，与官方一致。
		 */
		function VisionDelegateCard() {
			const [open, setOpen] = react.useState(false);
			const [state, setState] = react.useState({ status: "loading" });
			const [draft, setDraft] = react.useState({ provider: "", model: "", enabled: false });
			const [saved, setSaved] = react.useState({ provider: "", model: "", enabled: false });
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [failed, setFailed] = react.useState(null);
			const saveStarted = react.useRef(false);

			const load = react.useCallback(() => {
				let alive = true;
				Promise.all([callJson(MODELS_URL), callJson(STATUS_URL)]).then(
					([models, status]) => {
						if (!alive) return;
						const next = {
							provider: typeof status.provider === "string" ? status.provider : "",
							model: typeof status.model === "string" ? status.model : "",
							enabled: status.enabled === true
						};
						setDraft(next);
						setSaved(next);
						setState({ status: "ready", candidates: models.candidates ?? [], providerAvailable: status.providerAvailable !== false });
					},
					(error) => {
						if (alive) setState({ status: "error", message: String(error?.message ?? error) });
					}
				);
				return () => {
					alive = false;
				};
			}, []);

			react.useEffect(() => load(), [load]);

			const dirty = draft.provider !== saved.provider || draft.model !== saved.model || draft.enabled !== saved.enabled;

			// 官方行为：保存落地（不再脏、也没有失败）后自动收起卡片。
			react.useEffect(() => {
				if (busy) {
					saveStarted.current = true;
					return;
				}
				if (!saveStarted.current) return;
				saveStarted.current = false;
				if (!dirty && failed === null) setOpen(false);
			}, [busy, dirty, failed]);

			const save = () => {
				setBusy(true);
				setNotice(null);
				setFailed(null);
				callJson(STATUS_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ patch: { provider: draft.provider, model: draft.model, enabled: draft.enabled } })
				})
					.then(
						(status) => {
							const next = {
								provider: typeof status.provider === "string" ? status.provider : "",
								model: typeof status.model === "string" ? status.model : "",
								enabled: status.enabled === true
							};
							setDraft(next);
							setSaved(next);
							setNotice("已保存：对后续调用立即生效（新会话与开关都按这个模型）。");
						},
						(error) => setFailed(`保存失败：${String(error?.message ?? error)}`)
					)
					.finally(() => setBusy(false));
			};

			return react.createElement(
				"li",
				{ className: cx(C.card, open && C.cardOpen), "data-dsh-vision-delegate": "card" },
				react.createElement(
					"button",
					{
						type: "button",
						className: C.header,
						"aria-expanded": open === true,
						"aria-label": `${open ? T.collapse : T.expand}: ${CARD_TITLE}`,
						onClick: () => setOpen((current) => !current)
					},
					react.createElement(
						"span",
						{ className: C.headText },
						react.createElement("span", { className: C.name }, CARD_TITLE),
						react.createElement("span", { className: C.description }, CARD_DESCRIPTION)
					),
					state.status === "ready" && dirty ? react.createElement(PendingTag, null, T.unsaved) : null,
					react.createElement(CardChevron, { open })
				),
				open
					? react.createElement(
							"div",
							{ className: C.body },
							react.createElement(VisionDelegateBody, {
								state,
								draft,
								dirty,
								busy,
								notice,
								failed,
								onSelect: (event) => {
									const [provider, model] = String(event.target.value).split("\u0000");
									setDraft((current) => ({ ...current, provider: provider ?? "", model: model ?? "" }));
								},
								onToggle: (next) =>
									setDraft((current) => ({ ...current, enabled: typeof next === "boolean" ? next : current.enabled !== true })),
								onSave: save,
								onDiscard: () => {
									setDraft(saved);
									setNotice(null);
									setFailed(null);
								},
								onRetry: () => {
									setState({ status: "loading" });
									setFailed(null);
									load();
								}
							})
						)
					: null
			);
		}

		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.input.right", () =>
						ctx.slots.register(
							{
								name: "conversation.input.right",
								id: "dsh-vision-delegate",
								order: 50,
								label: "视觉委派",
								inject: (sessionId) => ({ sessionId })
							},
							VisionChip
						)
					),
				"dsh-vision-delegate: composer chip"
			);
			// ① 官方"插件配置"页的卡片：槽位 settings.plugin.item（keyed，key = 本插件的 settings 命名空间）。
			//    该页的配对规则是"Host 提供的命名空间 ∩ 注册进本槽位的卡片"（ui-settings-plugins 注释原文：
			//    the intersection of two ledgers: the namespaces the Host serves and the cards registered
			//    into `settings.plugin.item`）。所以要 host 半区 installSection 注册的命名空间
			//    + 这里注册同 key 的卡片，两者都有才渲染。
			//    注册形状照抄仓库内已验证的 dsh-turing-web-search（以及官方页自己注册那五张卡）：
			//    **generator + yield**，不是普通箭头函数返回注册对象。
			ctx.effect(
				() =>
					ctx.slots.inject("settings.plugin.item", function* () {
						yield ctx.slots.register(
							{ name: "settings.plugin.item", key: NAMESPACE, inject: () => ({}) },
							VisionDelegateCard
						);
					}),
				"dsh-vision-delegate: plugin config card"
			);
			// 只保留官方「插件配置」页里的卡片（不再另开一页 settings.section）：
			// 配置入口只有一处，避免同一个设置两个地方。
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = {
			chipLabel,
			chipHint,
			sessionQuery,
			VisionChip,
			VisionDelegateBody,
			VisionDelegateCard,
			CardChevron,
			PendingTag,
			Toggle,
			C,
			CARD_CSS,
			CARD_CSS_ID,
			STATUS_URL,
			MODELS_URL,
			NAMESPACE
		};
		return module.exports;
	}
});
