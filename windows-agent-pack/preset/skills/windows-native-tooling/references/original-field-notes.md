# Windows 上让 Agent 少踩坑的实战指南

> 来源：一次真实的长链路开发会话（在 Windows 上做 DSH 插件开发：npm 安装、隔离子进程、git 提交、PowerShell 编排脚本、Node 测试、并发跑多个 server）。
> 本文件记录**实际发生过的报错原文、根因、正确写法**，可直接摘取为新一代 agent 的 system prompt 片段。

---

## 0. 先认清环境（这是全部坑的总根源）

在这台机器上实测得到的事实：

| 项 | 实测值 | 影响 |
|---|---|---|
| 操作系统 | Windows 10（10.0.18362） | 无 Unix 工具链、路径分隔符 `\`、文件锁行为 |
| **`pwsh`/`powershell` 实际版本** | **`5.1.18362.2212`，`PSEdition = Desktop`** | **不是 PowerShell 7！** 没有 `&&`、没有 `??`、`-Encoding utf8` 会写 BOM、`ConvertFrom-Json` 更脆弱 |
| 控制台代码页 | **936（GBK）** | 读 UTF-8 输出/文件会乱码（`灞傦細` 这类） |
| Node | v22.22.0 | ESM 语义、`fs.rename` 的 EPERM 现象 |
| npm | 10.9.4，registry 指向内网 Nexus（内网地址略） | 安装走内网镜像；外网 `api.github.com` / `raw.githubusercontent.com` 可能长时间挂住 |
| git | 2.32.0.windows.2 | `core.autocrlf` 换行警告、credential/SSH 交互弹窗 |

**第 0 条铁律**：任何命令动手前先确认"我现在到底在哪个 shell 里"：

```powershell
$PSVersionTable.PSVersion; $PSVersionTable.PSEdition   # 期望能分辨 5.1/Desktop 与 7/Core
```

分辨不清就会写出"在我脑子里能跑、在这台机器上语法错误"的命令。

---

## 1. 十条铁律（可直接抄进 agent 指令）

1. **不要和 PowerShell 的引号搏斗**：命令一复杂（嵌套引号 + 正则 + 通配 + 中文），就**写成一个文件再执行**（`.mjs` 用 Node 跑，或 `.cmd`/`.ps1`），别在单行命令里堆。
2. **读写文件用专用工具（read/write/grep/glob），不要用 shell 等价物**（`cat`/`grep`/`find` 在这里不可靠或不存在）。
3. **脚本文件不要用 PowerShell 写**：5.1 的 `Set-Content -Encoding UTF8` **会写 BOM**，`Set-Content` 默认还是 ANSI。会让 YAML/JSON/JS 解析器炸掉。要写就用文件工具或 Node（`fs.writeFileSync(p, s, 'utf8')`）。
4. **`.ps1` 里不要放非 ASCII 字符**，除非确认会被 PS7 执行；5.1 按 ANSI/GBK 读 `.ps1`，中文注释会让**解析器直接报语法错误**（见 §3.4）。
5. **判定"命令失败"要看 `$LASTEXITCODE`，不要看 `$?`**；并且**管道截断会伪造失败**（见 §5.2）。
6. **PS 5.1 没有 `&&`**：shell 层用 `;`，需要"成功才继续"就写 `if ($LASTEXITCODE -eq 0) {...}`。`&&` 只允许出现在 `cmd.exe /c "..."` 的**字符串内部**。
7. **不要用保留/自动变量当自己的变量名**：`$HOME`、`$PID`、`$host`、`$error`、`$input`、`$args`、`$_`、`$?`、`$Matches`、`$PSVersionTable`……（我实际踩到的是 `$home`。）
8. **抓取原生命令输出 = 重定向到文件，再读文件**；不要 `native | Select-Object -First N`（截断 + 假失败 + 编码混乱）。
9. **同一棵目录树上不要并发跑重活**（npm install / server / git / 测试）。要并发就**复制到独立目录**（隔离实例、临时前缀）。这是 Windows 文件锁 + 弹框问题的根源。
10. **一切长时间/不可控操作都放后台任务并设超时**：npm 安装实测 8 分钟；外网请求要 `AbortSignal.timeout(...)`，否则会**永久挂住**（我遇到 300s 超时后仍无输出）。

---

## 2. 引号与转义（最高频的坑）

### 2.1 我实际撞到的原文

```
At line 7 char:70
+ ... t-String -Path $f -Pattern 'handle\(|route|path:|'/|Remote\(|@Remote| ...
                                                             ~
The string is missing the terminator: '.
'@Remote' can be used only as an argument to a command.
```

**根因**：我在**单引号字符串**里写了一个 `'`（`|'/|`）。PS 认为字符串到此结束，后面全部错位，于是报出一堆莫名其妙的连带错误（`@Remote`、`An empty pipe element is not allowed`）。

```
An empty pipe element is not allowed.
```

**根因**：同一类引号错位导致 `|` 出现在语句末尾。

### 2.2 正确姿势

```powershell
# 单引号是"字面量"，里面绝对不要出现 '（要表示单引号就写两个：''）
Select-String -Path $f -Pattern 'run|start|exec'          # ✅
Select-String -Path $f -Pattern "handle\(|@Remote"        # ✅ 双引号包正则，$ 需转义；@ 在双引号里安全
# 复杂正则/含引号/含 | 的检索：别用 shell —— 用 grep 工具 ✅✅
```

嵌套引号给 `cmd.exe` 传路径的**唯一可靠写法**（5.1 上验证可用）：

```powershell
$w = 'E:\JavaScript\dsh-enforce'
& cmd.exe /c "cd /d `"$w\workspace-manager`" && npm test > `"$w\out.txt`" 2>&1"
$code = $LASTEXITCODE
```

要点：外层双引号 + 内层 `` `" ``（反引号转义）+ 反引号里不放中文。**能不用就优先用单引号**：

```powershell
& cmd.exe /c 'cd /d E:\proj && npm test > E:\proj\out.txt 2>&1'   # ✅ 路径无空格时最稳
```

### 2.3 变量名里的正则/特殊字符

- `$env:X` 里 `@`、`:` 等一般安全，但**表达式位置**（不是命令参数位置）里 `@name` 会被当成 splatting 语法 → `'@Remote' can be used only as an argument to a command`。
- 含空格/中文/括号的路径**永远加引号**。

---

## 3. 文件与目录 cmdlet 的坑

### 3.1 `-Include` 不配 `-Recurse` 会静默什么都不匹配

```powershell
Get-ChildItem $w -File -Include *.txt        # ❌ 静默返回空（无报错！）
Get-ChildItem $w -File -Recurse -Include *.txt   # ✅
Get-ChildItem $w -File | Where-Object { $_.Extension -in '.txt','.log' }  # ✅ 更直观
Get-ChildItem $w -File -Filter *.txt         # ✅ 只要单个通配符时用 -Filter（更快）
```

我当时用错的后果：一批日志文件"搬走了"其实没搬，白跑一轮。

### 3.2 `Get-Content -Raw | ConvertFrom-Json` 可能失败（文件其实是好的）

同一批 `package.json`，用**文件读取工具**能正常解析，`ConvertFrom-Json` 却报错（报错信息还被我自己的 try/catch 吞成了"解析失败"）。
**处置**：解析 JSON 用 Node：`node -e "console.log(JSON.parse(require('fs').readFileSync(p,'utf8')).version)"`，或直接读文件。

### 3.3 编码：读文件必须显式指定

```powershell
Get-Content $f                  # ❌ 代码页 936 下读 UTF-8 中文 → 乱码
Get-Content $f -Encoding UTF8    # ✅
```

乱码实例：`# profile 灞傦細澶嶅埗鐪熷疄閰嶇疆` ← 这是 UTF-8 被按 GBK 解码的结果。**看到这种"汉字乱码 + 问号"就知道是编码问题，不是逻辑问题。**

### 3.4 `.ps1` 脚本的编码会决定它能否被解析（我为此整段失败）

我用文件工具写了一个含中文注释的 `setup-bootcheck.ps1`，用 `powershell -File` 执行：

```
At E:\...\setup-bootcheck.ps1:24 char:37
+ ... em -ItemType Directory -Path "$Target\profiles\web" -Force | Out-Null
Unexpected token '$Target\profiles\web" -Force | Out-Null
Missing closing '}' in statement block...
```

**根因**：文件是 UTF-8 **无 BOM**，而 Windows PowerShell 5.1 按 ANSI（GBK）读 `.ps1`。中文注释被解码成乱码后**把后面的引号结构吃掉了**，于是解析器看到的是截断的字符串。
**处置（三选一）**：
1. **`.ps1` 只用 ASCII**（注释也用英文）——最省事；
2. 保存为 **UTF-8 with BOM**（5.1 认 BOM）；
3. 用 PowerShell 7 执行（`pwsh -File`），PS7 默认 UTF-8。
**我的最终选择**：把这个脚本**改写成 `.mjs`（Node）**——Node 永远按 UTF-8 读源码，从此这类问题绝迹。

### 3.5 用 PowerShell 写文件给别人解析 = 埋雷

| 写法 | 结果 |
|---|---|
| `Set-Content x.json '{}'` | 5.1 默认 ANSI/UTF-16 → 解析器可能挂在 BOM/编码 |
| `Set-Content x.yml -Encoding UTF8`（5.1） | **写入 BOM**；YAML 解析器可能报首行非法 |
| `[IO.File]::WriteAllText($p,$s,[Text.UTF8Encoding]::new($false))` | ✅ 无 BOM UTF-8（但只读沙箱模式下 .NET 静态调用被禁） |
| 文件写入工具 / `node -e "fs.writeFileSync(p,s,'utf8')"` | ✅✅ 推荐 |

---

## 4. 保留变量与作用域

```
Cannot overwrite variable HOME because it is read-only or constant.
At line:6 char:74
+ ... ommandLine -match 'DSH_HOME'){ '(cmd 里 set 的)' } else { ...
SessionStateUnauthorizedAccessException
```

**根因**：我把 `$HOME` 当普通变量用（`$home = ...`）。`$HOME` 是 PS 的只读自动变量 → 赋值报错，且**错误发生在循环体里**，导致该次输出整体不可信。
**处置**：改用 `$dshHome`、`$userHome`、`$repoRoot` 这类名字。同类禁区：`$PID`、`$HOST`、`$ERROR`、`$INPUT`、`$ARGS`、`$MATCHES`、`$_`、`$?`、`$^`、`$$`、`$PSVersionTable`、`$PSScriptRoot`（只读但可读）。

---

## 5. 退出码、管道与"假失败"

### 5.1 `$LASTEXITCODE` 才是原生命令的退出码

```powershell
& cmd.exe /c "... npm test ..."
$code = $LASTEXITCODE          # ✅ 立即取，别隔几条命令再取（会被后续原生命令覆盖）
```
`$?` 只反映**上一条命令**是否"没有报错"，对原生命令非零退出码的语义不如 `$LASTEXITCODE` 明确。

### 5.2 管道截断会伪造失败

```powershell
& cmd.exe /c 'git status --short' | Select-Object -First 25
[exit code: 1]     # ❌ 看起来失败了，其实是 PS 提前关管道 → 上游 broken pipe
```
**另一个更隐蔽的版本**：把 `cmd.exe` 的输出接到 **PowerShell cmdlet** 上时，管道归 **cmd** 解析：

```
'Select-Object' is not recognized as an internal or external command,
operable program or batch file.
```
**根因**：`& cmd.exe /c "git status" | Select-Object -First 20` —— `|` 落到了 cmd 那边（因为我把管道写在了 cmd 字符串之外）。**处置**：要么把整条管道写进 cmd 字符串（用 `findstr`），要么**重定向到文件再读**：

```powershell
& cmd.exe /c "cd /d $w && git status --short > $w\dev\logs\status.txt 2>&1"
Get-Content "$w\dev\logs\status.txt" -Encoding UTF8 | Select-Object -First 25   # ✅
```

### 5.3 Unix 工具不存在

```
'tail' is not recognized as an internal or external command
```
用 `Select-Object -First/-Last N`、`Select-String`（≈grep）、`Measure-Object`、`Sort-Object -Unique`。

### 5.4 别把"工具名"当 shell 命令

```
job_list : The term 'job_list' is not recognized as the name of a cmdlet...
```
我的失误：把 **agent 工具名**写进了 PowerShell。**规则**：工具调用走工具通道，shell 只能调用真实存在的可执行文件/别名。写脚本前可以用 `Get-Command <name> -ErrorAction SilentlyContinue` 确认。

### 5.5 路径拼错会造成"看起来很严重"的假象

一次 `Test-Path` 用了多一个连字符的路径（`--D--data-…` vs `-D-data-…`）→ 判定"文件不存在"，我据此得出错误结论。**规则**：路径由程序计算（`Join-Path`）或从真实枚举结果里取，不要手抄；关键判定要**双证据**（例如同时列出父目录内容）。

---

## 6. 并发执行：文件锁、EPERM 与弹出的错误框

### 6.1 为什么"同时跑"会出问题

Windows 与 Unix 最大的差异：**打开的文件默认独占**。因此：

- 一个正在运行的 `node` 进程（如 `dsh web`）**持有** `node_modules` 里成千上万个文件 → 此时 `npm install` 覆盖该目录会 `EPERM/EBUSY`；
- 杀软/索引器会短暂持有刚写入的文件 → `fs.rename` 偶发 `EPERM`；
- `git` 遍历工作区时若有进程在写文件，会出现 `unable to unlink`/`Permission denied`；
- 多个 agent/会话同时对同一仓库操作（本次会话确实有"另一个 session 在提交"）→ 索引冲突、暂存内容互相覆盖。

**实测到的原文**（一次测试偶发失败）：

```
Error: EPERM: operation not permitted, rename
  '...\dsh-workspace-manager.state.json.21032.1789869663856.tmp' -> '...state.json'
    at async rename (node:internal/fs/promises:781:10)
```

**为什么必须重试**：这是**毫秒级**的瞬时占用，重试即成功。我在代码里加了受限重试，测试从"偶发失败"变为稳定通过：

```js
async function renameWithRetry(from, to) {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(from, to); return }
    catch (error) {
      if (attempt >= 4 || !retryable.has(error?.code)) throw error
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)))
    }
  }
}
```

### 6.2 关于"弹出的错误框"

我查了证据：**最近 8 小时的应用程序事件日志（Level 1–2）没有崩溃记录，也没有 `WerFault.exe` 进程**（只有无关的 Office 授权与证书注册告警）。所以那些框**大概率不是程序崩溃**，而是下面这些"会弹窗但不算崩溃"的行为：

| 现象 | 真实原因 | 消除办法 |
|---|---|---|
| git 弹出的窗口/凭据框 | `git push/fetch` 触发 **Git Credential Manager** 或 SSH host-key 交互 | `$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'`；SSH 用 `-o BatchMode=yes -o StrictHostKeyChecking=accept-new`；或先把 known_hosts 配好 |
| 一闪而过的黑框 | `cmd.exe`/`node.exe` 被以新控制台方式启动（尤其并发多个后台任务） | 用后台任务 + 输出重定向到文件；不要用 `Start-Process` 开新窗口 |
| "应用程序错误 / 0xc0000005" 类框 | 进程被强杀或崩溃后由 **Windows 错误报告** 弹框 | 避免 `Stop-Process -Force` 打正在写文件的进程；要杀就杀整棵树：`taskkill /PID <pid> /T /F`；确认方式见下 |
| 真正的崩溃排查 | — | `Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2; StartTime=(Get-Date).AddHours(-8)}`；崩溃转储在 `%LOCALAPPDATA%\CrashDumps` |

**消除"框"的根本办法：把并发变成串行 + 把交互变成非交互。**

### 6.3 实用的并发纪律

1. **同一棵树一次只跑一件重活**：`npm install` 时不要跑 server、不要跑 git、不要跑测试。
2. **要并发就隔离目录**：本次会话的做法是"复制一份 `DSH_HOME` 到临时目录 + 用不同端口起第二个实例"，由此能在**不碰正在使用的 GUI、不碰真实数据**的前提下做端到端验证。这是最值得复用的模式。
3. **大件下载/安装在后台任务里跑**（实测 523 个包 ≈ 8 分钟），期间只做互不干扰的事（写代码、读代码）。
4. **杀进程要连子孙一起杀**：`taskkill /PID <pid> /T /F`；只用 `Stop-Process` 会留下持有文件的子进程。
5. **多个会话/agent 共享一个仓库时**：先 `git status` 看清别人改了什么再动手；提交前只 `git add` 自己改的路径，别用全量 `git add -A`。

---

## 7. git 在 Windows 上的具体坑

| 现象 | 原因 / 处置 |
|---|---|
| `warning: LF will be replaced by CRLF in <file>` | `core.autocrlf=true`。对源码建议提交 `.gitattributes`：`* text=auto eol=lf`；注意构建脚本若统一行尾会与 git 反复拉扯 |
| 想把文件移出版本库但保留在磁盘 | `git rm -r --cached <path>` + 把该目录写进 `.gitignore`（**不要**用 `git rm`，那会删文件） |
| `git status` 看不到一堆"多余文件" | 它们被 `.gitignore` 忽略了。`git status --ignored` 可列出；`git check-ignore -v <path>` 可确认是哪条规则命中 |
| 中文路径显示成 `\346\226\207` | `git config core.quotepath false` |
| 提交信息含中文/多行 | 别用 shell 拼引号：把信息写进文件再 `git commit -F <file>`（注意该文件编码用 UTF-8 无 BOM） |
| 提交范围失控 | 显式列路径 `git add .gitignore README.md`；提交前用 `git status --short` + `git diff --cached --stat` 复核 |
| 一个仓库多会话并行 | 分支隔离 + 明确"谁推谁合"；本次会话就用 `git branch <名字> <commit>` 给旧版本留了一个干净分支 |

---

## 8. Node / npm 在 Windows 上的具体坑

1. **`fs.rename` 的 EPERM/EBUSY 要重试**（见 §6.1）；同理 `unlink`/`rmdir` 也可能瞬时失败。
2. **ESM 有模块缓存**：改了被 import 的源码后**必须新起进程**才能生效。在 DSH 语境里具体表现为：patch 层的条目改动可热生效，但 host 半区的模块代码改动**必须重启 dsh web**（client 半区刷新页面即可）。
3. **抓取网络请求一定要带超时**：`fetch(url, { signal: AbortSignal.timeout(20000) })`。我遇到过一次 GitHub API 请求无超时 → 整个脚本挂到 300s 被强杀，且没有任何输出。
4. **npm 走内网 registry**：`npm view <pkg> dist.tarball` 能确认包在内网镜像里存在，再决定是否安装。
5. **`npm install --prefix <dir>` 可把新版装到临时前缀做"升级空跑"**，不影响全局安装——强烈推荐在升级生产依赖前先这样验证（本次就是靠它发现"新版会导致整个进程启动失败"）。
6. **`node --test`（内置测试器）** 在 Windows 上足够用，不需要额外框架；配合 `node --check <file>` 做语法闸。
7. **隐藏的假失败**：Node 测试里出现 `EPERM` 时先怀疑并发/杀软，再怀疑代码。
8. **stdin/stdio**：在被限制的沙箱里，`child_process.spawn` 用**管道 stdio** 可能直接 `EPERM`（命名管道被禁）；改用 `stdio: 'inherit'` 或 `stdio: 'ignore'`，或走 `cmd /c "... > file"` 重定向。

---

## 9. 命令模板速查（复制即用）

```powershell
# A. 抓原生命令输出 + 退出码（最常用）
$w = 'E:\JavaScript\dsh-enforce'
& cmd.exe /c "cd /d `"$w`" && npm test > `"$w\dev\logs\out.txt`" 2>&1"
"exit=$LASTEXITCODE"
Get-Content "$w\dev\logs\out.txt" -Encoding UTF8 | Select-Object -Last 40

# B. 只想看关键行（避免输出刷屏）
Get-Content $f -Encoding UTF8 | Select-String -Pattern 'PASS','FAIL','exit code'

# C. 递归找文件/找内容 → 优先用工具（glob/grep），shell 兜底：
Get-ChildItem $w -Recurse -File -Filter '*.mjs' | Select-Object -First 20 -ExpandProperty FullName
Select-String -Path "$w\*.md" -Pattern 'keyword' | ForEach-Object { "$($_.Filename):$($_.LineNumber)" }

# D. 进程与命令行（排查"谁占着文件/谁在占端口"）
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match '3182' } |
  ForEach-Object { "PID $($_.ProcessId): $($_.CommandLine)" }
