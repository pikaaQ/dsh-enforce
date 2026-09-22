# dsh-plugin-toggle

DSH 插件（`E:\JavaScript\dsh-enforce\plugin-toggle`）：**只处理插件管理**——在 shipped 的
「设置 → 插件 → 插件列表」页（ui-settings-plugin-inventory）里，**不新增任何按钮**，
直接复用每张插件卡片行尾**已有的状态徽章**（`configTag`：“已启用 / 已停用”小胶囊，
启用时旁边还有运行状态点 `statusDot`）作为 `停用 / 启用` 开关：点击徽章即切换该
loader 条目的启用状态。

原 `dsh-provider-toggle` 插件 2026 改名 `dsh-provider-manager` 后**只处理模型提供商**，
插件条目开关剥离为本插件。Web 搜索（图灵 Baidu/Tavily）是**独立插件**
`dsh-turing-web-search`（`E:\JavaScript\dsh-enforce\turing-web-search`）。三者各自独立安装/卸载。

## 功能

- **点击卡片行尾状态徽章即开关**：每张插件卡片行尾的 `configTag` 徽章显示当前状态
  （“已启用”/“已停用”），点击它（或 Tab 聚焦后按 Enter/Space）即停用/启用该 loader
  条目（`stopPropagation`，不会触发行卡片“展开详情”），成功后列表自动重拉；
  停用只写入 home patch 的 `disabled: true`，配置保留，重启后依然停用；启用即恢复。
  忙碌（busy）期间徽章半透明并忽略点击。
- **本插件自身条目不生效**：`plugin-toggle` / `dsh-plugin-toggle` 卡片的徽章点击
  退回普通行为（照常展开详情），避免把自己停掉；其它条目（含 `provider-manager`、
  `turing-web-search` 与 shipped 条目）均可开关。
- **官方核心条目保护（现行补丁 v5；该行为自 0.1.1 时代的补丁 v3 起就有，一直未变）**：
  - **T0 硬保护（锁定不可停用）**：维持 dsh 启动 / 传输 / 设置与插件管理入口的行——
    社区默认 18 项（`api-gateway`、`api-remotes`、`connection`、`client-hmr`、
    `client-locale`、`client-modules`、`client-runtime`、`cordis-host-runner`、`hmr`、
    `include`、`locale`、`modules`、`runtime`、`timer`、`ui-settings`、
    `ui-settings-general`、`ui-settings-plugins`、`webserver`）+ web 补充
    （`web-startup`（web 启动依赖：`webserver`/`web-runtime` 注入并引用其
    `ctx.webStartup.*`，停用后 dsh web 无法启动，故列为 T0）、
    `web-runtime`、`cordis-client-runner`（浏览器端 cordis 运行时，停用则整个 UI
    含设置/管理入口不启动）、`plugin-inventory`（插件列表页数据源，停用后管理页
    失效、无法从 UI 恢复自身）、`ui-settings-plugin-inventory`（本管理入口自身）、
    `typert`、`typert-loader`、`typert-gateway`）。这类行的徽章锁定：不可 Tab / 点击，悬浮
    `title` / `aria` 显示保护原因；**host 侧 `setEnabled` 同样拒绝**（同表强制）。
  - **T1 二次确认（高危核心服务）**：`settings`、`credentials`、`llm`、`session`、
    `agent`、`agent-loop`、`tools`、`storage`、`storage-json`、`storage-domain`、
    `workspace`、`web`（另按依赖边扫描补充：`agent-presets`、`agent-default-model`、
    `llm-pi-ai`（本部署唯一聊天 provider）、`subagent`、`session-persistence-jsonl`、
    `attachment-local`、`session-projection`、`system-prompt`、`commands`、`goal`、
    `goal-round-driver`、`skills`——点击徽章先 `window.confirm(原因)`，确认后才停用。
  - 保护只作用于**停用方向**（启用从不拦截）；名单可在条目 config 扩展
    （见下「配置」）；手动编辑 `cordis.patch.yml` / CLI 仍可绕过（官方 patch 语义
    允许，UI 只防误点）。
  - **可管理性（补丁 v4 起，只对「声明行」开放开关）**：清单 entryId 形如 `include:<裸 id>`
    （单层 include 组）的行才是 patch 可寻址的声明行。运行期自建行——`agent-presets`
    嵌套预设实例（`include:agent-presets:*`）与 loader 动态行（hex 如 `d103ba78`）——
    按裸 id 写 patch 只会 no-op 或串到同名基础行，故 **host 一律拒绝**：
    `protection` 判 `blocked`（徽章置灰不可点，title/aria 显示原因），`setEnabled`
    抛 `PLUGIN_TOGGLE_UNMANAGEABLE`；组前缀可用条目 config 的 `manageGroups` 扩展。
