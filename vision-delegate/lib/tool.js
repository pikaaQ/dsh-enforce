// dsh-vision-delegate — 模型可见的 subagent_vision 工具
//
// 这条工具就是"视觉能力"本身：插件在 host 平面 `tools.register()` 它，所以
// **任何 preset 的会话**都能看到（不再依赖某个 preset 里的 tool-subagent 行）。
//
// 图片怎么交给子代理（关键设计）：
//   * **不走路径**。插件在**自己这侧**把图片读成字节（或直接收内联 base64），
//     交给官方 attachments 服务存成 durable attachment，然后把 **image block** 放进
//     子代理的 prompt。子代理拿到的是图片本身，不需要 `read_image`，也拿不到任何文件路径。
//   * 支持三种输入：`images`（绝对路径，插件读字节）、`image_data`（内联 base64 + mediaType）、
//     以及后续"附加图片桥"要用的同一个附件通道（见 README 的做法 B）。
//
// 子代理用 `spawn`（`dsh-subagent-spawn-in-process`）：**全新上下文**、不继承会话历史，
// 并且支持 `agentOptions` 把 provider/model 固定到用户选定的视觉模型。
//
// 三条硬规则：
//   1. 未配置 / 已关闭 / provider 缺失 → 抛可执行错误，**绝不 spawn**（守卫也在同一判定上兜底）；
//   2. 附件被拒（类型/大小/坏 base64）→ 原样带原因抛出，不做静默降级；
//   3. 子代理运行结束一定 `run.dispose()`，失败把 diagnostic 原样带回，不伪装成功。

import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { refusalFor, SUBAGENT_PROVIDER, TOOL_NAME } from "./config.js";
import { sessionIdOfRun } from "./session-cleanup.js";

export const VISION_TOOL_DESCRIPTION =
  "把图片分析委派给视觉子代理，拿回图片内容。**用户直接附加的图片你看不到内容**——" +
  "那种情况下不要传参数，直接调用本工具即可：插件会自动把本会话最近的附件图片交给视觉子代理" +
  "（图片以附件形式直传，子代理不需要读文件、也拿不到任何路径），它读图后把结论返回给你，" +
  "你再据此回答用户。\n" +
  "需要显式指定图片时再传参数：`images`（图片绝对路径，插件读字节后作为附件交给子代理，路径不外传）" +
  "或 `image_data`（内联 base64）。**这两种方式都是把图片本身交给子代理**，它不需要去读文件；" +
  "反之，如果你想让子代理自己去读某个文件，就把**图片路径写进 `prompt`**（那种情况下它会按路径去读）。\n" +
  "视觉子代理**只负责看图并回答**：它那侧看不到图时会把**原因**回报给你（例如「这条消息里没有图片附件」），" +
  "而不是再往下委派——遇到这种回报就原样转告用户。\n" +
  "若调用被拒绝：错误信息会告诉你原因（未配置 → 让用户去 设置 → 插件 → 插件配置 → 「视觉委派」选模型；" +
  "已关闭 → 让用户点 composer 的「视觉」开关）。把该信息转告用户，不要重复调用。";

/**
 * 视觉子代理自己的**系统提示词前缀**（`subagents.start` 的 `persona`：官方用
 * `systemPrompt.section({ name: "deployment:persona-prefix" })` **遮蔽**父会话那套前缀，
 * 只作用于这个子会话）。
 *
 * 角色语义（用户 2026-09-21 明确）：它不是"能看就看、不能看就转发"，**它就是看图的那个角色**——
 * 看到图就答；看不到图就把**原因**回报给调用方（不是再委派）。
 * "要不要找文件"由**图片是怎么给的**决定：给了附件 → 直接看、别去找；只给了路径 → 按路径去读；
 * 都没有/读不出来 → 回报原因。早先让子代理沿用父会话那套"用户附图 → 先调 subagent_vision"的提示，
 * 正是 19 层委派链的诱因。
 *
 * 顺带把 Windows 执行纪律那一大段换掉，子代理的 system prompt 小很多 → 首字节更快。
 * ⚠️ 它只是**软约束**：兜住无限委派的是 `toolFilter`（子代理没有这个工具）与 `maxDepth`
 * （孙代委派被 harness 直接拒绝），见 `execute`。
 */
