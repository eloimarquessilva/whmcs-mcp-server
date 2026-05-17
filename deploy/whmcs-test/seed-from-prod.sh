#!/usr/bin/env bash
# Seed BOTH local WHMCS legs from a SCRUBBED copy of the prod DB.
#
# Flow: pull prod dump → load into a disposable staging DB → scrub PII +
# secrets → export scrubbed.sql → DELETE the raw dump → load scrubbed.sql
# into whmcs8 (mcpw8-db) and whmcs9 (mcpw9-db) → write configuration.php
# for each leg → post-install-fixup the 8.13 leg. The 9.0 leg then needs
# `npm run whmcs:test:upgrade9` (WHMCS 8→9 migration).
#
# Unscrubbed prod data never enters a WHMCS container and is deleted as
# soon as the scrubbed export exists. .prodseed/ is gitignored.
#
# Usage:
#   deploy/whmcs-test/seed-from-prod.sh            # full (pull + seed)
#   deploy/whmcs-test/seed-from-prod.sh --skip-pull  # reuse existing raw.sql.gz

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/deploy/whmcs-test"
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
PRODSEED="$HERE/.prodseed"
DC=(docker compose -f "$COMPOSE_FILE")

DEV_ADMIN_USER_PW="${WMCP_DEV_ADMIN_PW:-DevOnly#2026!secure}"

skip_pull=0
[[ "${1:-}" == "--skip-pull" ]] && skip_pull=1

# --- preconditions -----------------------------------------------------------
if ! "${DC[@]}" ps mcpw8-db --status running --quiet >/dev/null 2>&1 \
   || ! "${DC[@]}" ps mcpw9-db --status running --quiet >/dev/null 2>&1; then
  echo "ERROR: stack not up. Run: npm run whmcs:test:up" >&2
  exit 1
fi

if [[ $skip_pull -eq 0 || ! -f "$PRODSEED/raw.sql.gz" ]]; then
  bash "$HERE/pull-prod-db.sh"
fi
[[ -f "$PRODSEED/raw.sql.gz" ]] || { echo "ERROR: no $PRODSEED/raw.sql.gz" >&2; exit 1; }
# shellcheck disable=SC1091
source "$PRODSEED/prod-config.env"

mysql8() { "${DC[@]}" exec -T mcpw8-db mariadb -uroot -prootsecret_8 "$@"; }
mysql9() { "${DC[@]}" exec -T mcpw9-db mariadb -uroot -prootsecret_9 "$@"; }

# --- 1. staging DB + load raw ------------------------------------------------
# The operator dump is a full mysqldump from prod MySQL 8.0 → it carries
# CREATE/USE/DROP DATABASE (would escape our staging DB) and MySQL-8-only
# collations (utf8mb4_0900_*) MariaDB rejects. Strip the DB-scoping lines
# so it loads into OUR staging DB, and rewrite the collations. --force so
# residual MySQL8↔MariaDB incompatibilities don't abort the import.
sanitize_dump() {
  gunzip -c "$PRODSEED/raw.sql.gz" \
    | sed -E '/^[[:space:]]*(CREATE[[:space:]]+DATABASE|DROP[[:space:]]+DATABASE|USE[[:space:]]+`)/Id' \
    | sed -E 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g; s/utf8mb4_0900_bin/utf8mb4_bin/g; s/[[:space:]]COLLATE[[:space:]]+utf8mb4_0900_as_cs//g'
}
echo "==> Loading raw prod dump into disposable staging DB (mcpw8-db/whmcs_stage) ..."
mysql8 -e "DROP DATABASE IF EXISTS whmcs_stage;
           CREATE DATABASE whmcs_stage CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sanitize_dump | "${DC[@]}" exec -T mcpw8-db \
  mariadb -uroot -prootsecret_8 --force --default-character-set=utf8mb4 whmcs_stage

# --- 2. scrub ----------------------------------------------------------------
echo "==> Computing dev-admin bcrypt + applying scrub-pii.sql ..."
PWHASH="$("${DC[@]}" exec -T mcpw8-php php -r \
  'echo password_hash($argv[1], PASSWORD_DEFAULT);' "$DEV_ADMIN_USER_PW" 2>/dev/null | tr -d '\r')"
[[ "$PWHASH" == \$2* ]] || { echo "ERROR: failed to compute bcrypt for dev admin" >&2; exit 1; }
TMP_SQL="$(mktemp)"
{
  printf "SET @ph := '%s';\n" "$PWHASH"
  sed "s/'__ADMIN_PWHASH__'/@ph/g" "$HERE/scrub-pii.sql"
} > "$TMP_SQL"
# --force: optional table/column missing on a minor must not abort the
# mandated core scrubs (which run first and are guaranteed present).
"${DC[@]}" exec -T mcpw8-db mariadb -uroot -prootsecret_8 --force whmcs_stage < "$TMP_SQL"
rm -f "$TMP_SQL"

