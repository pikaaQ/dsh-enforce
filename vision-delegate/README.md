# dsh-vision-delegate

把「视觉委派」做成**宿主能力**的 DSH 插件：任何 preset 的会话都有 `subagent_vision` 工具，
composer 右下角有一个**每会话**的「视觉」开关，视觉大模型在 **设置 → 插件 → 插件配置 → 「视觉委派」卡片**里选。

本仓库里的视觉委派**只有这一份实现**（历史沿革见 `..\CHANGELOG.md`）。


## 三条硬规则

1. **能力在插件里**：host 半区 `ctx.tools.register()` 注册 `subagent_vision`（全局）——不再依赖某个 preset 的
   `tool-subagent` 行，所以 `standard`/`ptc`/`minimal`/`cordis` 的会话都能用，开关也才在每个会话都成立。
2. **模型必须显式配置，没有兜底**：不跟随官方 `subagent-model-selection`，也不跟随父会话模型。
   provider/model 为空 = **未配置**：开关点不动（点击就地提示去配置），工具调用直接返回同一条可执行指令。
3. **不热插拔工具目录**：开关只门控**行为**——`ctx.tools.guard()` 在调用时拒绝，工具始终留在目录里
   （贴合 harness "会话内工具目录稳定"的取向）。

## 三个状态

| 状态 | 条件 | composer 开关 | 调用 `subagent_vision` |
|---|---|---|---|
| 未配置 | provider/model 任一为空 | 「视觉 未配置」（虚线），点击**不切换**、弹提示 | 抛错：`视觉委派未配置：请先在 设置 → 插件 → 插件配置 → 「视觉委派」卡片里选择视觉模型（provider + model）…` |
| 已关闭 | 已配置，本会话有效值 = 关 | 「视觉 关」（划线），点击打开本会话 | 抛错：`视觉委派已关闭：请点 composer 输入框右下角的「视觉」开关…` |
| 自动 | 已配置，本会话有效值 = 开 | 「视觉 自动」，点击关闭本会话 | 起一个 `spawn` 子代理（全新上下文、模型已 pin 成上面选的视觉模型）并返回结论 |

- **唯一的运行时开关是胶囊**：是否调用视觉模型**只看本会话胶囊的状态**（有会话覆盖就用会话值，没有才回落配置默认）。
  卡片里的「新会话默认打开胶囊」只决定**新会话初始**的胶囊状态，等同于 `Shift+点击` 胶囊写下去的值；
  把它设成"关"**不会**阻止你在任一会话里点开胶囊。
- 配置改动**无需重启**：官方 `installSection` 的 `setSource` 回调让新值在当前进程立刻生效。

## 构成

| 文件 | 作用 |
|---|---|
| `lib/config.js` | settings 命名空间 `vision-delegate` 的 schema/校验、三态判定、**守卫构造** `createRefusalGuard` |
| `lib/candidates.js` | 视觉模型候选：`llm.listProviders()`+`listModels()`（带 `inputModalities`）与 settings `llm-pi-ai` 快照合并去重 |
| `lib/tool.js` | `subagent_vision` 工具：描述、参数、`execute`（三条图片来源 → image block → `subagents.start('spawn', { …, persona, toolFilter, maxDepth })`）、渲染；跑完把子会话 id 交给清理器（并把**本会话 id** 作为父会话指针一起登记） |
| `lib/index.js` | apply：注册命名空间 + 工具 + 守卫 + 会话图片暂存 + `/vision-delegate`、`/vision-delegate/models` 路由 + 启动补删（临时会话清理） |
| `lib/session-cleanup.js` | 临时子会话清理**策略**：账本（`$DSH_HOME/dsh-vision-delegate.state.json`）、完成即删、启动补删、**父会话登记**（`claim(owner, ids, { parentSessionId })`）、对 `sessionRemoval` 服务的**探测式获取**与优雅降级 |
| `lib/client.js` | composer 三态开关（`conversation.input.right`）+ 「插件配置」页卡片（`settings.plugin.item`，自带卡片外壳） |
| `lib/trace.js` | **临时诊断探针**（排查"附图片后卡住/委派链"用）：把桥的每个阶段与每次出网请求写成 JSONL 到 `$DSH_HOME/vision-delegate-trace.log`。确认稳定后**整份删掉**（连同 `bridge.js`/`index.js` 里的 `trace(...)` 调用） |
| `test/*.test.mjs` | 76 项离线测试（`apply()` 接线、"守卫不得拦别的工具"、"只拦本轮新附的图"（含宿主注入消息 / 失败轮次 / 同 rpcId 拆分三种回归）、"注入提示仍走原 provider/model"、"工具自动吃会话附件"、"子代理的 persona + toolFilter + maxDepth"、"临时会话完成即删 + 启动补删 + 服务缺席时优雅降级"、**"登记时带上父会话 id"（工具 → 清理器 → 服务三层都验）**） |

