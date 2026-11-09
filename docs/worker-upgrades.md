# Worker upgrades

Temporal Worker Deployments let a workflow stay pinned to the build that first processed it. Promoting a build routes new workflows there. Keep old workers alive while their conversations wait for replies or operator decisions.

## Configuration

Set both variables on each versioned worker.

```sh
export TEMPORAL_DEPLOYMENT_NAME=comment-automations
export TEMPORAL_BUILD_ID=release-2026-11-08
ROLE=worker npm start
```

Set both values together. Leave both unset to keep versioning off.

Use one immutable build ID per artifact and share it across that artifact's replicas. Keep deployment name and task queue consistent across upgrade versions.

## Rollout

1. Start the new workers alongside the old ones.
2. Verify the new version has registered workflow and activity pollers.
3. Promote it through Temporal's deployment management API or operator tooling. Startup only registers the version.
4. Check that new workflows use the new build and conversations already waiting for an email still run on the previous build.
5. Keep old workers until Temporal reports the version drained and no open workflow remains pinned to it. Include runs waiting for email or operator review.
6. To roll back new-run routing, promote the previous build. Moving already pinned runs needs a separate plan and replay evidence.

The installed SDK exposes `client.workflowService.setWorkerDeploymentCurrentVersion`. First fetch `describeWorkerDeployment`, then pass its conflict token when promoting so concurrent changes conflict. Leave missing-poller safeguards enabled. Use the existing Temporal connection's credentials and authorization.

Existing unversioned histories need an explicit transition plan and replay verification. The repository retains its workflow patch marker and captured-history replay test. Keep command-order changes replay-safe even when rollout routing looks healthy.

## Reproducible verification

```sh
npm test -- tests/unit/worker-deployment.test.ts tests/integration/worker-versioning.test.ts
```

The check uses a temporary Temporal server and no application database. With workflow caching disabled, it verifies that promotion routes new workflows to v2 while existing workflows stay pinned to v1.

Worker Deployment API support was verified with bundled Temporal CLI 1.10.0 and Server 1.32.2. Check compatibility on the repository's older Docker server before enabling these variables. If that server lacks the APIs, upgrade it or keep replay-safe unversioned workers.
