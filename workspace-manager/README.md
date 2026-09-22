# dsh-workspace-manager

非侵入式 DSH（DeepSeek Harness）Web 插件，两件事：

1. **工作区行菜单加「关闭」** —— 在官方「重命名 / 删除」之外多一项；关闭后该工作区
   从**侧栏工作区列表**与**新会话的工作区选择器**两处同时消失（可随时恢复，不删数据）。
2. **设置页「工作区/会话」** —— 顶部报出磁盘上的会话总量（含未分组计数）；列出全部工作区
   （含已关闭的），每个工作区一个**打开**开关（取消勾选 = 关闭/隐藏），可展开它会话列表，
   每个会话一个**归档**开关（勾选 = 归档，取消 = 重新打开）；不属于任何工作区的会话收在一个
   默认折叠的**「未分组」**分组里。**子会话缩进显示在父会话下面**（默认折叠、行尾标「子会话」；
   父子关系跨重启存活：产出方登记 + 本插件从运行时观察到的边会被学进账本），
   删父会话时可一并删掉它的子会话（`cascade`），归档父会话时子会话**随父隐藏**，
   见下文「子会话视图与级联删除」。磁盘上确实有工件的会话行还多一个**「彻底删除」**按钮：
   二次确认后连磁盘数据一起删掉，**不可恢复**（归档 ≠ 删除），
   见下文「为什么『彻底删除』是文件级实现」。

> 早期版本还有一项「会话跨工作区移动」，**DSH 0.1.5 起已整体移除**
> （不是隐藏入口，是功能不再存在），原因见下文「为什么没有『会话跨工作区移动』」。

---

## 非侵入性契约

本插件**不做**以下任何事：

- 不替换、不 `disabled` 任何内核行（`workspace`、`session-projection-cache`、`ui-*` 全部原样）；
- 不注册也不 shadow `sidebar.workspaces` / `conversation.hero.workspace` 等任何槽位；
- 不 disabled 任何官方设置项、不接管任何官方组件；
- 不写 `localStorage`（状态在宿主侧，见下）；
- 宿主半区**零 npm 依赖**（只用 node 内置模块 + cordis 注入的服务）。

它**只做**五件事：

| # | 接缝 | 用途 |
|---|---|---|
| 1 | 一个自有 RPC 端点 `/dsh-workspace-manager`（`authority: 'trusted-host'`） | 关闭集合读写、归档/恢复、会话清点（含会话树）与彻底移除（含级联） |
| 2 | 包装 `ctx.workspaces.list` 这**一个**模型的 `getSnapshot()`/`subscribe()` | 过滤 `items` + 并入 `archivedSessionIds` |
| 3 | 往 `settings.section`（`list` 槽）**新增一项** | 「工作区/会话」页 |
| 4 | 一个 DOM 注入（捕获阶段 click，只往已打开的 `[role="menu"]` 里插一项） | 工作区行菜单的「关闭」 |
| 5 | **发布**一个宿主服务 `ctx.provide('sessionRemoval', …)` | 把「彻底删除」那套机制开放给**其它插件**（见下文「给其它插件用的删除机制」） |

### 本插件不提供「会话跨工作区移动」

要换工作区，请在目标工作区里新建会话。0.1.5 上这件事已经**不可能安全做到**
（持久化契约只剩 `create/open/stat/list/flush`、日志 append-only、会话归属由日志头 `cwd` 决定、
artifact 容器没有公开长度索引）——完整论证见 [`../TECH-NOTES.md`](../TECH-NOTES.md) §1.10，
移除经过见 [`../CHANGELOG.md`](../CHANGELOG.md)。

### 为什么一个模型包装就够

- 侧栏浏览器（占 `sidebar.workspaces`）与**新会话选择器**（占
  `conversation.hero.workspace`）**都**通过 `useWorkspaces` 选择器读
  `WorkspaceListState`（证据：`dsh-client-ui-workspace/lib/types/client/WorkspacePicker.d.ts:24`
  的 `useWorkspaces: SnapshotSelectorHook<WorkspaceListState>`）。所以过滤 `items`
  会让"关闭的工作区"在两处同时消失。
- `archivedSessionIds` 由侧栏的 `sessionVisible()` 消费（分组树 / 平铺列表 / 搜索
  三处，证据：`dsh-client-ui-workspace/lib/client.js:100/156/161/228/262`）。
- 参考稳定性是硬要求（React `useSyncExternalStore`）：投影按
  `{原始快照身份, 关闭集合版本}` 记忆化，无变化时**返回原对象本身**。

### 为什么会话要"动态"隐藏

官方 `groupByWorkspace()` 只统计**可见**工作区名下的会话，其余全部塞进「未分组」。
所以只摘掉工作区会让它的会话变成一堆无主条目。本插件按**当前**归属动态计算
（不是关闭那一刻的快照），因此：

- 关闭期间**新建**的会话会一起隐藏；
- 归属到该工作区名下的会话（例如早先由第三方移动插件搬进去的）也会一起隐藏；
- 不会产生孤儿。

