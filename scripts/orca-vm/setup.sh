#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

node_bin="$(command -v node || true)"
npm_bin="$(command -v npm || true)"
git_bin="$(command -v git || true)"
python_bin="$(command -v python3 || true)"

[[ -n "$node_bin" ]] || { echo "node is required by package.json." >&2; exit 1; }
[[ -n "$npm_bin" ]] || { echo "npm is required by package-lock.json." >&2; exit 1; }
[[ -n "$git_bin" ]] || { echo "git is required for workspace setup." >&2; exit 1; }
[[ -n "$python_bin" ]] || { echo "python3 is required by requirements.txt." >&2; exit 1; }

node_major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22 or newer is required; found $("$node_bin" --version)." >&2
  exit 1
fi

lock_hash="$(node -e 'const fs=require("fs"),crypto=require("crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync("package-lock.json")).digest("hex"))')"
marker="node_modules/.meeting-package-lock-sha256"

if [[ -d node_modules && -f "$marker" ]] && [[ "$(cat "$marker")" == "$lock_hash" ]] && "$npm_bin" ls --depth=0 --silent >/dev/null 2>&1; then
  echo "Node dependencies already match package-lock.json."
elif [[ -d node_modules ]] && "$npm_bin" ls --depth=0 --silent >/dev/null 2>&1; then
  printf '%s\n' "$lock_hash" > "$marker"
  echo "Node dependencies verified."
else
  echo "Installing locked Node dependencies."
  "$npm_bin" ci --prefer-offline --no-audit --no-fund
  printf '%s\n' "$lock_hash" > "$marker"
fi

setup_marker="$("$git_bin" rev-parse --path-format=absolute --git-path orca/setup-runner.sh 2>/dev/null || true)"
if [[ -n "$setup_marker" ]]; then
  mkdir -p "$(dirname "$setup_marker")"
  printf 'ok\n' > "$setup_marker"
fi

echo "Orca workspace setup completed."
