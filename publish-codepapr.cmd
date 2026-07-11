@echo off
chcp 65001 >nul 2>nul
setlocal

set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

set "OUTPUT_DIR=%ROOT_DIR%Release"

where npm >nul 2>nul
if errorlevel 1 (
  echo 错误: 未找到 npm，请先安装 Node.js。
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo CodePapr Publish
echo 项目目录: %ROOT_DIR%
echo ============================================================
echo.
echo 1/2 正在生成桌面运行文件和安装包...
call npm run publish
if errorlevel 1 (
  echo.
  echo Publish 失败。
  echo.
  pause
  exit /b 1
)

echo.
echo 2/2 Publish 完成。
echo.
echo 输出目录:
echo   %OUTPUT_DIR%
echo.
echo 正在打开输出目录...
start "" "%OUTPUT_DIR%"

echo.
echo 完成：你可以在打开的文件夹里查看当前平台的运行文件和安装包。
echo.
pause
