// dsh-vision-delegate — 附加图片桥离线测试
//
// 设计要点（2026-09-21 重做）：本轮附了图、而目标模型不能看图时，桥**不换路由**，
// 只给主模型注入"先调 subagent_vision"的指令，并把本轮图片 ref 记进会话暂存。
// 历史与工具因此一个字节都不外发（早期"整体重定向"已废弃，见 README 的事故记录）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ⚠️ 必须在**导入 lib/bridge.js 之前**把 home 指向临时目录：
//   bridge.js 会 `import "./trace.js"`，而 trace.js 在模块加载时就算好 trace 文件路径
//   （`$DSH_HOME/vision-delegate-trace.log`），桥每跑一步都会往它追加 ——
//   测试绝不能写真实 `$DSH_HOME`（用户数据）。
const TEST_HOME = mkdtempSync(join(tmpdir(), "dsh-vision-bridge-"));
process.env.DSH_HOME = TEST_HOME;
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const {
	createVisionBridge,
	decideBridgeAction,
	hasImageBlock,
	installModelInfoShim,
	latestUserImageRefs,
	modelTakesImages,
	newestUserImageRefs,
	turnNeedsVision,
	visionHintText,
	withVisionHint,
} = await import("../lib/bridge.js");

const CONFIG = { enabled: true, provider: "tcl1", model: "qwen3.7-flash" };
const IMAGE_MESSAGE = {
	role: "user",
	content: [{ type: "image", attachment: { attachmentId: "a1" } }, { type: "text", text: "这是什么" }],
};
const TEXT_MESSAGE = { role: "user", content: [{ type: "text", text: "你好" }] };
const OPTIONS = { provider: "tcl1", model: "deepseek-v4-flash-0731", messages: [IMAGE_MESSAGE], sessionId: "s1" };

