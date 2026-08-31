@echo off
rem ============================================================
rem  NOVA Mail CLI - Windows installer
rem  Downloads the latest nova.mjs and installs a `nova` command.
rem ============================================================
setlocal EnableExtensions

set "BASE=https://nova-email.com"
set "DEST=%USERPROFILE%\.nova-cli"
set "BIN=%DEST%\nova.mjs"

title NOVA Mail CLI Installer
echo.
echo   Installing NOVA Mail CLI...
echo   Destination: %DEST%
echo.

rem -- create the install folder ----
if not exist "%DEST%" mkdir "%DEST%"
if errorlevel 1 goto fail

rem -- download the CLI ----
echo   Downloading latest version...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=New-Object System.Net.WebClient; $c.DownloadFile('%BASE%/cli/nova.mjs','%BIN%')"
if errorlevel 1 goto fail

rem -- create the starter script ----
>  "%DEST%\nova.cmd" @echo off
echo @set "NOVA_CLI=%~dp0nova.mjs">>"%DEST%\nova.cmd"
echo @node "%NOVA_CLI%" %%*>>"%DEST%\nova.cmd"
if errorlevel 1 goto fail

rem -- add the folder to the user PATH so `nova` works in new terminals ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=[Environment]::GetEnvironmentVariable('Path','User'); if($p -notlike '*%DEST%*'){ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';')+';'+'%DEST%'), 'User') }"

echo.
echo   Done! To see the interactive menu, open a NEW terminal and run:
echo.
echo       nova
echo.
echo   Or script it with one-shot commands like:
echo       nova mailbox
echo       nova send --to a@b.com --subject "Hi" --body "Hello"
echo.
echo   (The current window still needs a new terminal to pick up the PATH.)
pause
exit /b 0

:fail
echo.
echo   [!] Install failed. Check your internet connection and try again.
pause
exit /b 1
