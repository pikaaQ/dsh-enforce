#!/usr/bin/env node
/**
 * win-env-probe.mjs - resolve the Windows environment axes ONCE, as facts.
 *
 *   node win-env-probe.mjs [--cwd <dir>] [--json] [--out <file>] [--fast]
 *
 * Everything a Windows agent tends to guess wrong is measured here: which
 * PowerShell backs the `pwsh` tool, code page, long-path and developer-mode
 * policy, elevation and session shape, drive types (local / network /
 * removable / OneDrive), the tools that actually exist, git and npm
 * configuration, and the TCP port ranges Windows already reserved.
 *
 * Output is UTF-8. `--json` prints one JSON object; `--out <file>` also writes
 * it to a file (UTF-8, no BOM) so a workspace can keep the facts. `--fast`
 * skips the slow antivirus/port queries.
 *
 * The independent probes run concurrently, so a full run costs about as much
 * as its slowest single probe instead of the sum.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { arch, cpus, hostname, release, totalmem, userInfo } from 'node:os'
import { delimiter, join, resolve as resolvePath } from 'node:path'
import { IS_WINDOWS, decodeBytes, resolveCommand, resolveHarnessPwsh, runAsync, parseKeyValueLines } from './run-native.mjs'

function parseArgv(argv) {
  const options = { cwd: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') options.json = true
    else if (token === '--fast') options.fast = true
    else if (token === '--out') options.out = argv[++i]
    else if (token === '--cwd') options.cwd = resolvePath(argv[++i] || '.')
    else if (token === '--help' || token === '-h') options.help = true
    else if (!token.startsWith('--')) options.cwd = resolvePath(token)
  }
  return options
}

const options = parseArgv(process.argv.slice(2))
if (options.help) {
  process.stdout.write('usage: node win-env-probe.mjs [--cwd <dir>] [--json] [--out <file>] [--fast]\n')
  process.exit(0)
}
const cwd = options.cwd
const env = process.env

const isAscii = (text) => /^[\x20-\x7e]*$/.test(String(text))
const hasSpace = (text) => /\s/.test(String(text))

/* ── 1. process / host facts (no I/O) ────────────────────────────────────── */

const homePath = env.USERPROFILE || env.HOME || ''
const oneDriveRoots = [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer].filter((value) => typeof value === 'string' && value.length > 0)
const lowerCwd = cwd.toLowerCase()
const pathEntries = (env.PATH || '').split(delimiter).map((entry) => entry.replace(/^"|"$/g, '').trim()).filter((entry) => entry.length > 0)
const lowerPathEntries = pathEntries.map((entry) => entry.toLowerCase())
const duplicatePathEntries = lowerPathEntries.filter((entry, index) => lowerPathEntries.indexOf(entry) !== index)
const tempPath = env.TEMP || env.TMP || ''
const driveLetterOf = (value) => (value.length > 1 && value[1] === ':' ? value.slice(0, 2).toUpperCase() : null)

