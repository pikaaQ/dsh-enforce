<#
.SYNOPSIS
  Install windows-agent-pack onto one DeepSeek Harness (DSH) instance (Windows).

.DESCRIPTION
  Installs the Windows-optimised coding agent, using official mechanisms only
  (no custom plugin code):

    1. $DSH_HOME\.agent-presets\windows\ - an agent preset whose composition is
       the shipped 'standard' preset plus exactly two functional changes:
         a. the persona prefix carries the Windows execution doctrine
            (shell semantics, 5.1-vs-7, encodings, exit codes, file locks,
            interactive prompts), and
         b. skill-filesystem gets customSkillDirs pointing at the preset's own
            skills\ directory, which ships 'windows-native-tooling'
            (the generalised Windows playbook) with win-env-probe / win-run.
       The global agent instructions ($DSH_HOME\AGENTS.md) are NOT touched.

    2. optional (-GlobalSkill): also copy the playbook to
       $DSH_HOME\skills\windows-native-tooling\ so EVERY preset can load it
       on demand, not just this one.

    3. optional (-SetDefault): write agent-presets.default = windows into
       $DSH_HOME\settings.yaml so new sessions start on this preset.

  Compatibility baseline: @deepseek-ai/dsh 0.1.5-rc.2 - the persona row uses
  the new `prefix`/`suffix` shape and the skill row uses `customSkillDirs`.
  On an older install (0.1.4 and below) the persona row was a single `text:`
  key and this preset will NOT mount; upgrade dsh first.

  Everything replaced is backed up next to the original before the write.

.PARAMETER DSHHome
  DSH home directory (default: $env:DSH_HOME, else $HOME\.dsh).

.PARAMETER Force
  Overwrite an existing 'windows' preset / global skill copy instead of
  failing. The previous version is kept as <name>.bak-<timestamp>.

.PARAMETER SetDefault
  Also set agent-presets.default = windows in settings.yaml (backed up first).
  Without it the current default is only reported.

.PARAMETER GlobalSkill
  Also install the playbook into $DSH_HOME\skills\windows-native-tooling so
  every preset can load it (same content as the preset-local copy).

