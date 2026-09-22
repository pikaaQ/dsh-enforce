// dsh-vision-delegate — 临时会话清理（策略层）离线测试
//
// 覆盖：账本（落盘/重载/容错）、子会话 id 提取、完成即删的每种结局、
// 启动补删的汇总与优雅降级。全部在 mkdtemp 出来的临时目录里跑，
// 用**假的**清理服务（绝不触碰真实 $DSH_HOME，也不真删任何东西）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CLEANUP_OWNER,
	createSessionReaper,
	defaultLedgerPath,
	openLedger,
	parseLedger,
	resolveDshHome,
	sessionIdOfRun,
	SESSION_REMOVAL_SERVICE,
} from "../lib/session-cleanup.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "dsh-vision-cleanup-"));

/** 假服务：记录每次调用，按 id 注入错误码。 */
function fakeService(failures = {}) {
	const calls = { claim: [], remove: [] };
	return {
		calls,
		claim(owner, ids) {
			calls.claim.push({ owner, ids });
			return { owner, claimed: ids, alreadyClaimed: [], rejected: [] };
		},
		async remove(sessionId, options) {
			calls.remove.push({ sessionId, owner: options?.owner });
			const code = failures[sessionId];
			if (code !== undefined) throw Object.assign(new Error(`${sessionId}: ${code}`), { code });
			return { sessionId, removed: [], bytes: 3, prunedProjects: [] };
		},
	};
}

const ctxWith = (service) => ({ get: (name) => (name === SESSION_REMOVAL_SERVICE ? service : undefined) });

function collectingLogger() {
	const info = [];
	const warn = [];
	return { info: (...args) => info.push(args.join(" ")), warn: (...args) => warn.push(args.join(" ")), infoLines: info, warnLines: warn };
}

// ── 路径与解析 ───────────────────────────────────────────────────────────────

test("清理：home 与账本路径沿用本仓库插件约定（DSH_HOME 优先，否则 ~/.dsh）", () => {
	assert.equal(resolveDshHome({ DSH_HOME: "E:\\tmp\\home" }, "C:\\Users\\x"), "E:\\tmp\\home");
	assert.equal(resolveDshHome({ DSH_HOME: "   " }, "C:\\Users\\x"), join("C:\\Users\\x", ".dsh"));
	assert.equal(resolveDshHome({}, "C:\\Users\\x"), join("C:\\Users\\x", ".dsh"));
	assert.equal(defaultLedgerPath({ DSH_HOME: "E:\\tmp\\home" }, "C:\\Users\\x"), join("E:\\tmp\\home", "dsh-vision-delegate.state.json"));
});

test("清理：parseLedger 对损坏内容退化为空账本，并过滤非法 id", () => {
	assert.deepEqual(parseLedger("{not json"), { version: 1, pendingSessionIds: [] });
	assert.deepEqual(parseLedger('{"pendingSessionIds":"x"}'), { version: 1, pendingSessionIds: [] });
	assert.deepEqual(parseLedger('{"pendingSessionIds":["a","a","",7,"b"]}'), { version: 1, pendingSessionIds: ["a", "b"] });
});

