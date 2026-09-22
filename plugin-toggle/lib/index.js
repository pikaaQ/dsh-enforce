// dsh-plugin-toggle — host 半区（只处理插件管理）
//
// 单一 Typert Remote 命名空间 pluginToggle（旧名沿用，语义即动作）：
//   pluginToggle.setEnabled(entryId, enabled) —— 插件（loader 条目）停用/启用，
//     状态写入 $DSH_HOME/cordis.patch.yml（home 层 user patch，热加载、重启保留）。
//   pluginToggle.protection({ entryId, enabled }) —— 只读保护判定，供补丁后的页面
//     决定徽章是否锁定 / 是否需要二次确认（与 setEnabled 的 host 侧强制共用同一张表）。
//
// 保护模型（对齐社区 dsh-plugin-manager + web profile 补充，2026 加）：
//   - T0（blocked，硬保护）：停用会破坏 dsh 启动/传输/设置与插件管理入口的官方核心行，
//     host 直接拒绝（client 徽章锁定、悬浮显示原因）；名单 = 社区 DEFAULT 集 + web 补充。
//   - T1（confirm，二次确认）：停用会明显降级但可恢复的核心服务行，host 放行、
//     client 先弹确认。条目 config 可扩展 protectedEntries / confirmEntries。
//   - 启用（enabled=true）从不拦截；保护只作用于「停用」方向。
//   手动编辑 cordis.patch.yml / CLI 仍可绕过（官方 patch 语义允许，UI 只防误点）。
//   - 可管理性（2026-09 A 方案）：只有 patch 可寻址的「声明行」才能从这里开关——
//     清单 entryId 必须形如 `include:<裸 id>`（单层 include 组，无更多冒号）。
//     loader/agent-presets 运行期自建行（`include:agent-presets:*` 嵌套预设行、
//     hex 动态行如 d103ba78）patch 写不到（点了只会 no-op 或串到同名基础行），
//     因此 protection 一律判 blocked、setEnabled 抛 PLUGIN_TOGGLE_UNMANAGEABLE。
//
// 模型提供商的「停用 / 启用」（providerToggle，设置 → 模型）自 2026 起剥离为
// 独立插件 dsh-provider-manager；本文件不再包含任何模型/提供商逻辑。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 本插件管理的 patch 文件：home 层 user patch（与 dsh-provider-manager 共用同一文件）。 */
function patchFilePath() {
	return join(resolveDshHome(), "cordis.patch.yml");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
* 匹配 `- id: <id>` 起始的完整条目块（含其后所有缩进行，直到下一个顶层条目）。
* @param {string} id - 条目 id。
* @returns {RegExp} 全局匹配的正则。
*/
function entryBlockPattern(id) {
	return new RegExp(`^[ \\t]*- id: ${escapeRegExp(id)}[ \\t]*\\n(?:[ \\t]+[^\\n]*\\n)*`, "gm");
}

/** 在文本中定位第一个目标条目块。 */
function findEntryBlock(text, id) {
	const match = entryBlockPattern(id).exec(text);
	return match === null ? void 0 : match[0];
}

/** 移除文本中满足 predicate 的目标条目块。 */
function removeEntryBlock(text, id, predicate) {
	const pattern = entryBlockPattern(id);
	let output = "";
	let last = 0;
	let removed = false;
	for (const match of text.matchAll(pattern)) {
		const block = match[0];
		if (!removed && predicate(block)) {
			removed = true;
			output += text.slice(last, match.index);
		} else {
			output += text.slice(last, match.index + block.length);
		}
		last = match.index + block.length;
	}
	output += text.slice(last);
	return output;
}

/** 追加一个 `- id: X\n  disabled: true` 条目（保持文件以换行结尾）。 */
function appendDisabledEntry(text, id) {
	let out = text;
	if (out.length > 0 && !out.endsWith("\n")) out += "\n";
	return out + `- id: ${id}\n  disabled: true\n`;
}

/** 追加一个 `- id: X\n  config: {}` 条目（search 配对用）。 */
function appendConfigEmptyEntry(text, id) {
	let out = text;
	if (out.length > 0 && !out.endsWith("\n")) out += "\n";
	return out + `- id: ${id}\n  config: {}\n`;
}

/**
* 停用 / 启用配对条目：停用 web-search-deepseek 时同时清空 web.searchProvider
* （config: {}），启用时一并恢复，保证搜索开关语义完整。
*/
const PAIRED_CONFIG_ENTRIES = { "web-search-deepseek": ["web"] };

/** 原子写文件（tmp + rename，避免 HMR 读到半截内容）。 */
function writeFileAtomic(filename, content) {
	const tmp = `${filename}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, filename);
}

/** 读取 patch 文件文本（不存在视为空）。 */
function readPatchText() {
	const file = patchFilePath();
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
* 取条目 id 的裸段：loader 清单（pluginInventory）里的条目 id 带 `include:` 组前缀
* （如 `include:llm-deepseek`），而 patch 文件按惯例写裸 id（`- id: llm-deepseek`）。
* 读写 patch 前必须去掉前缀，否则启用/停用都找不到目标条目块。
* @param {string} entryId - 清单或调用方给的条目 id。
* @returns {string} 裸 id（取最后一个 `:` 之后的部分）。
*/
function bareEntryId(entryId) {
	const value = String(entryId);
	const index = value.lastIndexOf(":");
	return index === -1 ? value : value.slice(index + 1);
}

/** 本页可管理的 loader 组前缀：include 组展开后，声明行的清单 entryId 形如 `include:<裸 id>`。 */
const MANAGEABLE_GROUPS = ["include"];

/**
* 行身份判定（2026-09 A 方案）：返回该 entryId 对应的 patch 可寻址 id；不可管理返回 undefined。
* 只有「声明行」可开关：entryId 必须是单层 `include:` 组下的 `<裸 id>`（不含更多冒号）。
* 运行期自建行一律不可管理：
*   - `include:agent-presets:*` 嵌套预设实例（两层冒号）——按裸 id 写 patch 只会串到同名基础行，
*     预设行本体不可寻址；
*   - loader 动态行（无 include 前缀的随机 hex，如 `d103ba78`）——patch 写不到；
*   对这些行 protection 判 blocked、setEnabled 抛 PLUGIN_TOGGLE_UNMANAGEABLE。
* 无前缀时只放行组/核心行自身（如 `include`，其停用方向本就受 T0 保护）。
* 组前缀可用条目 config 的 `manageGroups` 扩展（其它 profile / 组名用）。
* @param {string} entryId - 清单里的完整条目 id。
* @param {Set<string>|string[]} groups - 允许的组前缀集合。
* @returns {string | undefined} patch 可寻址的裸 id；不可管理时为 undefined。
*/
function patchIdOf(entryId, groups = MANAGEABLE_GROUPS) {
	const value = String(entryId);
	if (value.length === 0) return void 0;
	const has = (name) => groups instanceof Set ? groups.has(name) : groups.includes(name);
	const colon = value.indexOf(":");
	if (colon === -1) {
		// 无前缀：只放行组/核心行自身（如 `include`）；随机 hex 动态行不可管理。
		return has(value) ? value : void 0;
	}
	const group = value.slice(0, colon);
	const rest = value.slice(colon + 1);
	if (!has(group) || rest.includes(":") || rest.length === 0) return void 0;
	return rest;
}

/** 不可管理行的提示文案（protection 的 reason / setEnabled 的错误信息）。 */
function patchUnmanageableReason(entryId) {
	return `${entryId} 是 loader/agent-presets 运行期自动创建的行（非 patch 可寻址的声明行，如 agent-presets 预设实例或 loader 动态行），不能从这里停用/启用。预设行请编辑对应预设配置，loader 动态行由 loader 管理。`;
}

/**
* 设置一个 loader 条目的启用状态：
* - enabled=false：确保文件中存在 `- id: X` + `disabled: true`（不存在则追加）；
* - enabled=true ：移除文件中该 id 的所有带 `disabled` 字段的条目。
* 特殊配对：web-search-deepseek 会连带管理 `web` 条目的 `config: {}`。
* @param {{entryId: string, enabled: boolean}} request - 远程调用载荷。
* @returns {{entryId: string, enabled: boolean}} 应用后的状态。
*/
function applyToggle(request) {
	const { entryId, enabled } = request ?? {};
	if (typeof entryId !== "string" || entryId.length === 0) throw new Error("entryId must be a non-empty string");
	if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
	const id = bareEntryId(entryId);
	let text = readPatchText();
	if (enabled) {
		text = removeEntryBlock(text, id, (block) => /disabled:\s*(?:true|false)/.test(block));
		for (const paired of PAIRED_CONFIG_ENTRIES[id] ?? []) {
			text = removeEntryBlock(text, paired, (block) => /config:\s*\{\}/.test(block));
		}
	} else {
		if (!/disabled:\s*true/.test(findEntryBlock(text, id) ?? "")) text = appendDisabledEntry(text, id);
		for (const paired of PAIRED_CONFIG_ENTRIES[id] ?? []) {
			if (!/config:\s*\{\}/.test(findEntryBlock(text, paired) ?? "")) text = appendConfigEmptyEntry(text, paired);
		}
	}
	writeFileAtomic(patchFilePath(), text);
	return { entryId, enabled };
}

/** 本插件自身的 loader 条目 id：禁止从管理页停用（会失去恢复入口）。 */
const SELF_ENTRY_ID = "plugin-toggle";

/**
* T0 硬保护（停用会破坏启动/传输/设置与插件管理入口；host 拒绝 + client 锁定徽章）。
* 社区 dsh-plugin-manager DEFAULT_PROTECTED_IDS 原样 + web profile 补充。
*/
const PROTECTED_IDS = /* @__PURE__ */ new Set([
	// 社区 dsh-plugin-manager 默认集
	"api-gateway", "api-remotes", "connection", "client-hmr", "client-locale",
	"client-modules", "client-runtime", "cordis-host-runner", "hmr", "include",
	"locale", "modules", "runtime", "timer", "ui-settings", "ui-settings-general",
	"ui-settings-plugins", "webserver",
	// web profile 补充：Web 启动/运行面、浏览器 cordis 运行时、插件管理入口自身及其
	// 数据源、Typert 远程三层。
	// 注意 web-startup：webserver / web-runtime 都 `inject: [webStartup]` 并在 config 里
	// 引用 `ctx.webStartup.host/port/openBrowser/trustedHosts`，停用后 loader 无法解析
	// 这些行 → dsh web 无法启动（2026-09 真实事故，T0 化）。cordis-client-runner 停用则
	// 浏览器端 cordis（整个 UI 含设置/管理入口）不启动；plugin-inventory 是插件列表页的
	// 数据源，停用后管理页失效、无法从 UI 恢复自身。
	"web-startup", "web-runtime", "cordis-client-runner", "plugin-inventory",
	"ui-settings-plugin-inventory", "typert", "typert-loader", "typert-gateway"
]);

/**
* T1 二次确认（停用会明显降级但可恢复的官方核心服务行；host 放行，client 先确认）。
* 2026-09 深度扫描（对 web profile 138 行做 compose + 代码级 inject/provide 依赖遍历）补充：
* 被众多行注入、缺失会让消费方无法挂载的注册表/服务面（commands/goal/goal-round-driver/
* skills/system-prompt/session-projection/subagent），会话与代理组装（agent-presets/
* agent-default-model/llm-pi-ai[本部署唯一聊天 provider]），以及数据面
* （session-persistence-jsonl/attachment-local）。
*/
const CONFIRM_IDS = /* @__PURE__ */ new Set([
	"settings", "credentials", "llm", "session", "agent", "agent-loop",
	"tools", "storage", "storage-json", "storage-domain", "workspace", "web",
	// 2026-09 深度扫描补充（注册表 / 会话代理组装 / 数据面）
	"agent-presets", "agent-default-model", "llm-pi-ai", "subagent",
	"session-persistence-jsonl", "attachment-local", "session-projection",
	"system-prompt", "commands", "goal", "goal-round-driver", "skills"
]);

const PROTECTED_REASON = (id) => `${id} 是维持 dsh 启动 / 传输 / 设置与插件管理入口的核心条目，停用后 dsh 可能无法正常使用或无法从此页恢复，已加保护。`;
const CONFIRM_REASON = (id) => `停用 ${id} 会影响 dsh 核心服务（配置 / 凭据 / 模型 / 会话 / 工具等），相关功能将不可用。确认仍要停用吗？`;

/**
* 保护判定（启用方向从不拦截；只挡「停用」）。
* @param {string} id - 裸条目 id。
* @param {boolean} enabled - 期望状态（true=启用，false=停用）。
* @param {Set<string>} extraProtected - config.protectedEntries 合并集。
* @param {Set<string>} extraConfirm - config.confirmEntries 合并集。
* @returns {{level: "blocked"|"confirm"|"none", reason: string|null}}
*/
function protectionOf(id, enabled, extraProtected, extraConfirm) {
	if (enabled) return { level: "none", reason: null };
	if (id === SELF_ENTRY_ID) {
		return { level: "blocked", reason: "plugin-toggle 管理着本页开关，禁止停用自身，否则将失去恢复入口。" };
	}
	if (PROTECTED_IDS.has(id) || extraProtected.has(id)) {
		return { level: "blocked", reason: PROTECTED_REASON(id) };
	}
	if (CONFIRM_IDS.has(id) || extraConfirm.has(id)) {
		return { level: "confirm", reason: CONFIRM_REASON(id) };
	}
	return { level: "none", reason: null };
}

var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};

/** Typert Remote 服务：`pluginToggle.setEnabled` / `pluginToggle.protection`（loader 条目开关）。 */
let PluginToggleGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _setEnabled_decorators;
	let _protection_decorators;
	return class PluginToggleGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_setEnabled_decorators = [Remote("setEnabled")];
			_protection_decorators = [Remote("protection")];
			__esDecorate(this, null, _setEnabled_decorators, {
				kind: "method",
				name: "setEnabled",
				static: false,
				private: false,
				access: {
					has: (obj) => "setEnabled" in obj,
					get: (obj) => obj.setEnabled
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _protection_decorators, {
				kind: "method",
				name: "protection",
				static: false,
				private: false,
				access: {
					has: (obj) => "protection" in obj,
					get: (obj) => obj.protection
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		/** 插件条目开关只写 home 层 patch 文件，不需要注入任何 host 服务。 */
		static inject = [];
		/** config.protectedEntries / confirmEntries 可扩展保护名单（与社区 dsh-plugin-manager 同款写法）。 */
		constructor(ctx, config = {}) {
			super(ctx, "pluginToggle");
			this.protectedIds = new Set([...PROTECTED_IDS, ...(config.protectedEntries ?? [])]);
			this.confirmIds = new Set([...CONFIRM_IDS, ...(config.confirmEntries ?? [])]);
			// config.manageGroups 可扩展“可从本页开关”的组前缀（默认 include）。
			this.manageGroups = new Set([...MANAGEABLE_GROUPS, ...(config.manageGroups ?? [])]);
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		* 停用/启用一个 loader 条目（host 侧强制：非声明行拒绝；T0 直接拒绝）。
		* @param {{entryId: string, enabled: boolean}} request - 远程调用载荷。
		* @returns {{entryId: string, enabled: boolean}} 应用后的状态。
		* @throws {Error} PLUGIN_TOGGLE_UNMANAGEABLE / PLUGIN_TOGGLE_PROTECTED
		*/
		setEnabled(request) {
			const { entryId, enabled } = request ?? {};
			if (typeof entryId !== "string" || entryId.length === 0) throw new Error("entryId must be a non-empty string");
			if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
			const patchId = patchIdOf(entryId, this.manageGroups);
			if (patchId === void 0) {
				const error = new Error(patchUnmanageableReason(entryId));
				error.code = "PLUGIN_TOGGLE_UNMANAGEABLE";
				throw error;
			}
			const verdict = protectionOf(patchId, enabled, this.protectedIds, this.confirmIds);
			if (verdict.level === "blocked") {
				const error = new Error(verdict.reason);
				error.code = "PLUGIN_TOGGLE_PROTECTED";
				throw error;
			}
			return applyToggle(request);
		}
		/**
		* 只读保护判定（client 决定锁定/二次确认；与 setEnabled 同表，防止双份名单漂移）。
		* 不可管理的运行期行无论方向一律返回 blocked（阻止开关，仅展示状态）。
		* @param {{entryId: string, enabled: boolean}} request - 期望状态查询。
		* @returns {{level: "blocked"|"confirm"|"none", reason: string|null}}
		*/
		protection(request) {
			const { entryId, enabled } = request ?? {};
			if (typeof entryId !== "string" || entryId.length === 0) throw new Error("entryId must be a non-empty string");
			if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
			const patchId = patchIdOf(entryId, this.manageGroups);
			if (patchId === void 0) return { level: "blocked", reason: patchUnmanageableReason(entryId) };
			return protectionOf(patchId, enabled, this.protectedIds, this.confirmIds);
		}
	};
})();

export { PluginToggleGateway, PluginToggleGateway as default, CONFIRM_IDS, MANAGEABLE_GROUPS, PROTECTED_IDS, patchIdOf, protectionOf };