taskkill /PID <pid> /T /F          # 连子孙一起杀

# E. 端口占用
Get-NetTCPConnection -LocalPort 3080 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess

# F. 长任务放后台（配合 agent 的后台任务机制），不要前台干等
# G. 写文件一律用文件工具或 Node，不要用 Set-Content
```

---

## 10. 动手前自检清单（建议直接做成 agent 的前置检查）

- [ ] 我在这个 shell 里能用 `&&` 吗？（5.1 **不能**）
- [ ] 这条命令里有嵌套引号吗？有 → **改成写文件再执行**。
- [ ] 我用了 `'` 的单引号字符串里还有 `'` 吗？→ 会截断。
- [ ] 我的变量名撞了保留变量吗（`$HOME`/`$PID`/…）？
- [ ] 我读文件时带 `-Encoding UTF8` 了吗？我写文件时用的是文件工具而不是 `Set-Content` 吗？
- [ ] 我要跑的是原生命令吗？那退出码看 `$LASTEXITCODE`，输出**重定向到文件**再读。
- [ ] 输出管道里有没有 PowerShell cmdlet 会被 cmd 抢走？（`|` 必须在正确的一侧）
- [ ] 现在是否有别的重活在跑同目录（npm/server/git/测试）？→ 串行化，或复制到独立目录。
- [ ] 网络请求带超时了吗？
- [ ] 这会动到用户的真实数据/正在运行的服务吗？→ 先做隔离副本，再多端口并行验证。

---

## 附录 A：我实际遇到的报错 → 根因 → 处置（原文索引）

| # | 报错原文（节选） | 根因 | 处置 |
|---|---|---|---|
| 1 | `The string is missing the terminator: '.` / `'@Remote' can be used only as an argument to a command.` | 单引号字符串里出现 `'`（正则 `'/|`） | 改用 grep 工具；或双引号/regex 分离 |
| 2 | `An empty pipe element is not allowed.` | 同上引号错位的连带表现 | 同上 |
| 3 | `'Select-Object' is not recognized as an internal or external command` | `& cmd.exe /c "..." \| Select-Object` 中管道归 cmd 解析 | 重定向到文件再读 |
| 4 | `'tail' is not recognized ...` | Windows 无 Unix 工具 | `Select-Object -First/-Last` |
| 5 | `Cannot overwrite variable HOME because it is read-only or constant.` | 用了 `$HOME` 作变量名 | 改名 `$dshHome`/`$repoRoot` |
| 6 | `The token '&&' is not a valid statement separator in this version.` | PS 5.1 不支持 `&&` | shell 层用 `;`；`&&` 只在 cmd 字符串里 |
| 7 | `.ps1` 的 `Unexpected token '$Target\profiles\web" -Force \| Out-Null'` + 乱码注释 | 5.1 按 GBK 读 UTF-8 无 BOM 的 .ps1，中文注释吃掉引号结构 | .ps1 纯 ASCII / 带 BOM / 改用 .mjs |
| 8 | `job_list : The term 'job_list' is not recognized` | 把 agent 工具名当 shell 命令 | 工具走工具通道 |
| 9 | `ConvertFrom-Json` 对合法 JSON 报错 | 5.1 的 JSON 解析脆弱 | 用 Node 解析或文件工具读 |
| 10 | 输出里 `灞傦細澶嶅埗...` | 代码页 936 读 UTF-8 | `-Encoding UTF8` |
| 11 | `EPERM: operation not permitted, rename '...tmp' -> '...json'` | Windows 瞬时文件占用（杀软/索引器） | 受限重试（10/20/30/40ms，仅 EPERM/EBUSY/EACCES） |
| 12 | 脚本挂到 300s 被强杀、无任何输出 | 网络请求无超时 | `AbortSignal.timeout(...)` |
| 13 | `Get-ChildItem -Include *.txt` 静默返回空 | `-Include` 未配 `-Recurse` | 加 `-Recurse` 或改 `Where-Object` |
| 14 | 取消后台任务后 `[exit code: 1]` 无信号标记 | Windows 上强杀进程的既定表现 | **不要**当作命令失败；看输出与目标状态 |
| 15 | 看似"文件不存在" | 手抄路径多了一个连字符 | 路径由程序生成/枚举获得，关键判定要双证据 |