### 归档语义（与内核完全一致）

- **归档**：调内核官方 `WorkspaceRegistry.archiveSession(id)`（带存在性校验）。
  官方**会话行**菜单里本来就有「归档」（`rename`/`fork`/`archive`，
  见 `dsh-client-ui-workspace/lib/client.js:766-768`），本插件的设置页开关与它同源同语义，
  只是**多提供反向路径**。
- **重新打开**：内核没有反向动词（0.1.1-rc.2 全仓库搜不到 unarchive），因此用注册表
  **自己的写链**去掉该 id：`enqueueOperation` + `setState({...state, archivedSessionIds: 去掉后的数组})`。
  storage domain 的写路径是"先落盘 → 再改内存 → 再 `emit('domain/changed')`"
  （`dsh-storage-domain/lib/index.js:87/205`），api-proxy 订阅该事件、对比前后集合后推
  `host/archived-sessions-changed` 帧（`dsh-host-apiproxy/lib/index.js:3644-3671`），
  于是**所有浏览器/标签页同步恢复显示**。
- 能力守卫：这三个方法不在 Service Definition 接口里；`typeof` 探测失败时
  `canRestoreArchive=false`，设置页把归档开关置为禁用并给出说明，绝不假装成功。

**实测证据**：`test/unarchive-offline.mjs` 用内核真实的 `WorkspaceRegistry` 类与
**你真实的状态文件副本**跑 27 项检查，证明移除 id 能落盘、能通过内核自己的
`validateStoredState` 与 zod schema、`workspaces` 表逐字节不变、会话日志仍在、
且会触发 apiproxy 的差异判定。

### 为什么「彻底删除」是文件级实现

**0.1.5 没有删除会话的写面。** `dsh-session-persistence` 只声明
`create / open / stat / list / flush` 五个方法（连读改原始 artifact 的接口都没有，
见上文「为什么没有『会话跨工作区移动』」），官方 session RPC 的动词表里也没有删除
（`list`/`search`/`create`/`selectModel`/`modelCatalog`/`openWorkspacePath`/`rename`/
`fork`/`prompt`/`attachment`/`updateQueue`/`cancel`/`page`）。
而一个会话的**全部持久状态**就是 `$DSH_HOME/sessions/<projectKey>/<sessionId>/`
这一个目录（外加一份可重建的投影缓存）——注册表下次扫描时自然就不再列出它。
所以「彻底删除」**等价于把这个目录删掉**：不需要任何内核写面，也不需要新契约。

本能力涉及两个端点（插件一共 8 个端点，见第 1 节）：`inventory`（只读清点，返回 `sessions`（含 `workspaceId`/`bytes`/`archived`/
`active`/`removable`/`reason`，以及会话树的 `parentId`/`kind`/`orphan`）、`totals`、
`sessionsRoot`）与 `remove`（`{ sessionId, cascade? }` →
`{ removed, bytes, prunedProjects, archiveCleared, removedIds, childrenRemoved, skipped, ...state }`）。

一次 `remove` 会清掉这些东西（`removed` 逐项 `{ path, kind, bytes }`）：

| 目标 | 路径 | 说明 |
|---|---|---|
| 会话工件目录 | `sessions/<projectKey>/<sessionId>/` | 按目录名精确匹配；同 id 出现在多个项目键下时**全部**清掉 |
| 投影缓存 | `storages/session_projcache/sessions/<sessionId>.json` | 可重建，但留着就是孤儿 |
| 旧移动插件备份 | `session-workspace-backups/<sessionId>` | 早期第三方 `dsh-session-workspace` 搬家留下的副本，不删就是孤儿数据 |
| 空项目目录 | `sessions/<projectKey>/` | 删空后顺手 `rmdir`（只是 cwd 的分组壳，注册表需要时会自己重建） |

**不碰** `attachments/`：它是内容寻址存储（`attachments/v1/objects/…`），
对象可能被别的会话共用，所以删会话释放的字节数**不包含附件**。

安全边界（全部在触碰任何文件**之前**判定，逐条都有单测）：

- **活跃会话一律拒绝**（`session-active`）：`ctx.sessions.get(id)` 或 `ctx.agents.get(id)`
  还持有句柄时先报错，让你切走再删——写租约还在的工件不能从底下抽掉。
  这两个服务在 `inject` 里；它们若缺失，判定阶段就会抛错、整个请求失败，
  **不会**退化成"都算不活跃"然后把正在跑的会话删掉。
- **id 必须能安全地当目录名**：`^[A-Za-z0-9][A-Za-z0-9._-]*$`、不含 `..`，且解析后的路径
  必须仍在 `sessions` 根之内（防目录穿越、防前缀误伤），否则 `bad-request`。
- **找不到工件就报 `session-not-found`**，绝不"猜一个路径"去删。
- **先摘官方归档集合再删文件**：归档集合里还留着这个 id 的话，会变成指向已删会话的孤儿条目，
  所以 `remove` 会先把该 id 从内核归档集合里去掉（返回的 `archiveCleared: true` 表示确实摘了）。

