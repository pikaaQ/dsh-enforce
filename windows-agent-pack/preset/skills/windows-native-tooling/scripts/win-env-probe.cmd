@echo off
rem ASCII-only by design: cmd.exe reads .cmd files with the OEM/ANSI code page,
rem so non-ASCII bytes in this file can break parsing on a non-English Windows.
rem Locates node.exe (PATH, then the usual install dirs) and runs the probe. Args go through %*, so avoid cmd metacharacters (& | < > ^ " ( )).
setlocal
set "NODEEXE="
for %%I in (node.exe) do if not defined NODEEXE set "NODEEXE=%%~$PATH:I"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE (
  echo [error] node.exe not found on PATH or in the usual install dirs. 1>&2
  echo         Run it yourself with any node: node "%~dp0win-env-probe.mjs" 1>&2
  exit /b 127
)
"%NODEEXE%" "%~dp0win-env-probe.mjs" %*
exit /b %ERRORLEVEL%
