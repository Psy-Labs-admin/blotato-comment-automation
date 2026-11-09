import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import specification from './openapi.json';

const distribution = path.dirname(require.resolve('swagger-ui-dist/package.json'));
const localAssets = path.join(__dirname, '../ui/api-docs');
export const documentationAssets = [
  { name: 'swagger-ui-bundle.js', file: path.join(distribution, 'swagger-ui-bundle.js'), type: 'text/javascript' },
  { name: 'swagger-ui.css', file: path.join(distribution, 'swagger-ui.css'), type: 'text/css' },
  {
    name: 'swagger-ui-bundle.js.LICENSE.txt',
    file: path.join(distribution, 'swagger-ui-bundle.js.LICENSE.txt'),
    type: 'text/plain',
  },
  { name: 'LICENSE', file: path.join(distribution, 'LICENSE'), type: 'text/plain' },
  { name: 'NOTICE', file: path.join(distribution, 'NOTICE'), type: 'text/plain' },
  { name: 'init.js', file: path.join(localAssets, 'init.js'), type: 'text/javascript' },
  { name: 'reference.css', file: path.join(localAssets, 'reference.css'), type: 'text/css' },
];

export const docsPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

export function documentationHtml(mode: 'workspace' | 'reference'): string {
  const publicReference = mode === 'reference';
  const spec = publicReference ? './openapi.json' : '/openapi.json';
  return `<!doctype html>
<html lang="en" data-mode="${mode}" data-spec="${spec}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${docsPolicy}">
<title>Integration API · Blotato</title>
<link rel="stylesheet" href="./assets/swagger-ui.css">
<link rel="stylesheet" href="./assets/reference.css">
<script defer src="./assets/swagger-ui-bundle.js"></script><script defer src="./assets/init.js"></script>
</head>
<body>
<header class="api-header">
<a class="api-brand" href="${publicReference ? 'https://github.com/Psy-Labs-admin/blotato-comment-automation' : '/console'}">Blotato</a>
<nav aria-label="Documentation"><a href="https://github.com/Psy-Labs-admin/blotato-comment-automation/blob/main/docs/integration.md">Integration guide</a><a href="${spec}">OpenAPI JSON</a></nav>
</header>
<main><div class="api-instructions">${
    publicReference
      ? 'Browse the endpoints here. To try a request with your own data, open /docs/ on your running workspace.'
      : 'Choose Authorize and paste your workspace key. Try it out calls this workspace, so any edits you make here will be saved.'
  }</div>
<div id="swagger-ui"></div></main>
</body></html>`;
}

export function registerDocumentation(app: FastifyInstance): void {
  app.get('/openapi.json', async () => specification);
  app.get('/docs', async (_req, reply) => reply.redirect('/docs/'));
  app.get('/docs/', async (_req, reply) =>
    reply
      .header('Content-Security-Policy', docsPolicy + "; frame-ancestors 'none'")
      .type('text/html; charset=utf-8')
      .send(documentationHtml('workspace')),
  );
  for (const asset of documentationAssets) {
    app.get('/docs/assets/' + asset.name, async (_req, reply) =>
      reply.type(asset.type).send(createReadStream(asset.file)),
    );
  }
}
