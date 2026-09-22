// dsh-provider-manager — host 半区（只处理模型提供商）
//
// 单一 Typert Remote 命名空间 providerToggle（旧名沿用，语义即动作）：
//   providerToggle.list() —— 列出可停用/启用的模型提供商（设置 → 模型 的 llm.providers 目录）
//   providerToggle.setEnabled(provider, enabled) —— 停用/启用一个模型提供商：
//       · settingsPath 非空（pi-ai 类，如 llm-pi-ai.providers.<网关id>）：把该 provider 的
//         配置备份到 $DSH_HOME/dsh-provider-toggle.state.json（状态文件名沿用旧插件名，
//         不随改名迁移），再从 settings 文档移除，路由随即注销（配置保留、随时恢复）；
//       · settingsPath 为空（整段适配器，如 deepseek-official）：停用其适配器 loader 条目
//         （cordis.patch.yml 的 `- id: <ns>\n  disabled: true`，home 层），settings 文档原样保留。
//
// 插件条目的「停用 / 启用」（pluginToggle，设置 → 插件 → 插件列表）自 2026 起剥离为
// 独立插件 dsh-plugin-toggle，本文件不再包含任何插件管理逻辑。
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 模型适配器条目的停用状态写入同一个 home 层 user patch（与 dsh-plugin-toggle 共用）。 */
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
* 取条目 id 的裸段：loader 清单里的条目 id 可能带 `include:` 组前缀，而 patch 文件
* 按惯例写裸 id。读写 patch 前必须去掉前缀。
* @param {string} entryId - 调用方给的条目 id。
* @returns {string} 裸 id（取最后一个 `:` 之后的部分）。
*/
function bareEntryId(entryId) {
	const value = String(entryId);
	const index = value.lastIndexOf(":");
	return index === -1 ? value : value.slice(index + 1);
}

/**
* 设置一个模型适配器 loader 条目的启用状态（provider 的 settingsPath 为空时用）：
* - enabled=false：确保文件中存在 `- id: X` + `disabled: true`（不存在则追加）；
* - enabled=true ：移除文件中该 id 的所有带 `disabled` 字段的条目。
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
	} else {
		if (!/disabled:\s*true/.test(findEntryBlock(text, id) ?? "")) text = appendDisabledEntry(text, id);
	}
	writeFileAtomic(patchFilePath(), text);
	return { entryId, enabled };
}

/**
* 本插件管理的提供商停用状态文件（JSON；备份被停用 provider 的完整配置）。
* 文件名沿用旧插件名 dsh-provider-toggle.state.json，与历史版本无缝衔接。
*/
function providerStateFilePath() {
	return join(resolveDshHome(), "dsh-provider-toggle.state.json");
}

/** 读取提供商停用状态（不存在或损坏视为空）。 */
function readProviderState() {
	const file = providerStateFilePath();
	if (!existsSync(file)) return { disabledProviders: {} };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed === null || typeof parsed !== "object" || parsed.disabledProviders === null || typeof parsed.disabledProviders !== "object") return { disabledProviders: {} };
		return { disabledProviders: parsed.disabledProviders };
	} catch {
		return { disabledProviders: {} };
	}
}

/** 原子写提供商停用状态。 */
function writeProviderState(state) {
	writeFileAtomic(providerStateFilePath(), JSON.stringify(state, null, 2) + "\n");
}

