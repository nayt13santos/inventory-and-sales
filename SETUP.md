# Octogo Tracker — One-time Setup Guide

Total cost: **₱0**. You'll set up three things: the Google Sheet (database), the Apps Script API (backend), and the app itself (PWA). Budget ~20 minutes.

> **Which Google account?** Use your **personal** account — the same one that owns your existing takoyaki sheets — NOT your work (@globe.com.ph) account. Two reasons: company accounts can be closed when you change jobs (your business data goes with them), and company Workspace policies often block Apps Script web apps from being shared with "Anyone".

## Part 1 — Create the Sheet + API (≈10 min)

1. Go to [sheets.new](https://sheets.new) (logged in as your personal account). Name it **Octogo Tracker**.
2. Menu: **Extensions → Apps Script**. A code editor opens.
3. Delete the placeholder code. Copy the entire contents of `apps-script/Code.gs` from this project and paste it in.
4. Click the ⚙️ **Project Settings** (left sidebar) → check **"Show appsscript.json manifest file"**. Go back to Editor, open `appsscript.json`, replace its contents with the `apps-script/appsscript.json` from this project (sets timezone to Asia/Manila and web app access).
5. Back in the editor, select the function **`setupSheet`** in the toolbar dropdown, press **Run**. Approve the permission prompts (it asks because the script writes to your own sheet — this is normal; choose Advanced → Go to project if Google shows the "unverified" screen). When it finishes, your sheet has all tabs (Settings, Prices, DailyLog, DailyCounts, Expenses, Backlogs, Cutoffs) with seed data.
6. Open the **Settings** tab of the sheet and copy the `token` value — you'll enter it in the app later.
7. **Deploy the API**: in the Apps Script editor, click **Deploy → New deployment** → type: **Web app** → Description "v1" → Execute as: **Me** → Who has access: **Anyone** → **Deploy**. Copy the **Web app URL** (ends in `/exec`).

> "Who has access: Anyone" only means the URL is reachable; every request still needs your secret token, and the URL itself is unguessable. Anyone without both gets rejected.

## Part 2 — Host the app (≈5 min, pick ONE)

**Option A — GitHub Pages (recommended — this is the one that can update itself):**
1. Create a free account at github.com if you don't have one.
2. New repository → name `octogo-tracker` → Public → Create.
3. Upload **the whole project folder** (not just `pwa/`) — it includes `.github/workflows/deploy.yml`, which is what makes future updates automatic.
4. Repo **Settings → Pages** → Source: **GitHub Actions**.
5. After ~1 minute your app is live at `https://<your-username>.github.io/octogo-tracker/`. Every later push republishes it on its own — see "Automatic updates" below.

**Option B — Cloudflare Pages:** free account → Workers & Pages → Create → Pages → Upload assets → drag the six files from `pwa/` (`index.html`, `sw.js`, `manifest.webmanifest`, `logo.png`, `icon-192.png`, `icon-512.png`) → Deploy. You get `https://<name>.pages.dev`. Simple, but you re-upload by hand each time.

## Part 3 — Connect and install on phones (≈5 min)

1. Open the app URL in the phone's browser (Chrome on Android, Safari on iPhone).
2. Go to the **More** tab → API setup → paste the **Web app URL** (from Part 1 step 7) and the **token** (step 6) → **Test connection**. You should see "Connected".
3. Install:
   - **Android (Chrome):** menu ⋮ → **Add to Home screen** → Install.
   - **iPhone (Safari):** Share button → **Add to Home Screen**.
4. Repeat on Mama's phone (same URL + token). Done — she can log tonight's sales.

## Part 4 — Make it yours (5 min, in the Sheet)

Open the Google Sheet and edit these tabs directly — the app picks up changes on next sync.

- **Backlogs** — your eight obligations are already seeded (₱81,352 outstanding in total): Takoyaki Flour ₱2,538, Takoyaki Sauce ₱114, Ref ₱6,700, Deposit Nayt ₱7,500, Deposit Lou ₱7,500, Deposit Mama ₱7,000, Deposit Ilog Nayt ₱40,000, Deposit Ilog Mama ₱10,000. The `description` column is blank — fill it in if you want a reminder of what each one is. When you pay a variable amount out of a cutoff's excess, log it in Gastos under category **Backlog**, pick which one, and its balance drops. All backlog payments plus anything under **Other** roll up into the note's "Other payments" line. Add or retire obligations by editing rows here (set `active` to FALSE to hide one without deleting its history).
- **Prices** — current menu: Octobits 4/6/10 pcs at ₱50/65/105, Chizubits at ₱60/80/125. Change a price here and the app uses it for *future* days only; past days keep the price they were saved with, so history never shifts under you. To sell something new later (drinks, for example), add a row: `group` = `box` gives it start/end counts with a cheese split, `group` = `simple` gives counts with one price and no cheese.
- **Settings** — `mama_per_cutoff` (₱500), `electric_per_cutoff` (₱500), `branch` (Tañong), and `staff` (comma-separated names if more than Mama minds the stall).

## Daily / cutoff flow after setup

- **Mama, at closing:** open app → Sales tab → enter container counts (start and end of day), cheese counts, GCash total → Save day. Log expenses as they happen in the Expenses tab. Works even with no signal — it syncs later.
- **You, at cutoff:** Cutoff tab → check the preview → Generate cutoff note → Copy or Share it to your partner. Mama ₱500 and Electric ₱500 are pre-suggested each cutoff; add Octopus and backlog payments under Expenses as you pay them.
- **Your data is always yours:** everything is plain rows in the Google Sheet — open it anytime, or take it elsewhere.

## Who can see what

Three separate things, with three different settings. Only one of them is public, and it holds no data.

| Thing | Who can access it | What to do |
| --- | --- | --- |
| **The Google Sheet** (all your money data) | **Only you.** Private by default. | Nothing — just don't share it. Mama does **not** need access; the app reaches the sheet through the script, which runs as you. |
| **The Apps Script web app** (the API URL) | Anyone who has **both** the URL *and* the token | Keep both to yourself and Mama's phone. This is the real lock. |
| **The app files** (index.html, icons) | Public on the web | Fine as-is — see below. |

**Why the deployment says "Anyone".** In Part 1 step 7 you set *Who has access: Anyone*. That only means a request doesn't have to be signed in to Google — necessary so Mama's phone never has to log in. It does **not** make your data public: the script checks the secret token before it will do anything at all, and rejects every request without it. The URL itself is a long unguessable string.

**The token is the password.** Anyone holding both the URL and the token can read and write your business data, so treat it like a bank PIN — don't post it in a group chat or commit it to GitHub. It's never baked into the app files; each phone stores its own copy, typed in once during Part 3.

**To change the token** (if you ever think it leaked): open the Sheet → Settings tab → replace the `token` value with a new random string → re-enter it on both phones under **More → API setup**. Every old copy stops working immediately.

**The public app files are safe.** They contain no data, no token, and no sheet URL — a stranger who finds your GitHub Pages link sees an empty app in demo mode with nothing in it. If you'd still rather it not be reachable at all, Cloudflare Pages can put an email login in front of it (Cloudflare Access, free for small teams), at the cost of Mama having to sign in.

## Automatic updates (set up once, then never touch it again)

The repo already contains `.github/workflows/deploy.yml`. Once the repo exists, **every push publishes the app automatically** — and it refuses to publish if the tests fail, so a broken calculation can't reach the stall.

**Turn on the app half (2 minutes, no credentials needed):**

1. Push this project to your GitHub repo (the whole folder, not just `pwa/`).
2. Repo **Settings → Pages → Source: GitHub Actions** (change it from "Deploy from a branch").

That's it. From then on, any change to the app files publishes itself, and the phones pick it up on their own — see "How the phones update" below.

**The sheet-script half — DONE (verified 2026-08-01).** All three secrets are set and a full run was confirmed end to end: tests → app published → `Redeployed @3` → the same `/exec` URL still answering `{"ok":true,"data":{"name":"octogo-api","version":"2.0.0"}}`. The API URL and token did not change, so no phone needed touching.

If you ever have to redo it (new machine, revoked credential, or the token expires):

1. Turn on the Apps Script API: [script.google.com/home/usersettings](https://script.google.com/home/usersettings) → **Google Apps Script API: On**.
2. `npm install -g @google/clasp@3` then `clasp login` (opens a browser, approve).
   > Pin **3.x**. clasp 3 writes `{"tokens":{"default":{…}}}`, which clasp 2 cannot read — it fails with `Cannot read properties of undefined (reading 'access_token')`. The workflow pins 3.3.0 to match.
3. `gh secret set CLASPRC_JSON < ~/.clasprc.json --repo <you>/octogo-tracker`
4. `SCRIPT_ID` — Apps Script → **Project Settings → Script ID**. Container-bound scripts do **not** appear in `clasp list-scripts`, so read it from the editor.
5. `DEPLOYMENT_ID` — run `clasp list-deployments`. You'll see two: an `@HEAD` dev deployment and your versioned web app. **Pick the versioned one** — confirm by opening its `/exec` URL; the right one returns the ping JSON, the `@HEAD` one shows a Google sign-in page.

> Without `DEPLOYMENT_ID` the workflow deliberately pushes the code but leaves it unpublished and warns you — better than minting a new URL and silently stranding the phones on the old API.
>
> `CLASPRC_JSON` is a Google credential for your Apps Script projects, held in GitHub's encrypted secrets. It means a push can change the live script that touches your money data — the test gate runs first and only that one deployment can ever be updated, but it is a real increase in blast radius. To back out: delete the secret (the app half keeps auto-deploying) and run `clasp logout`.

## How the phones update

Nothing to do — the app updates itself. When a new version is published, the next time the app is opened it swaps over automatically.

It deliberately **waits** if Mama is mid-entry: a half-typed day is never interrupted, and the update applies after she saves or the next time the app is opened. Nothing queued is ever lost across an update.

To confirm which version a phone is on: **More → About**. Current release: **app 2.0.0**, **script 2.0.0**.

## Updating by hand (if you skip the automation)

The app has **two halves that must be updated separately** — the script in the sheet, and the files on the web host. A change to one usually needs the other, so do both. Takes about 5 minutes.

Current versions: **script 2.0.0**, **app 2.0.0**. You can check what each phone is actually running under **More → About**.

### 1. Update the script (in the sheet)

1. Open the Sheet → **Extensions → Apps Script**.
2. Select all the code in `Code.gs` and replace it with the new `apps-script/Code.gs`. Save (⌘S).
3. Run **`setupSheet`** once from the toolbar dropdown. It's safe to re-run — it only adds what's missing (new tabs, new seed rows) and never overwrites your data, your prices, or your token.
4. **Publish the new version — this is the step people miss.** Editing the code does *nothing* to the live URL until you republish:
   **Deploy → Manage deployments** → click the ✏️ pencil on your existing deployment → **Version: New version** → **Deploy**.
   > Use **Manage deployments → Edit**, not "New deployment". Editing keeps your existing URL, so nothing on the phones needs changing. Creating a *new* deployment mints a *different* URL and the phones would keep talking to the old code.
5. Confirm: **More → API setup → Test connection** on your phone should report the new script version.

### 2. Update the app files (on your web host)

Upload the six files from `pwa/` (`index.html`, `sw.js`, `manifest.webmanifest`, `logo.png`, `icon-192.png`, `icon-512.png`), replacing the old ones.

- **GitHub Pages:** open the repo → **Add file → Upload files** → drag all six → **Commit changes**. Live in about a minute.
- **Cloudflare Pages:** project → **Create deployment** → drag all six → **Deploy**.

### 3. Get the update onto the phones

Each phone caches the app so it works offline, so a new version lands on the **second** open, not the first: open the app once (it quietly downloads the update), close it fully — swipe it out of the app switcher, don't just go to the home screen — then open it again.

Check **More → About** shows the new version. If it still shows the old one, close it fully and reopen once more.

**Nothing is lost during an update.** Anything not yet synced stays in the phone's queue and sends once the new version loads. Your token and API URL stay put — you won't have to type them again.

## Changing prices or adding a product

No update needed — edit the **Prices** tab of the sheet directly, then hit **Sync now** on the phones. New prices apply to future days only; days already saved keep the price they were recorded at, so your history never shifts.
