// dsh-plugin-toggle — 给 shipped 的「设置 → 插件 → 插件列表」页
// （ui-settings-plugin-inventory）打补丁：**不新增任何按钮**，直接把卡片行尾的状态徽章
// 变成 停用/启用 开关 —— 点击徽章即切换该 loader 条目的启用状态（stopPropagation，
// 不触发行卡片"展开详情"）。
//
// v5（面向 DSH 0.1.5 的 bundle，2026-09）：
//   - 0.1.5 重写了这一页，锚点全部换掉：
//       · 行状态从 `<span class=configTag data-enabled>` 变成 `StateTag({ kind, label })` 组件
//         （调 ui-primitives 的 Tag），卡片本体抽成 `PluginCard({ …, trailing })`，状态由调用方
//         以 trailing 传入 —— 所以补丁改成给 StateTag 增加可选的 toggle 语义，再在两处调用点传入；
//       · `matches(entry, query)` 变成 `matches(moduleName, entryId, query)`，行对象也不再是
//         entry（预设行是 `row`、全局行是 `entry`），helper 相应取 (entryId, moduleName)；
//       · snapshot 已是组件里的既有变量（`const snapshot = state.status === "ready" ? …`），
//         预取 effect 直接挂在它后面，不再重复声明（重复声明会 SyntaxError）；
//       · 行渲染函数是 `presetRowCard(preset, row, index)` 与 `globalRowCard(entry, providers)`。
//   - 行为与 v4 一致：blocked（T0 硬保护 / host 判定的不可管理行）徽章锁定并显示原因；
//     confirm（T1）只在"停用"方向弹一次 window.confirm；本插件自身条目不做开关；
//     条件启用（enabled 非布尔）的行保持只读徽章。
//
// 历史：v4/v3 是面向 0.1.1 bundle 的锚点（configTag 徽章 + PluginInventorySettingsTab({ list, t })），
// 已被本版取代；v1/v2 曾注入独立按钮，也已废弃。
//
// 说明：
//   - 状态徽章仍是 shipped 的那个 Tag，只在外层包一个 role="switch" 的 span 承载
//     键盘/点击语义（Tab、Enter/Space、aria-checked、动态 title/aria-label），不新增控件；
//   - 点徽章以外的任意处照常展开/收起卡片详情；
//   - host 侧（lib/index.js）是唯一的状态机：protection / setEnabled 都走它的 Typert Remote，
//     UI 只防误点，手动编辑 cordis.patch.yml 仍可绕过。
//
// 用法：
//   node scripts/patch-plugins-inventory-bundle.mjs [--revert] [--bundle <path>]
// 默认目标：<$DSH_HOME 或 ~/.dsh>/profiles/node_modules/@deepseek-ai/
//           dsh-client-ui-settings-plugin-inventory/lib/client.js
// 给隔离实例打补丁时用 --bundle 显式指定，避免动到正在运行的真实 home。

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const bundleArg = args.find((value, index) => args[index - 1] === "--bundle");

// 默认按 $DSH_HOME 推导（隔离实例请显式传 --bundle，别让默认值指到真实 home）。
const HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const DEFAULT_BUNDLE = join(HOME, "profiles", "node_modules", "@deepseek-ai", "dsh-client-ui-settings-plugin-inventory", "lib", "client.js");
const BUNDLE = bundleArg ?? DEFAULT_BUNDLE;
const BACKUP = `${BUNDLE}.dsh-plugin-toggle.bak`;
const MARKER = "dsh-plugin-toggle-v5";
// 旧设计的标记：命中即说明 bundle 上是旧补丁，先借 .bak 还原再重打。
const LEGACY = [
	"dsh-plugin-toggle-v4",
	"dsh-plugin-toggle-v3",
	"dsh-plugin-toggle-v2",
	"dsh-plugin-toggle: 插件列表行内",
	"dsh-provider-toggle: 插件列表行内",
	"dsh-provider-toggle-v2"
];

if (!existsSync(BUNDLE)) {
	console.error(`bundle not found: ${BUNDLE}`);
	console.error("0.1.5 的隔离实例请用 --bundle 指定该实例里的同名 bundle。");
	process.exit(1);
}

