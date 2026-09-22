# dsh-enforce — DSH 增强仓库（全部自研：插件 + 安装包）

本仓库收纳 DSH 增强，**全部自研**（代码插件 + 安装包）。

**不 vendor 第三方插件**：需要参考某个上游实现就重新 clone，不要入库留底。
工作区隐藏、会话管理与视觉委派都由本仓库自研插件覆盖（见第 5、6 节）。

| 类型 | 子项目 | 一句话作用 |
|---|---|---|
| 代码插件（bundle 层） | `workspace-manager\` | 工作区「关闭/隐藏」+ 会话清点与彻底删除 + 设置页「工作区/会话」管理页（零 npm 依赖） |
| 代码插件（bundle 层） | `provider-manager\` | 「设置 → 模型」页**底部**的「模型提供商 停用/启用」面板（官方插槽 `settings.models.footer`，不打补丁） |
| 代码插件（bundle 层） | `plugin-toggle\` | 「设置 → 插件」页：不新增按钮，点卡片行尾状态徽章即 停用/启用 |
| 代码插件（bundle 层） | `turing-web-search\` | ⚠️ **仅图灵平台用户**：ctx.web 图灵独立搜索端点（Baidu/Tavily/Firecrawl/Cloudsway/Bing，无模型费）——非图灵用户**不必安装** |
| 代码插件（patch 层，可热挂载） | `turing-balance\` | ⚠️ **仅图灵平台用户**：会话头部显示图灵平台余额（本月剩余额度），**跟随当前模型 provider**、**按 provider 缓存 5 分钟**（到期或点击才重取），非图灵 provider 不显示——非图灵用户**不必安装** |
| 仅 Windows 安装包（非 bundle） | `windows-agent-pack\` | Windows 优化版编码 Agent：persona 常驻 Windows 纪律 + 随包实战手册（十二个环境轴 / 探测与执行脚本） |
| 代码插件（patch 层，可热挂载） | `vision-delegate\` | 视觉委派做成宿主能力：**任何 preset** 的会话都有 `subagent_vision` 工具 + composer 右下角「视觉」胶囊；用户直接附加的图片以附件直传一个新 `spawn` 子代理（不继承历史、不走路径、不需要 `read_image`），结论作为 tool result 回到会话 |

- **代码插件**：装进 `web` profile 的 bundle 层，需要 junction/`dsh plugin add` + 重启 dsh web；
  `turing-balance` 例外——它挂在 **profile patch 层**，被 loader 热监听（条目增删即时生效），
  且浏览器半区按请求实时下发（刷新页面即最新），只有它的 host 半区代码改动仍需重启 dsh web；
  每个插件目录内有自己的 README（当前状态 + 安装/卸载/验证）；**只有 `plugin-toggle\`
   带一个升级后需重跑的 bundle 补丁脚本**（`scripts/patch-plugins-inventory-bundle.mjs`，
   因为它要改 shipped 的「插件列表」页），其余插件不打任何官方 bundle 补丁。
- **vision-delegate**（第 5 节）：**本仓库视觉委派的唯一实现**。host 平面注册
  `subagent_vision`（每个 preset 都能用）+ `/vision-delegate` 路由 + 能力垫片 + `llm/stream` 桥；
  视觉模型在 设置 → 插件 → 插件配置 → 「视觉委派」卡片里选，开关是 composer 的「视觉」胶囊（每会话）。
- **windows-agent-pack**：同样不注册 bundle/补丁，只写 `$DSH_HOME\.agent-presets\windows\`
  （可选 `$DSH_HOME\skills\` 与 `settings.yaml` 的默认 preset），**只面向 Windows**，
  不修改 `AGENTS.md`（视觉委派不属于它）。
- **`dev\`（不进版本库）**：开发与验证用的一切都放这里，master 只保留"完整可用的插件"。
  目录约定：`dev\tools\` 验证脚本（探针 / 隔离实例 / 运行时 RPC 验证 / 升级空跑）、
  `dev\research\` 调研脚本与抓取的官方包、`dev\logs\` 验证证据日志、`dev\backup\` 改真实配置前的备份、
  `dev\tmp\` 隔离实例（`bootcheck` / `rehearsal-home` / `upgrade-rehearsal`，可达数百 MB）、
  **`dev\plans\` 开发计划与设计草稿**。
  整体由 `.gitignore` 忽略，删掉也不影响插件运行。
  **子项目目录里只放成品**：插件目录内只有 `README.md` + 代码 + 测试 + 挂载补丁；
  计划书、草稿、调研笔记一律进 `dev\`，不要留在插件目录里。

> ⚠️ **图灵（Turing / TCL）平台专属插件：非图灵用户不必安装。**
> `turing-web-search\`（第 3 节）与 `turing-balance\`（第 4 节）都只对**图灵平台**有效——
> 它们请求的是图灵内网网关（`https://live-turing.cn.llm.tcljd.com/`），凭据引用
> （`TCL1_API_KEY` / `TCL2_API_KEY`）也只有图灵账号才有。非图灵用户装上以后：
> 搜索插件找不到可用凭据（`WEB_PROVIDER_CREDENTIAL_MISSING`），余额插件因为当前 provider
> 的 baseURL 不匹配图灵前缀而**永远返回 hidden、不显示徽章**（判定 fail closed，不会显示错账号）。
> 也就是说：**没有图灵账号就不要装这两个插件**，其余插件（1、2、5、6、7 节）与平台无关。