const host = {
  platform: process.platform,
  osRelease: release(),
  arch: process.arch,
  cpuCount: cpus().length,
  totalMemGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  hostname: hostname(),
  user: userInfo().username,
  userPathAscii: isAscii(homePath),
  userPathSpaced: hasSpace(homePath),
  node: process.version,
  nodePath: process.execPath,
  cwd,
  cwdLength: cwd.length,
  cwdAscii: isAscii(cwd),
  cwdSpaced: hasSpace(cwd),
  cwdIsUnc: cwd.startsWith('\\\\'),
  cwdDrive: driveLetterOf(cwd),
  cwdInsideOneDrive: oneDriveRoots.some((root) => lowerCwd.startsWith(root.toLowerCase())),
  userProfile: homePath,
  homeDefined: typeof env.HOME === 'string' && env.HOME.length > 0,
  temp: tempPath || null,
  tempDrive: driveLetterOf(tempPath),
  systemRoot: env.SystemRoot || null,
  processorArchitecture: env.PROCESSOR_ARCHITECTURE || null,
  wow64: env.PROCESSOR_ARCHITEW6432 || null,
  sessionName: env.SESSIONNAME || null,
  sshConnection: typeof env.SSH_CONNECTION === 'string' && env.SSH_CONNECTION.length > 0,
  pathext: env.PATHEXT || null,
  pathEntryCount: pathEntries.length,
  pathTotalChars: (env.PATH || '').length,
  pathQuotedEntries: pathEntries.filter((entry) => /"/.test(entry)).length,
  pathNonAsciiEntries: pathEntries.filter((entry) => !isAscii(entry)).length,
  pathDuplicateEntries: [...new Set(duplicatePathEntries)],
  nodeExtraCaCerts: env.NODE_EXTRA_CA_CERTS || null,
  httpProxy: env.HTTP_PROXY || env.http_proxy || null,
  httpsProxy: env.HTTPS_PROXY || env.https_proxy || null,
  noProxy: env.NO_PROXY || env.no_proxy || null,
}

/* ── 2. tools that exist, and the bash dialect ───────────────────────────── */

const toolNames = [
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'corepack',
  'python', 'py', 'python3',
  'pwsh', 'powershell', 'bash', 'wsl', 'sh', 'ssh', 'scp',
  'tar', 'curl', 'robocopy', 'xcopy', 'where', 'findstr', 'taskkill', 'tasklist',
  'winget', 'choco', 'scoop', 'rg', 'fd', 'make', 'cmake', 'gcc', 'cl', 'msbuild', 'dotnet', 'vswhere', 'code', '7z', 'certutil', 'icacls', 'fsutil', 'netsh',
]
const tools = {}
for (const name of toolNames) {
  const found = resolveCommand(name, cwd)
  if (found) tools[name] = found
}

function bashDialectOf(path) {
  const lower = path.toLowerCase()
  if (lower.includes('system32') && lower.endsWith('bash.exe')) return 'wsl'
  if (lower.includes('\\git\\') || lower.includes('git\\bin') || lower.includes('git\\usr')) return 'git-bash'
  if (lower.includes('cygwin')) return 'cygwin'
  if (lower.includes('msys')) return 'msys2'
  return 'unknown'
}
const bash = tools.bash ? { path: tools.bash, dialect: bashDialectOf(tools.bash) } : null
const pathTranslation = !bash ? null
  : bash.dialect === 'wsl' ? 'C:\\x -> /mnt/c/x'
  : bash.dialect === 'git-bash' ? 'C:\\x -> /c/x'
  : bash.dialect === 'cygwin' ? 'C:\\x -> /cygdrive/c/x'
  : null

/* ── 3. the concurrent native probes ────────────────────────────────────── */

const programFiles = env.ProgramFiles || 'C:\\Program Files'
const pwsh7Path = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
const legacyPsPath = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const toolShellPath = resolveHarnessPwsh(env)

const psScriptLines = [
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
  "function E([string]$k,$v){ [Console]::Out.WriteLine($k + '=' + [string]$v) }",
  "E 'psVersion' $PSVersionTable.PSVersion.ToString()",
  "E 'psEdition' $PSVersionTable.PSEdition",
  "E 'outputCodePage' ([Console]::OutputEncoding.CodePage)",
  "E 'ansiCodePage' ([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage)",
  "E 'execPolicy' (Get-ExecutionPolicy).ToString()",
  "E 'longPathsEnabled' (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled).LongPathsEnabled",
  "E 'developerMode' (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense).AllowDevelopmentWithoutDevLicense",
  "E 'isAdmin' ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  "E 'userInteractive' [Environment]::UserInteractive",
  "E 'drives' ((Get-CimInstance Win32_LogicalDisk | ForEach-Object { $_.DeviceID + ' type=' + $_.DriveType + ' fs=' + $_.FileSystem + ' size=' + [math]::Round($_.Size/1GB,1) + 'GB free=' + [math]::Round($_.FreeSpace/1GB,1) + 'GB' }) -join ' ; ')",
]
if (!options.fast) {
  psScriptLines.push(
    "E 'defenderRealtime' (Get-MpComputerStatus).RealTimeProtectionEnabled",
    "E 'defenderCfa' (Get-MpPreference).EnableControlledFolderAccess",
    "E 'defenderExclusions' (((Get-MpPreference).ExclusionPath) -join ' ; ')",
    "E 'excludedTcpPorts' (((netsh int ipv4 show excludedportrange protocol=tcp) | Select-String -Pattern '^\\s+\\d+' | ForEach-Object { $_.Line.Trim() }) -join ' ; ')",
  )
}

const probePowershell = async () => {
  const result = await runAsync(toolShellPath || 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScriptLines.join('\n')], { cwd, timeoutMs: 90000 })
  const values = parseKeyValueLines(result.stdout)
  return { values, result }
}

