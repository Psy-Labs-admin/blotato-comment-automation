import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";
import { DEFAULT_CAPABILITIES } from "../helpers/account";
import { createConnection } from "../helpers/account";
import { commentEvent, createAutomation } from "../helpers/fixtures";
import { ingestEvent } from "../../src/ingest/ingest";
import { routeEvent } from "../../src/ingest/router";
import { systemClock } from "../../src/domain/clock";
import { finalizeRun } from "../../src/activities/runs";
import { integrationHandlers } from "../../src/relay/integrations";
import { OutboxRelay } from "../../src/relay/relay";

// Every fixture belongs to a fresh test_* database. No production service or Meta request is used.
test("first use saves a real draft across reload on desktop and mobile", async ({
  page,
  workspace,
}, info) => {
  await workspace.signIn(page);
  await expect(
    page.getByRole("heading", { name: "Create your first automation" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("first-use-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Create automation", exact: true }),
  ).toBeInViewport();
  await expect(
    page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).resolves.toBe(true);
  await page.screenshot({
    path: info.outputPath("first-use-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create automation", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Comment follow-up");
  await page.getByLabel("Keyword or phrase").fill("information");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/operator/automations",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  expect((await saved).status()).toBe(201);
  await expect(page.getByText("Draft saved.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Comment follow-up",
  );
  await expect(page.getByLabel("Keyword or phrase")).toHaveValue("information");
  await expect(
    page.getByRole("button", { name: "Publish automation", exact: true }),
  ).toBeDisabled();
  expect(
    (
      await workspace.data.db.query(
        "SELECT count(*)::int AS n FROM automation_drafts",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await workspace.data.db.query(
        "SELECT count(*)::int AS n FROM automation_runs",
      )
    ).rows[0].n,
  ).toBe(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
});

test("native disconnect requires confirmation and preserves gateway accounts", async ({
  page,
  workspace,
}) => {
  const { db } = workspace.data;
  const native = (
    await db.query(
      `INSERT INTO social_connections
    (tenant_id,platform,external_account_id,display_name,status,verified_at,capabilities,integration_kind)
    VALUES ($1,'instagram','browser-native','Native account','active',now(),$2,'native') RETURNING id`,
      [workspace.tenantId, DEFAULT_CAPABILITIES],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO social_connections
    (tenant_id,platform,external_account_id,display_name,status,verified_at,capabilities,integration_kind)
    VALUES ($1,'instagram','browser-gateway','Gateway account','active',now(),$2,'gateway')`,
    [workspace.tenantId, DEFAULT_CAPABILITIES],
  );
  await db.query(
    `INSERT INTO instagram_credentials(connection_id,tenant_id,encrypted_token,expires_at,refresh_after,granted_scopes)
    VALUES ($1,$2,'test-only-placeholder',now()+interval '1 day',now()+interval '12 hours','{}')`,
    [native, workspace.tenantId],
  );
  await workspace.signIn(page, "#accounts");
  const nativeRow = page.locator(".account-row").filter({
    has: page.locator(".account-name", { hasText: "Native account" }),
  });
  const gatewayRow = page.locator(".account-row").filter({
    has: page.locator(".account-name", { hasText: "Gateway account" }),
  });
  await expect(
    gatewayRow.getByRole("button", { name: /Disconnect|Reconnect/ }),
  ).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Native account");
    await dialog.dismiss();
  });
  await nativeRow
    .getByRole("button", { name: "Disconnect Native account", exact: true })
    .click();
  expect(
    (
      await db.query("SELECT status FROM social_connections WHERE id=$1", [
        native,
      ])
    ).rows[0].status,
  ).toBe("active");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("New automated messages");
    await dialog.accept();
  });
  await nativeRow
    .getByRole("button", { name: "Disconnect Native account", exact: true })
    .click();
  await expect(
    page.getByText(
      "Native account disconnected. New automated messages have stopped.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    nativeRow.getByRole("button", {
      name: "Reconnect Native account",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (
      await db.query(
        "SELECT encrypted_token,token_version FROM instagram_credentials WHERE connection_id=$1",
        [native],
      )
    ).rows[0],
  ).toEqual({ encrypted_token: "", token_version: 2 });
});

test("operations shows honest empty state and disabled notification configuration", async ({
  page,
  workspace,
}, info) => {
  await workspace.signIn(page, "#operations");
  await expect(
    page.getByRole("heading", { name: "No open incidents" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Processing is running" }),
  ).toBeVisible();
  await page.getByText("Processing details", { exact: true }).click();
  await expect(page.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Retry delivery/ }),
  ).toHaveCount(0);
  await page.getByText("Processing details", { exact: true }).click();
  await page.screenshot({
    path: info.outputPath("operations-empty-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).resolves.toBe(true);
  await page.screenshot({
    path: info.outputPath("operations-empty-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Incident history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No resolved incidents" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delivery queue", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No failed deliveries" }),
  ).toBeVisible();
  await page.getByLabel("Show", { exact: true }).selectOption("pending");
  await expect(
    page.getByRole("heading", { name: "No waiting deliveries" }),
  ).toBeVisible();
});

test("operator reviews a CRM incident retries its delivery and sees factual recovery", async ({
  page,
  workspace,
}, info) => {
  const { db } = workspace.data;
  const connectionId = await createConnection(db, {
    tenantId: workspace.tenantId,
    accountId: "browser-crm",
  });
  await db.query(
    "UPDATE social_connections SET integration_kind='gateway',verified_at=now(),display_name='CRM fixture account' WHERE id=$1",
    [connectionId],
  );
  await createAutomation(db, { tenantId: workspace.tenantId, connectionId });
  const stored = await ingestEvent(
    { db, clock: systemClock },
    commentEvent({ accountId: "browser-crm", from: "browser-person" }),
  );
  if (stored.status !== "accepted")
    throw new Error("Test event was not accepted");
  const decision = await routeEvent({ db, clock: systemClock }, stored.eventId);
  if (!decision.runId) throw new Error("Test run was not created");
  await finalizeRun(
    { db, clock: systemClock },
    {
      runId: decision.runId,
      outcome: "failed",
      reason: "test-only-crm-outage",
    },
  );
  const lead = (
    await db.query(
      `INSERT INTO leads (tenant_id,connection_id,conversation_id,participant_id,run_id,source_event_id,email,crm_status)
    SELECT tenant_id,$2,conversation_id,'browser-person',id,trigger_event_id,'browser@example.org','failed'
    FROM automation_runs WHERE id=$1 RETURNING id`,
      [decision.runId, connectionId],
    )
  ).rows[0].id;
  const delivery = (
    await db.query(
      `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status,attempts,done_at)
    VALUES ($1,'crm.lead_captured',$2,$3,'dead',3,now()) RETURNING id::text`,
      [workspace.tenantId, "lead:" + lead, { leadId: lead }],
    )
  ).rows[0].id;
  const incident = (
    await db.query(
      `INSERT INTO incidents(tenant_id,connection_id,error_class,affected_runs,occurrences,first_seen_at,last_seen_at)
    VALUES ($1,$2,'crm_delivery_failing',$3,3,now()-interval '10 minutes',now()-interval '2 minutes') RETURNING id`,
      [workspace.tenantId, connectionId, [decision.runId]],
    )
  ).rows[0].id;
  await workspace.signIn(page, "#operations");
  await page.screenshot({
    path: info.outputPath("operations-active-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).resolves.toBe(true);
  await page.screenshot({
    path: info.outputPath("operations-active-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: /CRM delivery needs attention/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "CRM delivery needs attention" }),
  ).toBeVisible();
  await expect(
    page.getByText("The incident was recorded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The most recent occurrence was recorded.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review failed deliveries", exact: true })
    .click();
  await expect(page.getByLabel("Integration", { exact: true })).toHaveValue(
    "crm.lead_captured",
  );
  await page
    .getByRole("button", { name: "Retry CRM sync", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    (await db.query("SELECT status FROM outbox WHERE id=$1", [delivery]))
      .rows[0].status,
  ).toBe("dead");
  await page
    .getByRole("button", { name: "Retry CRM sync", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry delivery", exact: true })
    .click();
  await expect(
    page.getByLabel("Reason for retry", { exact: true }),
  ).toBeFocused();
  await page
    .getByLabel("Reason for retry", { exact: true })
    .fill("The CRM connection has been restored.");
  await db.query(
    "UPDATE outbox SET retry_generation=retry_generation+1 WHERE id=$1",
    [delivery],
  );
  await page
    .getByRole("button", { name: "Retry delivery", exact: true })
    .click();
  await expect(
    page.getByText(
      "This delivery changed. Close this dialog and refresh the queue before retrying.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    (await db.query("SELECT status FROM outbox WHERE id=$1", [delivery]))
      .rows[0].status,
  ).toBe("dead");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Retry CRM sync", exact: true })
    .click();
  await page
    .getByLabel("Reason for retry", { exact: true })
    .fill("The CRM connection has been restored.");
  await page.screenshot({
    path: info.outputPath("operations-retry-desktop.png"),
  });
  await page
    .getByRole("button", { name: "Retry delivery", exact: true })
    .click();
  await expect(
    page.getByText("CRM sync returned to the delivery queue.", {
      exact: true,
    }),
  ).toBeVisible();
  const pending = (
    await db.query(
      "SELECT status,retry_generation::text FROM outbox WHERE id=$1",
      [delivery],
    )
  ).rows[0];
  expect(pending).toEqual({ status: "pending", retry_generation: "2" });
  const retried = (
    await db.query(
      "SELECT data FROM run_audit_events WHERE type='delivery.retry_requested'",
    )
  ).rows[0].data;
  expect(retried.note).toBe("The CRM connection has been restored.");
  const crm = new Map<string, unknown>();
  const relay = new OutboxRelay({
    db,
    kinds: ["crm.lead_captured"],
    handlers: integrationHandlers({
      db,
      crm: {
        upsertLead: async (body, key) => {
          crm.set(key, body);
        },
      },
    }),
  });
  await relay.drainOnce();
  expect(crm.size).toBe(1);
  expect(
    (await db.query("SELECT status FROM incidents WHERE id=$1", [incident]))
      .rows[0].status,
  ).toBe("resolved");
  await page
    .getByRole("button", { name: "Incident history", exact: true })
    .click();
  await page
    .getByRole("button", { name: /CRM delivery needs attention/ })
    .click();
  await expect(
    page.getByText("The underlying incident condition cleared.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Resolved", { exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).resolves.toBe(true);
  await page.screenshot({
    path: info.outputPath("operations-recovered-mobile.png"),
    fullPage: true,
  });
});

test("incident and delivery filters paginate without losing earlier rows", async ({
  page,
  workspace,
}) => {
  const { db } = workspace.data;
  for (let index = 0; index < 21; index++) {
    const account = (
      await db.query(
        `INSERT INTO social_connections(tenant_id,platform,external_account_id)
      VALUES ($1,'instagram',$2) RETURNING id`,
        [workspace.tenantId, "pagination-" + index],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO incidents(tenant_id,connection_id,error_class,first_seen_at,last_seen_at)
      VALUES ($1,$2,'connection_unauthorized',now()-make_interval(secs=>$3),now())`,
      [workspace.tenantId, account, index],
    );
    await db.query(
      `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status,attempts)
      VALUES ($1,'metadata.hydrate',$2,$3,'dead',3)`,
      [
        workspace.tenantId,
        "pagination-" + randomUUID(),
        { eventId: randomUUID() },
      ],
    );
  }
  await workspace.signIn(page, "#operations");
  await expect(page.locator(".incident-row")).toHaveCount(20);
  await page
    .getByRole("button", { name: "Load earlier incidents", exact: true })
    .click();
  await expect(page.locator(".incident-row")).toHaveCount(21);
  await expect(
    page.getByRole("button", { name: "Load earlier incidents", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Incident history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No resolved incidents" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delivery queue", exact: true })
    .click();
  await expect(page.locator(".delivery-row")).toHaveCount(20);
  await page
    .getByRole("button", { name: "Load earlier deliveries", exact: true })
    .click();
  await expect(page.locator(".delivery-row")).toHaveCount(21);
  await page
    .getByLabel("Integration", { exact: true })
    .selectOption("crm.lead_captured");
  await expect(
    page.getByRole("heading", { name: "No failed deliveries" }),
  ).toBeVisible();
});

test.describe("notification diagnostics", () => {
  test.use({ alertsConfigured: true });

  test("shows recorded Telegram rejection and subsequent acceptance without sending messages", async ({
    page,
    workspace,
  }) => {
    const { db } = workspace.data;
    const incident = (
      await db.query(
        "INSERT INTO incidents(tenant_id,error_class) VALUES ($1,'outbox_dead_letter') RETURNING id",
        [workspace.tenantId],
      )
    ).rows[0].id;
    const row = (
      await db.query(
        `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status,attempts)
      VALUES ($1,'alert.notify',$2,$3,'dead',1) RETURNING id`,
        [
          workspace.tenantId,
          "telegram-fixture-" + randomUUID(),
          { incidentId: incident, kind: "opened" },
        ],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO alert_deliveries(outbox_id,tenant_id,incident_id,channel,channel_key,status,attempts,last_error_code)
      VALUES($1,$2,$3,'telegram',$4,'permanent',1,'telegram_token_rejected')`,
      [row, workspace.tenantId, incident, workspace.alertDestinationKey],
    );
    await workspace.signIn(page, "#operations");
    await page.getByText("Processing details", { exact: true }).click();
    await expect(page.getByText("Telegram", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Replace the Telegram bot token in the deployment settings.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Delivery stopped and needs attention", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Delivery queue", exact: true })
      .click();
    await page
      .getByLabel("Integration", { exact: true })
      .selectOption("alert.notify");
    await expect(page.locator(".delivery-row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Retry / })).toHaveCount(0);
    await db.query(
      "UPDATE alert_deliveries SET status='accepted',accepted_at=now(),last_attempt_at=now(),last_error_code=NULL WHERE outbox_id=$1",
      [row],
    );
    await db.query(
      "UPDATE outbox SET status='done',done_at=now() WHERE id=$1",
      [row],
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText("Processing details", { exact: true }).click();
    await expect(
      page.getByText("Last accepted", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Replace the Telegram bot token in the deployment settings.",
        { exact: true },
      ),
    ).toHaveCount(0);
  });
});

test.describe("processing health", () => {
  test.use({ processingConfigured: true });

  test("detects a missing CRM consumer while worker and relay loops remain healthy", async ({
    page,
    workspace,
  }, info) => {
    const { db } = workspace.data;
    await db.query(
      `INSERT INTO service_heartbeats(instance_id,role,temporal_namespace,task_queue,state,started_at,observed_at,capabilities)
      VALUES($1,'worker','default','comment-automations','ready',now(),now(),'{}')`,
      [randomUUID()],
    );
    await page.clock.install();
    await db.query(
      `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status,attempts)
      VALUES($1,'alert.notify',$2,'{}','dead',1),($1,'alert.notify',$3,'{}','pending',0)`,
      [workspace.tenantId, randomUUID(), randomUUID()],
    );
    await workspace.signIn(page, "#operations");
    await expect(
      page.getByRole("heading", { name: "Processing is running" }),
    ).toBeVisible();
    await db.query(
      "UPDATE service_heartbeats SET capabilities=array_remove(capabilities,'crm') WHERE role='relay'",
    );
    await page.clock.fastForward(15_000);
    await expect(
      page.getByText("New operational activity is available.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Refresh operations", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Processing needs attention" }),
    ).toBeVisible();
    await page.getByText("Processing details", { exact: true }).click();
    const crm = page
      .locator(".operation-queue-row")
      .filter({ hasText: "Send lead to CRM" });
    await expect(crm).toContainText("Sender unavailable");
    await expect(crm).not.toContainText("Queue clear");
    const unconfigured = page
      .locator(".operation-queue-row")
      .filter({ hasText: "Send operational notification" });
    await expect(unconfigured).toContainText("Not configured");
    await expect(unconfigured).toContainText("1 failed delivery");
    await expect(unconfigured).toContainText("1 delivery waiting");
    expect(
      (await db.query("SELECT state FROM service_heartbeats")).rows.every(
        (row) => row.state === "ready",
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("operations-unavailable-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).resolves.toBe(true);
    await page.screenshot({
      path: info.outputPath("operations-unavailable-mobile.png"),
      fullPage: true,
    });
    await db.query(
      "UPDATE service_heartbeats SET capabilities=array_append(capabilities,'crm') WHERE role='relay'",
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Processing is running" }),
    ).toBeVisible();
  });
});

test("operations detects a new incident while the operator keeps the page open", async ({
  page,
  workspace,
}) => {
  await page.clock.install();
  await workspace.signIn(page, "#operations");
  await expect(
    page.getByRole("heading", { name: "No open incidents" }),
  ).toBeVisible();
  await workspace.data.db.query(
    "INSERT INTO incidents(tenant_id,error_class) VALUES($1,'outbox_dead_letter')",
    [workspace.tenantId],
  );
  await page.clock.fastForward(15_000);
  await expect(
    page.getByText("New operational activity is available.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No open incidents" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh operations", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Background delivery stopped/ }),
  ).toBeVisible();
  await expect(page.locator("#operations-updates")).toBeHidden();
});

test("one-time sign-in consumes the ticket removes the fragment and handles invalid links", async ({
  page,
  workspace,
  coverage,
}) => {
  const minted = await workspace.app.inject({
    method: "POST",
    url: "/session/tickets",
    headers: { authorization: "Bearer " + workspace.token },
  });
  expect(minted.statusCode).toBe(200);
  const ticket = minted.json().ticket;
  let release: (() => void) | undefined;
  const exchangeAllowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let exchanges = 0;
  await page.route("**/session/exchange", async (route) => {
    exchanges++;
    await exchangeAllowed;
    await route.continue();
  });
  await page.goto(workspace.origin + "/session/enter#ticket=" + ticket, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveURL(workspace.origin + "/session/enter");
  await coverage();
  release!();
  await expect(page).toHaveURL(workspace.origin + "/console");
  await expect(
    page.getByRole("heading", { name: "Create your first automation" }),
  ).toBeVisible();
  const failure =
    "This sign-in link has expired. Open a new link or sign in with your access token.";
  await page.context().clearCookies();
  for (const fragment of [
    "#ticket=" + ticket,
    "#ticket=" + "f".repeat(64),
    "",
  ]) {
    const before = exchanges;
    await page.goto(workspace.origin + "/session/enter" + fragment);
    await expect(page.getByText(failure, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(workspace.origin + "/session/enter");
    expect(exchanges).toBe(before + (fragment ? 1 : 0));
  }
  await coverage();
  await page.getByRole("link", { name: "Go to sign in", exact: true }).click();
  await expect(page.getByLabel("Access key", { exact: true })).toBeVisible();
});
