#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/local-orca-lib.sh"

payload="$(cat)"
set_instance_from_payload "$payload"
assert_schema_version
trap cleanup_failed_start ERR
start_server
