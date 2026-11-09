# Deploy a backend build

Open [Verify and stage backend](https://github.com/Psy-Labs-admin/blotato-comment-automation/actions/workflows/checks.yml) and pick a green push to `main`. The run summary shows the commit, Docker image ID and what happened when two requests tried to create the same draft. The runner starts the packaged API and Postgres, restarts the API, and checks the saved result. It also runs the production activation script on a disposable Linux host. Both installations disappear at the end of the job.

## Try a deployment from GitHub

1. Copy the run ID from the URL. It’s the number after `/actions/runs/`.
2. Open [Deploy backend](https://github.com/Psy-Labs-admin/blotato-comment-automation/actions/workflows/deploy.yml), click **Run workflow** and choose **main**.
3. Pick **rehearsal**, paste the run ID and start it. GitHub loads the same image on a clean runner, checks its identity, runs the host activation and probes the API. You can do this in your own fork with Actions enabled and a successful push to its `main`.

The artifact is called `backend-<commit>` and stays available for 14 days. Both deployment targets accept successful push runs from this repo’s verification workflow. You can browse published results without repo access. Running a workflow requires write access.

## Connect a production host once

The **production** target updates the API on a Linux/amd64 host. The operator supplies DNS, HTTPS, PostgreSQL and any workers and relays. The API applies migrations at startup.

- Use Docker Engine, Compose 2.24.4+, Bash, Python 3, `flock` and `sha256sum`. Give a dedicated nonroot SSH account named `blotato-deploy` access to Docker on this host.
- Under `/srv/blotato`, install [compose.deploy.yaml](../compose.deploy.yaml), [the Caddyfile](../deploy/Caddyfile), [the image override](../deploy/release/compose.image.yaml) and [the executable release script](../deploy/release/production.sh) at their repository paths. Keep those files operator-owned. Give the deploy account write access to a private `releases/` directory for temporary transfers and history.
- Put the service credentials and `ROLE=api` in `/srv/blotato/service.env`. Put `PUBLIC_HOST` in `/srv/blotato/.env.deploy`. Restrict access to both files. Start PostgreSQL and any workers first. On a fresh host, start the proxy on its own with the command below so it can serve the API as soon as activation finishes. An existing setup must use the Compose project name `blotato`. [Service settings](operations.md#deploying)

```sh
cd /srv/blotato
BLOTATO_ENV_FILE=/srv/blotato/service.env docker compose --env-file .env.deploy -f compose.deploy.yaml up -d --no-deps https
```

- In **Settings → Environments**, restrict the **production** environment to the `main` branch. Add its secrets `PRODUCTION_HOST`, `PRODUCTION_SSH_KEY` and `PRODUCTION_KNOWN_HOSTS`. Use port 22 and verify the host key fingerprint through the server console. Set the environment variable `PRODUCTION_PUBLIC_HOST` to the API’s public DNS name for the final HTTPS readiness check.
- Docker control grants host-level privileges. In `blotato-deploy`’s `authorized_keys`, prefix the dedicated public key with `restrict,command="/srv/blotato/deploy/release/production.sh"` and a space. That key can now request one operation, `activate`, with three validated identifiers. Add a reviewer if your team uses release approvals.

## Promote or roll back

Choose **production** in the same workflow. GitHub checks the archive and image ID, then streams the archive over SSH. The host serializes deploys and checks the whole transfer before loading it. It starts the API, verifies the running image and waits for Docker health and `/ready`. GitHub then checks `/ready` over public HTTPS. The run summary records the actual candidate commit, image ID and source build. This matters when you deploy an older build from the current workflow.

If the transfer breaks, the old API keeps serving. If activation starts and readiness fails, inspect the container and `/srv/blotato/releases/history.log`. The candidate may already be running. To restore a compatible older image, select its successful run ID and promote it again. Database migrations and messages already sent survive an image rollback. Check schema compatibility and backups before rolling back.