test("清理：账本 add/remove 原子落盘，重新打开能读回来", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		assert.equal(await ledger.add(["s-1", "s-2"]), true);
		assert.equal(await ledger.add(["s-2", "s-3"]), true, "去重后仍算变化");
		assert.equal(await ledger.add(["s-3"]), false, "没有变化就不写盘");
		assert.deepEqual(ledger.ids(), ["s-1", "s-2", "s-3"]);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, pendingSessionIds: ["s-1", "s-2", "s-3"] });

		assert.equal(await ledger.remove(["s-2"]), true);
		assert.equal(await ledger.remove(["s-2"]), false);
		const reopened = openLedger({ file });
		await reopened.ready;
		assert.deepEqual(reopened.ids(), ["s-1", "s-3"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：账本文件损坏/缺失都不阻断启动", async () => {
	const dir = tempDir();
	try {
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{oops");
		const ledger = openLedger({ file: broken });
		await ledger.ready;
		assert.deepEqual(ledger.ids(), []);
		const missing = openLedger({ file: join(dir, "nope.json") });
		await missing.ready;
		assert.deepEqual(missing.ids(), []);
	} finally {
		{
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("清理：子会话 id 取 run.id，退回 localAgent.session.id，缺失时 undefined", () => {
	assert.equal(sessionIdOfRun({ id: "child-1" }), "child-1");
	assert.equal(sessionIdOfRun({ id: "", localAgent: { session: { id: "child-2" } } }), "child-2");
	assert.equal(sessionIdOfRun({ localAgent: { session: { id: "child-3" } } }), "child-3");
	assert.equal(sessionIdOfRun({}), undefined);
	assert.equal(sessionIdOfRun(undefined), undefined);
});

// ── 完成即删 ─────────────────────────────────────────────────────────────────

test("清理：track 先落盘再登记（崩溃也能补删）", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		const service = fakeService();
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger, logger: collectingLogger() });

		assert.equal(await reaper.track("child-1"), true);
		assert.deepEqual(ledger.ids(), ["child-1"], "落账在登记之前");
		assert.deepEqual(service.calls.claim, [{ owner: CLEANUP_OWNER, ids: ["child-1"] }]);
		assert.equal(await reaper.track(""), false);
		assert.equal(await reaper.track(undefined), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：track 把**父会话 id** 一起登记（服务面 v2 的第三个参数）", async () => {
	const dir = tempDir();
	try {
		const ledger = openLedger({ file: join(dir, "state.json") });
		const claims = [];
		const service = {
			claim(owner, ids, options) {
				claims.push({ owner, ids, options });
				return { owner, claimed: ids, alreadyClaimed: [], parentUpdated: [], rejected: [] };
			},
		};
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger });

		await reaper.track("child-1", { parentSessionId: "session-parent" });
		assert.deepEqual(claims, [{ owner: CLEANUP_OWNER, ids: ["child-1"], options: { parentSessionId: "session-parent" } }]);

		// 拿不到父（或父非法）时照常登记，但**不带** options：绝不能抹掉已知的父指针。
		await reaper.track("child-2");
		await reaper.track("child-3", { parentSessionId: "" });
		assert.equal(claims[1].options, undefined);
		assert.equal(claims[2].options, undefined);
		assert.deepEqual(ledger.ids(), ["child-1", "child-2", "child-3"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：启动补删重登记时不带父（服务端保留第一次记下的父指针）", async () => {
	const dir = tempDir();
	try {
		const ledger = openLedger({ file: join(dir, "state.json") });
		await ledger.add(["child-1"]);
		const claims = [];
		const service = fakeService();
		const originalClaim = service.claim;
		service.claim = (owner, ids, options) => {
			claims.push({ ids, options });
			return originalClaim(owner, ids);
		};
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger });
		await reaper.sweep();
		assert.equal(claims[0].options, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：finish 成功 → 服务按 owner 删除、账本划掉", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		const service = fakeService();
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger });
		await ledger.add(["child-1"]);

		assert.deepEqual(await reaper.finish("child-1"), { outcome: "removed" });
		assert.deepEqual(service.calls.remove, [{ sessionId: "child-1", owner: CLEANUP_OWNER }]);
		assert.deepEqual(ledger.ids(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：session-not-found 当已清理（不报错、划账）", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		const service = fakeService({ "child-1": "session-not-found" });
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger });
		await ledger.add(["child-1"]);

		assert.deepEqual(await reaper.finish("child-1"), { outcome: "absent", code: "session-not-found" });
		assert.deepEqual(ledger.ids(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：别人登记的 id（not-claimed）→ 不动磁盘、划自己的账", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		const service = fakeService({ "child-1": "not-claimed" });
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger });
		await ledger.add(["child-1"]);

		const result = await reaper.finish("child-1");
		assert.equal(result.outcome, "foreign");
		assert.deepEqual(ledger.ids(), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：活跃/不安全等删不掉的原因 → kept，账本留着下次启动再试", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		const service = fakeService({ "child-1": "session-active", "child-2": "bad-request" });
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger });
		await ledger.add(["child-1", "child-2"]);

		assert.equal((await reaper.finish("child-1")).outcome, "kept");
		assert.equal((await reaper.finish("child-2")).outcome, "kept");
		assert.deepEqual(ledger.ids(), ["child-1", "child-2"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：服务不存在 / 抛非结构化错误 / 账本写坏 —— 一律不抛给调用方", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		await ledger.add(["child-1"]);

		// 服务不存在（没装 workspace-manager）
		const absent = createSessionReaper({ ctx: { get: () => undefined }, ledger, logger: collectingLogger() });
		assert.deepEqual(await absent.finish("child-1"), { outcome: "no-service" });
		assert.deepEqual(ledger.ids(), ["child-1"], "留账，等下次启动");

		// 服务抛非结构化错误（名字都没见过的失败）
		const broken = createSessionReaper({
			ctx: ctxWith({ remove: async () => { throw new Error("boom"); } }),
			ledger,
			logger: collectingLogger(),
		});
		const result = await broken.finish("child-1");
		assert.equal(result.outcome, "kept");
		assert.equal(result.code, "");
		assert.deepEqual(ledger.ids(), ["child-1"]);

		// 账本自己写坏：track 只是返回 false，绝不抛
		const exploding = {
			ready: Promise.resolve(),
			ids: () => [],
			add: async () => { throw new Error("disk full"); },
			remove: async () => {},
		};
		const reaper = createSessionReaper({ ctx: ctxWith(fakeService()), ledger: exploding, logger: collectingLogger() });
		assert.equal(await reaper.track("child-9"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── 启动补删 ─────────────────────────────────────────────────────────────────

test("清理：空账本的启动补删什么都不做、也不记日志", async () => {
	const dir = tempDir();
	try {
		const ledger = openLedger({ file: join(dir, "state.json") });
		const service = fakeService();
		const logger = collectingLogger();
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger, logger });

		const summary = await reaper.sweep();
		assert.deepEqual(summary, { attempted: 0, removed: [], absent: [], foreign: [], kept: [], unavailable: 0, available: true });
		assert.deepEqual(service.calls.remove, []);
		assert.deepEqual(logger.infoLines, []);
		assert.deepEqual(logger.warnLines, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：启动补删按账本逐项删除，汇总四种结局、账本只剩删不掉的", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		await ledger.add(["ok", "gone", "foreign", "stuck"]);
		const service = fakeService({ gone: "session-not-found", foreign: "not-claimed", stuck: "session-active" });
		const logger = collectingLogger();
		const reaper = createSessionReaper({ ctx: ctxWith(service), ledger, logger });

		const summary = await reaper.sweep();
		assert.equal(summary.attempted, 4);
		assert.deepEqual(summary.removed, [{ id: "ok", code: undefined }]);
		assert.deepEqual(summary.absent, [{ id: "gone", code: "session-not-found" }]);
		assert.deepEqual(summary.foreign, [{ id: "foreign", code: "not-claimed" }]);
		assert.deepEqual(summary.kept, [{ id: "stuck", code: "session-active" }]);
		assert.deepEqual(ledger.ids(), ["stuck"], "删不掉的留账，下次启动再试");
		// 补删前先按账本重新登记归属（服务的内存登记重启即失效）
		assert.deepEqual(service.calls.claim[0].ids, ["ok", "gone", "foreign", "stuck"]);
		assert.deepEqual(service.calls.claim[0].owner, CLEANUP_OWNER);
		assert.equal(logger.infoLines.length, 1, "清掉了几个只记一行");
		assert.equal(logger.warnLines.length, 1, "没清掉的只记一行");
		assert.match(logger.warnLines[0], /stuck\(session-active\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：服务不可用时的启动补删 —— 只记一条日志、账本原样保留", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "state.json");
		const ledger = openLedger({ file });
		await ledger.add(["child-1", "child-2"]);
		const logger = collectingLogger();
		const reaper = createSessionReaper({ ctx: { get: () => undefined }, ledger, logger });

		const summary = await reaper.sweep();
		assert.equal(summary.available, false);
		assert.equal(summary.unavailable, 2);
		assert.equal(summary.attempted, 0);
		assert.deepEqual(ledger.ids(), ["child-1", "child-2"]);
		assert.equal(logger.warnLines.length, 1, "最多一条日志，不刷屏");
		assert.match(logger.warnLines[0], /sessionRemoval/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清理：ctx.get 抛错（受限 ctx）时按服务不可用处理，不抛", async () => {
	const dir = tempDir();
	try {
		const ledger = openLedger({ file: join(dir, "state.json") });
		const reaper = createSessionReaper({
			ctx: { get: () => { throw new Error("denied"); } },
			ledger,
			logger: collectingLogger(),
		});
		assert.equal(reaper.available(), false);
		assert.deepEqual(await reaper.finish("child-1"), { outcome: "no-service" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