设置页据此展示：以**磁盘清点**为准列出会话（注册表的 `sessionIds` 只认得本次运行见过的会话），
`removable !== true` 的行按钮置灰并在 `title` 里给原因（`session-active` → 中文「仍活跃」，
`unsafe-id` → 不能安全当目录名）；磁盘上没有工件的行不显示删除按钮（没什么可删）。
点得动的行会弹一个确认对话框，报出体积、说明**不可恢复**、并点明「归档 ≠ 删除」；
父会话有子会话时，确认框还会列出「将一并删除 N 个子会话（约 X）」再让你确认。

### 子会话视图与级联删除（`parentId` / `kind` / `orphan` / `cascade`）

**父子关系是哪来的。** 内核**没有**"谁是谁的子会话"这份落盘数据：子会话的投影缓存
（`storages/session_projcache/sessions/<id>.json`）里 `record.identity` 只有
`formatVersion`/`createdAt`/`cwd`/`isSeeded`/`inheritedEventCount`，没有指回父的字段。
所以这份关系只能由**本插件自己记**，有**两个生产者**、落进同一个账本
（`$DSH_HOME/dsh-workspace-manager.claims.json`，见下文「状态文件」）：

1. **生产者登记**（`source: 'claim'`）—— 调用方在 `sessionRemoval.claim()` 里带上
   `parentSessionId`（`dsh-vision-delegate` 就是这么做的，见它的 README）。**权威来源**；
2. **运行时观察的提升**（`source: 'observed'`）—— 平台自带的 `subagent` / `subagent_fork`
   工具**不走** `claim()` 登记（那是本插件的服务，内核不知道），这类子会话的父关系本来只活在
   当前进程的内存里、`dsh web` 一重启就没了。所以插件把**此刻在运行时列表里还看得到的**边
   "学"进账本：`apply()` 启动时提升一次，之后**每次 `inventory`**（设置页每次打开都会清点）
   顺手增量提升一次，同一进程内按 `子→父` 去重（不重复 diff、不重复写盘）。

合成会话树的优先级（从强到弱）：**登记 > 运行时内存 > 观察**
（`ctx.sessions.list()` / `ctx.agents.list()` 的 session header 里的 `parentSession`，
`dsh-session/lib/types/types.d.ts:71` —— 尽力而为：拿不到就少一条边，不报错、不降级成别的行为）。
**观察条目刻意排在运行时之后**：它是"运行时快照的持久化镜像"，只在运行时读不到时（刚重启）
才顶上 —— 所以提升**不会改变**进程内 `inventory` 看得见的关系（那仍然走"登记 > 运行时"），
也堵掉了"账本里一条过期的观察边盖住当前运行时事实"的可能。
提升**只写"观察"条目**：某个 id 已经被 `claim` 登记过时，观察到的边**绝不改写**它的
`owner`/`parentSessionId`（登记优先）；反过来，登记落到纯观察条目上会把它升级成登记条目、
并保留已观察到的父指针。提升失败（读不了/写不进账本）**只告警**，绝不影响 `inventory` 的返回值。

> **边界（明说）**：父子关系覆盖 **①产出方插件登记过的**（`claim`）与 **②此刻还能在运行时
> 列表里看到、因而被提升进账本的**子会话 —— 后者包括本功能上线**之前**产生、但此刻仍在
> 运行时列表里的子会话（会话头里带 `parentSession` 就够）。
> **真正读不到的会话不追认**：进程早已结束、会话头已经拿不到 `parentSession` 的历史遗留
> 裸 UUID 会话**不会自动建树，也不做任何推断** —— 它们照常按「子会话（父未知）」显示
> （裸 UUID 形态即 `kind: 'subagent'`，`parentId: null`），**不掉行、不报错**。
> 本版本**故意不解析会话日志兜底**：虽然 v3 事件流里确实有据可查
> （父日志的 `subagent/catalog` 事件带 `data.childId`，子会话 v3 的首个 `session` 事件带
> `parentSession`），但那是"将来若要追认"的路，不是现在的语义。

**三个字段的含义**（`inventory` 的每一行）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `parentId` | `string \| null` | 解析成功的直接父会话（父行在清点里且同一工作区）；解析不到就是 `null` |
| `kind` | `'subagent' \| 'session'` | **裸 UUID 形态**（`subagents.start()` 返回的 `run.id`）**或**有父指针 → `subagent`；否则 `session` |
| `orphan` | `boolean` | **声明了父、但父行不在清点里**（登记指向一个已经删掉的父）。没有父指针 ≠ 孤儿 |

**设置页的展示**：子会话缩进显示在父会话下面（默认折叠，父行带展开箭头与子会话计数），
行尾标「子会话」；孤儿与跨工作区的子会话照常留在顶层（不掉行），只是不缩进。

**级联删除**：`remove` 的 `cascade` **可选、默认 `false`**（默认行为与以前逐字相同）。
`cascade: true` 时：

