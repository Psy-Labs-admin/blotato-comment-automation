import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerConsole } from '../../src/ui';

describe('operator console public shell', () => {
  it('serves only a static shell with a restrictive policy and no cached customer data', async () => {
    const app = Fastify();
    registerConsole(app);
    try {
      const page = await app.inject('/console');
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.headers['content-security-policy']).toContain("script-src 'self'");
      expect(page.body).toContain('aria-labelledby="resolve-title"');
      for (const [path, type] of [['/console.js', 'text/javascript'], ['/console.css', 'text/css']]) {
        const asset = await app.inject(path);
        expect(asset.statusCode).toBe(200);
        expect(asset.headers['content-type']).toContain(type);
        expect(asset.headers['x-content-type-options']).toBe('nosniff');
      }
    } finally {
      await app.close();
    }
  });
});
