---
name: windows-native-tooling
description: Use when working on Windows and the task touches running or debugging shell commands (PowerShell 5.1 vs 7, cmd.exe, WSL/Git Bash), quoting or encoding failures, npm/pnpm installs and native builds, git commit/push/line-endings, file locks and EPERM/EBUSY, ports and services, long paths, OneDrive/network drives, UAC/execution policy/antivirus policy, or headless sessions. Also use once at the start of work in a new Windows workspace, to probe the environment and write the facts down.
---

# Windows 原生命令实战手册

本技能是对一份真实长链路会话踩坑记录的**泛化**：那份记录只覆盖了一台机器（Windows 10 18362 +
Windows PowerShell 5.1 + 代码页 936 + 内网 npm 镜像），这里把它推广成"**先判定环境轴，再选写法**"的
决策手册，并附上可运行的环境探测与命令执行脚本。

**核心信条**：Windows 上的"命令失败"绝大多数不是命令本身错了，而是**引号、编码、退出码语义、文件锁、
交互提示**这五件事之一。先把它们从等式里消掉，再谈调试业务逻辑。

---

## 0. 先做这三件事

1. **探测一次环境，把事实落盘。** 新工作区第一件事——在 `pwsh` 工具里**直接调 `.mjs`**（argv 直传，
   不经过任何 shell，参数含空格/引号/`&|<>` 都不会被改写）：
   ```powershell
   node "<本技能目录>\scripts\win-env-probe.mjs" --out <工作区>\win-env.json
   ```
   只有 `node` 不在 PATH 上时，才退回 node 定位包装
   `& "<本技能目录>\scripts\win-env-probe.cmd" --out <工作区>\win-env.json`：它用 `%*` 转发参数，
   而 `cmd.exe` 会**再解析一次**参数里的 `& | < > ^ " ( )`（见 §16 的边界）。
   输出是一份可读报告 + 一份 JSON。把 JSON 留在工作区（例如 `docs/win-env.json`），
   后续每条命令都以它为依据，而不是以"我记忆中 Windows 是那样"为依据。
   `--fast` 跳过杀软/端口探测（更快）。
2. **确认你所在的 shell。** `pwsh` 工具的每次调用都是全新的 `-NoLogo -NoProfile -NonInteractive -Command`
   进程：**cd、`$env:`、函数、别名都不跨调用保留**，用户 profile 也不加载。用 `workdir` 参数代替 `cd`。
   执行器解析顺序：`%ProgramFiles%\PowerShell\7\pwsh.exe` → PATH 中的 `pwsh.exe` → `System32\WindowsPowerShell\v1.0\powershell.exe`（5.1）。
   用 `$PSVersionTable.PSEdition` 判定：`Desktop` = 5.1，`Core` = 7。
   注意这描述的是本 preset 的 `tool-pwsh`；dsh 另有 `dsh-tool-pwsh-persistent`（`minimal` 等终端类
   preset 使用），那种会话里 **cd 与变量会跨调用保留**，不要按"无状态"来写命令。
3. **复杂命令不要写成一行的引号艺术。** 超过约 3 个引号或 2 个管道，就落成文件执行：
   `.mjs`（Node 永远按 UTF-8 读源码，无 BOM/解析/引号问题，DSH 宿主必有 Node）>
   `.cmd`/`.ps1`（必须纯 ASCII）> 长命令行。
   需要"跑原生命令 + 可靠拿到退出码和完整输出"时，用 `node "<本技能目录>\scripts\win-run.mjs" ...`
   （argv 直传，不经过 shell；`.cmd` 包装只在 node 不在 PATH 时用，边界见 §16）。

---

## 1. 十二个环境轴：判定方法与它改变了什么

每一步都不该假设，而应判定。下表把"变化点 → 如何判定 → 写法如何变"绑在一起。

| # | 环境轴 | 常见分支 | 判定 | 对写法的改变 |
|---|---|---|---|---|
| 1 | PowerShell 版本 | 5.1 Desktop / 7 Core | `$PSVersionTable.PSEdition` | 见 §2 对照表；5.1 无 `&&`/`\|\|`/`??`/三元 |
| 2 | 控制台与文件编码 | UTF-8 / ANSI(OEM) / UTF-16LE | `[Console]::OutputEncoding`、`chcp`、实测落盘字节 | 见 §3 |
| 3 | shell 家族 | 只有 PowerShell / +cmd / +WSL bash / +Git Bash / +Cygwin | `where.exe bash`，看路径 | 路径方言不同：`C:\x` = `/mnt/c/x`(WSL) / `/c/x`(Git Bash) / `/cygdrive/c/x`(Cygwin) |
| 4 | 会话形态 | 交互桌面 / 无头(SSH、服务、CI) | 探针里的 `interactive`、`SESSIONNAME`、`SSH_CONNECTION` | 无头时 GUI 弹窗**不可回答**：UAC、防火墙、SmartScreen 只能提前避开 |
| 5 | 权限 | 管理员 / 标准用户；Developer Mode 开/关 | 探针 `isAdmin`、`developerMode` | 符号链接/junction、服务、机器级 PATH 写入需要管理员或开发者模式 |
| 6 | 安全策略 | ExecutionPolicy、Defender、CFA、AppLocker/WDAC、MOTW | 探针 `executionPolicy`、`defender*` | 见 §7；被策略拦下的操作重试无用，要换路径 |
| 7 | 工作区文件系统 | 本地 NTFS/ReFS / 网络盘 / U 盘 / OneDrive / Dev Drive | 探针 `workspaceDrive`、`cwdInsideOneDrive` | 网络盘/同步盘的锁与重命名语义不同；重活放本地盘 |
| 8 | 长路径 | LongPathsEnabled 开/关 | 探针 `longPathsEnabled`、路径长度 | 关时必须保持路径 < 260；`git core.longpaths`、pnpm 深树 |
| 9 | TEMP 位置 | 与工作区同盘 / 跨盘 | 探针 `temp` vs `workspaceDrive` | 跨盘 `rename` 不是原子的，会 `EXDEV`；需要 rename 的临时文件放工作区内 |
| 10 | 并发与文件锁 | 单进程 / 同目录多进程 / 杀软实时扫描 | 探针 `defenderRealtime`、`Get-Process` | 见 §6；打开的文件默认独占 |
| 11 | 包管理与网络 | 公网 registry / 内网镜像 / 代理 + TLS 中间盒 | 探针 `npm.registry`、`git sslBackend`、`*_PROXY` | 内网镜像要先 `npm view <pkg> version` 验证存在；TLS 中间盒要 `sslBackend schannel` / `cafile` |
| 12 | 架构与 Node 安装方式 | x64 / ARM64(含 x64 模拟) / nvm-windows / volta / 系统安装 | `$env:PROCESSOR_ARCHITECTURE`、`process.arch`、`where.exe node` | ARM64 上无预编译产物的模块要源码编译（需要 VS Build Tools + Python）；nvm-windows 用 junction 切换版本 |

