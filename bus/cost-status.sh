#!/usr/bin/env bash
# cost-status.sh — wrapper for Node.js CLI
# Usage: cost-status.sh [--agent <name>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

exec node "$CLI" bus cost-status "$@"