/**
* 读 settings 文档中 (ns, path) 处的原始用户配置（无用户段或路径不存在则 undefined）。
* @param {object} settings - host `settings` 服务（SettingsProvider）。
* @param {string} ns - 配置命名空间（如 "llm-pi-ai"）。
* @param {string[]} path - 段内路径（空数组 = 整个用户段）。
* @returns {unknown} 该处的原始用户配置，或 undefined。
*/
function providerProfileAt(settings, ns, path) {
	let descriptor;
	for (const candidate of settings.describe()) {
		if (candidate.ns === ns) {
			descriptor = candidate;
			break;
		}
	}
	const source = descriptor?.user;
	if (source === void 0 || source === null || typeof source !== "object") return void 0;
	let node = source;
	for (const segment of path) {
		if (node === void 0 || node === null || typeof node !== "object") return void 0;
		node = node[segment];
	}
	return node;
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

/** Typert Remote 服务：`providerToggle.list` / `providerToggle.setEnabled`（模型提供商开关）。 */
let ProviderToggleGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _setEnabled_decorators;
	return class ProviderToggleGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_setEnabled_decorators = [Remote("setEnabled")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
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
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		/** 模型提供商开关需要 llm（目录/路由）与 settings（文档读写）服务。 */
		static inject = ["llm", "settings"];
		constructor(ctx) {
			super(ctx, "providerToggle");
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		* 列出可停用/启用的模型提供商：
		* 目录中 active / 已配置 / 本插件停用过的行，外加状态文件中目录已消失的行。
		* @returns {{providers: Array<{provider, displayName, active, configured, disabled, mechanism}>}}
		*/
		list() {
			const llm = this.ctx.llm;
			const settings = this.ctx.settings;
			const savedMap = readProviderState().disabledProviders;
			const rows = [];
			const seen = new Set();
			for (const entry of llm.listConfigurableProviders()) {
				const active = llm.adapters.has(entry.provider);
				const configured = providerProfileAt(settings, entry.settingsNs, entry.settingsPath) !== void 0;
				const saved = savedMap[entry.provider];
				if (!active && !configured && saved === void 0) continue;
				seen.add(entry.provider);
				rows.push({
					provider: entry.provider,
					displayName: entry.displayName,
					active,
					configured,
					disabled: saved !== void 0,
					mechanism: saved?.mechanism ?? (entry.settingsPath.length === 0 ? "entry" : "settings")
				});
			}
			for (const [provider, saved] of Object.entries(savedMap)) {
				if (seen.has(provider)) continue;
				rows.push({
					provider,
					displayName: saved.displayName ?? provider,
					active: false,
					configured: false,
					disabled: true,
					mechanism: saved.mechanism ?? "entry"
				});
			}
			rows.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
			return { providers: rows };
		}
		/**
		* 停用 / 启用一个模型提供商：
		* - 停用（settingsPath 非空）：备份配置到状态文件，再从 settings 文档移除该段，
		*   适配器热加载后路由注销（配置保留）；
		* - 停用（settingsPath 为空）：停用其适配器 loader 条目（cordis.patch.yml）；
		* - 启用：恢复备份（settings 机制）或移除适配器条目的 disabled（entry 机制）。
		* @param {{provider: string, enabled: boolean}} request - 远程调用载荷。
		* @returns {{provider: string, enabled: boolean}} 应用后的状态。
		*/
		async setEnabled(request) {
			const { provider, enabled } = request ?? {};
			if (typeof provider !== "string" || provider.length === 0) throw new Error("provider must be a non-empty string");
			if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
			const state = readProviderState();
			const savedMap = state.disabledProviders;
			const saved = savedMap[provider];
			if (enabled) {
				if (saved === void 0) throw new Error(`提供商 "${provider}" 当前未被停用，无需启用`);
				if (saved.mechanism === "entry") {
					applyToggle({ entryId: saved.settingsNs, enabled: true });
				} else {
					await this.ctx.settings.mutate(saved.settingsNs, [{ op: "set", path: saved.settingsPath, value: saved.profile }]);
				}
				delete savedMap[provider];
				writeProviderState(state);
				return { provider, enabled: true };
			}
			const llm = this.ctx.llm;
			const entry = llm.listConfigurableProviders().find((candidate) => candidate.provider === provider);
			if (entry === void 0) throw new Error(`未知的模型提供商 "${provider}"`);
			if (entry.settingsPath.length === 0) {
				// 整段适配器（如 deepseek-official）：停用其 loader 条目，settings 文档原样保留。
				applyToggle({ entryId: entry.settingsNs, enabled: false });
				savedMap[provider] = {
					mechanism: "entry",
					displayName: entry.displayName,
					settingsNs: entry.settingsNs,
					settingsPath: []
				};
				writeProviderState(state);
				return { provider, enabled: false };
			}
			const profile = providerProfileAt(this.ctx.settings, entry.settingsNs, entry.settingsPath);
			if (profile === void 0) throw new Error(`提供商 "${provider}" 没有已保存的配置，无法停用`);
			savedMap[provider] = {
				mechanism: "settings",
				displayName: entry.displayName,
				settingsNs: entry.settingsNs,
				settingsPath: [...entry.settingsPath],
				profile
			};
			writeProviderState(state);
			try {
				await this.ctx.settings.mutate(entry.settingsNs, [{ op: "unset", path: [...entry.settingsPath] }]);
			} catch (error) {
				delete savedMap[provider];
				writeProviderState(state);
				throw error;
			}
			return { provider, enabled: false };
		}
	};
})();

export { ProviderToggleGateway, ProviderToggleGateway as default };
