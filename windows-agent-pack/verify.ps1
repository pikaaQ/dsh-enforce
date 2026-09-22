<#
.SYNOPSIS
  Check an installed windows-agent-pack (and optionally re-probe the machine).

.DESCRIPTION
  Read-only. Verifies, against the pack in this directory:
    1. every installed file is byte-identical to the pack,
    2. the composition still carries the two functional changes
       (persona 'prefix' in the new 0.1.5 shape + skill-filesystem
       customSkillDirs), and does NOT carry the legacy 'text:' persona key,
    3. the bundled playbook has valid frontmatter (name + description),
    4. what settings.yaml currently uses as agent-presets.default,
    5. (unless -SkipProbe) this machine's environment axes.

  The mount verdict itself comes from dsh, not from this script: a successful
  preset mount is what a new session performs. Point 2 is the schema check that
  catches the common post-upgrade breakage (a renamed persona key).

.PARAMETER DSHHome
  DSH home directory (default: $env:DSH_HOME, else $HOME\.dsh).

.PARAMETER SkipProbe
  Do not run win-env-probe.mjs.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\verify.ps1
#>
[CmdletBinding()]
param(
    [string]$DSHHome = '',
    [switch]$SkipProbe
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Utf8([string]$Path) { [System.IO.File]::ReadAllText($Path, $utf8) }

if (-not $DSHHome) { $DSHHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }
if (-not (Test-Path -LiteralPath $DSHHome)) { throw "DSH home not found: $DSHHome" }
$DSHHome = (Resolve-Path -LiteralPath $DSHHome).Path

$skillName = 'windows-native-tooling'
$packPreset = Join-Path $here 'preset'
$presetDir = Join-Path $DSHHome '.agent-presets\windows'
$problems = New-Object System.Collections.Generic.List[string]

Write-Host ''
Write-Host "windows-agent-pack verify -> $DSHHome" -ForegroundColor Cyan
Write-Host ''

# -- 1. files -----------------------------------------------------------------
Write-Host '[1/4] installed files vs pack'
if (-not (Test-Path -LiteralPath $presetDir)) {
    Write-Host "  preset not installed: $presetDir" -ForegroundColor Red
    $problems.Add('preset directory missing')
} else {
    $n = 0
    Get-ChildItem -LiteralPath $packPreset -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($packPreset.Length + 1)
        $installed = Join-Path $presetDir $rel
        if (-not (Test-Path -LiteralPath $installed)) { Write-Host "  MISSING $rel" -ForegroundColor Red; $problems.Add("missing $rel") }
        elseif ((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash) {
            Write-Host "  DIFFERS $rel (installed copy was edited)" -ForegroundColor Yellow; $problems.Add("differs $rel")
        } else { $n++ }
    }
    Write-Host "  $n file(s) identical to the pack" -ForegroundColor Green
}

# -- 2. composition schema ----------------------------------------------------
Write-Host '[2/4] composition schema (dsh 0.1.5 persona/skill shape)'
$compPath = Join-Path $presetDir 'agent.cordis.yml'
if (Test-Path -LiteralPath $compPath) {
    $comp = Read-Utf8 $compPath
    $rows = ([regex]::Matches($comp, '(?m)^- id: ')).Count
    Write-Host "  rows: $rows"
    if ($comp -match '(?m)^\s+prefix:') { Write-Host '  persona prefix present (0.1.5 shape) OK' -ForegroundColor Green }
    else { Write-Host '  persona prefix MISSING - this preset will not mount on 0.1.5+' -ForegroundColor Red; $problems.Add('persona prefix missing') }
    if ($comp -match '(?m)^\s+text:\s*>-') { Write-Host "  legacy 'text:' persona key present - 0.1.5 rejects it" -ForegroundColor Red; $problems.Add('legacy persona text key') }
    if ($comp -match 'customSkillDirs') { Write-Host '  skill-filesystem customSkillDirs present OK' -ForegroundColor Green }
    else { Write-Host '  customSkillDirs missing - the bundled playbook would not be discovered' -ForegroundColor Red; $problems.Add('customSkillDirs missing') }
} else {
    Write-Host '  composition missing' -ForegroundColor Red
    $problems.Add('composition missing')
}

# -- 3. playbook frontmatter --------------------------------------------------
Write-Host '[3/4] playbook frontmatter'
$skillPath = Join-Path $presetDir "skills\$skillName\SKILL.md"
if (Test-Path -LiteralPath $skillPath) {
    $skill = Read-Utf8 $skillPath
    $hasName = $skill -match '(?m)^name:\s*\S+'
    $hasDesc = $skill -match '(?m)^description:\s*\S+'
    if ($hasName -and $hasDesc) {
        $fences = ([regex]::Matches($skill, '(?m)^```')).Count
        Write-Host "  name + description OK; $fences code fences (must be even: $($fences % 2 -eq 0))" -ForegroundColor Green
        if ($fences % 2 -ne 0) { $problems.Add('unbalanced code fences in SKILL.md') }
    } else { Write-Host '  frontmatter lacks name/description - the catalog would drop this skill' -ForegroundColor Red; $problems.Add('skill frontmatter invalid') }
} else {
    Write-Host '  SKILL.md missing' -ForegroundColor Red
    $problems.Add('SKILL.md missing')
}

# -- 4. default preset + environment ------------------------------------------
$settings = Join-Path $DSHHome 'settings.yaml'
if (Test-Path -LiteralPath $settings) {
    $raw = Read-Utf8 $settings
    $m = [regex]::Match($raw, '(?m)^agent-presets:\r?\n(?:\s+.*\r?\n)*?\s+default:\s*(\S+)\s*$')
    if ($m.Success) { Write-Host "[4/4] agent-presets.default = $($m.Groups[1].Value)" }
    else { Write-Host '[4/4] settings.yaml has no agent-presets.default (new sessions use the shipped default)' }
}

if (-not $SkipProbe) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if ($node -and (Test-Path -LiteralPath $skillPath)) {
        $probe = Join-Path $presetDir "skills\$skillName\scripts\win-env-probe.mjs"
        Write-Host ''
        Write-Host 'environment probe (win-env-probe.mjs --fast):' -ForegroundColor Cyan
        & $node.Source $probe --fast
        if ($LASTEXITCODE -ne 0) { Write-Host "probe exited $LASTEXITCODE" -ForegroundColor Yellow }
    }
}

Write-Host ''
if ($problems.Count -eq 0) {
    Write-Host 'verify OK - files, schema and playbook all check out.' -ForegroundColor Green
    Write-Host 'Mount proof: start a NEW session on the preset at the "windows" slot (.agent-presets\windows).' -ForegroundColor Gray
    exit 0
}
Write-Host 'verify found problems:' -ForegroundColor Red
$problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
Write-Host 'Re-run install.ps1 -Force to restore the packaged version.' -ForegroundColor Yellow
exit 1