async function collect(iterable) {
	const chunks = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

function nextStream(label = "N") {
	return () => (async function* () {
		yield { type: "text-delta", index: 0, text: label };
	})();
}

test("hasImageBlock / modelTakesImages", () => {
	assert.equal(hasImageBlock([IMAGE_MESSAGE]), true);
	assert.equal(hasImageBlock([TEXT_MESSAGE]), false);
	assert.equal(hasImageBlock(void 0), false);
	assert.equal(modelTakesImages({ inputModalities: ["text", "image"] }), true);
	assert.equal(modelTakesImages({ inputModalities: ["text"] }), false);
	assert.equal(modelTakesImages({}), true, "没声明模态视为未知，交给下游");
	assert.equal(modelTakesImages(void 0), true);
});

// ── 只拦"本轮新附的图"（回归：2026-09-21 现场，历史里的图让后面每一轮都被拦）──────
const TOOL_RESULT_MESSAGE = { role: "user", content: [{ type: "tool-result", content: [{ type: "text", text: "ok" }] }] };

test("turnNeedsVision：历史里的图不算，只有最近一条真正的用户发言带图才算", () => {
	assert.equal(turnNeedsVision([TEXT_MESSAGE, IMAGE_MESSAGE]), true);
	assert.equal(
		turnNeedsVision([IMAGE_MESSAGE, { role: "assistant", content: [{ type: "text", text: "看过了" }] }, TEXT_MESSAGE]),
		false,
		"图片属于更早的轮次"
	);
	// 同一轮里助手已经答过（tool-call/tool-result 之后）→ 不重复注入：图片内容此时已在 tool result 里
	assert.equal(turnNeedsVision([IMAGE_MESSAGE, { role: "assistant", content: [{ type: "text", text: "" }] }, TOOL_RESULT_MESSAGE]), false);
	// 工具结果不能当成"用户发言"
	assert.equal(turnNeedsVision([TEXT_MESSAGE, TOOL_RESULT_MESSAGE]), false);
	assert.equal(turnNeedsVision(void 0), false);
});

// 回归：2026-09-21 现场——宿主会在用户消息之后追加若干**注入的 user 消息**。
// 真实用户发言是 `source.kind === 'user'`；注入的是 `agent-instructions` / `plugin` /
// `skill-catalog` …（`dsh-llm` 的 MessageSourceMap，merge-extensible）。早期版本只看
// "最近一条用户发言"，于是附图那一轮被判成"没有新图"：桥既不记暂存也不注入提示，
// 子代理收到一个**没有图的空委派**。
const injectedMessage = (kind, blocks) => ({ role: "user", source: { kind }, content: blocks });
const injectedText = (kind) => injectedMessage(kind, [{ type: "text", text: "<system-reminder>…</system-reminder>" }]);

test("turnNeedsVision：注入的 user 消息不影响判定（按 source.kind，而不是靠顺序）", () => {
	const messages = [IMAGE_MESSAGE, injectedText("agent-instructions"), injectedText("plugin"), injectedText("skill-catalog")];
	assert.equal(turnNeedsVision(messages), true);
	assert.deepEqual(newestUserImageRefs(messages).map((ref) => ref.attachmentId), ["a1"]);
	// 即使某种注入**自己带图**（未来可能的形状），也不能被当成"用户附的图"
	const withInjectedImage = [IMAGE_MESSAGE, injectedMessage("plugin", [{ type: "image", attachment: { attachmentId: "injected" } }])];
	assert.equal(turnNeedsVision(withInjectedImage), true);
	assert.deepEqual(newestUserImageRefs(withInjectedImage).map((ref) => ref.attachmentId), ["a1"]);
	assert.deepEqual(latestUserImageRefs(withInjectedImage).map((ref) => ref.attachmentId), ["a1"]);
	// 助手答过之后才算历史
	assert.equal(
		turnNeedsVision([...messages, { role: "assistant", content: [{ type: "text", text: "答" }] }, TEXT_MESSAGE]),
		false,
		"助手答过之后才算历史"
	);
});

// 回归：2026-09-21 现场——**失败的那一轮不会留下助手消息**（开关关着被拒、或模型报错），
// 早期规则拿"有没有助手消息"当"这张图是否已处理"，于是它被永远当成"本轮新图"：
// 之后每一轮（哪怕纯文本）都继续报"视觉委派已关闭"，除非用户先想别的办法把它"处理掉"。
test("turnNeedsVision：图片那一轮失败（无助手消息）后，新的文本轮次不再被当成带图", () => {
	const failed = [IMAGE_MESSAGE, injectedText("agent-instructions"), TEXT_MESSAGE, injectedText("plugin")];
	assert.equal(turnNeedsVision(failed), false, "最新一条用户发言是纯文本 → 本轮没有新图");

	// 同一次提交被拆成多条消息（同 rpcId）时仍算同一轮
	const split = [
		{ ...IMAGE_MESSAGE, source: { kind: "user", rpcId: "rpc-1" } },
		{ role: "user", source: { kind: "user", rpcId: "rpc-1" }, content: [{ type: "text", text: "顺便看下这张" }] },
	];
	assert.equal(turnNeedsVision(split), true);
	assert.deepEqual(newestUserImageRefs(split).map((ref) => ref.attachmentId), ["a1"]);

	// 换了 rpcId（新的一次提交）就不再算本轮
	const nextTurn = [
		{ ...IMAGE_MESSAGE, source: { kind: "user", rpcId: "rpc-1" } },
		{ role: "user", source: { kind: "user", rpcId: "rpc-2" }, content: [{ type: "text", text: "换个问题" }] },
	];
	assert.equal(turnNeedsVision(nextTurn), false);
});

// 两条规则必须同时成立：**先筛掉注入消息，再看最新一条用户发言**。
// 注入消息"更新"（排在后面）也不能当上"最新一条用户发言"——否则第 3 条规则会把注入问题带回来。
test("turnNeedsVision：注入消息排在新用户发言之后，也不能顶替「最新一条用户发言」", () => {
	// 场景 A：附图那一轮（注入紧跟其后）→ 仍算本轮新图
	const imageTurn = [IMAGE_MESSAGE, injectedText("agent-instructions"), injectedText("plugin"), injectedText("skill-catalog")];
	assert.equal(turnNeedsVision(imageTurn), true);
	assert.deepEqual(newestUserImageRefs(imageTurn).map((ref) => ref.attachmentId), ["a1"]);

	// 场景 B：失败的那一轮之后来了新的文本轮（注入排在最末）→ 不再算新图
	const failedThenText = [
		{ ...IMAGE_MESSAGE, source: { kind: "user", rpcId: "rpc-1" } },
		injectedText("agent-instructions"),
		{ role: "user", source: { kind: "user", rpcId: "rpc-2" }, content: [{ type: "text", text: "这个问题换个说法" }] },
		injectedText("plugin"),
		injectedText("skill-catalog"),
	];
	assert.equal(turnNeedsVision(failedThenText), false, "最新一条**用户**发言是纯文本 → 本轮无新图");
	assert.deepEqual(newestUserImageRefs(failedThenText), []);

	// 场景 C：只有注入消息、没有用户发言（会话标题/压缩那种形状）→ 不算
	assert.equal(turnNeedsVision([injectedText("plugin"), injectedText("skill-catalog")]), false);
});

test("newestUserImageRefs / latestUserImageRefs：一个只看本轮，一个看全历史", () => {
	const refs = newestUserImageRefs([
		{ role: "user", content: [{ type: "image", attachment: { attachmentId: "old" } }] },
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		IMAGE_MESSAGE,
		{ role: "user", content: [{ type: "image", attachment: { attachmentId: "a1" } }, { type: "text", text: "再一张" }] },
	]);
	assert.deepEqual(refs.map((ref) => ref.attachmentId), ["a1"]);
	assert.deepEqual(newestUserImageRefs([TEXT_MESSAGE]), []);

	// 图属于更早的轮次：本轮 refs 为空，但"最近出现过的那张"仍能取到（给暂存兜底用）
	const historical = [
		{ role: "user", content: [{ type: "image", attachment: { attachmentId: "old" } }, { type: "text", text: "看图" }] },
		{ role: "assistant", content: [{ type: "text", text: "看过了" }] },
		TEXT_MESSAGE,
	];
	assert.deepEqual(newestUserImageRefs(historical), []);
	assert.deepEqual(latestUserImageRefs(historical).map((ref) => ref.attachmentId), ["old"]);
	assert.deepEqual(latestUserImageRefs([TEXT_MESSAGE]), []);
});

test("createVisionBridge：本轮无新图时也把「最近出现的那张图」记进暂存（兜底 + 刷新 TTL）", async () => {
	const recorded = [];
	const llm = {
		stream: () => (async function* () {})(),
		resolveModelInfo: async () => ({ inputModalities: ["text"] }),
	};
	const bridge = createVisionBridge({
		llm,
		readStatus: () => "on",
		readConfig: () => CONFIG,
		resolveModelInfo: llm.resolveModelInfo,
		recordTurnImages: (sessionId, refs) => recorded.push({ sessionId, refs }),
	});
	const historical = [
		IMAGE_MESSAGE,
		{ role: "assistant", content: [{ type: "text", text: "看过了" }] },
		TEXT_MESSAGE,
	];
	await collect(bridge({ ...OPTIONS, messages: historical }, nextStream("N")));
	assert.deepEqual(recorded, [{ sessionId: "s1", refs: [{ attachmentId: "a1" }] }]);
});

test("withVisionHint：只在最后那条用户消息后追加文本块，不改动原对象", () => {
	const messages = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }, IMAGE_MESSAGE];
	const next = withVisionHint(messages, 1);
	assert.notEqual(next, messages);
	assert.equal(next[1].content.length, 3);
	assert.match(next[1].content[2].text, /subagent_vision/);
	assert.equal(IMAGE_MESSAGE.content.length, 2, "原消息必须原样不动（官方契约只读）");
	assert.equal(next[0], messages[0], "其它消息保持同一对象");
	assert.match(visionHintText(2), /2 张图片/);
});

