// dsh-vision-delegate — 附加图片桥
//
// 目标：用户像平常一样在 composer 里**附加图片**，也能用；图片既不落盘到别处、也不经过不能看图的主模型，
// 而且**只有图片会被送进视觉子代理**——历史与工具不外发。
//
// 卡点（官方代码，无插件接缝）：
//   `dsh-api-session-controller` 在提交提示词时用 `llm.resolveModelInfo(...).inputModalities`
//   判定"模型不支持图片"就直接拒绝附件（`MODEL_DOES_NOT_SUPPORT_IMAGES`），消息根本不会被创建。
//   → ① **能力垫片**：配置了视觉模型时把能力报告成"包含 image"，消息得以创建、image block 留在会话里。
//
// 接下来为什么**不是**"整体重定向"（2026-09-21 事故）：
//   把那一轮的整份请求改路由到视觉模型，等于把**整段会话历史 + 工具表**一起发给视觉模型。
//   主模型窗口通常比视觉模型大得多（现场 80 万 vs 40 万，历史已 60 万 tokens），而本机网关对
//   超窗请求**既不报错也不返回内容**（接受连接后长时间不吐字节）→ 界面表现为"卡住"。
//   实测同一段 60 万 tokens 历史：小窗口视觉模型首字节 40s 起、更长时完全无响应；80 万窗口的 3.0s。
//
// 现在的做法（"子代理看图、主模型回答"）：
//   ② 本轮带新图、而目标模型不能看图时，桥**不换路由**，只在**最后那条用户消息**后面追加一条指令，
//      让主模型先调用 `subagent_vision` 取回图片内容再回答；那次调用仍走原 provider/model，
//      历史与工具一个字节都不外发。
//   ③ 本轮图片的 attachment ref 记进本会话暂存，`subagent_vision` 不带图片参数时自动用它——
//      子代理因此只拿到**图片 + 主模型写的问题**（spawn，全新上下文）。
//      子代理结论作为 tool result 落进会话日志，**后续轮次依然可见**。
//
// 为什么不能"改写图片块再交给下游"：瀑布的 `next()` 是闭包 `() => (cbs.shift() ?? inner)(...args)`，
// 不吃参数、永远转发最初那份 options；agent-loop 构造的 request 是 `Object.freeze` + 消息 `deepFreeze`
// （官方契约：listeners *read it, never rewrite it*）。所以"追加提示"只能通过**自己再发一次调用**实现，
// 而不是把改写后的 options 交给 `next()`。
//
// ⚠️ 本文件当前带**临时诊断探针**（trace.js）。确认稳定后整份删掉。

import { trace } from "./trace.js";

/** 我们自己注入过提示的 options（WeakSet 认对象身份）：嵌套那一次直接放行，避免自我递归。
 *  不用模块级 depth 计数——不同会话是并发的，全局计数会互相干扰。 */
const hintedRequests = new WeakSet();

/** 卡住时定时汇报"当前阶段"（只记日志，不改变行为）。 */
function stallWatch(stage, timers = [10000, 30000, 60000]) {
  const handles = timers.map((ms) => setTimeout(() => trace("bridge:stall", { stage: stage.value, afterMs: ms }), ms));
  return () => {
    for (const handle of handles) clearTimeout(handle);
  };
}

/** 某次调用里是否有图片块（含嵌套 tool-result 内容）。 */
export function hasImageBlock(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (message) => Array.isArray(message?.content) && message.content.some((block) => containsImage(block))
  );
}

function containsImage(block) {
  if (block?.type === "image") return true;
  if (block?.type === "tool-result") return Array.isArray(block.content) && block.content.some((nested) => containsImage(nested));
  return false;
}

function collectImageRefs(blocks, refs) {
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === "image" && block.attachment !== void 0) refs.set(String(block.attachment.attachmentId), block.attachment);
    else if (block?.type === "tool-result") collectImageRefs(block.content, refs);
  }
}

/** 最近一条**真正的**用户发言（跳过工具结果消息：官方 `createToolResultMessage` 也是 role: 'user'）。 */
export function newestUserMessage(messages) {
  if (!Array.isArray(messages)) return void 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolResultOnly = blocks.length > 0 && blocks.every((block) => block?.type === "tool-result");
    if (toolResultOnly) continue;
    return message;
  }
  return void 0;
}

/**
 * 这条消息是不是**用户自己**的发言（而不是工具结果载体、也不是宿主注入的上下文）。
 *
 * 宿主的注入上下文同样是 `role: 'user'`，但带**来源标记**（`@deepseek-ai/dsh-llm` 的
 * `MessageSourceMap`：真实用户发言是 `kind: 'user'`；注入是 `plugin` / `model` / `tool`
 * 以及插件自加的 `agent-instructions` / `skill-catalog` …——该联合类型是 merge-extensible 的，
 * 所以**按"不是 'user' 就不算"判定**，而不是枚举注入种类）。缺失 `source` 时才退回宽松处理。
 */