> dsh（或人）想装哪个增强：读对应小节 → 拷贝安装命令执行即可。装完重启按小节「生效」要求做。

> 📚 **文档分工（本 README 与各插件 README 都遵守）**：
> - 各 `README.md` 只写**当前状态**——装了什么、原理、怎么装/怎么用/怎么卸、边界、怎么验收；
> - [`CHANGELOG.md`](CHANGELOG.md) 写**变更履历**——何时改了什么、为什么改、退役了什么、事故与修复经过；
> - [`TECH-NOTES.md`](TECH-NOTES.md) 写**技术要点与踩过的坑**——必须/禁止怎么写、根因、现场特征、回归用例。
>
> 同一个知识点只在一处展开，另外两处最多放一行指针。

---

## 1. provider-manager（模型提供商 停用/启用）

**装了什么**：host 半区 Typert Remote `providerToggle` + client 半区注册的
「模型提供商 停用/启用」**面板**（挂在 shipped「设置 → 模型」页（ui-settings-models）的官方插槽
`settings.models.footer` = 页面**底部**，**不打任何 bundle 补丁**）；停用只备份配置
（`$DSH_HOME/dsh-provider-toggle.state.json`，旧名沿用）或写 `cordis.patch.yml` 的
`disabled: true`，**配置全部保留、可一键恢复**。

```powershell
# 安装（junction 到 profile 的 node_modules + bundles 登记，编辑即时生效）
# <本插件目录> = E:\JavaScript\dsh-enforce\provider-manager
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-provider-manager" -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-provider-manager" "E:\JavaScript\dsh-enforce\provider-manager"
# 再在 profiles\web\package.json 的 dsh.profile.bundles 追加 "dsh-provider-manager"（通常已配好）
# UI 走官方插槽 settings.models.footer，无需任何 bundle 补丁

# 备选（有 pnpm）：dsh plugin --profile web add "E:\JavaScript\dsh-enforce\provider-manager"
# 卸载：dsh plugin --profile web remove dsh-provider-manager（或从 bundles 移除）
```

**生效**：重启 dsh web（host 半区按启动加载）后浏览器 Ctrl+F5；面板在 设置 → 模型 页底部。
详见 `provider-manager\README.md`。

## 2. plugin-toggle（插件条目 停用/启用）

**装了什么**：host 半区 `pluginToggle` + 对 shipped「设置 → 插件 → 插件列表」页
（ui-settings-plugin-inventory）的补丁——**不新增按钮**，点击每张卡片行尾现有的状态徽章
（已启用/已停用）即 停用/启用 loader 条目（写 `$DSH_HOME/cordis.patch.yml`）；
带官方核心条目保护：T0 锁定不可停用、T1 停用前二次确认。

```powershell
# 安装：junction + bundles 登记 + 一次性补丁（dsh 升级后重跑 patch-plugins-inventory-bundle.mjs）
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-toggle" -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-toggle" "E:\JavaScript\dsh-enforce\plugin-toggle"
# dsh.profile.bundles 追加 "dsh-plugin-toggle"（通常已配好）；备选：dsh plugin --profile web add <本目录>
# 卸载：从 bundles 移除 + 还原补丁
```