---

## 2. 轴 1：PowerShell 5.1 与 7 的写法差异

| 能力 | Windows PowerShell 5.1 (Desktop) | PowerShell 7 (Core) |
|---|---|---|
| `&&`、`\|\|`、三元 `? :`、`??` | **不支持**（`The token '&&' is not a valid statement separator in this version.`） | 支持 |
| shell 层连续执行 | `;` + `if ($LASTEXITCODE -eq 0) { ... }` | 同上或 `&&` |
| `-Encoding utf8` 写文件 | **写 BOM** | 不写 BOM |
| `Set-Content` 默认编码 | ANSI/OEM | utf8 无 BOM |
| `>` / `Out-File` / `Add-Content` 默认 | **UTF-16LE（带 BOM）** | utf8 无 BOM |
| `curl`、`wget` | 是 `Invoke-WebRequest` 的别名 | 已移除，`curl.exe` 才是真的 |
| `Invoke-WebRequest` | 需 `-UseBasicParsing`；老版本默认 TLS 1.0，要手工 `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` | 默认 TLS 1.2+，无需 `-UseBasicParsing` |
| `Get-Content` 读字节 | `-Encoding Byte` | `-AsByteStream` |
| `ConvertFrom-Json` | 较脆（注释、重复键、空输入都容易炸） | 更宽容，还有 `-AsHashtable`、`Test-Json` |
| 原生命令非零退出 | 只是 `$LASTEXITCODE` | 7.3+ 若 `$PSNativeCommandUseErrorActionPreference=$true` 会成为终止错误 |
| 传到原生命令的参数含引号 | **Legacy 传递，内嵌 `"` 会被吃掉**（本机实测：`'console.log("x")'` 到 node 变成 `console.log(x)`） | 7.2+ `$PSNativeCommandArgumentPassing='Standard'`，行为不同 |

**处置**：不写"只在某一代能跑"的命令。跨代安全的写法：

```powershell
# 成功才继续（两代通用）
& cmd.exe /d /s /c "npm run build > build.log 2>&1"; if ($LASTEXITCODE -eq 0) { Write-Output 'build ok' }
# 需要多语句、条件、正则时：写成 .mjs 或 .cmd，不要在单行里堆
```

> 5.1 上 `$ErrorActionPreference='Stop'` + `2>&1` 会把原生命令的 stderr 变成**终止错误**
> （`NativeCommandError`），让"只是打印了警告"的命令看起来彻底失败。要么别在包装原生命令的
> 那段作用域里设 Stop，要么把 stderr 重定向到文件。

---

## 3. 轴 2：编码（这是最容易"看着像逻辑错误"的一类）

事实先摆清楚（本机实测）：

| 路径 | 实际字节 | 说明 |
|---|---|---|
| PowerShell 自身输出到 harness | UTF-8 | 执行器在每条命令前注入 `[Console]::OutputEncoding = UTF8(no BOM)` 和 `$OutputEncoding = UTF8(no BOM)` |
| `cmd.exe /c "echo 中文 > f.txt"` | UTF-8 | 控制台输出代码页已被固定为 65001（所以 `chcp` 显示 936 也别信） |
| PowerShell `'x' > f.txt` / `Out-File`（5.1） | **UTF-16LE，`FF FE` 开头** | 文件写入不受上面的固定影响 |
| `fsutil` 等原生命令**被管道捕获**时 | **ANSI/OEM（中文机 = GBK）** | `console` 输出的固定传不到孙进程；直接按 UTF-8 解码就是乱码 |
| 用 `Get-Content` 读 UTF-8 文件而不带 `-Encoding UTF8` | 按 ANSI 解码 → 乱码 | 典型症状：`灞傦細` 这类"汉字+问号" |

**规则**

1. 看到"汉字乱码 + 问号"或 `�`，第一反应是**编码**，不是逻辑。先确认是谁写的、用什么编码写的。
2. 命令输出重定向到文件时，把重定向写在 `cmd.exe /c "..."` **内部**（cmd 按字节原样写），
   或交给文件工具/Node 写。不要用 PowerShell 的 `>` 落盘再让别的工具解析。
3. 写 YAML/JSON/源码/配置：**只用文件工具或 Node**（`fs.writeFileSync(p, s, 'utf8')`）。
   用 PowerShell 写就等于给解析器埋雷（BOM、UTF-16LE、ANSI 三选一，随版本和参数漂移）。