test("decideBridgeAction：无新图 / 原生视觉模型 / 已是视觉模型 → 放行（不注入）", () => {
	assert.deepEqual(decideBridgeAction({ status: "off", config: CONFIG, options: { messages: [TEXT_MESSAGE] } }), {
		action: "passthrough",
	});
	assert.deepEqual(
		decideBridgeAction({ status: "off", config: CONFIG, options: OPTIONS, modelInfo: { inputModalities: ["text", "image"] } }),
		{ action: "passthrough" }
	);
	assert.deepEqual(
		decideBridgeAction({
			status: "on",
			config: CONFIG,
			options: { ...OPTIONS, provider: "tcl1", model: "qwen3.7-flash" },
			modelInfo: { inputModalities: ["text"] },
		}),
		{ action: "passthrough" }
	);
	assert.deepEqual(
		decideBridgeAction({ status: "on", config: CONFIG, options: { ...OPTIONS, purpose: "session-title" }, modelInfo: { inputModalities: ["text"] } }),
		{ action: "passthrough" }
	);
	// 压缩（compaction）的请求同样带着整段历史（含那张图），绝不能把提示混进摘要提示词里
	assert.deepEqual(
		decideBridgeAction({ status: "on", config: CONFIG, options: { ...OPTIONS, purpose: "compaction" }, modelInfo: { inputModalities: ["text"] } }),
		{ action: "passthrough" }
	);
});

