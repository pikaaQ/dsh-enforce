# 技术要点与踩坑记录（TECH NOTES）

> 这份文件收纳**结论性的技术要点与踩过的坑**：为什么必须这么写、写错了会怎样、
> 现场长什么样、用什么用例把它钉住。

**三份文档的分工（改文档前先看这张表）**

| 文件 | 只写什么 | 不写什么 |
|---|---|---|
| `README.md`、各插件 `README.md` | **当前状态**：装了什么、原理（为什么这么设计）、怎么装/怎么用/怎么卸、边界在哪、怎么验收 | 变更履历、日期化的历史、踩坑经过 |
| `CHANGELOG.md` | **变更履历**：何时改了什么、为什么改、退役/删除了什么、事故与修复的经过 | 面向使用者的操作指导 |
| 本文件（`TECH-NOTES.md`） | **技术要点与坑**：必须/禁止怎么写、根因、现场特征、回归用例 | 当前状态清单、时间线 |

> 三者的关系：README 说"现在是什么样"，CHANGELOG 说"怎么变成这样的"，本文件说"为什么必须这样"。
> 同一个知识点只在一处展开，另外两处最多放一行指针。

**目录**

- [1. DSH 插件机制](#1-dsh-插件机制)
- [2. 视觉委派（图文桥 / 子代理）](#2-视觉委派图文桥--子代理)
- [3. 取数、缓存与外部接口](#3-取数缓存与外部接口)
- [4. 删除类操作的安全要点](#4-删除类操作的安全要点)
- [5. Windows / harness 相关](#5-windows--harness-相关)
- [6. 仓库维护约定](#6-仓库维护约定)

---

## 1. DSH 插件机制

### 1.1 同名工具会互相遮蔽：preset 行打败不了插件，只会盖住它

- **要点**：`subagent_vision` 这类工具名**全局唯一**。preset 里若再写一行同名工具，
  **preset 那份会遮蔽插件的工具**，插件的实现根本不会被执行。
- **现场**：旧 `windows-agent-pack` preset 里的 `tool-subagent-vision` 行（`provider: fork`）
  就是这样——一次调用变成 6 步、每步 ~1.2 MB 请求、30~120 秒，从主 agent 看就是"调用一直不返回"。
- **对策**：能力只由插件注册一次；preset 里**不要**出现同名行。改完用一次真实调用验证。
- **回归**：`vision-delegate/test/apply.test.mjs` 断言 `apply()` 只注册一个工具 + 一个守卫。

### 1.2 subagent provider：`fork` 继承父历史，`spawn` 不继承

- **要点**：委派给子代理时要问自己"子代理需要看到整段父历史吗"。默认答案是否。
- **根因**：`fork` provider 的 `inheritsParentContext = true`——子代理拿到整段历史与工具表；
  `spawn` 是全新上下文，只发你给的那点内容，并用 `agentOptions` 把模型 pin 死。
- **现场**：60 万 tokens 的历史发给 40 万窗口的视觉模型 → 网关不报错也不返回（见 §2.1）。
- **对策**：视觉/工具型委派一律 `spawn` + `toolFilter` + `maxDepth` + 固定 `agentOptions`。

### 1.3 `ctx.tools.guard()` 是**全局**守卫：第一条语句就要放行非目标工具

- **要点**：守卫写错会拒绝**所有**工具调用。
- **现场**：`ctx.tools.guard((execution) => refusalFor(...))` 这种写法在"未配置"时会连
  `read`/`write`/`pwsh` 一起拦——等于把会话锁死。
- **对策**：`createRefusalGuard(readStatus, TOOL_NAME)`——**第一条语句**判断工具名，
  非目标立即放行；自身判定抛错时 **fail-open**（放行）。
- **回归**：`test/apply.test.mjs` 的"未配置时守卫只拦 `subagent_vision`"。改守卫必须让它继续绿。

### 1.4 「设置 → 插件 → 插件配置」卡片是两个账本的交集（必须 generator + `yield`）

- **要点**：卡片要出现，host 与 client 两侧都得登记**同一个 key**：
  1. host：`settings.installSection()` 注册命名空间；
  2. client：往 `settings.plugin.item` 注册同 key 的卡片。
- **现场**：普通箭头函数**返回**注册对象不会配对成功，表现为"插件配置里什么都没有"；
  必须是 `function*` + `yield ctx.slots.register(...)`。卡片外壳（`<li>` 边框、可点标题行、
  可折叠内容）也要插件自带。
- **可照抄的样本**：`turing-web-search/lib/client.js`（官方页自己也这么注册）。

### 1.5 同一个 loader id 只能出现一次：patch 层与 bundle 层二选一

- **要点**：`profiles/web/cordis.patch.yml` 的 `- insert:` 与 `dsh.profile.bundles` 登记
  是**两条挂载路径**，同一个 id 同时走两条 → 冷启动报 `duplicate loader entry id: <id>`。
- **易错点**：包声明了 `dsh.bundle.patch` **不等于**已挂载——只有进了 `dsh.profile.bundles`
  才真正参与层栈。所以"junction + patch 层 insert"本身不会重复；
  用 `dsh plugin --profile web add <dir>`（会自动登记 bundles）同时留着 insert 才会。
- **对策**：决定挂哪层后写进插件 README 的安装段；`cordis.patch.yml` 顶部注明"二选一"。

### 1.6 给 shipped bundle 打补丁：锚点会随版本变，必须能重锚

- **要点**：改官方页面的补丁脚本（`plugin-toggle/scripts/patch-plugins-inventory-bundle.mjs`）
  依赖**源码文本锚点**，dsh 升级会全部失配。
- **经验**：0.1.5 把行状态从 `<span class=configTag>` 换成 `StateTag({kind,label})` 组件、
  卡片抽成 `PluginCard({…, trailing})`、`matches` 变成三元签名——所以补丁从"注入按钮"
  改成"给 `StateTag` 增加可选 `toggle` 语义，再在两处调用点传入"。
- **纪律**：脚本必须①幂等（有标记就跳过）②可回退（`.bak`）③每处替换唯一命中否则中止
  ④打完自动 `node --check`。失配时要**明确报错中止**，不能写坏文件。

### 1.7 官方插槽 > 打 bundle 补丁

- **要点**：能用官方扩展点就别打补丁。补丁要跟着 shipped 源码走，插槽不用。
- **例**：0.1.1 的「设置 → 模型」页没有任何第三方插槽，只能外科手术式注入按钮；
  0.1.5 提供 `settings.models.footer`（list 型）后，`provider-manager` 的补丁与"伪行"逻辑
  全部退役，升级不再锚点失配，也不再需要 `.bak` / `node --check` 那一套。
- **选槽要点**：`settings.models.provider-card` 是 **keyed** 型插槽、按 `settingsNs` 派发，
  注册即**替换**该 key 的占用者——不适合"给每张卡都加一个控件"，故未采用。

### 1.8 不要往会话日志写自定义事件：整份日志会被读取端拒绝

- **要点**：仓库外插件的事件类型不在 `dsh-session` 的 `known-event-types`（GENERATED）里，
  而本构建的 `Session.append` 无法给信封打 `ignorable` 标记 →
  **任何包含该事件的会话日志都会被读取端拒绝**（`SessionFormatUnsupportedError`，GUI 显示
  "历史加载失败"）。
- **现场**：`turing-web-search` 早期写 `web/turing-search-request`，44 个会话受影响。
- **对策**：插件不要写会话日志，改用 cordis logger 的 debug 输出。
- **补救**：存量日志用 `turing-web-search/scripts/session-log-repair.mjs` 补 `ignorable: true`
  （用法见该插件 README 的 runbook）。

### 1.9 同源 HTTP 路由必须写成 Node 风格 `(req, res)`

- **要点**：写成 `(req) => Response` 会让请求**一直挂住**（实测踩过）。
- **对策**：照 `lib/http.js` 那套（`respond` / `readJsonBody`）写，读写 `res`。

### 1.10 内核不提供的写面，别用"绕过"来补

- **会话删除**：`dsh-session-persistence` 只有 `create/open/stat/list/flush`，没有删除动词。
  临时子会话只能由**文件级删除**清掉——本仓库把它做成 `workspace-manager` 的
  `sessionRemoval` 宿主服务，需要删除的插件只登记 id（**机制归提供方、策略归调用方**）。
- **会话重归属（跨工作区移动）**：0.1.5 起不可能安全实现——持久化契约没有读改原始 artifact
  的面、日志 append-only、「会话属于哪个工作区」由日志头 `cwd` 决定、容器是多帧 zstd/稀疏区
  没有公开长度索引（自行解析等于绕过 codec 与写租约，判断有误就是历史损坏）。
  **结论：要换工作区就在新工作区新建会话**，不要提供入口。
- **会话父子关系**：内核没有这份落盘数据（子会话投影缓存的 identity 里没有父字段）。
  只有两个来源——产出方 `claim(parentSessionId)` 登记（权威）与**运行时观察到的边**
  （会话头带 `parentSession`）；**不解析会话日志、不推断**。

### 1.11 两个长期存活的写入者不要同写一个文件

- **现场**：工作区关闭集合与子会话登记表若共用一个文件，必然丢更新。
- **对策**：各开一个文件（`dsh-workspace-manager.state.json` / `.claims.json`），
  写盘原子（临时文件 + fsync + rename），并且从"能读多少读多少"起步（损坏即安全回落）。

---

## 2. 视觉委派（图文桥 / 子代理）

### 2.1 本机网关对超窗请求**既不报错也不返回内容**

- **要点**：把超长 prompt 发给小窗口模型时，网关先回 200 + SSE 头，然后长时间不吐第一个字节；
  dsh 的 idle 看门狗要 **5 分钟**才报 `LLM_STREAM_IDLE_TIMEOUT`——在那之前界面没有任何反馈，
  看起来就是"卡死"。
- **实测（同一段历史 + 同一张图）**：

  | 目标模型（声明窗口） | prompt 规模 | 首字节 |
  |---|---|---|
  | `tcl1/qwen3.7-flash`（40 万） | ~10 万 tokens | 4.8s |
  | `tcl1/qwen3.7-flash`（40 万） | ~30 万 tokens | 18.9s |
  | `tcl1/qwen3.7-flash`（40 万） | ~60 万 tokens | 40.5s 起；更长（~100 万 / 300 万）**完全无字节** |
  | `tcl1/deepseek-v4-flash-vision-exp`（80 万） | ~60 万 tokens | **3.0s** |

- **对策**：①视觉委派只发"图片 + 主模型写的问题"，**不转发历史与工具表**；
  ②选视觉模型时看窗口，别拿小窗口模型硬扛长会话。

### 2.2 桥只拦"本轮新附的图"

- **要点**：按"整段历史里有图"拦截是错的——附过一次图之后，**每一轮**（哪怕纯文本）都会被
  重定向到小窗口视觉模型（每轮都卡），开关关掉时则每轮都报"视觉委派已关闭"。
- **对策**：只认**本轮新增**的 image block；`purpose` 非空的是辅助调用（标题生成、历史压缩），
  **一律放行**——它们同样带着整段历史，拦下来只会把视觉提示混进标题/摘要提示词。

### 2.3 宿主注入的 `user` 消息会让"最近一条用户发言"判定失效

- **要点**：用户附图的消息之后，宿主会追加若干**注入的 `user` 消息**
  （`agent-instructions`(AGENTS.md) / `plugin`(运行时上下文) / `skill-catalog`(技能目录)）。
  早期用"最近一条用户发言里有没有图"判定本轮，于是附图那一轮被判成"没有新图"——
  子代理收到一个**没有图的空委派**，只能回"我看不到这张图"。
- **对策**：按 `source.kind` 判定本轮是否带图，遇到助手消息就停；**被拒的那一轮也要把图片
  ref 记进会话暂存**，否则之后打开开关再说"看一下刚才那张图"会拿到空委派。
- **回归**：`test/bridge.test.mjs` 的三种回归用例（注入消息 / 失败轮次 / 同 rpcId 拆分）。

### 2.4 不要把父会话的开关"授权"给子代理，否则会叠委派链

- **要点**：视觉子代理的系统提示里写着"用户附图时先调用 `subagent_vision`"；
  一旦把父会话的"已开"状态授给它，它就会**自己再委派一层**、再一层……
- **现场**：留下 19 个 `origin: subagent` 的会话（每层 8~10 秒），主 agent 侧表现为
  "工具调用一直不返回"。
- **对策**：四层护栏——子代理自己的 persona + `toolFilter`（摘掉 `subagent_vision`）
  + `maxDepth` 上限 + **不授开关**；并把"不要再委派"写进子代理 persona。

### 2.5 注入提示必须"自己再发一次调用"，不能改写后交给 `next()`

- **根因**：瀑布的 `next()` 是闭包 `() => (cbs.shift() ?? inner)(...args)`——不吃参数、
  永远转发最初那份 options；而 agent-loop 构造的 request 是 `Object.freeze` + 消息
  `deepFreeze`（官方契约：listeners *read it, never rewrite it*）。
- **对策**：只能自己再发一次调用；那份被注入过的 options 记在模块级 `WeakSet` 里，
  嵌套那一次放行（认对象身份，不用全局深度计数——不同会话是并发的）。

### 2.6 子会话 id 的取得时机决定了"崩溃窗口"

- **要点**：`subagents.start()` 一返回就能拿到子会话 id（本地 run 的 `run.id` **就是**已发布的
  子会话 id）。但"start 成功、落账之前进程就死"这一个瞬间必然漏一个孤儿——**无法避免**
  （内核不告诉我们它建过哪些会话）。
- **对策**：先落账再登记归属，跑完（`run.dispose()` 之后，无论成败）立刻删；启动时补删上次的孤儿。

---

## 3. 取数、缓存与外部接口

### 3.1 免费接口也会被打爆：轮询 → TTL + 到期/点击

- **现场**：`turing-balance` v1/v2 每次切会话都强制刷新 + 固定 60s 轮询，调用过密。
- **对策**：前端按 provider 内存缓存、host 按 `baseURL|apiKeyEnv` 缓存（TTL 默认 300s），
  前端**按到期时刻排一次定时器**而不是轮询；只有**到期**或**用户点击**才重取；
  非目标 provider 不缓存也不排期；失败/陈旧值按 `min(ttl, 120)` 秒短窗口自动重试。
- **可复用结论**：徽章类 UI 的默认取数策略就应该是"TTL + 显式刷新"，不是轮询。

### 3.2 余额类接口可能接受 API key 直连（不必走控制台 SSO）

- **要点**：`GET {baseURL}/users/me/usage` 实测**接受 API key 直连**（`Authorization: Bearer <key>`），
  不需要控制台 access token。
- **纪律**：key 只在 **host 半区**解析，**不进浏览器**；浏览器只打同源路由
  （`GET /turing-balance?provider=<id>`）。
- **判定要 fail closed**：认不出/判定失败/非目标平台一律"不显示"，绝不显示错账号的数字。
  前缀判定是纯字符串前缀匹配（`https://live-turing.cn.llm.tcljd.com.evil.example/` 不命中）。

---

## 4. 删除类操作的安全要点

### 4.1 删除脚本上线前必须先干跑核对清单

- **现场**：本项目一次实现里工作区 id 取自状态文件的**字段名**而非表的**键**，
  干跑把 **123 个会话**全判成"未分组"——是干跑拦下了这次误删。
- **纪律**：任何批量删除先 `--dry` 打印待删清单 + 字节账目，人工核对通过再真删。

### 4.2 内容寻址的 `attachments\` 永不触碰

- **要点**：附件按内容寻址、可能被**别的会话**共用，删会话时**绝不**动它。
- **同时删的**：会话工件目录 + `storages\session_projcache\sessions\<id>.json` +
  旧第三方移动插件遗留的 `session-workspace-backups\<id>\`；删空的项目目录收掉。

### 4.3 守卫要"拒绝"而不是"尽力"：活跃会话 / 不安全 id / 未知会话

- **要点**：活跃会话一律拒绝（`session-active`）；id 必须是安全目录名且解析后仍落在 sessions
  根内（否则 `bad-request`，防 `../` 穿越）；找不到工件报 `session-not-found`。
- **删除不可恢复**，所以入口只放设置页 + 一道确认弹窗（报出体积、说明不可恢复）。

### 4.4 子会话级联删除的顺序与边界

- **顺序**：先子后父；只在**同一工作区内**连带；任一子孙活跃则**整体拒绝**。
- **归档**：归档父会话时子会话**随父隐藏**（走客户端的视图层隐藏），
  **不**调官方 `archiveSession`——子会话通常不在注册表里，会被拒。

---

## 5. Windows / harness 相关

> 完整的报错原文 → 根因 → 处置索引（32 条）与十二个环境轴的判定方法，见
> `windows-agent-pack/preset/skills/windows-native-tooling/SKILL.md`（装机后也在
> `$DSH_HOME\.agent-presets\windows\skills\windows-native-tooling\`）。这里只留几条**本仓库
> 开发过程中反复用到**的：

- **只读句柄 fsync 会 `EPERM`**（Windows）：要 fsync 就用 `open(path, 'r+')` 的可写句柄。
  这条来自上游第三方插件的 Windows 修复，写盘原子化时同样适用。
- **受限沙箱下 `node --test` 会 `spawn EPERM`**：`node --test` 为每个测试文件起子进程并用管道
  收集输出，而受限模式下命名管道不可用。绕法：直接 `node test/xxx.test.mjs` 逐个跑
  （`node:test` 在进程内执行，不 spawn）。
- **`原生命令 | PowerShell cmdlet` 可能被沙箱拒绝**（broken pipe / 命名管道）：
  要截断输出就重定向到文件再读，别用 `| Select-Object -First N`。
- **`git diff`/`git status` 这类命令单独跑**：把 `git ls-files | Measure-Object` 这类
  "原生命令接 cmdlet"混在一条长命令里，失败原因会被埋在一堆输出中间。
- **绝对路径不要手抄**：脚本里尽量用 `Join-Path`/`homedir()` 推导（本仓库已把
  `unarchive-offline.mjs` 里写死的个人 `$DSH_HOME` 改成 `os.homedir()`，内核入口可用
  `$DSH_KERNEL` 覆盖）。

---

## 6. 仓库维护约定

### 6.1 文档分工

见本文开头的分工表：**README 只写现状 / 原理 / 安装使用 / 边界；CHANGELOG 写变更履历；
本文件写技术要点与坑**。三处都不要互相复制大段内容，最多放一行指针。

### 6.2 审计敏感信息时的三分法

每次审计的结论按三类落盘——**当前基线表在根 README 的「敏感信息与移植性」一节**，
本文件只记准则（别在两处各写一份表）：

| 分类 | 含义 | 处理 |
|---|---|---|
| **已清理** | 真实个人信息（用户名/邮箱/个人目录）、与功能无关的内网地址 | 换占位符或删除；清理清单记进 `CHANGELOG.md` |
| **故意保留** | 功能必需的内网端点（图灵网关）、安装手册里的本机绝对路径、凭据**引用名** | 保留，并在 README 基线里写明理由 |
| **已知未处理** | 只影响"对外发布"的项（如 `package-lock.json` 里的内网 registry 地址） | 记进 README 基线，发布前再处理 |

- **判断准则**：仓库里**不允许出现任何真实凭据值**（只允许引用名，值在
  `$DSH_HOME\.credentials.yaml`）；"内网/本机绑定"不算泄露，但要能被一条命令找出来。
- **提醒**：git 提交元数据（作者名/邮箱）也在暴露面内，但它属于历史，只能在 push 前决定。

### 6.3 子项目目录只放成品

- **插件目录里只允许**：`README.md` + 代码 + 测试 + 挂载补丁（`cordis.patch.yml` / `package.json`）。
- **计划书、设计草稿、调研笔记、临时脚本一律进 `dev\`**
  （计划书放 `dev\plans\`，验证脚本放 `dev\tools\`，调研放 `dev\research\`，证据日志放 `dev\logs\`）——
  `dev\` 不进版本库，所以这些东西不会随仓库分发，也不会被误当成"当前设计"。
- **例外**：随包交付的文档不算草稿——例如 `windows-agent-pack\preset\skills\...\SKILL.md`
  与它的 `references\original-field-notes.md` 是安装包要装到用户机器上的**交付物**，必须留在包内。
- 历史决策不要靠"留一份计划书"来保存：**决策与原因写进 `CHANGELOG.md`，技术要点写进本文件**。

### 6.4 改文档顺手做的事

- 改完 `README` 的安装命令，**照着执行一遍**（或至少逐条对代码/路径核验）——本仓库的
  README 里曾出现"已恢复为空模板 `[]`"这类与现实相反的描述。
- 改完 `lib/client.js` 这类**生成物**要重跑 build（`workspace-manager` 有 `scripts/build-client.mjs`，
  它自带漂移守卫）；`vision-delegate` 的 `lib/client.js` 是**手写**的，别搞混。
- 改了 `windows-agent-pack/preset/` 之后，`$DSH_HOME\.agent-presets\windows\` 那份是**安装副本**，
  要 `install.ps1 -Force` 才会同步，否则 `verify.ps1` 会如实报"与 pack 不一致"。
