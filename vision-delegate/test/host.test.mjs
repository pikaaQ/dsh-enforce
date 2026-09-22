// dsh-vision-delegate — 离线测试（node --test；不碰网络与 DSH 运行时）
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	candidateIsUsable,
	candidatesFromProviderList,
	candidatesFromSettings,
	mergeCandidates,
} from "../lib/candidates.js";
import {
	createRefusalGuard,
	DEFAULT_CONFIG,
	DISABLED_MESSAGE,
	normalizeConfig,
	refusalFor,
	statusOf,
	statusPayload,
	UNCONFIGURED_MESSAGE,
	validateConfig,
} from "../lib/config.js";
import { readJsonBody, respond, sessionIdOf } from "../lib/http.js";
import { buildDelegationPrompt, createVisionTool, textOfBlocks } from "../lib/tool.js";

const CONFIGURED = { enabled: true, provider: "tcl1", model: "deepseek-v4-flash-vision-exp" };

// ── config ───────────────────────────────────────────────────────────────────

test("配置：normalizeConfig 只认字符串与显式 true", () => {
	assert.deepEqual(normalizeConfig(void 0), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig({ enabled: "yes", provider: 7, model: null }), { enabled: false, provider: "", model: "" });
	assert.deepEqual(normalizeConfig({ enabled: true, provider: " tcl1 ", model: " m " }), { enabled: true, provider: "tcl1", model: "m" });
});

test("配置：启用但没选模型 → 保存被拒（无兜底规则的落点）", () => {
	assert.throws(() => validateConfig({ enabled: true, provider: "", model: "" }), /必须先选择视觉模型/);
	assert.throws(() => validateConfig({ enabled: true, provider: "tcl1", model: "" }), /必须先选择视觉模型/);
	validateConfig({ enabled: false, provider: "", model: "" });
	validateConfig(CONFIGURED);
});

test("状态：未配置 / 关 / 自动；会话覆盖只在已配置时生效", () => {
	assert.equal(statusOf({ enabled: true, provider: "", model: "" }), "unconfigured");
	assert.equal(statusOf({ enabled: false, provider: "tcl1", model: "m" }), "off");
	assert.equal(statusOf({ enabled: true, provider: "tcl1", model: "m" }), "on");
	assert.equal(statusOf({ enabled: false, provider: "tcl1", model: "m" }, true), "on");
	assert.equal(statusOf({ enabled: true, provider: "tcl1", model: "m" }, false), "off");
	// 未配置时覆盖不改变结论
	assert.equal(statusOf({ enabled: false, provider: "", model: "" }, true), "unconfigured");
});

test("拒绝理由：未配置与关闭各给一条可执行提示，开启放行", () => {
	assert.equal(refusalFor("unconfigured"), UNCONFIGURED_MESSAGE);
	assert.equal(refusalFor("off"), DISABLED_MESSAGE);
	assert.equal(refusalFor("on"), undefined);
	assert.match(UNCONFIGURED_MESSAGE, /插件配置 → 「视觉委派」/);
});

test("statusPayload：文案与状态同源", () => {
	const payload = statusPayload({ status: "unconfigured", config: DEFAULT_CONFIG });
	assert.equal(payload.ok, true);
	assert.equal(payload.tool, "subagent_vision");
	assert.equal(payload.hint, UNCONFIGURED_MESSAGE);
	assert.equal(statusPayload({ status: "on", config: CONFIGURED }).hint, "");
});

test("语义：胶囊是唯一运行时开关；配置里的 enabled 只是新会话的初始默认", () => {
	const configured = { provider: "tcl1", model: "m" };
	// 配置默认是关，但本会话胶囊点开了 → 用
	assert.equal(statusOf({ ...configured, enabled: false }, true), "on");
	// 配置默认是开，但本会话胶囊关掉了 → 不用
	assert.equal(statusOf({ ...configured, enabled: true }, false), "off");
	// 本会话没点过胶囊（没有覆盖）→ 用配置默认
	assert.equal(statusOf({ ...configured, enabled: true }), "on");
	assert.equal(statusOf({ ...configured, enabled: false }), "off");
});

// ── 守卫（回归：全局守卫必须只拦目标工具）────────────────────────────────────