.PARAMETER SkipProbe
  Do not run the environment probe after installing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Force -GlobalSkill
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DSHHome D:\.dsh -SetDefault
#>
[CmdletBinding()]
param(
    [string]$DSHHome = '',
    [switch]$Force,
    [switch]$SetDefault,
    [switch]$GlobalSkill,
    [switch]$SkipProbe
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# Windows PowerShell 5.1 reads files with the system ANSI codepage (gb2312 on
# zh-CN) unless told otherwise, which corrupts these UTF-8 sources into mojibake.
# Read/write every text file explicitly as UTF-8, without a BOM.
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Utf8([string]$Path) { [System.IO.File]::ReadAllText($Path, $utf8) }
function Write-Utf8([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $utf8) }
function Write-Bytes([string]$Path, [byte[]]$Bytes) { [System.IO.File]::WriteAllBytes($Path, $Bytes) }

if (-not $DSHHome) { $DSHHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }
if (-not (Test-Path -LiteralPath $DSHHome)) { throw "DSH home not found: $DSHHome (pass -DSHHome, or set DSH_HOME / use the default ~\.dsh)" }
$DSHHome = (Resolve-Path -LiteralPath $DSHHome).Path

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packPreset = Join-Path $here 'preset'
$skillName = 'windows-native-tooling'

Write-Host ''
Write-Host "windows-agent-pack -> $DSHHome" -ForegroundColor Cyan
Write-Host ''

# -- [1/6] check the pack itself ----------------------------------------------
Write-Host '[1/6] checking pack contents' -ForegroundColor Cyan
foreach ($rel in @('preset\agent.cordis.yml', 'preset\preset.yml', "preset\skills\$skillName\SKILL.md")) {
    $p = Join-Path $here $rel
    if (-not (Test-Path -LiteralPath $p)) { throw "pack is incomplete, missing: $rel" }
}
$compText = Read-Utf8 (Join-Path $packPreset 'agent.cordis.yml')
if ($compText -notmatch '(?m)^\s+prefix:') {
    throw "pack preset does not use the 'prefix' persona shape - it targets an older dsh and would not mount."
}
if ($compText -notmatch 'customSkillDirs') {
    throw "pack preset has no customSkillDirs - the bundled playbook would never be discovered."
}
if ($compText -match '(?m)^\s+text:\s*>-') {
    throw "pack preset still carries the legacy persona 'text:' key; refusing to install a composition 0.1.5 rejects."
}
$rowCount = ([regex]::Matches($compText, '(?m)^- id: ')).Count
Write-Host "  pack preset OK: $rowCount rows, persona prefix + customSkillDirs present" -ForegroundColor DarkGray

# -- [2/6] install the preset -------------------------------------------------
Write-Host '[2/6] installing agent preset ''windows''' -ForegroundColor Cyan
$presetDir = Join-Path $DSHHome ".agent-presets\windows"
if (Test-Path -LiteralPath $presetDir) {
    if (-not $Force) {
        throw "preset already exists: $presetDir  (re-run with -Force to replace it; the old copy is kept as windows.bak-<timestamp>)"
    }
    # Back up by COPY, never by renaming the directory: a running dsh watches the
    # preset composition, and on Windows a watched directory cannot be renamed
    # ("Access to the path ... is denied"). Overwriting the files in place is
    # allowed, because Node opens them with FILE_SHARE_* so a read handle does
    # not block a write.
    $backup = "$presetDir.bak-$stamp"
    Copy-Item -LiteralPath $presetDir -Destination $backup -Recurse -Force
    Write-Host "  backed up existing preset (copy) -> $backup" -ForegroundColor Yellow
}
New-Item -ItemType Directory -Path $presetDir -Force | Out-Null
Copy-Item (Join-Path $packPreset '*') $presetDir -Recurse -Force
Write-Host "  installed: $presetDir" -ForegroundColor Green

# -- [3/6] optional global skill copy -----------------------------------------
if ($GlobalSkill) {
    Write-Host '[3/6] installing the playbook into the user skill root' -ForegroundColor Cyan
    $userSkills = Join-Path $DSHHome 'skills'
    $dstSkill = Join-Path $userSkills $skillName
    if (Test-Path -LiteralPath $dstSkill) {
        if (-not $Force) {
            Write-Host "  $dstSkill exists - skipped (re-run with -Force to refresh it)" -ForegroundColor Yellow
            $dstSkill = $null
        } else {
            $backup = "$dstSkill.bak-$stamp"
            Copy-Item -LiteralPath $dstSkill -Destination $backup -Recurse -Force
            Write-Host "  backed up existing skill (copy) -> $backup" -ForegroundColor Yellow
        }
    }
    if ($dstSkill) {
        New-Item -ItemType Directory -Path $userSkills -Force | Out-Null
        Copy-Item (Join-Path $packPreset "skills\$skillName") $dstSkill -Recurse -Force
        Write-Host "  installed: $dstSkill (visible to every preset)" -ForegroundColor Green
    }
} else {
    Write-Host '[3/6] global skill copy not requested (-GlobalSkill to add it)' -ForegroundColor DarkGray
}

# -- [4/6] optional default preset --------------------------------------------
$settings = Join-Path $DSHHome 'settings.yaml'
$currentDefault = ''
if (Test-Path -LiteralPath $settings) {
    $raw = Read-Utf8 $settings
    $m = [regex]::Match($raw, '(?m)^agent-presets:\r?\n(?:\s+.*\r?\n)*?\s+default:\s*(\S+)\s*$')
    if ($m.Success) { $currentDefault = $m.Groups[1].Value }
}
if ($SetDefault) {
    Write-Host '[4/6] setting agent-presets.default = windows' -ForegroundColor Cyan
    if (-not (Test-Path -LiteralPath $settings)) {
        Write-Utf8 $settings "agent-presets:`n  default: windows`n"
        Write-Host '  settings.yaml did not exist - created with the default' -ForegroundColor Yellow
    } else {
        $raw = Read-Utf8 $settings
        $new = [regex]::Replace($raw, '(?m)^(agent-presets:\r?\n)(?:\s+default:.*\r?\n)?', "`$1  default: windows`n")
        if ($new -eq $raw) { $new = $raw.TrimEnd("`r", "`n") + "`nagent-presets:`n  default: windows`n" }
        Copy-Item -LiteralPath $settings -Destination "$settings.bak-install" -Force
        Write-Utf8 $settings $new
        Write-Host "  settings.yaml updated (backup: $settings.bak-install)" -ForegroundColor Green
    }
} else {
    Write-Host '[4/6] default preset left untouched' -ForegroundColor DarkGray
    if ($currentDefault) { Write-Host "  current agent-presets.default = $currentDefault" -ForegroundColor DarkGray }
    else { Write-Host '  settings.yaml has no agent-presets.default' -ForegroundColor DarkGray }
}

# -- [5/6] verify what was written --------------------------------------------
Write-Host '[5/6] verifying installed files against the pack' -ForegroundColor Cyan
$mismatch = 0
Get-ChildItem -LiteralPath $packPreset -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($packPreset.Length + 1)
    $installed = Join-Path $presetDir $rel
    if (-not (Test-Path -LiteralPath $installed)) { Write-Host "  MISSING $rel" -ForegroundColor Red; $script:mismatch++ ; return }
    $a = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    $b = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
    if ($a -ne $b) { Write-Host "  DIFFERS $rel" -ForegroundColor Red; $script:mismatch++ }
}
if ($mismatch -eq 0) { Write-Host '  all files identical to the pack' -ForegroundColor Green }

# -- [6/6] environment probe (the point of the preset) ------------------------
if (-not $SkipProbe) {
    Write-Host '[6/6] probing this machine (win-env-probe.mjs --fast)' -ForegroundColor Cyan
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($node) {
        $probe = Join-Path $presetDir "skills\$skillName\scripts\win-env-probe.mjs"
        $out = Join-Path $DSHHome 'win-env.json'
        & $node.Source $probe --fast --json --out $out
        if ($LASTEXITCODE -ne 0) { Write-Host "  probe exited $LASTEXITCODE (install itself is fine)" -ForegroundColor Yellow }
        else { Write-Host "  environment facts written to: $out" -ForegroundColor Green }
    } else {
        Write-Host '  node not found on PATH - skipped; run the probe from a session instead' -ForegroundColor Yellow
    }
} else {
    Write-Host '[6/6] probe skipped (-SkipProbe)' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'Installed. Next steps:' -ForegroundColor Green
Write-Host '  1. Start a NEW session and pick the preset at the "windows" slot (.agent-presets\windows).' -ForegroundColor Gray
Write-Host '     Compositions are read per new session, so no dsh restart is needed.' -ForegroundColor Gray
Write-Host '  2. First action in that session: run the probe once and keep the JSON in the workspace.' -ForegroundColor Gray
Write-Host '  3. The playbook loads on demand: ask the agent to load windows-native-tooling.' -ForegroundColor Gray
if (-not $GlobalSkill) {
    Write-Host '  Note: only sessions on this preset see the playbook; -GlobalSkill adds it for all presets.' -ForegroundColor DarkGray
}
Write-Host ''
Write-Host 'Uninstall with: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1'