**生效**：重启 dsh web；浏览器 Ctrl+F5。详见 `plugin-toggle\README.md`。

## 3. turing-web-search（图灵独立搜索端点）

> ⚠️ **仅图灵平台用户可用，非图灵用户不必安装。**
> 本插件把 `ctx.web` 的搜索请求打到图灵内网网关，凭据引用默认是 `TCL1_API_KEY`
> （写在 `$DSH_HOME\.credentials.yaml`，只有图灵账号才有）。没有图灵账号时：设置卡片能打开、
> 插件能挂载，但每次搜索都会以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。
> 非图灵用户请继续用 shipped 的 `web-search-deepseek`。

**装了什么**：host 半区注册 ctx.web 搜索提供商（engine 五选一：
baidu/tavily/firecrawl/cloudsway/bing，纯搜索端点、不走模型、无模型费）+ client 半区
「设置 → 插件 → 插件配置」的「图灵网页搜索」卡片（端点预置下拉，保存即热生效）。
与 shipped `web-search-deepseek` **互斥**：启用本插件时停用它。

```powershell
# 安装：junction + bundles 登记（本插件无 bundle 补丁脚本）
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-web-search" -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-web-search" "E:\JavaScript\dsh-enforce\turing-web-search"
# dsh.profile.bundles 追加 "dsh-turing-web-search"（通常已配好）；备选：dsh plugin --profile web add <本目录>
# 卸载：从 bundles 移除；停用/启用走 设置 → 插件 → 插件列表
```

**生效**：重启 dsh web；端点切换在 GUI 保存后下一次搜索即生效（无需重启）。
详见 `turing-web-search\README.md`。

## 4. turing-balance（图灵平台余额徽章）

> ⚠️ **仅图灵平台用户可用，非图灵用户不必安装。**
> 徽章的显示条件是「当前会话选中的 provider 的 baseURL 以
> `https://live-turing.cn.llm.tcljd.com/` 开头」，取数用该 provider 的 `apiKeyEnv`
> （`TCL1_API_KEY` / `TCL2_API_KEY`）。非图灵用户装上以后**永远看不到徽章**
> （接口返回 `hidden: true, PROVIDER_NOT_TURING`，fail closed），只是白占一个 patch 层条目。
> 用的是自己的网关（如 `linxi`/`ai.docker.tcl.com`、自建 LLM 网关）就别装它。

**装了什么**：会话头部动作区里的一枚余额徽章，显示 <https://ai.eaglelab.tcl.com/#/apikey>
「用量管理」页的那个数（图灵平台的**本月剩余额度**）。悬停看明细（提供商/总额度/已用/账号/更新时间），
点击强制刷新，额度 ≤10% 转警示色。
**与当前模型提供商挂钩**：只有当前会话选中的 provider 的 baseURL 以
`https://live-turing.cn.llm.tcljd.com/` 开头时才显示（判不出/认不出/非图灵一律不显示，fail closed），
切换 provider 立刻重判；取数用**该 provider 自己的 apiKeyEnv**（tcl1/tcl2 是两个图灵账号）。
**不会频繁打接口**：余额**按 provider 缓存 5 分钟**（前端内存 + host TTL，设置段 `ttlSeconds` 可调）
——切会话 / 徽章重挂载 / 切回某个 provider 都不发请求，只有**到期**或**点击徽章**才重新取；
非图灵 provider 不缓存也不排期；失败/陈旧值按 ≤120s 的短窗口自动重试一次。
数据链路：客户端同源 fetch `GET /turing-balance?provider=<id>` → host 半区读 settings 里该 provider 的
`baseURL`/`apiKeyEnv` 做前缀判定，命中才调 `GET {baseURL}/users/me/usage`（实测该接口**接受 API key 直连**，
无需控制台 SSO token），**API key 不进浏览器**；上游失败回落上次成功值并标 stale。

```powershell
# 安装：junction + profile patch 层 insert（patch 层被 loader 热监听 → 条目增删免重启）
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-balance" -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-balance" "E:\JavaScript\dsh-enforce\turing-balance"
cd E:\JavaScript\dsh-enforce\turing-balance; npm install
```

