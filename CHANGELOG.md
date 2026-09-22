# 变更履历（CHANGELOG）

> **本文件是 dsh-enforce 唯一的变更履历。** 仓库级改动、各插件的版本演进、退役与删除记录、
> 线上事故与修复记录都写在这里；各插件的 `README.md` 只描述**当前状态**
> （装了什么、怎么装、怎么用、边界在哪），不再各自维护一份历史。
>
> 变更履历原先分散在四处，已于 **2026-09-22** 全部迁入本文件：
> 根 `README.md` 的「变更历史」整节、`turing-web-search\README.md` 的「本机历史」与
> 「会话历史加载失败修复」、`vision-delegate\README.md` 的两条事故记录。

**约定**

- **时间倒序**：最新在最上面；同一日期内按「仓库级 → 各插件」排列。
- 删除与退役的东西**保留在履历里**：写清楚何时删、为什么删、替代物是什么——
  不要从文档里悄悄抹掉（读者需要知道"为什么这里少了一个东西"）。
- 每条尽量写清楚三件事：**改了什么 / 为什么 / 影响面**（是否需要重装、重启 dsh web、
  重跑 bundle 补丁脚本）。
- 精确日期缺失的早期条目归入「2026-09（月份段）」或「早期」小节，只保证**先后顺序**正确。

---

## 2026-09-22 — 文档梳理（本轮）

**1. 变更履历集中到本文件**

| 原位置 | 处理 |
|---|---|
| 根 `README.md` → `## 变更历史`（整节） | 整节迁入本文件（下方各小节），README 只留一行指针 |
| `turing-web-search\README.md` → `## 本机历史` | 迁入「图灵搜索端点（turing-web-search）」小节 |
| `turing-web-search\README.md` → `## 会话历史加载失败修复` | 历史叙述迁入本文件；README 只留**仍然有效**的修复脚本用法（runbook） |
| `vision-delegate\README.md` → 「⚠️ 2026-09-21 事故 1 / 事故 2」 | 两条事故记录迁入「2026-09-21」小节；README 的「附加图片桥」保留结论与一句指针 |

**2. 图灵平台插件加显著提示（非图灵用户不必安装）**

`turing-web-search`、`turing-balance` 在根 `README.md` 的表格行、各自小节标题下、
以及各自的 `README.md` 顶部都加了提示：**这两个插件只对图灵（Turing / TCL）平台用户可用**，
非图灵用户没有可用的 provider / 网关 / 凭据引用，装上也不会显示任何东西
（判定 fail closed），**不必安装**。

**3. 敏感信息清理（审计发现 → 已修）**

- `turing-balance\test\host.test.mjs`、`test\client.test.mjs` 的夹具与
  `turing-balance\README.md` 的示例里出现的**真实个人账号**（用户名 `qiumeng1`、
  另一位同事的用户名、公司邮箱 `QIUMENG1@tcl.com`）→ 换成占位符
  `user_test` / `USER@example.com` / `<user>` / `<账号名>`（测试断言同步改为占位符，
  `npm test` 40 项仍全绿）。
- `vision-delegate\PLAN.md` 里硬编码的个人 `$DSH_HOME` 路径 → 换成占位符
  （该文件随后整体移出仓库，见第 7 条）。
- `workspace-manager\test\unarchive-offline.mjs`：个人 `$DSH_HOME` 默认值 → 改成
  `os.homedir()` 推导；内核入口常量 → 支持 `$DSH_KERNEL` 覆盖并给出明确报错；
  夹具里的个人工作区路径 `E:/JavaSpace/aggregation` → 换成 `E:/work/example-project`。
- `windows-agent-pack\...\references\original-field-notes.md` 里的**内网 Nexus registry 地址**
  → 改成「内网地址略」（那份手册自称不绑定某台机器，不该带内网 IP）。

**4. 文档与代码不一致之处（审计发现 → 已改文档/文案）**