test("decideBridgeAction：历史里有图、本轮是纯文本 → 放行（不再报「视觉委派已关闭」）", () => {
	const messages = [IMAGE_MESSAGE, { role: "assistant", content: [{ type: "text", text: "看过了" }] }, TEXT_MESSAGE];
	assert.deepEqual(
		decideBridgeAction({ status: "off", config: CONFIG, options: { ...OPTIONS, messages }, modelInfo: { inputModalities: ["text"] } }),
		{ action: "passthrough" }
	);
});

test("decideBridgeAction：关闭/未配置 + 本轮附图 + 文本模型 → 可执行拒绝", () => {
	const off = decideBridgeAction({ status: "off", config: CONFIG, options: OPTIONS, modelInfo: { inputModalities: ["text"] } });
	assert.equal(off.action, "refuse");
	assert.match(off.reason, /「视觉」开关/);

	const unconfigured = decideBridgeAction({
		status: "on",
		config: { enabled: false, provider: "", model: "" },
		options: OPTIONS,
		modelInfo: { inputModalities: ["text"] },
	});
	assert.equal(unconfigured.action, "refuse");
	assert.match(unconfigured.reason, /未配置/);
});

test("decideBridgeAction：开着 + 文本模型 + 本轮附图 → 注入提示", () => {
	assert.deepEqual(decideBridgeAction({ status: "on", config: CONFIG, options: OPTIONS, modelInfo: { inputModalities: ["text"] } }), {
		action: "hint",
	});
});

test("installModelInfoShim：只改能力报告，还原后完全恢复", async () => {
	const original = async () => ({ provider: "tcl1", id: "m", name: "M", inputModalities: ["text"] });
	const llm = { resolveModelInfo: original, listModels: async () => [{ id: "m", inputModalities: ["text"] }] };
	let enabled = true;
	const dispose = installModelInfoShim(llm, () => enabled);

	assert.deepEqual((await llm.resolveModelInfo()).inputModalities, ["text", "image"]);
	assert.deepEqual((await llm.listModels())[0].inputModalities, ["text", "image"]);

	enabled = false;
	assert.deepEqual((await llm.resolveModelInfo()).inputModalities, ["text"]);

	dispose();
	assert.equal(llm.resolveModelInfo, original, "还原后必须就是原始函数本身");
	assert.deepEqual((await llm.resolveModelInfo()).inputModalities, ["text"]);
});