- **先删子、后删父**（按深度从大到小），返回 `removedIds`（删除顺序）与 `childrenRemoved` 便于核对；
- **任一子孙活跃就整体拒绝**（`session-active`）——**一个字节都不删**，父也留着：半个级联比不级联更难收场；
- **只在同一工作区内连带**：跨工作区的子孙留在磁盘上，逐个记进 `skipped`
  （`{ id, reason: 'different-workspace' }`）。`workspaceId === null`（未分组）彼此算同一工作区；
- 计划只建立在**磁盘清点行 + 登记表**之上（做计划时不碰任何文件），所以"拒绝"不会留下半个级联；
- 子孙的工件落在**别的项目键**下也照删（删除按 id 找目录，不按项目键）；
- 孤儿从不属于任何子树，因此永远不会被别人的级联波及；
- 环（登记互相指向）在合成阶段就被**确定性断开**（环里 id 最小的那条父边），并告警一次。

宿主服务 `sessionRemoval.remove()` **永远不级联**：它删的是"某个插件自己的临时会话"，
顺手连带一串它不认识的会话是危险的。级联只发生在用户在设置页显式确认的那一次。

**归档父会话 = 子会话随父隐藏（不是官方级联归档）**：子会话通常**不在**注册表
`sessionIds` 里，内核的 `archiveSession` 会直接拒，所以本插件只走自己现成的隐藏机制 ——
把"归档父会话名下的全部子孙"并进客户端的 `archivedSessionIds` 视图（官方
`sessionVisible()` 负责过滤，侧栏据此隐藏）；取消归档后并集自然收缩，子会话立刻恢复。
内核归档集合里**只有父会话那一个 id**（可以自己核对：设置页归档父会话后，
`host/archived-sessions-changed` 帧带来的集合里没有子会话）。设置页里子会话仍会列出
（带「随父归档隐藏」标记），便于取消归档后立即看到它们回来。

**`attachments/` 依旧不碰**：级联删的是会话工件目录、投影缓存、旧移动插件备份，
内容寻址的附件对象可能被别的会话共用，与单会话删除完全一致。

---

## 给其它插件用的删除机制：`sessionRemoval` 宿主服务

「彻底删除」不只是设置页上的一个按钮 —— 它同时是本插件**对外的机制**。需要清理临时会话的
插件（例如 `dsh-vision-delegate`：每次视觉委派都会 spawn 一个临时视觉子会话）只要调用这个
服务，不必自己再写一份文件级删除（内核没有删除面，自己写等于把下面这堆栅栏重新踩一遍）：

**机制归本插件，策略归调用方。** 本插件知道"怎么安全地删"；"哪些会话是我的临时会话、
什么时候算完事"只有调用方知道（进程崩溃/异常退出留下的孤儿，也要靠调用方自己的账本补删）。

发布与获取（本版本 DSH 里插件间共享服务的实际做法，cordis 原语）：

```js
// 提供方（本插件，在 apply() 里；随本插件 fiber 一起卸载）
ctx.provide('sessionRemoval', { claim, release, claimsOf, remove })
// 消费方（其它插件）
const removal = ctx.get('sessionRemoval')   // 探测式获取；undefined = 服务不在
```

> 消费方**不要**把 `sessionRemoval` 写进模块级 `inject`：本插件没装（或版本不匹配）时，
> cordis 会把消费方那一行整个 parked，它的功能会跟着一起消失。只有探测式获取才能优雅降级。
> 宿主半区的 `ctx.provide` / `ctx.get` 都在 DSH 的宿主动词白名单里
> （证据：`dsh-cordis-host-runner/lib/index.js:1083-1092`）。

服务面（方法都可能抛 `SessionRemovalError`，错误对象带 `code`）：

| 方法 | 语义 |
|---|---|
| `claim(owner, ids, { parentSessionId? })` | 登记"这些会话是我产出的"（+ 可选**父会话指针**） → `{ claimed, alreadyClaimed, parentUpdated, rejected }` |
| `release(owner, ids)` | 撤销登记（调用方放弃清理、或发现会话不是自己的时用） → `{ released, notClaimed }` |
| `claimsOf(owner)` | 该 owner 当前登记着的 id（副本） |
| `remove(id, { owner })` | 删除一个**已由该 owner 登记**的会话，返回与端点 `remove` 相同的报告（**不级联**） |

**服务面版本 2**：`claim`/`release` 是**异步**的 —— 登记（含父子关系）要**落盘**才能跨重启成立，
否则重启后设置页的会话树与"删父连带子会话"都会失去依据。改动在 `await` 之前就已写入内存，
所以调用方万一忘了 `await`，进程内的白名单判断依然正确；落盘只是跨重启的那一半。

`parentSessionId` 只在**显式给出**时改写：补删路径（启动时按自己的账本重新登记）不带父，
**不会**把第一次记下的父指针抹掉。自引用（父 = 自己）在登记处就被拒（`reason: 'self-parent'`），
形态不安全的父指针报 `bad-request`（不静默丢弃）。