4. 读文本显式指定编码：`Get-Content <f> -Encoding UTF8`。
5. 解析 JSON 用 Node（`JSON.parse`）或文件工具，不要用 5.1 的 `ConvertFrom-Json` 去猜；
   `ConvertTo-Json` 默认 `-Depth 2` 会**静默截断**深层对象，而且会把非 ASCII 转成 `\uXXXX`。
6. 抓别人（`git`、`python`、`fsutil`…）的输出，如果出现乱码，是**对方按 ANSI/OEM 输出的字节**
   被当成 UTF-8 解码了。对策按优先级：①换成读文件；②给该工具设 UTF-8
   （`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`、`chcp 65001` 后再跑）；③按代码页解码
   （本技能的 `run-native.mjs` 导出 `decodeBytes(buffer, ansiCodePage)`，`win-env-probe.mjs`
   对 `fsutil` 就是这么做的：中文机上是 GBK，解码后能看到"已禁用目录…"）。

---

## 4. 轴 3/4：shell 家族与会话形态

**bash 在不同安装下是完全不同的东西**：`where.exe bash` 的路径决定语义。

| 路径特征 | 家族 | 路径方言 | 注意 |
|---|---|---|---|
| `C:\Windows\System32\bash.exe` | WSL | `C:\a\b` ↔ `/mnt/c/a/b` | 不共享 Windows PATH；首跑可能触发发行版安装（会挂住）；访问 `/mnt/c` 很慢 |
| `C:\Program Files\Git\bin\bash.exe` | Git Bash (MSYS2) | `/c/a/b` | 自带 Unix 工具，会把看起来像路径的参数改写成 Windows 路径（`MSYS_NO_PATHCONV=1` 可关）；CRLF 破坏 shebang |
| `C:\cygwin64\bin\bash.exe` | Cygwin | `/cygdrive/c/a/b` | 同上，另有独立的 `/usr` 世界 |

**绝不要在一条命令里混两种路径方言**。跨边界时把路径显式转换，或干脆用 Windows 侧的工具完成这一步。

**会话形态**决定"能不能弹窗"：

- 无头（SSH/服务/CI/本会话实测 `interactive=false`）：UAC、Windows 防火墙、SmartScreen、"应用程序错误"
  这些窗口**没有人能点**，命令会挂到超时。凡是会触发它们的事，都必须提前规避或改用非交互方式。
- 交互桌面：同样别依赖弹窗——agent 无法点击。上面那类操作依旧是"挂住"。

---

## 5. 轴 5–9：路径、文件系统、权限、安全策略

### 5.1 路径与文件名（Windows 特有）

- 分隔符 `\`（Node/PS 也接受 `/`，但传给某些原生工具就未必）；UNC 路径 `\\server\share\x` 要引号。
- 非法字符：`< > : " / \ | ? *`；文件名不能以 `.` 或空格结尾；**不要用带冒号的 ISO 时间戳做文件名**
  （`2026-09-20T10:30:54.json` 会直接报"文件名、目录名或卷标语法不正确"）。用 `2026-09-20T10-30-54`。
- 保留设备名：`CON PRN AUX NUL COM1..COM9 LPT1..LPT9`（含带扩展名的 `aux.json`）。
- 大小写不敏感：`README.md` 与 `readme.md` 是同一个文件；两个只差大小写的路径无法共存，
  git 切分支时会报 `unable to create file ... File exists`。目录上还有逐个目录的"区分大小写"标志
  （WSL/开发者工具会设），用 `fsutil file queryCaseSensitiveInfo <dir>` 查询。
- 默认路径上限 260（`LongPathsEnabled=0` 时）。症状：`ENAMETOOLONG`、深层 `node_modules` 安装失败、
  `Remove-Item` 删不掉。对策：缩短根路径、开长路径支持、`git config --global core.longpaths true`、
  必要时用 `\\?\C:\...` 前缀。
- `cmd.exe` 不能把 UNC 路径作为当前目录（`CMD does not support UNC paths as current directories`）；
  用 `pushd \\server\share`（会临时映射盘符）或 `net use`。
- 路径由程序生成（`Join-Path`）或从枚举结果取，不要手抄：手抄多一个字符就会得出"文件不存在"的错误结论。
  关键判定用**双证据**（例如同时列出父目录内容）。

### 5.2 盘类型

- **网络盘/UNC**：锁语义不同、`rename` 可能失败、文件监视不可靠、`git` 在网络盘上不安全（还常报
  `detected dubious ownership` → `git config --global --add safe.directory <path>`）。
- **OneDrive/同步盘**：与同步进程抢锁（`EPERM/EBUSY`），"文件按需下载"会让文件看起来是空的或触发下载。
  构建产物、`node_modules`、临时库都不要放在同步目录里。
- **U 盘/FAT/exFAT**：无符号链接/硬链接、无可靠锁、随机 I/O 慢；pnpm 的硬链接方案会退化成复制。
- **跨盘 `rename`**：不是原子操作，会 `EXDEV`。`TEMP` 与工作区不在同一个盘时特别注意（本机就是
  `C:` 上的 TEMP、`E:` 上的工作区）——需要原子替换的临时文件要放在目标同盘。

### 5.3 权限与安全策略（拦下之后重试无用）

