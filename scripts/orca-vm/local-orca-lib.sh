#!/usr/bin/env bash
set -euo pipefail

START_PID=""
START_USER_DATA=""
START_STDOUT_FILE=""
START_STDERR_FILE=""

repo_root() {
  local source="${ORCA_REPO_PATH:-}"
  if [[ -z "$source" ]]; then
    source="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  fi
  node -e 'console.log(require("path").resolve(process.argv[1]))' "$source"
}

state_file() {
  printf '%s/scripts/orca-vm/local-orca-state.json' "$(repo_root)"
}

state_value() {
  local key="$1"
  node -e '
const fs = require("fs");
const [path, key] = process.argv.slice(1);
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const value = state[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(String(value));
' "$(state_file)" "$key"
}

env_value() {
  local name="$1" key="$2" fallback="${3:-}" indirect value
  indirect="${!name-}"
  if [[ -n "$indirect" ]]; then
    printf '%s' "$indirect"
  elif value="$(state_value "$key" 2>/dev/null)"; then
    printf '%s' "$value"
  else
    printf '%s' "$fallback"
  fi
}

provider() {
  env_value ORCA_VM_PROVIDER provider "local-orca-server"
}

runtime_dir() {
  local root rel
  root="$(repo_root)"
  rel="$(env_value ORCA_VM_RUNTIME_DIR runtimeDir ".local-data/orca-vm")"
  node -e '
const path = require("path");
const [root, rel] = process.argv.slice(1);
const resolvedRoot = path.resolve(root);
const resolved = path.resolve(resolvedRoot, rel);
const expected = path.join(resolvedRoot, ".local-data", "orca-vm");
if (resolved !== expected && !resolved.startsWith(expected + path.sep)) {
  throw new Error("Runtime directory must stay inside .local-data/orca-vm");
}
process.stdout.write(resolved);
' "$root" "$rel"
}

instance_id() {
  local raw="${ORCA_VM_INSTANCE_ID:-local-orca-server}" clean
  clean="$(printf '%s' "$raw" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-64)"
  [[ -n "$clean" ]] || clean="local-orca-server"
  printf '%s' "$clean"
}

instance_dir() {
  printf '%s/%s' "$(runtime_dir)" "$(instance_id)"
}

metadata_path() {
  printf '%s/metadata.json' "$(instance_dir)"
}

metadata_value() {
  local key="$1"
  node -e '
const fs = require("fs");
const [path, key] = process.argv.slice(1);
if (!fs.existsSync(path)) process.exit(1);
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const value = data[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(String(value));
' "$(metadata_path)" "$key"
}

validate_user_data_path() {
  local user_data="${1:-}"
  [[ -n "$user_data" ]] || return 0
  node -e '
const path = require("path");
const [runtime, userData] = process.argv.slice(1);
const resolvedRuntime = path.resolve(runtime);
const resolved = path.resolve(userData);
if (resolved.startsWith(resolvedRuntime + path.sep)) process.stdout.write(resolved);
' "$(runtime_dir)" "$user_data"
}

read_pid() {
  local pid
  if pid="$(metadata_value pid 2>/dev/null)" && [[ -n "$pid" && "$pid" != "0" ]]; then
    printf '%s' "$pid"
  fi
}

read_user_data() {
  local user_data
  user_data="$(metadata_value userData 2>/dev/null || true)"
  validate_user_data_path "$user_data"
}

write_metadata() {
  local pid="$1" port="$2" project_root="$3" user_data="$4"
  node -e '
const fs = require("fs");
const path = require("path");
const [file, pid, port, projectRoot, userData, instanceId] = process.argv.slice(1);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  instanceId,
  pid: Number(pid),
  port: Number(port),
  projectRoot,
  userData
}, null, 2) + "\n");
' "$(metadata_path)" "$pid" "$port" "$project_root" "$user_data" "$(instance_id)"
}

payload_value() {
  local payload="$1" key="$2"
  node -e '
const [payload, key] = process.argv.slice(1);
let data;
try { data = JSON.parse(payload); } catch { process.exit(1); }
const value = key.split(".").reduce((acc, part) => acc && acc[part], data);
if (value === undefined || value === null) process.exit(1);
process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
' "$payload" "$key"
}