const probeGitConfig = async () => {
  if (!tools.git) return null
  const listed = await runAsync('git', ['config', '--list'], { cwd, timeoutMs: 30000 })
  const values = {}
  let safeDirectoryCount = 0
  for (const line of listed.stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).toLowerCase()
    const value = trimmed.slice(index + 1)
    values[key] = value
    if (key === 'safe.directory') safeDirectoryCount += 1
  }
  const inside = await runAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 30000 })
  return { values, safeDirectoryCount, insideWorkTree: inside.stdout.trim() === 'true', raw: listed.stdout }
}

const probeNpm = async () => {
  if (!tools.npm) return null
  const listed = await runAsync('npm', ['config', 'list', '--json'], { cwd, timeoutMs: 90000 })
  // npm may print a warning line before the JSON object.
  const start = listed.stdout.indexOf('{')
  let parsed = null
  let error = null
  if (start >= 0) {
    try {
      parsed = JSON.parse(listed.stdout.slice(start))
    } catch (parseError) {
      error = `could not parse npm config JSON: ${parseError && parseError.message ? parseError.message : parseError}`
    }
  } else {
    error = (listed.stderr || listed.error || 'npm config list --json returned no JSON').slice(0, 400)
  }
  return { parsed, error }
}

const probeVersions = async () => {
  const wanted = [['git', ['--version']], ['node', ['--version']], ['npm', ['--version']], ['python', ['--version']]]
  const entries = await Promise.all(wanted.filter(([name]) => tools[name]).map(async ([name, args]) => {
    const result = await runAsync(name, args, { cwd, timeoutMs: 60000 })
    const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0]
    return [name, line || (result.error ? `error: ${result.error}` : null)]
  }))
  return Object.fromEntries(entries)
}

/**
 * `fsutil` writes through the ANSI/OEM code page, so its piped bytes are NOT
 * UTF-8 on a non-English Windows. Capture raw bytes and decode with the code
 * page the PowerShell probe reported.
 */
const probeCaseSensitive = async (ansiCodePage) => {
  if (!tools.fsutil) return null
  const result = await runAsync('fsutil', ['file', 'queryCaseSensitiveInfo', cwd], { cwd, timeoutMs: 30000, encoding: 'buffer' })
  const stdout = decodeBytes(result.stdoutBuffer, ansiCodePage)
  const stderr = decodeBytes(result.stderrBuffer, ansiCodePage)
  const text = `${stdout}\n${stderr}`.trim()
  const enabled = /is enabled|已启用|已开启|啟用/i.test(text) ? true : /is disabled|已禁用|已关闭|停用/i.test(text) ? false : null
  return { enabled, raw: text.split(/\r?\n/)[0] || null }
}

const [psProbe, gitProbe, npmProbe, versions] = await Promise.all([
  probePowershell(),
  probeGitConfig(),
  probeNpm(),
  probeVersions(),
])
const caseProbe = await probeCaseSensitive(psProbe.values.ansiCodePage)

/* ── 4. shape the results ───────────────────────────────────────────────── */