| 拦截者 | 典型症状 | 处置 |
|---|---|---|
| UAC | `Start-Process -Verb RunAs` 弹窗、无头下挂住 | 不要自我提权；改为用户级安装，或让用户执行 |
| 权限不足 | 服务安装、`HKLM` 写入、改 PATH、`icacls`/`takeown` 失败 | 全程用户级方案（`npm i -g --prefix`、`winget --scope user`、便携版解压） |
| Developer Mode 关 | `mklink`、`New-Item -ItemType SymbolicLink` 报权限错误 | 用复制/真实目录，或让用户开开发者模式 |
| ExecutionPolicy | `npm.ps1`、`npx.ps1` 报 "running scripts is disabled" | 用 `.cmd`/`.exe` shim；或单进程 `-ExecutionPolicy Bypass` |
| MOTW（`Zone.Identifier`） | 下载来的 `.ps1`/`.exe`/`.zip` 被拦、SmartScreen | `Unblock-File <path>`；zip 用 `Expand-Archive` 后再解除 |
| AppLocker/WDAC | 从 `%TEMP%`/`%USERPROFILE%` 运行未签名 exe 报"被系统管理员阻止" | 从受信任位置运行（`Program Files` 或策略允许的目录） |
| Defender 实时扫描 | 刚写完的文件短暂被占用 → `EPERM/EBUSY`；安装/测试变慢 | 受限重试（见 §6）；必要时让用户加排除目录 |
| Defender 受控文件夹访问 | 往"文档/桌面/图片"写文件被拦（"未授权更改被阻止"） | 构建输出放受保护目录之外 |
| Windows 防火墙 | 首次绑定 `0.0.0.0` 弹窗/静默拦截 | 测试绑 `127.0.0.1`（回环不触发）；确实要开端口再用 `netsh advfirewall`（需管理员） |

**dsh 自己的文件沙箱也是"拦截者"**，它的报错直接出现在工具结果里，语义与上表同类：

- `[sandbox: file access denied under <mode> mode]` 是策略拒绝，不是命令的 bug；换一种写法重试无用。
  按提示在允许的范围内操作，或在会话允许时按规则提权重试一次。
- 只读（read-only）沙箱下 pwsh 运行在 **ConstrainedLanguage**：`[System.IO.*]::`、`[math]::`、
  `Add-Type`、COM、反射都会报 "only core types"；此时只用 cmdlet 与基础类型（`[string]`、`[datetime]`、
  `[regex]`、`[guid]`；`-f` 格式化、属性访问正常）。
- 两种受限模式下**命名管道不可用**：Node 的 `child_process.spawn/exec` 用默认 `stdio:'pipe'` 会
  `EPERM`，`stdio:'inherit'`/`'ignore'` 可用；pwsh 自己的管道不受影响。

---

## 6. 轴 10：并发、文件锁与"假失败"（Defender 实时扫描同时属于轴 6）

Windows 打开的文件默认独占，这是与 Unix 最大的行为差异。后果与对策：

1. **`rename`/`unlink`/`rmdir` 的 `EPERM/EBUSY/EACCES` 往往是毫秒级占用**（杀软、索引器、
   正在跑的 node 进程）。受限重试即可稳定：

   ```js
   const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])
   export async function renameWithRetry(from, to, rename) {
     for (let attempt = 0; ; attempt += 1) {
       try { return await rename(from, to) } catch (error) {
         if (attempt >= 4 || !RETRYABLE.has(error?.code)) throw error
         await new Promise((r) => setTimeout(r, 10 * (attempt + 1)))
       }
     }
   }
   ```
2. **正在运行的 `.exe`/`.dll` 不能覆盖或删除**：`npm i -g` 升级正在使用的工具会失败。
   先停进程再升级；停的时候连子孙一起杀：`taskkill /PID <pid> /T /F`（`Stop-Process` 会留子进程占文件）。
3. **同一棵目录树一次只跑一件重活**（npm install / server / git / 测试）。要并发就复制到独立目录 +
   换端口（"隔离实例"模式），不要在同一棵树里并行。
4. **弹窗类"不是崩溃"的现象**：一闪而过的黑框（新控制台）、git 凭据框、防火墙框。
   根因是把交互式进程当后台任务跑；对策是后台任务 + 输出重定向到文件 + 全程非交互参数。
   真要查崩溃：`Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2; StartTime=(Get-Date).AddHours(-8)}`，
   转储在 `%LOCALAPPDATA%\CrashDumps`。
5. **多会话共享一个仓库**：动手前先 `git status --short` 看清别人改了什么；提交只 `git add` 自己改的路径，
   不要 `git add -A`。
6. **长任务放后台**（`run_in_background: true`）并给网络请求绝对超时（`AbortSignal.timeout(...)`）；
   被强杀在 Windows 上表现为 `[exit code: 1]` 且**没有**信号标记——那是终止，不是命令失败。

---

## 7. 退出码、管道与"看起来失败"

`$LASTEXITCODE` 是原生命令的退出码，`$?` 只反映"上一条命令有没有报错"。要点：

- 取 `$LASTEXITCODE` 要**紧跟其后**，它会被后续原生命令覆盖。
- **管道截断会伪造失败**：`& cmd.exe /c 'git status --short' | Select-Object -First 25` 可能得到
  `[exit code: 1]`，其实是 PowerShell 提前关管道导致上游 broken pipe。
- **`|` 落在哪一侧很关键**：`& cmd.exe /c "git status" | Select-Object -First 20` 里的 `|` 归 cmd 解析，
  于是报 `'Select-Object' is not recognized as an internal or external command`。
- 想截断输出：重定向到文件再读，或把整条管道写进 `cmd.exe /c "..."` 里（用 `findstr` 等）。

**非零退出码 ≠ 失败**（先判语义）：

| 命令 | 非零的含义 |
|---|---|
| `robocopy` | 0–7 都是成功（1=复制了文件）；**≥8 才是失败** |
| `findstr` | 1 = 没有匹配（不是错误） |
| `where.exe` | 1 = 找不到 |
| `msiexec` | 3010 = 成功但需要重启 |
| `winget`/`choco` | 3010 类似；`choco` 有 `--no-progress` 才不刷屏 |
| `git diff --quiet`/`--exit-code` | 1 = 有差异（这是它的用法） |
| `fc`/`comp` | 1 = 文件不同 |

