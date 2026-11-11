// ForgeFlow cloud: Supabase login + Cloudflare (Pages Functions + D1) for shop data, staff roles and sync.
// The app keeps working offline from a local copy; changes are sent when the internet is back.
// Cloudflare's free plan allows 100,000 requests a day, so one /api/sync request both sends and receives
// changes, and devices only sync while the app is on screen.
(() => {
  const cfg = window.FORGEFLOW_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase?.createClient);
  const API = (cfg.apiBase || '/api').replace(/\/$/, '');
  const COLLECTIONS = ['catalog', 'invoices', 'stock', 'purchases', 'expenses'];
  const LAST = 'forgeflow_cloud_last';
  const BATCH = 250, EVERY = 180000;
  let FF, sb, user, shop, role, timer;
  let meta = { synced: {}, rev: 0, listSig: null };
  let syncing = false, syncAgain = false, lastSync = 0, state = 'idle', lastError = '';

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const metaKey = () => 'forgeflow_meta_' + shop.id;
  const dataKey = () => 'forgeflow_shop_' + shop.id;
  const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortKeys(v[k]), o), {}) : v;
  const hash = v => JSON.stringify(sortKeys(v));
  function saveMeta() { try { localStorage.setItem(metaKey(), JSON.stringify(meta)) } catch {} }
  function loadMeta() { try { meta = { synced: {}, rev: 0, listSig: null, ...JSON.parse(localStorage.getItem(metaKey()) || '{}') } } catch { meta = { synced: {}, rev: 0, listSig: null } } }
  const isNetwork = e => !e?.status && /fetch|network|load failed|offline/i.test(String(e?.message || e));

  // ---- Talking to the API with the Supabase login token
  async function api(method, path, body, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: { session } } = await sb.auth.getSession();
      const headers = { Authorization: 'Bearer ' + (session?.access_token || '') };
      let payload;
      if (opts.bytes) { payload = opts.bytes; headers['content-type'] = 'application/octet-stream' }
      else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json' }
      const r = await fetch(API + '/' + path, { method, headers, body: payload });
      if (r.status === 401 && attempt === 0) { await sb.auth.refreshSession().catch(() => {}); continue }
      if (opts.raw && r.ok) return r;
      let out = {}; try { out = await r.json() } catch {}
      if (!r.ok) { const e = new Error(out.error || (r.status === 429 || r.status >= 500 ? 'The server is busy — try again shortly' : 'Request failed')); e.status = r.status; throw e }
      return out;
    }
  }

  // Every record becomes one row in the "docs" table, keyed by its id.
  function docsOf(db) {
    const out = new Map();
    out.set('settings', { collection: 'settings', data: db.settings });
    for (const c of COLLECTIONS) for (const d of db[c] || []) if (d && d.id) out.set(d.id, { collection: c, data: d });
    return out;
  }
  function pendingCount() {
    if (!shop) return 0;
    const cur = docsOf(FF.db); let n = 0;
    for (const [id, d] of cur) if (meta.synced[id]?.h !== hash(d.data)) n++;
    for (const id of Object.keys(meta.synced)) if (!cur.has(id)) n++;
    return n;
  }

  // ---- Send local changes and receive everyone else's, in as few requests as possible
  async function sync() {
    if (!shop || !navigator.onLine) return status();
    if (syncing) { syncAgain = true; return }
    syncing = true; state = 'syncing'; status(); lastSync = Date.now();
    try {
      for (let round = 0; round < 80; round++) {
        const cur = docsOf(FF.db), changes = [], sent = [];
        for (const [id, d] of cur) {
          if (changes.length >= BATCH) break;
          const h = hash(d.data);
          if (meta.synced[id]?.h !== h) { changes.push([id, d.collection, JSON.stringify(d.data), 0]); sent.push({ id, h, c: d.collection }) }
        }
        for (const [id, s] of Object.entries(meta.synced)) {
          if (changes.length >= BATCH) break;
          if (!cur.has(id)) { changes.push([id, s.c, '{}', 1]); sent.push({ id, h: null, c: s.c }) }
        }
        const res = await api('POST', 'sync', { rev: meta.rev, changes });
        const refused = new Set(res.refused || []);
        for (const s of sent) if (!refused.has(s.id)) { if (s.h === null) delete meta.synced[s.id]; else meta.synced[s.id] = { h: s.h, c: s.c } }
        apply(res.rows.map(r => ({ id: r[0], collection: r[1], data: JSON.parse(r[2]), deleted: !!r[3] })));
        meta.rev = res.rev; saveMeta();
        if (res.role && res.role !== role) { role = res.role; FF.setRole(role) }
        if (refused.size) { FF.toast('Some changes were not allowed for your account and were undone.'); await refetch([...refused]) }
        const sig = JSON.stringify(res.lists || []);
        if (sig !== meta.listSig) syncPriceList();
        if (!res.more && changes.length < BATCH) break;
      }
      state = 'idle'; lastError = '';
    } catch (e) {
      state = 'error'; lastError = isNetwork(e) ? 'Could not reach the server' : e.message;
      if (e.status === 403) removedFromShop();
    }
    syncing = false; status();
    if (syncAgain) { syncAgain = false; sync() }
  }
  async function refetch(ids) {
    const { rows } = await api('POST', 'docs', { ids });
    const got = new Set(rows.map(r => r[0]));
    // A refused new record never reached the server: drop it locally.
    const missing = ids.filter(id => !got.has(id)).map(id => ({ id, collection: meta.synced[id]?.c || findCollection(id), deleted: true, data: {} }));
    missing.forEach(m => delete meta.synced[m.id]);
    apply([...rows.map(r => ({ id: r[0], collection: r[1], data: JSON.parse(r[2]), deleted: !!r[3] })), ...missing], true);
  }
  function findCollection(id) { for (const c of COLLECTIONS) if ((FF.db[c] || []).some(d => d.id === id)) return c; return '' }
  function removedFromShop() {
    try { [dataKey(), metaKey(), LAST].forEach(k => localStorage.removeItem(k)) } catch {}
    shop = null; clearInterval(timer);
    screen('signin', 'You are no longer part of this shop. Ask the owner to invite you again.');
  }

  // Server rows win unless this device has an unsent edit of the same record.
  function apply(rows, force = false) {
    if (!rows.length) return;
    const db = structuredClone(FF.db); const cur = docsOf(db); let changed = false;
    for (const r of rows) {
      const local = cur.get(r.id);
      const localPending = local && meta.synced[r.id]?.h !== hash(local.data);
      if (localPending && !force) continue;
      const h = hash(r.data);
      if (!r.deleted && local && hash(local.data) === h) { meta.synced[r.id] = { h, c: r.collection }; continue }
      if (r.collection === 'settings') {
        if (!r.deleted) { db.settings = { ...db.settings, ...r.data }; meta.synced.settings = { h: hash(db.settings), c: 'settings' }; changed = true }
        continue;
      }
      const list = db[r.collection]; if (!list) continue;
      const i = list.findIndex(d => d.id === r.id);
      if (r.deleted) { if (i >= 0) { list.splice(i, 1); changed = true } delete meta.synced[r.id] }
      else { if (i >= 0) list[i] = r.data; else list.push(r.data); meta.synced[r.id] = { h, c: r.collection }; changed = true }
    }
    saveMeta();
    if (changed) FF.replaceDb(db);
  }

  // ---- The shop's own uploaded MRP price lists (a shop can have several, e.g. one per company)
  // Kept on this device under a key for this shop only, and in the cloud as gzip-compressed chunks.
  // The local record is {lists, removed} (see plNorm in index.html). Each list may carry `pending`:
  // true = upload it, 'rename' = send its new name, 'claim' = an old list from before lists were per shop.
  const LEGACY_PL = 'pricelist', CHUNK_BYTES = 1_500_000;
  let plBusy = false, plAgain = false;
  const plKey = () => 'pricelist_' + shop.id;
  const plSig = rec => rec.lists.map(l => l.id + ':' + (l.version || '') + ':' + l.name + ':' + (l.pending || '')).join('|');
  async function gzip(text) { return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()) }
  async function gunzip(bytes) { return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text() }
  async function uploadList(l) {
    const packed = await gzip(JSON.stringify(l.rows));
    const version = crypto.randomUUID(), n = Math.max(1, Math.ceil(packed.length / CHUNK_BYTES));
    for (let i = 0; i < n; i++) await api('PUT', `list-chunk?list=${encodeURIComponent(l.id)}&version=${version}&n=${i}`, undefined, { bytes: packed.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) });
    await api('POST', 'list-commit', { list_id: l.id, version, name: l.name, parts: l.rows.length, chunks: n });
    return version;
  }
  async function downloadList(c) {
    const parts = [];
    for (let i = 0; i < c.chunks; i++) parts.push(new Uint8Array(await (await api('GET', `list-chunk?version=${encodeURIComponent(c.version)}&n=${i}`, undefined, { raw: true })).arrayBuffer()));
    const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length }
    return JSON.parse(await gunzip(all));
  }
  async function syncPriceList() {
    if (!shop || !navigator.onLine) return;
    if (plBusy) { plAgain = true; return }
    plBusy = true;
    const id = shop.id, key = plKey();
    let before = '';
    try {
      let local = FF.plNorm(null); try { local = FF.plNorm(await FF.idbGet(key)) } catch {}
      before = plSig(local);
      const owner = role === 'owner';
      if (owner) {
        for (const lid of local.removed) {
          await api('POST', 'list-delete', { list_id: lid });
          await FF.plUpdate(key, rec => { rec.removed = rec.removed.filter(x => x !== lid); return rec });
        }
      }
      let cur = (await api('GET', 'lists')).lists;
      if (owner) {
        let changed = false;
        for (const l of local.lists) {
          if (l.pending === true || (l.pending === 'claim' && !cur.length)) {
            const version = await uploadList(l);
            // Only mark it saved if it wasn't replaced again while uploading.
            await FF.plUpdate(key, rec => { const x = rec.lists.find(y => y.id === l.id); if (x && x.importedAt === l.importedAt && x.pending === l.pending) { x.version = version; delete x.pending } return rec });
            FF.toast(`${l.name} saved to your shop: ${l.rows.length.toLocaleString('en-IN')} parts.`);
            changed = true;
          } else if (l.pending === 'rename' && l.version) {
            await api('POST', 'list-rename', { list_id: l.id, name: l.name });
            await FF.plUpdate(key, rec => { const x = rec.lists.find(y => y.id === l.id); if (x && x.pending === 'rename' && x.name === l.name) delete x.pending; return rec });
            changed = true;
          }
        }
        if (changed) cur = (await api('GET', 'lists')).lists;
      }
      // Download lists that are new or changed on another device.
      local = FF.plNorm(await FF.idbGet(key));
      const got = new Map();
      for (const c of cur) {
        const l = local.lists.find(x => x.id === c.list_id);
        if (local.removed.includes(c.list_id) || (l && (l.version === c.version || (owner && l.pending === true)))) continue;
        const rows = await downloadList(c);
        if (rows.length !== c.parts) continue;
        got.set(c.list_id, { id: c.list_id, name: c.name, rows, version: c.version });
      }
      const ids = new Map(cur.map(c => [c.list_id, c]));
      const rec = await FF.plUpdate(key, rec => {
        rec.lists = rec.lists.filter(l => ids.has(l.id) || (owner && (l.pending === true || (l.pending === 'claim' && !cur.length))))
          .map(l => { const g = got.get(l.id); if (g && !(owner && l.pending === true)) return g; const c = ids.get(l.id); if (c && l.version === c.version && !l.pending && l.name !== c.name) l.name = c.name; return l });
        for (const [lid, g] of got) if (!rec.lists.some(x => x.id === lid)) rec.lists.push(g);
        return rec;
      });
      if (plSig(rec) !== before && shop?.id === id) FF.usePriceList(key);
      // Remember what the server has, so /sync only triggers this again when something changes.
      if (!FF.plPending(rec) && shop?.id === id) { meta.listSig = JSON.stringify(cur.map(c => [c.list_id, c.version, c.name])); saveMeta() }
    } catch (e) {
      if (role === 'owner') console.warn('Price list sync failed; will retry.', e);
    } finally {
      plBusy = false;
      if (plAgain) { plAgain = false; syncPriceList() }
    }
  }
  async function adoptLegacyPriceList() {
    try {
      const old = FF.plNorm(await FF.idbGet(LEGACY_PL)); await FF.idbDel(LEGACY_PL);
      if (role !== 'owner' || !old.lists.length || FF.plNorm(await FF.idbGet(plKey())).lists.length) return;
      await FF.idbPut(plKey(), { lists: old.lists.map(l => ({ ...l, version: undefined, pending: 'claim' })), removed: [] });
    } catch {}
  }

  // ---- Moving a shop from the old site (Supabase database) on its owner's first sign-in here.
  // Everything is read from the old site first, then the shop is created here with the same id and team,
  // and the bills and price lists are saved on this device as "not yet sent", so normal syncing uploads them.
  async function readOldShop() {
    const { data, error } = await sb.from('members').select('role, shops(id, name)').eq('user_id', user.id).limit(1);
    if (error || !data?.[0]?.shops) return null;
    const old = data[0];
    if (old.role !== 'owner') return { staffOf: old.shops.name };
    screen('loading', 'Moving your shop from the old site — this happens once…');
    const docs = [];
    for (let from = 0; ; from += 1000) {
      const r = await sb.from('docs').select('id,collection,data').eq('shop_id', old.shops.id).eq('deleted', false).order('id').range(from, from + 999);
      if (r.error) throw r.error;
      docs.push(...r.data);
      if (r.data.length < 1000) break;
    }
    const lists = [];
    const pl = await sb.from('price_lists').select('list_id,version,name,parts,chunks').eq('shop_id', old.shops.id);
    for (const l of pl.data || []) {
      const rows = [];
      for (let i = 0; i < l.chunks; i += 4) {
        const r = await sb.from('price_list_chunks').select('n,rows').eq('shop_id', old.shops.id).eq('version', l.version).gte('n', i).lt('n', i + 4).order('n');
        if (r.error) throw r.error;
        for (const ch of r.data) rows.push(...ch.rows);
      }
      if (rows.length === l.parts) lists.push({ id: l.list_id, name: l.name, rows, pending: true, importedAt: Date.now() });
    }
    return { shopId: old.shops.id, docs, lists };
  }
  async function resumeMove(shopId) {
    let old = null;
    try { old = await readOldShop() } catch {}
    hideScreen();
    if (old?.shopId !== shopId || (!old.docs.length && !old.lists.length)) return;
    FF.useStore(dataKey(), dbFromDocs(old.docs)); meta = { synced: {}, rev: 0, listSig: null }; saveMeta();
    if (old.lists.length) { await FF.idbPut(plKey(), { lists: old.lists, removed: [] }); FF.usePriceList(plKey()) }
    FF.toast(`Finishing the move from the old site: ${old.docs.length.toLocaleString('en-IN')} records. Uploading…`);
    await sync();
  }
  function dbFromDocs(docs) {
    const db = FF.emptyDb();
    for (const d of docs) {
      if (d.collection === 'settings') db.settings = { ...db.settings, ...d.data };
      else if (db[d.collection]) db[d.collection].push(d.data);
    }
    return db;
  }

  // ---- Sidebar status
  function status() {
    const el = document.getElementById('cloud-status'); if (!el || !shop) return;
    const n = pendingCount();
    const line = !navigator.onLine ? `<span class="local-dot wait"></span>Offline${n ? ` · ${n} change${n === 1 ? '' : 's'} waiting` : ''}`
      : state === 'error' ? `<span class="local-dot err"></span><span title="${esc(lastError)}">Sync problem — retrying</span>`
      : state === 'syncing' || n ? `<span class="local-dot wait"></span>Saving to cloud…`
      : `<span class="local-dot"></span>Saved to cloud`;
    el.innerHTML = `<div>${line}</div><div class="cloud-user">${esc(user?.email || '')} · ${role === 'owner' ? 'Owner' : 'Staff'}</div><button class="link-btn" data-cloud="signout">Sign out</button>`;
  }

  // ---- Sign-in screens
  function screen(kind, msg = '') {
    let el = document.getElementById('auth-layer');
    if (!el) { el = document.createElement('div'); el.id = 'auth-layer'; document.body.append(el) }
    const name = esc(FF?.db?.settings?.businessName && FF.db.settings.businessName !== 'Your workshop' ? FF.db.settings.businessName : 'ForgeFlow');
    const note = msg ? `<div class="auth-msg">${msg}</div>` : '';
    const body = {
      loading: `<p class="muted">${msg || 'Opening your shop…'}</p>`,
      signin: `<h2>Sign in</h2><p class="muted">Use the email and password for your shop account.</p>${note}<form data-auth="signin"><label>Email</label><input class="field" name="email" type="email" autocomplete="email" required><label>Password</label><input class="field" name="password" type="password" autocomplete="current-password" required><button class="btn primary big">Sign in</button></form><div class="auth-links"><button class="link-btn" data-auth-go="signup">Create an account</button><button class="link-btn" data-auth-go="reset">Forgot password?</button></div>`,
      signup: `<h2>Create an account</h2><p class="muted">Shop owners: create your account, then name your shop.<br>Staff: use the email your owner invited.</p>${note}<form data-auth="signup"><label>Email</label><input class="field" name="email" type="email" autocomplete="email" required><label>Password (at least 8 characters)</label><input class="field" name="password" type="password" minlength="8" autocomplete="new-password" required><button class="btn primary big">Create account</button></form><div class="auth-links"><button class="link-btn" data-auth-go="signin">I already have an account</button></div>`,
      reset: `<h2>Reset password</h2><p class="muted">We'll email you a link to set a new password.</p>${note}<form data-auth="reset"><label>Email</label><input class="field" name="email" type="email" required><button class="btn primary big">Send reset link</button></form><div class="auth-links"><button class="link-btn" data-auth-go="signin">Back to sign in</button></div>`,
      newpass: `<h2>Set a new password</h2>${note}<form data-auth="newpass"><label>New password</label><input class="field" name="password" type="password" minlength="8" autocomplete="new-password" required><button class="btn primary big">Save password</button></form>`,
      setup: `<h2>Set up your shop</h2><p class="muted">Signed in as <b>${esc(user?.email)}</b>.</p>${note}<form data-auth="setup"><label>Shop name</label><input class="field" name="name" required placeholder="e.g. Singh Machine Works" value="${FF.db.settings.businessName !== 'Your workshop' ? esc(FF.db.settings.businessName) : ''}"><button class="btn primary big">Create my shop</button></form><div class="hint-box">Bills already saved on this device will be copied into your new shop.<br><br><b>Are you staff?</b> Don't create a shop. Ask the owner to invite <b>${esc(user?.email)}</b> in Business settings → Team, then <button class="link-btn" data-auth-go="retry" style="color:var(--green)">check again</button>.</div><div class="auth-links"><button class="link-btn" data-cloud="signout">Sign out</button></div>`,
    }[kind];
    el.innerHTML = `<div class="auth-card"><div class="brand auth-brand"><div class="brand-mark">F</div><div><div class="brand-name">${name}</div><div class="brand-sub" style="color:var(--muted)">Workshop billing</div></div></div>${body}</div>`;
    el.querySelector('input')?.focus();
  }
  function hideScreen() { document.getElementById('auth-layer')?.remove() }

  async function handleAuth(form) {
    const d = Object.fromEntries(new FormData(form)); const kind = form.dataset.auth;
    const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Please wait…';
    try {
      if (kind === 'signin') {
        const { data, error } = await sb.auth.signInWithPassword({ email: d.email.trim(), password: d.password });
        if (error) throw error; await enter(data.user);
      } else if (kind === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: d.email.trim(), password: d.password, options: { emailRedirectTo: location.href.split('#')[0] } });
        if (error) throw error;
        if (data.session) await enter(data.user);
        else screen('signin', `Check <b>${esc(d.email)}</b> for a confirmation email, click the link, then sign in here.`);
      } else if (kind === 'reset') {
        const { error } = await sb.auth.resetPasswordForEmail(d.email.trim(), { redirectTo: location.href.split('#')[0] });
        if (error) throw error; screen('signin', 'Reset link sent. Open it from your email to set a new password.');
      } else if (kind === 'newpass') {
        const { error } = await sb.auth.updateUser({ password: d.password });
        if (error) throw error; FF.toast('Password updated.'); const { data } = await sb.auth.getUser(); await enter(data.user);
      } else if (kind === 'setup') {
        const m = await api('POST', 'shop', { name: d.name });
        await open(m.shop, m.role, true);
      }
    } catch (e) {
      const m = String(e?.message || e);
      screen(kind, esc(/invalid login/i.test(m) ? 'Wrong email or password.' : /not confirmed/i.test(m) ? 'Please confirm your email first — check your inbox.' : isNetwork(e) ? 'No internet connection.' : m));
    }
  }

  // ---- Opening a shop after sign-in
  async function enter(u) {
    user = u; screen('loading');
    let membership = null, moved = null;
    try {
      membership = (await api('GET', 'me')).membership;
      if (!membership) {
        const old = await readOldShop();
        if (old?.staffOf) return screen('setup', `Your shop <b>${esc(old.staffOf)}</b> has not moved to this site yet. Ask the owner to sign in here once, then <button class="link-btn" data-auth-go="retry">check again</button>.`);
        if (old) { membership = await api('POST', 'import-shop', { shop_id: old.shopId }); moved = old }
      }
    } catch (e) {
      if (!isNetwork(e)) return screen('signin', esc(e.message || 'Could not open your shop.'));
      // Offline: reopen the last shop from this device's copy.
      try { const last = JSON.parse(localStorage.getItem(LAST)); if (last?.userId === u.id) membership = last } catch {}
      if (!membership) return screen('signin', 'No internet connection. Connect once to open your shop on this device.');
    }
    if (!membership) return screen('setup');
    await open(membership.shop, membership.role, false, moved);
  }

  async function open(s, r, isNew, moved = null) {
    shop = s; role = r;
    try { localStorage.setItem(LAST, JSON.stringify({ userId: user.id, shop: s, role: r })) } catch {}
    loadMeta();
    let cached = null; try { cached = JSON.parse(localStorage.getItem(dataKey())) } catch {}
    if (moved) {
      // Everything from the old site is unsent here, so it all uploads.
      FF.useStore(dataKey(), dbFromDocs(moved.docs)); meta = { synced: {}, rev: 0, listSig: null }; saveMeta();
      if (moved.lists.length) await FF.idbPut(plKey(), { lists: moved.lists, removed: [] });
    } else if (isNew) {
      // Copy this device's existing bills into the new shop; everything is unsent, so it all uploads.
      const local = FF.localDb();
      if (!local.settings.businessName || local.settings.businessName === 'Your workshop') local.settings.businessName = s.name;
      FF.useStore(dataKey(), local); meta = { synced: {}, rev: 0, listSig: null }; saveMeta();
      // Moved, not copied: another account opening a shop on this device must not get them too.
      FF.clearLocal();
    } else if (cached) FF.useStore(dataKey(), cached);
    else {
      // First time on this device: start empty and take everything (including settings) from the server.
      FF.useStore(dataKey(), FF.emptyDb()); meta = { synced: { settings: { h: hash(FF.db.settings), c: 'settings' } }, rev: 0, listSig: null }; saveMeta();
    }
    FF.setRole(r);
    await adoptLegacyPriceList();
    FF.usePriceList(plKey());
    hideScreen();
    document.body.classList.add('cloud-on');
    if (moved) FF.toast(`Moved ${moved.docs.length.toLocaleString('en-IN')} records${moved.lists.length ? ` and ${moved.lists.length} price list${moved.lists.length === 1 ? '' : 's'}` : ''} from the old site. Uploading…`);
    await sync();
    // A move that was interrupted (shop created here, but its records never uploaded): finish it now.
    if (!cached && !isNew && !moved && r === 'owner' && meta.rev === 0 && state === 'idle') await resumeMove(s.id);
    // /sync already reports changed lists; only upload here if this device has something waiting.
    try { if (FF.plPending(await FF.idbGet(plKey()))) syncPriceList() } catch {}
    clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === 'visible') sync() }, EVERY);
  }

  // ---- Team (owner only), shown in Business settings
  async function renderTeam() {
    const el = document.getElementById('team-card'); if (!el || !shop) return;
    if (role !== 'owner') { el.innerHTML = ''; return }
    el.innerHTML = `<div class="card-title">Team</div><div class="card-note">Loading…</div>`;
    let t; try { t = await api('GET', 'team') } catch { el.innerHTML = `<div class="card-title">Team</div><div class="card-note">Could not load the team. Check your internet.</div>`; return }
    const rows = t.members.map(x => `<tr><td><b>${esc(x.email || '—')}</b>${x.user_id === user.id ? ' <span class="tag">YOU</span>' : ''}</td><td>${x.role === 'owner' ? 'Owner' : 'Staff'}</td><td class="right">${x.role === 'staff' ? `<button class="btn small danger" data-cloud="remove-member" data-user="${esc(x.user_id)}">Remove</button>` : ''}</td></tr>`).join('')
      + t.invites.map(x => `<tr><td>${esc(x.email)}</td><td class="muted">Invited — waiting for sign-up</td><td class="right"><button class="btn small" data-cloud="cancel-invite" data-email="${esc(x.email)}">Cancel</button></td></tr>`).join('');
    el.innerHTML = `<div class="card-title">Team</div><div class="card-note">Staff can make bills, take payments, record purchases and update stock. They can't delete anything, see reports or expenses, or change settings.</div><div class="table-wrap" style="margin-top:12px"><table><tbody>${rows}</tbody></table></div><form id="invite-form" class="setting-actions"><input class="field" name="email" type="email" required placeholder="Staff email address" style="flex:1;min-width:200px"><button class="btn primary">＋ Invite staff</button></form><div class="helper">After you invite them, they open this website, choose “Create an account” with that email, and they're in.</div>`;
  }

  function bindEvents() {
    document.addEventListener('submit', async e => {
      const f = e.target;
      if (f.dataset.auth) { e.preventDefault(); handleAuth(f); return }
      if (f.id === 'invite-form') {
        e.preventDefault(); const email = new FormData(f).get('email').trim().toLowerCase();
        try { await api('POST', 'invite', { email }); FF.toast(`Invited ${email}.`) } catch (err) { FF.toast(err.status === 409 ? err.message + '.' : 'Could not invite: ' + err.message) }
        renderTeam();
      }
    });
    document.addEventListener('click', async e => {
      const t = e.target;
      const go = t.closest('[data-auth-go]');
      if (go) { if (go.dataset.authGo === 'retry') enter(user); else screen(go.dataset.authGo); return }
      const c = t.closest('[data-cloud]'); if (!c) return;
      const act = c.dataset.cloud;
      if (act === 'signout') {
        const waiting = shop && pendingCount();
        if (waiting && !confirm('Some changes are not saved to the cloud yet. Sign out anyway? They stay on this device.')) return;
        // Everything is in the cloud: remove this shop's copy so the next person on this device can't see it.
        if (shop && !waiting) {
          let pl = null; try { pl = await FF.idbGet(plKey()) } catch {}
          if (!FF.plPending(pl)) { try { await FF.idbDel(plKey()) } catch {} }
          try { [dataKey(), metaKey(), LAST].forEach(k => localStorage.removeItem(k)) } catch {}
        }
        await sb.auth.signOut(); location.reload();
      }
      if (act === 'remove-member') {
        if (!confirm('Remove this staff member? They will no longer be able to open your shop.')) return;
        try { await api('POST', 'member-remove', { user_id: c.dataset.user }); FF.toast('Staff member removed.') } catch (err) { FF.toast('Could not remove: ' + err.message) }
        renderTeam();
      }
      if (act === 'cancel-invite') { try { await api('POST', 'invite-cancel', { email: c.dataset.email }) } catch {} renderTeam() }
    });
    addEventListener('online', sync);
    addEventListener('offline', status);
    // Coming back to the app: catch up, but not more than twice a minute.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastSync > 30000) sync() });
    addEventListener('beforeunload', e => { if (shop && pendingCount() && navigator.onLine) { sync(); e.preventDefault(); e.returnValue = '' } });
  }

  async function start(app) {
    FF = app;
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    bindEvents();
    let recovering = /type=recovery/.test(location.hash);
    sb.auth.onAuthStateChange((ev) => { if (ev === 'PASSWORD_RECOVERY') { recovering = true; screen('newpass') } });
    screen('loading');
    const { data: { session } } = await sb.auth.getSession();
    if (recovering) return screen('newpass');
    if (!session) return screen('signin');
    await enter(session.user);
  }

  let changeTimer;
  window.Cloud = {
    enabled,
    start,
    // Wait for a pause in typing so one request carries several edits.
    changed() { if (!shop) return; status(); clearTimeout(changeTimer); changeTimer = setTimeout(sync, 2000) },
    renderTeam,
    status,
    priceListChanged() { syncPriceList() },
  };
})();