const ps = psProbe.values
const psFailed = psProbe.result.code !== 0 && Object.keys(ps).length === 0
const asBool = (value) => (value === undefined ? null : value === 'True')
const powerShell = {
  toolShellPath,
  toolShellVersion: ps.psVersion || null,
  toolShellEdition: ps.psEdition || null,
  toolShellIsCore: ps.psEdition === undefined ? null : ps.psEdition === 'Core',
  pwsh7Installed: existsSync(pwsh7Path),
  legacyPowerShellInstalled: existsSync(legacyPsPath),
  outputCodePage: ps.outputCodePage || null,
  ansiCodePage: ps.ansiCodePage || null,
  executionPolicy: ps.execPolicy || null,
  longPathsEnabled: asBool(ps.longPathsEnabled),
  developerMode: asBool(ps.developerMode),
  isAdmin: asBool(ps.isAdmin),
  userInteractive: asBool(ps.userInteractive),
  defenderRealtime: asBool(ps.defenderRealtime),
  defenderCfa: ps.defenderCfa === undefined ? null : ps.defenderCfa,
  defenderExclusions: ps.defenderExclusions || null,
  excludedTcpPorts: ps.excludedTcpPorts === undefined ? null : ps.excludedTcpPorts,
  error: psFailed ? (psProbe.result.stderr || psProbe.result.error || 'PowerShell probe produced no output') : null,
}

const driveTypes = { 2: 'removable', 3: 'local', 4: 'network', 5: 'cdrom', 6: 'ramdisk' }
const drives = String(ps.drives || '').split(' ; ').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
function describeDrive(letter) {
  if (!letter) return null
  const match = drives.find((entry) => entry.toUpperCase().startsWith(letter.toUpperCase()))
  if (!match) return { letter, kind: null, fileSystem: null, freeGB: null, raw: null }
  const type = /type=(\d+)/.exec(match)
  const fs = /fs=(\S+)/.exec(match)
  const free = /free=([\d.]+)GB/.exec(match)
  return {
    letter,
    kind: type ? (driveTypes[type[1]] || `unknown(${type[1]})`) : null,
    fileSystem: fs ? fs[1] : null,
    freeGB: free ? Number(free[1]) : null,
    raw: match,
  }
}
const workspaceDrive = describeDrive(host.cwdDrive)
const tempDriveInfo = host.tempDrive && host.tempDrive !== host.cwdDrive ? describeDrive(host.tempDrive) : null

const gitValue = (key) => (gitProbe ? gitProbe.values[key.toLowerCase()] : undefined)
const git = {
  insideWorkTree: gitProbe ? gitProbe.insideWorkTree : null,
  safeDirectoryCount: gitProbe ? gitProbe.safeDirectoryCount : null,
  core: {
    autocrlf: gitValue('core.autocrlf') || null,
    longpaths: gitValue('core.longpaths') || null,
    quotepath: gitValue('core.quotepath') || null,
    symlinks: gitValue('core.symlinks') || null,
    fscache: gitValue('core.fscache') || null,
  },
  httpSslBackend: gitValue('http.sslbackend') || null,
  httpProxy: gitValue('http.proxy') || null,
  credentialHelper: gitValue('credential.helper') || null,
  userName: gitValue('user.name') || null,
  userEmail: gitValue('user.email') || null,
  initDefaultBranch: gitValue('init.defaultbranch') || null,
}

const npm = {
  registry: npmProbe && npmProbe.parsed ? npmProbe.parsed.registry || null : null,
  prefix: npmProbe && npmProbe.parsed ? npmProbe.parsed.prefix || null : null,
  cache: npmProbe && npmProbe.parsed ? npmProbe.parsed.cache || null : null,
  proxy: npmProbe && npmProbe.parsed ? npmProbe.parsed.proxy || null : null,
  httpsProxy: npmProbe && npmProbe.parsed ? npmProbe.parsed['https-proxy'] || null : null,
  strictSsl: npmProbe && npmProbe.parsed && npmProbe.parsed['strict-ssl'] !== undefined ? npmProbe.parsed['strict-ssl'] : null,
  cafile: npmProbe && npmProbe.parsed ? npmProbe.parsed.cafile || null : null,
  msvsVersion: npmProbe && npmProbe.parsed ? npmProbe.parsed.msvs_version || null : null,
  python: npmProbe && npmProbe.parsed ? npmProbe.parsed.python || null : null,
  error: npmProbe ? npmProbe.error : null,
}

