# Worker upgrades

The worker can opt into Temporal Worker Deployments with `PINNED` behavior. Each workflow stays on the deployment build that first processed it. Promoting another build routes new workflows to the promoted version. Keep old workers available while pinned conversations wait for people to respond. [Temporal Worker Deployments](https://docs.temporal.io/production-deployment/worker-deployments)

## Configuration

Set both values on a worker process to opt in.

```sh
TEMPORAL_DEPLOYMENT_NAME=comment-automations
TEMPORAL_BUILD_ID=release-2026-11-08
```

`workerDeploymentOptionsFromEnv()` requires the values together and rejects empty values. With both variables absent it returns `undefined`. `startWorker` accepts the resulting `deploymentOptions` and passes them to the installed SDK's `workerDeploymentOptions`.

```ts
await startWorker({
  deps,
  connection,
  taskQueue,
  namespace,
  deploymentOptions: workerDeploymentOptionsFromEnv(),
})
```

Use an immutable build ID for each deployed artifact. Reusing an ID for changed workflow code defeats the isolation between versions. All replicas of an artifact should use the same build ID. Deployment names and task queues must match across the versions participating in an upgrade.

## Rollout

1. Start workers for the new build alongside the old workers.
2. Verify the new deployment version has registered its workflow and activity pollers.
3. Promote the new build through Temporal's deployment management API or operator tooling. Worker startup registers a version. Promotion is a separate operator action.
4. Confirm newly started workflows report the new deployment build and existing waiting runs still report the previous build.
5. Keep the old workers running until Temporal reports that their deployment version has drained and no open workflow remains pinned to it. Include workflows waiting for email or an operator decision when checking this condition.
6. To roll back routing for new runs, promote the previous build again. Review any desired migration of already pinned runs separately, with replay evidence for their histories.

The installed SDK exposes promotion through `client.workflowService.setWorkerDeploymentCurrentVersion`. Fetch `describeWorkerDeployment` first and pass its conflict token when making an operator change, so a concurrent promotion produces a conflict. Leave missing-poller safeguards enabled. API credentials and authorization are properties of the existing Temporal connection.

Pinning applies when workflows first run under a versioned worker. Existing unversioned histories need an explicit transition plan and replay verification. This repository also retains the workflow patch marker and captured-history replay test used by its current upgrade.

## Reproducible verification

```sh
npm test -- tests/unit/worker-deployment.test.ts tests/integration/worker-versioning.test.ts
```

The integration test starts its own temporary Temporal server, creates an isolated task queue and deployment name, and starts two versioned workers. It runs a workflow under v1, promotes v2, and starts another workflow. Both workflows then execute another activity. The old workflow returns `["v1", "v1"]`, the new workflow returns `["v2", "v2"]`, and the server's description of the old workflow records pinned behavior and build v1. Workflow caching is disabled during this check, so later tasks exercise server routing.

The check passed on the bundled Temporal CLI 1.10.0 with Server 1.32.2 in approximately four seconds. It contacts the temporary server and leaves the running demonstration stack untouched. It uses no application database.

Worker Deployment API support was verified on that server version. The repository's older Docker server image requires its own compatibility check before enabling these variables. A server that lacks the deployment APIs requires an upgrade or continued replay-safe unversioned operation. Versioning is opt-in and the configuration defaults leave it disabled.
