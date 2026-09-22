# dsh-turing-balance

> ⚠️ **仅图灵（Turing / TCL）平台用户可用 —— 非图灵用户不必安装。**
> 徽章的显示条件是「当前会话选中的 provider 的 baseURL 以
> `https://live-turing.cn.llm.tcljd.com/` 开头」，取数用该 provider 的 `apiKeyEnv`
> （`TCL1_API_KEY` / `TCL2_API_KEY`，存在 `$DSH_HOME\.credentials.yaml`）。
> 非图灵用户装上以后**永远看不到徽章**（接口返回 `hidden: true, PROVIDER_NOT_TURING`，
> fail closed），只是白占一个 patch 层条目——用自己的网关（`linxi` 等）就别装它。
> 本插件请求的是图灵内网网关，凭据也只有图灵账号才有；`baseURL`/`apiKeyEnv`/`providerPrefix`
> 虽可配置（能指到任何实现 `/users/me/usage` 的网关），但默认配置只对图灵平台有效。

DSH 插件（`E:\JavaScript\dsh-enforce\turing-balance`）：**在 DSH Web 的会话头部显示图灵平台（Turing）的余额**
——即 <https://ai.eaglelab.tcl.com/#/apikey>「用量管理」页显示的**本月剩余额度**。

**与当前模型提供商挂钩**：只有当前会话选中的 provider 的 baseURL 属于图灵平台
（前缀 `https://live-turing.cn.llm.tcljd.com/`）时才显示徽章；换成别的 provider（如 `linxi`）
徽章立刻消失——判不出、认不出时也**一律不显示**（fail closed），绝不显示错账号或非图灵平台的数字。

```
provider = tcl1（图灵）        [ 会话标题 ]        ● 图灵 $32.86
provider = linxi（非图灵）     [ 会话标题 ]        （无徽章）
                              ↑ 悬停看明细，点击强制刷新
```

| | |
|---|---|
| host 半区 | settings 段 `turing-balance:` + 只读 HTTP 路由 `GET /turing-balance?provider=<id>`（按 provider 判定 + 分账号缓存） |
| client 半区 | `conversation.session.header.actions` 槽位的余额徽章（`lib/client.js`，只依赖壳里的 react） |
| 跟随 provider | 读客户端 `modelDirectories`（与 composer 模型选择器同一份 store）→ provider 变化即重判 |
| **取数策略** | **按 provider 缓存 5 分钟**（前端内存 + host TTL）：切会话 / 重挂载 / 切回同一个 provider **一次请求都不发**，只有**到期**或**点击徽章**才重新取数；非图灵 provider 不缓存也不排期 |
| API key | 只用**当前 provider 自己的** `apiKeyEnv`（不同 provider 可能是不同图灵账号），且只在 host 侧解析，**不进浏览器** |
| 依赖 | 运行时：`dsh-credentials` / `dsh-launch-environment` / `schemastery`（settings 是**可选注入**的宿主服务，`ctx.get("settings")`，不列为依赖）；测试：react + react-test-renderer |

**目录**

