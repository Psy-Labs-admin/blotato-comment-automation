const { cpSync, mkdirSync, rmSync, statSync } = require('node:fs');
const { resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const output = resolve(__dirname, '../dist');
rmSync(output, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
});
const source = resolve(__dirname, '../src/ui');
const target = resolve(output, 'ui');
mkdirSync(target, { recursive: true });
cpSync(source, target, {
  recursive: true,
  filter: (name) => statSync(name).isDirectory() || /\.(html|css|js|woff2|svg|png|webp|txt)$/.test(name),
});
