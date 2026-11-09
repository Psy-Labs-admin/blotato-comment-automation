#!/usr/bin/env bash
# Destructive fixture setup is restricted to a clean GitHub-hosted Linux runner.
set -Eeuo pipefail
umask 077
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux ]] || die 'Use an ephemeral GitHub-hosted Linux runner'
[[ $# == 2 ]] || die 'Expected archive directory and full commit'
release=$(realpath -- "$1")
commit=$2
[[ $commit =~ ^[0-9a-f]{40}$ ]] || die 'Expected a full verified commit'
[[ ! -e /srv/blotato && ! -L /srv/blotato ]] || die 'Refusing an existing deployment directory'
! getent passwd blotato-deploy > /dev/null || die 'Refusing an existing deployment account'
[[ -z $(docker ps -aq --filter label=com.docker.compose.project=blotato) ]] || die 'Refusing an existing Compose project'
[[ -z $(docker volume ls -q --filter label=com.docker.compose.project=blotato) ]] || die 'Refusing existing project volumes'
for volume in blotato_certificates blotato_caddy_config; do
  ! docker volume inspect "$volume" > /dev/null 2>&1 || die 'Refusing existing named volumes'
done
! docker network inspect blotato_default > /dev/null 2>&1 || die 'Refusing an existing project network'
! docker container inspect blotato-activation-postgres > /dev/null 2>&1 || die 'Refusing an existing fixture database'

image="blotato-backend:$commit"
[[ -f $release/image.tar.gz && -f $release/image.id && -f $release/SHA256SUMS ]] || die 'Verified release directory is missing'
(cd "$release" && sha256sum --check --strict SHA256SUMS)
image_id=$(cat "$release/image.id")
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]] || die 'Invalid image identity'
[[ $(docker image inspect --format '{{.Id}}' "$image") == "$image_id" ]] || die 'Loaded image differs from verified release'
archive_sum=$(sha256sum "$release/image.tar.gz" | cut -d ' ' -f1)
scratch=$(mktemp -d)
created_user=false
created_directory=false
created_database=false
compose=(sudo -u blotato-deploy env "BLOTATO_IMAGE=$image" BLOTATO_ENV_FILE=/srv/blotato/service.env docker compose --project-name blotato --project-directory /srv/blotato --env-file /srv/blotato/.env.deploy -f /srv/blotato/compose.deploy.yaml -f /srv/blotato/deploy/release/compose.image.yaml)
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ $created_database == true ]]; then docker rm -f -v blotato-activation-postgres > /dev/null; fi
  if [[ $created_directory == true ]]; then
    "${compose[@]}" down --volumes --timeout 10
    sudo rm -rf -- /srv/blotato
  fi
  if [[ $created_user == true ]]; then sudo userdel blotato-deploy; fi
  rm -rf -- "$scratch"
  exit "$status"
}
trap cleanup EXIT

sudo useradd --system --user-group --no-create-home --groups docker blotato-deploy
created_user=true
created_directory=true
sudo install -d -m 755 /srv/blotato /srv/blotato/deploy /srv/blotato/deploy/release
sudo install -m 644 compose.deploy.yaml /srv/blotato/compose.deploy.yaml
sudo install -m 644 deploy/Caddyfile /srv/blotato/deploy/Caddyfile
sudo install -m 644 deploy/release/compose.image.yaml /srv/blotato/deploy/release/compose.image.yaml
sudo install -m 755 deploy/release/production.sh /srv/blotato/deploy/release/production.sh
sudo install -d -o blotato-deploy -g blotato-deploy -m 700 /srv/blotato/releases
printf 'PUBLIC_HOST=activation.example.invalid\n' > "$scratch/.env.deploy"
sudo install -m 600 -o blotato-deploy -g blotato-deploy "$scratch/.env.deploy" /srv/blotato/.env.deploy
sudo install -m 600 -o blotato-deploy -g blotato-deploy /dev/null /srv/blotato/service.env
# Creating (without starting) app establishes the real Compose network and labels.
"${compose[@]}" create --no-build app
password=$(openssl rand -hex 32)
created_database=true
docker run -d --name blotato-activation-postgres --network blotato_default --network-alias activation-postgres \
  -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=activation postgres:16-alpine > /dev/null
database_ready=false
for ((attempt=0; attempt<45; attempt++)); do
  if docker exec blotato-activation-postgres pg_isready -h 127.0.0.1 -U postgres -d activation > /dev/null 2>&1; then database_ready=true; break; fi
  sleep 2
done
[[ $database_ready == true ]] || die 'Fixture database did not become ready'
mkdir "$scratch/bootstrap"
bootstrap=(docker run --rm --user "$(id -u):$(id -g)" --network blotato_default --mount "type=bind,src=$scratch/bootstrap,dst=/activation" -e BLOTATO_LOCAL_DIR=/activation)
"${bootstrap[@]}" -e "DATABASE_URL=postgres://postgres:$password@activation-postgres:5432/activation" "$image" node scripts/admin.cjs init 'Host activation fixture'
sudo install -m 600 -o blotato-deploy -g blotato-deploy "$scratch/bootstrap/operator/service.env" /srv/blotato/service.env
key=$("${bootstrap[@]}" "$image" node scripts/api-key.cjs create 'Host activation fixture')
echo "::add-mask::$key"

if sudo -u blotato-deploy env SSH_ORIGINAL_COMMAND='uname -a' /srv/blotato/deploy/release/production.sh </dev/null; then
  die 'Forced command accepted an unrelated SSH request'
fi
activate=(sudo -u blotato-deploy env "SSH_ORIGINAL_COMMAND=activate $commit $image_id $archive_sum" /srv/blotato/deploy/release/production.sh)
"${activate[@]}" < "$release/image.tar.gz"
container=$("${compose[@]}" ps --quiet app)
[[ $container =~ ^[0-9a-f]{64}$ ]] || die 'Expected one activated API container'
docker exec -e "ACTIVATION_API_KEY=$key" "$container" node -e '
  fetch("http://127.0.0.1:3000/api/v1/drafts", {headers:{Authorization:"Bearer "+process.env.ACTIVATION_API_KEY},signal:AbortSignal.timeout(5000)})
    .then(async r=>{const b=await r.json();if(!r.ok||!Array.isArray(b.drafts)||b.drafts.length!==0)process.exit(1)})
    .catch(()=>process.exit(1));
'
# Replay must reconcile without replacing a healthy identical container.
"${activate[@]}" < "$release/image.tar.gz"
[[ $("${compose[@]}" ps --quiet app) == "$container" ]] || die 'Same-image replay unexpectedly replaced the API'
# A truncated stream must fail before docker load/up and preserve the active app.
head -c 32 "$release/image.tar.gz" > "$scratch/truncated.gz"
if "${activate[@]}" < "$scratch/truncated.gz"; then die 'Truncated archive was accepted'; fi
[[ $("${compose[@]}" ps --quiet app) == "$container" ]] || die 'Rejected transfer changed the running API'
[[ $(docker inspect --format '{{.State.Status}}/{{.State.Health.Status}}' "$container") == running/healthy ]] || die 'API lost health after rejected transfer'
[[ $(sudo grep -c 'result=success phase=complete' /srv/blotato/releases/history.log) == 2 ]] || die 'Missing successful activation history'
sudo grep -q 'result=failed phase=transfer' /srv/blotato/releases/history.log || die 'Missing rejected transfer history'
printf '%s\n' 'Production activation script passed: real PostgreSQL/API, exact image, same-image replay and rejected truncated transfer.'