test("守卫：未配置时只拦 subagent_vision，其它工具一律放行", () => {
	const guard = createRefusalGuard(() => "unconfigured");
	for (const name of ["pwsh", "read", "write", "edit", "glob", "grep", "todo_write", "ask_user_question", "subagent_fork", "present"]) {
		assert.equal(guard({ name, agent: { id: "s1" } }), undefined, `${name} 绝不能被拦`);
	}
	assert.equal(guard({ name: "subagent_vision", agent: { id: "s1" } }), UNCONFIGURED_MESSAGE);
	assert.equal(guard({ name: "subagent_vision" }), UNCONFIGURED_MESSAGE);
	assert.equal(guard({}), undefined);
	assert.equal(guard(undefined), undefined);
});

test("守卫：已开启放行、已关闭拒绝、状态读取抛错时 fail-open", () => {
	assert.equal(createRefusalGuard(() => "on")({ name: "subagent_vision" }), undefined);
	assert.equal(createRefusalGuard(() => "off")({ name: "subagent_vision" }), DISABLED_MESSAGE);
	const broken = createRefusalGuard(() => {
		throw new Error("boom");
	});
	assert.equal(broken({ name: "subagent_vision" }), undefined);
	// 会话覆盖也走同一条判定
	const guard = createRefusalGuard((sessionId) => (sessionId === "s-on" ? "on" : "off"));
	assert.equal(guard({ name: "subagent_vision", agent: { id: "s-on" } }), undefined);
	assert.equal(guard({ name: "subagent_vision", agent: { id: "s-other" } }), DISABLED_MESSAGE);
});

// ── candidates ───────────────────────────────────────────────────────────────

test("候选：从 settings 快照读 provider/models，并识别图片声明", () => {
	const rows = candidatesFromSettings({
		providers: {
			tcl1: { models: [{ id: "vision-x", name: "VisionX", input: ["text", "image"] }, { id: "text-y", name: "TextY", input: ["text"] }] },
			tcl2: { models: [{ id: "z" }] }
		}
	});
	assert.equal(rows.length, 3);
	const vision = rows.find((row) => row.model === "vision-x");
	assert.equal(vision.image, true);
	assert.equal(vision.name, "VisionX");
	assert.equal(rows.find((row) => row.model === "text-y").image, false);
	assert.equal(rows.find((row) => row.model === "z").name, "z");
});

test("候选：llm 服务的 inputModalities 优先，且合并去重后图片模型排前面", () => {
	const live = candidatesFromProviderList([{ id: "tcl1", name: "TCL-1" }], () => [
		{ id: "vision-x", name: "VisionX", inputModalities: ["text", "image"] },
		{ id: "text-y", name: "TextY", inputModalities: ["text"] }
	]);
	const fallback = candidatesFromSettings({ providers: { tcl1: { models: [{ id: "vision-x", name: "旧名", input: ["text"] }] } } });
	const merged = mergeCandidates(live, fallback);
	assert.deepEqual(
		merged.map((row) => `${row.provider}/${row.model}:${row.image}`),
		["tcl1/vision-x:true", "tcl1/text-y:false"]
	);
	assert.equal(merged[0].name, "VisionX");
	assert.deepEqual(candidateIsUsable(merged, "tcl1", "vision-x"), { found: true, image: true });
	assert.deepEqual(candidateIsUsable(merged, "nope", "x"), { found: false, image: false });
});

test("候选：合并时保留实时目录的名字，但补齐它缺的声明窗口", () => {
	const live = candidatesFromProviderList([{ id: "tcl1", name: "TCL-1" }], () => [
		{ id: "vision-x", name: "VisionX", inputModalities: ["text", "image"] },
	]);
	const fallback = candidatesFromSettings({
		providers: { tcl1: { models: [{ id: "vision-x", name: "旧名", input: ["text", "image"], contextWindow: 800000 }] } },
	});
	const merged = mergeCandidates(live, fallback);
	assert.equal(merged[0].name, "VisionX", "实时目录的名字仍然优先");
	assert.equal(merged[0].contextWindow, 800000, "窗口从 settings 侧补齐");
});

// ── tool ─────────────────────────────────────────────────────────────────────

