#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$ROOT_DIR/packages/@codepapr/ui/src-tauri/target/release/bundle"
DMG_DIR="$OUTPUT_DIR/dmg"
APP_DIR="$OUTPUT_DIR/macos"

echo "============================================================"
echo "CodePapr 桌面安装包构建器"
echo "项目目录: $ROOT_DIR"
echo "============================================================"
echo

cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "错误: 未找到 npm，请先安装 Node.js。"
  echo
  read -r -p "按回车键关闭..."
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "错误: 未找到 cargo，请先安装 Rust 工具链。"
  echo
  read -r -p "按回车键关闭..."
  exit 1
fi

echo "1/2 正在验证并发布桌面应用与安装包..."
npm run publish

echo
echo "2/2 构建完成。"
echo

if [ -d "$DMG_DIR" ]; then
  echo "DMG 输出目录:"
  echo "  $DMG_DIR"
fi

if [ -d "$APP_DIR" ]; then
  echo "APP 输出目录:"
  echo "  $APP_DIR"
fi

echo
echo "正在打开输出目录..."
open "$OUTPUT_DIR"

echo
echo "完成：你可以在打开的文件夹里直接看到 .app 和 .dmg。"
echo
read -r -p "按回车键关闭..."