| 位置 | 原来 | 现在 |
|---|---|---|
| 根 README 表格 + 第 1 节 | `provider-manager` 说成"每个提供商**行内**的按钮 / 外科手术补丁" | 改为「设置 → 模型」页**底部**的官方插槽 `settings.models.footer` 面板（与 10 行后的正文自相矛盾，也与代码不符） |
| 根 README 开头 | "每个插件目录内的 README 含升级后需重跑的 bundle 补丁脚本" | 只有 `plugin-toggle\` 有补丁脚本，其余不打官方补丁 |
| `plugin-toggle\README.md`、`provider-manager\README.md` | "`profiles/web/cordis.patch.yml` 已恢复为空模板 `[]`" | 该文件现有 `turing-balance`/`vision-delegate` 两条 `- insert:`；本插件条目不在其中 |
| 同上两处 bundles 示例 | 只列 5 个 bundle | 补上 `dsh-workspace-manager` |
| `plugin-toggle\README.md` | 保护/可管理性都标成 "v4"（`package.json` 写 v3、补丁标记是 v5） | 去掉版本号歧义：说明是现行 v5 补丁、行为自 v3 起未变 |
| `plugin-toggle\README.md` | "停用 `web-search-deepseek` 时清空 `web.searchProvider`" | 实际是给 loader 条目 **`web`** 追加 `config: {}`（整份 config 清空，`searchProvider` 随之消失） |
| `provider-manager\README.md` | 开头"每个提供商行内"；第 88 行起正文说"页底部面板、无需补丁" | 统一为"页底部面板、无需补丁" |
| `provider-manager\README.md` | 引用已删除的 `scripts/patch-models-bundle.mjs`；并留着"打补丁后刷新浏览器"的过时指令 | 标注该脚本随 0.1.5 退役，删除过时指令；补上「测试」一节（4 项） |
| `turing-balance\README.md` | 依赖表列了并未导入的 `dsh-settings` | 改成三项真实依赖 + 说明 settings 是可选注入服务 |
| `turing-balance\README.md` | 错误码表：`UNEXPECTED` 写 500，且缺 `BAD_REQUEST` | 按代码更正：取数内异常 = 502；`BAD_REQUEST` = 400；500 只来自路由回调自身抛错 |
| `vision-delegate\README.md` | "依赖五个宿主服务"（实际 `inject` 有 6 个，含 `llm`）；未配置提示引用旧设置路径 | 更正为六个并说明 `llm` 用途；提示文案与代码常量对齐 |
| `vision-delegate\lib\client.js`、`package.json`、`test\apply.test.mjs` | 仍写 "fork 子代理提供方（`dsh-subagent-fork-in-process`）" | 实现早已是 `spawn`，文案改为 "spawn 子代理提供方（`dsh-subagent-spawn-in-process`）" |
| `vision-delegate\PLAN.md` | 标题写"尚未开工"、`fork` 措辞、承诺一个从未迁入的 `TURING_VISION_MODELS.md` | 先标注为**历史留档**；随后整份**移出仓库**（见下面第 7 条） |
| `workspace-manager\README.md` | 同一段话连写两遍（状态清理说明） | 删掉重复；"端点两个"改为"本能力涉及两个端点（插件共 8 个）" |
| `windows-agent-pack\README.md` | 同一份 composition 一处说"两处改动"、另一处说"三处"；说 verify 检查"composition 是否 18 行"（脚本只打印行数） | 统一为三处；如实描述 verify 的检查内容；补上 `-GlobalSkill` 已存在时只跳过（不会覆盖）这一细节 |
| `windows-agent-pack\install.ps1`、`verify.ps1` | 让用户去选名为 "standard (Windows optimised)" 的 preset（roster 里显示的是 `preset.yml` 的名字） | 改为按 slot 指认：`.agent-presets\windows`（脚本保持纯 ASCII，不能写中文 preset 名） |
| `windows-agent-pack\preset\agent.cordis.yml` | 头部称"comments included"（其实注释也有增改）；persona 注释重复两遍 | 改成"31 行 id 与顺序相同 + 注释另有增改"；删掉重复注释行 |
| `windows-agent-pack\...\SKILL.md` | §6 标题写成"轴 6/10"（轴 6 是安全策略，本节是轴 10）；`shellJoinProblem` 归给 `win-run.mjs`；`win-run.mjs` 选项表漏了 `--max/--shell/--print-cmd` | 标题改为"轴 10（Defender 实扫同属轴 6）"；归给 `run-native.mjs`；补全选项 |

> ⚠️ **`windows-agent-pack` 的改动只在 pack 里**：`$DSH_HOME\.agent-presets\windows\` 里那份是
> 安装副本，本次**没有**同步。要让它与 pack 一致，重跑
> `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force`；
> 在此之前 `verify.ps1` 会如实报"与 pack 不一致"。全局技能副本（`-GlobalSkill` 装的）同理。

**5. 审计结论落盘**：根 `README.md` 新增「敏感信息与移植性（当前基线）」一节，
记录**故意保留**与**对外发布前要处理**的项（内网 registry 地址、机器级绝对路径常量等），
避免下次审计重复发现、也避免有人误以为它们被清理过。三分法（含"历次清理了什么"归 CHANGELOG）
记在 `TECH-NOTES.md` §6.2。

**6. 文档分工确立：README 只写现状，坑搬家到 `TECH-NOTES.md`（新增）**

- 新增 **`TECH-NOTES.md`**：技术要点与踩坑记录的**唯一**去处（必须/禁止怎么写、根因、
  现场特征、回归用例），按主题分 6 节——DSH 插件机制 / 视觉委派 / 取数与缓存 /
  删除类操作安全 / Windows 与 harness / 仓库维护约定。
- 各 README **清出**以下内容（内容不是删除，是搬家）：
  - 根 `README.md`：vision-delegate 的"坑（现场踩过，别重犯）"与"它取代了什么"、
    workspace-manager 的"血统"段与「会话跨工作区移动」的移除论证与结果指针、
    开头"原先 vendored…"的历史叙述（改成"不 vendor 第三方插件"的现状约定）。
  - `vision-delegate\README.md`：「⚠️ 全局守卫的坑」「⚠️ 第二个坑：卡片注册」两节、
    `2026-09-21 事故 1 / 事故 2` 两节、"它取代了先前的三处拼接"、
    "本机原先把它 disabled、已移除"这类日期化叙述。
  - `workspace-manager\README.md`：「为什么没有『会话跨工作区移动』」整节（改为一句现状约定 +
    指向 TECH-NOTES §1.10）、"本机没有 pnpm"的旧注解。
  - `plugin-toggle\README.md`：补丁的 v1–v5 版本演进（改成"现行 v5 的行为描述"）、
    "2026-09 事故后 T0 化"这类日期化理由。
  - `provider-manager\README.md`："为什么不再打 bundle 补丁"（改为一句现状 + 指向 TECH-NOTES §1.7）。
  - `turing-web-search\README.md`：「历史」节（根 README 与 CHANGELOG 已有指针）；
    "2026-09 用临时探针脚本验证后移除"的日期化注记。
  - `turing-balance\README.md`："本插件开发时就踩过一次"这类轶事（保留操作指令）。
  - `windows-agent-pack\README.md`：视觉委派的退役叙述与日期（改为现状 + 指向 TECH-NOTES §1.1）。
- README 的自我约定写进根 `README.md` 开头的「文档分工」提示块，细节写进 `TECH-NOTES.md` §6。

**7. 开发计划文件移出子项目（`PLAN.md` → `dev\`）**

- `vision-delegate\PLAN.md`（17 KB 的开工前施工图）**整份移出仓库**：
  文件挪到 `dev\plans\vision-delegate-PLAN.md`，并从 git 索引里摘除（`git rm --cached`）。
  仓库里不再有任何开发计划/草稿类文件。
- **子项目目录只放成品**：插件目录内只有 `README.md` + 代码 + 测试 + 挂载补丁
  （`windows-agent-pack\` 里随包分发的 `SKILL.md` 与 `references\original-field-notes.md`
  是**交付物本身**，不在此列）。计划书、草稿、调研笔记一律进 `dev\`。
  这条约定写进了根 `README.md` 的 `dev\` 说明与 `TECH-NOTES.md` §6.3。
- 全仓库复查过一遍：除 `PLAN.md` 外没有别的计划/草稿/`*.bak`/临时笔记残留在子项目里。

**8. 本次**未**改动的已知问题（留给后续决定）**

- `windows-agent-pack\install.ps1` 的 `-SetDefault` **不幂等**：当 `settings.yaml` 里已经是
  `agent-presets: default: windows` 时，正则替换 no-op → 走"追加"分支，写出**第二个
  `agent-presets:` 块**（重复顶层键，`yaml` 默认 `uniqueKeys` 会判错，settings 加载失败）。
- `windows-agent-pack\uninstall.ps1` 的摘除正则 `^agent-presets:\r?\n(?:\s+.*\r?\n)*?\s+default:…`
  会把 `agent-presets:` 与 `default:` 之间的**兄弟键一并删掉**（`includeUserRoot: true` 实测会被删空）。
- `install.ps1` 写出的 `$DSH_HOME\win-env.json` 没人清理；`install.ps1` 覆盖安装**不删**旧文件，
  pack 里删掉的文件会残留在安装副本里（`verify.ps1` 只按 pack 逐文件比对，看不见残留）。
- 文档互相矛盾待现场核实：patch 层**新增**条目到底要不要重启一次 dsh web——
  根 README/`turing-balance\README.md` 说"热挂载、无需重启"，而本机
  `profiles\web\cordis.patch.yml` 的注释说"新增条目要重启一次，后续改动才走热监听"。
- `plugin-toggle` 停用 `web-search-deepseek` 时给 `web` 条目写 `config: {}`（清空**整份** web 配置），
  粒度比"只关搜索"粗；是否为预期行为需要确认。

---

## 2026-09-21 — 视觉委派统一到 `vision-delegate`，三件旧实现全部删除

- 删 `vision-switch\`（能力并入插件的每会话胶囊 + 调用时守卫）、删 `vision-delegate-pack\`
  （仅 Linux/macOS 的安装包）、删 `windows-agent-pack` preset 里的 `tool-subagent-vision` 行
  与其 persona 段、删 `$DSH_HOME/AGENTS.md` 的旧规则块（改写成插件版说明）、清掉
  profile 里的 `dsh-vision-switch` junction 与 `dsh-vision-switch.state.json`。
- **为什么必须删 preset 那一行**：它 `provider: fork`，fork 子代理**继承整段父历史**——
  现场一次 `subagent_vision` 调用变成 6 步、每步 ~1.2 MB 请求、30~120 秒，看起来就是
  "调用一直不返回"；同时它**同名遮蔽**了插件的 `subagent_vision`，插件的"只发图片+问题"
  根本没被执行。删掉后插件那份才是唯一实现。
- 另外修掉两个真问题：桥**只拦"本轮新附的图"**（早期按"整段历史里有图"拦，导致附过一次图之后
  每轮都被拦/被整段重定向——历史 60 万 tokens 发给 40 万窗口的视觉模型，网关不报错也不返回内容，
  表现为卡死）；**被拒那一轮也要记会话暂存**（否则打开开关后再说"看一下刚才那张图"会拿到空委派）。

### 事故 1：附图片后"卡住"（"整体重定向"由此废弃）

现场：主模型 `tcl2/deepseek-v4-flash-0731`（声明窗口 80 万）跑了 2600 条事件的长会话，
`cacheReadTokens` 已到 **59.7 万**；卡片里选的视觉模型是 `tcl1/qwen3.7-flash`（声明窗口 40 万）。
附上一张 83KB 截图后那一轮**一个 chunk 都不出**，界面看起来完全卡死（用户 22~55s 后手动中止）。

早期实现是**整体重定向**：把那一轮的整份请求（整段历史 + 工具表 + 图片）改路由到视觉模型。
两条叠加导致卡死：

1. **本机网关对超窗请求既不报错也不返回内容**：先回 200 + SSE 响应头，然后长时间不吐第一个字节。
   实测（同一段历史 + 同一张图）：

   | 目标模型（声明窗口） | prompt 规模 | 首字节 |
   |---|---|---|
   | tcl1/qwen3.7-flash（40 万） | ~10 万 tokens | 4.8s |
   | tcl1/qwen3.7-flash（40 万） | ~30 万 tokens | 18.9s |
   | tcl1/qwen3.7-flash（40 万） | ~60 万 tokens | 40.5s 起；更长的（~100 万 / 300 万 tokens）**完全无字节**（90s/120s 都不回）|
   | tcl1/deepseek-v4-flash-vision-exp（80 万） | ~60 万 tokens | **3.0s**（9.6s 说完）|

   而 dsh 的 idle 看门狗要 **5 分钟**才报 `LLM_STREAM_IDLE_TIMEOUT`——在那之前界面上没有任何反馈。
2. 早期版本还按"整段历史里有图"拦截：附过一次图之后，后面**每一轮**（哪怕纯文本）都会被重定向到
   那个小窗口视觉模型 → 每轮都卡；开关关掉时则每轮都报"视觉委派已关闭"。

### 事故 2：附图片后"卡住"的第二个原因（空委派 + 19 层委派链）

修好重定向之后又暴露两层：

1. **空委派**：宿主会在用户附图的消息之后追加若干**注入的 `user` 消息**（`agent-instructions`(AGENTS.md) /
   `plugin`(运行时上下文) / `skill-catalog`(技能目录)）。早期用"最近一条用户发言"判定本轮是否带图，
   于是附图那一轮被判成"没有新图"——桥既不记暂存也不注入提示，子代理收到一个**没有图的空委派**，
   只能回"我看不到这张图"（并自己去磁盘上找图：`read_image` 是真实存在的官方工具，但它对**文本模型**
   没用，结果同样被投影成文本占位符）。修复＝按 `source.kind` 判定 + 遇到助手消息就停。
2. **19 层委派链**：为了消掉子代理那句"视觉委派已关闭"的转述，曾把父会话的"已开"授给子会话——
   结果**子代理自己的 `subagent_vision` 调用被放行**，而它的系统提示里写着"用户附图时先调用
   subagent_vision"（旧版 AGENTS.md 的措辞），于是它又委派一层、再一层……现场留下 19 个
   `origin: subagent` 的会话（每层 8~10 秒），主 agent 那边看起来就是"工具调用一直不返回"。
   修复＝四层护栏（persona + toolFilter + maxDepth + 不授开关）+ 把角色语义写回 AGENTS.md 与工具描述。

**在真实会话上验过**（`session-d4635765`，"构建Windows优化版智能体"）：

| 请求快照 | 末尾消息（role[kind]{blocks}） | 旧判定 | 新判定 |
|---|---|---|---|
| seq=2617（07:03:02，附图轮，开关关着） | … user[user]{image+text} | true（**正确**地拒了） | true（refs 已记进暂存） |
| seq=2628（08:42:14，之后那条纯文本轮） | … user[agent-instructions]{text} | **true → 又被拒**（bug） | **false → 放行** ✓ |

---

## 2026-09 — `workspace-manager` 成型（会话清点/删除 → 子会话树 → 观察边落盘）

### 运行时观察到的父子边落盘（跨重启存活）

上一个提交的会话树有两个父子来源（登记的账本 > 运行时内存），但平台自带的 `subagent` /
`subagent_fork` 工具**不走** `sessionRemoval.claim()` 登记 —— 这类子会话的父关系只活在当前进程
内存里，`dsh web` 一重启就掉（现场验证：`claims.json` 根本没生成）。本次**不碰平台的 spawn 路径**，
改为把"此刻运行时还能看到的边"**学进账本**：

- 条目新增 `source` 字段（`'claim'` = 产出方登记，权威；`'observed'` = 运行时观察学得，没有 `owner`；
  缺 `source` 的旧 v1 文件按 `'claim'` 读），并且**登记优先**——观察到的边绝不覆盖已有登记的
  `owner`/父指针（反过来登记会把纯观察条目升级成登记条目、没给父时保留已观察到的父）。
- 提升有防御（自引用丢弃、id 不安全跳过、环确定性断开）与进程内去重缓存（幂等：无变化不写盘、
  不产生重复条目、不重写旧 v1 文件）。
- 调用点是 `apply()` 启动一次（**不 await**，失败只告警）与**每次 `inventory`** 增量一次
  （设置页每次打开都会清点），且提升**不影响** `inventory` 返回的父子关系。
- **边界**：此刻还能看到的（会话头带 `parentSession`）会被提升并落盘 —— 包括本功能上线之前
  产生、但此刻仍在运行时列表里的子会话；进程早已结束、header 已读不到的**不追认**（不解析会话日志）。
  合成优先级保持 **登记 > 运行时 > 观察**（观察边只在运行时读不到时兜底）。
- 测试 **255 → 271 项**（新增 `test/runtime-promote.mjs` 16 项；`npm test` + `npm run check` 全绿，
  `vision-delegate` 76 项不变）。

### 新增「子会话树 + 级联删除」

内核没有"谁是谁的子会话"这份落盘数据（子会话投影缓存的 identity 里没有父字段），
所以父子关系由调用方在 `sessionRemoval.claim(owner, ids, { parentSessionId })` 里登记、
落进本插件自己的 `$DSH_HOME\dsh-workspace-manager.claims.json`
（**服务面 v2：claim/release 变异步**，因为要落盘才能跨重启成立）；

- `inventory` 每行加 `parentId`/`kind`/`orphan`；
- `remove` 加可选 `cascade`（**先子后父、只在同一工作区内连带、任一子孙活跃则整体拒绝**）；
- 设置页把子会话缩进显示在父会话下面（默认折叠、行尾标「子会话」），删除确认框列出
  "将一并删除 N 个子会话"，归档父会话时子会话**随父隐藏**（并进客户端 `archivedSessionIds`
  视图，**不**调官方 `archiveSession` —— 子会话通常不在注册表 `sessionIds` 里，会被拒）；
- `vision-delegate` 的 `track()` 顺带把本会话 id 当父指针登记；
- **边界（明说）**：只覆盖插件登记之后新产生的子会话；历史遗留的裸 UUID 会话照常按
  "子会话、父未知"列出，**不建树、不推断、也不解析会话日志兜底**；
- 测试 **201 → 255 项**（`npm test` 全绿：offline 51 / host-rpc 48 / session-tree 23 /
  session-removal 30 / client-harness 52 / transport 15 / remove-session 9 / unarchive-offline 27；
  `vision-delegate` 73 → 76 项）。

### 新增自研 `workspace-manager\`：替代先前三个第三方插件

一次替代先前三个插件的能力——工作区「关闭/隐藏」（侧栏 + 新会话工作区选择器同时不显示，
只写自己的状态文件、不碰内核归档集合）、会话跨工作区安全移动（移植自曾 vendored 的
`dsh-session-workspace`，含 Windows fsync 修复；**该能力已于 2026-09-20 整体移除**，见下）、
设置页「工作区/会话」管理页（打开勾选 + 会话归档勾选，走官方注册表写链可双向）。

非侵入：不 disabled 官方条目、不遮蔽服务、不写 localStorage，仅 1 个 RPC 端点 + 1 层快照包装
+ 1 个 settings.section + 2 处行菜单注入；卸载时投影原样还原。
同期移除 `dsh-workspace-hide`、`@michengai/dsh-archive-manager`、`dsh-session-workspace`
三个第三方插件（junction 与 bundles 登记均已清理）。

### 移除「会话跨工作区移动」，新增「会话清点 / 彻底删除」

移动功能在 0.1.5 上不可能实现（持久化契约只剩 `create/open/stat/list/flush`、没有读写原始
artifact 的面，日志 append-only，官方 session RPC 无重归属会话的动词，而归属由日志头 `cwd`
决定），因此把 `src\host\move-session.js`、`test\move-session.test.mjs`、`moveState`/`move`
端点、`state.move` 字段、会话行菜单项与移动对话框**全部删除**（不是隐藏入口）。

取而代之：`inventory`（按项目键归组的只读磁盘清点）+ `remove`（**文件级彻底删除**：工件目录 +
`storages\session_projcache\sessions\<id>.json` + 旧移动插件遗留的
`session-workspace-backups\<id>\`，收掉删空的项目目录，**永不触碰内容寻址的 `attachments\`**；
活跃拒绝 / 不安全 id 拒绝 / 未知会话报错 / 归档会话同时从官方归档集合摘除），
设置页加磁盘总量行、默认折叠的「未分组」分组与「彻底删除」按钮 + 确认弹窗。
测试 **161 → 180 项**（`npm test` 全绿：offline 51 / host-rpc 35 / client-harness 43 /
transport 15 / remove-session 9 / unarchive-offline 27）。

> 另附一条经验：删除脚本上线前必须先干跑核对待删清单——本项目一次实现里工作区 id 取自状态
> 文件的字段名而非表的键，干跑把 123 个会话全判成"未分组"，是干跑拦下了这次误删。

### 升级调研（0.1.1-rc.2 → 0.1.5-rc.2）

官方在该区间重排了 web 组合（移除 `dsh-host-apiproxy`、`dsh-storage*`、`dsh-client-runtime`、
`dsh-session-projection-cache`，新增 17 个 `dsh-api-*-controller` / `dsh-client-ui-*` 包）；
本仓库 `workspace-manager` 依赖的接缝经逐条比对**均未变化**。官方「取消归档 + 归档会话设置页」
是 0.1.6-alpha 起才有的能力（`dsh-workspace` 的 `unarchiveSession` 在 0.1.6-alpha.2 中出现），
升到 0.1.5-rc.2 不与本插件重叠。

---

## 2026-09 — 升级到 0.1.5-rc.2：`windows-agent-pack`、`vision-switch`、`vision-delegate-pack`

### 新增 `windows-agent-pack\`（仅 Windows）

Windows 优化版编码 Agent 的安装包——composition 与 shipped `standard` 逐行相同，
只做两处功能改动（persona 换成 Windows 执行纪律、`skill-filesystem` 加 `customSkillDirs`
指向随包手册），另附环境探测与 argv 直传执行脚本；

- `install.ps1`（登录前自检 + 备份 + 逐文件 SHA256 比对 + 环境探测）
- `verify.ps1`（抓 0.1.5 的 persona `prefix` 形状，复现旧 `text:` 键的挂载故障）
- `uninstall.ps1`（只删与 pack 逐字节相同的全局技能副本）
- 不碰 `AGENTS.md`，除 `-SetDefault` 外不碰 `settings.yaml`。

### 新增 `vision-switch\`（patch 层插件）——已于 2026-09-21 删除

composer 右下角的「视觉 自动/关」胶囊。host 半区用官方 `tools.guard` 在**调用时**门控
`subagent_vision`（关闭即拒绝，返回理由让模型自己解释），状态写
`$DSH_HOME/dsh-vision-switch.state.json`；client 半区把胶囊注册进官方插槽
`conversation.input.right`，读写走本包同源路由 `/vision-switch`（Node 风格 `(req,res)` 契约，
与 `turing-balance` 的余额路由同一套做法——写成 `(req)=>Response` 会让请求一直挂住，已踩过）。
配套把 `tool-subagent-vision` 行并入 `windows-agent-pack` 的 preset 并补 persona 说明。
离线测试 9 项（守卫判定 / 状态文件 / 路由 GET·HEAD·POST·405·500），并用
`agentPresets.standingKeyFor()` 在真实 compose 里挂载验证 + 路由 200 往返验证。

**退役**（2026-09-21）：开关能力并入 `vision-delegate` 的每会话「视觉」胶囊 + 调用时守卫；
运行时残留（profile `node_modules` 里的 junction、`$DSH_HOME/dsh-vision-switch.state.json`）已清理。

### `vision-delegate-pack` 转为仅 Linux/macOS，并重基到 0.1.5-rc.2——已于 2026-09-21 删除

preset composition 由当时的 shipped `standard` 快照重基为 0.1.5-rc.2 的逐行副本 + 唯一新增行
`tool-subagent-vision`（persona 由旧 `text:` 改成 `prefix` + `suffix`，否则挂载报
`$.prefix missing required value`），删除 Windows 侧 `install.ps1`/`uninstall.ps1`/`set-vision-model.ps1`，
README、`AGENTS.rule.md`、`TURING_VISION_MODELS.md` 与三个 `.sh` 的注释同步只剩 bash 命令；
重基后用 `agentPresets.standingKeyFor()` 实挂验证通过。Windows 的视觉能力当时改由
`windows-agent-pack` 的 preset 承载（会话级开关）。**2026-09-21 该包整体删除**，
视觉委派只由 `vision-delegate` 插件提供（那才是唯一实现）。

---

## 2026-09 — 仓库改名 `dsh-enforce`，第三方插件全部退出

- **仓库更名 dsh-enforce**（`E:\JavaScript\dsh-enforce`）：从"插件工作区"升级为
  "DSH 增强仓库"——代码插件与安装包统一收纳、按需选装；git 远端保留在原地址。
- **移除 `3rdparty\`**：vendored 源码副本（`dsh-session-workspace`、`dsh-workspace-hide`、
  `dsh-archive-manager`）与 231 MB 的 `3rdparty\node_modules` 一并删除——工作区隐藏与会话管理
  能力由 `workspace-manager` 覆盖（当时的移动实现是逐行移植、出处写在源码文件头；那份移植的
  移动能力后来也整体删除了），源码不再需要留底。
- **血统记录**：会话移动的实现曾**逐行移植**自先前 vendored 的第三方插件
  `dsh-session-workspace`（<https://github.com/Unintendedz/dsh-session-workspace>，MIT，
  基线 commit `974388e`，含该仓库在 Windows 上的 fsync 修复：只读句柄 fsync 会 `EPERM`，
  须用 `open(path,'r+')` 的可写句柄），移植说明写在
  `workspace-manager\src\host\move-session.js` 文件头；2026-09-20 该能力（连同那个文件）
  **整体删除**，仓库里不再有任何第三方代码的移植物。
- 旧工作区 `E:\JavaScript\dsh-plugin` 删除，其历史会话已迁入 `dsh-enforce` 工作区。

---

## 2026-09 — `turing-balance`（图灵余额徽章）v1 → v3

> 该插件只对**图灵（Turing / TCL）平台用户**有意义；非图灵用户不必安装（见根 README 第 4 节）。

- **v1 新增**：摸清控制台 `ai.eaglelab.tcl.com` 的用量接口
  （`GET {baseURL}/users/me/usage`，API key 直连可用），用「host 只读路由 + 同源徽章」
  把它显示到会话头部；本插件挂 **profile patch 层**，改完即热挂载、无需重启 dsh web
  ——顺带确认了 loader 对 `profiles/web/cordis.patch.yml` 的热监听行为
  （新增 insert 条目会在运行中即时挂载）。
- **v2 跟随 provider**：徽章**跟随当前模型 provider**——client 从 `modelDirectories`
  （与 composer 模型选择器同一个 store）读当前 provider，host 侧按
  `llm-pi-ai.providers.<id>.baseURL` 的前缀判定是否是图灵平台，并用该 provider 自己的
  `apiKeyEnv` 取数（tcl1/tcl2 是不同账号）；非图灵 provider 直接返回 `hidden` 不显示，
  切换 provider 不串台、host 未确认身份时 fail closed。同时实测确认：patch 层的
  条目增删可热生效，但 **host 半区的模块代码改动仍需重启 dsh web**（client 半区刷新页面即可）。
- **v3 取数策略改为「按 provider 缓存 5 分钟」**：原先每次切会话都强制刷新
  （`?refresh=1`）+ 固定 60s 轮询，接口调用过密。现在前端按 provider 内存缓存、host 按
  `baseURL|apiKeyEnv` 缓存（TTL 默认 `ttlSeconds: 300`，删掉了 `refreshSeconds` 轮询项），
  载荷新增 `ttlSeconds`/`expiresAt`，前端**按到期时刻排一次定时器**而非轮询：切会话 / 重挂载 /
  切回某个 provider 零请求，只有到期或**点击徽章**才重取；非图灵 provider 不缓存不排期；
  失败/陈旧值按 `min(ttl, 120)` 秒短窗口自动重试。测试增至 40 项（新增切会话零请求、
  到期重取、点击强制刷新、多 provider 各自缓存等用例，用假定时器断言排期）。

---

## 2026 — `turing-web-search`（图灵独立搜索端点）

> 该插件只对**图灵（Turing / TCL）平台用户**有意义；非图灵用户不必安装（见根 README 第 3 节）。

**本机历史（原 `turing-web-search\README.md` 的「本机历史」整节迁移）**

最早把 `dsh-web-search-deepseek` 指向图灵 `/messages`（Claude 路线）验证可行但贵；
后曾直接给该 shipped 模块打补丁走 Baidu，按"不覆盖 shipped 模块"的要求回滚，
改为本独立插件。provider id：`turing-search`。2026 扩展端点预置为五选一并新增
设置 → 插件 → 插件配置 卡片（client 半区经 `settings.plugin.item` 槽位注册，
与 shipped ui-settings-plugins 的卡片同构）。

**会话历史加载失败（`web/turing-search-request`）——故障与修复记录**

早期 host 半区在每次搜索时向会话日志 `session.append("web/turing-search-request", …)`
写自定义事件。仓库外的插件事件类型不在 dsh-session 的已知事件目录
（`known-event-types`，GENERATED，只含仓库内声明的类型）里，而本构建的
`Session.append` 无法在信封上打 `ignorable` 标记，因此**任何包含该事件的会话日志
都会被读取端拒绝**（`SessionFormatUnsupportedError`，GUI 显示「历史加载失败」），
这不是插件 bug 之外的另一次故障，而是该写入方式的必然结果。

处理（已完成）：

1. **存量日志修复**：`scripts/session-log-repair.mjs` 按 JSONL.zstd 后端同样的方式
   （拼接的独立 Zstandard 帧 → JSONL 记录）解码全部会话日志，给每个
   `web/turing-search-request` 事件信封补上 `ignorable: true`（数据、seq、header
   全部不变），再按 header 帧 + body 帧重写。已修复 44 个受影响会话，原文件备份为
   同目录 `session.jsonl.zstd.bak-<时间戳>`（确认历史可正常查看后可删除）。
2. **代码修复**：`lib/index.js` 的 `recordRequest` 不再写会话日志，改为 cordis
   logger 的 debug 级输出（诊断记录不影响会话重建，也不抛错）。
3. **重启生效**：host 半区在启动时加载，改完代码后需**重启 dsh web**，此后新会话
   不再产生该事件。

> 仍然有效的 runbook（脚本用法）保留在 `turing-web-search\README.md`。

---

## 2026 — 拆分与更名：`provider-manager` / `plugin-toggle` / `turing-web-search`

- 原为单包 `dsh-provider-toggle`（junction → `E:\JavaScript\dsh-provider-toggle`），
  同时含模型提供商与插件条目两种开关。
- 2026-09 分拆：工作区更名 `E:\JavaScript\dsh-plugin`，web-search 独立成
  `dsh-turing-web-search`。
- 2026 再分拆：`provider-toggle` 改名 `provider-manager`（只处理模型提供商），
  插件条目开关剥离为独立插件 `dsh-plugin-toggle`；Remote 命名空间
  （`providerToggle` / `pluginToggle`）与状态文件名
  （`dsh-provider-toggle.state.json`）**保持旧名**，避免补丁与状态漂移。
- `provider-manager` 退役「对 shipped bundle 打补丁」：0.1.1 时代 shipped 的「模型」页
  没有任何第三方插槽，只能用 `scripts/patch-models-bundle.mjs` 做外科手术式补丁；
  0.1.5 提供官方插槽 `settings.models.footer` 后，补丁与伪行逻辑**全部退役**——
  不碰官方 bundle、升级不会锚点失配，也不再需要 `.bak` / `node --check` 那一套。
- `plugin-toggle` v3：不新增按钮、复用行尾状态徽章为开关（v1 按钮版已取代），
  并加**官方核心条目保护**——T0 锁定不可停用（host 同表强制）+ T1 停用前二次确认，
  条目 config 可扩展 `protectedEntries` / `confirmEntries`（参考社区 dsh-plugin-manager）。
- `plugin-toggle` v5：面向 DSH 0.1.5 **重锚** patch——那一版把行状态改成
  `StateTag({ kind, label })`、卡片抽成 `PluginCard({ …, trailing })`、`matches` 变成
  `(moduleName, entryId, query)`、行渲染函数是 `presetRowCard` / `globalRowCard`，
  于是 v5 给 `StateTag` 增加可选的 `toggle` 语义，再在两处调用点传入。

---

## 早期 — 单包 `dsh-provider-toggle` 时代

- 起点是「DeepSeek 官方」相关模型配置（`deepseek-official` → `llm-deepseek` 适配器）
  被手动禁用后无法从 GUI 恢复：直接删配置需要重新填 key / baseURL。
  于是把「停用 / 启用」做成 GUI 操作——停用只写 `disabled: true`（加载器热加载、
  重启保留）或把配置段移进备份文件，**配置全部保留**、启用即恢复。
- 该单包同时管模型提供商与插件条目两件事，后来按上面的记录拆成三个独立插件。

---

## 附录：曾经的目录与它们的去向

| 目录 | 状态 | 去向 |
|---|---|---|
| `3rdparty\` | 2026-09-20 删除 | 能力由自研 `workspace-manager\` 覆盖；要参考就重新 clone 上游 |
| `dsh-session-workspace`（vendored） | 2026-09-20 删除 | 「会话跨工作区移动」在 0.1.5 上不可能实现，能力一并删除 |
| `dsh-workspace-hide`（vendored，第三方） | 2026-09-20 删除 | 并入 `workspace-manager\` 的「关闭/隐藏」 |
| `@michengai/dsh-archive-manager`（vendored，第三方） | 2026-09-20 删除 | 并入 `workspace-manager\` 的设置页（归档勾选） |
| `vision-switch\` | 2026-09-21 删除 | 开关并入 `vision-delegate\` 的每会话胶囊 + 调用时守卫 |
| `vision-delegate-pack\` | 2026-09-21 删除 | 视觉委派统一由 `vision-delegate\` 提供 |
| `windows-agent-pack` 的 `tool-subagent-vision` preset 行 | 2026-09-21 删除 | 同名会遮蔽插件工具（fork 实例继承整段历史），视觉委派只由插件提供 |
| `$DSH_HOME/AGENTS.md` 的旧视觉规则块 | 2026-09-21 重写 | 改成插件版说明（含"子代理不要再委派"） |
| `turing-balance` 的 `refreshSeconds` 配置项 | v3 删除 | 改为按 provider 缓存 `ttlSeconds` + 到期/点击重取 |
| `workspace-manager` 的 `moveState`/`move` 端点与 `src\host\move-session.js` | 2026-09-20 删除 | 换成 `inventory` + `remove`（文件级彻底删除） |
