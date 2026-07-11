#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

node "$SCRIPT_DIR/packages/@codepapr/cli/bin/codepapr.mjs" agent -w "$SCRIPT_DIR" "$@"
