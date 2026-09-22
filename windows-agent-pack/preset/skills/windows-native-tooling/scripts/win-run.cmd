@echo off
rem ASCII-only by design: cmd.exe reads .cmd files with the OEM/ANSI code page,
rem so non-ASCII bytes in this file can break parsing on a non-English Windows.
rem Locates node.exe (PATH, then the usual install dirs) and runs win-run.mjs.
rem Usage: win-run.cmd [options] -- <command> [args...]  (args containing cmd metacharacters & | < > ^ " ( ) are re-parsed by cmd.exe BEFORE this file runs: call node win-run.mjs directly instead)
setlocal
set "NODEEXE="
for %%I in (node.exe) do if not defined NODEEXE set "NODEEXE=%%~$PATH:I"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE (
  echo [error] node.exe not found on PATH or in the usual install dirs. 1>&2
  echo         Run it yourself with any node: node "%~dp0win-run.mjs" %* 1>&2
  exit /b 127
)
"%NODEEXE%" "%~dp0win-run.mjs" %*
exit /b %ERRORLEVEL%