export const SUBAGENT_PERSONA =
  "你是**视觉子代理**：调用方把要分析的图片和问题交给你，你唯一的职责就是**看清这张图并回答**——" +
  "你就是负责看图的那一个，不需要把它转给别人。\n" +
  "**图片从哪来，决定你怎么拿**：\n" +
  "- 图片以**附件**形式出现在这条消息里（最常见）→ 直接读它。**不要**去找文件、不要 read_image、" +
  "不要在磁盘上搜图。\n" +
  "- 消息里**没有**附件，而调用方在 prompt 里给了**图片路径 / 地址** → 那就按那个路径**去读**" +
  "（read_image 等工具正是为这种情况准备的）；读不到就把确切原因回报。\n" +
  "- 两者都没有，或给了路径却读不出来 → 把**原因**如实回复给调用方" +
  "（例如「这条消息里没有图片附件」「路径 xxx 读不到：ENOENT」），让它去处理。\n" +
  "其它要求：\n" +
  "- 要求逐字转录时按原样抄下来，不要意译、不要省略、不要改写。\n" +
  "- 你**没有** subagent_vision 这个工具：不要委派、不要把它转给别的子代理。\n" +
  "- 看不清的地方明确写「看不清 / 不确定」，不要猜。用 Markdown 输出，简洁但完整；不要复述这些规则。";

/** 允许的图片类型 → 扩展名映射（与官方 attachments 的 mediaTypes 白名单一致）。 */
export const MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** `images` 接受路径字符串（保持既有写法的兼容）。 */
export function normalizeImages(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const path = typeof item === "string" ? item.trim() : item !== null && typeof item === "object" && typeof item.path === "string" ? item.path.trim() : "";
    if (path !== "") out.push({ path });
  }
  return out;
}

/** `image_data` 接受 `[{ mediaType, data }]`（规范 base64）。 */
export function normalizeImageData(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const mediaType = typeof item.mediaType === "string" ? item.mediaType.trim().toLowerCase() : "";
    const data = typeof item.data === "string" ? item.data.trim() : "";
    if (mediaType === "" || data === "") continue;
    out.push({ mediaType, data });
  }
  return out;
}

/** 路径 / 内联 base64 → 附件库输入（`{ data, mediaType, name? }`），读盘只发生在插件侧。 */
export function collectImageInputs(args, readFile = readFileSync) {
  const inputs = [];
  for (const { path } of normalizeImages(args?.images)) {
    const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
    if (mediaType === void 0) {
      throw new Error(`视觉委派：不认识的图片扩展名（${path}）。支持 .png / .jpg / .jpeg / .webp / .gif。`);
    }
    let data;
    try {
      data = readFile(path);
    } catch (error) {
      throw new Error(`视觉委派：读不到图片 ${path}（${error instanceof Error ? error.message : String(error)}）。`);
    }
    inputs.push({ data, mediaType, name: path.split(/[\\/]/).pop() });
  }
  for (const item of normalizeImageData(args?.image_data)) {
    inputs.push({ data: Buffer.from(item.data, "base64"), mediaType: item.mediaType });
  }
  return inputs;
}

/** 交给子代理的文本部分（图片本身走 image block，这里只说明"附带了几张"）。 */
export function buildDelegationPrompt(args, imageCount = 0) {
  const lines = [];
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (prompt !== "") lines.push(prompt);
  if (imageCount > 0) {
    lines.push("", `（本条消息已附带 ${imageCount} 张图片，请直接读图回答，不要去找文件路径。）`);
  }
  return lines.join("\n");
}

