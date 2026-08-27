# Octogo Tracker — One-time Setup Guide

Total cost: **₱0**. You'll set up three things: the Google Sheet (database), the Apps Script API (backend), and the app itself (PWA). Budget ~20 minutes.

> **Which Google account?** Use your **personal** account — the same one that owns your existing takoyaki sheets — NOT your work (@globe.com.ph) account. Two reasons: company accounts can be closed when you change jobs (your business data goes with them), and company Workspace policies often block Apps Script web apps from being shared with "Anyone".

## Part 1 — Create the Sheet + API (≈10 min)

1. Go to [sheets.new](https://sheets.new) (logged in as your personal account). Name it **Octogo Tracker**.
2. Menu: **Extensions → Apps Script**. A code editor opens.
3. Delete the placeholder code. Copy the entire contents of `apps-script/Code.gs` from this project and paste it in.
4. Click the ⚙️ **Project Settings** (left sidebar) → check **"Show appsscript.json manifest file"**. Go back to Editor, open `appsscript.json`, replace its contents with the `apps-script/appsscript.json` from this project (sets timezone to Asia/Manila and web app access).
5. Back in the editor, select the function **`setupSheet`** in the toolbar dropdown, press **Run**. Approve the permission prompts (it asks because the script writes to your own sheet — this is normal; choose Advanced → Go to project if Google shows the "unverified" screen). When it finishes, your sheet has all twelve tabs (Settings, Prices, DailyLog, DailyCounts, Expenses, Backlogs, Cutoffs, CutoffInputs, StockItems, StockUsage, StockCounts, StockDeliveries) with seed data.
6. Open the **Settings** tab of the sheet and copy the `token` value — you'll enter it in the app later.
7. **Deploy the API**: in the Apps Script editor, click **Deploy → New deployment** → type: **Web app** → Description "v1" → Execute as: **Me** → Who has access: **Anyone** → **Deploy**. Copy the **Web app URL** (ends in `/exec`).

> "Who has access: Anyone" only means the URL is reachable; every request still needs your secret token, and the URL itself is unguessable. Anyone without both gets rejected.

## Part 2 — Host the app (≈5 min, pick ONE)

**Option A — GitHub Pages (recommended — this is the one that can update itself):**
1. Create a free account at github.com if you don't have one.
2. New repository → name `inventory-and-sales` → Public → Create.
3. Upload **the whole project folder** (not just `pwa/`) — it includes `.github/workflows/deploy.yml`, which is what makes future updates automatic.
4. Repo **Settings → Pages** → Source: **GitHub Actions**.
5. After ~1 minute your app is live at `https://<your-username>.github.io/inventory-and-sales/`. Every later push republishes it on its own — see "Automatic updates" below.

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

- **Backlogs** — your eight obligations are already seeded (₱81,352 outstanding in total): Takoyaki Flour ₱2,538, Takoyaki Sauce ₱114, Ref ₱6,700, Deposit Nayt ₱7,500, Deposit Lou ₱7,500, Deposit Mama ₱7,000, Deposit Ilog Nayt ₱40,000, Deposit Ilog Mama ₱10,000. The `description` column is blank — fill it in if you want a reminder of what each one is. When you pay a variable amount out of a cutoff's excess, log it under **Expenses** with category **Backlog**, pick which one, and its balance drops. All backlog payments plus anything under **Other** roll up into the note's "Other payments" line. Add or retire obligations by editing rows here (set `active` to FALSE to hide one without deleting its history).
- **Prices** — current menu: Octobits 4/6/10 pcs at ₱50/65/105, Chizubits at ₱60/80/125, plus **Nori at ₱25** (seeded with "Counts in the cutoff" OFF, so its card shows a "Not in the cutoff" badge and its money stays out of the partner note — deactivate the row if you stop selling it). Change a price here and the app uses it for *future* days only; past days keep the price they were saved with, so history never shifts under you. To sell something new later (drinks, for example), add a row: `group` = `box` gives it start/end counts with a cheese split, `group` = `simple` gives counts with one price and no cheese. There is also a **`box_cost`** column — what **one container** costs you (your bundle price divided by how many were in the bundle: Box 4 ₱0.375, Box 6 ₱3.00, Box 10 ₱4.60 are filled in for you). It is only used by **More → What it costs**; it touches no price, no cutoff and no note. Leave a cell **blank** if you genuinely don't know — blank means "no cost on file" and that sku is left out of the costing and named, which is safer than pretending it is free. Editable from the phone under **More → Maintenance**, beside the price.
- **Settings** — `mama_per_cutoff` (₱500), `electric_per_cutoff` (₱500), `daily_salary` (₱200 — added to every day that is not marked closed), `split_default` (₱3,000, i.e. ₱1,500 each), `costed_buckets` (which expense buckets are already priced per unit — see “What it costs”), `branch` (Tañong), and `staff` (comma-separated names if more than Mama minds the stall). **You can now edit all of these from the phone** under **More → Maintenance**, along with prices and the stock list — the sheet is no longer the only way in.
- **StockItems** — the things you open, counted whole: Takoyaki Flour (pack), Takoyaki Sauce (gallon), Japanese Mayo (pack), Bonito (pack), Aonori (pack), Togarashi (pack). All start at 0 on hand. Three arrive with their reorder points already set — **Flour at 5, Sauce at 1, Mayo at 1** (your figures) — so the quiet **Low** line can appear from day one; the rest have none (blank `reorder_at` = no warning, and any value you set yourself is never overwritten). There is also a **`unit_cost`** column — what **one of that unit** costs you, per the unit it is counted in: a pack of Flour ₱120, a gallon of Sauce ₱490, Mayo ₱300, Bonito ₱900, Aonori ₱550, Togarashi ₱320 (your figures, filled in for you). Like `box_cost` it feeds **More → What it costs** and nothing else, a blank means "no cost on file", and anything you correct yourself is never overwritten. After your first stocktake, use **More → Stock on hand → Correct the count** rather than typing figures in here.

> **After updating the script, run `setupSheet` once more.** Re-running it adds whatever your sheet is still missing — as of v2.9.0 that means columns (`gcash_converted`, `lid_boxes` and **`photo_url`** on DailyLog, `custom_qty` on DailyCounts, **`box_cost`** on Prices and **`unit_cost`** on StockItems — `photo_url` is just the link to the photo a night was read from, blank on every night typed in by hand), a `supply_picklist` setting (the expense screen's picklist — edit it under More → Maintenance), and fills in the figures you chose — the reorder points (Flour 5, Sauce 1, Mayo 1) and **the costs** (Flour ₱120, Sauce ₱490, Mayo ₱300, Bonito ₱900, Aonori ₱550, Togarashi ₱320; Box 4 ₱0.375, Box 6 ₱3.00, Box 10 ₱4.60) — **only where the cell is blank**, so anything you set yourself, including a deliberate 0, stays. It's a safe migration: it only ever *appends* new columns at the right and creates missing tabs — it never moves, renames or deletes anything you already have, and your token and prices are preserved. The old `SupplyItems`/`DailySupplies` tabs are left exactly as they are and simply stop being used.

## Daily / cutoff flow after setup

- **Mama, at closing:** open app → **Sales** tab and work down the screen, laid out the way the stall works:
  0. **📷 Read it from the paper** *(only if you set up the photo reader below — otherwise this button is not there at all)*. Photograph the page you have just written, and the app fills the rest of this screen in for you. Then **check every figure against the paper in your hand** and carry on down the screen exactly as before. It shows what it read, names anything it could **not** read (those stay **empty**, never 0), and compares the page's own total against what the form now adds up to — if the two agree, that is real evidence it read you right; if they differ it says by how many pesos and which lines to look at. **Nothing is saved by any of this.** Typing the night in by hand works exactly as it always did, and on a night with no signal it is the only way — the reader needs internet.
  1. **Box counts** per size — start of day is **already filled in from the last close** (it's just a suggestion; change it if it's wrong), end of day, and **"How many were cheese?"** — a fact about what was made, not how it was paid. The app works out how many sold.
  2. **Sold with GCash** — one card for the whole payment question: per size, how many went through GCash, and of those how many were cheese. It stays closed on an all-cash night. At its bottom sits **Converted during the day**, with two buttons for the direction — tin cash swapped into a GCash transfer, or GCash paid out of the tin as cash — the day's total doesn't change, only the cash/GCash split moves.
  3. **Sold with cash** — nothing to type here: the app shows what's left after GCash, with its arithmetic spelled out, so the figure you count the tin against explains itself.
  4. **Custom order** amount, **how much of it was GCash**, and — if the order physically used boxes from tonight's counted stack — **"Boxes the order used"** (they're not priced again; the amount you typed is the order's whole value). **"Lid boxes used"** is its own counter here too: just a count, no price, no money.
  5. **Wage for this day** — ₱200 already filled in. Lower it for a half day, or 0 if nobody was paid. It is not part of the day's sales; it comes out at the cutoff.
  6. **Stock used today** — tap **+** once for each whole unit you OPENED: one gallon of sauce, one pack of flour. Not money, and not a weight.
  7. **Save day.**

  There is **no GCash total to type** — the app adds it up from what you entered and shows it on the receipt, so you can check it against your GCash history. There is no "supplies bought today" card any more either: every purchase goes under **Expenses**, so nothing can be counted twice. Works with no signal; it syncs later.
- **Adding an expense:** one tap, one amount, done. The form is a single row of buckets — **Octopus · Veggies · Eggs · Flour · Box · Other** — plus the amount and the date. Nothing to type: a named bucket files under **Supplies** with that name, Octopus and Other file under their own note lines. Edit the middle of that list under More → Maintenance (like the staff list). Mama ₱500, Electric ₱500 and backlog payments have their own buttons on the **Cutoff** screen, where that money is actually decided.
- **When a delivery arrives:** More → **Stock on hand** → **"Stock came in"** → every product is listed; tap **+** on what arrived (whole units), one Save for the lot. Quantity only — no money, because the goods usually arrive before they are paid for. **Paying the supplier later** (whenever that happens) is a normal **Supplies** expense on the Expenses screen, like any other money leaving. Two events, two entries, and nothing can be counted twice: the quantity lives in your stock, the money in Expenses, each on the day it actually happened. (Deliveries you logged the old way — on an expense row — still count in your stock forever.)
- **On the Cutoff screen, before you make the note:** if any day in the period has **nothing entered**, the app lists those dates at the top with two buttons each — **Enter it** (opens that night) or **Was closed** (records a dark day). It never stops you making the note; it just refuses to let a missing night look like a slow one. A period with no purchases logged says so too.
- **Anytime you're suspicious of the sheet** (after hand-edits): **More → Check the sheet** — the server audits every tab for stray duplicates, orphaned rows and money that disagrees with itself, in plain sentences.
- **You, at cutoff:** Cutoff tab → check the preview (below the note sits **Stock this cutoff** — your old paper supplies count, done for you from what was logged) → adjust **Split** if this fortnight is different (it remembers per cutoff, ₱1,500 each by default) → pay a backlog from the **Pay a backlog** card if there is anything left → **Generate cutoff note** → Copy or Share it to your partner. Mama ₱500 and Electric ₱500 are pre-suggested each cutoff; add Octopus under Expenses as you pay it.

  The note's last line is the **residual**: `Remaining - 1,000` when there is money left in the business, or `Short - 2,000` when the fortnight came up short. Split is now an amount you enter, not whatever was left over.
- **What it costs (yours, not Mama's):** More → **What it costs** → **Work out the costing**. It answers the question you asked by hand once — *what does a ball actually cost, and what should the price be?* — from what has actually been logged, for one cutoff at a time (the same ‹ › fortnights as the Cutoff screen). It shows: what **one ball** cost to make, broken into stock opened, supplies and octopus paid, and boxes used; what **one night** costs before a single box sells (wages plus Mama and the electric, spread over the nights that were open); **what each box leaves you** after all of it; how many balls a night just breaks even; and what a typical night takes, costs and leaves.

  Two things about it are deliberate and worth knowing. **Stock opened and boxes used are what was *used up*; supplies and octopus are what was *paid for*.** Over a fortnight those are not the same money — your suppliers deliver before you pay them — so they are shown apart and never added into one figure, and a sack of flour is never counted twice (once as money paid and once as flour opened). That last part works off one setting: **`costed_buckets`** (More → Maintenance) lists the expense buckets whose money is already counted per unit — **Flour** (priced from what Mama opens) and **Box** (priced per box sold). Buckets that are *not* on that list — Veggies, Eggs, Octopus — are counted as money, because their peso amount is the only record of them. Give something a per-unit cost, add its bucket to the list the same day. And **anything with no cost on file is left out and named**, never quietly counted as free: if a dash appears where a figure should be, the screen says exactly which product or box needs a cost under Maintenance.

  At the bottom, type what you want a night to leave you and it says **what each price would have to be** to get there, selling the same mix you actually sold. That is advice and nothing else — **it saves no price, changes no cutoff, and never touches a note**. This whole screen is read-only management information; the figures your partner receives are byte-for-byte what they always were.
- **Checking stock:** More → **Stock on hand** shows each item's count, a **Low** mark when it is at or below its reorder point, and **Correct the count** for a stocktake. A count is an end-of-day figure and becomes the new starting point, which is what absorbs spoilage and miscounts. A figure below zero just means the starting point is out of date — count it.
- **Your data is always yours:** everything is plain rows in the Google Sheet — open it anytime, or take it elsewhere.

## Who can see what

Three separate things (four if you set up the photo reader), with their own settings. Only one of them is public, and it holds no data.

| Thing | Who can access it | What to do |
| --- | --- | --- |
| **The Google Sheet** (all your money data) | **Only you.** Private by default. | Nothing — just don't share it. Mama does **not** need access; the app reaches the sheet through the script, which runs as you. |
| **The Apps Script web app** (the API URL) | Anyone who has **both** the URL *and* the token | Keep both to yourself and Mama's phone. This is the real lock. |
| **The app files** (index.html, icons) | Public on the web | Fine as-is — see below. |
| **The photo reader** (Octogo Vision, if you set it up) | Anyone who has **both** its URL *and* its own token | Keep both to yourself and Mama's phone. It holds a **Gemini API key**, so a leak costs money — but it cannot reach your sheet, so it cannot cost you data. |

**Why the deployment says "Anyone".** In Part 1 step 7 you set *Who has access: Anyone*. That only means a request doesn't have to be signed in to Google — necessary so Mama's phone never has to log in. It does **not** make your data public: the script checks the secret token before it will do anything at all, and rejects every request without it. The URL itself is a long unguessable string.

**The token is the password.** Anyone holding both the URL and the token can read and write your business data, so treat it like a bank PIN — don't post it in a group chat or commit it to GitHub. It's never baked into the app files; each phone stores its own copy, typed in once during Part 3.

**To change the token** (if you ever think it leaked): open the Sheet → Settings tab → replace the `token` value with a new random string → re-enter it on both phones under **More → API setup**. Every old copy stops working immediately.

**The public app files are safe.** They contain no data, no token, and no sheet URL — a stranger who finds your GitHub Pages link sees an empty app in demo mode with nothing in it. If you'd still rather it not be reachable at all, Cloudflare Pages can put an email login in front of it (Cloudflare Access, free for small teams), at the cost of Mama having to sign in.

## Back up the sheet (set up once — strongly recommended)

Everything the business records lives in one Google Sheet. Give it a safety net. This is a **separate little script**, on purpose: copying files needs Drive permission, and permissions in Apps Script are granted per project — keeping this out of the sheet's own script means it can never affect the app the phones use.

1. Go to [script.google.com](https://script.google.com) → **New project** → name it **Octogo Backups**.
2. Delete the placeholder code, paste in the whole of `standalone-scripts/Backups.gs` from this project.
3. Put your sheet in the `SPREADSHEET_ID` line at the top: paste **either** its id (in the sheet's URL, the long string between `/d/` and `/edit`) **or** the whole sheet URL — both work. Then **save** (the disk icon, or ⌘S/Ctrl+S): Run always uses the *saved* code.
4. Choose **`setupBackups`** in the toolbar dropdown → **Run** → approve the prompts (it asks for Drive because it makes copies). Google will likely show a scary **"Google hasn't verified this app"** screen — that is just because *you* wrote this script and never published it. Choose **Advanced → Go to Octogo Backups (unsafe)** and continue, exactly like you did for the tracker's own script.

Look at the **Execution log** panel that opens at the bottom: it prints a line naming the copy it just made ("Made \"Backup 2026-08-21 — …\""). That line is your proof it worked — the editor never shows anything else on success.

> **If it says the id is "still PASTE_THE_SHEET_ID_HERE" even though you typed it**, the message lists the three real reasons and you can check them in seconds. Usually it is one of the first two: the file wasn't **saved** before you pressed Run, or the project has **two files** containing this script (look at the file list on the left — every file shares one namespace, so the spare one wins; delete it). Choose **`whichSheet`** in the dropdown and Run it any time: it prints the id the saved code is really using **and the name of the file it points at**, so a wrong-sheet mistake is impossible to miss. From then on, **every Monday morning Google copies the sheet by itself** into a Drive folder called **"Octogo Tracker Backups"**, keeping the newest 8 copies (about two months). Older ones go to Drive's trash, which holds them ~30 days more. Nothing needs to be open — not the phones, not a computer. Re-running `setupBackups` never doubles the schedule; it just makes a fresh copy on the spot.

**To restore after a disaster** (sheet corrupted, tabs deleted, account mishap):
1. Open **"Octogo Tracker Backups"** in Drive → open the newest copy → **File → Make a copy** (work on the copy; leave the backup pristine).
2. In that copy: **Extensions → Apps Script** → paste in the current `apps-script/Code.gs` and `appsscript.json` → run **`setupSheet`** → **Deploy → New deployment** (Web app, Execute as **Me**, Who has access **Anyone**).
3. On each phone: **More → API setup** → paste the new Web app URL and the token from the restored sheet's Settings tab → **Test connection**.
4. Point the backup project at the new sheet: update its `SPREADSHEET_ID` and run `setupBackups` again.

You lose at most the days since the last Monday copy — and those are usually still on the phones, which re-send anything queued on their next sync.

**Two things worth knowing about the weekly run:**
- **It uses a little Drive space.** Each copy counts toward your Google storage (and trashed ones keep counting ~30 days), but this sheet is well under a megabyte, so eight copies is a few MB — nothing. It only matters if your Drive is *already* full: then the copy fails.
- **If a Monday ever fails, Google emails you** ("Summary of failures for Google Apps Script") — that email is the alarm, so don't filter it away. A 20-second habit covers the rest: open the **Octogo Tracker Backups** folder once a month and check the newest name carries a recent date.

## Read it from the paper (optional, set up once — ≈5 min)

Mama writes the night on paper before anything is typed in. This lets the app **photograph that page and fill the Sales form in from it**, so the typing becomes checking. Like the backups, it is a **separate little script** on purpose, and for two reasons: reading a photo needs permission to make internet requests and to keep files in Drive, and permissions in Apps Script are granted **per project** — keeping this out of the sheet's own script means it can never affect the app the phones use. It also keeps the secrets apart: this project holds a **Gemini API key**, which costs money if it leaks, and the sheet's token — the one that writes money — must never be typed in here.

1. Get a free key: [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key**. Copy it. (Google's free tier is generous; a photo a night is nowhere near it.)
2. Go to [script.google.com](https://script.google.com) → **New project** → name it **Octogo Vision**.
3. Delete the placeholder code, paste in the whole of `standalone-scripts/Vision.gs` from this project.
4. Fill in the **two** constants at the top:
   - `GEMINI_API_KEY` — the key from step 1.
   - `VISION_TOKEN` — invent a **long random string of its own**. **Never the sheet's token.** Two doors, two keys: if this project is ever compromised, the worst it can do is read photographs — it has no way to reach your sheet at all.
5. **Save** (the disk icon, or ⌘S/Ctrl+S). A deployment serves the *saved* code, so this matters.
6. Choose **`visionCheck`** in the toolbar dropdown → **Run** → approve the prompts (it asks for Drive because it keeps every photo, and for internet because it does the reading). You will likely get the **"Google hasn't verified this app"** screen — that is just because *you* wrote this script; choose **Advanced → Go to Octogo Vision (unsafe)**, exactly as you did for the tracker. The **Execution log** then prints one line saying whether each constant is set (it prints their *lengths*, never the secrets themselves) and which Drive folder the photos will go to.
7. **Deploy → New deployment → Web app**, Execute as **Me**, Who has access **Anyone** → **Deploy** → copy the `/exec` URL. (Same as the tracker: "Anyone" only means the phone doesn't have to sign in — this app checks its own token before it does anything.)
8. On each phone: **More → Read it from the paper** → paste that URL and the `VISION_TOKEN` → tap **Test the photo reader**. **Do this before taking a single photo:** the test asks the reader whether it is set up and **spends no Gemini quota at all**. It should say it answered, with its version and which model it is reading with. If it says it has no key in it yet, the key did not save — go back to step 4.

Both fields blank on a phone (which is how every phone starts) means the feature simply **is not there** — no button appears on the Sales screen. Both are needed: a URL with no token would only ever be refused.

Every photo is kept in a Drive folder called **"Octogo Sales Photos"**, named by the night, and a night read this way stores the link beside it — so any figure can be taken back to the page it came from, months later. The photo is kept **before** the reading is attempted, so even a failed reading leaves the paper on file.

> **What this is, plainly.** It is a helper, not an authority. It reads handwriting with a machine, and machines misread handwriting. **The numbers are yours to confirm** — that is the whole design: it fills the form, marks it as unconfirmed, prints what it read and what it could not, and then waits for the ordinary **Save day**, with every refusal and every check the app has always done still in force. It can never save a night by itself, move a figure, or touch the cutoff note. And **typing the night in by hand is always still there** — every refusal it can give you says so, because on a night with no signal, no quota or no key, that is the way through.
>
> **If it ever says a constant is "still PASTE_…" even though you typed it**, the message lists the three real reasons: the file was not **saved** before you pressed Run; the project has **two files** containing this script (look at the file list on the left and delete the spare — every file shares one namespace, so the other one wins); or the value went somewhere other than the `var GEMINI_API_KEY =` / `var VISION_TOKEN =` line. Run **`visionCheck`** any time to see what the saved code really holds.

**The sheet's own script gains nothing from any of this.** It grows one column, `photo_url` on DailyLog — a link, and nothing else. It asks for no new permission, never sees a photograph, and no figure anywhere is computed differently.

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
3. `gh secret set CLASPRC_JSON < ~/.clasprc.json --repo <you>/inventory-and-sales`
4. `SCRIPT_ID` — Apps Script → **Project Settings → Script ID**. Container-bound scripts do **not** appear in `clasp list-scripts`, so read it from the editor.
5. `DEPLOYMENT_ID` — run `clasp list-deployments`. You'll see two: an `@HEAD` dev deployment and your versioned web app. **Pick the versioned one** — confirm by opening its `/exec` URL; the right one returns the ping JSON, the `@HEAD` one shows a Google sign-in page.

> Without `DEPLOYMENT_ID` the workflow deliberately pushes the code but leaves it unpublished and warns you — better than minting a new URL and silently stranding the phones on the old API.
>
> `CLASPRC_JSON` is a Google credential for your Apps Script projects, held in GitHub's encrypted secrets. It means a push can change the live script that touches your money data — the test gate runs first and only that one deployment can ever be updated, but it is a real increase in blast radius. To back out: delete the secret (the app half keeps auto-deploying) and run `clasp logout`.

## How the phones update

Nothing to do — the app updates itself. When a new version is published, the next time the app is opened it swaps over automatically.

It deliberately **waits** if Mama is mid-entry: a half-typed day is never interrupted, and the update applies after she saves or the next time the app is opened. Nothing queued is ever lost across an update.

To confirm which version a phone is on: **More → About**. Current release: **app 2.9.6**, **script 2.9.6**.

## Updating by hand (if you skip the automation)

The app has **two halves that must be updated separately** — the script in the sheet, and the files on the web host. A change to one usually needs the other, so do both. Takes about 5 minutes.

Current versions: **script 2.9.6**, **app 2.9.6**. You can check what each phone is actually running under **More → About**.

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

Each phone caches the app so it works offline. On an open with signal, the app quietly downloads the update and **reloads itself** so the new version lands on that same open (it politely waits if a day is half-typed). If **More → About** still shows the old version, close it fully — swipe it out of the app switcher — and open it once more.

Check **More → About** shows the new version. If it still shows the old one, close it fully and reopen once more.

**Nothing is lost during an update.** Anything not yet synced stays in the phone's queue and sends once the new version loads. Your token and API URL stay put — you won't have to type them again.

## Changing prices or adding a product

No update needed — edit the **Prices** tab of the sheet directly, then hit **Sync now** on the phones. New prices apply to future days only; days already saved keep the price they were recorded at, so your history never shifts.