payload_instance_id() {
  local payload="$1" value
  if value="$(payload_value "$payload" recipeResult.userData.resourceId 2>/dev/null)" && [[ -n "$value" ]]; then
    printf '%s' "$value"
  elif value="$(payload_value "$payload" instanceId 2>/dev/null)" && [[ -n "$value" ]]; then
    printf '%s' "$value"
  else
    echo "Lifecycle payload has no instance id." >&2
    return 1
  fi
}

set_instance_from_payload() {
  export ORCA_VM_INSTANCE_ID="$(payload_instance_id "$1")"
}

runtime_process_exists() {
  local user_data="${1:-}"
  [[ -n "$user_data" ]] || return 1
  command -v pgrep >/dev/null 2>&1 || return 1
  pgrep -f "$user_data" >/dev/null 2>&1
}

signal_runtime_processes() {
  local user_data="$1" signal="$2" process_pid
  [[ -n "$user_data" ]] || return 0
  command -v pgrep >/dev/null 2>&1 || return 0
  while IFS= read -r process_pid; do
    [[ "$process_pid" =~ ^[0-9]+$ ]] || continue
    kill "-$signal" "$process_pid" 2>/dev/null || true
  done < <(pgrep -f "$user_data" 2>/dev/null || true)
}

stop_runtime_processes() {
  local user_data pid i=0 runtime_alive=0
  user_data="$(validate_user_data_path "${1:-}")"
  pid="${2:-}"

  signal_runtime_processes "$user_data" TERM
  if [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$pid" != "0" ]] && kill -0 "$pid" 2>/dev/null; then
    if command -v pkill >/dev/null 2>&1; then
      pkill -TERM -P "$pid" 2>/dev/null || true
    fi
    kill -TERM "$pid" 2>/dev/null || true
  fi

  while (( i < 50 )); do
    runtime_alive=0
    if runtime_process_exists "$user_data"; then
      runtime_alive=1
    fi
    if [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$pid" != "0" ]] && kill -0 "$pid" 2>/dev/null; then
      runtime_alive=1
    fi
    if (( runtime_alive == 0 )); then
      return 0
    fi
    i=$((i + 1))
    sleep 0.1
  done

  signal_runtime_processes "$user_data" KILL
  if [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$pid" != "0" ]]; then
    if command -v pkill >/dev/null 2>&1; then
      pkill -KILL -P "$pid" 2>/dev/null || true
    fi
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

safe_remove_instance_dir() {
  local root runtime instance
  root="$(repo_root)"
  runtime="$(runtime_dir)"
  instance="$(instance_dir)"
  node -e '
const fs = require("fs");
const path = require("path");
const [root, runtime, instance] = process.argv.slice(1);
const realRoot = fs.realpathSync(root);
const realRuntime = fs.existsSync(runtime) ? fs.realpathSync(runtime) : path.resolve(runtime);
const expected = path.join(realRoot, ".local-data", "orca-vm");
if (realRuntime !== expected && !realRuntime.startsWith(expected + path.sep)) {
  throw new Error("Refusing to remove an unexpected runtime directory");
}
if (!fs.existsSync(instance)) process.exit(0);
const realInstance = fs.realpathSync(instance);
if (!realInstance.startsWith(realRuntime + path.sep)) {
  throw new Error("Refusing to remove an instance directory outside the runtime root");
}
if (realInstance === realRoot || realInstance === path.dirname(realRoot) || realInstance === process.env.HOME) {
  throw new Error("Refusing to remove an unsafe directory");
}
fs.rmSync(realInstance, { recursive: true, force: true });
' "$root" "$runtime" "$instance"
}

orca_bin() {
  local candidate="${ORCA_CLI_COMMAND:-}"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  candidate="$(command -v orca || true)"
  if [[ -z "$candidate" ]]; then
    echo "orca CLI was not found on PATH." >&2
    return 1
  fi
  printf '%s' "$candidate"
}

choose_port() {
  node -e '
const net = require("net");
const server = net.createServer();
server.on("error", () => process.exit(1));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  server.close(() => process.stdout.write(String(port)));
});
'
}

project_root() {
  node -e 'console.log(require("path").resolve(process.argv[1]))' "${ORCA_REPO_PATH:-$(pwd)}"
}

assert_schema_version() {
  local version="${ORCA_RECIPE_RESULT_SCHEMA_VERSION:-1}"
  if [[ "$version" != "1" ]]; then
    echo "Unsupported recipe result schema version: $version" >&2
    return 1
  fi
}

parse_recipe_result() {
  local stdout_file="$1" instance="$2" provider_name="$3"
  node -e '
const fs = require("fs");
const [file, instanceId, provider] = process.argv.slice(1);
let raw;
try { raw = fs.readFileSync(file, "utf8").trim(); } catch { process.exit(1); }
if (!raw) process.exit(1);
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) process.exit(1);
  try { parsed = JSON.parse(match[0]); } catch { process.exit(1); }
}
const connection = parsed.connection ?? {
  type: "orca-server",
  pairingCode: parsed.pairingCode,
  projectRoot: parsed.projectRoot
};
if (connection.type !== "orca-server" || !connection.pairingCode || !connection.projectRoot) process.exit(1);
const result = {
  schemaVersion: 1,
  pairingCode: connection.pairingCode,
  projectRoot: connection.projectRoot,
  userData: {
    ...(parsed.userData && typeof parsed.userData === "object" ? parsed.userData : {}),
    provider,
    resourceId: instanceId
  }
};
process.stdout.write(JSON.stringify(result));
' "$stdout_file" "$instance" "$provider_name"
}