```yaml
# profiles\web\cordis.patch.yml 末尾追加（patch 层与 bundle 层二选一，否则冷启动报 duplicate loader entry id）
- insert:
    - id: turing-balance
      name: dsh-turing-balance
```

```powershell
# 自查：切到图灵 provider 应回余额，非图灵 provider 应回 hidden
curl "http://127.0.0.1:3080/turing-balance?provider=tcl1"    # → ok:true + 余额 + expiresAt（5 分钟后过期）
curl "http://127.0.0.1:3080/turing-balance?provider=linxi"   # → hidden:true, PROVIDER_NOT_TURING
curl "http://127.0.0.1:3080/turing-balance?provider=tcl1&refresh=1"   # → 强制刷新（cached 消失）
# 卸载：删掉 cordis.patch.yml 里那段 insert（热生效）+ 删 junction
```

**生效**：改 patch 层条目即热挂载（无需重启），浏览器 Ctrl+F5 加载徽章；
**改 `lib/index.js`（host 半区）需重启 dsh web**（loader 缓存已 import 的模块），改 `lib/client.js` 只需刷新页面。
配置见 `settings.yaml` 的 `turing-balance:` 段（`providerPrefix` 改判定前缀、`ttlSeconds` 改缓存时长；
不带 `?provider=` 时用 `baseURL`/`apiKeyEnv`）。测试：`npm test`（40 项全离线）。详见 `turing-balance\README.md`。

## 5. vision-delegate（视觉委派：宿主能力插件）

**装了什么**：把「视觉委派」做成**宿主能力**的插件（挂 patch 层，与 `turing-balance` 同层）。
任何 preset 的会话都能用：

- **`subagent_vision` 工具**（host 平面 `tools.register`，全局）：把图片分析交给一个新建的
  `spawn` 子代理——子代理只收到「图片 + 你写的问题」（**不继承会话历史**、**不走文件路径**、
  不需要 `read_image`），结论作为 tool result 回到会话（落盘，后续轮次仍可见）。
- **图片交付**：用户**直接附加**的图片由官方附件库存成 durable attachment，插件把**本轮**的
  attachment 记进会话暂存，工具不带参数时自动用它（复用已有 ref，**不重存字节、不外传路径**）；
  也支持 `images`（绝对路径，插件读字节）与 `image_data`（内联 base64）。
- **附加图片桥**：官方控制器按 `inputModalities` 拒附件 → 插件用**能力垫片**放行（消息得以创建、
  image block 留在会话）＋ `llm/stream` 桥在**本轮带图**时给主模型注入"先调 `subagent_vision`"，
  然后仍走**原** provider/model（历史与工具不外发）。
- **每会话开关**：「视觉 未配置 / 关 / 自动」三态胶囊（`conversation.input.right`），调用时守卫
  （`ctx.tools.guard`）按会话读取，**即时生效**；视觉模型在 设置 → 插件 → 插件配置 → 「视觉委派」卡片里选。

```powershell
# 状态（三态 + provider/model）/ 候选模型（image=true 表示声明了 input: [text, image]）
curl.exe -s http://127.0.0.1:3080/vision-delegate
curl.exe -s http://127.0.0.1:3080/vision-delegate/models
# 离线测试（76 项，不联网）
cd vision-delegate; npm test
```

> 临时视觉子会话的清理交给 `workspace-manager` 发布的宿主服务 `sessionRemoval`（见第 6 节）：
> 子代理完成即删、插件启动补删上次的孤儿；spawn 之后登记时会**带上本会话 id 作为父会话指针**，
> 于是设置页把视觉子会话显示成主会话的子会话、删主会话时一并处理；
> 服务缺席时优雅降级（视觉功能照常，只是不清理、也不登记父子关系）。

**生效**：client 半区刷新页面即最新；**host 半区（`lib/*.js`）改动需重启 dsh web**；
设置卡片里的 provider/model 保存后**当前进程立刻生效**（官方 `installSection` 的 `setSource`）。

> **不要**在 preset 里再写一行同名工具（会**遮蔽**插件的工具，见
> [`TECH-NOTES.md`](TECH-NOTES.md) §1.1）；视觉委派只由本插件提供。
> 详见 `vision-delegate\README.md`。

---

## 6. workspace-manager（工作区管理：关闭隐藏 / 会话清点与彻底删除 / 设置页）

**装了什么**（三个能力，全在一个插件里）：