零额外运行时依赖（只用 node 内置模块 + `@deepseek-ai/schemastery` 做设置 schema）。

## 临时子会话的清理（**依赖 dsh-workspace-manager**）

每次视觉委派都会 spawn 一个**全新会话**的子代理，而 DSH 内核**没有删除会话的 API**
（`dsh-session-persistence` 只有 create/open/stat/list/flush，官方 session RPC 里也没有删除动词），
所以这些临时会话会永久留在 `$DSH_HOME/sessions/<项目键>/<会话id>/` 里。

> **依赖声明**：本插件把删除交给 **`dsh-workspace-manager`** 发布的宿主服务 `sessionRemoval`
> （`ctx.provide('sessionRemoval', …)`，内部是它已经测过的文件级删除）。
> **本插件自己不删文件、也不自己拼路径。** 没装 workspace-manager 时视觉功能**照常可用**，
> 只是不清理：启动时最多记一条日志，账本原样保留，装上之后下次启动补删。

分工：**机制**在 workspace-manager（怎么安全地删），**策略**在本插件（哪些 id 是我起的、什么时候算完事）。

- **完成即删**：`subagents.start()` 一返回就拿到子会话 id（官方契约：本地 run 的 `run.id`
  **就是**已发布的子会话 id，`dsh-subagent/lib/types/types.d.ts:292-298`），**先落账**、
  再在服务里登记归属（`claim`）；子代理跑完（`run.dispose()` 之后，无论成败）立刻把它交给
  服务的 `remove(id, { owner: 'dsh-vision-delegate' })`。
- **顺带登记父会话**：`claim` 时会带上**发起这次委派的会话 id**（`agent.id`，即
  `parentSessionId`）。这是 workspace-manager「会话树」唯一的父子来源 —— 内核没有这份数据
  （子会话的投影缓存里没有指回父的字段），所以不带父指针的话，设置页就不会把这个视觉子会话
  挂在主会话下面，删主会话时也不会连带它。拿不到父（`agent` 没有 id）时照常登记，只是父未知。
  注意：`sessionRemoval` 的 `claim` 自 **服务面 v2** 起是**异步**的（父子关系要落盘才能跨重启
  成立），这里显式 `await`；就算 `await` 失败也只影响登记，不影响删除与结论。
- **启动补删**：账本里"上次没清干净"的 id 在插件启动时逐个补删（崩溃/异常退出会留下孤儿）。
  补删用 `ctx.inject(['sessionRemoval'], …)` 挂：workspace-manager 可能比本插件晚就绪，
  服务出现的那一刻回调才触发。**服务名不写进模块级 `inject`** —— 那会在对方缺席时把整行 parked，
  视觉功能会一起消失。补删路径重新登记时**不带父**，因此**不会**抹掉第一次记下的父指针
  （服务面 v2 的幂等语义：`parentSessionId` 只在显式给出时改写）。
- **不做定时器式全盘扫描**：删除永远由一个具体的 id 驱动。
- **绝不打断委派**：清理是附加能力——服务缺失 / 抛错 / 账本写坏都只影响清理，结论照常返回。

账本（`lib/session-cleanup.js`，落盘是原子的：临时文件 + fsync + rename）：

```jsonc
// $DSH_HOME/dsh-vision-delegate.state.json
{ "version": 1, "pendingSessionIds": ["<子会话 id>", "..."] }
```

结局分类：`session-not-found` 当作"已清理"（划账、不报错）；`session-active`（子会话还没静默）
等失败**保留在账本里**，下次启动再试；`not-claimed`（登记在别的 owner 名下）只划自己的账、
不碰磁盘。**崩溃窗口**：id 在 `subagents.start()` 返回之后才拿得到，所以"start 成功但落账前进程就死"
这一个瞬间仍会漏掉一个孤儿（无法避免：内核不告诉我们它建过哪些会话）。