cleanup_failed_start() {
  set +e
  local pid="${START_PID:-}" user_data="${START_USER_DATA:-}"
  if [[ -z "$user_data" ]]; then
    user_data="$(read_user_data 2>/dev/null || true)"
  fi
  if [[ -z "$pid" ]]; then
    pid="$(read_pid 2>/dev/null || true)"
  fi
  stop_runtime_processes "$user_data" "$pid"
  [[ -n "$START_STDOUT_FILE" ]] && rm -f "$START_STDOUT_FILE"
  [[ -n "$START_STDERR_FILE" ]] && rm -f "$START_STDERR_FILE"
  safe_remove_instance_dir >/dev/null 2>&1 || true
  exit 1
}

start_server() {
  local project port instance user_data existing_pid existing_user_data result attempt=0 tmp_dir provider_name
  local -a serve_env
  project="$(project_root)"
  instance="$(instance_id)"
  provider_name="$(provider)"

  existing_user_data="$(read_user_data 2>/dev/null || true)"
  existing_pid="$(read_pid 2>/dev/null || true)"
  stop_runtime_processes "$existing_user_data" "$existing_pid"

  mkdir -p "$(instance_dir)"
  user_data="$(mktemp -d "$(instance_dir)/user-data.XXXXXX")"
  START_USER_DATA="$user_data"
  port="$(choose_port)"
  [[ -n "$port" ]] || { echo "Could not allocate a loopback port." >&2; cleanup_failed_start; }

  write_metadata "0" "$port" "$project" "$user_data"

  tmp_dir="${TMPDIR:-/tmp}"
  START_STDOUT_FILE="$(mktemp "$tmp_dir/orca-recipe-out.XXXXXX")"
  START_STDERR_FILE="$(mktemp "$tmp_dir/orca-recipe-err.XXXXXX")"

  serve_env=(ORCA_USER_DATA_PATH="$user_data" ORCA_INSTANCE_ID="$instance")
  if [[ "$(uname -s)" != "Darwin" ]]; then
    serve_env+=(ORCA_SERVE_RUNTIME=orcad)
  fi

  env "${serve_env[@]}" nohup "$(orca_bin)" serve \
    --port "$port" \
    --bind 127.0.0.1 \
    --pairing-address "ws://127.0.0.1:$port" \
    --project-root "$project" \
    --recipe-json \
    --refuse-public \
    >"$START_STDOUT_FILE" 2>"$START_STDERR_FILE" < /dev/null &
  START_PID=$!
  disown 2>/dev/null || true

  while (( attempt < 150 )); do
    if result="$(parse_recipe_result "$START_STDOUT_FILE" "$instance" "$provider_name" 2>/dev/null)"; then
      write_metadata "$START_PID" "$port" "$project" "$user_data"
      printf '%s' "$result"
      rm -f "$START_STDOUT_FILE" "$START_STDERR_FILE"
      trap - ERR
      return 0
    fi
    if ! kill -0 "$START_PID" 2>/dev/null && ! runtime_process_exists "$user_data"; then
      echo "orca serve exited before it produced recipe JSON." >&2
      [[ -s "$START_STDERR_FILE" ]] && cat "$START_STDERR_FILE" >&2
      cleanup_failed_start
    fi
    attempt=$((attempt + 1))
    sleep 0.2
  done

  echo "Timed out waiting for orca serve recipe JSON." >&2
  [[ -s "$START_STDERR_FILE" ]] && cat "$START_STDERR_FILE" >&2
  cleanup_failed_start
}
