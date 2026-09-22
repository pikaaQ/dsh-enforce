# windows-agent-pack

把「Windows 优化版编码 Agent」装到一个 DSH 实例上的安装包。**全部使用官方机制，无任何自研插件代码**。
**只面向 Windows**（本 agent 的整篇纪律都是 Windows 原生命令的语义，不提供 Linux/macOS 脚本）。

> 机制：`standard` preset 的 persona 默认假设的是 POSIX 风格的 shell，在 Windows 上会反复撞同一类坑
> （引号与转义、编码、退出码语义、文件独占、交互提示、路径）。本包安装一个 preset：**composition 的
> 31 行条目与 shipped `standard` 逐行相同**（id 与顺序都不变），功能改动**三处**——
> (a) persona 前缀换成 Windows 执行纪律（常驻，影响每一步）；
> (b) `skill-filesystem` 增加 `customSkillDirs` 指向 preset 自带的 `skills\`，随包携带
> `windows-native-tooling` 手册（按需加载：十二个环境轴 + 报错索引 + 探测/执行脚本）。
>
> **本 preset 不含任何视觉委派行**：视觉委派由 host 平面的 `dsh-vision-delegate` 插件提供，
> 它对**每个** preset 注册 `subagent_vision`。preset 里若出现**同名**工具行会**遮蔽**插件那份
> （后果见 [`..\TECH-NOTES.md`](../TECH-NOTES.md) §1.1），所以这里没有、也不要再加。

## 依赖的官方组件

| 组件 | 作用 |
|---|---|
| `dsh-agent-presets` | 用户 preset（`$DSH_HOME\.agent-presets\windows\`） |
| `dsh-persona` | persona 的 `prefix`（本包改写）+ `suffix`（沿用 shipped 的 `Your working directory is {{cwd}}.`） |
| `dsh-skill-filesystem` | `customSkillDirs`：让 preset 自带技能目录被扫描，`baseUrl` 相对本 preset 目录，随装随用 |
| `dsh-tool-pwsh` / `dsh-pwsh-local` | 手册里所有 shell 事实的依据（每次调用新进程、`workdir`、`[exit code: N]`、UTF-8 输出前置声明等） |
| settings 命名空间 `agent-presets` | `default: windows`（仅 `-SetDefault` 时写入；默认不动） |

> DSH home：脚本取 `$DSH_HOME` 环境变量，未设置时用 `%USERPROFILE%\.dsh`；也可用 `-DSHHome` 显式指定
> （先 `echo $env:DSH_HOME` 确认实例实际 home，不一致时务必显式传入）。

## 目录结构

```
windows-agent-pack/
├── README.md          # 本文件
├── install.ps1        # 一键安装（-Force / -SetDefault / -GlobalSkill / -SkipProbe / -DSHHome）
├── uninstall.ps1      # 一键卸载（-KeepPreset / -RemoveGlobalSkill）
├── verify.ps1         # 只读自检：文件哈希、0.1.5 的 persona/skill schema、技能 frontmatter、默认 preset、环境探测
└── preset/            # 安装内容（权威副本）
    ├── agent.cordis.yml
    ├── preset.yml
    └── skills/windows-native-tooling/
        ├── SKILL.md
        ├── references/original-field-notes.md
        └── scripts/{win-env-probe,win-run}.mjs + .cmd + run-native.mjs
```

## 前置条件

1. DSH 版本 **≥ 0.1.5-rc.2**（本包在该版本上验证）。判断依据：preset 的 persona 行使用
   `prefix` + `suffix`、技能行使用 `customSkillDirs`。**0.1.4 及更早**的 persona 是单个 `text:` 键，
   本 preset 装上去**无法挂载**（`$.prefix missing required value`）——先升级 dsh。
   `install.ps1` 会在安装前自检 pack 本身是否符合新形状。
2. Windows 10/11；`node` 在 PATH（只有探测脚本需要；没有也能装，只是装完不自动跑探测）。

## 安装

```powershell
# 默认：只装 preset，不动 settings.yaml / AGENTS.md
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 覆盖已存在的 windows preset（旧副本保留为 windows.bak-<时间戳>）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force

# 顺带让所有 preset 都能加载这本手册（复制到 $DSH_HOME\skills\）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -GlobalSkill

# 顺带把新会话的默认 preset 设成 windows（备份 settings.yaml）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -SetDefault

# 指定其它 DSH 实例
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DSHHome D:\.dsh
```

| 参数 | 作用 | 默认 |
|---|---|---|
| `-DSHHome <path>` | 目标实例 home | `$env:DSH_HOME`，否则 `%USERPROFILE%\.dsh` |
| `-Force` | 覆盖已存在的 preset（旧版备份为 `<name>.bak-<时间戳>`）；全局技能副本**不存在才复制**，已存在只是跳过（要刷新它得先删掉） | 关（preset 已存在即报错退出） |
| `-GlobalSkill` | 把手册也装到 `$DSH_HOME\skills\windows-native-tooling`，**任何 preset 的会话都能按需加载** | 关 |
| `-SetDefault` | 写 `settings.yaml` 的 `agent-presets.default: windows` | 关（只报告当前值） |
| `-SkipProbe` | 装完不跑环境探测 | 关（默认跑，结果写 `$DSH_HOME\win-env.json`） |

脚本做六步：检查 pack → 装 preset（先备份）→ 可选全局技能 → 可选默认 preset → **逐文件 SHA256 比对** →
环境探测。所有文本显式按 UTF-8 读写（无 BOM），避免 PowerShell 5.1 按 ANSI 解码造成的乱码。

**生效时机**：preset 组合在**会话创建时**装载，改动后**新会话即生效、无需重启 dsh**；正在运行的会话
保持创建时的组合。首次安装后重启一次最稳（让设置/发现层整体刷新）。

**本包不做什么**：不修改 `$DSH_HOME\AGENTS.md`（那是用户全局规则层，本 agent 的纪律属于 preset；
AGENTS.md 里那段视觉委派说明与 `AGENTS.md` 的所有权归 `dsh-vision-delegate` 插件/其仓库）；除 `-SetDefault`
外不碰 `settings.yaml`；不安装任何插件、不写 `cordis.patch.yml`。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File .\verify.ps1          # 只读自检
powershell -ExecutionPolicy Bypass -File .\verify.ps1 -SkipProbe
```

