@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

node "%SCRIPT_DIR%packages\@codepapr\cli\bin\codepapr.mjs" agent -w "%SCRIPT_DIR%" %*