const filesystem = {
  caseSensitiveCwd: caseProbe ? caseProbe.enabled : null,
  caseSensitiveRaw: caseProbe ? caseProbe.raw : null,
}

/* ── 5. advice derived from the facts ──────────────────────────────────── */

const advice = []
if (!IS_WINDOWS) {
  advice.push('not running on Windows: only the platform-independent parts of this playbook apply.')
} else {
  if (powerShell.toolShellIsCore === false) {
    advice.push("the pwsh tool runs Windows PowerShell 5.1 (Desktop): no `&&`/`||`/`??`/ternary, `-Encoding utf8` writes a BOM, `>`/`Out-File` writes UTF-16LE, `curl`/`wget` are aliases. Use ';' plus `if ($LASTEXITCODE -eq 0) {...}`, and write files with the file tools or Node.")
  } else if (powerShell.toolShellIsCore === true) {
    advice.push('the pwsh tool runs PowerShell 7 (Core): `&&`/`||`/ternary work and `-Encoding utf8` writes no BOM. A bare `pwsh` inside a command may still resolve to a different build - check `$PSVersionTable.PSEdition` if a construct fails to parse.')
  }
  if (powerShell.longPathsEnabled === false) advice.push('long-path support (LongPathsEnabled) is OFF: keep paths well under 260 characters; deep node_modules trees fail with ENAMETOOLONG. `git config --global core.longpaths true` covers git itself.')
  if (powerShell.developerMode !== true) advice.push('Developer Mode is not enabled: creating symlinks/junctions needs elevation, so avoid `mklink`/`New-Item -ItemType SymbolicLink` and prefer copies or real directories.')
  if (powerShell.isAdmin === false) advice.push('this session is NOT elevated: no service installs, no machine-wide PATH/registry writes, no ACL surgery. Prefer per-user installs (`npm i -g --prefix`, winget --scope user, portable archives).')
  if (powerShell.userInteractive === false) advice.push('PowerShell reports a non-interactive session: UAC / firewall / SmartScreen dialogs cannot be answered, and any command that prompts will hang until the timeout. Use `--yes`/`-y`/`-Force`/`-Confirm:$false` and set GIT_TERMINAL_PROMPT=0.')
  if (powerShell.executionPolicy && !/Unrestricted|Bypass/i.test(powerShell.executionPolicy)) advice.push(`ExecutionPolicy is ${powerShell.executionPolicy}: running .ps1 scripts (including npm.ps1/npx.ps1 shims) may be blocked. Prefer the .cmd/.exe shim, or run with -ExecutionPolicy Bypass for one process.`)
  if (bash && bash.dialect === 'wsl') advice.push(`bash resolves to WSL (${tools.bash}): it sees C:\\x as /mnt/c/x and does not share the Windows PATH the same way. Never mix path dialects in one command.`)
  else if (bash && bash.dialect === 'git-bash') advice.push(`bash resolves to Git Bash (${tools.bash}): it sees C:\\x as /c/x and brings its own Unix tools, which are not the Windows ones. Path and line-ending mangling is common across the boundary.`)
  if (host.cwdSpaced || host.cwdAscii === false) advice.push('the workspace path contains spaces or non-ASCII characters: always quote it, and expect extra trouble from npm/node-gyp and from unquoted cmd.exe redirections.')
  if (host.cwdInsideOneDrive) advice.push('the workspace is inside OneDrive: sync/lock contention produces EPERM/EBUSY and Files-On-Demand placeholders can make files appear empty. Prefer a local, non-synced directory for builds.')
  if (workspaceDrive && workspaceDrive.kind === 'network') advice.push('the workspace is on a network drive: locking semantics differ, rename can fail, and file watching is unreliable. Do heavy work (npm install, tests) on a local drive.')
  if (workspaceDrive && workspaceDrive.kind === 'removable') advice.push('the workspace is on removable media: weak locking, no symlinks/hardlinks on FAT/exFAT, slow random I/O.')
  if (host.tempDrive && host.cwdDrive && host.tempDrive !== host.cwdDrive) advice.push(`TEMP (${host.temp}) is on a different drive than the workspace: a cross-drive rename is not atomic and fails with EXDEV, so stage temp files inside the workspace when you intend to rename them.`)
  if (host.pathDuplicateEntries.length > 0) advice.push(`PATH contains duplicate entries (${host.pathDuplicateEntries.slice(0, 4).join(', ')}): resolution order can pick an unexpected tool.`)
  if (host.pathQuotedEntries > 0) advice.push('PATH contains quoted entries: some tools mis-parse them; entries with spaces should be unquoted.')
  if (host.pathNonAsciiEntries > 0) advice.push('PATH contains non-ASCII entries: old toolchains (node-gyp, some CMake generators) can fail on them.')
  const autocrlf = git.core.autocrlf
  if (autocrlf && !/false/i.test(autocrlf)) advice.push(`git core.autocrlf=${autocrlf}: checkout writes CRLF, and a shell script checked out that way breaks under bash ("bad interpreter: /bin/bash^M"). Prefer \`git config --global core.autocrlf input\` plus a .gitattributes with \`* text=auto eol=lf\`.`)
  if (!git.core.longpaths) advice.push('git core.longpaths is not set: checkouts with long paths fail. `git config --global core.longpaths true`.')
  if (!git.core.quotepath || !/false/i.test(git.core.quotepath)) advice.push('git core.quotepath is not disabled: non-ASCII file names print as \\346\\226\\207 escapes. `git config --global core.quotepath false`.')
  if (git.httpSslBackend === 'openssl' || (host.httpsProxy && git.httpSslBackend !== 'schannel')) advice.push('behind a corporate proxy / TLS-inspecting middlebox: set `git config --global http.sslBackend schannel` so git uses the Windows certificate store, and point npm at the internal registry/CA (cafile or NODE_EXTRA_CA_CERTS).')
  if (!git.userName || !git.userEmail) advice.push('git user.name/user.email are not both set: commits fail or are attributed wrongly. Set them before committing.')
  if (npm.registry && !/registry\.npmjs\.org/i.test(npm.registry)) advice.push(`npm registry is redirected (${npm.registry}): the public registry may be unreachable, so confirm a package exists there (\`npm view <pkg> version\`) before installing.`)
  if (npm.strictSsl === false) advice.push('npm strict-ssl is false: TLS verification is disabled - acceptable for a lab mirror, but know that it is on.')
  if (npm.error) advice.push(`npm config could not be read as JSON (${npm.error}); individual \`npm config get <key>\` calls still work.`)
  if (powerShell.defenderCfa && String(powerShell.defenderCfa) !== '0') advice.push('Defender Controlled Folder Access is ON: writes into Documents/Desktop/Pictures can be blocked with "Unauthorized change blocked" even for your own process. Keep build output outside protected folders.')
  if (powerShell.defenderRealtime === true) advice.push('Defender real-time protection is ON: installs and test runs are slowed by scanning, and freshly written files can be briefly locked (EPERM/EBUSY). Retry rename/unlink with a small backoff.')
  if (powerShell.excludedTcpPorts !== null && powerShell.excludedTcpPorts.length > 0) advice.push('Windows has reserved TCP port ranges (Hyper-V/WSL/NAT): if a server fails to bind with EACCES, pick a port outside these ranges.')
  if (host.sshConnection) advice.push('this shell came in over SSH: no interactive desktop, so GUI prompts are invisible; HOME may also be unset, which sends git/ssh to the wrong config location (set HOME=%USERPROFILE%).')
}

