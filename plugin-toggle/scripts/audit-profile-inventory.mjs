// dsh-plugin-toggle — 审计工具：还原指定 profile 的 loader 最终行表（只读，不写任何文件）。
//
// 复用 dsh 官方加载器的组合逻辑（@deepseek-ai/dsh-app-boot 的 loadProfile / composeEntries），
// 与真实启动时跑的是同一段合并代码，因此输出 = 实际挂载的行全集（含 bundle 层 insert、
// profile/home 层 targeted patch 的 disabled/config 覆盖）。
//
// 用法：
//   node scripts/audit-profile-inventory.mjs [profile] [--json]
//   - profile 默认 web；--json 输出纯 JSON（否则打印人类可读表格）。
//
// 该文件仅供审计，dsh-plugin-toggle 运行不依赖它。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const profile = args.find((value) => !value.startsWith("--")) ?? "web";
const json = args.includes("--json");
const deps = args.includes("--deps");

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE_DIR = join(DSH_HOME, "profiles", profile);
// 与真实运行一致的解析锚点：profile 侧安装的 dsh 包（与运行时同一份产物）。
const INSTALL_ANCHOR = join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json");

if (!existsSync(PROFILE_DIR)) {
	console.error(`profile dir not found: ${PROFILE_DIR}`);
	process.exit(1);
}

const appBoot = await import(pathToFileURL(join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js")).href);
const homePaths = await import(pathToFileURL(join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh-home-paths", "lib", "index.js")).href);

const { loadProfile, loadOptionalPatches, composeEntries, PROFILE_PATCH_FILENAME } = appBoot;
const { resolveDshHome } = homePaths;

// ---- 镜像 @deepseek-ai/dsh profile-boot 的 composeProfile（只读部分） ----
const profileInfo = loadProfile("dsh", profile, INSTALL_ANCHOR, resolveDshHome(), { userLayer: true });
const homePatches = loadOptionalPatches("dsh", join(resolveDshHome(), PROFILE_PATCH_FILENAME)) ?? [];
const rows = new Map();
for (const row of composeEntries(
	[
		profileInfo.layers.flatMap((layer) => layer.patches),
		profileInfo.patches,
		homePatches,
		[]
	],
	(message) => console.error(`[compose warn] ${message}`)
)) {
	if (typeof row.id === "string") rows.set(row.id, row);
}

// agent-presets 的 shipped roots overlay 与 telemetry 开关只改 config / 个别禁用，不影响行存在性；
// telemetry 仅在设置了 DSH_TELEMETRY_DISABLED 时禁用（与 launch 一致）。
if (rows.has("session-telemetry-otel") && (process.env.DSH_TELEMETRY_DISABLED ?? "") !== "") {
	rows.get("session-telemetry-otel").disabled = true;
}

const entries = [...rows.values()].map((row) => ({
	id: row.id,
	name: row.name ?? null,
	disabled: row.disabled ?? false,
	inject: row.inject ?? null
})).sort((a, b) => a.id.localeCompare(b.id));

// ---- --deps：代码级依赖边（模块 lib/index.js 的 inject / 提供服务名） ----
const codeDeps = [];
if (deps) {
	const MODULE_ROOT = join(DSH_HOME, "profiles", "node_modules");
	const seen = new Set();
	for (const row of rows.values()) {
		const moduleName = row.name;
		if (typeof moduleName !== "string") continue;
		if (seen.has(moduleName)) continue;
		seen.add(moduleName);
		let dir;
		if (moduleName.startsWith("@deepseek-ai/")) dir = join(MODULE_ROOT, moduleName);
		else dir = join(PROFILE_DIR, "node_modules", moduleName);
		const indexFile = join(dir, "lib", "index.js");
		if (!existsSync(indexFile)) continue;
		let text;
		try {
			text = readFileSync(indexFile, "utf8");
		} catch {
			continue;
		}
		const injectNames = [];
		const injectRe = /(?:export\s+)?const\s+inject\s*=\s*\[([\s\S]*?)\]/g;
		let im;
		while ((im = injectRe.exec(text)) !== null) {
			for (const m of im[1].matchAll(/"([^"]+)"/g)) injectNames.push(m[1]);
		}
		const provides = [];
		const svcRe = /super\(ctx,\s*"([^"]+)"\)|ctx\.provide\(\s*"([^"]+)"\s*,|provide\(\s*"([^"]+)"\s*,/g;
		let sm;
		while ((sm = svcRe.exec(text)) !== null) provides.push(sm[1] ?? sm[2] ?? sm[3]);
		if (injectNames.length > 0 || provides.length > 0) {
			codeDeps.push({ moduleName, injects: [...new Set(injectNames)], provides: [...new Set(provides)] });
		}
	}
}

if (json) {
	console.log(JSON.stringify({ profile, layers: profileInfo.layers.map((l) => l.packageName), entries, codeDeps }, null, 2));
} else {
	console.log(`# profile: ${profile}`);
	console.log(`# bundle layers: ${profileInfo.layers.map((l) => l.packageName).join(" -> ")}`);
	console.log(`# total rows: ${entries.length} (disabled: ${entries.filter((e) => e.disabled).length})`);
	console.log("");
	for (const entry of entries) {
		const tag = entry.disabled ? "OFF" : "on ";
		console.log(`${tag}  ${entry.id.padEnd(38)} ${entry.name ?? ""}${entry.inject ? `  inject=[${entry.inject.join(",")}]` : ""}`);
	}
	if (deps) {
		console.log("");
		console.log("# code-level inject/provide (lib/index.js of each module):");
		for (const item of codeDeps.sort((a, b) => a.moduleName.localeCompare(b.moduleName))) {
			const parts = [];
			if (item.injects.length > 0) parts.push(`inject=[${item.injects.join(",")}]`);
			if (item.provides.length > 0) parts.push(`provides=[${item.provides.join(",")}]`);
			console.log(`${item.moduleName}  ${parts.join("  ")}`);
		}
	}
}
