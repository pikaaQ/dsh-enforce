// dsh-vision-delegate — 临时诊断探针（排查"附图片后卡住"）
//
// 只在排查期间存在：把桥的每个阶段与每次出网请求写成 JSONL，
// 落盘到 $DSH_HOME/vision-delegate-trace.log（可用 DSH_VISION_TRACE 改路径）。
// 不改变任何行为；确认原因后整份删掉即可。
//
// 用法：重启 dsh web → 复现 → 读 trace 文件（卡住时最后一行 = 卡住的阶段）。

import { appendFileSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE =
  process.env.DSH_VISION_TRACE && process.env.DSH_VISION_TRACE !== ""
    ? process.env.DSH_VISION_TRACE
    : join(process.env.DSH_HOME && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh"), "vision-delegate-trace.log");

const start = Date.now();
/** 串行化 + 带时间戳的 JSONL 追加（同步写：卡死前一定已经落盘）。 */
export function trace(event, data) {
  const line = JSON.stringify({ ms: Date.now() - start, at: new Date().toISOString(), pid: process.pid, ev: event, ...(data === void 0 ? {} : { d: data }) });
  try {
    appendFileSync(FILE, `${line}\n`, "utf8");
  } catch {
    /* 探针不能影响主流程 */
  }
}

export const traceFile = FILE;

/** 只在模块首次加载时清空（避免上一轮的噪音混进来）。 */
export function resetTraceFile() {
  try {
    statSync(FILE);
    truncateSync(FILE, 0);
  } catch {
    /* 文件不存在就无所谓 */
  }
}

/** 把出网请求也记下来：判断"请求到底有没有发出去"。 */
export function installFetchTrace() {
  const marker = Symbol.for("dsh-vision-delegate.trace.fetch");
  const globalObject = globalThis;
  if (globalObject[marker] === true) return;
  globalObject[marker] = true;
  const original = globalObject.fetch;
  if (typeof original !== "function") return;
  globalObject.fetch = async function tracedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url ?? "";
    if (!/(chat\/completions|responses|completions|messages)/.test(url)) return original.call(this, input, init);
    const started = Date.now() - start;
    let model;
    let bodyBytes;
    try {
      const raw = init?.body;
      if (typeof raw === "string") {
        bodyBytes = raw.length;
        model = JSON.parse(raw)?.model;
      } else if (raw !== void 0 && raw !== null) bodyBytes = -1;
    } catch {
      /* 解析失败不影响探针 */
    }
    let host = url;
    try {
      const parsed = new URL(url);
      host = `${parsed.host}${parsed.pathname}`;
    } catch {
      /* 保持原样 */
    }
    trace("fetch:start", { started, host, method: init?.method ?? "GET", model, bodyBytes });
    try {
      const response = await original.call(this, input, init);
      trace("fetch:headers", { ms: Date.now() - start, host, status: response.status });
      response
        .clone()
        .text()
        .then((text) => trace("fetch:end", { ms: Date.now() - start, host, status: response.status, bytes: text.length, tail: text.slice(-160) }))
        .catch((error) => trace("fetch:body-error", { ms: Date.now() - start, host, message: String(error?.message ?? error) }));
      return response;
    } catch (error) {
      trace("fetch:error", { ms: Date.now() - start, host, name: error?.name, message: String(error?.message ?? error) });
      throw error;
    }
  };
}