1. **关闭工作区**：侧栏工作区行菜单在 重命名 / 删除 之间加一项 **关闭**。关闭后该工作区
   **不在工作区列表显示**，**新会话的工作区选择器里也不出现**（两处读的是同一个快照，所以一起消失）；
   菜单里再选 **打开** 即恢复。**关闭不删任何东西**——不删目录、不删会话、不改内核归档集合。
2. **会话清点与彻底删除**：宿主 `inventory` 只读清点磁盘上的每个会话（按 `cwd` 推出的
   dsh-workspace 项目键归组，对不上任何已注册工作区就是「未分组」）；`remove` 做**文件级彻底删除**
   ——会话工件目录 + `storages\session_projcache\sessions\<id>.json` + 旧第三方移动插件遗留的
   `session-workspace-backups\<id>\`，并收掉因此被删空的项目目录。内容寻址、可能被别的会话共用的
   `attachments\` **永不触碰**。安全边界：活跃会话一律拒绝（`session-active`）、id 必须是安全的
   目录名且解析后仍落在 sessions 根内（否则 `bad-request`）、找不到工件报 `session-not-found`、
   归档会话在删除时同时从官方归档集合里摘除。**删除不可恢复**（这也是它只放在设置页里、
   并且要过一道确认弹窗的原因）。另外 `inventory` 每行还带**会话树**字段
   （`parentId`/`kind`/`orphan`），`remove` 支持可选 `cascade`：**先子后父**、只在同一工作区内
   连带、任一子孙活跃则整体拒绝；归档父会话时子会话**随父隐藏**（走本插件现成的视图层隐藏机制，
   不碰官方归档集合——子会话通常不在注册表里，`archiveSession` 会拒）。
   **边界**：父子关系有两个来源 —— 产出方插件 `claim` 登记的 `parentSessionId`（权威），
   以及**运行时观察到的边被"提升"进账本**（`source: 'observed'`；平台自带的 `subagent`/
   `subagent_fork` 不走登记，靠它跨重启存活）。**只覆盖这两类**：已经登记过的，以及此刻
   运行时列表里还看得到（会话头带 `parentSession`）的；真正读不到的历史遗留会话**不建树、
   不推断**（也不解析会话日志）。
3. **设置页「工作区 / 会话」**：顶部一行**磁盘总量**（会话数、体积，含未分组计数）；列出**所有**
   工作区（含已关闭的，带「随工作区隐藏」标注），每行一个 **打开** 勾选（勾=显示、取消=隐藏）；
   可展开该工作区的会话列表，每个会话一行 **归档** 勾选，可直接 归档 / 重新打开（写的是官方
   归档集合，与侧栏菜单的 归档 完全等价、可双向切换）。另有默认**折叠**的「未分组」分组，
   里面是磁盘上存在、但归属不到任何已注册工作区的会话；每个**有磁盘工件**的会话行多一个
   **彻底删除** 按钮（活跃会话置灰并提示原因），点击弹确认框（报出体积、说明不可恢复）。
   会话列表以**磁盘清点**为准（注册表只认得本次运行见过的会话，光看它会漏）。当前 DSH 版本
   若不暴露所需写入面，开关会变灰并给出说明。

> **本插件不提供「会话跨工作区移动」**：要换工作区，请在目标工作区新建会话。
> 为什么在 0.1.5 上不可能安全实现（持久化契约、append-only 日志、归属由日志头 `cwd` 决定），
> 见 [`TECH-NOTES.md`](TECH-NOTES.md) §1.10；移除经过见 [`CHANGELOG.md`](CHANGELOG.md)。

**实现独立**：三项能力都是本仓库自研（历史渊源见 `CHANGELOG.md`，仓库内不含任何第三方代码的移植物）；
"归档可逆"走的是官方 `WorkspaceRegistry` 自己的写链（`enqueueOperation` + `setState`），
**不手改状态文件**；清点/彻底删除同样不手改状态文件（只删文件，归档集合的摘除走同一个写链）。

**非侵入约定**（这是本插件唯一允许做的事）：不 `disabled` 任何官方条目、不替换/遮蔽任何服务、
不写 `localStorage`、不改内核状态。只做四件事——1 个自有 RPC 端点（`POST /dsh-workspace-manager/<method>`，
`authority: 'trusted-host'`）、1 层快照包装（`ctx.workspaces.list`，插件卸载时**原样还原**）、
1 个 `settings.section`（id `workspace-manager`，order 19）、1 处 DOM 菜单注入
（工作区行的「关闭」，会话行菜单不再有任何本插件的项）。
宿主半区 **零 npm 依赖**（本机没有 pnpm 也能装）。

另外它对**其它插件**发布一个宿主服务 `ctx.provide('sessionRemoval', …)`：把"彻底删除"那套
已经测过的文件级删除开放出去（`claim(owner, ids, { parentSessionId })` / `release` /
`claimsOf` / `remove(id, { owner })`，带活跃会话拒绝 + "只能删自己登记的 id"白名单；
服务面 v2 起 `claim`/`release` 是异步的——父子关系要落盘才能跨重启成立）。
`vision-delegate` 就靠它清理临时视觉子会话、并登记父会话——
**机制归本插件、策略归调用方**，别的插件不必再写一份文件级删除。详见 `workspace-manager\README.md`。

**安装（junction + bundles 登记；无需 pnpm）**：
```powershell
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-workspace-manager" "E:\JavaScript\dsh-enforce\workspace-manager"
# 再在 profiles\web\package.json 的 dsh.profile.bundles 末尾加 "dsh-workspace-manager"
```

**状态文件**：`$DSH_HOME\dsh-workspace-manager.state.json`（**只存"被关闭的工作区 id"**；
原子写 tmp+fsync+rename；损坏时安全回落为空集合）。改这个文件等于改"哪些工作区被隐藏"，
除此之外它不承载任何状态（清点与彻底删除也**不往这里存东西**——删除只是删文件）。
另有一份 `$DSH_HOME\dsh-workspace-manager.claims.json`：**子会话登记表**（`sessionRemoval`
服务自己的账本：每个 id 的 `owner` / `parentSessionId` / **`source`**，即会话树的父子来源）。
条目有两种来源：`source: 'claim'`（产出方插件 `claim()` 登记的，**权威**）与
`source: 'observed'`（本插件把**运行时观察到的** `parentSession` 边"学"进账本，没有 `owner`；
平台自带的 `subagent`/`subagent_fork` 不走登记，靠它跨重启存活）——`apply()` 启动时提升一次、
每次 `inventory` 增量一次；观察到的边**绝不覆盖**已有登记。缺 `source` 的旧 v1 文件按 `'claim'` 读。
**另开一个文件**是为了避免与关闭集合互相覆盖（两个长期存活的写入者同写一个文件必然丢更新），
也顺便让"容忍旧格式"变成免费（旧文件原样不动）。

**生效**：bundle 层随 dsh 启动加载 → 改 host 半区需**重启 dsh web**；改 client 半区刷新页面即可。
卸载：从 `dsh.profile.bundles` 移除 + 删 junction（投影包装会自动还原，无需手工回滚）。

**测试**：`cd workspace-manager; npm test`（**271 项**：offline 51 / host-rpc 48 /
session-tree 23 / runtime-promote 16 / session-removal 30 / client-harness 52 / transport 15 /
remove-session 9 / unarchive-offline 27），
外加 `npm run check`（语法检查）。**清点 / 彻底删除**的覆盖点：按项目键归组与「未分组」判定、
删掉工件 + 投影缓存 + 旧移动插件遗留备份、收掉被删空的项目目录、字节账目、
活跃会话 / 不安全 id（含目录穿越）/ 未知会话三类守卫的拒绝语义，以及
「点删除 → 确认 → 走真实 `remove` 端点 → 磁盘文件消失 → 清点刷新」的客户端整链路。
**会话树**的覆盖点（+69 项）：`claim` 父指针落盘与跨重启读回、重复 claim 不抹父、
孤儿/自引用/环/跨项目键/跨工作区防御、`planCascade` 的先子后父与跨工作区跳过、
`inventory` 的 `parentId`/`kind`/`orphan`、级联删除的守卫（任一子孙活跃则整体拒绝、
默认不级联）、设置页的缩进树与折叠、「将一并删除 N 个子会话」确认文案、
归档父会话时子会话随父隐藏并可逆；
**运行时观察边 → 账本（提升）**：观察边落盘（`source: 'observed'`）、只用账本重建树（模拟重启）、
合成优先级（登记 > 运行时 > 观察）、观察边不覆盖已 `claim` 的 owner/父、
幂等（第二次不写盘/不重复条目/不重写 v1 文件）、自引用/环/不安全 id 防御、
历史会话（没有 `parentSession`）不追认、
`apply()` 启动提升不阻塞不抛错（`sessions.list()` 抛错也只告警）、每次 `inventory` 增量提升。
另有**真实运行时验证**：隔离 `DSH_HOME` 冷启动一个真实实例，再用真实 HTTP RPC 打一套
（信任栅栏 403、真实内核的归档集合、`inventory` 的逐行判定与汇总自洽、
`remove` 的守卫 + 「真删一个一次性会话后别的会话字节不变」的复核）。
脚本与步骤见 `workspace-manager\README.md`。

**与官方新版的关系（升级前必读）**：0.1.5-rc.2 里官方**仍然没有**"取消归档"；
官方 **0.1.6-alpha 起**自带 `WorkspaceRegistry.unarchiveSession` 和「归档会话」设置页
（`@deepseek-ai/dsh-client-ui-settings-unarchive-sessions`，section id `archived-sessions`，order 25）。
升到那个版本后，本插件设置页里的"归档"勾选与官方页功能重叠，可以只摘掉这一半
（打开勾选、未分组预览与彻底删除都保留）。
另：官方 0.1.5 重排过 web 组合（移除 `dsh-host-apiproxy`/`dsh-storage*`/`dsh-client-runtime`，
新增 `dsh-api-*-controller` 等），本插件依赖的接缝（`settings.section` 槽位、
`workspaces.list` 快照形状、`connection.rpc.handle`、侧栏行 DOM 契约、
`WorkspaceRegistry` 写链）在 0.1.5-rc.2 中**均未变化**。

---

## 7. windows-agent-pack（Windows 优化 Agent 安装包）

给编码 Agent 装上 Windows 原生命令纪律的安装包：**不注册 bundle/补丁，纯官方机制**（只写 `$DSH_HOME`），
**只面向 Windows**（不提供 `.sh`）。composition 与 shipped `standard` **逐行相同**，只做两处功能改动：
persona 前缀换成 Windows 执行纪律（常驻，影响每一步）；`skill-filesystem` 增加 `customSkillDirs` 指向
preset 自带的 `skills\windows-native-tooling`（按需加载的实战手册：十二个环境轴 + 32 条报错索引 +
环境探测与 argv 直传执行脚本）。

```powershell
# 在 windows-agent-pack\ 目录内
powershell -ExecutionPolicy Bypass -File .\install.ps1                    # 只装 preset
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force -GlobalSkill -SetDefault
powershell -ExecutionPolicy Bypass -File .\verify.ps1                     # 只读自检：哈希 / 0.1.5 schema / 环境探测
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveGlobalSkill
```

- 版本基线 **@deepseek-ai/dsh 0.1.5-rc.2**：persona 用 `prefix` + `suffix`、技能用 `customSkillDirs`；
  0.1.4 及更早的单个 `text:` persona 形状**挂不上**（`$.prefix missing required value`），
  `install.ps1` 会先自检 pack 形状。
- 不碰 `AGENTS.md`；除 `-SetDefault` 外不碰 `settings.yaml`。
- `-GlobalSkill` 把手册也装到 `$DSH_HOME\skills\`，让 `standard`/`ptc`/`minimal` 的会话也能按需加载
  （否则手册只在本 preset 的会话里可见）。
- **升级 dsh 后重基**：`preset\` 是权威副本；按 `preset\agent.cordis.yml` 头部注释的四处改动，
  把新版 shipped `standard` 重新套一遍，再 `install.ps1 -Force` + `verify.ps1`。

## 变更履历

变更履历**全部集中**在 [`CHANGELOG.md`](CHANGELOG.md)：仓库改名与拆分、各插件的版本演进、
`3rdparty\` 与 `vision-switch\` 等退役记录、`workspace-manager` 的清点/删除/会话树演进、
以及 `vision-delegate` 的两次线上事故与修复，都在那里。
技术要点与踩过的坑集中在 [`TECH-NOTES.md`](TECH-NOTES.md)。
本 README 只描述**当前状态**，不维护历史条目，也不重复踩坑细节。
