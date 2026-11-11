// ForgeFlow API on Cloudflare Pages Functions + D1.
// Login stays with Supabase Auth: every request carries the Supabase access token, which is checked here
// against Supabase's public signing keys (no secret needed). Shop data lives in the D1 database "DB".
//
// The free plan allows 100,000 requests a day and 50 queries per request, so each endpoint does a fixed,
// small number of queries, and one /sync request both sends and receives changes.

const STAFF_COLLECTIONS = ['catalog', 'invoices', 'stock', 'purchases'];
const ALL_COLLECTIONS = ['settings', ...STAFF_COLLECTIONS, 'expenses'];
const PULL_LIMIT = 500;
const MAX_PUSH = 300;
const MAX_CHUNK_BYTES = 1_900_000; // D1 rows are limited to 2 MB.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status } }
const fail = (status, message) => { throw new HttpError(status, message) };
const now = () => Date.now();

// ---- Supabase token check (ES256 / RS256 keys from the project's JWKS)
let jwksCache = { at: 0, keys: [] };
const b64urlBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
async function jwks(env) {
  if (env.TEST_JWKS) return JSON.parse(env.TEST_JWKS).keys; // local tests only; never set in production
  if (now() - jwksCache.at < 600_000 && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`, { cf: { cacheTtl: 600 } });
  if (!r.ok) fail(503, 'Could not load login keys');
  jwksCache = { at: now(), keys: (await r.json()).keys || [] };
  return jwksCache.keys;
}
async function verifyToken(env, token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) fail(401, 'Not signed in');
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1]))) } catch { fail(401, 'Bad login token') }
  let keys = await jwks(env);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk && !env.TEST_JWKS) { jwksCache.at = 0; keys = await jwks(env); jwk = keys.find(k => k.kid === header.kid) } // keys were rotated
  if (!jwk) fail(401, 'Unknown login key');
  const algo = header.alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } : header.alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : fail(401, 'Unsupported login token');
  const key = await crypto.subtle.importKey('jwk', jwk, algo, false, ['verify']);
  const ok = await crypto.subtle.verify(algo, key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) fail(401, 'Bad login token');
  const t = Math.floor(now() / 1000);
  if (!payload.exp || payload.exp < t - 30) fail(401, 'Login expired');
  if (payload.iss !== `${env.SUPABASE_URL}/auth/v1`) fail(401, 'Login from another project');
  if (payload.role !== 'authenticated' || !payload.sub) fail(401, 'Not signed in');
  return { id: payload.sub, email: String(payload.email || '').toLowerCase(), token };
}

// ---- Membership
async function membership(env, user) {
  return env.DB.prepare('select m.shop_id, m.role, s.name from members m join shops s on s.id = m.shop_id where m.user_id = ? limit 1').bind(user.id).first();
}
async function requireMember(env, user, ownerOnly = false) {
  const m = await membership(env, user);
  if (!m) fail(403, 'You are not part of a shop');
  if (ownerOnly && m.role !== 'owner') fail(403, 'Only the shop owner can do this');
  return m;
}
const shopOut = m => m ? { shop: { id: m.shop_id, name: m.name }, role: m.role } : null;

// ---- Endpoints
const routes = {
  // Who am I? Claims a pending staff invite on the way.
  async 'GET me'(env, user) {
    let m = await membership(env, user);
    if (!m && user.email) {
      const inv = await env.DB.prepare('select shop_id, role from invites where email = ? order by created_at limit 1').bind(user.email).first();
      if (inv) {
        await env.DB.batch([
          env.DB.prepare('insert or ignore into members (shop_id, user_id, email, role, created_at) values (?, ?, ?, ?, ?)').bind(inv.shop_id, user.id, user.email, inv.role, now()),
          env.DB.prepare('delete from invites where shop_id = ? and email = ?').bind(inv.shop_id, user.email),
        ]);
        m = await membership(env, user);
      }
    }
    return { user: { id: user.id, email: user.email }, membership: shopOut(m) };
  },

  // First sign-in of an owner: create the shop.
  async 'POST shop'(env, user, body) {
    const m = await membership(env, user);
    if (m) return shopOut(m);
    const id = crypto.randomUUID(), name = String(body.name || '').trim().slice(0, 120) || 'My workshop', t = now();
    await env.DB.batch([
      env.DB.prepare('insert into shops (id, name, created_by, created_at) values (?, ?, ?, ?)').bind(id, name, user.id, t),
      env.DB.prepare('insert into members (shop_id, user_id, email, role, created_at) values (?, ?, ?, ?, ?)').bind(id, user.id, user.email, 'owner', t),
    ]);
    return shopOut(await membership(env, user));
  },

  // Bring a shop over from the old Supabase site. The caller must be its owner there (checked with their own token).
  async 'POST import-shop'(env, user, body) {
    const existing = await membership(env, user);
    if (existing) return shopOut(existing);
    const shopId = String(body.shop_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(shopId)) fail(400, 'Bad shop id');
    const rest = async path => {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + user.token } });
      if (!r.ok) fail(502, 'Could not read the old shop');
      return r.json();
    };
    const mine = await rest(`members?select=role,shops(name)&shop_id=eq.${shopId}&user_id=eq.${user.id}`);
    if (mine[0]?.role !== 'owner') fail(403, 'Only the owner can move a shop');
    const already = await env.DB.prepare('select id from shops where id = ?').bind(shopId).first();
    if (already) fail(409, 'This shop was already moved. Ask its owner to invite you.');
    const [members, invites] = await Promise.all([rest(`members?select=user_id,email,role&shop_id=eq.${shopId}`), rest(`invites?select=email&shop_id=eq.${shopId}`)]);
    const t = now();
    const stmts = [env.DB.prepare('insert into shops (id, name, created_by, created_at) values (?, ?, ?, ?)').bind(shopId, String(mine[0].shops?.name || 'My workshop'), user.id, t)];
    for (const x of members.slice(0, 40)) stmts.push(env.DB.prepare('insert or ignore into members (shop_id, user_id, email, role, created_at) values (?, ?, ?, ?, ?)').bind(shopId, x.user_id, String(x.email || '').toLowerCase(), x.role === 'owner' ? 'owner' : 'staff', t));
    for (const x of invites.slice(0, 40 - Math.min(members.length, 40))) stmts.push(env.DB.prepare('insert or ignore into invites (shop_id, email, role, created_at) values (?, ?, ?, ?)').bind(shopId, String(x.email).toLowerCase(), 'staff', t));
    await env.DB.batch(stmts);
    return shopOut(await membership(env, user));
  },

  // Send this device's changes and receive everyone else's, in one request.
  // body: { rev: last rev this device has, changes: [[id, collection, dataJson, deleted]] }
  async 'POST sync'(env, user, body) {
    const m = await requireMember(env, user);
    const since = Math.max(0, Number(body.rev) || 0);
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_PUSH) : [];
    const byId = new Map(), refused = [];
    for (const c of changes) {
      if (!Array.isArray(c) || typeof c[0] !== 'string' || !c[0] || c[0].length > 200 || !ALL_COLLECTIONS.includes(c[1]) || typeof c[2] !== 'string') { if (typeof c?.[0] === 'string') refused.push(c[0]); continue }
      const del = c[3] ? 1 : 0;
      if (m.role !== 'owner' && (!STAFF_COLLECTIONS.includes(c[1]) || del)) { refused.push(c[0]); continue }
      byId.set(c[0], [c[0], c[1], del ? '{}' : c[2], del]); // the last change to a record wins
    }
    let myRev = 0;
    if (byId.size) {
      // One statement writes the whole batch. The rev subquery runs once, under D1's write lock, so every row of
      // this batch gets the same new rev and no other request can be given it.
      const r = await env.DB.prepare(`insert into docs (shop_id, id, collection, data, deleted, rev, updated_at, updated_by)
          select ?1, j.value ->> 0, j.value ->> 1, j.value ->> 2, j.value ->> 3,
                 (select coalesce(max(rev), 0) + 1 from docs where shop_id = ?1), ?2, ?3
          from json_each(?4) j where true
          on conflict (shop_id, id) do update set collection = excluded.collection, data = excluded.data,
            deleted = excluded.deleted, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by
          returning rev`)
        .bind(m.shop_id, now(), user.id, JSON.stringify([...byId.values()])).all();
      myRev = r.results[0]?.rev || 0;
    }
    // Everything newer than what this device has, except the batch it just sent.
    const [pulled, lists] = await env.DB.batch([
      env.DB.prepare('select id, collection, data, deleted, rev from docs where shop_id = ? and rev > ? and rev <> ? order by rev limit ?').bind(m.shop_id, since, myRev, PULL_LIMIT),
      env.DB.prepare('select list_id, version, name from price_lists where shop_id = ? order by updated_at').bind(m.shop_id),
    ]);
    let rows = pulled.results;
    const more = rows.length === PULL_LIMIT;
    // A batch shares one rev, so never stop in the middle of one (a batch is at most MAX_PUSH < PULL_LIMIT rows).
    if (more) { const last = rows[rows.length - 1].rev; rows = rows.filter(r => r.rev !== last) }
    const top = rows.length ? rows[rows.length - 1].rev : since;
    return {
      role: m.role, shop: { id: m.shop_id, name: m.name }, refused, more,
      // The device may jump to myRev only when it has nothing older left to fetch.
      rev: more ? top : Math.max(top, myRev),
      rows: rows.map(r => [r.id, r.collection, r.data, r.deleted, r.rev]),
      lists: lists.results.map(l => [l.list_id, l.version, l.name]),
    };
  },

  // Re-read specific records (after the server refused a change).
  async 'POST docs'(env, user, body) {
    const m = await requireMember(env, user);
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter(x => typeof x === 'string').slice(0, 300);
    const r = await env.DB.prepare('select d.id, d.collection, d.data, d.deleted, d.rev from docs d join json_each(?2) j on j.value = d.id where d.shop_id = ?1').bind(m.shop_id, JSON.stringify(ids)).all();
    return { rows: r.results.map(x => [x.id, x.collection, x.data, x.deleted, x.rev]) };
  },

  // ---- Team (owner only)
  async 'GET team'(env, user) {
    const m = await requireMember(env, user, true);
    const [a, b] = await env.DB.batch([
      env.DB.prepare('select user_id, email, role from members where shop_id = ? order by created_at').bind(m.shop_id),
      env.DB.prepare('select email from invites where shop_id = ? order by created_at').bind(m.shop_id),
    ]);
    return { members: a.results, invites: b.results };
  },
  async 'POST invite'(env, user, body) {
    const m = await requireMember(env, user, true);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) fail(400, 'Enter a valid email address');
    const taken = await env.DB.prepare('select 1 from members where shop_id = ? and email = ?').bind(m.shop_id, email).first();
    if (taken) fail(409, 'Already in your team');
    const r = await env.DB.prepare('insert or ignore into invites (shop_id, email, role, created_at) values (?, ?, ?, ?)').bind(m.shop_id, email, 'staff', now()).run();
    if (!r.meta.changes) fail(409, 'Already invited');
    return { ok: true };
  },
  async 'POST invite-cancel'(env, user, body) {
    const m = await requireMember(env, user, true);
    await env.DB.prepare('delete from invites where shop_id = ? and email = ?').bind(m.shop_id, String(body.email || '').toLowerCase()).run();
    return { ok: true };
  },
  async 'POST member-remove'(env, user, body) {
    const m = await requireMember(env, user, true);
    if (body.user_id === user.id) fail(400, 'You cannot remove yourself');
    await env.DB.prepare("delete from members where shop_id = ? and user_id = ? and role = 'staff'").bind(m.shop_id, String(body.user_id || '')).run();
    return { ok: true };
  },

  // ---- Price lists. Stored as gzip bytes cut into chunks; the browser compresses and decompresses.
  async 'GET lists'(env, user) {
    const m = await requireMember(env, user);
    const r = await env.DB.prepare('select list_id, version, name, parts, chunks from price_lists where shop_id = ? order by updated_at').bind(m.shop_id).all();
    return { lists: r.results };
  },
  async 'PUT list-chunk'(env, user, body, url, request) {
    const m = await requireMember(env, user, true);
    const list = url.searchParams.get('list') || '', version = url.searchParams.get('version') || '', n = Number(url.searchParams.get('n'));
    if (!list || list.length > 100 || !/^[\w-]{8,64}$/.test(version) || !Number.isInteger(n) || n < 0 || n > 500) fail(400, 'Bad chunk');
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_CHUNK_BYTES) fail(413, 'Chunk too large');
    await env.DB.prepare('insert or replace into price_list_chunks (shop_id, list_id, version, n, data) values (?, ?, ?, ?, ?)').bind(m.shop_id, list, version, n, bytes).run();
    return { ok: true };
  },
  async 'POST list-commit'(env, user, body) {
    const m = await requireMember(env, user, true);
    const list = String(body.list_id || ''), version = String(body.version || ''), chunks = Number(body.chunks), parts = Number(body.parts);
    if (!list || !version || !Number.isInteger(chunks) || chunks < 1 || !Number.isInteger(parts) || parts < 0) fail(400, 'Bad list');
    const have = await env.DB.prepare('select count(*) as n from price_list_chunks where shop_id = ? and version = ?').bind(m.shop_id, version).first();
    if (have.n !== chunks) fail(409, 'Upload incomplete');
    await env.DB.batch([
      env.DB.prepare(`insert into price_lists (shop_id, list_id, version, name, parts, chunks, updated_at) values (?, ?, ?, ?, ?, ?, ?)
        on conflict (shop_id, list_id) do update set version = excluded.version, name = excluded.name, parts = excluded.parts, chunks = excluded.chunks, updated_at = excluded.updated_at`)
        .bind(m.shop_id, list, version, String(body.name || 'Price list').slice(0, 120), parts, chunks, now()),
      env.DB.prepare('delete from price_list_chunks where shop_id = ? and list_id = ? and version <> ?').bind(m.shop_id, list, version),
    ]);
    return { ok: true };
  },
  async 'POST list-rename'(env, user, body) {
    const m = await requireMember(env, user, true);
    await env.DB.prepare('update price_lists set name = ? where shop_id = ? and list_id = ?').bind(String(body.name || '').slice(0, 120), m.shop_id, String(body.list_id || '')).run();
    return { ok: true };
  },
  async 'POST list-delete'(env, user, body) {
    const m = await requireMember(env, user, true);
    const list = String(body.list_id || '');
    await env.DB.batch([
      env.DB.prepare('delete from price_lists where shop_id = ? and list_id = ?').bind(m.shop_id, list),
      env.DB.prepare('delete from price_list_chunks where shop_id = ? and list_id = ?').bind(m.shop_id, list),
    ]);
    return { ok: true };
  },
  async 'GET list-chunk'(env, user, body, url) {
    const m = await requireMember(env, user);
    const r = await env.DB.prepare('select data from price_list_chunks where shop_id = ? and version = ? and n = ?').bind(m.shop_id, url.searchParams.get('version') || '', Number(url.searchParams.get('n'))).first();
    if (!r) fail(404, 'Chunk not found');
    // D1 hands BLOBs back as an array of byte values.
    return new Response(r.data instanceof ArrayBuffer ? r.data : new Uint8Array(r.data), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } });
  },
};

export async function onRequest({ request, env, params }) {
  try {
    const url = new URL(request.url);
    const name = [].concat(params.path || []).join('/');
    const handler = routes[`${request.method} ${name}`];
    if (!handler) return json({ error: 'Not found' }, 404);
    const auth = request.headers.get('authorization') || '';
    const user = await verifyToken(env, auth.startsWith('Bearer ') ? auth.slice(7) : '');
    let body = {};
    if (request.method === 'POST') { try { body = await request.json() } catch { fail(400, 'Bad request') } }
    const out = await handler(env, user, body, url, request);
    return out instanceof Response ? out : json(out);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
}