## 附录 B：值得固化的好模式（本次会话验证有效）

1. **隔离实例模式**：复制一份"家目录"（只读复制配置与数据，凭据不复制）→ 换端口启动真实服务 → 打真实接口做端到端验证 → 用完删除。**能在不影响用户正在使用的环境的前提下做最真实的验证。**
2. **临时前缀空跑升级**：`npm install --prefix <临时目录> <包>@<新版本>`，用新版本冷启动隔离实例验证一遍再动全局安装。本次正是靠它发现"新版会让进程启动失败"。
3. **探针脚本**：一个 40 行的 `probe-*.mjs`（查端口/查路由/查清单）反复使用，比每次手敲命令可靠得多。
4. **证据落盘**：每条重要结论都把命令输出重定向到 `logs/*.txt`，事后可复核、可写进报告。
5. **后台任务 + 明确等待**：长任务用后台，不要在前后台之间反复打断；杀掉时连子孙一起杀。
6. **写脚本而不是写长命令**：一旦命令超过 ~3 个引号或 2 个管道，就落成 `.mjs`/`.cmd` 文件。

---

*环境：Windows 10 (18362)、Windows PowerShell 5.1 Desktop、代码页 936、Node v22.22.0、npm 10.9.4、git 2.32.0.windows.2。*
