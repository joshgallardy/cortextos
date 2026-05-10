#!/usr/bin/env bash
# reset-cost-cap.sh — wrapper for Node.js CLI
# Usage: reset-cost-cap.sh <agent> [tier]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus reset-cost-cap "$@"