function fakeSubagents() {
	const calls = [];
	let disposed = 0;
	return {
		calls,
		get disposed() {
			return disposed;
		},
		start(provider, request) {
			calls.push({ provider, request });
			return Promise.resolve({
				id: "child-1",
				result: Promise.resolve({ output: [{ type: "text", text: "截图里是 ENOENT：路径少了反斜杠。" }], stopReason: "completed" }),
				async dispose() {
					disposed += 1;
				}
			});
		}
	};
}

const EXEC = { agent: { id: "s1" }, signal: { aborted: false } };

test("工具：未配置/已关闭时不 spawn，只抛可执行错误", async () => {
	for (const [status, expected] of [["unconfigured", UNCONFIGURED_MESSAGE], ["off", DISABLED_MESSAGE]]) {
		const subagents = fakeSubagents();
		const tool = createVisionTool({ readStatus: () => status, readConfig: () => CONFIGURED, subagents });
		await assert.rejects(() => tool.execute({ prompt: "看图" }, EXEC), (error) => error.message === expected);
		assert.equal(subagents.calls.length, 0, "拒绝时绝不能调用 subagents.start");
	}
});

test("工具：spawn 未注册时也拒绝，且不启动子代理", async () => {
	const subagents = fakeSubagents();
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents, isProviderAvailable: () => false });
	await assert.rejects(() => tool.execute({ prompt: "看图" }, EXEC), /没有注册 "spawn"/);
	assert.equal(subagents.calls.length, 0);
});

test("工具：spawn 时装上子代理的系统提示词 + 两道硬约束（防 19 层委派链）", async () => {
	const subagents = fakeSubagents();
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents });
	const value = await tool.execute({ prompt: "看看这张报错截图", label: "shot" }, EXEC);

	assert.equal(subagents.calls.length, 1);
	const call = subagents.calls[0];
	assert.equal(call.provider, "spawn");
	assert.deepEqual(call.request.agentOptions, { provider: "tcl1", model: "deepseek-v4-flash-vision-exp" });
	assert.equal(call.request.parent, EXEC.agent);
	assert.equal(call.request.signal, EXEC.signal);
	assert.equal(call.request.label, "shot");
	assert.deepEqual(call.request.prompt, [{ type: "text", text: "看看这张报错截图" }]);
	// 子代理自己的系统提示词：它就是看图的那个角色；"找不找文件"看图片是怎么给的
	assert.match(call.request.persona, /视觉子代理/);
	assert.match(call.request.persona, /附件.*直接读它/s, "给了附件就不要去找文件");
	assert.match(call.request.persona, /图片路径.*去读/s, "只给了路径就按路径去读");
	assert.match(call.request.persona, /原因.*回复给调用方/s, "拿不到图就回报原因，不要自己猜");
	assert.match(call.request.persona, /没有.*subagent_vision.*工具/, "明确它没有委派工具");
	// 硬约束 ①：子代理的工具目录里没有 subagent_vision
	assert.deepEqual(call.request.toolFilter, { deny: ["subagent_vision"] });
	// 硬约束 ②：孙代委派的深度会超过上限，被 harness 直接拒
	assert.equal(call.request.maxDepth, 1, "父会话深度 0 → 上限 1（子代=1 允许，孙代=2 拒绝）");
	assert.match(value.conclusion, /ENOENT/);
	assert.equal(value.images, 0);
	assert.equal(subagents.disposed, 1);
});

test("工具：maxDepth 跟着父会话深度走（本身就在子代理里的会话也不会被误伤）", async () => {
	const subagents = fakeSubagents();
	const deepAgent = { id: "s1", session: { header: { delegationDepth: 3 } }, options: {} };
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents });
	await tool.execute({ prompt: "看图" }, { agent: deepAgent, signal: { aborted: false } });
	assert.equal(subagents.calls[0].request.maxDepth, 4);
});

