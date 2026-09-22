// dsh-vision-delegate — 视觉模型候选清单
//
// 两个官方来源，合并去重（优先带 inputModalities 的实时目录）：
//   1. `ctx.llm.listProviders()` + 每个 route 的 `listModels(provider)` ——
//      dsh-llm-pi-ai 的 listModels 返回 [{ provider, id, name, inputModalities: [...] }]，
//      其中 inputModalities 直接告诉我们这个模型能不能收图；
//   2. settings 里的 `llm-pi-ai.providers.<route>.models[]`（`{ id, name, input }`）——
//      兜底，覆盖 "llm 服务没暴露 listModels" 的部署。
//
// 卡片用这份清单渲染下拉；`image: true` 的排在前面，`image: false` 的标灰+警告
// （选了也能保存，但调用时会再校验一次并直接报错，绝不 spawn 一个收不到图的子代理）。

function modalitiesOf(entry) {
  if (Array.isArray(entry?.inputModalities)) return entry.inputModalities;
  if (Array.isArray(entry?.input)) return entry.input;
  return [];
}

/** 声明了正整数窗口时带上（超窗预检的兜底建议要用它）。 */
function contextWindowOf(entry) {
  const value = entry?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}

export function declaresImage(entry) {
  return modalitiesOf(entry).includes("image");
}

export function candidateKey(row) {
  return `${row.provider}\u0000${row.model}`;
}

function pushRow(rows, row, overwrite) {
  const key = candidateKey(row);
  const existing = rows.get(key);
  if (existing === void 0) {
    rows.set(key, row);
    return;
  }
  if (!overwrite) return;
  // 实时目录优先（名字/模态更权威），但**补齐**它没有的声明窗口：
  // llm 服务的 listModels 不带 contextWindow，而超窗预检的建议要用它。
  const merged = { ...existing };
  let changed = false;
  if (row.image === true && existing.image !== true) {
    merged.image = true;
    changed = true;
  }
  if (merged.contextWindow === void 0 && row.contextWindow !== void 0) {
    merged.contextWindow = row.contextWindow;
    changed = true;
  }
  if (changed) rows.set(key, merged);
}

/** settings 快照 → 候选（纯粹函数，便于离线测试）。 */
export function candidatesFromSettings(snapshot) {
  const rows = new Map();
  const providers = snapshot?.providers;
  if (providers === null || typeof providers !== "object") return [];
  for (const [provider, profile] of Object.entries(providers)) {
    const models = Array.isArray(profile?.models) ? profile.models : [];
    for (const model of models) {
      if (typeof model?.id !== "string" || model.id === "") continue;
      pushRow(
        rows,
        {
          provider,
          model: model.id,
          name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
          image: declaresImage(model),
          ...contextWindowOf(model) === void 0 ? {} : { contextWindow: contextWindowOf(model) },
        },
        false
      );
    }
  }
  return [...rows.values()];
}

/** llm 服务结果 → 候选（纯粹函数，便于离线测试）。 */
export function candidatesFromProviderList(providers, modelsOf) {
  const rows = new Map();
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = typeof provider?.id === "string" ? provider.id : "";
    if (id === "") continue;
    for (const model of Array.isArray(modelsOf?.(id)) ? modelsOf(id) : []) {
      const modelId = typeof model?.id === "string" ? model.id : "";
      if (modelId === "") continue;
      pushRow(
        rows,
        {
          provider: id,
          model: modelId,
          name: typeof model.name === "string" && model.name !== "" ? model.name : modelId,
          providerName: typeof provider.name === "string" && provider.name !== "" ? provider.name : id,
          image: declaresImage(model),
          ...contextWindowOf(model) === void 0 ? {} : { contextWindow: contextWindowOf(model) },
        },
        true
      );
    }
  }
  return [...rows.values()];
}

export function mergeCandidates(primary, fallback) {
  const rows = new Map();
  for (const row of [...(primary ?? []), ...(fallback ?? [])]) pushRow(rows, row, true);
  return [...rows.values()].sort((left, right) => {
    if (left.image !== right.image) return left.image ? -1 : 1;
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
    return left.model < right.model ? -1 : left.model > right.model ? 1 : 0;
  });
}

/**
 * 运行期入口：能拿到的官方来源都试一遍，任何一个失败都不影响另一个。
 *
 * @param options.listModels 可选：**未被垫片包过**的原始 `llm.listModels`。
 *   插件自己的能力垫片会把目录里每个模型都报成"能收图"，那是给前端附件闸门用的；
 *   卡片自己的候选清单必须看**真实**模态，否则用户会被引导去选一个收不到图的模型。
 */
export async function listCandidates(ctx, options = {}) {
  let live = [];
  let fromSettings = [];
  try {
    const llm = ctx.get?.("llm");
    const modelsOf =
      typeof options.listModels === "function"
        ? options.listModels
        : (provider) => llm?.listModels?.(provider);
    if (typeof llm?.listProviders === "function") {
      const providers = await llm.listProviders();
      const rows = [];
      for (const provider of Array.isArray(providers) ? providers : []) {
        const id = typeof provider?.id === "string" ? provider.id : "";
        if (id === "") continue;
        let models = [];
        try {
          // 注意：官方 `llm.listModels()` 是 async（返回 Promise）——必须 await，否则会静默拿到空列表。
          const maybe = await modelsOf(id);
          if (Array.isArray(maybe)) models = maybe;
        } catch {
          models = [];
        }
        rows.push(...candidatesFromProviderList([provider], () => models));
      }
      live = rows;
    }
  } catch {
    live = [];
  }
  try {
    const snapshot = ctx.get?.("settings")?.get?.("llm-pi-ai");
    fromSettings = candidatesFromSettings(snapshot);
  } catch {
    fromSettings = [];
  }
  return mergeCandidates(live, fromSettings);
}

/** 某个 route 是否声明了图片输入（用于调用前校验）。 */
export function candidateIsUsable(candidates, provider, model) {
  const row = (candidates ?? []).find((item) => item.provider === provider && item.model === model);
  if (row === void 0) return { found: false, image: false };
  return { found: true, image: row.image === true };
}