/* ── 6. report ─────────────────────────────────────────────────────────── */

const facts = {
  host,
  powershell: powerShell,
  workspaceDrive,
  tempDrive: tempDriveInfo,
  drives,
  bash,
  pathTranslation,
  tools,
  versions,
  git,
  npm,
  filesystem,
  advice,
}

if (options.out) {
  try {
    writeFileSync(options.out, `${JSON.stringify(facts, null, 2)}\n`, 'utf8')
  } catch (error) {
    process.stderr.write(`probe: could not write ${options.out}: ${error && error.message ? error.message : error}\n`)
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`)
  process.exit(0)
}

const lines = []
const put = (label, value) => lines.push(`${String(label).padEnd(22)} ${value === null || value === undefined || value === '' ? '(unknown/none)' : value}`)
lines.push('=== Windows environment probe ===')
put('os', `${host.osRelease} ${host.arch}${host.wow64 ? ` (process ${host.processorArchitecture}, OS ${host.wow64})` : ''}`)
put('node', `${host.node} at ${host.nodePath}`)
put('user', `${host.user} (profile ${host.userProfile}${host.userPathAscii ? '' : ', NON-ASCII'})`)
put('cwd', `${host.cwd} (${host.cwdLength} chars${host.cwdSpaced ? ', HAS SPACES' : ''}${host.cwdAscii ? '' : ', NON-ASCII'}${host.cwdIsUnc ? ', UNC' : ''})`)
if (workspaceDrive) put('workspace drive', `${workspaceDrive.letter} ${workspaceDrive.kind} ${workspaceDrive.fileSystem} free ${workspaceDrive.freeGB}GB${host.cwdInsideOneDrive ? ' (INSIDE ONEDRIVE)' : ''}`)
put('temp', `${host.temp}${host.tempDrive ? ` (drive ${host.tempDrive}${tempDriveInfo ? `, ${tempDriveInfo.kind} ${tempDriveInfo.fileSystem}` : ''})` : ''}`)
put('session', `SESSIONNAME=${host.sessionName || '(none)'} interactive=${powerShell.userInteractive} admin=${powerShell.isAdmin} ssh=${host.sshConnection}`)
put('pwsh tool uses', powerShell.toolShellPath || '(not resolved)')
put('powershell', `${powerShell.toolShellVersion || '?'} / ${powerShell.toolShellEdition || '?'}; PS7 installed=${powerShell.pwsh7Installed}`)
put('output code page', powerShell.outputCodePage)
put('execution policy', powerShell.executionPolicy)
put('longPathsEnabled', powerShell.longPathsEnabled)
put('developerMode', powerShell.developerMode)
put('bash', bash ? `${bash.path} [${bash.dialect}] -> ${pathTranslation}` : '(absent)')
put('tools present', Object.keys(tools).join(' '))
put('versions', Object.entries(versions).map(([name, value]) => `${name}: ${value}`).join(' | '))
const unset = (value) => (value === null || value === undefined || value === '' ? '(unset)' : value)
put('git core', `autocrlf=${unset(git.core.autocrlf)} longpaths=${unset(git.core.longpaths)} quotepath=${unset(git.core.quotepath)} symlinks=${unset(git.core.symlinks)}`)
put('git other', `sslBackend=${unset(git.httpSslBackend)} credential.helper=${unset(git.credentialHelper)} user=${unset(git.userName)}/${unset(git.userEmail)} insideWorkTree=${git.insideWorkTree} safe.directory=${git.safeDirectoryCount}`)
put('npm', `registry=${npm.registry} prefix=${npm.prefix} strict-ssl=${npm.strictSsl} proxy=${npm.proxy || npm.httpsProxy}`)
put('npm native build', `msvs_version=${npm.msvsVersion} python=${npm.python}`)
put('defender', `realtime=${powerShell.defenderRealtime} controlledFolderAccess=${powerShell.defenderCfa} exclusions=${powerShell.defenderExclusions || '(none)'}`)
put('reserved tcp ports', powerShell.excludedTcpPorts === null ? '(not probed)' : powerShell.excludedTcpPorts.length === 0 ? '(none)' : powerShell.excludedTcpPorts.slice(0, 300))
put('case-sensitive cwd', `${filesystem.caseSensitiveCwd}${filesystem.caseSensitiveRaw ? ` (${filesystem.caseSensitiveRaw})` : ''}`)
if (options.out) put('json written to', options.out)
lines.push('')
lines.push('--- advice (derived from the facts above) ---')
for (const item of advice) lines.push(`* ${item}`)
lines.push('')
lines.push('(machine-readable: re-run with --json; skip the slow antivirus/port probes with --fast)')

process.stdout.write(`${lines.join('\n')}\n`)