- **外层整卡行为不变**：点击徽章以外的任意处仍是 shipped 原有的“展开/收起详情”。
- 特殊配对：停用 `web-search-deepseek` 时，连带给 loader 条目 **`web`** 追加 `config: {}`
  （`PAIRED_CONFIG_ENTRIES = { "web-search-deepseek": ["web"] }`）——那会清空 `web` 条目自己的
  整份 config，其中的 `web.searchProvider` 随之消失；启用时一并还原，保证「搜索关闭 / 打开」语义完整。

## 工作原理

- **loader 条目开关**：状态文件 `$DSH_HOME/cordis.patch.yml`（home 层 user patch，
  加载器 watch + 热加载，任何 profile 生效）。与 `dsh-provider-manager` 共用同一文件：
  本插件管理任意插件条目（含 `web-search-deepseek` 的配对条目），provider-manager 只动
  模型适配器条目（如 `llm-deepseek`），互不覆盖对方关心字段。
- **Host 半区**（`lib/index.js`）：单一 Typert Remote 服务 `PluginToggleGateway`
  （命名空间 `pluginToggle`，名字沿用旧插件，语义即动作）：
  `pluginToggle.setEnabled({ entryId, enabled })`（原子写 patch，tmp + rename 防 HMR
  半截；entryId 先经 `patchIdOf` 做**行身份判定**：非声明行直接抛
  `PLUGIN_TOGGLE_UNMANAGEABLE`，声明行才剥 `include:` 前缀写 patch）+ **只读
  `pluginToggle.protection({ entryId, enabled })`**——对不可管理行无论方向一律返回
  `blocked`；T0/T1 判定与 `setEnabled` 用同一张表（`PROTECTED_IDS` / `CONFIRM_IDS`，
  在 `lib/index.js` 一处维护），`setEnabled` 对 T0 抛 `PLUGIN_TOGGLE_PROTECTED`。
- **Client 半区**（`lib/client.js`）：浏览器端通过 `ctx.remote.$mount` 自挂载客户端描述符
  （`pluginToggle` 命名空间的 `setEnabled` + `protection`），供补丁后的「插件列表」页调用；
  本身不注册任何 UI。
- **「插件列表」页补丁**（`scripts/patch-plugins-inventory-bundle.mjs`，现行标记 `dsh-plugin-toggle-v5`）：
  shipped 卡片行尾本来就有状态徽章与状态点（`statusDot`），补丁**不注入任何新按钮**，
  只给现有徽章附加开关语义——给 `StateTag` 增加可选的 `toggle`，再在两处调用点
  （预设行 / 全局行）传入。开关本身：`role="switch"` + `aria-checked`、动态
  `aria-label`/`title`（T0 / 不可管理行显示原因）、`tabIndex`/`onKeyDown`（Enter/Space，
  上述行摘除焦点）、`onClick`（`isSelfEntry` 排除自身；blocked 直接 return；T1 仅对已启用
  条目在停用前 `window.confirm`；busy 半透明禁点）；`enabled` 非布尔的条件行保持只读徽章。
  清单加载就绪后（以 shipped 清单快照为准）对**全部条目**预取
  `protectionFor(entryId, false)` 驱动上述状态，重拉清单后自动刷新；
  切换调用 `ctx.get("remote").pluginToggle.setEnabled({ entryId, enabled })`，
  成功后重拉清单（loader 对 home patch 热加载后即反映新状态）。
  补丁**幂等**（含当前标记则跳过；检测到旧版补丁标记自动借 `.bak` 回退后重打）、
  **可回退**（`.bak` 备份）、每处替换必须唯一命中否则中止，并自动跑 `node --check` 校验。
  默认目标由 `$DSH_HOME` 推导；给隔离实例打补丁请显式传 `--bundle <该实例里的同名 bundle>`，
  免得动到正在运行的真实 home。
  为什么补丁必须这么写（锚点随 dsh 版本变、重锚经验）见
  [`../TECH-NOTES.md`](../TECH-NOTES.md) §1.6；各版本改了什么见 `../CHANGELOG.md`。

## 配置（扩展保护名单）

默认 T0/T1 名单在 `lib/index.js` 一处维护（`PROTECTED_IDS` / `CONFIRM_IDS`）。
要临时加自己的基础条目，可在 home 层 patch 给本条目补 config（loader 热加载后
`setEnabled` / `protection` 即生效）：

