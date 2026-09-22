# dsh-provider-manager

DSH 插件（`E:\JavaScript\dsh-enforce\provider-manager`，原 `dsh-provider-toggle`，2026 改名并
剥离插件管理）：**只处理模型提供商**——「停用 / 启用」做成 shipped
「设置 → 模型」页（ui-settings-models）**底部的面板**（官方插槽 `settings.models.footer`），
不新增目录 / tab、也**不修改官方 bundle**。

插件条目（loader 条目）的「停用 / 启用」已剥离为**独立插件** `dsh-plugin-toggle`
（`E:\JavaScript\dsh-enforce\plugin-toggle`）；Web 搜索（图灵 Baidu/Tavily）是**独立插件**
`dsh-turing-web-search`（`E:\JavaScript\dsh-enforce\turing-web-search`）。三者各自独立安装/卸载。

## 背景

「DeepSeek 官方」相关模型配置（`deepseek-official` → `llm-deepseek` 适配器）此前被手动禁用。
直接删配置无法通过 GUI 恢复（删除的 Provider 需要重新填 key / baseURL）。本插件把
「停用 / 启用」变成 GUI 操作：停用只写入 `disabled: true`（加载器热加载、重启后保留）
或从 settings 文档移除配置段（自动备份），**配置全部保留**，启用即恢复，无需重新配置。

## 功能

开关集中在一个面板里，不新增任何目录 / tab：

- **设置 → 「模型」页底部的「模型提供商 停用/启用」面板**（DSH 0.1.5 起通过官方插槽
  `settings.models.footer` 注册，见下）列出全部可停用/启用的提供商：
  - 目录中 `active` 或已配置的提供商（如自建 LLM 网关、DeepSeek 官方的 `deepseek-official`）
    显示「停用」；停用后该行**保持可见**并变为「启用」（已自动备份，一键恢复）；
  - 停用（settingsPath 非空）只移除该提供商在 settings 文档中的配置段（自动备份到
    `$DSH_HOME/dsh-provider-toggle.state.json`——文件名沿用旧插件名，不随改名迁移），
    模型与凭据引用全部保留；
  - 对整段配置的提供商（如 `deepseek-official`，settingsPath 为空），停用其适配器
    loader 条目（`llm-deepseek`，写入 `$DSH_HOME/cordis.patch.yml`），settings 文档原样
    保留；其目录条目与命名空间会随之消失 —— host 的 `list()` 会把这类“已消失”的提供商
    以保留行返回（仅显示名 + 启用按钮），因此面板里同样可直接恢复。

> 插件条目的开关见 `dsh-plugin-toggle`（设置 → 插件 → 插件列表，点击卡片行尾**现有状态徽章**即停用/启用、不新增按钮；停用
> `web-search-deepseek` 时连带清空 `web.searchProvider` 的配对逻辑也归它管）。

## 工作原理

- **模型提供商开关**：状态文件 `$DSH_HOME/dsh-provider-toggle.state.json`
  （被停用 provider 的完整配置备份，JSON、机器管理、不进入加载器补丁）；
  对 settingsPath 为空的整段适配器，停用/启用写 `$DSH_HOME/cordis.patch.yml`（home 层
  user patch，与 dsh-plugin-toggle 共用同一文件；本插件只动模型适配器条目，如
  `llm-deepseek`，不涉及配对条目）。
- **Host 半区**（`lib/index.js`）：单一 Typert Remote 服务 `ProviderToggleGateway`
  （命名空间 `providerToggle`，名字沿用旧插件，语义即动作）：
  `providerToggle.list()` / `providerToggle.setEnabled({ provider, enabled })`，
  经 `ctx.llm.listConfigurableProviders()` 读目录、`ctx.settings.describe()/mutate()` 读写
  settings 文档。
- **Client 半区**（`lib/client.js`）：既通过 `ctx.remote.$mount` 自挂载客户端描述符
  （只含 `providerToggle` 命名空间），也注册 UI 贡献：
  `ctx.slots.inject("settings.models.footer", …)` → `ctx.slots.register({ name: "settings.models.footer",
  id: "dsh-provider-manager", order: 100, label: … }, ProviderTogglePanel)`。