`verify.ps1` 检查：9 个文件是否与 pack 逐字节一致；composition 是否仍是新形状
（打印实际条目行数，并断言含 `prefix:` 与 `customSkillDirs`、**明确抓出旧版 `text:` 键**）；
`SKILL.md` 的 frontmatter 与代码围栏是否成对；当前 `agent-presets.default`；
以及本机十二个环境轴的实测报告。任一项不通过则退出码 1。

会话内验证：开**新会话**选 preset「标准模式·Windows 优化」，让 agent 先跑一次
`scripts/win-env-probe.mjs` 并把 JSON 留在工作区，再让它加载 `windows-native-tooling` 技能。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveGlobalSkill   # 连全局技能副本一起删
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepPreset         # 只撤销全局技能 / 默认 preset
```

删除 preset（`-KeepPreset` 可保留）、删除**与 pack 逐字节相同**的全局技能副本（手改过的不动，只提示）、
若 `agent-presets.default` 当前指向 windows 则摘除该段（`settings.yaml.bak-uninstall` 备份）。
install 产生的 `windows.bak-<时间戳>` 一律保留，便于回退。

## 升级 dsh 之后：怎么重基（re-base）

composition 是 shipped `standard` 的副本，**dsh 升级不会自动跟上**。本包的处理方式：

1. `preset\` 是权威副本；要跟官方，就重新复制新版 shipped standard，再套回**三处改动**
   （见 `preset\agent.cordis.yml` 头部注释：persona 前缀、`skill-filesystem` 的 `customSkillDirs`、
   文件头注释）。**不要**在重基时把旧的视觉委派行抄回来——视觉委派不属于本 preset。
2. 改完把 `preset\` 更新（或直接改 `$DSH_HOME\.agent-presets\windows\` 再回灌本包），然后：
   - `install.ps1 -Force` 让安装副本与 pack 一致；
   - `verify.ps1` 确认新 schema；
   - **挂载验证**由 dsh 负责：开一个新会话即等于挂载验证（`persona`/`skill`/行名任一不兼容都会在挂载时报错）。
3. 手册里的 harness 事实也有版本基线（`SKILL.md` §17）：升级后如相关行为变化，重读
   `dsh-pwsh-local` / `dsh-tool-pwsh` / `dsh-skill-filesystem` / `dsh-persona` 的 `lib\index.js` 复核即可。

## 已知限制

- **只支持 Windows**：persona 通篇是 Windows 原生命令语义；不提供 `.sh` 脚本。装到 Linux 上这个 preset
  会明确提示「没有 `pwsh` 工具就只保留平台无关部分」，但没有意义。
- **技能可见范围**：默认只在**本 preset 的会话**里可见（它挂在 preset 目录下）。想让
  `standard`/`ptc`/`minimal` 的会话也能按需加载，用 `-GlobalSkill`。
- **`.cmd` 包装的边界**：`scripts\win-run.cmd` / `win-env-probe.cmd` 只用 `%*` 转发参数，`cmd.exe` 会在
  包装脚本运行前先解析一遍参数里的 `& | < > ^ " ( )`；脚本内部的防护来不及生效。**默认一律直接调 `.mjs`**
  （`node "...\scripts\win-run.mjs" ...`，argv 直传），`.cmd` 只在 `node` 不在 PATH 时用于定位 node。
- **沙箱受限模式下的 Windows 例外**：只读（read-only）沙箱里 pwsh 处于 ConstrainedLanguage
  （`[System.IO.*]::`、`Add-Type`、COM、反射会报 "only core types"）；两种受限模式下命名管道不可用
  （Node 默认 `stdio:'pipe'` 会 EPERM）。详见 `SKILL.md` §5.3。
- **信任边界**：`$DSH_HOME\.agent-presets`、`$DSH_HOME\skills`、`settings.yaml` 都属于用户层，
  与 shell 同等信任——只在本机安装，装前可通读本包源码（脚本+preset 都是纯文本）。
- **视觉委派不在本包里**：由 host 平面的 **`dsh-vision-delegate`** 插件提供
  （`..\vision-delegate\`，挂 `profiles\web\cordis.patch.yml` 的 patch 层）。它对每个 preset 注册
  `subagent_vision`：用户直接附加的图片以 attachment 直传一个新 `spawn` 子代理（只发"图片 + 问题"，
  不继承会话历史、不走路径、不需要 `read_image`），结论作为 tool result 回到会话；开关是 composer
  右下角的「视觉」胶囊（每会话），视觉模型在 设置 → 插件 → 插件配置 → 「视觉委派」里选。
  **本 preset 若出现同名工具行会遮蔽插件那份**——所以这里没有、也不要再加。