**Win32 与 Node 的假失败**：`[exit code: 1]` 出现在被取消的后台任务、被 `taskkill` 的进程上，属正常终止。

---

## 8. 交互提示：无头会话的头号杀手

`-NonInteractive` 下，任何等待输入的行为都会挂到超时（或弹出无人能点的窗口）。**默认给所有命令加非交互参数**：

| 工具 | 非交互写法 |
|---|---|
| git（凭据） | `$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'`；或用 `credential.helper=` 临时清空 |
| git（ssh 主机指纹） | `-o BatchMode=yes -o StrictHostKeyChecking=accept-new`；或先 `ssh-keyscan` 写 `known_hosts` |
| ssh 密钥 | `ssh-keygen -t ed25519 -N "" -f <path>`（`-N ""` 是免口令，别漏） |
| npx / npm create / npm init | `npx --yes ...`、`npm init -y`、`npm exec --yes` |
| npm ci/install | `--no-audit --no-fund --yes`；CI 用 `npm ci` |
| winget | `--accept-package-agreements --accept-source-agreements --disable-interactivity` |
| choco | `-y --no-progress` |
| 删除/覆盖 | `-Confirm:$false -Force`；`cmd /c del /f /q`、`rd /s /q` |
| `Read-Host`/`pause`/`set /p`/`choice` | 根本不要在无头里用；用参数、环境变量或文件传值 |
| `Start-Process` GUI 程序 | 无头下不要启动 GUI（看不到、退不出） |

`-NoProfile` 还意味着：**别指望用户 profile 里的 `conda activate`、自定义函数、PATH 追加**。环境要在
同一条命令里显式准备好；跨调用不存在任何状态。

---

## 9. 命令模板速查（复制即用）

```powershell
# A. 抓原生命令输出 + 退出码（最常用；重定向写在 cmd 内部，字节原样写）
$w = 'E:\proj'
& cmd.exe /d /s /c "cd /d `"$w`" && npm test > `"$w\out.txt`" 2>&1"
$code = $LASTEXITCODE
Get-Content "$w\out.txt" -Encoding UTF8 | Select-Object -Last 40

# A'. 更好的方式：argv 直传，无引号问题，超时杀整棵树
node "<技能目录>\scripts\win-run.mjs" --cwd E:\proj --timeout 900000 -- npm test
# 参数含引号/元字符时也必须走 .mjs：PS 5.1 把内嵌双引号交给 .cmd/原生 exe 时会丢引号（§2）
node "<技能目录>\scripts\win-run.mjs" -- node -e 'console.log(process.version)'

# B. 只看关键行
Get-Content $f -Encoding UTF8 | Select-String -Pattern 'PASS','FAIL','exit code'

# C. 找文件/找内容 —— 优先用文件工具（glob/grep），shell 兜底：
Get-ChildItem $w -Recurse -File -Filter '*.mjs' | Select-Object -First 20 -ExpandProperty FullName
Select-String -Path "$w\*.md" -Pattern 'keyword' | ForEach-Object { "$($_.Filename):$($_.LineNumber)" }
# 注意：-Include 不配 -Recurse 会静默返回空（不报错！）

# D. 进程与命令行（谁占着文件/端口）
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'E:\\proj' } |
  ForEach-Object { "PID $($_.ProcessId): $($_.CommandLine)" }
taskkill /PID <pid> /T /F          # 连子孙一起杀（wmic 在 Win11 24H2 已移除，用 CIM）

# E. 端口占用与保留范围
Get-NetTCPConnection -LocalPort 3080 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess
netstat -ano | findstr :3080
netsh int ipv4 show excludedportrange protocol=tcp   # Hyper-V/WSL 预留端口：命中就会 EACCES

# F. 写文件一律用文件工具或 Node
node -e "require('fs').writeFileSync('out.json', JSON.stringify(x), 'utf8')"

# G. git 提交信息含中文/多行：写进文件再 -F（文件必须 UTF-8 无 BOM）
git commit -F "$w\.git-msg.txt"

