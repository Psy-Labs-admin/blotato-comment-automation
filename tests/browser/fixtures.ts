import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/api/server";
import { systemClock } from "../../src/domain/clock";
import { createTenant } from "../../src/storage/admin";
import { createTestDb } from "../helpers/db";
import { createTestAccess } from "../helpers/test-access";
import { DEFAULT_CAPABILITIES } from "../helpers/account";
import { startServiceHeartbeat } from "../../src/observability/heartbeat";
import { OutboxRelay } from "../../src/relay/relay";
import { telegramChannelKey } from "../../src/adapters/alerts";
import type { InstagramConfig } from "../../src/instagram/config";

interface Workspace {
  app: FastifyInstance;
  data: Awaited<ReturnType<typeof createTestDb>>;
  tenantId: string;
  token: string;
  origin: string;
  instagram: InstagramConfig;
  alertDestinationKey: string;
  signIn(page: Page, route?: string): Promise<void>;
}

async function captureBrowserCoverage(page: Page, title: string) {
  const scripts = (await page.coverage.stopJSCoverage())
    .filter((entry) => {
      try {
        return ["/console.js", "/session/enter.js", "/docs/assets/init.js"].includes(
          new URL(entry.url).pathname,
        );
      } catch {
        return false;
      }
    })
    .map((entry) => ({
      url: new URL(entry.url).pathname,
      source: entry.source,
      functions: entry.functions,
    }));
  const directory = path.resolve("reports/browser-v8");
  await mkdir(directory, { recursive: true });
  const filename =
    title.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 90) +
    "-" +
    randomUUID() +
    ".json";
  await writeFile(path.join(directory, filename), JSON.stringify(scripts));
}

export const test = base.extend<{
  workspace: Workspace;
  coverage: () => Promise<void>;
  alertsConfigured: boolean;
  processingConfigured: boolean;
}>({
  alertsConfigured: [false, { option: true }],
  processingConfigured: [false, { option: true }],
  workspace: async ({ alertsConfigured, processingConfigured }, use) => {
    const data = await createTestDb();
    const access = createTestAccess();
    const tenantId = await createTenant(data.db, "Browser verification");
    const token = access.operatorHeaders(tenantId).authorization.slice(7);
    const instagram: InstagramConfig = {
      appId: "123456789012345",
      appSecret: "test-only-instagram-secret",
      webhookAppSecret: "test-only-webhook-secret",
      webhookVerifyToken: "test-only-webhook-verification",
      redirectUri: "https://operator.example/integrations/instagram/callback",
      encryptionKey: randomBytes(32),
      graphVersion: "v24.0",
      capabilities: { ...DEFAULT_CAPABILITIES, reconciliation: "none" },
    };
    const alertDestinationKey = telegramChannelKey(
      "isolated-browser-bot:fake-token",
      "isolated-browser-chat",
    );
    const app = buildServer({
      db: data.db,
      access: access.access,
      clock: systemClock,
      logger: false,
      nativeInstagram: instagram,
      dispatchConfigured: processingConfigured,
      operations: {
        destinations: {
          crm: true,
          metadata: true,
          alerts: alertsConfigured,
          alertChannel: alertsConfigured ? "telegram" : null,
          alertDestinationKey: alertsConfigured ? alertDestinationKey : null,
        },
      },
    });
    // An actual isolated relay completes a database work cycle before its heartbeat.
    // Slow polling leaves each test in control of when its test transport delivers work.
    let relayHealthy = false;
    let firstCycle!: () => void;
    const observedCycle = new Promise<void>((resolve) => {
      firstCycle = resolve;
    });
    const relay = new OutboxRelay({
      db: data.db,
      kinds: [
        "crm.lead_captured",
        "metadata.hydrate",
        ...(alertsConfigured ? ["alert.notify" as const] : []),
      ],
      handlers: {
        "crm.lead_captured": async () => {},
        "metadata.hydrate": async () => {},
        "alert.notify": async () => {},
      },
      pollMs: 60_000,
      onCycle(error) {
        relayHealthy = !error;
        firstCycle();
      },
    });
    relay.start();
    await observedCycle;
    const heartbeat = await startServiceHeartbeat({
      db: data.db,
      role: "relay",
      namespace: "default",
      taskQueue: "comment-automations",
      capabilities: [
        "crm",
        "metadata",
        ...(processingConfigured ? ["dispatch"] : []),
        ...(alertsConfigured
          ? ["alerts", "alert.telegram:" + alertDestinationKey]
          : []),
      ],
      probe: async () => relayHealthy,
      intervalMs: 60_000,
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      const origin = "http://127.0.0.1:" + address.port;
      await use({
        app,
        data,
        tenantId,
        token,
        origin,
        instagram,
        alertDestinationKey,
        async signIn(page, route = "#automations") {
          await page.goto(origin + "/console" + route);
          await page.getByLabel("Access key", { exact: true }).fill(token);
          await page
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await page.locator("#navigation").waitFor({ state: "visible" });
          await expect(page.locator("#content .loading")).toHaveCount(0);
        },
      });
    } finally {
      await heartbeat.stop();
      await relay.stop();
      app.server.closeAllConnections();
      await app.close();
      await data.drop();
    }
  },
  coverage: [
    async ({ page }, use, info) => {
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        reportAnonymousScripts: false,
      });
      // Chromium can discard unloaded documents. Take a checkpoint on short-lived pages.
      await use(async () => {
        await captureBrowserCoverage(page, info.title);
        await page.coverage.startJSCoverage({
          resetOnNavigation: false,
          reportAnonymousScripts: false,
        });
      });
      await captureBrowserCoverage(page, info.title);
    },
    { auto: true },
  ],
});

export { expect };
