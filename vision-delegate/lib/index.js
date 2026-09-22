// dsh-vision-delegate — host 半区
//
// 一个插件承担四件事：
//   1. `settings` 命名空间 `vision-delegate`（官方 `installSection`）——配置的权威存储，
//      也是"设置 → 插件 → 插件配置"里卡片的分发 key；
//   2. `ctx.tools.register()` 注册 `subagent_vision`——**全局**，任何 preset 的会话都能用；
//   3. `ctx.tools.guard()`——调用时门控（未配置/已关闭直接拒绝，工具目录保持稳定）；
//   4. `/vision-delegate` 与 `/vision-delegate/models` 路由——给 composer 开关与设置卡片读写
//      （官方 `ctx.webServer` 扩展点，Node `(req,res)` 契约）。
//
// 四个宿主服务都写在**模块级 inject** 里：loader 会等它们就绪再调用 `apply`，因此下面全是
// 直接调用、没有"注入回调可能不触发"的静默路径。代价是这条行只在 web profile 生效
// （headless/TUI 没有 webServer）。官方 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`
// 用的也是子路径行 + 模块级 inject 这套写法。
//
// 配置在 `apply` 里只读一次；官方 installSection 会在设置变更时回调 `setSource`，
// 因此卡片保存后**同一进程内立即生效**，无需重启。

import {
  Config,
  createRefusalGuard,
  DEFAULT_CONFIG,
  isConfigured,
  normalizeConfig,
  SETTINGS_NAMESPACE,
  statusOf,
  statusPayload,
  TOOL_NAME,
  validateConfig,
} from "./config.js";
import { candidateIsUsable, listCandidates } from "./candidates.js";
import { createVisionTool } from "./tool.js";
import { createVisionBridge, installModelInfoShim } from "./bridge.js";
import { createSessionReaper, openLedger, SESSION_REMOVAL_SERVICE } from "./session-cleanup.js";
import { installFetchTrace, resetTraceFile, trace } from "./trace.js";
import { readJsonBody, respond, sessionIdOf } from "./http.js";

export const name = "dsh-vision-delegate";
// 硬依赖（模块级 inject：loader 会等它们就绪后再 apply；缺任何一个整行都不会激活）：
//   tools / subagents —— 宿主平面工具注册表与子代理注册表；
//   settings —— 配置命名空间（官方 installSection + 设置卡片按命名空间分发）；
//   webServer —— composer 开关与设置卡片读写的路由；
//   attachments —— 把图片字节存成 durable 附件，好让子代理直接收到 image block（不走路径）；
//   llm —— 附加图片桥：垫片（能力报告）+ `llm/stream` 瀑布（本轮附图时给主模型注入"先调 subagent_vision"）。
// ⚠️ `sessionRemoval`（dsh-workspace-manager 发布的会话清理服务）**故意不在这里**：
//    它是**可选**依赖 —— 写进 inject 会让对方缺席时整行 parked（视觉功能一起消失）。
//    实际用法是 `ctx.get('sessionRemoval')` 探测 + `ctx.inject([...], …)` 等它就绪（见下）。
export const inject = ["tools", "subagents", "settings", "webServer", "attachments", "llm"];

export const ROUTE_STATUS = "/vision-delegate";
export const ROUTE_MODELS = "/vision-delegate/models";
export const PROVIDER_NAME = "spawn";
/** 卡片/开关要保存的字段。 */
export const CONFIG_FIELDS = ["enabled", "provider", "model"];