# H. 长任务：run_in_background + 明确的等待；不要前台干等
```

---

## 10. git 在 Windows 的专属坑

| 现象 | 根因 / 处置 |
|---|---|
| `warning: LF will be replaced by CRLF` | `core.autocrlf=true`。源码仓库建议 `core.autocrlf input` + `.gitattributes: * text=auto eol=lf` |
| 检出后 shell 脚本报 `/bin/bash^M: bad interpreter` | 脚本被写成 CRLF。用 `.gitattributes` 固定 `*.sh text eol=lf` |
| 中文路径显示 `\346\226\207` | `git config --global core.quotepath false` |
| `detected dubious ownership` | 网络盘/他人拥有的目录：`git config --global --add safe.directory <path>` |
| `Unable to create ... index.lock: File exists` | 上一次 git 被强杀留下的锁：确认没有 git 在跑后删掉 `.git/index.lock` |
| 长路径检出失败 | `git config --global core.longpaths true` |
| 企业代理/HTTPS 证书错误 | `git config --global http.sslBackend schannel`（用 Windows 证书库）；或设 `http.proxy` |
| 凭据管理器弹窗 | `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never` |
| 提交范围失控 | 显式列路径 `git add a.md b/`；提交前 `git status --short` + `git diff --cached --stat` 复核 |
| 想把文件移出版本库但保留磁盘 | `git rm -r --cached <p>` + 写 `.gitignore`（不要用 `git rm`，会删文件） |
| 看不到"多余文件" | 被 `.gitignore` 忽略：`git status --ignored`、`git check-ignore -v <p>` |

---

## 11. Node / npm / 构建在 Windows 的专属坑

1. **Node 不能直接 spawn `.cmd`**：Node 18.20.3/20.12.2 起（CVE-2024-27980 修复）用 `shell:false`
   启动 `.bat`/`.cmd` 会 `EINVAL`。要么 `{ shell: true }`，要么解析出真实 `.exe`
   （本技能 `run-native.mjs` 的做法：`resolveCommand` + 仅对 shim 走 shell；参数含空格/元字符时
   拒绝并提示改用 pwsh 工具）。
2. **PATH 里有同名无扩展名脚本**：`npm`、`git` 旁边常有给 Git Bash 用的无扩展名脚本；
   CreateProcess 跑不了它，误选会得到 `spawn npm ENOENT`。解析时优先 PATHEXT 变体。
3. **`.ps1` shim 被策略拦**：`pnpm.ps1`/`npm.ps1` 在 ExecutionPolicy 受限时不可执行；
   用 `.cmd` shim 或在 pwsh 工具里直接调用。
4. **`python` 可能是 Microsoft Store 的占位程序**（会提示去商店安装）。用 `py -3` 或完整路径；
   node-gyp 需要真 Python + VS Build Tools，可用 `npm config set msvs_version 2022`、
   `npm config set python <path>`；装不上就找预编译产物或 `--ignore-scripts`（清楚风险）。
5. **nvm-windows**：`C:\Program Files\nodejs` 是指向当前版本的 junction。**切换版本时不能有正在
   使用它的进程**（会破坏运行中的 shell/服务）；切换后确认 `node -v` 与 `where.exe node`。
6. **ESM 模块缓存**：改了被 `import` 的源码必须**新起进程**才生效（对 DSH 自身也一样：host 半区改动
   需要重启进程，client 半区刷新页面即可）。
7. **pnpm 硬链接**：只在同一卷内有效；store 与项目跨盘会退化为复制/报长路径错误。
8. **网络请求必须带超时**，否则会永久挂住（没有超时的一次 GitHub 请求实测挂到 300s 被强杀、零输出）。
9. **`node --test` + `node --check`** 足够做闸门：`node --check <file>` 查语法，`node --test` 跑测试。
10. **临时前缀空跑升级**：`npm install --prefix <临时目录> <包>@<新版本>`，冷启动验证过再升级生产环境。

---

## 12. 报错原文 → 根因 → 处置（索引）

| # | 报错（节选） | 根因 | 处置 |
|---|---|---|---|
| 1 | `The string is missing the terminator: '.` / `'@Remote' can be used only as an argument to a command.` | 单引号字符串里出现 `'`（正则 `'/|`），后续全部错位 | 用 grep 工具；或双引号包正则、分离单引号 |
| 2 | `An empty pipe element is not allowed.` | 同上引号错位的连带表现 | 同上 |
| 3 | `'Select-Object' is not recognized as an internal or external command` | `& cmd.exe /c "..." \| Select-Object` 的 `\|` 归 cmd 解析 | `\|` 放对侧；或重定向到文件再读 |
| 4 | `'tail' is not recognized ...` | Windows 默认没有 Unix 工具 | `Select-Object -First/-Last`；或 Go/文件工具 |
| 5 | `Cannot overwrite variable HOME because it is read-only or constant.` | 用了 `$HOME` 当变量名 | 换名 `$dshHome`/`$repoRoot`；同类：`$PID $HOST $ERROR $INPUT $ARGS $_ $? $Matches` |
| 6 | `The token '&&' is not a valid statement separator in this version.` | PowerShell 5.1 | shell 层用 `;`；`&&` 只在 `cmd.exe /c "..."` 字符串内 |
| 7 | `.ps1` 报 `Unexpected token ...` 并伴随乱码注释 | 5.1 按 ANSI 读 UTF-8 无 BOM 的 `.ps1`，中文注释吃掉引号结构 | `.ps1` 纯 ASCII / UTF-8 with BOM / 改用 `.mjs`（最省事） |
| 8 | `job_list : The term 'job_list' is not recognized ...` | 把 agent 工具名当 shell 命令 | 工具走工具通道；shell 只能调真实可执行文件（`Get-Command -All` 确认） |
| 9 | `ConvertFrom-Json` 对合法 JSON 报错 | 5.1 的 JSON 解析脆弱 | 用 Node 解析或文件工具读 |
| 10 | 输出里 `灞傦細澶嶅埗...` | 按 ANSI 解码了 UTF-8 字节（或反过来） | 明确编码：`-Encoding UTF8`；写文件用文件工具/Node |
| 11 | `EPERM: operation not permitted, rename '...tmp' -> '...json'` | 杀软/索引器/运行中进程的瞬时占用 | 受限重试（10/20/30/40ms，仅 EPERM/EBUSY/EACCES） |
| 12 | 脚本挂到 300s 被强杀、无任何输出 | 网络请求无超时 | `AbortSignal.timeout(...)`；长任务放后台 |
| 13 | `Get-ChildItem -Include *.txt` 静默返回空 | `-Include` 未配 `-Recurse` | 加 `-Recurse`，或用 `Where-Object`/`-Filter` |
| 14 | 取消后台任务后 `[exit code: 1]` 无信号标记 | Windows 强杀的既定表现 | 不要当作命令失败 |
| 15 | 看似"文件不存在" | 手抄路径多/少了一个字符 | 路径由程序生成或枚举取得；关键判定双证据 |
| 16 | `spawn npm ENOENT`（Node 里） / `EINVAL` | 选中了无扩展名的 POSIX 脚本；或 Node 拒绝直接 spawn `.cmd` | 解析 PATHEXT 变体优先；`.cmd` 用 `shell:true`（本技能 `win-run` 已处理） |
| 17 | 参数里的 `"` 消失（如 `-e "a(b)"`） | 5.1 向原生命令传递内嵌引号是 Legacy 行为；PS 还会把未加引号的 `()` 当表达式 | 参数写进文件；或用 `win-run` argv 直传；或改成 `-f <file>` |
| 18 | `无法将"xxx"项识别为 cmdlet...` 其实想调 `where`/`curl`/`ls` | 别名遮蔽原生命令（`where`=Where-Object） | 写 `where.exe`/`curl.exe`，或 `Get-Command -All <name>` |
| 19 | `File name, directory name, or volume label syntax is incorrect` | 文件名含 `:` 等非法字符（常见：ISO 时间戳） | 时间戳改用 `-`/`_`；避开保留设备名 |
| 20 | `ENAMETOOLONG` / 深层 node_modules 失败 | 路径超 260 且未开长路径 | 缩短根路径、开 LongPathsEnabled、`git core.longpaths` |
| 21 | 服务器绑定报 `EACCES`（端口看似空闲） | 命中 Hyper-V/WSL 预留端口范围，或 `http.sys` URL ACL | 换高端口；`netsh int ipv4 show excludedportrange protocol=tcp` |
| 22 | 首次绑定 `0.0.0.0` 后无响应/弹窗 | Windows 防火墙对话框（无头不可回答） | 测试绑 `127.0.0.1`；要外部访问再让用户/管理员加规则 |
| 23 | `文件正被另一个进程使用` / 覆盖安装失败 | 目标进程正在运行 | 先 `taskkill /PID <pid> /T /F`，再安装 |
| 24 | `running scripts is disabled on this system` | ExecutionPolicy 限制 `.ps1` shim | 走 `.cmd`/`.exe`；或单进程 `-ExecutionPolicy Bypass` |
| 25 | `Unauthorized change blocked` / 写入被拒（自己的目录） | Defender 受控文件夹访问 | 输出移到受保护目录外 |
| 26 | `This app has been blocked by your system administrator` | AppLocker/WDAC 拦截 `%TEMP%` 下未签名 exe | 从受信任目录运行 |
| 27 | 下载的脚本/可执行文件打不开 | MOTW（`Zone.Identifier`） | `Unblock-File <path>`；`Get-Item -Stream Zone.Identifier` 确认 |
| 28 | `python` 打开微软商店 | Store 占位程序 | 用 `py -3` 或真实 python 路径 |
| 29 | `CMD does not support UNC paths as current directories` | 把 UNC 当 cwd | `pushd \\server\share` 或映射盘符 |
| 30 | git 切分支 `unable to create file ... File exists` | 只差大小写的两个路径在 NTFS 上是同一个文件 | 避免只差大小写的重命名；临时用 `git checkout -f` 后清理 |
| 31 | `setx PATH` 之后 PATH 变短/内容丢失 | `setx` 在 1024 字符处截断 | 用 `[Environment]::SetEnvironmentVariable('PATH', $v, 'User')`，且注意只对新进程生效 |
| 32 | 同一份配置在 5.1 能跑、7 上变成终止错误 | 7.3+ `$PSNativeCommandUseErrorActionPreference` / 7.2+ 参数传递策略 | 显式设置该偏好，或用与版本无关的写法（§2） |

