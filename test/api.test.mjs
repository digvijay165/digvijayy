// End-to-end tests for functions/api against a local D1 database (wrangler pages dev).
// Supabase is replaced by a tiny local server: it publishes the test signing key and answers the
// "old site" REST reads used when moving a shop. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 8790, MOCK_PORT = 8791;
const API = `http://127.0.0.1:${PORT}/api`;
const SUPA = `http://127.0.0.1:${MOCK_PORT}`;
let server, mock, keys;
const oldSite = { members: [], invites: [] }; // what the fake old Supabase site returns

const b64url = b => Buffer.from(b).toString('base64url');
async function token(sub, email, { exp = 3600, iss = `${SUPA}/auth/v1`, key = keys.privateKey, kid = 'test-key' } = {}) {
  const h = b64url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify({ sub, email, role: 'authenticated', aud: 'authenticated', iss, exp: Math.floor(Date.now() / 1000) + exp }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(h + '.' + p));
  return `${h}.${p}.${b64url(sig)}`;
}
const users = {};
async function as(name) {
  if (!users[name]) users[name] = { id: crypto.randomUUID(), email: `${name}@test.example` };
  users[name].token = await token(users[name].id, users[name].email);
  return users[name];
}
async function call(u, method, path, body, bytes) {
  const headers = u ? { Authorization: 'Bearer ' + (u.token || u) } : {};
  let payload;
  if (bytes) { payload = bytes; headers['content-type'] = 'application/octet-stream' }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json' }
  const r = await fetch(`${API}/${path}`, { method, headers, body: payload });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
}
const doc = (id, collection, data, del = 0) => [id, collection, JSON.stringify({ id, ...data }), del];
async function pullAll(u, rev = 0) {
  const seen = []; let more = true, rounds = 0;
  while (more && rounds++ < 20) { const r = await call(u, 'POST', 'sync', { rev, changes: [] }); assert.equal(r.status, 200); seen.push(...r.body.rows); rev = r.body.rev; more = r.body.more }
  return { rows: seen, rev };
}

