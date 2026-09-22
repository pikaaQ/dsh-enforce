/**
 * run-native.mjs - shared helpers for running native Windows commands from Node.
 *
 * Why this file exists: on Windows the fragile part of "run a command and read
 * its result" is the SHELL STRING (nested quoting, `$LASTEXITCODE`, pipeline
 * truncation, code-page decoding). Here the argv array goes straight to
 * CreateProcess: no shell quoting, the exit code is the child's real status,
 * and captured bytes are decoded exactly once as UTF-8.
 *
 * Only `.cmd`/`.bat` targets need cmd.exe (Node refuses to spawn them without
 * `shell`), so those go through `shell: true`; everything else is shell-free.
 *
 * No dependencies. Plain ESM. Node >= 18.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'
const COMSPEC = process.env.ComSpec || 'cmd.exe'
const PATHEXT = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)

/**
 * Environment that makes native tools behave for an automated caller: UTF-8
 * output, no color, no interactive credential prompts, stable English
 * messages. Real `process.env` values win, so any of these can be overridden.
 */
export const ENV_DEFAULTS = {
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  NO_COLOR: '1',
  npm_config_color: 'false',
  LC_ALL: 'C.UTF-8',
  LANG: 'C.UTF-8',
}

/**
 * Candidate file names for a command, honoring PATHEXT. The extensionless name
 * comes LAST (and is skipped entirely for PATH lookups on Windows): npm/git
 * also ship an extensionless POSIX shell script next to their .cmd/.exe, and
 * CreateProcess cannot run that file - picking it up is exactly the
 * `spawn npm ENOENT` trap.
 */
function candidates(file, includeBare = true) {
  if (extname(file) !== '') return [file]
  const out = []
  for (const ext of PATHEXT) out.push(file + ext.toLowerCase())
  if (includeBare) out.push(file)
  return out
}

/** Resolve a command exactly like cmd.exe would: explicit path, else PATH scan. */
export function resolveCommand(command, cwd = process.cwd()) {
  if (typeof command !== 'string' || command.length === 0) return null
  const looksLikePath = isAbsolute(command) || command.includes('/') || command.includes('\\')
  if (looksLikePath) {
    for (const candidate of candidates(resolve(cwd, command))) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  const dirs = (process.env.PATH || '')
    .split(delimiter)
    .map((dir) => dir.replace(/^"|"$/g, '').trim())
    .filter((dir) => dir.length > 0)
  for (const dir of dirs) {
    for (const candidate of candidates(join(dir, command), !IS_WINDOWS)) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * A `.ps1`-only name (pnpm/yarn/corepack install one) cannot be spawned at all:
 * Node refuses script shims. Report it so the caller runs it from the shell.
 */
function powershellShimHint(command) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\\') || command.includes('/')) return null
  const dirs = (process.env.PATH || '').split(delimiter).map((dir) => dir.replace(/^"|"$/g, '').trim()).filter((dir) => dir.length > 0)
  for (const dir of dirs) {
    const candidate = join(dir, `${command}.ps1`)
    if (existsSync(candidate)) return `${command} is a PowerShell script shim (${candidate}), which Node cannot spawn; run it in the pwsh tool instead.`
  }
  return null
}

export function isShimFile(file) {
  if (typeof file !== 'string') return false
  const ext = extname(file).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

function needsShell(command, resolved) {
  return isShimFile(command) || isShimFile(resolved)
}

const CMD_META = /[&|<>^%!()"'\r\n]/

/** A structured refusal, shaped like a spawn result so callers need no branch. */
function errorResult(command, args, resolved, useShell, message, extra = {}) {
  return {
    command, args, resolved, useShell,
    code: null, signal: null, error: message,
    hint: resolved ? null : powershellShimHint(command),
    stdout: '', stderr: '',
    ...extra,
  }
}

function buildEnv(extra) {
  return { ...ENV_DEFAULTS, ...process.env, ...(extra || {}) }
}

function shape(command, args, resolved, useShell, result) {
  const stdoutBuffer = Buffer.isBuffer(result.stdout) ? result.stdout : null
  const stderrBuffer = Buffer.isBuffer(result.stderr) ? result.stderr : null
  return {
    command,
    args,
    resolved,
    useShell,
    code: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : null,
    hint: result.error && !resolved ? powershellShimHint(command) : null,
    stdout: stdoutBuffer ? stdoutBuffer.toString('utf8') : result.stdout == null ? '' : String(result.stdout),
    stderr: stderrBuffer ? stderrBuffer.toString('utf8') : result.stderr == null ? '' : String(result.stderr),
    stdoutBuffer,
    stderrBuffer,
  }
}

/**
 * `shell: true` joins the argv with spaces, so an argument containing
 * whitespace or cmd metacharacters would be re-split by cmd.exe. Refuse loudly
 * instead of running something subtly different.
 */
export function shellJoinProblem(command, args) {
  const bad = [command, ...args].find((arg) => CMD_META.test(arg) || /\s/.test(arg))
  if (bad === undefined) return null
  return `${JSON.stringify(bad)} cannot be passed through a .cmd/.bat shim: cmd.exe would re-split it. Run this particular command in the pwsh tool (PowerShell invokes .cmd shims natively and quotes correctly), or make it a real executable.`
}

/** Run to completion, synchronously. Returns a plain result object. */
export function runSync(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd()
  const resolved = resolveCommand(command, cwd)
  const useShell = options.shell === true || (options.shell !== false && needsShell(command, resolved))
  if (useShell) {
    const problem = shellJoinProblem(resolved || command, args)
    if (problem) return errorResult(command, args, resolved, useShell, problem)
  }
  const spawnOptions = {
    cwd,
    env: buildEnv(options.env),
    windowsHide: true,
    encoding: options.encoding === 'buffer' ? 'buffer' : 'utf8',
    maxBuffer: options.maxBuffer || 128 * 1024 * 1024,
    shell: useShell,
    input: options.input,
  }
  if (options.timeoutMs && options.timeoutMs > 0) spawnOptions.timeout = options.timeoutMs
  const result = spawnSync(resolved || command, args, spawnOptions)
  return shape(command, args, resolved, useShell, result)
}

/**
 * Run to completion, asynchronously, with a real timeout and process-TREE kill
 * (on Windows a plain kill leaves grandchildren holding files and ports).
 */
export function runAsync(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd()
  const resolved = resolveCommand(command, cwd)
  const useShell = options.shell === true || (options.shell !== false && needsShell(command, resolved))
  const startedAt = Date.now()
  if (useShell) {
    const problem = shellJoinProblem(resolved || command, args)
    if (problem) {
      return Promise.resolve(errorResult(command, args, resolved, useShell, problem, { killedByTimeout: false, ms: Date.now() - startedAt }))
    }
  }
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(resolved || command, args, {
        cwd,
        env: buildEnv(options.env),
        windowsHide: true,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({
        command, args, resolved, useShell,
        code: null, signal: null, error: String(error && error.message ? error.message : error),
        stdout: '', stderr: '', killedByTimeout: false, ms: Date.now() - startedAt,
      })
      return
    }

    const wantBuffer = options.encoding === 'buffer'
    let stdout = ''
    let stderr = ''
    const stdoutChunks = []
    const stderrChunks = []
    let settled = false
    let killedByTimeout = false
    if (wantBuffer) {
      child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk) })
      child.stderr.on('data', (chunk) => { stderrChunks.push(chunk) })
    } else {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }

    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          killedByTimeout = true
          killTree(child.pid)
        }, options.timeoutMs)
      : null

    const finish = (code, signal, error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const stdoutBuffer = wantBuffer ? Buffer.concat(stdoutChunks) : null
      const stderrBuffer = wantBuffer ? Buffer.concat(stderrChunks) : null
      resolvePromise({
        command, args, resolved, useShell,
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        error: error ? String(error.message || error) : null,
        stdout: stdoutBuffer ? stdoutBuffer.toString('utf8') : stdout,
        stderr: stderrBuffer ? stderrBuffer.toString('utf8') : stderr,
        stdoutBuffer,
        stderrBuffer,
        killedByTimeout, ms: Date.now() - startedAt,
      })
    }

    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal, null))
  })
}

