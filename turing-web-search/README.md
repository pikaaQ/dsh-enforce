# dsh-turing-web-search

> ⚠️ **仅图灵（Turing / TCL）平台用户可用 —— 非图灵用户不必安装。**
> 本插件把 `ctx.web` 的搜索请求打到图灵内网网关
> （`https://live-turing.cn.llm.tcljd.com/api/v1`），凭据引用默认 `TCL1_API_KEY`
> （存在 `$DSH_HOME\.credentials.yaml`，只有图灵账号才有）。没有图灵账号时：
> 插件能挂载、卡片能打开，但**每次搜索都以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败**。
> 非图灵用户请继续用 shipped 的 `web-search-deepseek`（默认就是它）。

DSH 独立插件：向 `ctx.web` 注册**图灵（Turing）独立搜索端点**（路径 B，对照文档
<https://live-turing-docs.cn.llm.tcljd.com/api-guides/capabilities/web-search/>）的搜索提供商，
纯搜索引擎调用、**不走模型、无模型费**。与 shipped 的
`web-search-deepseek`（Claude/DeepSeek `/messages` 模型路线）**互斥可选**：ctx.web
在只有唯一可用提供商时自动选中，两个都启用会报歧义。

**host 半区**注册 ctx.web 提供商与 settings 配置段；**client 半区**在
设置 → 插件 → 插件配置 提供「图灵网页搜索」卡片（端点预置下拉 + baseURL 覆盖，
保存即写入 settings 文档，热生效，无需重启）。

## 支持的端点预置（`engine` 枚举，对照图灵文档）

| `engine` | 端点 | 请求 | 响应 → sources | 说明 |
|---|---|---|---|---|
| `baidu`（默认） | `POST {baseURL}/proxy/baidu/search` | `{q, count}` | `data.references[]`（title/url/content/date） | 百度，仅中国区 |
| `tavily` | `POST {baseURL}/proxy/tavily/search` | `{query, max_results}` | 透传 Tavily 官方 `results[]` | 全球，LLM-optimized |
| `firecrawl` | `POST {baseURL}/proxy/firecrawl/search` | `{query, limit}`（≤100，只发这两个字段，表外字段 422） | `success` + `data.web[]`（url/title/description） | 全球，搜索与网页抓取 |
| `cloudsway` | `GET {baseURL}/proxy/cloudsway/search?q=…&count=…`（≤50） | query 参数 | Bing 形状 `webPages.value[]`（url/name/snippet/datePublished） | 搜索，中国区 |
| `bing` | `POST {baseURL}/proxy/bing/v7.0/search` | `{q, count}`（≤25） | Bing 形状 `webPages.value[]` | Legacy Bing Proxy，自动路由 Baidu/Google（历史接口） |

- 条数参数按引擎映射（settings 的 `count`）：baidu `count`、tavily `max_results`、
  firecrawl `limit`（≤100）、cloudsway `count`（≤50）、bing `count`（≤25），请求前钳制。
- 响应解析四种 kind：`references`（baidu）、`results`（tavily）、`firecrawl`、`bingShape`
  （cloudsway/bing），见 host 侧 `ENGINE_ROUTES` 与 `mapStandaloneResponse`。
- 五者共用同一 `baseURL` 与 API key；`engine` 只认白名单，其它/未知值回落默认 `baidu`
  （host 侧 `normalizeEngine`）。
- 五个端点均已实测通过（每个返回 5 条来源）。

## 在 GUI 切换端点（推荐）

1. 设置 → 插件 → 插件列表，确保 `turing-web-search` 已启用
   （`web-search-deepseek` 需停用，二者互斥）。
2. 设置 → 插件 → **插件配置** → 打开「图灵网页搜索」卡片：
   - **搜索引擎 / 端点**：五选一（Baidu / Tavily / Firecrawl / Cloudsway /
     Legacy Bing Proxy）；
   - **接口地址（可选）**：留空 = 图灵默认网关
     `https://live-turing.cn.llm.tcljd.com/api/v1`；
   - 卡片底部预览「下次请求：`POST/GET …/proxy/<engine>/…`」（按引擎真实路由，含
     bing 的 `v7.0` 段），点**保存**。
3. 保存经 settings scope 写入 settings 文档的 `web-search-turing:` 段
   （settings-file watch 热发布；host 每次搜索重新取值），**下一次搜索即切换端点**，
   无需重启 dsh web、无需改文件。

## 直接改 settings.yaml（等效，watch 热生效）

```yaml
web-search-turing:
  engine: baidu        # baidu（默认）| tavily | firecrawl | cloudsway | bing
  baseURL: https://live-turing.cn.llm.tcljd.com/api/v1
  apiKeyEnv: TCL1_API_KEY   # 复用 .credentials.yaml 里已有 key
  # count: 10              # 条数：baidu/cloudsway/bing 的 count、tavily 的 max_results、firecrawl 的 limit
```

缺省即上述值（apiKeyEnv 与 count 高级项 GUI 未暴露，走本文件）。也可用 loader 补丁
覆盖条目 config（`- id: turing-web-search\n  config: {...}`）。

## 安装（bundle 层，与工作区其它私有插件各自独立）

```powershell
# 1. junction：让 profile 解析到包目录
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-web-search" "<本目录>"

# 2. 在 profiles\web\package.json 的 dsh.profile.bundles 追加：
#      "dsh-turing-web-search"
#    包已声明 dsh.bundle.patch（cordis.patch.yml，`- insert:` 挂载条目 turing-web-search）
#    与 dsh.client（client 半区 lib/client.js，浏览器端自动按包名加载）。

# 3. 重启 dsh web（bundle 列表与 client 行图启动时读取），浏览器 Ctrl+F5。
```

启用/停用：设置 → 插件 → 插件列表 → `turing-web-search` 开关。想切回官方/Claude
路线：停用它、启用 `web-search-deepseek`。

> 改 host 半区（`lib/index.js`）或首次新增/变更 client 半区声明后需**重启 dsh web**
> （client 行图在入口激活时按 package.json 增量扫描）；之后浏览器 Ctrl+F5 刷新即可。
