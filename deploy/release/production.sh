#!/usr/bin/env bash
# Operator-installed code, never copied from a candidate release.
set -Eeuo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }
# OpenSSH sets this when the deploy key has a forced command. Never evaluate it as shell.
allowed_command='^activate ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([0-9a-f]{64})$'
[[ ${SSH_ORIGINAL_COMMAND:-} =~ $allowed_command ]] || die 'Expected activate with a commit, image ID and archive checksum'
commit=${BASH_REMATCH[1]}
expected_id=${BASH_REMATCH[2]}
archive_sum=${BASH_REMATCH[3]}
[[ $(id -un) == blotato-deploy && $(id -u) != 0 ]] || die 'Use the dedicated blotato-deploy account'

cd /srv/blotato
[[ -f .env.deploy && -f service.env && -f compose.deploy.yaml && -f deploy/release/compose.image.yaml ]] || die 'Host is not provisioned'
[[ -d releases && ! -L releases ]] || die 'Provision a private releases directory'
exec 9>releases/production.lock
flock -w 600 9 || die 'Another deployment holds the lock'

archive=$(mktemp releases/incoming.XXXXXXXX.gz)
result=failed
phase=transfer
finish() {
  local status=$?
  trap - EXIT
  rm -f -- "$archive"
  printf '%s commit=%s image=%s result=%s phase=%s\n' "$(date -u +%FT%TZ)" "$commit" "$expected_id" "$result" "$phase" >> releases/history.log
  [[ $status == 0 ]] || printf 'Deployment failed during %s; inspect the running service before retrying.\n' "$phase" >&2
  exit "$status"
}
trap finish EXIT
# A truncated transfer never reaches docker load or changes the running app.
cat > "$archive"
printf '%s  %s\n' "$archive_sum" "$archive" | sha256sum --check --status || die 'Incomplete or corrupt image transfer'
phase=load
docker image load --input "$archive" > /dev/null
export BLOTATO_IMAGE="blotato-backend:$commit"
export BLOTATO_ENV_FILE=/srv/blotato/service.env
actual_id=$(docker image inspect --format '{{.Id}}' "$BLOTATO_IMAGE")
[[ $actual_id == "$expected_id" ]] || die 'Loaded image does not match verified CI image'
[[ $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$BLOTATO_IMAGE") == linux/amd64 ]] || die 'Wrong image platform'

compose=(docker compose --project-name blotato --project-directory /srv/blotato --env-file /srv/blotato/.env.deploy -f /srv/blotato/compose.deploy.yaml -f /srv/blotato/deploy/release/compose.image.yaml)
phase=config
# Validate quietly: rendered configuration can contain service credentials.
"${compose[@]}" config --format json | python3 -c '
import json, sys
c = json.load(sys.stdin)["services"]["app"]
import os
assert c["image"] == os.environ["BLOTATO_IMAGE"] and not c.get("build"), "Unexpected image/build configuration"
assert c["platform"] == "linux/amd64", "Unexpected platform"
e = c["environment"]
assert e.get("NODE_ENV") == "production" and e.get("HOST") == "0.0.0.0" and str(e.get("PORT")) == "3000", "Unexpected service configuration"
assert e.get("ROLE") == "api", "This release target serves the API role"
assert e.get("CONSOLE_ORIGIN", "").startswith("https://"), "HTTPS public origin required"
assert c.get("healthcheck", {}).get("test"), "Health check required"
'
phase=activate
# Dependencies, credentials, TLS and migrations compatibility are operator-managed.
"${compose[@]}" up -d --no-build --pull never --no-deps app
phase=readiness
container=$("${compose[@]}" ps --all --quiet app)
[[ $container =~ ^[0-9a-f]{64}$ ]] || die 'Expected exactly one API container'
[[ $(docker inspect --format '{{.Image}}' "$container") == "$expected_id" ]] || die 'Running image differs from release'
[[ $(docker inspect --format '{{.Config.Image}}' "$container") == "$BLOTATO_IMAGE" ]] || die 'Running image tag differs from release'
ready=false
deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  state=$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
  if [[ $state == running/healthy ]] && docker exec "$container" node -e '
    const e=process.env;
    if(e.NODE_ENV!=="production"||e.HOST!=="0.0.0.0"||e.PORT!=="3000"||e.ROLE!=="api"||!e.CONSOLE_ORIGIN?.startsWith("https://")) process.exit(1);
    fetch("http://127.0.0.1:3000/ready", {signal:AbortSignal.timeout(3000)}).then(async r=>{const b=await r.json();process.exit(r.ok&&b.ok===true?0:1)}).catch(()=>process.exit(1));
  '; then
    ready=true
    break
  fi
  sleep 2
done
[[ $ready == true ]] || die 'API did not become healthy and ready within 120 seconds'
phase=complete
result=success
printf 'Verified production API release %s (%s)\n' "$commit" "$expected_id"