---

## 13. 交叉平台桥（Windows ⇄ bash）

- 路径：`C:\a\b` ↔ WSL `/mnt/c/a/b`、Git Bash `/c/a/b`、Cygwin `/cygdrive/c/a/b`。转换要显式做。
- 行尾：任何 `.sh`、`Makefile`、`Dockerfile`、`.editorconfig` 关心的文件都用 LF；`.cmd`/`.bat` 用 CRLF。
  写入时用文件工具指定内容（LF），需要 CRLF 的 `.cmd` 单独转换并自检。
- shebang：CRLF 的 `#!/bin/sh` 在 bash 下报 `bad interpreter`。
- Git Bash 会把看起来像路径的参数改写（`MSYS_NO_PATHCONV=1` 关闭）；跨边界传路径时优先传文件。
- 同一个仓库里，Windows 侧与 WSL 侧不要同时跑重活（两套文件语义、两套缓存、可能两套 node）。

---

## 14. 动手前自检（45 秒）

- [ ] 这次调用里我在哪个 shell？能用 `&&` 吗？（不确定就先 `$PSVersionTable.PSEdition`）
- [ ] 命令里有嵌套引号或 >3 个引号吗？→ 写成 `.mjs`/`.cmd` 或改用 `win-run`。
- [ ] 有非 ASCII 字符要进 `.ps1`/`.cmd` 吗？→ 改为 `.mjs`，或保证纯 ASCII。
- [ ] 我要写文件吗？→ 文件工具/Node，不用 `Set-Content`/`>`。
- [ ] 我要读文件吗？→ `-Encoding UTF8`，或文件工具。
- [ ] 这是原生命令吗？→ 退出码看 `$LASTEXITCODE`，输出重定向到文件再读；非零先判语义（§7）。
- [ ] 会不会等交互？→ git/ssh/npx/npm/winget/删除，全部加非交互参数。
- [ ] 会不会弹窗（UAC/防火墙/SmartScreen/GUI）？→ 无头下必挂，改方案。
- [ ] 同目录有别的重活在跑吗？→ 串行化，或复制到独立目录 + 换端口。
- [ ] 网络请求有超时吗？长任务进后台了吗？
- [ ] 路径可靠吗（程序生成 vs 手抄）？有 260 上限/非法字符/大小写冲突吗？
- [ ] 会动到用户真实数据/正在运行的服务吗？→ 先做隔离副本，再多端口并行验证。

---

## 15. 反模式（明确不要做）