/** Kill a whole process tree: `taskkill /T` is the only reliable Windows way. */
export function killTree(pid) {
  if (!pid) return
  if (IS_WINDOWS) {
    try {
      spawnSync(COMSPEC, ['/d', '/s', '/c', `taskkill /PID ${pid} /T /F`], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20000,
      })
    } catch {
      /* best effort */
    }
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* best effort */
  }
}

/**
 * The PowerShell the harness's `pwsh` tool will use, in the harness's own
 * resolution order: PowerShell 7 in Program Files, then PATH, then the
 * always-installed Windows PowerShell 5.1.
 */
export function resolveHarnessPwsh(env = process.env) {
  const candidates = []
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files'
  candidates.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  const pathDirs = (env.PATH || '').split(delimiter).map((dir) => dir.replace(/^"|"$/g, '').trim())
  for (const dir of pathDirs) if (dir) candidates.push(join(dir, 'pwsh.exe'))
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/**
 * Run one PowerShell snippet and return its raw output. The snippet must be
 * pure ASCII and avoid double quotes: it travels as a single argv element.
 */
export function runPwsh(script, options = {}) {
  const exe = options.exe || resolveHarnessPwsh() || 'powershell.exe'
  return runSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || 30000,
  })
}

/** Parse `key=value` lines (first `=` splits) into an object. */
export function parseKeyValueLines(text) {
  const out = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    out[line.slice(0, index)] = line.slice(index + 1)
  }
  return out
}

/**
 * Windows ANSI/OEM code pages mapped to WHATWG decoder labels. This matters
 * because a native tool writing to a PIPE often emits the ANSI/OEM code page
 * even when the console is UTF-8 (fsutil, older tools, Python without
 * PYTHONUTF8): decoding those bytes as UTF-8 yields mojibake. Pass
 * `{ encoding: 'buffer' }` to get the raw bytes and decode them here.
 */
const CODE_PAGE_LABELS = {
  437: 'ibm866', 720: null, 850: null, 852: null, 866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
  1258: 'windows-1258', 65001: 'utf-8',
}

export function codePageLabel(codePage) {
  const key = Number(codePage)
  return Object.prototype.hasOwnProperty.call(CODE_PAGE_LABELS, key) ? CODE_PAGE_LABELS[key] : null
}

/** Decode bytes with a WHATWG label; returns null when the label is unusable. */
export function decodeWithLabel(buffer, label) {
  if (!buffer || !label) return null
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    return null
  }
}

/**
 * Decode captured bytes the way the emitting tool most likely meant them:
 * UTF-8 first, and only when that produced replacement characters fall back to
 * the given ANSI code page.
 */
export function decodeBytes(buffer, ansiCodePage) {
  if (!buffer) return ''
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  const fallback = decodeWithLabel(buffer, codePageLabel(ansiCodePage))
  return fallback === null ? utf8 : fallback
}
