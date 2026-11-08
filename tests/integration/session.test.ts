import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb } from '../helpers/db';
import { createTestAccess } from '../helpers/test-access';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';

let data: Awaited<ReturnType<typeof createTestDb>>;
let app: FastifyInstance;
const credentials = createTestAccess();
let authorization: string;

beforeAll(async () => {
  data = await createTestDb();
  const tenant = (await data.db.query("INSERT INTO tenants(name) VALUES ('Session test') RETURNING id")).rows[0].id;
  authorization = credentials.operatorHeaders(tenant).authorization;
  app = buildServer({db:data.db, clock:systemClock, access:credentials.access, logger:false});
});
afterAll(async () => { await app?.close(); await data?.drop(); });

it('authenticates a real workspace and requires session-bound CSRF for changes and logout', async () => {
  const token = authorization.slice(7);
  expect((await app.inject({url:'/workspace'})).statusCode).toBe(401);
  const hostile = await app.inject({method:'POST',url:'/session',headers:{origin:'https://elsewhere.example'},payload:{token}});
  expect(hostile.statusCode).toBe(403);
  const login = await app.inject({method:'POST',url:'/session',payload:{token}});
  expect(login.statusCode).toBe(200);
  expect(login.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict');
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const workspace = await app.inject({url:'/workspace',headers:{cookie}});
  expect(workspace.json().name).toBe('Session test');
  const route = '/operator/automations';
  expect((await app.inject({method:'POST',url:route,headers:{cookie},payload:{name:'Rule'}})).statusCode).toBe(403);
  const headers = {cookie,'x-csrf-token':workspace.json().csrfToken};
  expect((await app.inject({method:'POST',url:route,headers:{...headers,origin:'https://elsewhere.example'},payload:{name:'Rule'}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:route,headers,payload:{name:'Rule'}})).statusCode).toBe(201);
  expect((await app.inject({method:'DELETE',url:'/session',headers})).statusCode).toBe(204);
  expect((await app.inject({url:'/workspace',headers:{cookie}})).statusCode).toBe(401);
});

it('exchanges a short-lived sign-in ticket exactly once under concurrent requests', async () => {
  expect((await app.inject({method:'POST',url:'/session/tickets'})).statusCode).toBe(401);
  const issued = await app.inject({method:'POST',url:'/session/tickets',headers:{authorization}});
  const redeem = () => app.inject({method:'POST',url:'/session/exchange',payload:{ticket:issued.json().ticket}});
  const results = await Promise.all([redeem(),redeem()]);
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,401]);
});