- ❌ 在单行命令里堆嵌套引号、正则、通配符和中文。
- ❌ 用 shell 的 `cat`/`grep`/`find`/`tail`/`sed` 代替文件工具。
- ❌ 用 PowerShell 写 YAML/JSON/源码（BOM/UTF-16LE/ANSI 三选一）。
- ❌ 用 `native | Select-Object -First N` 截断输出；把 `|` 写在 `cmd.exe /c "..."` 外面。
- ❌ 把非零退出码一律当失败；把被强杀的 `[exit code: 1]` 当失败。
- ❌ 在同一棵目录树里并发跑 npm install / server / git / 测试。
- ❌ 用 `Stop-Process` 杀带子进程的任务；用 `Start-Process` 开新窗口跑后台任务。
- ❌ 指望跨调用保留 cwd/环境变量/profile 函数。
- ❌ 在没有超时的情况下发起网络请求或长时间命令。
- ❌ 用带冒号的 ISO 时间戳命名文件；手抄路径。
- ❌ 试图自我提权（UAC 弹窗无人可点）；在无头会话启动 GUI 程序。

---

## 16. 本技能附带的脚本

路径：`<本技能目录>\scripts\`（技能加载时会告知本技能的基础目录）。

| 文件 | 用途 |
|---|---|
| `win-env-probe.mjs` | 探测 §1 的十二个环境轴，输出可读报告 + JSON；`--out <file>` 落盘、`--json` 只要 JSON、`--fast` 跳过杀软/端口探测、`--cwd <dir>` 指定工作区 |
| `win-run.mjs` | 以 argv 直传运行原生命令：无 shell 引号、真实退出码、UTF-8 收集、`--timeout` 到期**杀整棵进程树**、`--out` 保存完整输出、`--max` 截断上限、`--cwd`、`--env K=V`、`--shell`、`--json`、`--print-cmd` |
| `run-native.mjs` | 共享库：`resolveCommand`（PATHEXT 语义）、`runSync`/`runAsync`、`killTree`、`resolveHarnessPwsh`、`decodeBytes`（按 ANSI 代码页解码管道字节）、`parseKeyValueLines` |
| `win-env-probe.cmd` / `win-run.cmd` | **仅**用于 `node` 不在 PATH 时的 node 定位包装（纯 ASCII、CRLF）；参数边界见下 |

用法示例（在 `pwsh` 工具里；`.mjs` 是默认形式）：

```powershell
node "<技能目录>\scripts\win-env-probe.mjs" --out .\win-env.json
node "<技能目录>\scripts\win-run.mjs" --cwd E:\proj --timeout 900000 --out E:\proj\dev\logs\test.txt -- npm test
node "<技能目录>\scripts\win-run.mjs" -- git status --short
```

**边界（实测结论，别踩）：**

- `.mjs` 形式是 argv 直传：参数里的空格、`& | < > ^`、反斜杠路径都原样送达；`-- node -e 'process.exit(3)'`
  的退出码 3 原样透传。
- `.cmd` 包装**不能**用于复杂参数：它用 `%*` 转发，调用它的那一行会先被 `cmd.exe` 解析一遍，
  `&`/`|` 在包装脚本运行之前就被拆成多条命令（实测：`'y' is not recognized as an internal or external
  command`、退出码 255）——包装内部的任何防护都来不及生效。PowerShell 5.1 把内嵌双引号交给
  `.cmd`/原生 exe 时还会直接丢引号（§2），所以"用引号包一层"也不可靠。
- `run-native.mjs` 的 `shellJoinProblem` 会让 `win-run.mjs` **拒绝**把含空格/元字符的参数交给它去
  spawn 的 `.cmd`/`.bat` shim；那与上面这条是两件事——前者是它替你去跑别的程序，后者是它自己被谁调用。
- 结论：参数可能含空格+元字符或引号时，写一个 `.mjs` 脚本（§0 第 3 条）或用 `.mjs` 形式直调，
  不要经过 `.cmd`。

---

## 17. 这份手册的来源与适用范围

- 原始素材：一次真实长链路会话的踩坑记录（Windows 10 18362、Windows PowerShell 5.1、
  代码页 936、Node 22、npm 内网镜像、git 2.32）。本文件保留其全部结论，并补上"同一类问题在别的
  Windows 分支下长什么样"，因此**不绑定那一台机器**：所有条目都写成"判定 → 分支 → 对策"。
- 本文件的实测标记（§3 的字节表、§6 的重试、§7 的假失败、§10/§12 的部分条目）来自对当前机器的
  真实命令输出，可在本工作区复现：`win-env-probe.mjs` 的输出即为现场证据。
- 原始会话记录若需查阅，见同目录 `references/` 下的原始笔记。
- **版本基线：`@deepseek-ai/dsh` 0.1.5-rc.2**（2026-09-20 安装、并已实际运行）。与 harness 行为有关的
  事实逐条对过该版本的源码：`dsh-pwsh-local`（`-NoLogo -NoProfile -NonInteractive -Command`、UTF-8
  输出前置声明、`NO_COLOR=1`、解析顺序 程序目录 PowerShell 7 → PATH → `System32` 5.1）、
  `dsh-tool-pwsh`（每次调用新进程、`workdir`、`[exit code: N]`、Windows 强杀 = `[exit code: 1]` 无信号、
  默认开放 `run_in_background`、沙箱下的 ConstrainedLanguage 与命名管道限制）、`dsh-skill-filesystem`
  （`customSkillDirs`）、`dsh-persona`（`prefix` + `suffix`）。dsh 升级后复核时，重读这几个包的
  `lib/index.js` 与相关 schema 即可；本 preset 的 composition 以同一版本的 shipped `standard` 为基线，
  升级后按 preset 头部注释里写的三处改动重新套用。