export function apply(ctx, config = DEFAULT_CONFIG) {
  // ⚠️ 临时诊断探针（排查"附图片后卡住"）：清空上一轮 trace + 记录出网请求。
  resetTraceFile();
  installFetchTrace();
  trace("apply", { statusPath: config?.statusPath, config: normalizeConfig(config) });

  // 路由可在行 config 里改名（用于隔离验证：临时 preset 挂载到独立路径，不撞默认路径）。
  const statusPath = typeof config?.statusPath === "string" && config.statusPath !== "" ? config.statusPath : ROUTE_STATUS;
  const modelsPath = typeof config?.modelsPath === "string" && config.modelsPath !== "" ? config.modelsPath : ROUTE_MODELS;

  let current = () => normalizeConfig(config);
  /** 会话级覆盖（内存；不落盘，新会话回落配置默认）。 */
  const sessionOverrides = new Map();

  const readConfig = () => normalizeConfig(current());
  const readStatus = (sessionId) =>
    statusOf(readConfig(), typeof sessionId === "string" && sessionId !== "" ? sessionOverrides.get(sessionId) : void 0);
  // 注意：**不要**给视觉子会话授"已开"（曾做过，见 git 历史）：那会放行子代理自己的
  // `subagent_vision` 调用 → 子代理再委派一层 → 19 层委派链（2026-09-21 现场）。
  // 子会话的状态需求由"目标==配置的视觉模型 → 桥直接放行"满足；无限委派由工具侧的
  // toolFilter + maxDepth 兜住。
  const isProviderAvailable = () => {
    try {
      return Array.isArray(ctx.subagents?.list?.()) && ctx.subagents.list().includes(PROVIDER_NAME);
    } catch {
      return false;
    }
  };

  // 会话 → 最近一次出现在请求里的图片 ref（内存；进程重启即失效，不落盘）。
  // 只在新的一轮附了图时覆盖，所以"附完图后隔一轮再问那张图"时工具仍然拿得到。
  // 声明放在最前面：工具（第 2 步）与桥（第 4 步）都要用它。
  const sessionImages = new Map();
  const SESSION_IMAGE_TTL_MS = 30 * 60 * 1000;
  const recordTurnImages = (sessionId, refs) => {
    if (typeof sessionId !== "string" || sessionId === "" || !Array.isArray(refs) || refs.length === 0) return;
    sessionImages.set(sessionId, { refs, at: Date.now() });
  };
  const readSessionImages = (sessionId) => {
    if (typeof sessionId !== "string" || sessionId === "") return [];
    const hit = sessionImages.get(sessionId);
    if (hit === void 0) return [];
    if (Date.now() - hit.at > SESSION_IMAGE_TTL_MS) {
      sessionImages.delete(sessionId);
      return [];
    }
    return hit.refs;
  };

  // 1) 配置命名空间：官方 installSection（旧版本退回 register）。
  const hooks = {
    setSource: (source) => {
      current = source;
    },
    validate: (value) => validateConfig(value),
    onChange: () => {},
  };
  if (typeof ctx.settings?.installSection === "function") {
    ctx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, normalizeConfig(config), hooks);
  } else {
    const scope = ctx.settings.register(SETTINGS_NAMESPACE, Config, { base: normalizeConfig(config) });
    hooks.setSource(() => scope.get());
  }

  // 2) 临时视觉子会话的清理：**机制**在 dsh-workspace-manager 发布的 `sessionRemoval`
  //    宿主服务里（它内部是已经测过的文件级删除），这里只提供**策略**——哪些 id 是我起的、
  //    什么时候算完事。服务缺席时优雅降级：视觉功能照常，只是不清理（最多一条日志）。
  const ledger = openLedger({ logger: ctx.logger });
  const sessionCleanup = createSessionReaper({ ctx, ledger, logger: ctx.logger });

  // 3) 工具：全局注册，所有 preset 的会话都能看到 `subagent_vision`。
  ctx.effect(
    () =>
      ctx.tools.register(
        createVisionTool({
          readStatus,
          readConfig,
          subagents: ctx.subagents,
          attachments: ctx.attachments,
          readSessionImages,
          isProviderAvailable,
          provider: PROVIDER_NAME,
          toolName: TOOL_NAME,
          sessionCleanup,
        })
      ),
    "dsh-vision-delegate: tool"
  );

  // 4) 守卫：**只拦 `subagent_vision`**（兜住"别的 preset 也注册了同名工具"的情况）。
  //    `ctx.tools.guard` 是全局守卫，工具名判断写在 createRefusalGuard 的第一行——
  //    漏掉它会在未配置时拒绝所有工具调用（现场踩过，见该函数的注释与回归测试）。
  ctx.effect(() => ctx.tools.guard(createRefusalGuard(readStatus, TOOL_NAME)), "dsh-vision-delegate: guard");

  // 5) 附加图片桥（纯插件，不改官方 bundle）：让"模型不支持图片"的附件能进来（能力垫片），
  //    本轮附图时给主模型注入"先调 subagent_vision"的指令，并把本轮的图片 ref 记进会话暂存，
  //    好让工具把**只有图片 + 问题**交给视觉子代理（历史与工具一个字节都不外发）。
  //    早期版本走的是"整体重定向"（整段历史转发给视觉模型），已废弃——2026-09-21 的事故：
  //    60 万 tokens 的历史发给 40 万窗口的视觉模型，本机网关不报错也不返回内容 → 界面卡住。
  const originalResolveModelInfo =
    typeof ctx.llm?.resolveModelInfo === "function" ? ctx.llm.resolveModelInfo.bind(ctx.llm) : void 0;
  // 垫片会把目录里每个模型都报成"能收图"（前端附件闸门需要），所以卡片候选清单必须留一份
  // **未被垫片包过**的 listModels，否则候选会全被标成 image=true，把用户引向收不到图的模型。
  const originalListModels = typeof ctx.llm?.listModels === "function" ? ctx.llm.listModels.bind(ctx.llm) : void 0;
  ctx.effect(
    () => installModelInfoShim(ctx.llm, () => isConfigured(readConfig())),
    "dsh-vision-delegate: model-info shim"
  );
  ctx.effect(
    () =>
      ctx.on(
        "llm/stream",
        createVisionBridge({
          llm: ctx.llm,
          readStatus,
          readConfig,
          resolveModelInfo: originalResolveModelInfo,
          recordTurnImages,
        })
      ),
    "dsh-vision-delegate: llm bridge"
  );

  // 6) 设置卡片 / composer 开关用的读写路由。
  const writeConfig = async (patch) => {
    const merged = { ...readConfig() };
    const ops = [];
    for (const field of CONFIG_FIELDS) {
      if (patch?.[field] === void 0) continue;
      merged[field] = patch[field];
      ops.push({ op: "set", path: [field], value: patch[field] });
    }
    if (ops.length === 0) throw new Error("没有要保存的字段");
    validateConfig(merged); // 先在本地给出更清楚的中文报错，再交给官方 schema
    await ctx.settings.mutate(SETTINGS_NAMESPACE, ops);
  };

  const payload = (sessionId) => ({
    build: "trace-6",
    ...statusPayload({ status: readStatus(sessionId), config: readConfig(), toolName: TOOL_NAME }),
    providerAvailable: isProviderAvailable(),
    provider: readConfig().provider,
    sessionOverride:
      typeof sessionId === "string" && sessionId !== "" && sessionOverrides.has(sessionId)
        ? sessionOverrides.get(sessionId) === true
        : null,
    modelsUrl: modelsPath,
  });

  const statusRoute = async (req, res) => {
    const method = req?.method ?? "GET";
    const sessionId = sessionIdOf(req, statusPath);
    try {
      if (method === "POST" || method === "PUT") {
        const body = await readJsonBody(req);
        const session = typeof body?.session === "string" && body.session !== "" ? body.session : sessionId;
        if (body?.patch !== void 0 && body.patch !== null && typeof body.patch === "object") {
          await writeConfig(body.patch);
        }
        if (body?.resetSession === true && typeof session === "string" && session !== "") {
          sessionOverrides.delete(session);
        } else if (typeof body?.enabled === "boolean" && typeof session === "string" && session !== "") {
          sessionOverrides.set(session, body.enabled);
        }
        respond(res, 200, payload(typeof session === "string" ? session : void 0));
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        respond(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支持 GET / HEAD / POST" } });
        return;
      }
      respond(res, 200, payload(sessionId), method === "HEAD");
    } catch (error) {
      respond(res, 400, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const modelsRoute = async (req, res) => {
    const method = req?.method ?? "GET";
    try {
      if (method !== "GET" && method !== "HEAD") {
        respond(res, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "只支持 GET / HEAD" } });
        return;
      }
      const candidates = await listCandidates(ctx, { listModels: originalListModels });
      const current_ = readConfig();
      respond(
        res,
        200,
        {
          ok: true,
          candidates,
          current: { provider: current_.provider, model: current_.model },
          currentUsable: candidateIsUsable(candidates, current_.provider, current_.model),
        },
        method === "HEAD"
      );
    } catch (error) {
      respond(res, 500, {
        ok: false,
        error: { code: "CANDIDATES_FAILED", message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: statusPath, handler: statusRoute }),
    "dsh-vision-delegate: status route"
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: modelsPath, handler: modelsRoute }),
    "dsh-vision-delegate: models route"
  );

  // 7) 启动补删：把**上次没清干净**的自己的临时会话（崩溃/异常退出留下的孤儿）收掉。
  //    用 `ctx.inject([服务名], …)` 而不是直接调用：workspace-manager 可能比本插件晚就绪
  //    （loader 顺序不确定），服务出现的那一刻回调才会触发；服务永远不出现也不影响视觉功能
  //    （账本原样保留，装上之后下次启动补删）。不做定时器式全盘扫描。
  const runStartupSweep = () => {
    void sessionCleanup.sweep().catch(() => {
      /* sweep 内部已吞掉所有错误，这里只是兜底 */
    });
  };
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject([SESSION_REMOVAL_SERVICE], () => runStartupSweep());
    } catch {
      runStartupSweep();
    }
  } else {
    runStartupSweep();
  }

  ctx.logger?.info?.(
    "dsh-vision-delegate: 工具 %s 已注册（provider %s），路由 %s、%s",
    TOOL_NAME,
    PROVIDER_NAME,
    statusPath,
    modelsPath
  );
}