test("工具：路径图片→插件读字节→附件库→image block（子代理拿到图，不需要 read_image，路径不外传）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-vision-tool-"));
	const file = join(dir, "shot.png");
	writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const saved = [];
	const attachments = {
		saveImages: async (inputs) => {
			saved.push(...inputs);
			return inputs.map((_, index) => ({ attachmentId: `att-${index}`, mediaType: "image/png", bytes: 4, width: 1, height: 1 }));
		}
	};
	try {
		const subagents = fakeSubagents();
		const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents, attachments });
		const value = await tool.execute({ prompt: "图里是什么", images: [file] }, EXEC);

		assert.equal(saved.length, 1);
		assert.equal(saved[0].mediaType, "image/png");
		assert.equal(saved[0].name, "shot.png");
		assert.deepEqual([...saved[0].data], [0x89, 0x50, 0x4e, 0x47]);

		const prompt = subagents.calls[0].request.prompt;
		assert.equal(prompt.length, 2);
		assert.equal(prompt[0].type, "image");
		assert.equal(prompt[0].attachment.attachmentId, "att-0");
		assert.equal(prompt[1].type, "text");
		assert.match(prompt[1].text, /1 张图片/);
		assert.doesNotMatch(prompt[1].text, /shot\.png/, "路径不能出现在交给子代理的文本里");
		assert.equal(value.images, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("工具：不带图片参数时自动用「本会话最近的附件图片」（用户直接附图那条路）", async () => {
	const saved = [];
	const attachments = {
		saveImages: async () => {
			throw new Error("这条路径不该再存一遍字节：直接复用已有 durable ref");
		},
	};
	const subagents = fakeSubagents();
	const sessionRefs = [{ attachmentId: "sha256:deadbeef", mediaType: "image/png", bytes: 12, width: 3, height: 4, name: "image.png" }];
	const tool = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents,
		attachments,
		readSessionImages: (sessionId) => (sessionId === "s1" ? sessionRefs : []),
	});
	const value = await tool.execute({ prompt: "这张截图里是什么" }, EXEC);

	assert.equal(saved.length, 0);
	const prompt = subagents.calls[0].request.prompt;
	assert.equal(prompt[0].type, "image");
	assert.equal(prompt[0].attachment, sessionRefs[0], "直接把 durable ref 交给子代理（不落盘、不给路径）");
	assert.match(prompt[1].text, /1 张图片/);
	assert.equal(value.images, 1);
	assert.equal(value.source, "session");
});

test("工具：另一个会话的暂存不能用；暂存读失败也不影响显式路径", async () => {
	const subagents = fakeSubagents();
	const tool = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents,
		readSessionImages: () => {
			throw new Error("boom");
		},
	});
	await tool.execute({ prompt: "看图" }, EXEC);
	assert.deepEqual(subagents.calls[0].request.prompt, [{ type: "text", text: "看图" }], "取不到附件时退回纯文本，不抛错");
	subagents.calls.length = 0;

	const other = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents,
		readSessionImages: (sessionId) => (sessionId === "s-other" ? [{ attachmentId: "x", mediaType: "image/png" }] : []),
	});
	await other.execute({ prompt: "看图" }, EXEC);
	assert.equal(subagents.calls[0].request.prompt.length, 1, "别的会话的附件不能串到本会话");
});

test("工具：内联 base64 走同一条附件通道", async () => {
	const saved = [];
	const attachments = {
		saveImages: async (inputs) => {
			saved.push(...inputs);
			return [{ attachmentId: "att-b64", mediaType: "image/jpeg", bytes: 3, width: 1, height: 1 }];
		}
	};
	const subagents = fakeSubagents();
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents, attachments });
	await tool.execute(
		{ prompt: "看图", image_data: [{ mediaType: "image/jpeg", data: Buffer.from([1, 2, 3]).toString("base64") }] },
		EXEC
	);
	assert.equal(saved.length, 1);
	assert.equal(saved[0].mediaType, "image/jpeg");
	assert.deepEqual([...saved[0].data], [1, 2, 3]);
	assert.equal(subagents.calls[0].request.prompt[0].type, "image");
});

test("工具：图片输入不合法时给出可执行错误，且不启动子代理", async () => {
	const attachments = {
		saveImages: async () => {
			throw new Error("Image upload is not canonical base64.");
		}
	};
	const subagents = fakeSubagents();
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents, attachments });
	await assert.rejects(() => tool.execute({ prompt: "x", images: ["E:\\tmp\\nope.tiff"] }, EXEC), /不认识的图片扩展名/);
	await assert.rejects(() => tool.execute({ prompt: "x", images: ["E:\\tmp\\missing.png"] }, EXEC), /读不到图片/);
	await assert.rejects(
		() => tool.execute({ prompt: "x", image_data: [{ mediaType: "image/png", data: "AAAA" }] }, EXEC),
		/图片被附件库拒绝/
	);
	assert.equal(subagents.calls.length, 0);
});