before(async () => {
  keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  mock = createServer((req, res) => {
    const url = new URL(req.url, SUPA);
    const send = v => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)) };
    if (url.pathname === '/rest/v1/members') {
      const shop = (url.searchParams.get('shop_id') || '').replace('eq.', ''), uid = (url.searchParams.get('user_id') || '').replace('eq.', '');
      return send(oldSite.members.filter(m => m.shop_id === shop && (!uid || m.user_id === uid)).map(m => ({ ...m, shops: { name: 'Old Works' } })));
    }
    if (url.pathname === '/rest/v1/invites') return send(oldSite.invites);
    res.statusCode = 404; res.end('{}');
  }).listen(MOCK_PORT);
  writeFileSync(`${ROOT}/.dev.vars`, `SUPABASE_URL=${SUPA}\nSUPABASE_ANON_KEY=test-anon\nTEST_JWKS=${JSON.stringify({ keys: [jwk] })}\n`);
  rmSync(`${ROOT}/.wrangler/state`, { recursive: true, force: true });
  execSync('npx wrangler d1 execute forgeflow --local --file=schema.sql', { cwd: ROOT, stdio: 'ignore' });
  server = spawn(`npx wrangler pages dev --port ${PORT} --ip 127.0.0.1`, { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${API}/me`); if (r.status === 401) return } catch {} await new Promise(r => setTimeout(r, 500)) }
  throw new Error('wrangler pages dev did not start');
});
after(() => {
  mock?.close();
  try { if (process.platform === 'win32') execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' }); else server.kill() } catch {}
  rmSync(`${ROOT}/.dev.vars`, { force: true });
});

test('rejects missing, forged, expired and foreign tokens', async () => {
  assert.equal((await call(null, 'GET', 'me')).status, 401);
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  assert.equal((await call(await token('u1', 'a@b.c', { key: other.privateKey }), 'GET', 'me')).status, 401, 'wrong key');
  assert.equal((await call(await token('u1', 'a@b.c', { exp: -120 }), 'GET', 'me')).status, 401, 'expired');
  assert.equal((await call(await token('u1', 'a@b.c', { iss: 'https://evil.example/auth/v1' }), 'GET', 'me')).status, 401, 'other project');
  assert.equal((await call(await token('u1', 'a@b.c', { kid: 'nope' }), 'GET', 'me')).status, 401, 'unknown key');
  assert.equal((await call(await as('nobody'), 'GET', 'nope')).status, 404);
});

test('owner creates a shop and syncs between two devices', async () => {
  const owner = await as('owner1');
  assert.equal((await call(owner, 'GET', 'me')).body.membership, null);
  const s = await call(owner, 'POST', 'shop', { name: 'Singh Works' });
  assert.equal(s.status, 200); assert.equal(s.body.role, 'owner'); assert.equal(s.body.shop.name, 'Singh Works');
  // A second create returns the same shop.
  assert.equal((await call(owner, 'POST', 'shop', { name: 'Again' })).body.shop.id, s.body.shop.id);

  const push = await call(owner, 'POST', 'sync', { rev: 0, changes: [doc('settings', 'settings', { businessName: 'Singh Works' }), doc('inv1', 'invoices', { number: 'INV-1', total: 1500 }), doc('exp1', 'expenses', { amount: 200 })] });
  assert.equal(push.status, 200); assert.deepEqual(push.body.refused, []);
  assert.equal(push.body.rows.length, 0, 'own batch is not echoed back');
  assert.ok(push.body.rev > 0);

  const other = await pullAll(owner, 0); // a second device starting from scratch
  assert.equal(other.rows.length, 3);
  assert.deepEqual(JSON.parse(other.rows.find(r => r[0] === 'inv1')[2]), { id: 'inv1', number: 'INV-1', total: 1500 });

  // Edit + delete arrive on the other device.
  await call(owner, 'POST', 'sync', { rev: push.body.rev, changes: [doc('inv1', 'invoices', { number: 'INV-1', total: 1800 }), ['exp1', 'expenses', '{}', 1]] });
  const later = await pullAll(owner, other.rev);
  assert.equal(later.rows.length, 2);
  assert.equal(JSON.parse(later.rows.find(r => r[0] === 'inv1')[2]).total, 1800);
  assert.equal(later.rows.find(r => r[0] === 'exp1')[3], 1);
});

test('staff join by invite and are limited to bills, stock, purchases and saved items', async () => {
  const owner = await as('owner2'); await call(owner, 'POST', 'shop', { name: 'Team Shop' });
  const staff = await as('staff2');
  assert.equal((await call(staff, 'POST', 'sync', { rev: 0, changes: [] })).status, 403, 'not a member yet');
  assert.equal((await call(owner, 'POST', 'invite', { email: staff.email.toUpperCase() })).status, 200);
  assert.equal((await call(owner, 'POST', 'invite', { email: staff.email })).status, 409, 'duplicate invite');
  const me = await call(staff, 'GET', 'me');
  assert.equal(me.body.membership.role, 'staff');
  assert.equal(me.body.membership.shop.name, 'Team Shop');

  const r = await call(staff, 'POST', 'sync', { rev: 0, changes: [doc('sb1', 'invoices', { n: 1 }), doc('se1', 'expenses', { n: 1 }), doc('settings', 'settings', { x: 1 }), ['sb0', 'invoices', '{}', 1]] });
  assert.deepEqual(r.body.refused.sort(), ['sb0', 'se1', 'settings']);
  const seen = await pullAll(owner, 0);
  assert.deepEqual(seen.rows.map(x => x[0]), ['sb1']);

  assert.equal((await call(staff, 'GET', 'team')).status, 403);
  assert.equal((await call(staff, 'POST', 'invite', { email: 'x@y.z' })).status, 403);
  const team = await call(owner, 'GET', 'team');
  assert.equal(team.body.members.length, 2);
  assert.equal((await call(owner, 'POST', 'member-remove', { user_id: owner.id })).status, 400, 'cannot remove self');
  assert.equal((await call(owner, 'POST', 'member-remove', { user_id: staff.id })).status, 200);
  assert.equal((await call(staff, 'POST', 'sync', { rev: 0, changes: [] })).status, 403, 'removed staff lose access');
});

test('shops cannot see each other', async () => {
  const a = await as('ownerA'); await call(a, 'POST', 'shop', { name: 'A' });
  const b = await as('ownerB'); await call(b, 'POST', 'shop', { name: 'B' });
  await call(a, 'POST', 'sync', { rev: 0, changes: [doc('secretA', 'invoices', { v: 1 })] });
  await call(b, 'POST', 'sync', { rev: 0, changes: [doc('secretB', 'invoices', { v: 1 })] });
  assert.deepEqual((await pullAll(b, 0)).rows.map(r => r[0]), ['secretB']);
  assert.deepEqual((await call(b, 'POST', 'docs', { ids: ['secretA', 'secretB'] })).body.rows.map(r => r[0]), ['secretB']);
});

test('many devices syncing at once never lose a change', async () => {
  const o = await as('ownerC'); await call(o, 'POST', 'shop', { name: 'Busy' });
  const results = await Promise.all(Array.from({ length: 12 }, (_, d) => call(o, 'POST', 'sync', { rev: 0, changes: Array.from({ length: 20 }, (_, i) => doc(`d${d}-${i}`, 'invoices', { d, i })) })));
  results.forEach(r => assert.equal(r.status, 200));
  const all = await pullAll(o, 0);
  assert.equal(all.rows.length, 240);
  assert.equal(new Set(all.rows.map(r => r[0])).size, 240);
  // Each batch got its own rev.
  assert.equal(new Set(all.rows.map(r => r[4])).size, 12);
});

test('large catch-up is paged without skipping or repeating', async () => {
  const o = await as('ownerD'); await call(o, 'POST', 'shop', { name: 'Big' });
  for (let b = 0; b < 4; b++) {
    const r = await call(o, 'POST', 'sync', { rev: 0, changes: Array.from({ length: 300 }, (_, i) => doc(`b${b}-${i}`, 'invoices', { b, i })) });
    assert.equal(r.status, 200);
  }
  const first = await call(o, 'POST', 'sync', { rev: 0, changes: [] });
  assert.equal(first.body.more, true);
  assert.ok(first.body.rows.length <= 500);
  const all = await pullAll(o, 0);
  assert.equal(all.rows.length, 1200);
  assert.equal(new Set(all.rows.map(r => r[0])).size, 1200);
});

test('price lists upload in chunks, download intact, and only the owner can change them', async () => {
  const o = await as('ownerE'); await call(o, 'POST', 'shop', { name: 'Parts' });
  const staff = await as('staffE'); await call(o, 'POST', 'invite', { email: staff.email }); await call(staff, 'GET', 'me');
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const v = crypto.randomUUID();
  assert.equal((await call(staff, 'PUT', `list-chunk?list=mrp&version=${v}&n=0`, undefined, bytes)).status, 403);
  assert.equal((await call(o, 'PUT', `list-chunk?list=mrp&version=${v}&n=0`, undefined, bytes.slice(0, 40000))).status, 200);
  assert.equal((await call(o, 'POST', 'list-commit', { list_id: 'mrp', version: v, name: 'MRP', parts: 10, chunks: 2 })).status, 409, 'missing chunk');
  assert.equal((await call(o, 'PUT', `list-chunk?list=mrp&version=${v}&n=1`, undefined, bytes.slice(40000))).status, 200);
  assert.equal((await call(o, 'POST', 'list-commit', { list_id: 'mrp', version: v, name: 'MRP', parts: 10, chunks: 2 })).status, 200);
  const lists = await call(staff, 'GET', 'lists');
  assert.deepEqual(lists.body.lists, [{ list_id: 'mrp', version: v, name: 'MRP', parts: 10, chunks: 2 }]);
  const got = Buffer.concat([(await call(staff, 'GET', `list-chunk?version=${v}&n=0`)).body, (await call(staff, 'GET', `list-chunk?version=${v}&n=1`)).body]);
  assert.ok(Buffer.from(bytes).equals(got));
  assert.deepEqual((await call(staff, 'POST', 'sync', { rev: 0, changes: [] })).body.lists, [['mrp', v, 'MRP']]);
  // Another shop cannot read it.
  const x = await as('ownerX'); await call(x, 'POST', 'shop', { name: 'X' });
  assert.equal((await call(x, 'GET', `list-chunk?version=${v}&n=0`)).status, 404);
  assert.equal((await call(o, 'POST', 'list-rename', { list_id: 'mrp', name: 'Bosch MRP' })).status, 200);
  assert.equal((await call(o, 'GET', 'lists')).body.lists[0].name, 'Bosch MRP');
  assert.equal((await call(staff, 'POST', 'list-delete', { list_id: 'mrp' })).status, 403);
  assert.equal((await call(o, 'POST', 'list-delete', { list_id: 'mrp' })).status, 200);
  assert.deepEqual((await call(o, 'GET', 'lists')).body.lists, []);
  assert.equal((await call(o, 'GET', `list-chunk?version=${v}&n=0`)).status, 404);
  const tooBig = new Uint8Array(1_950_000);
  assert.equal((await call(o, 'PUT', `list-chunk?list=mrp&version=${crypto.randomUUID()}&n=0`, undefined, tooBig)).status, 413);
});

test('an owner moves a shop from the old site with its team', async () => {
  const owner = await as('oldOwner'), staff = await as('oldStaff'), stranger = await as('stranger');
  const shopId = crypto.randomUUID();
  oldSite.members = [{ shop_id: shopId, user_id: owner.id, email: owner.email, role: 'owner' }, { shop_id: shopId, user_id: staff.id, email: staff.email, role: 'staff' }];
  oldSite.invites = [{ email: 'later@test.example' }];
  assert.equal((await call(staff, 'POST', 'import-shop', { shop_id: shopId })).status, 403, 'staff cannot move it');
  assert.equal((await call(stranger, 'POST', 'import-shop', { shop_id: shopId })).status, 403, 'strangers cannot move it');
  const r = await call(owner, 'POST', 'import-shop', { shop_id: shopId });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { shop: { id: shopId, name: 'Old Works' }, role: 'owner' });
  assert.equal((await call(staff, 'GET', 'me')).body.membership.role, 'staff', 'staff come along');
  const team = await call(owner, 'GET', 'team');
  assert.deepEqual(team.body.invites, [{ email: 'later@test.example' }]);
  const again = await as('oldOwner2'); oldSite.members.push({ shop_id: shopId, user_id: again.id, email: again.email, role: 'owner' });
  assert.equal((await call(again, 'POST', 'import-shop', { shop_id: shopId })).status, 409, 'cannot be moved twice');
});