function isPromptMessage(message) {
  if (message?.role !== "user") return false;
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (blocks.length > 0 && blocks.every((block) => block?.type === "tool-result")) return false;
  const kind = message?.source?.kind;
  if (typeof kind === "string" && kind !== "user") return false;
  return true;
}

/**
 * 从末尾往前找"本轮新附的图片"所在的用户发言，找到就返回它的 content blocks。
 *
 * 三条规则叠加（每一条都是现场踩出来的）：
 *   1. **先筛掉注入消息**：宿主会在用户消息之后追加若干注入的 `user` 消息
 *      （AGENTS.md=`agent-instructions`、运行时上下文=`plugin`、技能目录=`skill-catalog` …），
 *      它们**不是**用户发言（真实用户发言的 `source.kind === 'user'`，见 `isPromptMessage`）。
 *      只看"最近一条 role==='user' 的消息"时附图那一轮会被判成"没有新图"：桥不记暂存、不注入提示，
 *      子代理收到一个**没有图的空委派**（2026-09-21 现场）。
 *   2. **助手消息是"更早轮次"的边界**：同一轮里助手已经答过（tool-call/tool-result 之后）就不再注入。
 *   3. **回到"筛完注入之后"的最新一条用户发言本身看它带不带图**——这条是关键：不能拿
 *      "有没有助手消息"当"这张图是否已经处理过"，因为**一轮失败时不会留下助手消息**
 *      （例如开关关着被拒）。否则那张图会被永远当成"本轮新图"，后续每一轮（哪怕纯文本）
 *      都继续报"视觉委派已关闭"，除非用户想办法把它"处理掉"。
 *      只有"同一次提交被拆成多条消息"（同 `source.rpcId`）时，才把更早那条带图的发言也算作本轮。
 *
 * 注意顺序：**先按 kind 过滤、再取最新一条**。所以"最新一条"永远是用户自己的发言，
 * 注入消息再新也当不上（这正是第 1 条与第 3 条能同时成立的原因）。
 */
function turnImageBlocks(messages) {
  if (!Array.isArray(messages)) return void 0;
  /** 最后一条助手消息之后、且**筛掉注入消息**的用户发言（时间顺序）。 */
  const prompts = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") break; // 更早的都已被回答过
    if (!isPromptMessage(message)) continue; // 注入消息 / 工具结果：这里就筛掉了
    prompts.unshift(message);
  }
  const newest = prompts[prompts.length - 1]; // ← 一定是用户自己的发言
  if (newest === void 0) return void 0;
  const blocks = Array.isArray(newest.content) ? newest.content : [];
  if (blocks.some((block) => block?.type === "image")) return blocks;
  // 最新一条用户发言没带图 → 只有"同一次提交"的兄弟消息带图时才算同一轮
  const rpcId = newest?.source?.rpcId;
  if (typeof rpcId !== "string" || rpcId === "") return void 0;
  for (let index = prompts.length - 2; index >= 0; index -= 1) {
    const candidate = prompts[index];
    if (candidate?.source?.rpcId !== rpcId) continue;
    const candidateBlocks = Array.isArray(candidate.content) ? candidate.content : [];
    if (candidateBlocks.some((block) => block?.type === "image")) return candidateBlocks;
  }
  return void 0;
}

/** 这一**轮**是否需要视觉模型：最新一条用户发言（自上一次助手回答之后）里有没有图片。 */
export function turnNeedsVision(messages) {
  return turnImageBlocks(messages) !== void 0;
}

/** 本轮图片的 attachment ref（去重、保持顺序）。 */
export function newestUserImageRefs(messages) {
  const blocks = turnImageBlocks(messages);
  if (blocks === void 0) return [];
  const refs = new Map();
  collectImageRefs(blocks, refs);
  return [...refs.values()];
}

/**
 * 会话里**最近出现过**的图片 ref（不设"本轮"边界，从末尾往前找第一条带图的用户发言）。
 * 只用于给"本轮图片"擦屁股：万一某一轮没记上暂存，后续请求仍能把它记回来，
 * 于是"附过图之后再说'看一下那张图'"在同一个会话里也能用。
 */
export function latestUserImageRefs(messages) {
  if (!Array.isArray(messages)) return [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isPromptMessage(message)) continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (!blocks.some((block) => block?.type === "image")) continue;
    const refs = new Map();
    collectImageRefs(blocks, refs);
    return [...refs.values()];
  }
  return [];
}

/** 该模型是否声明了图片输入（`inputModalities` 缺失视为"未知"，交给下游决定）。 */
export function modelTakesImages(info) {
  if (info === void 0 || info === null) return true;
  if (!Array.isArray(info.inputModalities)) return true;
  return info.inputModalities.includes("image");
}

