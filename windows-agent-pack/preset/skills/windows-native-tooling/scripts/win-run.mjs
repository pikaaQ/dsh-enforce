#!/usr/bin/env node
/**
 * win-run.mjs - run one native command with an argv array (no shell string).
 *
 *   node win-run.mjs [options] -- <command> [args...]
 *
 * Options
 *   --cwd <dir>        working directory (default: current directory)
 *   --timeout <ms>     wall-clock limit; on expiry the whole process TREE is
 *                      killed with `taskkill /T /F` (default 600000, 0 = none)
 *   --env K=V          add/override an environment variable (repeatable)
 *   --out <file>       write the full untruncated output to this file (UTF-8, no BOM)
 *   --max <chars>      truncate what is PRINTED to this many chars (default 120000)
 *   --shell            force cmd.exe (`--shell` implies the argument list is
 *                      joined into one command string; prefer the default)
 *   --json             print one JSON result object instead of a report
 *   --print-cmd        only show what would run (resolution result), run nothing
 *
 * Why: quoting, `$LASTEXITCODE`, pipeline truncation and code-page decoding are
 * the four ways a Windows command "fails" while the command itself is fine.
 * This wrapper removes all four, and turns a hang into a killed tree plus a
 * reported timeout instead of a stuck tool call.
 */

import { writeFileSync } from 'node:fs'
import { runAsync, resolveCommand } from './run-native.mjs'

const DEFAULT_TIMEOUT_MS = 600000
const DEFAULT_MAX_CHARS = 120000

function parseArgs(argv) {
  const options = { env: {}, timeoutMs: DEFAULT_TIMEOUT_MS, maxChars: DEFAULT_MAX_CHARS }
  const rest = []
  let i = 0
  let afterSeparator = false
  while (i < argv.length) {
    const token = argv[i]
    if (afterSeparator) {
      rest.push(token)
      i += 1
      continue
    }
    if (token === '--') {
      afterSeparator = true
      i += 1
      continue
    }
    const take = () => {
      i += 1
      if (i >= argv.length) throw new Error(`missing value for ${token}`)
      return argv[i]
    }
    if (token === '--cwd') options.cwd = take()
    else if (token === '--timeout') options.timeoutMs = Number(take())
    else if (token === '--max') options.maxChars = Number(take())
    else if (token === '--out') options.out = take()
    else if (token === '--env') {
      const pair = take()
      const index = pair.indexOf('=')
      if (index <= 0) throw new Error(`--env expects K=V, got ${pair}`)
      options.env[pair.slice(0, index)] = pair.slice(index + 1)
    } else if (token === '--shell') options.shell = true
    else if (token === '--json') options.json = true
    else if (token === '--print-cmd') options.printCmd = true
    else if (token === '--help' || token === '-h') options.help = true
    else if (token.startsWith('--')) throw new Error(`unknown option ${token}`)
    else rest.push(token)
    i += 1
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('--timeout must be a number >= 0')
  if (!Number.isFinite(options.maxChars) || options.maxChars <= 0) throw new Error('--max must be a positive number')
  return { options, rest }
}

function usage() {
  return [
    'usage: node win-run.mjs [options] -- <command> [args...]',
    '',
    '  --cwd <dir>     working directory',
    '  --timeout <ms>  wall-clock limit, kills the process tree (default 600000, 0 = none)',
    '  --env K=V       add/override an environment variable (repeatable)',
    '  --out <file>    write full untruncated output to a UTF-8 file',
    '  --max <chars>   truncate printed output (default 120000)',
    '  --shell         run through cmd.exe (escape hatch for shell syntax)',
    '  --json          print a JSON result object',
    '  --print-cmd     show the resolution result and exit',
  ].join('\n')
}

function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false }
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return {
    text: `${text.slice(0, head)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-tail)}`,
    truncated: true,
  }
}

const { options, rest } = parseArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}
if (rest.length === 0) {
  process.stderr.write(`win-run: no command given\n${usage()}\n`)
  process.exit(2)
}

const [command, ...args] = rest
const cwd = options.cwd || process.cwd()

if (options.printCmd) {
  process.stdout.write(`${JSON.stringify({ command, args, cwd, resolved: resolveCommand(command, cwd), shell: options.shell === true }, null, 2)}\n`)
  process.exit(0)
}

const result = await runAsync(command, args, {
  cwd,
  env: options.env,
  timeoutMs: options.timeoutMs,
  shell: options.shell,
})

if (options.out) {
  const header = `# ${result.resolved || command} ${args.join(' ')}\n# cwd: ${cwd}\n# exit: ${result.code}\n\n`
  try {
    writeFileSync(options.out, `${header}${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`, 'utf8')
    result.outFile = options.out
  } catch (error) {
    result.outError = String(error && error.message ? error.message : error)
  }
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.killedByTimeout ? 124 : (typeof result.code === 'number' ? result.code : 127))
}

const lines = []
lines.push(`$ ${result.resolved || command} ${args.join(' ')}`)
if (!result.resolved && !result.useShell) {
  lines.push(`[not found: ${command}] not on PATH (and not a path that exists); use --print-cmd to inspect resolution, or pass the full path to the executable`)
}
const stdout = truncate(result.stdout, options.maxChars)
if (stdout.text.length > 0) lines.push(stdout.text.replace(/\s+$/, ''))
if (result.error) lines.push(`[error] ${result.error}`)
if (result.hint) lines.push(`[hint] ${result.hint}`)
if (result.stderr.trim().length > 0) {
  const stderr = truncate(result.stderr, options.maxChars)
  lines.push(`[stderr]\n${stderr.text.replace(/\s+$/, '')}`)
}
if (stdout.truncated) lines.push(`[output truncated for display; full output: ${options.out || 'pass --out <file> to save it'}]`)
if (result.outFile) lines.push(`[full output written to ${result.outFile}]`)
if (result.outError) lines.push(`[could not write --out file] ${result.outError}`)
if (result.killedByTimeout) lines.push(`[timeout] killed the process tree after ${options.timeoutMs}ms`)
if (result.signal) lines.push(`[killed by signal: ${result.signal}]`)
lines.push(`[exit code: ${result.code === null ? 'none' : result.code}] (${result.ms}ms)`)

process.stdout.write(`${lines.join('\n')}\n`)
process.exit(result.killedByTimeout ? 124 : (typeof result.code === 'number' ? result.code : 127))
