# Worker upgrades

Temporal Worker Deployments pin workflows to their first processing build. Promotion routes new workflows to the current build. If v1 is waiting for an email when v2 arrives, keep v1 workers available.

## Configuration

Build the application and supply its [service settings](operations.md#deploying). Set both variables or leave both unset to disable versioning. Partial or empty values fail startup.

```sh
export TEMPORAL_DEPLOYMENT_NAME=comment-automations
export TEMPORAL_BUILD_ID="$(git rev-parse HEAD)"
ROLE=worker npm start
```

Use one immutable build ID per artifact across replicas. The example assumes checkout and artifact match. Keep deployment name and task queue consistent across versions.

## Rollout

1. Start new workers alongside old ones and confirm workflow and activity pollers registered. Startup registers without promoting.
2. Promote through Temporal's API or operator tooling.
3. Confirm new workflows use the new build and waiting conversations remain pinned.
4. Retain old workers until Temporal reports the version drained and no open runs remain pinned, including email and operator waits.
5. Roll back new-run routing by promoting the previous build. Moving pinned runs requires a separate plan and replay evidence.

Fetch `describeWorkerDeployment`, then pass its conflict token to `client.workflowService.setWorkerDeploymentCurrentVersion`. Keep missing-poller safeguards enabled. Use the connection's existing credentials and authorization.

Unversioned histories need an explicit transition plan. Preserve workflow patch markers and replay captured histories after command-order changes.

## Reproducible verification

Install dependencies with Node.js 24+ and run the focused checks.

```sh
npm test -- tests/unit/worker-deployment.test.ts tests/integration/worker-versioning.test.ts
```

A temporary Temporal server, without an application database or workflow caching, verifies v2 routing and v1 pinning. Replay tests cover history compatibility separately.

APIs were verified with bundled CLI 1.10.0 and Server 1.32.2. Check compatibility with Docker's Server 1.27.2 before enabling versioning. Upgrade if needed or keep replay-safe unversioned workers.