/**
 * 注入给主模型的指令。追加在**最后那条用户消息**的文本后面（不改任何已有块），
 * 告诉它图片在会话里但它看不到内容、以及怎么取回来。
 */
export function visionHintText(count) {
  return (
    `\n\n[视觉委派] 本轮用户直接附带了 ${count} 张图片，但当前模型不支持图片输入——你只看到占位符，看不到图片内容。` +
    `请**先调用 subagent_vision**（不要传 images / image_data，它会自动带上本轮附件）取回图片内容，再据此回答用户；` +
    `若调用被拒绝，把拒绝理由原样转告用户，不要重复调用。`
  );
}

/** 把提示追加到"最后一条用户角色的消息"上（含宿主注入的那几条——放在最末尾对指令遵循最有利），
 *  返回新的 messages 数组（绝不改动原对象——官方契约只读）。 */
export function withVisionHint(messages, count) {
  const target = newestUserMessage(messages);
  if (target === void 0) return messages;
  return messages.map((message) =>
    message === target
      ? { ...message, content: [...(Array.isArray(message.content) ? message.content : []), { type: "text", text: visionHintText(count) }] }
      : message
  );
}

/**
 * 决策：这次调用要不要注入提示。
 * @returns {{action:'passthrough'|'refuse'|'hint', reason?:string}}
 *
 * 判定顺序有意把"目标模型本来就能看图"放在最前面：那样它与插件开关无关
 * （用原生视觉模型的会话不该被本插件的开关拦下来）。
 */
export function decideBridgeAction({ status, config, options, modelInfo }) {
  if (!turnNeedsVision(options?.messages)) return { action: "passthrough" };
  // 只拦**主调用**：带 `purpose` 的是辅助调用（`session-title` 生成标题、`compaction` 压缩历史），
  // 它们的请求里同样带着整段历史（含那张图），拦下来只会把提示混进标题/摘要提示词里。
  if (options?.purpose !== void 0) return { action: "passthrough" };
  const provider = typeof config?.provider === "string" ? config.provider.trim() : "";
  const model = typeof config?.model === "string" ? config.model.trim() : "";
  if (options.provider === provider && options.model === model) return { action: "passthrough" };
  if (modelTakesImages(modelInfo)) return { action: "passthrough" };
  if (status !== "on") {
    return {
      action: "refuse",
      reason:
        "视觉委派已关闭：这条消息附了图片，而当前模型不能看图。请打开 composer 右下角的「视觉」开关，" +
        "或先切换到支持图片的模型再发。",
    };
  }
  if (provider === "" || model === "") {
    return {
      action: "refuse",
      reason: "视觉委派未配置：请先在 设置 → 插件 → 插件配置 → 「视觉委派」卡片里选择视觉模型。",
    };
  }
  return { action: "hint" };
}

/**
 * 安装"模型能力垫片"：让官方控制器与前端目录在**配置了视觉模型**时认为当前模型能收图。
 * 返回还原函数（disposer），插件卸载/停用时能力报告恢复原样。
 * 注意：桥内部用**原始** resolveModelInfo 判定真实能力，所以垫片不会骗到自己。
 */
export function installModelInfoShim(llm, isEnabled) {
  if (llm === void 0 || llm === null) return () => {};
  const originalResolve = llm.resolveModelInfo;
  const originalList = llm.listModels;
  const withImage = (info) => {
    if (info === void 0 || info === null || !Array.isArray(info.inputModalities)) return info;
    if (info.inputModalities.includes("image")) return info;
    return { ...info, inputModalities: [...info.inputModalities, "image"] };
  };
  if (typeof originalResolve === "function") {
    llm.resolveModelInfo = async function shimmedResolveModelInfo(...args) {
      const info = await originalResolve.apply(this, args);
      return isEnabled() ? withImage(info) : info;
    };
  }
  if (typeof originalList === "function") {
    llm.listModels = async function shimmedListModels(...args) {
      const models = await originalList.apply(this, args);
      if (!isEnabled() || !Array.isArray(models)) return models;
      return models.map((entry) => withImage(entry));
    };
  }
  return () => {
    if (typeof originalResolve === "function") llm.resolveModelInfo = originalResolve;
    if (typeof originalList === "function") llm.listModels = originalList;
  };
}

/**
 * 构造 `llm/stream` 监听器（瀑布：要么调用 `next()`，要么自己产出 chunk 流）。
 * 判定用**原始** resolveModelInfo（绕开垫片），避免"说模型能看图"→"因此不注入"的自欺。
 * @param recordTurnImages 可选：`(sessionId, refs) => void`，把本轮的图片 ref 记进会话暂存（工具会用）。
 */
