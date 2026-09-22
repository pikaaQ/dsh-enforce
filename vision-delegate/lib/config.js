// dsh-vision-delegate — 配置层
//
// 唯一权威来源是官方 settings 命名空间 `vision-delegate:`（落盘 settings.yaml），
// 由本插件的设置卡片编辑；本会话开关只做内存覆盖（不落盘，新会话回落配置默认）。
//
// 硬规则：视觉模型必须由用户显式配置。未配置 → 状态 `unconfigured`：
// 开关不可开、点开关给提示、工具调用直接返回可执行错误。**没有**任何隐式兜底
// （不跟随官方 subagent-model-selection，也不跟随父会话模型）。

import z from "@deepseek-ai/schemastery";

/** 官方 settings 命名空间（也决定"设置 → 插件 → 插件配置"里卡片的分发 key）。 */
export const SETTINGS_NAMESPACE = "vision-delegate";
/** 对模型暴露的工具名（保持与既有文档/提示词兼容）。 */
export const TOOL_NAME = "subagent_vision";
/** 委派子代理使用的 provider 名（`dsh-subagent-spawn-in-process` 注册的 `spawn`）。
 *  用 spawn 而不是 fork：**全新上下文**（不继承会话历史），且同样支持 agentOptions 固定视觉模型。 */
export const SUBAGENT_PROVIDER = "spawn";

export const DEFAULT_CONFIG = { enabled: false, provider: "", model: "" };

/** 设置段 schema：官方 installSection 用它校验，超范围/类型错误在保存时被拒。 */
export const Config = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default(""),
  model: z.string().default(""),
});

export const UNCONFIGURED_MESSAGE =
  "视觉委派未配置：请先在 设置 → 插件 → 插件配置 → 「视觉委派」卡片里选择视觉模型（provider + model），" +
  "选好之后 composer 的「视觉」开关才能打开。";

export const DISABLED_MESSAGE =
  "视觉委派已关闭：请点 composer 输入框右下角的「视觉」开关打开它，或先用支持图片输入的模型直接看图。";

export function normalizeConfig(value) {
  const raw = value ?? {};
  return {
    enabled: raw.enabled === true,
    provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
  };
}

export function isConfigured(value) {
  const config = normalizeConfig(value);
  return config.provider !== "" && config.model !== "";
}

/**
 * 官方 settings 保存时调用的校验（镜像 dsh-tool-subagent 的 model-selection-settings）：
 * 启用必须有模型，否则拒绝保存。
 */
export function validateConfig(value) {
  const config = normalizeConfig(value);
  if (config.enabled && !isConfigured(config)) {
    throw new Error("视觉委派：启用之前必须先选择视觉模型（provider + model）。");
  }
}

/** 有效状态：unconfigured | off | on。会话覆盖仅在已配置时有意义。 */
export function statusOf(value, sessionOverride) {
  const config = normalizeConfig(value);
  if (!isConfigured(config)) return "unconfigured";
  const on = sessionOverride === undefined ? config.enabled : sessionOverride === true;
  return on ? "on" : "off";
}

/** 拒绝理由：`on` 之外的两种状态各给一条可执行提示；`on` 返回 undefined（放行）。 */
export function refusalFor(status) {
  if (status === "unconfigured") return UNCONFIGURED_MESSAGE;
  if (status === "off") return DISABLED_MESSAGE;
  return void 0;
}

/** 把状态整理成 route / client 共用的载荷（文案同源，避免三处不一致）。 */
export function statusPayload({ status, config, toolName = TOOL_NAME }) {
  const normalized = normalizeConfig(config);
  return {
    ok: true,
    status,
    tool: toolName,
    enabled: normalized.enabled === true,
    provider: normalized.provider,
    model: normalized.model,
    hint: refusalFor(status) ?? "",
  };
}

/**
 * 构造"调用时守卫"。
 *
 * ⚠️ 第一条语句就必须把**非目标工具**放行：`ctx.tools.guard` 注册的是**全局**守卫，
 * 漏掉这个判断会在"未配置/已关闭"时拒绝**所有**工具调用（连 read/write/pwsh 都被拦，
 * 现场把自己锁死过一次）。test/host.test.mjs 里有对应的回归用例。
 *
 * 判定失败时 fail-open：守卫自身出错不能把 agent 卡死。
 */
export function createRefusalGuard(readStatus, toolName = TOOL_NAME) {
  return function visionDelegateGuard(execution) {
    if (execution?.name !== toolName) return void 0;
    try {
      return refusalFor(readStatus(execution?.agent?.id));
    } catch {
      return void 0;
    }
  };
}