- **不打任何 bundle 补丁**：面板通过官方插槽 `settings.models.footer` 注册，
  host 侧 `list()` 本就返回"已从目录消失但被本插件停用"的行，所以既不需要给官方页面打补丁，
  也不需要 0.1.1 时代那套 `.bak` / `node --check` 流程。为什么官方插槽优于补丁（以及
  `settings.models.provider-card` 为何不适合）见 [`../TECH-NOTES.md`](../TECH-NOTES.md) §1.7。

## 安装（DSH 官方 bundle 层机制，无需 pnpm）

DSH 官方插件机制是 **bundle 层**：profile 的 `package.json` 里 `dsh.profile.bundles`
按顺序列出 bundle 包名，每个包声明 `dsh.bundle.patch`，启动时加载器把各 bundle 的
patch（`- insert:` 语义）应用到组合树；profile 自己的 `cordis.patch.yml` 只是最后一层
「针对性补丁」。`dsh plugin --profile <name> add <pkg>` 只是这个机制的 pnpm 封装。

当前已按官方机制安装到 web profile：

```powershell
# 1. 让 loader 从 profile 解析到包：profile 的 node_modules 指向项目目录（junction，编辑即时生效）。
#    $DSH_HOME 默认是 ~/.dsh（未设置环境变量时的回退）；<本插件目录> = E:\JavaScript\dsh-enforce\provider-manager
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-provider-manager" -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-provider-manager" "E:\JavaScript\dsh-enforce\provider-manager"

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

## UI 挂载方式（DSH 0.1.5 起：官方插槽，无需补丁）

本插件通过官方扩展点注册面板，**不需要**任何 bundle 补丁或一次性脚本：

- 插槽：`settings.models.footer`（「设置 → 模型」页底部、提供商行与新增控件之后的
  ordered 区域；无注册者时不渲染任何东西）；
- 注册：`ctx.slots.inject("settings.models.footer", () => ctx.slots.register({ name, id: "dsh-provider-manager", order: 100, label }, ProviderTogglePanel))`；
- 依赖的客户端服务：`remote`（Typert 客户端，`@deepseek-ai/dsh-api-gateway` 提供）与
  `slots`（`@deepseek-ai/dsh-client-ui-renderer` 提供），已登记在 `package.json` 的
  `dsh.client.inject`；
- 该插槽的契约（`kind: list`、`registerOptions: id/order/label`）由
  `dsh-cordis-client-runner` 内的插槽文档给出，插槽本身由 `settings.section` 里的
  ui-settings-models 条目声明，因此只有打开「设置 → 模型」时存在。
- 改完 client 半区后**刷新浏览器**（Ctrl+F5）即可生效；client 内容按请求实时读取，
  无需为它重启 dsh web（但**本插件 host 半区改动仍需重启 dsh web**）。
- 「插件 → 插件列表」页的补丁脚本在 `dsh-plugin-toggle` 包里，见其 README。

## 测试

`npm test` → `node --test test/*.test.mjs`，单个文件 `test/slot-panel.test.mjs`
（4 项，全离线）：用 `react-test-renderer` 把面板渲染出来，断言「停用/启用」按钮的
文案、禁用态与点击后的 `providerToggle.setEnabled` 调用。

> 该测试需要 `react` 与 `react-test-renderer`（`devDependencies` 未登记，
> 依赖本机 `node_modules` 里的副本；要复现请先在这台机器上装好这两个包）。

## 安装（备选：装了 pnpm 后走官方命令）

```powershell
# 先移除手动 junction，让 pnpm 接管 node_modules 条目：
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-provider-manager" -Recurse -Force -ErrorAction SilentlyContinue
dsh plugin --profile web add "E:\JavaScript\dsh-enforce\provider-manager"
# 重启 dsh web。pnpm 会安装依赖并自动把 dsh-provider-manager 登记进 dsh.profile.bundles。
```

## 卸载

从 profiles\web\package.json 的 `dsh.profile.bundles` 里移除 `dsh-provider-manager`（或
`dsh plugin --profile web remove dsh-provider-manager`），重启即可——插槽贡献随条目
卸载自动消失，无需还原任何补丁。`dsh-provider-toggle.state.json`
（旧名沿用）里的备份会在启用时自动清空。
