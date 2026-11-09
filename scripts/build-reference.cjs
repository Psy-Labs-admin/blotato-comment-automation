// Publish only the OpenAPI document and the assets needed to read it.
const { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { documentationAssets, documentationHtml } = require('../dist/api/documentation');

const output = path.resolve(__dirname, '../reports/reference-site');
rmSync(output, { recursive: true, force: true });
mkdirSync(path.join(output, 'assets'), { recursive: true });
for (const asset of documentationAssets) copyFileSync(asset.file, path.join(output, 'assets', asset.name));
const spec = readFileSync(path.resolve(__dirname, '../dist/api/openapi.json'));
writeFileSync(path.join(output, 'openapi.json'), spec);
writeFileSync(path.join(output, 'index.html'), documentationHtml('reference'));
writeFileSync(path.join(output, '.nojekyll'), '');
console.log('Public API reference built in reports/reference-site');