export function createVisionBridge({ llm, readStatus, readConfig, resolveModelInfo, recordTurnImages }) {
  const probe = typeof resolveModelInfo === "function" ? resolveModelInfo : (provider, model, signal) => llm.resolveModelInfo(provider, model, signal);
  return async function* visionBridge(options, next) {
    const stage = { value: "enter" };
    const stopWatch = stallWatch(stage);
    trace("bridge:enter", {
      depth: hintedRequests.has(options) ? "hinted" : 1,
      provider: options?.provider,
      model: options?.model,
      purpose: options?.purpose,
      sessionId: options?.sessionId,
      messages: Array.isArray(options?.messages) ? options.messages.length : -1,
      hasImage: hasImageBlock(options?.messages),
      turnNeedsVision: turnNeedsVision(options?.messages),
    });
    async function* passthrough(path) {
      stage.value = `${path}:awaiting-first-chunk`;
      let count = 0;
      for await (const chunk of next()) {
        if (count === 0) {
          stage.value = `${path}:streaming`;
          trace("bridge:first-chunk", { path });
        }
        count += 1;
        yield chunk;
      }
      trace("bridge:end", { path, chunks: count });
    }
    try {
      // 我们自己注入提示后重发的那一次：直接放行（认对象身份，不认全局计数——会话是并发的）。
      if (hintedRequests.has(options)) {
        yield* passthrough("hinted-passthrough");
        return;
      }
      stage.value = "read-status";
      const status = readStatus(options?.sessionId);
      const config = readConfig();
      trace("bridge:config", { status, config, frozen: Object.isFrozen(options) });

      stage.value = "decide";
      const needsVision = turnNeedsVision(options?.messages);
      // 图片暂存：**每一轮都记一次**（不只在"本轮带图"那一轮）。
      //   * 本轮带图 → 记本轮那张（覆盖）；
      //   * 本轮不带图、但请求里仍有图片（历史里的那张）→ 记最近出现的那张（刷新 TTL，
      //     并给"万一某轮没记上"兜底：附过一次图之后再说"看一下那张图"也能用）；
      //   * 全无图片 → recordTurnImages 自己会跳过。
      const turnRefs = turnImageBlocks(options?.messages) === void 0 ? [] : newestUserImageRefs(options?.messages);
      const stashRefs = turnRefs.length > 0 ? turnRefs : latestUserImageRefs(options?.messages);
      if (stashRefs.length > 0 && typeof recordTurnImages === "function") {
        try {
          recordTurnImages(options?.sessionId, stashRefs);
        } catch (error) {
          trace("bridge:record-failed", { message: String(error?.message ?? error) });
        }
      }
      if (!needsVision || options?.purpose === "session-title") {
        trace("bridge:passthrough", {
          reason: "no-new-image-in-this-turn",
          stashed: stashRefs.length,
        });
        yield* passthrough("passthrough");
        return;
      }

      // 本轮图片已经记进暂存（见上）；下面走"注入提示"那一路。
      const refs = turnRefs;
      trace("bridge:record", { count: refs.length, sessionId: options?.sessionId });

      let modelInfo;
      const probeStarted = Date.now();
      try {
        modelInfo = await probe(options.provider, options.model, options.signal);
        trace("bridge:probe-ok", { ms: Date.now() - probeStarted, inputModalities: modelInfo?.inputModalities });
      } catch (error) {
        modelInfo = void 0; // 探不到就当未知，交给下游
        trace("bridge:probe-fail", { ms: Date.now() - probeStarted, message: String(error?.message ?? error) });
      }
      const decision = decideBridgeAction({ status, config, options, modelInfo });
      trace("bridge:decision", { decision, modelTakesImages: modelTakesImages(modelInfo) });
      if (decision.action === "refuse") throw new Error(decision.reason);
      if (decision.action === "passthrough") {
        yield* passthrough("passthrough-visible-model");
        return;
      }

      // 本轮图片已经记进暂存（见上）；这里只负责给主模型注入"先调 subagent_vision"的指令。
      const augmented = { ...options, messages: withVisionHint(options.messages, refs.length) };
      hintedRequests.add(augmented);
      trace("bridge:hint", { count: refs.length, sessionId: options?.sessionId, messages: augmented.messages.length });
      stage.value = "hint:awaiting-first-chunk";
      let count = 0;
      for await (const chunk of llm.stream(augmented)) {
        if (count === 0) {
          stage.value = "hint:streaming";
          trace("bridge:first-chunk", { path: "hint", ms: Date.now() - probeStarted });
        }
        count += 1;
        yield chunk;
      }
      trace("bridge:end", { path: "hint", chunks: count });
    } catch (error) {
      trace("bridge:error", { stage: stage.value, name: error?.name, message: String(error?.message ?? error) });
      throw error;
    } finally {
      stopWatch();
      trace("bridge:exit", { stage: stage.value });
    }
  };
}