```yaml
- id: plugin-toggle
  config:
    protectedEntries: [my-core-row]     # 追加到 T0（锁定不可停用）
    confirmEntries: [my-service-row]    # 追加到 T1（停用前二次确认）
    manageGroups: [include, my-group]   # 追加可从本页开关的组前缀（默认 include）
```

## 安装（DSH 官方 bundle 层机制，无需 pnpm）

当前已按官方机制安装到 web profile：

```powershell
# 1. 让 loader 从 profile 解析到包：profile 的 node_modules 指向项目目录（junction，编辑即时生效）。
#    $DSH_HOME 默认是 ~/.dsh；<本插件目录> = E:\JavaScript\dsh-enforce\plugin-toggle
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-toggle" -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-toggle" "E:\JavaScript\dsh-enforce\plugin-toggle"

# 2. 在 profiles\web\package.json 的 dsh.profile.bundles 登记包名（已配好，私有插件都在列）：
#      "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
#        "dsh-provider-manager", "dsh-plugin-toggle", "dsh-turing-web-search",
#        "dsh-workspace-manager"] } }
#    包必须声明 dsh.bundle.patch（本包已声明），否则加载器 fail loud。

# 3. 重启 dsh web（bundle 层列表在启动时读取，不像 profile patch 那样热加载）。
```

> 注意：bundles 列表登记后，`profiles/web/cordis.patch.yml` 里**不再有本插件的挂载条目**
> （该文件里现有的 `- insert:` 块属于挂在 patch 层的插件，如 `turing-balance` /
> `vision-delegate`；文件不再要求是空模板），避免与 bundle 层产生重复 id。

## 「插件列表」页补丁（一次性，dsh 升级后需重跑）

```powershell
node scripts\patch-plugins-inventory-bundle.mjs             # 徽章即开关
node scripts\patch-plugins-inventory-bundle.mjs --revert    # 从 .bak 还原
```

- 目标文件：`<DSH_HOME>\profiles\node_modules\@deepseek-ai\dsh-client-ui-settings-plugin-inventory\lib\client.js`
- dsh 升级重装对应包后，若补丁锚点失配，脚本会明确报错中止（不会写坏文件），
  此时按新 bundle 更新脚本中的锚点后重跑。
- 打补丁后**刷新浏览器**（Ctrl+F5）即可生效；bundle 内容按请求实时读取（no-cache），
  无需为补丁本身重启 dsh web（但本插件 host 半区改动仍需重启）。

## 保护名单审计（T0/T1 维护）

`scripts/audit-profile-inventory.mjs`（只读）用官方 `@deepseek-ai/dsh-app-boot` 的组合器
还原指定 profile（默认 `web`）的 loader 最终行表（含 `include:` 组展开与 home patch 覆盖），
`--deps` 再对每个模块的 `lib/index.js` 扫代码级 `inject` / 提供服务，列出依赖边：

```powershell
node scripts\audit-profile-inventory.mjs web          # 最终行表
node scripts\audit-profile-inventory.mjs web --deps   # + 代码级依赖边
```

据此维护 `lib/index.js` 里唯一的一份名单（T0 硬保护 / T1 二次确认，host 与 client 同表）：
- **T0**：loader 组合/配置表达式依赖、传输与远程三层、设置与插件管理入口及其数据源、
  浏览器运行时——停用即无法启动或失去恢复入口；
- **T1**：官方核心服务/注册表/数据面行（session 持久化、附件、agent presets、subagent
  委派、commands/goal/skills 等注册表、llm-pi-ai 等聊天 provider）——停用明显降级但可恢复，
  先 `window.confirm` 再执行；
- 其余（工具行、ui 外观行、provider 适配器、私有插件 UI 条目等）不拦截，保持可自由开关。

## 安装（备选：装了 pnpm 后走官方命令）

```powershell
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-plugin-toggle" -Recurse -Force -ErrorAction SilentlyContinue
dsh plugin --profile web add "E:\JavaScript\dsh-enforce\plugin-toggle"
# 重启 dsh web。pnpm 会安装依赖并自动把 dsh-plugin-toggle 登记进 dsh.profile.bundles。
```

## 卸载

从 profiles\web\package.json 的 `dsh.profile.bundles` 里移除 `dsh-plugin-toggle`（或
`dsh plugin --profile web remove dsh-plugin-toggle`），重启即可；同时建议还原补丁：
`node scripts\patch-plugins-inventory-bundle.mjs --revert`。
`cordis.patch.yml` 里由本插件写下的 `disabled: true` 条目可手动删除以恢复
（也随时可在 UI 里点徽章「启用」）。
