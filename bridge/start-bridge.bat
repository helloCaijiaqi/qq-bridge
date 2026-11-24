@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem Node version guard -- the single place that decides which
rem interpreter runs src\bridge.js. Nothing else may fall back
rem to a bare "node" from PATH.
rem
rem Why this exists:
rem   @snowluma/sdk builds its WebSocketClient with
rem     options.webSocket ?? globalThis.WebSocket
rem   and that global only exists in Node 22+. Launching the
rem   bridge on C:\Program Files\nodejs\node.exe (v20.20.1 on
rem   this machine) therefore dies during client construction
rem   with:
rem     SnowLumaConnectionError: No WebSocket implementation is available
rem   The message names neither Node nor a version, so it reads
rem   like a SnowLuma server fault instead of an interpreter one.
rem
rem How candidates are judged:
rem   The accept test is the capability itself -- major >= 22
rem   AND globalThis.WebSocket is a function -- not a string
rem   compare against a version banner. If a future build moves
rem   the boundary, the test follows it instead of lying.
rem   package.json declares node >= 22.13.0.
rem ============================================================
set "NODE_EXE="
set "NODE_VER="
set "PROBE_LOG=%TEMP%\_qqbridge_probe.log"
if exist "%PROBE_LOG%" del "%PROBE_LOG%" >nul 2>&1
>"%PROBE_LOG%" echo.

rem Candidate order:
rem   1. QQBRIDGE_NODE override (an explicit operator choice)
rem   2. DSH's bundled node -- the bridge is a DSH companion,
rem      so this is the version DSH itself is known to run on
rem   3. every node on PATH, in the order "where" returns them
rem   4. runtimes downloaded by WorkBuddy
call :probe "%QQBRIDGE_NODE%"
call :probe "C:\DeepSeekHarness\node\node.exe"
for /f "delims=" %%P in ('where node 2^>nul') do call :probe "%%P"
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do call :probe "%%D\node.exe"

if not defined NODE_EXE (
    echo [ERROR] No usable Node found. Need Node 22+ with globalThis.WebSocket.
    echo.
    echo   Rejected candidates:
    type "%PROBE_LOG%"
    echo   Starting the bridge without one fails at connect time with:
    echo     SnowLumaConnectionError: No WebSocket implementation is available
    echo.
    echo   Fix any one of these:
    echo     1. install Node 22+
    echo     2. set QQBRIDGE_NODE to a Node 22+ executable, e.g.
    echo          set QQBRIDGE_NODE=C:\DeepSeekHarness\node\node.exe
    del "%PROBE_LOG%" >nul 2>&1
    pause
    exit /b 1
)
del "%PROBE_LOG%" >nul 2>&1

rem Re-check the winner before it is used for anything. Probing
rem passing is necessary but not sufficient: a candidate could be
rem replaced or shadowed between probe and launch.
"%NODE_EXE%" -e "process.exit((Number(process.versions.node.split('.')[0])>=22&&typeof globalThis.WebSocket==='function')?0:1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] "%NODE_EXE%" passed probing but failed the re-check. Aborting.
    pause
    exit /b 1
)
echo [node] %NODE_VER%  (%NODE_EXE%)

rem Audit hook: "start.bat --check-node" prints the interpreter this
rem entry point would use and exits, so the decision can be verified
rem without launching (and without touching) the running bridge.
rem Kept as two single-line ifs on purpose: a parenthesised block would
rem break if NODE_VER ever carried a stray carriage return.
if /i "%~1"=="--check-node" echo RESOLVED %NODE_VER% "%NODE_EXE%"
if /i "%~1"=="--check-node" exit /b 0

rem Put the chosen interpreter's directory first on PATH so that
rem anything spawned later ("node ...", npx shims, the ACL helper)
rem resolves the same version instead of drifting back to v20.
for %%I in ("%NODE_EXE%") do set "PATH=%%~dpI;%PATH%"

rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
"%NODE_EXE%" scripts\harden-state-acl.mjs --quiet
:loop
"%NODE_EXE%" src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop

rem ---- subroutine: accept %1 as the bridge interpreter or log why not ----
:probe
if defined NODE_EXE goto :eof
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
set "CAND_VER=?"
call :version "%~1"
"%~1" -e "process.exit((Number(process.versions.node.split('.')[0])>=22&&typeof globalThis.WebSocket==='function')?0:1)" >nul 2>&1
if errorlevel 1 goto :probe_reject
set "NODE_EXE=%~1"
set "NODE_VER=%CAND_VER%"
goto :eof

:probe_reject
>>"%PROBE_LOG%" echo   - [%CAND_VER%] "%~1"
goto :eof

rem ---- subroutine: read the version banner of %1 into CAND_VER ----
:version
set "CAND_VER=?"
"%~1" -v > "%TEMP%\_qqbridge_ver.txt" 2>nul
set /p CAND_VER=<"%TEMP%\_qqbridge_ver.txt"
del "%TEMP%\_qqbridge_ver.txt" >nul 2>&1
goto :eof