if (revert) {
	if (!existsSync(BACKUP)) {
		console.error(`no backup to revert: ${BACKUP}`);
		process.exit(1);
	}
	copyFileSync(BACKUP, BUNDLE);
	console.log(`reverted ${BUNDLE} from backup`);
	process.exit(0);
}

let source = readFileSync(BUNDLE, "utf8");
if (source.includes(MARKER)) {
	console.log("already patched (v5, badge-as-switch for 0.1.5) — nothing to do (use --revert to restore the backup)");
	process.exit(0);
}
const legacyHit = LEGACY.find((value) => source.includes(value));
if (legacyHit !== void 0) {
	console.log(`legacy patch detected (${legacyHit}) — reverting from backup, then applying …`);
	if (!existsSync(BACKUP)) {
		console.error(`no backup to revert: ${BACKUP}`);
		console.error("restore the bundle manually, then rerun this script.");
		process.exit(1);
	}
	copyFileSync(BACKUP, BUNDLE);
	source = readFileSync(BUNDLE, "utf8");
}

/** 行模板：每行以单个 \t 开头，行内缩进用 \t 平铺。 */
const T = (level) => "\t".repeat(level);

const L_ACTIVATE_GUARD = (row) => `if (isSelfEntry(${row}.entryId, ${row}.moduleName) || prot?.level === "blocked") return;`;
const L_ACTIVATE_CONFIRM = (row) => `if (${row}.enabled === true && prot?.level === "confirm" && !window.confirm(prot?.reason ?? \`确认停用 \${title}？\`)) return;`;
const L_ACTIVATE_ALERT = (row) => `window.alert(\`\${${row}.enabled === true ? "停用" : "启用"} \${title} 失败：\${error instanceof Error ? error.message : String(error)}\`);`;

/** 一处 <StateTag> 的替换：把徽章变成开关（row 变量名随调用点不同）。 */
function tagSwitch(row) {
	return [
		`${T(5)}}) : null, (0, react_jsx_runtime.jsx)(StateTag, {`,
		`${T(6)}kind,`,
		`${T(6)}label: stateText,`,
		`${T(6)}// dsh-plugin-toggle-v5: 徽章即开关（enabled 非布尔的条件行保持只读）`,
		`${T(6)}toggle: ${row}.enabled === true || ${row}.enabled === false ? {`,
		`${T(7)}checked: ${row}.enabled === true,`,
		`${T(7)}locked: prot?.level === "blocked",`,
		`${T(7)}lockReason: prot?.reason,`,
		`${T(7)}self: isSelfEntry(${row}.entryId, ${row}.moduleName),`,
		`${T(7)}busy: busyId === ${row}.entryId,`,
		`${T(7)}name: title,`,
		`${T(7)}activate: () => {`,
		`${T(8)}${L_ACTIVATE_GUARD(row)}`,
		`${T(8)}${L_ACTIVATE_CONFIRM(row)}`,
		`${T(8)}setBusyId(${row}.entryId);`,
		`${T(8)}setEntryEnabled(${row}.entryId, ${row}.enabled !== true).then(() => {`,
		`${T(9)}retry();`,
		`${T(8)}}, (error) => {`,
		`${T(9)}${L_ACTIVATE_ALERT(row)}`,
		`${T(8)}}).finally(() => {`,
		`${T(9)}setBusyId(null);`,
		`${T(8)}});`,
		`${T(7)}}`,
		`${T(6)}} : void 0`,
		`${T(5)}})] }),`
	].join("\n");
}

/** 行渲染函数里补一行 prot（同一函数内的返回值之后使用）。 */
const L_PROT = (row) => `${T(4)}const prot = protections[${row}.entryId];`;

