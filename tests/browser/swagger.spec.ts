import { test, expect } from './fixtures';
import { createIntegrationKey } from '../helpers/integration-key';

test('Swagger authorizes a real workspace call, keeps the key in memory and loads only local assets', async ({
  page,
  workspace,
}) => {
  const { token } = await createIntegrationKey(workspace.data.db, workspace.tenantId, 'Swagger browser check');
  const externalRequests: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== workspace.origin)
      externalRequests.push(url.origin);
  });
  await page.goto(workspace.origin + '/docs');
  await expect(page).toHaveURL(workspace.origin + '/docs/');
  await expect(page.getByRole('heading', { name: /Blotato Automation API/ })).toBeVisible();
  await page.getByRole('button', { name: 'Authorize', exact: true }).click();
  const modal = page.locator('.dialog-ux');
  await modal.locator('input').fill(token);
  await modal.getByRole('button', { name: 'Apply credentials', exact: true }).click();
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
  const operation = page.locator('#operations-Workspace-getWorkspace');
  await operation.locator('.opblock-summary-control').click();
  await operation.getByRole('button', { name: 'Try it out', exact: true }).click();
  const response = page.waitForResponse((res) => res.url() === workspace.origin + '/api/v1/workspace');
  await operation.getByRole('button', { name: 'Execute', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(operation.locator('.live-responses-table')).toContainText(workspace.tenantId);
  await page.reload();
  await page.getByRole('button', { name: 'Authorize', exact: true }).click();
  await expect(modal.locator('input')).toHaveValue('');
  expect(externalRequests).toEqual([]);
});