账本里还会有本插件自己**观察**学到的条目（`source: 'observed'`，见下文「状态文件」）——
它们**没有 `owner`，不算"别人登记过"**：`claim` 会把这样的条目**升级**成登记条目（报进
`claimed`），这次没显式给父时保留已观察到的父指针。反过来，观察到的边永远改不动已有登记。

`remove` 与端点走**同一个实现**（`removeSessionWithContext()`），所以归档条目摘除、工作区
记账摘除、投影缓存与旧移动备份的清理完全一致 —— 不存在"服务这条路删得比较糙"的可能。

安全栅栏（全部在触碰任何文件**之前**判定，逐条都有测试）：

- **`owner` 必填**（非空字符串）：没有 owner 就没有白名单 → `bad-request`；
- **只能删自己登记过的 id**：没登记过、或登记在别的 owner 名下 → `not-claimed`，
  磁盘一个字节都不动。这条挡的是"插件之间意外互删"；
- **活跃会话一律拒绝**（`session-active`）：`ctx.sessions.get(id)` 或 `ctx.agents.get(id)`
  还持有句柄时先拒绝（活会话的工件被抽掉会写坏）；
- **id 形态、路径 containment、不碰 `attachments/`**：与端点同源，见上文安全边界；
- **工件早就不在** → `session-not-found`（调用方按"已清理"处理即可），同时登记被释放。

> **诚实说明**：`owner` 是**协作式栅栏，不是安全边界** —— cordis 的服务调用不带调用方身份，
> 名字由调用方自报。它能挡住"插件之间的意外互删"，挡不住故意冒充。
> 想删任意会话（包括别的插件的）仍然只有设置页那条路 —— 那条路需要用户本人点确认。

---

## 状态文件

```
$DSH_HOME/dsh-workspace-manager.state.json          # 「已关闭工作区」集合（客户端下发的那份）
$DSH_HOME/dsh-workspace-manager.claims.json         # 「子会话登记」表（父子关系 + 白名单）
```

两份文件都沿用你现有插件的约定（与 `dsh-provider-toggle.state.json` 同级）。原子写
（临时文件 + fsync + rename），写入串行化；文件损坏/缺失时按空集合启动，
不阻断 dsh 启动。

```jsonc
// dsh-workspace-manager.state.json
{ "version": 1, "closedWorkspaceIds": ["<workspace-id>", "..."] }
```

```jsonc
// dsh-workspace-manager.claims.json（按 id 排序写出，便于人工核对"树为什么长这样"）
{
  "version": 2,
  "claims": {
    // source: 'claim' —— 某个产出方插件调 sessionRemoval.claim() 登记的（权威来源）。
    "338c519c-0b02-462e-98d9-3d4e4dabc0e5": {
      "owner": "dsh-vision-delegate",
      "parentSessionId": "session-dc1ddf05-acce-4271-a08a-f610a61820ef",
      "source": "claim",
      "claimedAt": 1789982216327
    },
    // source: 'observed' —— 运行时观察到的边被"提升"进来的：**没有 owner**
    // （它不是任何人的产物），observedAt 是第一次学到这条边的时间。
    "4d0e7c2c-7f1a-4a3d-9a2f-0d1c2b3a4e5f": {
      "parentSessionId": "session-dc1ddf05-acce-4271-a08a-f610a61820ef",
      "source": "observed",
      "observedAt": 1789982217000
    }
  }
}
```

**`source` 字段（条目来源，v2 起）与向后兼容**：

| `source` | 谁写的 | 有没有 `owner` | 语义 |
|---|---|---|---|
| `'claim'` | 产出方插件的 `sessionRemoval.claim()` | 有（白名单键） | **权威**：观察学到的边永远改不动它 |
| `'observed'` | 本插件的提升（`apply()` 启动 / 每次 `inventory`） | 没有 | 运行时观察到的父子边，只用来在**重启后**仍然建树 |
| 缺失（v1 老文件 / 手工编辑） | —— | 按 `'claim'` 读 | v1 只可能是登记写出来的，所以缺省就是 `'claim'` |

- **登记优先**：合并时观察条目绝不覆盖已有登记（`owner` 与 `parentSessionId` 都不动，
  连文件都不重写）；登记条目落到纯观察条目上则把它升级成登记条目。
- **幂等**：只有真有新增/变化才落盘（时间戳不参与比较）—— 反复提升、反复 `claim`
  同一条边都不会重写文件、也不会产生重复条目。
- 认不出的 `source`（更高版本写的新值）按缺省处理 = `'claim'`；`source: 'observed'`
  却没有合法父指针的条目直接丢弃（观察条目的全部信息就是那条边）。
- v1 → v2 **无需迁移**：老文件读得回来；**只要内容没有真的变化，插件不会顺手把它重写成 v2**
  （下次真的学/登记到新东西时才会按 v2 写出）。

**为什么登记表另开一个文件**（而不是塞进 `dsh-workspace-manager.state.json`）：

1. `openClosedStore().persist()` 会把**它自己的内存副本**整篇写回。登记表若住在同一个文件里，
   两个长期存活的写入者会互相覆盖（典型的丢更新），而两者谁都不该被对方拖住；