> 实现上有两个容易重犯的坑——**全局守卫必须只拦目标工具**（写漏工具名会拒绝所有工具调用，
> 把自己锁死）、**「插件配置」页卡片必须 generator + `yield` 注册同 key**；
> 根因、现场与回归用例见 [`../TECH-NOTES.md`](../TECH-NOTES.md) §1.3 / §1.4。

## 安装

两种挂法**二选一**（同 id 出现两次会在冷启动报 `duplicate loader entry id`）。

**① patch 层（本机用法，与 `dsh-turing-balance` 同层）**——在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾：

```yaml
- insert:
    - id: vision-delegate
      name: dsh-vision-delegate
```

并把包 junction 进 profile 的 `node_modules`：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-vision-delegate" `
  -Target "E:\JavaScript\dsh-enforce\vision-delegate"
# schemastery 从仓库内既有副本复用（内网 registry 不可达时）
New-Item -ItemType Directory -Force "$repo\vision-delegate\node_modules\@deepseek-ai" | Out-Null
New-Item -ItemType Junction -Path "$repo\vision-delegate\node_modules\@deepseek-ai\schemastery" `
  -Target "E:\JavaScript\dsh-enforce\turing-balance\node_modules\@deepseek-ai\schemastery"
```

**② bundle 层**：把 `dsh-vision-delegate` 加进 `profiles/web/package.json` 的 `dsh.profile.bundles`
（本包自带 `cordis.patch.yml`；`dsh plugin --profile web add <本目录>` 亦可）。

> **生效时机**：patch 层的**新增**条目要**重启一次 dsh web** 才会加载（后续改动才走热监听）；
> 之后 client 半区（开关/卡片）改动刷新页面即最新，host 半区改动仍需重启。

`cd vision-delegate; npm test` 跑离线测试（76 项，不联网）。

## 验证

```powershell
# 状态（未配置时 status=unconfigured）
curl.exe -s "http://127.0.0.1:3080/vision-delegate"
# 候选模型（image=true 表示声明了 input: [text, image]）
curl.exe -s "http://127.0.0.1:3080/vision-delegate/models"
# 配置（也可以直接在设置卡片里点）
curl.exe -s -X POST -H "content-type: application/json" -d '{\"patch\":{\"provider\":\"tcl1\",\"model\":\"deepseek-v4-flash-vision-exp\",\"enabled\":true}}' http://127.0.0.1:3080/vision-delegate
```

端到端：刷新页面 → composer 右下角出现「视觉 未配置」；在 **设置 → 插件 → 插件配置 → 「视觉委派」卡片**里选好模型并勾选启用 →
开关变成「视觉 自动」；在一个**没有**视觉行的 preset（如 `standard`）的新会话里让它分析一张真图 → 模型调用
`subagent_vision` → 视觉子代理返回结论；关掉开关后同样操作被拒绝且理由可读。

## 卸载

1. 删掉 `profiles/web/cordis.patch.yml` 里的那段 `- insert:`（或从 `dsh.profile.bundles` 移除）；
2. 删 `profiles/web/node_modules/dsh-vision-delegate` junction；
3. 可选：删 `settings.yaml` 里的 `vision-delegate:` 段（配置）；
4. 重启 dsh web。

## 附加图片桥（**纯插件，不改官方 bundle**）

用户像平常一样在 composer 里**附加图片**也能用：图片不进主模型、不要求用户贴路径，
而且**只有图片会被送进视觉子代理**——会话历史与工具表一个字节都不外发。

**卡点**：官方会话控制器在提交提示词时用 `llm.resolveModelInfo(...).inputModalities` 判定"模型不支持图片"，
直接拒绝附件（`dsh-api-session-controller/lib/index.js:761-765`，`MODEL_DOES_NOT_SUPPORT_IMAGES`）——
消息根本不会创建。那是一段普通 `if`，没有任何插件接缝。

**桥的三个动作**（`lib/bridge.js`）：

1. **模型能力垫片**：只要**配置了视觉模型**，就把该模型的能力报告成"包含 image"（同时包 `resolveModelInfo` 与
   `listModels`，让控制器与前端目录都放行附件）。消息因此得以创建、`image block` 留在会话里。
   *注意：垫片只改"能力报告"，不改任何磁盘/网络行为；插件停用或卸载时会精确还原（`ctx.effect` 的 disposer）。*
   *代价：`listModels` 因此把每个模型都报成能收图，所以卡片自己的候选清单另留一份**未被垫片包过**的
   `llm.listModels`（见 `lib/candidates.js`），否则用户会被引向一个收不到图的"视觉模型"。*