const replacements = [
	{
		name: "R1 helpers: bareEntryId + isSelfEntry（0.1.5 的 matches 签名）",
		old: [
			`${T(2)}/** Whether one row's module name or entry id matches the catalog query. */`,
			`${T(2)}function matches(moduleName, entryId, normalizedQuery) {`,
			`${T(3)}if (normalizedQuery.length === 0) return true;`,
			`${T(3)}return [moduleName, ...entryId === null ? [] : [entryId]].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));`,
			`${T(2)}}`
		].join("\n"),
		new: [
			`${T(2)}/** Whether one row's module name or entry id matches the catalog query. */`,
			`${T(2)}function matches(moduleName, entryId, normalizedQuery) {`,
			`${T(3)}if (normalizedQuery.length === 0) return true;`,
			`${T(3)}return [moduleName, ...entryId === null ? [] : [entryId]].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));`,
			`${T(2)}}`,
			`${T(2)}// dsh-plugin-toggle-v5: 徽章即开关；T0 / 不可管理行锁定、T1 停用前确认（host 同表强制）`,
			`${T(2)}/** 取条目 id 裸段（去掉 include: 组前缀），与 patch 文件写法一致。 */`,
			`${T(2)}function bareEntryId(entryId) {`,
			`${T(3)}const value = String(entryId);`,
			`${T(3)}const index = value.lastIndexOf(":");`,
			`${T(3)}return index === -1 ? value : value.slice(index + 1);`,
			`${T(2)}}`,
			`${T(2)}/** 本插件自身的条目不做开关，避免把自己停掉（点击退回普通展开行为）。 */`,
			`${T(2)}function isSelfEntry(entryId, moduleName) {`,
			`${T(3)}if (moduleName === "dsh-plugin-toggle") return true;`,
			`${T(3)}return entryId !== null && typeof entryId === "string" && bareEntryId(entryId) === "plugin-toggle";`,
			`${T(2)}}`
		].join("\n")
	},
	{
		name: "R2 组件签名 + busy/protections 状态",
		old: [
			`${T(2)}function PluginInventorySettingsTab({ list, presetName, t }) {`,
			`${T(3)}const sectionId = (0, react.useId)();`,
			`${T(3)}const [request, setRequest] = (0, react.useState)(0);`,
			`${T(3)}const [query, setQuery] = (0, react.useState)("");`,
			`${T(3)}const [expanded, setExpanded] = (0, react.useState)(null);`
		].join("\n"),
		new: [
			`${T(2)}function PluginInventorySettingsTab({ list, presetName, t, setEntryEnabled, protectionFor }) {`,
			`${T(3)}const sectionId = (0, react.useId)();`,
			`${T(3)}const [request, setRequest] = (0, react.useState)(0);`,
			`${T(3)}const [query, setQuery] = (0, react.useState)("");`,
			`${T(3)}const [expanded, setExpanded] = (0, react.useState)(null);`,
			`${T(3)}const [busyId, setBusyId] = (0, react.useState)(null);`,
			`${T(3)}const [protections, setProtections] = (0, react.useState)({});`
		].join("\n")
	},
	{
		name: "R3 预取 host 判定（挂在既有的 snapshot 之后）",
		old: `${T(3)}const snapshot = state.status === "ready" ? state.snapshot : void 0;`,
		new: [
			`${T(3)}const snapshot = state.status === "ready" ? state.snapshot : void 0;`,
			`${T(3)}// dsh-plugin-toggle-v5: 清单就绪后对**全部条目**预取判定（不只已启用）：`,
			`${T(3)}//   blocked -> 徽章锁定（title/aria 显示原因）：T0 保护行，或 host 判定的不可管理行`,
			`${T(3)}//   confirm -> 仅对已启用条目在"停用"时先弹确认（启用方向从不拦截）`,
			`${T(3)}(0, react.useEffect)(() => {`,
			`${T(4)}const rows = snapshot?.entries ?? [];`,
			`${T(4)}if (rows.length === 0) {`,
			`${T(5)}setProtections({});`,
			`${T(5)}return;`,
			`${T(4)}}`,
			`${T(4)}let alive = true;`,
			`${T(4)}Promise.all(rows.map((row) => protectionFor(row.entryId, false).then((verdict) => ({ id: row.entryId, verdict }), () => void 0))).then((results) => {`,
			`${T(5)}if (!alive) return;`,
			`${T(5)}const next = {};`,
			`${T(5)}for (const item of results) {`,
			`${T(6)}if (item !== void 0 && item.verdict !== void 0) next[item.id] = item.verdict;`,
			`${T(5)}}`,
			`${T(5)}setProtections(next);`,
			`${T(4)}});`,
			`${T(4)}return () => {`,
			`${T(5)}alive = false;`,
			`${T(4)}};`,
			`${T(3)}}, [snapshot]);`
		].join("\n")
	},
	{
		name: "R4 StateTag 增加可选开关语义（无 toggle 时保持只读）",
		old: [
			`${T(2)}/** Enablement tag; \`kind\` selects the palette. */`,
			`${T(2)}function StateTag({ kind, label }) {`,
			`${T(3)}return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {`,
			`${T(4)}tone: TAG_TONES[kind],`,
			`${T(4)}children: label`,
			`${T(3)}});`,
			`${T(2)}}`
		].join("\n"),
		new: [
			`${T(2)}/** Enablement tag; \`kind\` selects the palette. */`,
			`${T(2)}function StateTag({ kind, label, toggle }) {`,
			`${T(3)}const tag = (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {`,
			`${T(4)}tone: TAG_TONES[kind],`,
			`${T(4)}children: label`,
			`${T(3)}});`,
			`${T(3)}// dsh-plugin-toggle-v5: 不新增控件——给现有状态徽章加开关语义；无 toggle 时原样返回`,
			`${T(3)}if (toggle === void 0) return tag;`,
			`${T(3)}const locked = toggle.locked === true || toggle.self === true;`,
			`${T(3)}const reason = toggle.self === true ? "本插件自身的条目：徽章不切换状态" : toggle.locked === true ? toggle.lockReason ?? "受保护：核心条目，禁止停用" : void 0;`,
			`${T(3)}const text = \`\${toggle.checked ? "停用" : "启用"} \${toggle.name}\`;`,
			`${T(3)}return (0, react_jsx_runtime.jsx)("span", {`,
			`${T(4)}role: "switch",`,
			`${T(4)}"aria-checked": toggle.checked ? "true" : "false",`,
			`${T(4)}"aria-label": reason ?? text,`,
			`${T(4)}title: reason ?? text,`,
			`${T(4)}tabIndex: locked ? void 0 : 0,`,
			`${T(4)}onClick: (event) => {`,
			`${T(5)}if (locked) return;`,
			`${T(5)}event.stopPropagation();`,
			`${T(5)}toggle.activate();`,
			`${T(4)}},`,
			`${T(4)}onKeyDown: (event) => {`,
			`${T(5)}if (locked) return;`,
			`${T(5)}if (event.key !== "Enter" && event.key !== " ") return;`,
			`${T(5)}event.preventDefault();`,
			`${T(5)}event.stopPropagation();`,
			`${T(5)}event.currentTarget.click();`,
			`${T(4)}},`,
			`${T(4)}style: {`,
			`${T(5)}display: "inline-flex",`,
			`${T(5)}cursor: locked ? void 0 : "pointer",`,
			`${T(5)}opacity: toggle.busy === true ? 0.6 : void 0,`,
			`${T(5)}pointerEvents: toggle.busy === true ? "none" : void 0`,
			`${T(4)}},`,
			`${T(4)}children: tag`,
			`${T(3)}});`,
			`${T(2)}}`
		].join("\n")
	},
	{
		name: "R5 预设行：prot 引用",
		old: [
			`${T(3)}const presetRowCard = (preset, row, index) => {`,
			`${T(4)}const key = \`preset:\${preset.id}:\${String(index)}\`;`,
			`${T(4)}const title = moduleShortName(row.moduleName);`
		].join("\n"),
		new: [
			`${T(3)}const presetRowCard = (preset, row, index) => {`,
			`${T(4)}const key = \`preset:\${preset.id}:\${String(index)}\`;`,
			`${T(4)}const title = moduleShortName(row.moduleName);`,
			L_PROT("row")
		].join("\n")
	},
	{
		name: "R6 预设行：徽章 -> 开关",
		old: [
			`${T(5)}trailing: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [row.enabled === true && !failed && row.fiberPhase !== null ? (0, react_jsx_runtime.jsx)(PhaseDot, {`,
			`${T(6)}phase: row.fiberPhase,`,
			`${T(6)}t`,
			`${T(5)}}) : null, (0, react_jsx_runtime.jsx)(StateTag, {`,
			`${T(6)}kind,`,
			`${T(6)}label: stateText`,
			`${T(5)}})] }),`
		].join("\n"),
		new: [
			`${T(5)}trailing: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [row.enabled === true && !failed && row.fiberPhase !== null ? (0, react_jsx_runtime.jsx)(PhaseDot, {`,
			`${T(6)}phase: row.fiberPhase,`,
			`${T(6)}t`,
			tagSwitch("row")
		].join("\n")
	},
	{
		name: "R7 全局行：prot 引用",
		old: [
			`${T(3)}const globalRowCard = (entry, providers) => {`,
			`${T(4)}const key = \`global:\${entry.entryId}\`;`,
			`${T(4)}const title = moduleShortName(entry.moduleName);`
		].join("\n"),
		new: [
			`${T(3)}const globalRowCard = (entry, providers) => {`,
			`${T(4)}const key = \`global:\${entry.entryId}\`;`,
			`${T(4)}const title = moduleShortName(entry.moduleName);`,
			L_PROT("entry")
		].join("\n")
	},
	{
		name: "R8 全局行：徽章 -> 开关",
		old: [
			`${T(5)}trailing: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [entry.enabled && !failed && entry.fiberPhase !== null ? (0, react_jsx_runtime.jsx)(PhaseDot, {`,
			`${T(6)}phase: entry.fiberPhase,`,
			`${T(6)}t`,
			`${T(5)}}) : null, (0, react_jsx_runtime.jsx)(StateTag, {`,
			`${T(6)}kind,`,
			`${T(6)}label: stateText`,
			`${T(5)}})] }),`
		].join("\n"),
		new: [
			`${T(5)}trailing: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [entry.enabled && !failed && entry.fiberPhase !== null ? (0, react_jsx_runtime.jsx)(PhaseDot, {`,
			`${T(6)}phase: entry.fiberPhase,`,
			`${T(6)}t`,
			tagSwitch("entry")
		].join("\n")
	},
	{
		name: "R9 apply: protectionFor + setEntryEnabled 注入",
		old: [
			`${T(3)}const injected = () => ({`,
			`${T(4)}list,`,
			`${T(4)}presetName`,
			`${T(3)}});`
		].join("\n"),
		new: [
			`${T(3)}// dsh-plugin-toggle-v5: 经官方 gateway 提供的 remote 服务调用本插件 host 半区`,
			`${T(3)}const toggleRemote = () => {`,
			`${T(4)}const pluginToggle = ctx.get("remote")?.pluginToggle;`,
			`${T(4)}if (pluginToggle === void 0) throw new Error("dsh-plugin-toggle 未挂载（请重启 dsh web）");`,
			`${T(4)}return pluginToggle;`,
			`${T(3)}};`,
			`${T(3)}const callToggle = async (method, payload) => {`,
			`${T(4)}const result = await toggleRemote()[method](payload);`,
			`${T(4)}if (!result.ok) throw new Error(\`\${result.error.code}: \${result.error.message}\`);`,
			`${T(4)}return result.value;`,
			`${T(3)}};`,
			`${T(3)}const protectionFor = (entryId, enabled) => callToggle("protection", { entryId, enabled });`,
			`${T(3)}const setEntryEnabled = (entryId, enabled) => callToggle("setEnabled", { entryId, enabled });`,
			`${T(3)}const injected = () => ({`,
			`${T(4)}list,`,
			`${T(4)}presetName,`,
			`${T(4)}setEntryEnabled,`,
			`${T(4)}protectionFor`,
			`${T(3)}});`
		].join("\n")
	}
];

let output = source;
for (const { name, old, new: next } of replacements) {
	const count = output.split(old).length - 1;
	if (count !== 1) {
		console.error(`patch aborted: "${name}" matched ${count} times (expected exactly 1)`);
		console.error("the installed dsh-client-ui-settings-plugin-inventory version likely differs from the anchors;");
		console.error("update scripts/patch-plugins-inventory-bundle.mjs for the new bundle, or run with --revert.");
		process.exit(1);
	}
	output = output.replace(old, next);
	console.log(`ok: ${name}`);
}

copyFileSync(BUNDLE, BACKUP);
writeFileSync(BUNDLE, output, "utf8");
console.log(`backup written: ${BACKUP}`);

const check = spawnSync(process.execPath, ["--check", BUNDLE], { encoding: "utf8" });
if (check.status !== 0) {
	console.error("node --check FAILED — restoring backup:");
	console.error(check.stderr);
	copyFileSync(BACKUP, BUNDLE);
	process.exit(1);
}
console.log("node --check passed");
console.log(`patched: ${BUNDLE}`);
