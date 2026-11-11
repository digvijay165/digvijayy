// Login: Supabase Auth (accounts are shared with the original ForgeFlow site).
// Shop data: Cloudflare D1, reached through this site's own /api (functions/api).
// Leave supabaseUrl and supabaseAnonKey empty to keep everything on this device only (no login).
// The publishable key is meant to be public; shop data is protected by the checks in functions/api.
window.FORGEFLOW_CONFIG = {
  supabaseUrl: 'https://zwxhlxjgsdijzqpsviiv.supabase.co',
  supabaseAnonKey: 'sb_publishable_wOhvEwVlyimxtkHRh4qcGw_P7EhUjL-',  // publishable key — safe to be public
  apiBase: '/api',
  // Microsoft app (client) ID for "Save bills to a OneDrive Excel link". Safe to be public. See SETUP.md.
  onedriveClientId: '',
};