2. **给主模型注入指令**：`llm/stream` 是官方文档明确的可拦截瀑布。当**本轮**带了新图、而目标模型不能看图时，
   桥在**最后一条用户角色的消息**后面追加一条指令（`withVisionHint`）：

   > 本轮用户直接附带了 N 张图片，但当前模型不支持图片输入——你只看到占位符。请**先调用 subagent_vision**
   > （不要传 images / image_data，它会自动带上本轮附件）取回图片内容，再据此回答用户。

   然后**用原来的 provider/model 再发一次调用**（`llm.stream({ ...options, messages: 追加了提示的那份 })`）。
   路由不变 → 历史与工具不外发；图片块原样保留，由官方按"文本模型"投影成占位符
   （`projectImagesForTextModel`）。桥用**原始** `resolveModelInfo` 判定真实能力，不会被自己的垫片骗到。
3. **会话暂存**：本轮图片的 attachment ref 记进内存映射（`sessionId → refs`，30 分钟 TTL）。
   `subagent_vision` 在**没给** `images`/`image_data` 时自动取它——所以子代理只拿到
   **图片 + 主模型写的问题**（`spawn`，全新上下文、不继承历史），字节不落盘、路径不外传。
   子代理的结论作为 **tool result** 落进会话日志 → **后续轮次依然看得到**。

**只在"本轮带了新图"时介入**（`turnNeedsVision`）：两条规则叠加——

1. **先筛掉宿主注入的上下文**：注入消息同样是 `role: 'user'`，但带**来源标记**
   （`@deepseek-ai/dsh-llm` 的 `MessageSourceMap`：真实用户发言 `kind: 'user'`；注入是 `plugin` /
   `model` / `tool` 以及插件自加的 `agent-instructions`(AGENTS.md) / `skill-catalog`(技能目录) /
   `session-reference` …，该联合类型 merge-extensible）。判定按"不是 `'user'` 就不算用户发言"，
   而不是枚举注入种类。扫描时跳过工具结果消息（官方 `createToolResultMessage` 也是 `role: 'user'`）。
2. **助手消息是"更早轮次"的边界**：同一轮里助手已经答过（tool-call/tool-result 之后）就不再注入。
3. **在筛完注入之后的列表里，取最新一条用户发言看它带不带图**。**顺序很重要**：先按 `source.kind`
   过滤、再取最新一条——所以注入消息再新也当不上"最新一条用户发言"，第 1 条与第 3 条不会互相打架。
   为什么不能拿"有没有助手消息"当"这张图是否已处理"：**一轮失败时不留下助手消息**（例如开关关着被拒），
   那样这张图会被永远当成"本轮新图"，之后每一轮（哪怕纯文本）都继续报"视觉委派已关闭"，
   除非用户先把它"处理掉"。另：只有"同一次提交被拆成多条消息"（同 `source.rpcId`）时，
   才把更早那条带图的发言也算作本轮。

**只拦主调用**：带 `purpose` 的是辅助调用——`session-title`（生成标题）与 `compaction`（压缩历史），
它们的请求里同样带着整段历史（含那张图），拦下来只会把视觉提示混进标题/摘要提示词。

**图片暂存每轮刷新**：本轮带图 → 记本轮那张；本轮不带图但请求里仍有图 → 记"最近出现过的那张"
（刷新 TTL，并给"某轮漏记"兜底：附过一次图之后再说"看一下那张图"仍能用）。
暂存按 **session id** 记（= `exec.agent.id`：agent 注册表就是按 session id 索引的，
`dsh-agent-loop` 里 `ownerCtx.agents.get(sessionId)`）。

**子代理拿到自己的系统提示词，并且不能再委派**（`lib/tool.js` 的 `spawn` 请求）：

| 层 | 手段 | 性质 |
|---|---|---|
| 软 | `persona: SUBAGENT_PERSONA` —— 官方用 `systemPrompt.section({name:'deployment:persona-prefix'})` **遮蔽**父会话那套前缀，只作用于子会话。角色语义：**它就是看图的那一个**——给了附件就直接看（别去找文件）；只给了路径就按路径去读；都没有/读不出来就**把原因回报调用方**（不委派、不猜）。顺带把 Windows 纪律那一大段换掉，system prompt 更小、出字更快 | 指令遵循 |
| 硬 | `toolFilter: { deny: ["subagent_vision"] }` —— 子代理的工具目录里**根本没有**这个工具 | 结构性 |
| 硬 | `maxDepth: 父会话深度 + 1` —— 孙代委派的深度超限，harness 用 `SubagentDepthError` 直接拒 | 结构性 |
| 硬 | **不给子会话授"视觉已开"** —— 子会话回落到配置默认（多是关），它若要再调工具会被守卫按"视觉委派已关闭"拒掉 | 状态 |