2. 语义与消费者不同：关闭集合是整篇下发给客户端的视图状态（`state` 端点原样返回），
   登记表是 `sessionRemoval` 服务自己的账本（逐条增删、给别的插件用）；
3. "容忍旧格式"因此变成免费：**旧文件原样不动**（`parseState` 本来就忽略未知字段），
   新文件缺失即空表。登记表本身也容忍异形内容：损坏 JSON / 缺字段 / `claims` 是数组 /
   `version` 更高 / `source` 缺失或认不出 / 父指针缺失或不安全 —— 一律"能读多少读多少"，
   绝不抛错阻断启动。

已删除工作区的残留记录会在每次读取状态时自动清理（关闭只是本插件的视图层概念，
不影响内核注册表，所以仍存在的工作区一定在列表里）；被删除的会话，其登记也在删除时
一并清掉（否则登记表会一路长下去）。

---

## 安装（本地目录 link，与你的其它插件一致）

```powershell
# 1. junction 进 profile
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-workspace-manager" `
  -Target "E:\JavaScript\dsh-enforce\workspace-manager"

# 2. profiles\web\package.json 的 dsh.profile.bundles 追加一行
#    "dsh-workspace-manager"
```

宿主半区零依赖，所以**不需要 pnpm**，也不需要为裸导入 `@deepseek-ai/*` 准备一层
`node_modules` 闭包（本插件从不裸导入官方包）。

**重启 dsh web 后生效**（客户端 bundle 在服务器启动时进入 boot manifest，热加载覆盖不到）。

---

## 重启后的验收清单（30 秒）

**第 0 步（机器可验证）**：确认服务器已经把你的客户端半区挂上 boot manifest：

```bash
node E:\JavaScript\dsh-enforce\dev\tools\probe-runtime.mjs
# 期望：dsh-workspace-manager  status=200 ... // dsh-workspace-manager v0.1.0 — 由 scripts/build-client.mjs 生成
#        boot manifest: 含本插件？ 是
# 重启前实测：:3080 为 404 且 manifest 里是旧插件 dsh-session-workspace；
#             隔离冷启动实例（同组合）为 200 且 manifest 含本插件。
```

> 这些验证脚本放在仓库根的 `dev\` 下（`dev\tools\` 工具、`dev\research\` 调研、`dev\logs\` 证据日志、
> `dev\tmp\` 隔离实例）。`dev\` 整体**不进版本库**（`.gitignore`）——master 只保留完整可用的插件。

然后：

1. 侧栏工作区行的 ⋮ 菜单里，除了重命名/删除多了**「关闭」**；点它 → 该工作区从侧栏消失，
   其会话也不出现在「未分组」里。
2. 新建会话 → 工作区选择器里**不再列出**已关闭的工作区。
3. 设置 → 左侧出现**「工作区/会话」**：该工作区显示为未勾选「打开」；勾回去 → 侧栏立刻恢复。
4. 在同页展开一个工作区 → 会话列表出现；勾一个会话的**「归档」** → 它从侧栏消失；
   取消勾选 → 立刻回来（这一步同时验证 `host/archived-sessions-changed` 帧链路）。
5. 同页顶部显示「磁盘上共 N 个会话、X MB；其中未分组 M 个…」（数字应与
   `$DSH_HOME\sessions\` 下的实际目录相符）；展开默认折叠的**「未分组」**分组，
   能看到不属于任何工作区的会话（旧仓库路径、临时目录等）。
6. 挑一个**不在运行中**的会话点**「彻底删除」** → 弹确认框（报出体积、写明不可恢复、
   点明归档 ≠ 删除）→ 点「确认删除」→ 该行消失、顶部总量减少，
   且 `$DSH_HOME\sessions\<项目键>\<会话 id>\` 确实没了。
   当前正在跑的那个会话按钮是灰的，鼠标悬停显示「仍活跃」。

任一步不对：先看浏览器控制台（`dsh-workspace-manager` 前缀），再看 `dsh web` 终端输出。

---

## 测试

```bash
npm test        # 构建客户端 bundle + 全部离线测试
npm run check   # 语法检查
```

| 文件 | 覆盖 | 项数 |
|---|---|---|
| `test/offline.mjs` | 隐藏规则、投影（引用稳定性/订阅/还原）、宿主状态（原子写/幂等/容错/并发串行化） | 51 |
| `test/host-rpc.mjs` | `apply()` 注册契约、端点分发、payload 严格校验、归档/恢复、能力降级、磁盘清点与彻底移除（活跃拒绝/不安全 id/幂等/归档条目摘除）、**会话树的 `parentId`/`kind`/`orphan` 与级联删除（先子后父/活跃子孙整体拒绝/跨工作区不连带/默认不级联）** | 48 |
| `test/session-tree.mjs` | **会话树纯规则与宿主合成**：子会话 id 形态、建边规则（父行在+同工作区）、共享的 `childrenIndex`/`topLevelRows`/`hiddenByArchivedParentIds`、登记表解析的格式容忍（含 `source` 缺省/认不出/纯观察条目）、孤儿/自引用/环防御、跨项目键、登记优先于运行时、`planCascade` 的先子后父与跨工作区跳过、`collectRuntimeEdges` 的优雅降级 | 23 |
| `test/runtime-promote.mjs` | **运行时观察到的父子边 → 账本（提升）**：观察边落盘（`source: 'observed'`、无 owner、带时间戳）、只用账本重建树（模拟重启）、合成优先级（登记 > 运行时 > 观察）、**观察边不覆盖已 claim 的 owner/父**、幂等（第二次不写盘/不重复条目/不重写 v1 文件）、升级观察条目、自引用/环/不安全 id 防御、历史会话不提升、`apply()` 启动提升不阻塞不抛错、每次 `inventory` 增量提升、`sessions.list()` 抛错与写盘失败都只告警 | 16 |
| `test/session-removal.mjs` | **`sessionRemoval` 宿主服务**：发布契约与优雅降级（`provide` 缺失 / 服务名被占用）、白名单（claim/release/跨 owner 拒绝）、活跃拒绝、不安全 id、与端点同源（归档条目与工作区记账摘除、`attachments/` 不动）、**父指针落盘与跨重启读回、重复 claim 不抹父、自引用与非法父指针、旧/异形格式容忍** | 30 |
| `test/client-harness.mjs` | **整条客户端链路**：真实 `lib/client.js` 载入最小 DOM + 迷你 React，RPC 接真实宿主处理器；含设置页渲染/勾选交互、删除链路（点删除 → 确认 → 真实 `remove` → 磁盘工件与投影缓存消失 → 清点刷新）、**子会话树（缩进/默认折叠/展开）、删除确认框的"将一并删除 N 个子会话"、归档父会话时子会话随父隐藏并可逆**、一个行菜单 DOM 注入（并断言会话行菜单里没有本插件的项）、契约变化的可诊断性 | 52 |
| `test/transport.test.mjs` | 传输通道（官方 `rpc.handle` 优先、0.1.5 上退回自建 prefix 路由）、通道名白名单与路径穿越、信任栅栏 403、404/415/400 与信封级 bad-request | 15 |
| `test/remove-session.test.mjs` | 项目键换算、安全 id 判定、磁盘清点与归属（含未分组）、工件定位、删除清单（保留 `attachments/`、清投影缓存与旧移动插件备份、收掉空项目目录） | 9 |
| `test/unarchive-offline.mjs` | 用**内核真实类** + 真实状态文件副本验证"移除 id 可恢复归档" | 27 |

合计 **271 项**（会话树相关共 +70：host-rpc +11、session-tree +23、session-removal +11、
client-harness +9、runtime-promote +16）。

### 真实运行时验证（隔离实例）

上面都是离线测试。要让宿主半区走**真实 HTTP 传输 + 真实内核**跑一遍，用 `dev\tools\` 下的三个脚本
（它们不属于插件包，是验证工具；`dev\` 不进版本库）：

```bash
# 1) 建隔离副本：独立 DSH_HOME（真实 home 只被读取，凭据不复制）
node E:\JavaScript\dsh-enforce\dev\tools\setup-bootcheck.mjs

# 2) 冷启动一个真实实例（独立端口、不弹浏览器）
$env:DSH_HOME='E:\JavaScript\dsh-enforce\dev\tmp\bootcheck'
node D:\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 3181 --no-open

# 3) 跑验证（自带就绪等待；会打 3181，默认拒绝打到 3080 以免改动真实数据）
node E:\JavaScript\dsh-enforce\dev\tools\verify-runtime-rpc.mjs 3181 E:\JavaScript\dsh-enforce\dev\tmp\bootcheck

# 4) 清理
node E:\JavaScript\dsh-enforce\dev\tools\setup-bootcheck.mjs --remove
```

覆盖：

- **真实传输层**：`POST /dsh-workspace-manager/<method>` 的真实信封（`{type:'client-request',rpcId,method,payload}`）；
  GET→404、错 content-type→415、`method` 与路径不一致→信封级 bad-request。
- **信任栅栏**：伪造跨站 `Origin` → **403**（证明没有绕过 `authority: 'trusted-host'`）；
  本机进程不带 Origin → 通过。证据：`dsh-client-connection/lib/index.js:186-197/249-256`。
- **真实内核注册表**：`canRestoreArchive: true`，读出**你真实的归档会话集合**。
- **真实磁盘清点与删除**：`inventory` 的逐行归属/体积/`removable` 与 `totals` 自洽
  （未分组计数与字节数逐行核对）；`remove` 对不安全 id、不存在的会话、活跃会话分别报
  `bad-request` / `session-not-found` / `session-active`；再临时播种一个会话、删掉它并核对
  **工件与项目目录都没了、`totals` 回到删除前、再删一次仍是 `session-not-found`**（不留残迹）。
- **真实存储域写入**：`close`/`open`/`unarchive`/`archive` 都会跨请求读回一致（确实落盘）。

`test/unarchive-offline.mjs` 只读你真实的状态文件（结束时校验哈希未变），
其余测试都在临时目录里跑。

---

## 已知边界

- **行菜单注入依赖官方行的 DOM 契约**：只注入工作区行 —— 它是
  `[role="treeitem"][aria-expanded]` 且 fiber props 里有 `group.workspaceId`（`ProjectRowItem`）。
  真正的闸门是 fiber props（`group.workspaceId`）：官方另有 3 处 `aria-expanded`
  （会话分组折叠、搜索区折叠）都不是 `role="treeitem"`，即使被误判也取不到 workspaceId，不会注入。
  dsh 升级若改这些结构，菜单项会**静默消失**（不会误注入到别的行、也不会报错）。
  设置页不受影响。
- **注入项插在第一个菜单项之后**（工作区菜单：重命名 → 关闭 → 删除），
  沿用例子里已验证过的做法。
- **多标签页同步**：宿主帧会实时同步归档状态；「关闭集合」由本插件自己的 RPC 维护，
  另一个标签页在你切回它（window focus）时对账。单标签页无感。
- **投影是"包装同一个模型对象"**：`createSnapshotStore()` 返回**对象字面量**
  （`dsh-client-runtime/lib/client.js:5415`），方法都是自有属性、没有原型可回退。
  因此卸载插件时 `dispose()` 是把原函数**赋回去**（不是 `delete`），否则 `getSnapshot`
  会变成 `undefined`，仍在订阅的组件一读就崩。已由测试覆盖。
- **契约变化的可诊断性**：万一 dsh 升级改了工作区行组件的 props 名，插件不会静默什么都不做，
  而是告警一次（`[dsh-workspace-manager] 无法从工作区行解析 id…`），
  提示对齐 `ProjectRowItem({ group })` 检查；
  「未分组」桶（`group` 在、只是没有 `workspaceId`）属正常情况，不告警。
- **归档恢复依赖注册表内部方法**（`enqueueOperation`/`requireState`/`setState`）。
  dsh 若改名，插件降级为"只读展示"，不会破坏归档数据。
- **彻底删除是本插件直接操作磁盘**（内核没有删除面，理由见上文）。它只认
  `sessions/<项目键>/<会话 id>/` 这个布局：dsh 若改了目录结构，插件会报
  `session-not-found` 而**不会**按猜的路径删——宁可删不掉，也不删错。
- **`attachments/` 不做引用计数**（内容寻址、可能共用），本插件无从知道某个附件对象
  还被谁引用，所以宁可留着：删掉一个会话后磁盘占用**不会**完全归零，
  要回收这部分空间得等内核自己提供 GC 或官方删除面。
- **会话树的父子关系有两个来源，且都不推断历史**：生产者登记的 `parentSessionId`
  （`sessionRemoval.claim()`）+ **运行时观察到的边被提升进账本**（`source: 'observed'`：
  `apply()` 启动一次、每次 `inventory` 增量一次）。因此**只有两种子会话会进树**：
  ① 产出方登记过的（下一次产出时带上父指针即可）；② **此刻在运行时列表里还看得到**
  （会话头带 `parentSession`）的 —— 后者包括本功能上线**之前**产生、但此刻仍在运行时
  列表里的子会话。**真正读不到的**（进程早已结束、会话头里没有 `parentSession`）**不追认**：
  **不解析会话日志**，它们照常按「子会话（父未知）」列出，不掉行、不报错。
  提升失败（读不了/写不进账本）只告警，不影响清点与删除。
- **观察到的边不会覆盖登记**：某个 id 已被 `claim` 登记过时，提升不改它的 `owner`/父指针
  （登记是权威来源）；反过来登记落到纯观察条目上会把它升级成登记条目。
- **归档父会话只做"随父隐藏"**，不改内核归档集合：子会话通常不在注册表 `sessionIds` 里，
  官方 `archiveSession` 会拒。侧栏的隐藏由客户端的 `archivedSessionIds` 视图并集负责，
  因此**只在装了本插件的浏览器里生效**（这与其他"视图层"能力一致：内核数据不变）。
- **级联删除不跨工作区**：跨工作区的子会话留在磁盘上（`skipped` 里逐个列出原因）。
  这是刻意的边界 —— "删一个工作区的父会话"不该顺手删掉另一个工作区里的数据。

## 卸载

1. 设置页把「打开」全部勾回、把想恢复的会话「归档」全部取消勾选；
2. `profiles\web\package.json` 移除 `dsh-workspace-manager`；
3. 删掉 profile 里那个 junction（用 `rmdir` 只删链接点，别递归删源目录）；
4. 可选：删 `$DSH_HOME/dsh-workspace-manager.state.json` 与
   `$DSH_HOME/dsh-workspace-manager.claims.json`。

注意：卸载插件**不会**把「彻底删除」掉的会话找回来（那是真正的文件删除，不走回收站）。
`attachments/` 里的共用对象也不会因为卸载而被清理。
