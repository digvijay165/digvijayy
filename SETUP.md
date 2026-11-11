# Deploying ForgeFlow on Cloudflare

This version keeps shop data (bills, team, price lists) in **Cloudflare D1** and serves the website and its API
from **Cloudflare Pages**. Logins still use the **Supabase Auth** project in [`public/config.js`](public/config.js),
so the same accounts work here and on the original site.

Everything below is free and needs **no credit card**. It takes about 10 minutes.
You need [Node.js](https://nodejs.org) 20 or newer.

## 1. Create a Cloudflare account

Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and confirm your email.

## 2. Sign in from this folder

```bash
npm install
npx wrangler login
```

A browser window opens. Click **Allow** to let Wrangler (Cloudflare's tool) manage your account.

## 3. Create the database

```bash
npx wrangler d1 create forgeflow
```

It prints a `database_id`. Paste it into [`wrangler.toml`](wrangler.toml), replacing the zeros:

```toml
[[d1_databases]]
binding = "DB"
database_name = "forgeflow"
database_id = "paste-the-id-here"
```

Then create the tables:

```bash
npm run db:remote
```

## 4. Create the website and publish it

```bash
npx wrangler pages project create digvijayy --production-branch main
npm run deploy
```

The last command prints the address, for example `https://digvijayy.pages.dev`.
Run `npm run deploy` again whenever you change the code.

## 5. Allow logins from the new address

In the Supabase dashboard of the login project: **Authentication → URL Configuration → Redirect URLs**,
add your new address (for example `https://digvijayy.pages.dev/`). This makes sign-up confirmation and
password-reset emails come back to the new site.

## 6. First sign-in

- **Owners of a shop on the original site:** just sign in. The first time, your shop, team, bills and
  price lists are copied here automatically. The original site is not changed; after the move, the two
  sites no longer sync with each other, so use this one from then on.
- **Staff:** sign in after your owner has done the step above. If you sign in first, you'll be asked to wait.
- **New shops:** choose **Create an account**, then name your shop. Invite staff from
  **Business settings → Team**.

## Free plan limits

| Limit | Free amount | What it means |
| --- | --- | --- |
| API requests | 100,000 a day | About 2 per app open and 1 every 3 minutes while the app is on screen: roughly 400–500 devices used all day. When the limit is hit the app keeps working offline and syncs after midnight UTC (5:30 AM IST). |
| Database | 500 MB per database, 5 GB per account | Bills are about 1–2 KB each; price lists are stored zipped (a 60,000-part list is about 2–4 MB). |
| Website traffic | Unlimited | Static files don't count as requests. |

Watch usage in the Cloudflare dashboard under **Workers & Pages → digvijayy → Metrics** and **D1 → forgeflow**.

## Save bills to OneDrive (optional)

Same as the original site: add a Microsoft app ID to `onedriveClientId` in [`public/config.js`](public/config.js).
Register the app at [portal.azure.com](https://portal.azure.com) → **App registrations** with the redirect URIs
`https://digvijayy.pages.dev/` and `https://digvijayy.pages.dev/index.html` (type *Single-page application*) and the
Microsoft Graph delegated permission **Files.ReadWrite.All**. Personal Microsoft accounts need an Azure directory
first (sign up for Azure once).

## Good to know

- **Offline:** bills made without internet are saved on the device and sent when it reconnects.
  The sidebar shows "Saved to cloud" or how many changes are waiting.
- **Sync timing:** a change is sent about 2 seconds after you stop typing. Other devices pick it up when they
  next sync: when the app is opened or brought back on screen, or every 3 minutes while it is open.
- **Bill numbers:** if two devices make a bill at the same moment while offline, they can get the same number.
  Edit one of them if that happens.
- **Price lists** belong to the shop that uploaded them. Only the owner can add, replace, rename or remove a
  list; staff get them on every device, and other shops can never see them.
- **Changing the database:** `schema.sql` is safe to run again (`npm run db:remote`).
- **Testing:** `npm test` runs the API against a local copy of D1 with a test login key; nothing touches Cloudflare
  or Supabase.