**体验**：主模型不能看图的会话里，附图的轮次是「主模型写问题 → 视觉子代理看图 → 主模型据此回答（可继续用工具改代码）」；
不附图片的轮次照旧走主模型。会话开关关掉时，附图片发送会得到明确提示（打开开关 / 先切到视觉模型），
而不是一句底层适配器报错。

> **为什么"追加提示"要自己再发一次调用，而不是改写后交给 `next()`**：瀑布的 `next()` 是闭包
> `() => (cbs.shift() ?? inner)(...args)`——不吃参数、永远转发最初那份 options；而 agent-loop 构造的
> request 是 `Object.freeze` + 消息 `deepFreeze`（官方契约：listeners *read it, never rewrite it*）。
> 只有"自己再发一次调用"才能让主模型看到提示。那份被注入过的 options 记在模块级 `WeakSet` 里，
> 嵌套那一次直接放行（认对象身份，不用全局深度计数——不同会话是并发的）。

> 图文桥的设计要点（超窗网关的行为、只拦本轮新附图、宿主注入消息、委派链护栏）见
> [`../TECH-NOTES.md`](../TECH-NOTES.md) 第 2 节；事故经过见 [`../CHANGELOG.md`](../CHANGELOG.md)。

## 边界

- 开关是**每会话**语义；无"打开设置面板"的官方 API，所以未配置时的提示是就地文案 + 工具错误，不能自动跳转。
- 工具面向**全部** preset。若日后只想给部分 preset，加一层 `agentPresets.composedPreset(agentCtx)` 白名单即可。
- 视觉模型必须声明 `input: [text, image]`：卡片对未声明的模型标灰并警告，调用前再校验一次，绝不 spawn 收不到图的子代理。
- 依赖 `tools` / `subagents` / `settings` / `webServer` / `attachments` / `llm` 六个宿主服务（模块级 `inject`，缺一不可；
  `llm` 是附加图片桥用的，见上文「附加图片桥」）
  → 面向 **web profile**；headless/TUI 没有 `webServer`，整行不会激活（要那样用，得把路由那一段拆成独立子路径行，
  官方 `…/model-selection-settings` 就是这种写法）。
- **可选依赖 `sessionRemoval`（`dsh-workspace-manager` 发布）**：用来清理自己 spawn 出来的临时视觉子会话，
  并**登记父会话**（`claim(owner, ids, { parentSessionId })`，服务面 v2 起为异步）。
  缺席时**优雅降级**（视觉功能照常，只是不清理、也不登记父子关系，见上文「临时子会话的清理」）；
  因此它**不在**模块级 `inject` 里，而是 `ctx.get('sessionRemoval')` 探测 + `ctx.inject([...], …)` 等就绪。
- **图片怎么过去（关键）**：三条来源都变成同一个东西——子代理 prompt 里的 **image block**：
  ① 用户直接附加的图（桥记进会话暂存，工具不带参数时自动用，**直接复用已有 durable ref**，不重存字节）；
  ② `images` 绝对路径（插件自己读字节 → `attachments.saveImages`）；
  ③ `image_data` 内联规范 base64（同上）。
  子代理拿到的就是图片本身：**不需要 `read_image`、拿不到任何文件路径**；`spawn` 子代理**不继承会话历史**
  （`inheritsParentContext = false`），所以长会话也只发"图片 + 问题"。
  **"要不要找文件"由图片怎么给决定**：给了附件就别去找；只给了路径（调用方把路径写在 `prompt` 里）
  就按路径去读；都没有/读不出来就把原因回报调用方——这条写进了子代理自己的 persona。
- **前置**：宿主必须注册 `spawn` 这个 subagent provider（`@deepseek-ai/dsh-subagent-spawn-in-process`）；
  `/vision-delegate` 的 `providerAvailable` 会如实反映这一状态（`$DSH_HOME\cordis.patch.yml` 里若把它
  `disabled: true`，路由与卡片都会显示 `unavailable` 并给出原因）。
