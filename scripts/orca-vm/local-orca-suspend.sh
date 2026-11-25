#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/local-orca-lib.sh"

payload="$(cat)"
set_instance_from_payload "$payload"
user_data="$(read_user_data 2>/dev/null || true)"
pid="$(read_pid 2>/dev/null || true)"
stop_runtime_processes "$user_data" "$pid"