test("createVisionBridge：注入提示后仍走**原** provider/model，并把本轮图片记进暂存", async () => {
	const recorded = [];
	const calls = [];
	const llm = {
		stream: (options) => (async function* () {
			calls.push(options);
			yield { type: "text-delta", index: 0, text: "M" };
		})(),
		resolveModelInfo: async () => ({ inputModalities: ["text"] }),
	};
	let nextCalled = 0;
	const bridge = createVisionBridge({
		llm,
		readStatus: () => "on",
		readConfig: () => CONFIG,
		resolveModelInfo: llm.resolveModelInfo,
		recordTurnImages: (sessionId, refs) => recorded.push({ sessionId, refs }),
	});
	const chunks = await collect(
		bridge(OPTIONS, () => {
			nextCalled += 1;
			return nextStream()();
		})
	);

	assert.deepEqual(chunks.map((chunk) => chunk.text), ["M"]);
	assert.equal(nextCalled, 0, "注入提示后不再走下游（下游拿到的是没有提示的那份 options）");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].provider, "tcl1", "仍然是主模型");
	assert.equal(calls[0].model, "deepseek-v4-flash-0731", "不换路由");
	assert.equal(calls[0].messages[0].content.length, 3, "最后那条用户消息多了提示块");
	assert.equal(calls[0].messages[0].content[0].type, "image", "图片块原样保留（由官方按文本模型投影成占位符）");
	assert.deepEqual(recorded, [{ sessionId: "s1", refs: [{ attachmentId: "a1" }] }]);
});

test("createVisionBridge：我们注入过的那份 options 再次进入瀑布 → 直接放行（不自我递归）", async () => {
	let bridge;
	let nested = 0;
	const llm = {
		// 模拟真实瀑布：嵌套那一次会把（我们注入过的）同一份 options 再交给桥
		stream: (options) => {
			nested += 1;
			assert.ok(nested < 5, "注入过的 options 不能再触发注入，否则会无限递归");
			return bridge(options, nextStream("DOWNSTREAM"));
		},
		resolveModelInfo: async () => ({ inputModalities: ["text"] }),
	};
	bridge = createVisionBridge({ llm, readStatus: () => "on", readConfig: () => CONFIG, resolveModelInfo: llm.resolveModelInfo });
	const chunks = await collect(bridge(OPTIONS, nextStream("OUTER")));
	assert.deepEqual(chunks.map((chunk) => chunk.text), ["DOWNSTREAM"]);
	assert.equal(nested, 1);
});

test("createVisionBridge：会话关闭被拒时也要记暂存（之后打开开关还能用它看图）", async () => {
	const recorded = [];
	const llm = {
		stream: () => (async function* () {})(),
		resolveModelInfo: async () => ({ inputModalities: ["text"] }),
	};
	const bridge = createVisionBridge({
		llm,
		readStatus: () => "off",
		readConfig: () => CONFIG,
		resolveModelInfo: llm.resolveModelInfo,
		recordTurnImages: (sessionId, refs) => recorded.push({ sessionId, refs }),
	});
	await assert.rejects(() => collect(bridge(OPTIONS, nextStream())), /视觉委派已关闭/);
	assert.deepEqual(recorded, [{ sessionId: "s1", refs: [{ attachmentId: "a1" }] }]);
});

test("createVisionBridge：无图时走下游；会话关闭时抛出可执行错误", async () => {
	const llm = {
		stream: () => (async function* () {})(),
		resolveModelInfo: async () => ({ inputModalities: ["text"] }),
	};
	const passthrough = createVisionBridge({ llm, readStatus: () => "on", readConfig: () => CONFIG, resolveModelInfo: llm.resolveModelInfo });
	const chunks = await collect(passthrough({ ...OPTIONS, messages: [TEXT_MESSAGE] }, nextStream("N")));
	assert.deepEqual(chunks.map((chunk) => chunk.text), ["N"]);

	const closed = createVisionBridge({ llm, readStatus: () => "off", readConfig: () => CONFIG, resolveModelInfo: llm.resolveModelInfo });
	await assert.rejects(() => collect(closed(OPTIONS, nextStream())), /视觉委派已关闭/);
});