test("工具：子代理失败时抛出带模型的错误，并照样释放 run", async () => {
	let disposed = 0;
	const subagents = {
		start: () =>
			Promise.resolve({
				id: "child-2",
				result: Promise.reject(new Error("模型 404")),
				async dispose() {
					disposed += 1;
				}
			})
	};
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents });
	await assert.rejects(() => tool.execute({ prompt: "看图" }, EXEC), /视觉子代理运行失败（tcl1\/deepseek-v4-flash-vision-exp）：模型 404/);
	assert.equal(disposed, 1);
});

test("工具：spawn 后把子会话 id 交给清理器（先 track、跑完 finish），结论不受影响", async () => {
	const events = [];
	const subagents = fakeSubagents();
	const tool = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents,
		sessionCleanup: {
			async track(id) {
				events.push(`track:${id}`);
			},
			async finish(id) {
				events.push(`finish:${id}`);
			}
		}
	});
	const value = await tool.execute({ prompt: "看图" }, EXEC);
	assert.deepEqual(events, ["track:child-1", "finish:child-1"], "id 取自 run.id（= 子会话 id）");
	assert.match(value.conclusion, /ENOENT/);
	assert.equal(subagents.disposed, 1);
});

test("工具：track 带上 {parentSessionId} = 本会话 id（dsh-workspace-manager 会话树的父子来源）", async () => {
	const calls = [];
	const tool = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents: fakeSubagents(),
		sessionCleanup: {
			async track(id, options) {
				calls.push({ id, options });
			},
			async finish() {}
		}
	});
	await tool.execute({ prompt: "看图" }, EXEC);
	assert.deepEqual(calls, [{ id: "child-1", options: { parentSessionId: "s1" } }]);

	// 拿不到本会话 id（agent 没有 id）时也照常登记：父位置是 undefined，由清理器决定不带父。
	const bare = [];
	const bareTool = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents: fakeSubagents(),
		sessionCleanup: {
			async track(id, options) {
				bare.push({ id, options });
			},
			async finish() {}
		}
	});
	await bareTool.execute({ prompt: "看图" }, { agent: {}, signal: { aborted: false } });
	assert.deepEqual(bare, [{ id: "child-1", options: { parentSessionId: undefined } }]);
});

test("工具：先 dispose 再删临时会话（子会话必须先静默，否则会被判活跃而删不掉）", async () => {	const events = [];
	const subagents = {
		start: () =>
			Promise.resolve({
				id: "child-9",
				result: Promise.resolve({ output: [{ type: "text", text: "ok" }], stopReason: "completed" }),
				async dispose() {
					events.push("dispose");
				}
			})
	};
	const tool = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents,
		sessionCleanup: {
			async track(id) {
				events.push(`track:${id}`);
			},
			async finish(id) {
				events.push(`finish:${id}`);
			}
		}
	});
	await tool.execute({ prompt: "看图" }, EXEC);
	assert.deepEqual(events, ["track:child-9", "dispose", "finish:child-9"]);
});

test("工具：子代理失败时也补删临时会话（会话已经产生，不能因为失败就留着）", async () => {
	const events = [];
	const subagents = {
		start: () =>
			Promise.resolve({
				id: "child-2",
				result: Promise.reject(new Error("模型 404")),
				async dispose() {}
			})
	};
	const tool = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents,
		sessionCleanup: {
			async track(id) {
				events.push(`track:${id}`);
			},
			async finish(id) {
				events.push(`finish:${id}`);
			}
		}
	});
	await assert.rejects(() => tool.execute({ prompt: "看图" }, EXEC), /视觉子代理运行失败/);
	assert.deepEqual(events, ["track:child-2", "finish:child-2"]);
});

