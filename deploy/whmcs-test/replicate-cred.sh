#!/usr/bin/env bash
# Replicate a WHMCS External-API credential row between the two local legs
# so ONE generated credential authenticates on BOTH 8.13 and 9.0.
#
# WHY: WHMCS 8.13.3 / 9.0.4 store API credentials in `tbldeviceauth`
# (NOT the older `tblapi_credentials`, which no longer exists). Generating
# a credential is admin-SPA-only (no headless contract), and it lands in
# only the leg whose admin you used. This copies the exact row (hashed
# `secret` + `compat_secret` + `role_ids`) to the other leg's DB — the
# same identifier/secret then verifies on both (bcrypt password_verify).
#
# Usage:
#   deploy/whmcs-test/replicate-cred.sh <IDENTIFIER> [src] [dst]
#     src/dst ∈ {mcpw8,mcpw9}; default src=mcpw9 dst=mcpw8
#
# Idempotent (REPLACE INTO). Dev-only.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
DC=(docker compose -f "$COMPOSE_FILE")

IDENT="${1:?usage: replicate-cred.sh <IDENTIFIER> [src mcpw9] [dst mcpw8]}"
SRC="${2:-mcpw9}"
DST="${3:-mcpw8}"

declare -A DBSVC=( [mcpw8]=mcpw8-db [mcpw9]=mcpw9-db )
declare -A RPW=(   [mcpw8]=rootsecret_8 [mcpw9]=rootsecret_9 )
declare -A DBN=(   [mcpw8]=whmcs8 [mcpw9]=whmcs9 )
for k in "$SRC" "$DST"; do [[ -n "${DBSVC[$k]:-}" ]] || { echo "bad leg: $k (use mcpw8|mcpw9)" >&2; exit 1; }; done

esc=${IDENT//\'/\'\'}
have="$("${DC[@]}" exec -T "${DBSVC[$SRC]}" mariadb -uroot "-p${RPW[$SRC]}" -N -B "${DBN[$SRC]}" \
  -e "SELECT COUNT(*) FROM tbldeviceauth WHERE identifier='$esc';" 2>/dev/null | grep -vi insecure | tr -d '\r')"
[[ "${have:-0}" -ge 1 ]] || { echo "ERROR: identifier not found in $SRC/${DBN[$SRC]}.tbldeviceauth" >&2; exit 1; }

DUMP="$("${DC[@]}" exec -T "${DBSVC[$SRC]}" sh -lc 'command -v mariadb-dump || command -v mysqldump' | tr -d '\r')"
"${DC[@]}" exec -T "${DBSVC[$SRC]}" "$DUMP" --no-create-info --complete-insert \
  --skip-extended-insert --no-tablespaces -uroot "-p${RPW[$SRC]}" \
  --where="identifier='$esc'" "${DBN[$SRC]}" tbldeviceauth 2>/dev/null \
  | grep -E '^INSERT INTO' | sed 's/^INSERT INTO/REPLACE INTO/' \
  | "${DC[@]}" exec -T "${DBSVC[$DST]}" mariadb -uroot "-p${RPW[$DST]}" "${DBN[$DST]}"

echo "OK: credential '$IDENT' replicated $SRC → $DST (tbldeviceauth). Same identifier/secret now works on both legs."
