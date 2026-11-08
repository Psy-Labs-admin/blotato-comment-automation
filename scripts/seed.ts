import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { createAutomation, createConnection, createTenant } from '../src/storage/admin';
import { createPool } from '../src/storage/db';
import { migrate } from '../src/storage/migrate';

export const DEMO_ACCOUNT = 'ig_demo_coffee';

export const demoDefinition = {
  schemaVersion: 1,
  trigger: { type: 'comment.created', platform: 'instagram', keyword: 'pricing', match: 'whole_word_case_insensitive', posts: 'all_supported' },
  steps: [
    { id: 'public_reply', type: 'reply_comment', text: 'Sent you a DM!' },
    { id: 'ask_email', type: 'send_private_reply', text: 'What is your email address? Reply here and I’ll send you the pricing link in this chat.' },
    {
      id: 'email', type: 'await_input', validator: 'email', promptStep: 'ask_email', timeout: '72h', maxClarifications: 1,
      clarificationText: "Hmm, that doesn't look like an email address. Could you send it again?",
    },
    { id: 'send_link', type: 'send_message', text: 'Thanks! Here is our pricing: https://democoffee.example/pricing' },
  ],
};

export interface DemoIds {
  tenantId: string;
  connectionId: string;
  accountId: string;
  automationId: string;
}

/** Creates (or reuses) the demo tenant, its connected Instagram account and the pricing automation. */
export async function seed(db: Pool): Promise<DemoIds> {
  await migrate(db);
  const existing = (
    await db.query(
      `SELECT c.tenant_id, c.id AS connection_id, a.id AS automation_id FROM social_connections c
         JOIN automations a ON a.connection_id = c.id WHERE c.external_account_id = $1 LIMIT 1`,
      [DEMO_ACCOUNT],
    )
  ).rows[0];
  if (existing) {
    return { tenantId: existing.tenant_id, connectionId: existing.connection_id, accountId: DEMO_ACCOUNT, automationId: existing.automation_id };
  }
  const tenantId = await createTenant(db, 'Demo Coffee Co');
  const connectionId = await createConnection(db, { tenantId, accountId: DEMO_ACCOUNT, capabilities: { reconciliation: 'none' } });
  const { automationId } = await createAutomation(db, { tenantId, connectionId, name: 'Pricing DM', definition: demoDefinition, priority: 10, cooldownSeconds: 3600 });
  return { tenantId, connectionId, accountId: DEMO_ACCOUNT, automationId };
}

if (require.main === module) {
  const db = createPool(loadConfig().databaseUrl, 2);
  seed(db)
    .then((ids) => {
      writeFileSync(path.resolve(__dirname, '../.demo.json'), JSON.stringify(ids, null, 2));
      console.log(JSON.stringify(ids, null, 2));
    })
    .finally(() => db.end());
}