/** 把子代理返回的 ContentBlock[] 里的文本拼起来。 */
export function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * 构造工具定义。
 * @param readStatus (sessionId) => 'unconfigured' | 'off' | 'on'
 * @param readConfig () => { enabled, provider, model }
 * @param subagents 宿主 `subagents` 服务（子代理注册表）
 * @param attachments 宿主 `attachments` 服务（把字节变成 durable 图片附件）
 * @param readSessionImages (sessionId) => AttachmentRef[]  本会话最近的附件图片
 *   （由附加图片桥在"本轮附图"时记下；不带 `images`/`image_data` 调用时自动用它）
 * @param isProviderAvailable () => boolean（宿主是否注册了配置的 subagent provider）
 * @param sessionCleanup 可选：临时子会话清理器（`lib/session-cleanup.js`）——子代理跑完
 *   立刻把它的会话 id 交给 `dsh-workspace-manager` 的 `sessionRemoval` 服务删掉。
 *   它**只是附加能力**：缺失或抛错都不影响这次委派的结果（内核没有删除 API，机制在对方那边）。
 */
export function createVisionTool({
  readStatus,
  readConfig,
  subagents,
  attachments,
  readSessionImages = () => [],
  isProviderAvailable = () => true,
  toolName = TOOL_NAME,
  provider = SUBAGENT_PROVIDER,
  sessionCleanup,
}) {
  const sessionImagesOf = (sessionId) => {
    try {
      const refs = readSessionImages(sessionId);
      return Array.isArray(refs) ? refs.filter((ref) => ref !== null && typeof ref === "object" && typeof ref.attachmentId === "string") : [];
    } catch {
      return [];
    }
  };
  /** 临时会话清理是**附加**能力：任何失败都不改变这次委派的结果，也绝不抛出去。 */
  const cleanupSafely = async (method, sessionId, options) => {
    if (sessionId === void 0) return;
    try {
      await sessionCleanup?.[method]?.(sessionId, options);
    } catch {
      /* 清理失败不影响结论交付（下次插件启动还会补删） */
    }
  };
  return {
    name: toolName,
    description: VISION_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "交给视觉子代理的问题与要求（必填）。" },
        images: {
          type: "array",
          items: { type: "string" },
          description: "要分析的图片绝对路径，一个或多个（插件读取字节后作为附件交给子代理，路径不会外传）。",
        },
        image_data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              mediaType: { type: "string", description: "如 image/png、image/jpeg。" },
              data: { type: "string", description: "规范 base64 编码的图片字节。" },
            },
            required: ["mediaType", "data"],
            additionalProperties: false,
          },
          description: "没有文件路径时用内联 base64（规范 base64）直接给图片字节。",
        },
        label: { type: "string", description: "可选：这次委派的一行标签，显示在会话里。" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          images: { type: "integer" },
          conclusion: { type: "string" },
          diagnostic: { type: "string" },
          stopReason: { type: "string" },
        },
        required: ["conclusion"],
        additionalProperties: true,
      },
      render(_args, value) {
        const payload = value ?? {};
        const text =
          typeof payload.conclusion === "string" && payload.conclusion !== "" ? payload.conclusion : "(子代理没有返回文本结论)";
        const header = `视觉子代理（${payload.provider ?? "?"} / ${payload.model ?? "?"}${
          typeof payload.images === "number" && payload.images > 0 ? `，${payload.images} 张图` : ""
        }）`;
        const suffix =
          typeof payload.diagnostic === "string" && payload.diagnostic !== "" ? `\n\n[diagnostic] ${payload.diagnostic}` : "";
        return [{ type: "text", text: `${header}\n\n${text}${suffix}` }];
      },
    },
    presentCall(args) {
      const config = readConfig();
      const explicit = normalizeImages(args?.images).length + normalizeImageData(args?.image_data).length;
      return {
        card: "generic",
        title: `视觉委派 → ${config.provider}/${config.model}`,
        kind: "other",
        // `images` 保持数值类型（卡片可能直接渲染它）；"没给参数=用本轮附件"另用 `attachments` 说明。
        rawInput: {
          images: explicit,
          attachments: explicit === 0 ? "本轮附件（自动）" : "显式指定",
          prompt: args?.prompt,
        },
      };
    },
    async execute(args, exec) {
      const refusal = refusalFor(readStatus(exec?.agent?.id));
      if (refusal !== void 0) throw new Error(refusal);
      if (!isProviderAvailable()) {
        throw new Error(
          `视觉委派不可用：宿主没有注册 "${provider}" 子代理提供方（需要 @deepseek-ai/dsh-subagent-spawn-in-process）。`
        );
      }
      const agent = exec?.agent;
      if (agent === void 0) throw new Error("视觉委派：这次调用没有关联的 Agent，无法建立父子关系。");

      // 1) 图片：三种来源，都变成 image block 交给子代理（子代理不需要 read_image，也拿不到路径）
      //    ① `images` 绝对路径 → 插件读字节 → 附件库；
      //    ② `image_data` 内联 base64 → 附件库；
      //    ③ 都不给 → 用**本会话最近的附件图片**（附加图片桥记下的；用户直接附图的场景）。
      const inputs = collectImageInputs(args);
      let refs = [];
      let source = "none";
      if (inputs.length > 0) {
        if (attachments === void 0 || typeof attachments.saveImages !== "function") {
          throw new Error("视觉委派：宿主没有 attachments 服务，无法把图片作为附件交给子代理。");
        }
        try {
          refs = await attachments.saveImages(inputs);
          source = "explicit";
        } catch (error) {
          throw new Error(`视觉委派：图片被附件库拒绝（${error instanceof Error ? error.message : String(error)}）。`);
        }
      } else {
        // 用户直接附图（或上一轮附过图）：直接把 durable ref 交给子代理，不读字节、不落盘、不传路径。
        refs = sessionImagesOf(agent.id);
        if (refs.length > 0) source = "session";
      }

      const config = readConfig();
      // 父会话当前的委派深度（官方 `delegationDepthOf` 的同一算法）：用来给这次委派一个**绝对值上限**，
      // 让"子代理再委派一层"（孙代）在 harness 层被 `SubagentDepthError` 直接拒掉。
      const parentDepth = Math.max(
        Number.isSafeInteger(agent?.session?.header?.delegationDepth) ? agent.session.header.delegationDepth : 0,
        Number.isSafeInteger(agent?.options?.subagentDepth) ? agent.options.subagentDepth : 0,
        0
      );
      const run = await subagents.start(provider, {
        label: typeof args?.label === "string" && args.label.trim() !== "" ? args.label.trim() : "vision",
        prompt: [
          ...refs.map((attachment) => ({ type: "image", attachment })),
          { type: "text", text: buildDelegationPrompt(args, refs.length) },
        ],
        parent: agent,
        signal: exec.signal,
        agentOptions: { provider: config.provider, model: config.model },
        // ① 子代理的系统提示词：你能看图 → 直接回答，不要委派、不要找文件（见 SUBAGENT_PERSONA）。
        persona: SUBAGENT_PERSONA,
        // ② 硬约束：子代理的工具目录里**没有** `subagent_vision`，想再委派也调不到。
        toolFilter: { deny: [toolName] },
        // ③ 硬约束：孙代委派的深度会超过这个绝对值上限，harness 直接拒绝。
        maxDepth: parentDepth + 1,
      });
      // 子会话 id = `run.id`（官方契约：本地 run 的 id **就是**已发布的子会话 id）。
      // 一拿到就落账：这样即使进程随后崩溃，下次启动也能补删这个临时会话。
      // 同时把**本会话 id**（`agent.id`）作为父会话指针一起登记 —— dsh-workspace-manager
      // 用它把视觉子会话挂到主会话下面（内核没有父子关系数据，也不解析日志兜底）。
      const childSessionId = sessionIdOfRun(run);
      await cleanupSafely("track", childSessionId, { parentSessionId: agent?.id });
      try {
        const result = await run.result;
        return {
          provider: config.provider,
          model: config.model,
          images: refs.length,
          source,
          conclusion: textOfBlocks(result?.output),
          diagnostic: typeof result?.diagnostic === "string" ? result.diagnostic : "",
          stopReason: typeof result?.stopReason === "string" ? result.stopReason : "",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`视觉子代理运行失败（${config.provider}/${config.model}）：${message}`);
      } finally {
        try {
          await run.dispose?.();
        } catch {
          /* 释放失败不影响已经把结论交给调用方 */
        }
        // ④ 完成即删：子代理已经跑完（无论成败），立刻把这个临时会话交给
        // `dsh-workspace-manager` 的 `sessionRemoval` 服务删掉（服务不在就留账，启动时补删）。
        await cleanupSafely("finish", childSessionId);
      }
    },
  };
}
