#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$ROOT_DIR/Release"

echo "============================================================"
echo "CodePapr Publish"
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

echo "1/2 正在生成桌面运行文件和安装包..."
npm run publish

echo
echo "2/2 Publish 完成。"
echo
echo "输出目录:"
echo "  $OUTPUT_DIR"
echo
echo "正在打开输出目录..."
open "$OUTPUT_DIR"

echo
echo "完成：你可以在打开的文件夹里查看当前平台的运行文件和安装包。"
echo
read -r -p "按回车键关闭..."
