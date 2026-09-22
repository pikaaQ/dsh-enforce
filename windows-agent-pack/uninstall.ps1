<#
.SYNOPSIS
  Remove windows-agent-pack from one DSH instance (reversible).

.DESCRIPTION
  Removes:
    1. $DSH_HOME\.agent-presets\windows\            (the preset)
    2. $DSH_HOME\skills\windows-native-tooling\     (only if -GlobalSkill installed it)
    3. the 'agent-presets.default: windows' line in settings.yaml (only if it
       currently points at windows; a backup is written first)

  Timestamped backups created by install.ps1 (windows.bak-<stamp>,
  windows-native-tooling.bak-<stamp>, settings.yaml.bak-*) are kept on purpose.

.PARAMETER DSHHome
  DSH home directory (default: $env:DSH_HOME, else $HOME\.dsh).

.PARAMETER KeepPreset
  Do not delete the preset directory (useful to only undo the global skill /
  the default-preset change).

.PARAMETER RemoveGlobalSkill
  Also delete the user skill root copy when it is byte-identical to the pack's
  copy. Without this flag that copy is reported but left alone, because a
  hand-edited skill root copy is not ours to delete.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -RemoveGlobalSkill
#>
[CmdletBinding()]
param(
    [string]$DSHHome = '',
    [switch]$KeepPreset,
    [switch]$RemoveGlobalSkill
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Read-Utf8([string]$Path) { [System.IO.File]::ReadAllText($Path, $utf8) }
function Write-Utf8([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $utf8) }

if (-not $DSHHome) { $DSHHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }
if (-not (Test-Path -LiteralPath $DSHHome)) { throw "DSH home not found: $DSHHome" }
$DSHHome = (Resolve-Path -LiteralPath $DSHHome).Path
$skillName = 'windows-native-tooling'

Write-Host ''
Write-Host "windows-agent-pack uninstall <- $DSHHome" -ForegroundColor Cyan

# -- preset -------------------------------------------------------------------
$presetDir = Join-Path $DSHHome '.agent-presets\windows'
if ($KeepPreset) {
    Write-Host '-KeepPreset: preset left in place' -ForegroundColor DarkGray
} elseif (Test-Path -LiteralPath $presetDir) {
    try {
        Remove-Item -LiteralPath $presetDir -Recurse -Force -ErrorAction Stop
        Write-Host "removed preset: $presetDir" -ForegroundColor Yellow
    } catch {
        Write-Host "could not remove $presetDir : $($_.Exception.Message)" -ForegroundColor Red
        Write-Host '  a running dsh may be watching this preset - stop it (or wait a moment) and re-run,' -ForegroundColor Yellow
        Write-Host '  or delete the directory manually once that process is gone.' -ForegroundColor Yellow
    }
} else {
    Write-Host 'preset windows not present - skipped'
}

# -- user skill root copy -----------------------------------------------------
$dstSkill = Join-Path (Join-Path $DSHHome 'skills') $skillName
$packSkill = Join-Path $here "preset\skills\$skillName"
if (Test-Path -LiteralPath $dstSkill) {
    $identical = $false
    if (Test-Path -LiteralPath $packSkill) {
        $packFiles = Get-ChildItem -LiteralPath $packSkill -Recurse -File
        $identical = $true
        foreach ($f in $packFiles) {
            $rel = $f.FullName.Substring($packSkill.Length + 1)
            $other = Join-Path $dstSkill $rel
            if (-not (Test-Path -LiteralPath $other)) { $identical = $false; break }
            if ((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $other -Algorithm SHA256).Hash) { $identical = $false; break }
        }
    }
    if ($RemoveGlobalSkill -and $identical) {
        Remove-Item -LiteralPath $dstSkill -Recurse -Force
        Write-Host "removed user skill root copy: $dstSkill" -ForegroundColor Yellow
    } elseif ($RemoveGlobalSkill) {
        Write-Host "  $dstSkill differs from the pack - left in place (delete it yourself if you want it gone)" -ForegroundColor Yellow
    } else {
        Write-Host "user skill root copy present: $dstSkill (pass -RemoveGlobalSkill to delete it)" -ForegroundColor DarkGray
    }
}

# -- default preset -----------------------------------------------------------
$settings = Join-Path $DSHHome 'settings.yaml'
if (Test-Path -LiteralPath $settings) {
    $raw = Read-Utf8 $settings
    if ($raw -match '(?m)^agent-presets:\r?\n(?:\s+.*\r?\n)*?\s+default:\s*windows\s*$') {
        $new = [regex]::Replace($raw, '(?m)^agent-presets:\r?\n(?:\s+.*\r?\n)*?\s+default:\s*windows\s*\r?\n', '')
        Copy-Item -LiteralPath $settings -Destination "$settings.bak-uninstall" -Force
        Write-Utf8 $settings ($new.TrimEnd("`r", "`n") + "`n")
        Write-Host "removed 'agent-presets.default: windows' from settings.yaml (backup: $settings.bak-uninstall)" -ForegroundColor Yellow
    } else {
        Write-Host "settings.yaml does not default to windows - left untouched" -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host 'Uninstalled. New sessions fall back to the previous default preset.' -ForegroundColor Green
Write-Host 'Existing sessions keep the composition they started with.'