test("工具：清理是附加能力 —— 清理器缺失、抛错、或 run 没有 id 都不影响结论", async () => {
	const boom = {
		track: async () => {
			throw new Error("cleanup boom");
		},
		finish: async () => {
			throw new Error("cleanup boom");
		}
	};
	const withBoom = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents: fakeSubagents(), sessionCleanup: boom });
	const value = await withBoom.execute({ prompt: "看图" }, EXEC);
	assert.match(value.conclusion, /ENOENT/, "清理器抛错不能吞掉结论");

	// 没有清理器（宿主的 sessionRemoval 服务缺席时就是这条路径）
	const bare = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents: fakeSubagents() });
	assert.match((await bare.execute({ prompt: "看图" }, EXEC)).conclusion, /ENOENT/);

	// run 没有 id：跳过清理，不瞎猜也不报错
	const calls = [];
	const noId = createVisionTool({
		readStatus: () => "on",
		readConfig: () => CONFIGURED,
		subagents: {
			start: () =>
				Promise.resolve({
					result: Promise.resolve({ output: [{ type: "text", text: "ok" }], stopReason: "completed" }),
					async dispose() {}
				})
		},
		sessionCleanup: {
			async track(id) {
				calls.push(`track:${id}`);
			},
			async finish(id) {
				calls.push(`finish:${id}`);
			}
		}
	});
	await noId.execute({ prompt: "看图" }, EXEC);
	assert.deepEqual(calls, []);
});

test("工具：缺少 Agent 拒绝；presentCall 显示模型与图片数", async () => {
	const subagents = fakeSubagents();
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents });
	await assert.rejects(() => tool.execute({ prompt: "x" }, { signal: {} }), /没有关联的 Agent/);
	const view = tool.presentCall({ prompt: "x", images: ["a", "b"] });
	assert.match(view.title, /tcl1\/deepseek-v4-flash-vision-exp/);
	assert.equal(view.rawInput.images, 2);
});

test("工具：prompt 拼装与文本抽取", () => {
	assert.equal(buildDelegationPrompt({ prompt: "  问题  " }), "问题");
	assert.equal(buildDelegationPrompt({ prompt: "问题", images: ["C:\\a.png"] }), "问题", "路径不再写进文本");
	assert.match(buildDelegationPrompt({ prompt: "q" }, 2), /2 张图片/);
	assert.equal(textOfBlocks([{ type: "text", text: "a" }, { type: "reasoning", text: "b" }, { type: "text", text: "c" }]), "a\nc");
	assert.equal(textOfBlocks(void 0), "");
	assert.deepEqual(tool_renderCheck(), [{ type: "text", text: "视觉子代理（tcl1 / m）\n\n结论" }]);
});

function tool_renderCheck() {
	const tool = createVisionTool({ readStatus: () => "on", readConfig: () => CONFIGURED, subagents: { start: () => {} } });
	return tool.output.render({}, { provider: "tcl1", model: "m", conclusion: "结论" });
}

// ── http ─────────────────────────────────────────────────────────────────────

function fakeRequest(method, body, url) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url ?? "/vision-delegate";
	req.destroy = () => {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
		req.emit("end");
	});
	return req;
}

function fakeResponse() {
	return {
		status: 0,
		headers: {},
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(chunk) {
			this.body = chunk === undefined ? "" : String(chunk);
		}
	};
}

test("http：respond 写 JSON，HEAD 只发头", () => {
	const res = fakeResponse();
	respond(res, 200, { ok: true });
	assert.equal(res.status, 200);
	assert.deepEqual(JSON.parse(res.body), { ok: true });
	assert.match(res.headers["content-type"], /application\/json/);

	const head = fakeResponse();
	respond(head, 200, { ok: true }, true);
	assert.equal(head.body, "");
});

test("http：readJsonBody 解析 body，坏 JSON 与空 body 回落 {}", async () => {
	assert.deepEqual(await readJsonBody(fakeRequest("POST", { a: 1 })), { a: 1 });
	assert.deepEqual(await readJsonBody(fakeRequest("POST")), {});
	const broken = new EventEmitter();
	broken.method = "POST";
	broken.destroy = () => {};
	queueMicrotask(() => {
		broken.emit("data", Buffer.from("{not json", "utf8"));
		broken.emit("end");
	});
	assert.deepEqual(await readJsonBody(broken), {});
});

test("http：sessionIdOf 只在有 ?session= 时给值", () => {
	assert.equal(sessionIdOf({ url: "/vision-delegate?session=abc" }), "abc");
	assert.equal(sessionIdOf({ url: "/vision-delegate?session=a%20b" }), "a b");
	assert.equal(sessionIdOf({ url: "/vision-delegate?session=" }), undefined);
	assert.equal(sessionIdOf({ url: "/vision-delegate" }), undefined);
	assert.equal(sessionIdOf({}), undefined);
});
