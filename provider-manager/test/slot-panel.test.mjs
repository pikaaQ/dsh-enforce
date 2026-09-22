// dsh-provider-manager — client 半区（浏览器端）的插槽面板行为测试。
//
// 不依赖浏览器：把 lib/client.js（一个 window.__ModuleLoader__.load 脚本）在 Node 里执行，
// 用假的 ctx 抓住 slots.register 的注册项，再用 react-test-renderer 真渲染这个面板，
// 断言：① 面板把 host 的 list() 结果按行渲染出来（含被停用、目录已消失的保留行）；
//      ② 点「停用/启用」按钮会以 { provider, enabled } 调用 remote 的 setEnabled；
//      ③ 成功后重新拉取列表（reload），失败则在面板上给出错误文案。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import react from "react";
import TestRenderer from "react-test-renderer";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_SOURCE = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** 在 window.__ModuleLoader__ 存在的前提下执行 client 脚本，拿回它的模块导出。 */
function loadClient() {
	let captured;
	const previous = globalThis.window;
	globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
	try {
		new Function(CLIENT_SOURCE)();
	} finally {
		globalThis.window = previous;
	}
	assert.equal(captured?.id, "dsh-provider-manager", "client 脚本应注册 dsh-provider-manager");
	const exports = captured.factory((name) => {
		if (name === "react") return react;
		throw new Error(`unexpected require("${name}")`);
	});
	return { definition: captured, exports };
}

/** 组装一个够用的假 ctx：抓住 effect / slots.inject / slots.register，并记录 remote 调用。 */
function makeContext(providers, { failSetEnabled = false } = {}) {
	const calls = { list: 0, setEnabled: [] };
	const remote = {
		$mount: () => Promise.resolve(),
		providerToggle: {
			list: async () => {
				calls.list += 1;
				return { ok: true, value: { providers } };
			},
			setEnabled: async (payload) => {
				calls.setEnabled.push(payload);
				if (failSetEnabled) return { ok: false, error: { code: "bad-request", message: "假装失败" } };
				const row = providers.find((candidate) => candidate.provider === payload.provider);
				if (row !== void 0) row.disabled = payload.enabled !== true;
				return { ok: true, value: { provider: payload.provider, enabled: payload.enabled } };
			}
		}
	};
	const context = {
		get: (name) => (name === "remote" ? remote : void 0),
		logger: { warn: () => void 0 },
		effect: (fn) => fn(),
		slots: {
			injectedNames: [],
			registered: [],
			inject(name, callback) {
				this.injectedNames.push(name);
				callback();
				return () => void 0;
			},
			register(options, Component) {
				this.registered.push({ options, Component });
				return () => void 0;
			}
		}
	};
	return { context, calls, remote };
}

const PROVIDERS = [
	{ provider: "gw-1", displayName: "自建网关", active: true, configured: true, disabled: false, mechanism: "settings" },
	{ provider: "deepseek-official", displayName: "DeepSeek 官方", active: false, configured: false, disabled: true, mechanism: "entry" }
];

function buttonsOf(tree) {
	return tree.root.findAll((node) => node.type === "button");
}

function textOf(tree) {
	const collect = (node) => {
		if (typeof node === "string") return node;
		if (node === null || typeof node !== "object") return "";
		return [node.children ?? []].flat().map(collect).join("");
	};
	return collect(tree.toJSON());
}

test("注册的是官方 footer 插槽，且带上自己的 id/order", () => {
	const { exports } = loadClient();
	const { context } = makeContext(PROVIDERS);
	exports.apply(context);

	assert.deepEqual(context.slots.injectedNames, ["settings.models.footer"]);
	assert.equal(context.slots.registered.length, 1);
	const { options } = context.slots.registered[0];
	assert.equal(options.name, "settings.models.footer");
	assert.equal(options.id, "dsh-provider-manager");
	assert.equal(options.order, 100);
	assert.deepEqual(exports.inject, ["remote", "slots"]);
});

test("面板按 host 的 list() 渲染每一行（含已停用的保留行）", async () => {
	const { exports } = loadClient();
	const { context, calls } = makeContext(PROVIDERS);
	exports.apply(context);
	const { options, Component } = context.slots.registered[0];

	let tree;
	await TestRenderer.act(async () => {
		tree = TestRenderer.create(react.createElement(Component, options.inject()));
	});
	await TestRenderer.act(async () => {});

	assert.equal(calls.list, 1, "挂载后应拉一次列表");
	const text = textOf(tree);
	assert.match(text, /模型提供商 停用\/启用/);
	assert.match(text, /自建网关/);
	assert.match(text, /DeepSeek 官方/);
	assert.match(text, /（已停用）/);

	const buttons = buttonsOf(tree);
	assert.equal(buttons.length, 2);
	assert.equal(buttons[0].children.join(""), "停用", "active 的行显示「停用」");
	assert.equal(buttons[1].children.join(""), "启用", "已停用的行显示「启用」");
});

test("点按钮 -> setEnabled({provider, enabled})，成功后重新拉列表", async () => {
	const { exports } = loadClient();
	const providers = PROVIDERS.map((row) => ({ ...row }));
	const { context, calls } = makeContext(providers);
	exports.apply(context);
	const { options, Component } = context.slots.registered[0];

	let tree;
	await TestRenderer.act(async () => {
		tree = TestRenderer.create(react.createElement(Component, options.inject()));
	});
	await TestRenderer.act(async () => {});

	await TestRenderer.act(async () => {
		buttonsOf(tree)[1].props.onClick();
	});
	await TestRenderer.act(async () => {});

	assert.deepEqual(calls.setEnabled, [{ provider: "deepseek-official", enabled: true }]);
	assert.equal(calls.list, 2, "切换成功后应 reload");
	assert.equal(providers[1].disabled, false);
	assert.equal(buttonsOf(tree)[1].children.join(""), "停用", "重新渲染后该行变成「停用」");
});

test("停用方向同样带 enabled:false，失败时面板显示错误文案", async () => {
	const { exports } = loadClient();
	const providers = PROVIDERS.map((row) => ({ ...row }));
	const { context, calls } = makeContext(providers, { failSetEnabled: true });
	exports.apply(context);
	const { options, Component } = context.slots.registered[0];

	let tree;
	await TestRenderer.act(async () => {
		tree = TestRenderer.create(react.createElement(Component, options.inject()));
	});
	await TestRenderer.act(async () => {});

	await TestRenderer.act(async () => {
		buttonsOf(tree)[0].props.onClick();
	});
	await TestRenderer.act(async () => {});

	assert.deepEqual(calls.setEnabled, [{ provider: "gw-1", enabled: false }]);
	assert.equal(calls.list, 1, "失败不 reload");
	assert.match(textOf(tree), /操作失败：bad-request: 假装失败/);
});
