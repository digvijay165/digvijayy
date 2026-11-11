-- ForgeFlow on Cloudflare D1 (SQLite).
-- Apply with:  npx wrangler d1 execute forgeflow --remote --file=schema.sql
-- Safe to run again; it only creates what is missing.
-- Login stays with Supabase Auth: user ids and emails below come from the verified Supabase token.

-- A shop (your business). One owner, any number of staff.
create table if not exists shops (
  id text primary key,
  name text not null,
  created_by text,
  created_at integer not null
);

create table if not exists members (
  shop_id text not null references shops(id) on delete cascade,
  user_id text not null,
  email text,
  role text not null check (role in ('owner', 'staff')),
  created_at integer not null,
  primary key (shop_id, user_id)
);
create index if not exists members_user on members (user_id);

-- The owner invites staff by email; the invite is claimed when that person signs in.
create table if not exists invites (
  shop_id text not null references shops(id) on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('staff')),
  created_at integer not null,
  primary key (shop_id, email)
);
create index if not exists invites_email on invites (email);

-- Every record (bill, purchase, expense, stock item, saved item, settings) is one row.
-- Rows are never hard-deleted by the app; "deleted" marks them so other devices hear about it.
-- rev is a per-shop counter set by the server: devices ask for "everything after rev N".
create table if not exists docs (
  shop_id text not null references shops(id) on delete cascade,
  id text not null,
  collection text not null check (collection in ('settings', 'catalog', 'invoices', 'stock', 'purchases', 'expenses')),
  data text not null default '{}',
  deleted integer not null default 0,
  rev integer not null,
  updated_at integer not null,
  updated_by text,
  primary key (shop_id, id)
);
create index if not exists docs_shop_rev on docs (shop_id, rev);

-- Each shop's uploaded MRP price lists. A list is large (60,000+ parts), so it is stored as
-- gzip-compressed chunks. A new upload writes its chunks under a new version, then points
-- price_lists at it, so devices never read a half-written list.
create table if not exists price_lists (
  shop_id text not null references shops(id) on delete cascade,
  list_id text not null,
  version text not null,
  name text not null,
  parts integer not null,
  chunks integer not null,
  updated_at integer not null,
  primary key (shop_id, list_id)
);
create table if not exists price_list_chunks (
  shop_id text not null references shops(id) on delete cascade,
  list_id text not null,
  version text not null,
  n integer not null,
  data blob not null,
  primary key (shop_id, version, n)
);
create index if not exists price_list_chunks_list on price_list_chunks (shop_id, list_id);