# Post-scrub assertion (FAIL-CLOSED): no real PII/credentials may remain.
# Covers emails (clients/contacts/users), phones, anonymized names, custom
# field values, and the API device-credential store. If any table/column is
# missing the query errors → empty result → treated as failure (we never
# load prod-derived data on doubt).
leak="$(mysql8 -N -B whmcs_stage -e "
  SELECT
    (SELECT COUNT(*) FROM tblclients  WHERE email NOT LIKE 'dev+%@example.test'  AND email <> '') +
    (SELECT COUNT(*) FROM tblcontacts WHERE email NOT LIKE 'dev+c%@example.test' AND email <> '') +
    (SELECT COUNT(*) FROM tblusers    WHERE email NOT LIKE 'dev+u%@example.test' AND email <> '') +
    (SELECT COUNT(*) FROM tblclients  WHERE phonenumber NOT IN ('+10000000000','')) +
    (SELECT COUNT(*) FROM tblcontacts WHERE phonenumber NOT IN ('+10000000000','')) +
    (SELECT COUNT(*) FROM tblclients  WHERE firstname NOT LIKE 'Client%') +
    (SELECT COUNT(*) FROM tblcontacts WHERE firstname NOT LIKE 'Contact%') +
    (SELECT COUNT(*) FROM tblclients  WHERE address1  NOT LIKE 'Addr %') +
    (SELECT COUNT(*) FROM tblcustomfieldsvalues WHERE value <> '') +
    (SELECT COUNT(*) FROM tbldeviceauth);" 2>/dev/null | tr -d '\r')"
if [[ "${leak:-1}" != "0" ]]; then
  echo "ERROR: scrub assertion failed — ${leak:-<query error>} PII/credential rows remain" >&2
  echo "       (checked: emails clients/contacts/users, phones, names, addresses, custom fields, tbldeviceauth)." >&2
  echo "       Aborting — no prod-derived data loaded into the WHMCS containers." >&2
  mysql8 -e "DROP DATABASE IF EXISTS whmcs_stage;" || true
  exit 1
fi
echo "    scrub OK (emails, phones, names, addresses, custom fields, tbldeviceauth all clean)"

# --- 3. export scrubbed, DELETE raw -----------------------------------------
echo "==> Exporting scrubbed.sql and DELETING the raw prod dump ..."
DUMP_BIN="$("${DC[@]}" exec -T mcpw8-db sh -lc 'command -v mariadb-dump || command -v mysqldump' | tr -d '\r')"
"${DC[@]}" exec -T mcpw8-db "$DUMP_BIN" --no-tablespaces --single-transaction \
  --routines --triggers -uroot -prootsecret_8 whmcs_stage > "$PRODSEED/scrubbed.sql"
chmod 600 "$PRODSEED/scrubbed.sql"
rm -f "$PRODSEED/raw.sql.gz"
echo "    raw.sql.gz deleted; scrubbed.sql ($(du -h "$PRODSEED/scrubbed.sql"|awk '{print $1}')) retained (gitignored)."

# --- 4. load scrubbed into both legs ----------------------------------------
load_leg() {
  local mysqlfn="$1" db="$2" rootpw="$3" svc="$4"
  echo "==> Loading scrubbed data into $svc / $db ..."
  $mysqlfn -e "DROP DATABASE IF EXISTS \`$db\`;
               CREATE DATABASE \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
               GRANT ALL ON \`$db\`.* TO 'whmcs'@'%'; FLUSH PRIVILEGES;"
  "${DC[@]}" exec -T "$svc" mariadb -uroot "-p$rootpw" --default-character-set=utf8mb4 "$db" \
    < "$PRODSEED/scrubbed.sql"
}
load_leg mysql8 whmcs8 rootsecret_8 mcpw8-db
load_leg mysql9 whmcs9 rootsecret_9 mcpw9-db
mysql8 -e "DROP DATABASE IF EXISTS whmcs_stage;"

# --- 5. configuration.php per leg -------------------------------------------
write_conf() {
  local dir="$1" dbhost="$2" dbpass="$3" dbname="$4"
  cat > "$REPO_ROOT/deploy/whmcs-test/source/$dir/configuration.php" <<EOF
<?php
\$license = '${PROD_LICENSE:-WHMCS-DEV-LOCAL}';
\$db_host = '$dbhost';
\$db_port = '3306';
\$db_username = 'whmcs';
\$db_password = '$dbpass';
\$db_name = '$dbname';
\$db_tls_ca = '';
\$db_tls_ca_path = '';
\$db_tls_cert = '';
\$db_tls_cipher = '';
\$db_tls_key = '';
\$db_tls_verify_cert = '';
\$cc_encryption_hash = '${PROD_CC_HASH}';
\$templates_compiledir = 'templates_c';
\$mysql_charset = 'utf8';
EOF
  chmod 644 "$REPO_ROOT/deploy/whmcs-test/source/$dir/configuration.php"
}
write_conf 8.13 mcpw8-db whmcs_8_password whmcs8
write_conf 9.0  mcpw9-db whmcs_9_password whmcs9
echo "    configuration.php written for 8.13 + 9.0 (prod cc_encryption_hash kept; local db_host)"

# --- 6. fix up the 8.13 leg (matches prod version → no upgrade) -------------
bash "$HERE/post-install-fixup.sh" mcpw8

echo
echo "Done (8.13 leg ready). Dev admin: admin / $DEV_ADMIN_USER_PW"
echo "Next: npm run whmcs:test:upgrade9   # run WHMCS 8→9 migration on the 9.0 leg"