- [0. 快速开始（TL;DR）](#0-快速开始tldr)
- [1. 余额是怎么拿到的（已实测）](#1-余额是怎么拿到的已实测)
- [2. 显示规则：什么时候显示、什么时候不显示](#2-显示规则什么时候显示什么时候不显示)
- [3. 为什么走「本机 HTTP 路由」而不是浏览器直连](#3-为什么走本机-http-路由而不是浏览器直连)
- [4. 安装与「改动生效范围」](#4-安装与改动生效范围)
- [5. 配置](#5-配置)
- [6. 交互](#6-交互)
- [7. 接口（host 半区）](#7-接口host-半区)
- [8. 文件结构](#8-文件结构)
- [9. 测试](#9-测试)
- [10. 排错（FAQ）](#10-排错faq)
- [11. 相关插件与已知限制](#11-相关插件与已知限制)

---

## 0. 快速开始（TL;DR）

```powershell
# 装（详见第 4 节）：junction + profile patch 层 insert
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-balance" "E:\JavaScript\dsh-enforce\turing-balance"
cd E:\JavaScript\dsh-enforce\turing-balance; npm install
# profiles\web\cordis.patch.yml 末尾加：
#   - insert:
#       - id: turing-balance
#         name: dsh-turing-balance
```

* 徽章出现在**会话头部右侧**（会话标题行右端）；**当前 provider 不是图灵平台时不出现**。
* 想让它出现：用 `/model` 或 composer 底部的模型选择器切到 `tcl1` / `tcl2`（图灵网关的 provider）。
* 悬停看明细，点击强制刷新；额度 ≤10% 转警示色。
* **不会频繁打接口**：余额按 provider 缓存 5 分钟——切会话、切回某个 provider、徽章重挂载都不发请求，
  到期或点击才重取（见第 3 节「取数策略」）。
* 自查一条命令：
  ```powershell
  curl "http://127.0.0.1:3080/turing-balance?provider=tcl1"    # → ok:true + 余额 + expiresAt
  curl "http://127.0.0.1:3080/turing-balance?provider=linxi"   # → hidden:true, PROVIDER_NOT_TURING
  ```

## 1. 余额是怎么拿到的（已实测）

控制台 `ai.eaglelab.tcl.com` 是 Nuxt 前端，其运行时配置
（`window.__NUXT__.config.public`）把接口基址指向**图灵网关本身**：

```
baseURL:   https://live-turing.cn.llm.tcljd.com
urlPrefix: /api/v1
```

「用量管理」页取数的那个接口是 `GET /users/me/usage`，并且**接受 API key 直连**
（不需要控制台 SSO 的 access token）：

```http
GET https://live-turing.cn.llm.tcljd.com/api/v1/users/me/usage
Authorization: Bearer <TCL1_API_KEY>
```

实测响应（字段名原样）：

```json
{ "code": 0, "message": "Success",
  "data": {
    "user_tier": 10100,
    "tier_remaining_days": null,
    "quota_per_month_in_usd": 100.0,                        // 本月总额度
    "current_month_usage_in_usd": 66.30,                    // 本月已用
    "current_month_remaining_quota_in_usd": 33.66,          // ★ 本月剩余额度（控制台显示的余额）
    "total_usage_in_usd": 513.24,                           // 累计已用
    "pools": [ { "pool_type": "api_key",            "quota_per_month_in_usd": 100,  "current_month_usage_in_usd": 66.07 },
               { "pool_type": "portal_application", "quota_per_month_in_usd": 2000, "current_month_usage_in_usd": 0.59 } ]
  } }
```

徽章显示的就是 **`current_month_remaining_quota_in_usd`**（★）。另外还调一次
`GET /users/me`（同一把 key）取 `username`/`email`，用于确认「这是谁的余额」；
该请求失败只让账号信息降级为 null，不影响余额显示。

> 注意：这是**账号级月度额度**（额度池），不是充值钱包余额。
> `TCL1_API_KEY` 与 `TCL2_API_KEY` 属于不同账号，各自返回各自的额度。

**实测记录**（本机 live 网关，`/turing-balance` 路由返回值）：

| 当前 provider | 结果 |
|---|---|
| `tcl1` | `ok:true, provider:"tcl1"`，账号 `<user>`，本月剩余约 `$32.86 / $100` |
| `tcl2` | `ok:true, provider:"tcl2"`，账号 `<user>`，本月剩余约 `$99.48 / $100` |
| `linxi`（`https://ai.docker.tcl.com/imaas/v1`） | `ok:false, hidden:true, code:PROVIDER_NOT_TURING`（未访问图灵接口） |

## 2. 显示规则：什么时候显示、什么时候不显示

判定所用的事实（都在 host 侧，浏览器看不到）：

```
settings.yaml
  llm-pi-ai:
    providers:
      tcl1:  { baseURL: https://live-turing.cn.llm.tcljd.com/api/v1/, apiKeyEnv: TCL1_API_KEY }
      tcl2:  { baseURL: https://live-turing.cn.llm.tcljd.com/api/v1/, apiKeyEnv: TCL2_API_KEY }
      linxi: { baseURL: https://ai.docker.tcl.com/imaas/v1,           apiKeyEnv: LINXI_API_KEY }
```

前端把「当前会话选中的 provider id」带上：`GET /turing-balance?provider=<id>`，host 侧：

| 情况 | host 返回 | 徽章 |
|---|---|---|
| provider 的 `baseURL` 以 `providerPrefix` 开头 | `ok:true` + `provider:<id>` + 余额 | **显示**（用该 provider 的 `apiKeyEnv` 取数） |
| provider 的 baseURL 是别的网关（如 linxi） | `ok:false, hidden:true, code=PROVIDER_NOT_TURING`（**不联网**） | 不显示 |
| 定位不到该 provider 的配置（如整段适配器、settings 里没有它） | `hidden:true, code=PROVIDER_UNKNOWN` | 不显示 |
| provider 未知（模型目录还没加载出来 / 服务缺失） | 前端根本不发请求 | 不显示 |
| host 没回报 provider 身份（如 host 半区是旧版） | — | 不显示（fail closed） |
| 是图灵但凭据缺失/上游失败（且无上次成功值） | `ok:false, hidden:false, code=CREDENTIAL_MISSING…`（502/503） | 显示 `图灵 —`，悬停看原因、点击重试 |

**切换 provider** 时：徽章先用宿主 RPC 更新共享的模型目录 store（与 composer 的模型选择器同一个
`ModelDirectory`），前端只在「结果的 provider === 当前 provider」时才渲染，所以**不会短暂显示上一个
provider 的余额**；切到非图灵 provider 后徽章直接消失。

> 前缀判定是**纯前缀匹配**（`baseURL.trim().startsWith(prefix)`）：`https://live-turing.cn.llm.tcljd.com/`
> 命中，`https://live-turing.cn.llm.tcljd.com.evil.example/`、经代理转发的自有网关等都不命中。
> 前缀可用设置段 `providerPrefix` 改。

## 3. 为什么走「本机 HTTP 路由」而不是浏览器直连

浏览器直连图灵网关要求把 API key 放进页面（跨域 CORS + key 泄漏），因此本插件改成：

```
浏览器徽章 ──同源 fetch /turing-balance?provider=<id>──▶ host 半区
                                                        ├─ 读 settings：该 provider 的 baseURL / apiKeyEnv
                                                        └─ 前缀匹配图灵 → GET {baseURL}/users/me/usage
```

* 同源请求，不涉及 CORS，也不需要把 key 交给前端；
* 上游失败时回落该 provider 的「上次成功值」并在载荷里标 `stale`，徽章照常显示旧数字并注明原因；
* 响应不设 CORS 头，跨源网页读不到本机这份数据。

### 取数策略（缓存与刷新时机）

余额**按 provider 保存**（一个 provider 一个账号 → 一份缓存），默认 **5 分钟**内不再向上游取数；
只有「到期」或「点击徽章」才重新取。两层缓存 + 一处排期：

| 层 | 位置 | 作用 |
|---|---|---|
| 前端内存缓存 | `lib/client.js` 的 `balanceCache`（provider → `{state, expiresAt}`） | **切会话 / 徽章重挂载 / 切回上一个 provider 都不发请求**，直接用保存的值渲染 |
| host 缓存 | `lib/index.js` 的 `cache`（key = `baseURL\|apiKeyEnv`，TTL = `ttlSeconds`） | 多个标签页、多次刷新、多个会话共享同一份余额；`?refresh=1` 绕过 |
| 到期排期 | 载荷里的 `expiresAt`（= `fetchedAt + ttlSeconds`） | 前端**按到期时刻**排一次定时器，到点后非强制地取一次；**不做固定间隔轮询** |

| 触发 | 是否请求 |
|---|---|
| 切会话（同一 provider） | ❌ 命中前端缓存，零请求 |
| 切到另一个图灵 provider | ✅ 该 provider 第一次见 → 取一次（之后 5 分钟只吃缓存） |
| 切回上一个图灵 provider | ❌ 只要它的缓存还没过期 |
| 浏览器刷新页面 | ✅ 一次（内存缓存没了；host 缓存未过期则 host 不再打上游） |
| 5 分钟到期 | ✅ 一次（非强制；host 侧那条也正好过期 → 真正取一次上游） |
| 点击徽章 | ✅ 强制（`?refresh=1`，绕过两层缓存） |
| 切回标签页（页面重新可见） | 只在当前值**已过期或没有排期**时才取 |
| 当前 provider 非图灵 | ❌ 不显示、不缓存、不排期（完全没有后续请求） |
| 读取失败 / 陈旧值 | ✅ 按 host 给的较短 `expiresAt`（≤120s）自动重试一次，避免坏上游被干等 5 分钟 |

> 想改缓存时长：设置段 `ttlSeconds`（默认 300）。它同时决定 host 缓存有效期与前端排期间隔，
> 所以**改完下一次判定/请求就用新值**（host 命中缓存时回报的 `expiresAt` 按当前 TTL 重算）。

## 4. 安装与「改动生效范围」

当前挂法：**profile patch 层**（`$DSH_HOME/profiles/web/cordis.patch.yml`）。
loader 热监听该文件（profile-boot 的 `watchUserPatches` → `composeLive`），
所以**新增/删除这条目在运行中的 dsh web 立刻生效**（条目会即时挂载/下线）。

```powershell
# 1. junction：让 profile 能按包名解析到仓库内这份源码
Remove-Item "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-balance" -Recurse -Force -ErrorAction SilentlyContinue
cmd /c mklink /J "$env:DSH_HOME\profiles\web\node_modules\dsh-turing-balance" "E:\JavaScript\dsh-enforce\turing-balance"

# 2. 依赖（host 半区要 import @deepseek-ai/*；本包 node_modules 自带）
cd E:\JavaScript\dsh-enforce\turing-balance; npm install

# 3. 在 profiles\web\cordis.patch.yml 里加（已加好）：
#    - insert:
#        - id: turing-balance
#          name: dsh-turing-balance

# 4. 浏览器 Ctrl+F5（新条目会进入 __DSH_BOOT__，页面刷新即加载徽章）
```

**改代码后的生效范围**（实测）：

| 改动 | 生效方式 |
|---|---|
| `cordis.patch.yml` 里的条目（增删/改 config） | 运行中即时热挂载，无需重启 |
| `lib/client.js`（浏览器半区） | 按请求实时读取，**刷新页面**即可 |
| `lib/index.js`（host 半区） | loader 缓存已 import 的模块，**必须重启 dsh web** |

**另一种挂法（bundle 层）**：把 `profiles\web\cordis.patch.yml` 里那段 insert 删掉，
再把 `"dsh-turing-balance"` 追加到 `profiles\web\package.json` 的 `dsh.profile.bundles`
（包内已声明 `dsh.bundle.patch: ./cordis.patch.yml`），然后**重启 dsh web**。
两种挂法**只能二选一**：同一个 `id` 出现两次，冷启动会报
`duplicate loader entry id: turing-balance`。

**卸载**：删掉 `cordis.patch.yml` 里那段 insert（热生效，徽章随之消失），再删 junction；
bundle 挂法则从 `dsh.profile.bundles` 移除并重启。

> ⚠️ 手改 `cordis.patch.yml`（中文注释 + UTF-8）时**别用 PowerShell 的
> `Get-Content -Raw | Set-Content` 往返**：默认编码会把中文注释写坏、甚至吃掉换行把
> `- insert:` 并进注释里。用编辑器或文件工具直接改。

## 5. 配置

设置段命名空间 `turing-balance:`（`$DSH_HOME/settings.yaml`，settings-file watch 热生效）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `providerPrefix` | `https://live-turing.cn.llm.tcljd.com/` | 判定「这个 provider 是不是图灵平台」的 baseURL 前缀 |
| `ttlSeconds` | `300`（5 分钟） | 缓存时长：host 按 provider 分别缓存这么久，前端也按它决定何时重取；`?refresh=1`（点击徽章）忽略它。改小＝更实时、更费上游；改大＝更省请求 |
| `baseURL` | `https://live-turing.cn.llm.tcljd.com/api/v1` | **不带 `?provider=` 时**（命令行自查）用的地址 |
| `apiKeyEnv` | `TCL1_API_KEY` | provider 自己没配 `apiKeyEnv` 时回落到它；也是不带 `?provider=` 时的引用 |

```yaml
# $DSH_HOME/settings.yaml
turing-balance:
  providerPrefix: https://live-turing.cn.llm.tcljd.com/
  ttlSeconds: 300     # 5 分钟：到期或点击徽章才重新取余额
```

> 失败/陈旧值的自动重试窗口固定为 `min(ttlSeconds, 120)` 秒（不单独给配置项），
> 免得一次失败就把徽章冻住 5 分钟。

## 6. 交互

* **悬停**：浮出明细（模型提供商、本月剩余/总额度/百分比、本月已用、累计已用、账号、更新时间；
  host 命中缓存时补一行「缓存有效期至 hh:mm:ss（过期或点击才重新获取）」）。
* **点击**：强制刷新（`?refresh=1`，绕过前端与 host 两层缓存），并重排下一次到期重取。
* **额度 ≤10%**：徽章与状态点转警示色。
* **读取失败**（图灵 provider 但取数失败）：显示 `图灵 —` + 悬停看失败原因，点击重试。
* **数据陈旧**：仍显示上次成功值，悬停注明「数据为上次成功值，最近一次刷新失败：…」。
* 页面重新可见（切回标签页）时，只有在当前值已过期/没有排期时才补一次（未过期不打扰上游）。

## 7. 接口（host 半区）

`GET /turing-balance[?provider=<id>][&refresh=1]`

```json
{ "ok": true, "stale": false, "cached": true,
  "fetchedAt": 1789696376343, "ttlSeconds": 300, "expiresAt": 1789696676343,
  "provider": "tcl1", "providerBaseURL": "https://live-turing.cn.llm.tcljd.com/api/v1/",
  "baseURL": "https://live-turing.cn.llm.tcljd.com/api/v1", "apiKeyEnv": "TCL1_API_KEY",
  "account": { "username": "<账号名>", "email": "<账号邮箱>", "userId": "user_…" },
  "quotaPerMonthUsd": 100, "monthRemainingUsd": 32.86, "monthUsageUsd": 67.5,
  "totalUsageUsd": 514.2, "userTier": 10100, "tierRemainingDays": null,
  "pools": [ { "poolType": "api_key", "quotaPerMonthUsd": 100, "currentMonthUsageUsd": 66.9 } ] }
```

* `fetchedAt` / `ttlSeconds` / `expiresAt`：这次数据的取回时刻、缓存时长、**过期时刻**——前端据此排一次
  到期重取（`expiresAt` 缺失时前端按 `ttlSeconds`（默认 300）与 `fetchedAt` 自行推算，向后兼容）。
* `cached: true`：这次是 host 缓存命中（`fetchedAt` 仍是原来那次取回的时刻，不刷新）。
* 失败/陈旧载荷的 `ttlSeconds` 是较短的重试窗口（`min(ttlSeconds, 120)`）。

不适用（不该显示）：`{ "ok": false, "hidden": true, "provider": "linxi", "providerBaseURL": "…",
"error": { "code": "PROVIDER_NOT_TURING", "message": "…" } }`（HTTP 200 —— 这不是错误，而是「本 provider 不适用」，
也不带 `expiresAt`：前端既不显示也不排期）。

真实失败：`{ "ok": false, "hidden": false, "error": { "code": "…", "message": "…" } }`，错误码含义：

| code | HTTP | 含义 |
|---|---|---|
| `CREDENTIAL_MISSING` | 503 | 该 provider 的 `apiKeyEnv` 在 `$DSH_HOME/.credentials.yaml` 里解析不到值 |
| `CONFIG_INVALID` | 502 | `apiKeyEnv` 不是合法的凭据引用名（POSIX shell 标识符） |
| `UPSTREAM_UNREACHABLE` | 502 | 连不上图灵网关（网络/DNS/超时，超时上限 15s） |
| `UPSTREAM_HTTP` | 502 | 上游非 2xx（如 401 `API key not exist`） |
| `UPSTREAM_CODE` | 502 | 业务 `code ≠ 0` |
| `UPSTREAM_BODY` | 502 | 响应体不是可解析的 JSON 对象 |
| `METHOD_NOT_ALLOWED` | 405 | 非 GET/HEAD |
| `BAD_REQUEST` | 400 | 请求 URL 解析不了（路由外层直接回，不经过取数逻辑） |
| `UNEXPECTED` | 502 | 兜底：取数过程中抛出的非 `BalanceError` 异常（只有**路由回调本身**抛错才回 500） |

其余约定：`cache-control: no-store`、**不设 CORS 头**、`HEAD` 只回头。

## 8. 文件结构

```
turing-balance\
  package.json          # 包声明：main/exports（含 ./client）、dsh.bundle.patch、dsh.client（platform: web）
  cordis.patch.yml      # bundle 层挂载补丁（- insert: id: turing-balance）——走 bundle 挂法时才用
  lib\index.js          # host 半区：settings 段 + /turing-balance 路由 + provider 判定 + 缓存/归一化
  lib\client.js         # client 半区：会话头部徽章（window.__ModuleLoader__.load 注册，只 require react）
  test\host.test.mjs    # host 离线测试（fetch 替身）
  test\client.test.mjs  # client 离线测试（react-test-renderer 真渲染）
  README.md             # 本文档
```

## 9. 测试

```powershell
cd E:\JavaScript\dsh-enforce\turing-balance
npm test        # 40 项，全部离线（global.fetch 替身 + 假定时器）
```

* `test/host.test.mjs`（18 项）：载荷归一化、**默认 5 分钟 TTL 与 `expiresAt` 计算、命中缓存沿用原
  `expiresAt`、命中缓存不重取、失败/陈旧值的短重试窗口**、stale 回落、各错误码、**provider 前缀判定
  （含仿冒域名/代理网关/大小写空白）、按 provider 分别缓存、路由层 query/HEAD/405**。
* `test/client.test.mjs`（22 项）：bundle 注册协议、槽位/字典、**取数策略（首次取数不强制、按
  `expiresAt` 排期而不是固定轮询、到期自动重取、切会话/重挂载零请求、多 provider 各自缓存、
  非图灵不缓存不排期、点击强制刷新、失败按短窗口重试）**、provider 未知→不显示、非图灵→不显示、
  切换 provider 先清空旧数字、迟到响应丢弃、host 未确认身份时 fail closed、各余额数据文案、
  兜底解析路径、只依赖 react。

## 10. 排错（FAQ）

**Q：徽章一直不出现？** 依次查：
1. 当前 provider 是不是图灵网关的 provider —— 用 composer 底部的模型选择器切到 `tcl1`/`tcl2`。
   `GET /turing-balance?provider=<你的provider>` 若回 `hidden:true`，说明它本就不该显示
   （`PROVIDER_NOT_TURING`＝地址不是该前缀；`PROVIDER_UNKNOWN`＝settings 里找不到它的配置）。
2. 页面是否刷新过（Ctrl+F5）——新挂的客户端条目要重新加载 `__DSH_BOOT__` 才生效；
   `GET /` 里搜 `dsh-turing-balance` 能确认它是否在启动清单里。
3. 改过 `lib/index.js` 却没重启 dsh web —— host 半区不热重载（见第 4 节）。
4. 会话是不是「寻址子代理会话」（`sessionId` 指向 child）——这类会话拿不到模型目录，徽章不显示。

**Q：切会话还会打图灵接口吗？** 不会。余额按 provider 缓存在前端内存里，切会话只是让组件重挂载，
直接复用缓存（见第 3 节「取数策略」）。只有 5 分钟到期或点击徽章才会真正取一次；
`host` 侧同样按 provider 缓存，所以多个标签页/会话共享同一份余额。

**Q：怎么让余额更实时（或更省请求）？** 调设置段 `ttlSeconds`：例如 `60`＝一分钟一取，
`900`＝一刻钟一取；想立刻看最新值随时点一下徽章（强制刷新，不改变 TTL）。

**Q：徽章显示 `图灵 —`？** 悬停看具体原因：多半是 `CREDENTIAL_MISSING`（`$DSH_HOME/.credentials.yaml`
里没有该 provider 的 `apiKeyEnv`，或值被清空）。补上凭据后点一下徽章即可（失败时插件也会按
≤120s 的短窗口自动重试一次）。

**Q：余额数字是旧的？** 悬停里写着「数据为上次成功值…」就表示最近一次刷新失败（网络/上游 5xx/401），
徽章故意保留旧值而不是清空；点徽章可立即重试。若只是「更新于 hh:mm:ss」比较早，那是缓存正常行为
（悬停里会写「缓存有效期至 …」）。

**Q：tcl1 和 tcl2 显示的余额不一样？** 正常——它们是**两个不同的图灵账号**，插件按 provider 自己的
`apiKeyEnv` 取数（这正是「跟随 provider」的意义）。

**Q：能不能在 `linxi` 下也显示余额？** 不能，除非它也是图灵网关：把 `providerPrefix` 改成
`https://ai.docker.tcl.com/` 就会反过来（那时 `linxi` 显示、`tcl1` 不显示）——该字段就是干这个的。

**Q：如何临时关掉插件？** 删掉 `profiles\web\cordis.patch.yml` 里那段 insert（热生效、徽章立即消失），
或用 `dsh-plugin-toggle` 的「设置 → 插件 → 插件列表」行尾徽章停用 `turing-balance` 条目。

**Q：会不会泄漏 API key？** 不会：key 只在 host 进程内经凭据服务解析，浏览器只拿到数字；
路由也不带 CORS 头，跨源页面读不到。

## 11. 相关插件与已知限制

**相关**：

* `turing-web-search\` —— 同一个图灵网关、同一族凭据引用（`TCL1_API_KEY`），但彼此独立：
  那个插件给 `ctx.web` 注册搜索端点，本插件只读 `GET /users/me/usage` 显示余额。
* `plugin-toggle\` —— 本插件作为 loader 条目出现在「设置 → 插件 → 插件列表」里，可由它停用/启用。
* `provider-manager\` —— 「设置 → 模型」里停用某 provider 时，本插件对该 provider 自然不再显示
  （模型目录里没有它，provider 判定无从命中）。

**已知限制**：

* **仅 Web 面**：client 半区用同源相对路径 `/turing-balance`，Electron `file://` 面不适用。
* 依赖 `modelDirectories`（shipped `ui-model-selection`）读「当前 provider」；该服务缺失或该会话
  （如寻址子代理会话）拿不到模型目录时，徽章不显示。
* 余额是**月度额度**语义；若将来图灵改成充值钱包，字段可能要跟着改（`pools` 里还有
  `portal_application` 池，本插件只显示顶层总额度）。
* 路由路径 `/turing-balance` 是固定常量（host 注册 + client 请求两侧写死），不随设置变更。
* 前端缓存是**内存缓存**：刷新页面就没了（此时若 host 缓存未过期，直接命中 host 缓存、不打上游）；
  `lib/client.js` 额外导出 `__test = { balanceCache, clock, expiryOf }`，只是离线测试的接缝
  （替换定时器、清缓存），运行时不使用。
* 只读：本插件不消耗额度、也不改任何图灵侧或 DSH 侧配置。
