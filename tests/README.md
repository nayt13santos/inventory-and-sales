# Tests

Run everything:

```bash
node run-all.js
```

Two suites, both loading the **real** `apps-script/Code.gs` into a Node VM with Google Apps Script stubs (`gas-stubs.js`) — no mocks of the logic under test.

**`run-tests.js`** — the backend on its own: exact cutoff-note text (both the `Remaining` and the `Short` branch), cutoff maths and the accounting identity, salary snapshotting and the blank-cell fallback, the entered Split and its default, the computed stock ledger (baseline, deliveries, stocktakes, the reorder warning), the Maintenance writers, the DailyCounts grid-capacity boundary (the case that could once wipe per-item history), calendar-date validation, Cutoffs upsert, idempotent replays, price snapshots, and the backlog seeds.

**`contract.test.js`** — the seam between the two halves, and the reason it exists: the "cheese total is ₱0" bug shipped because the server sent `cheesePrice` while the app read `cheese_price`. Each half was well tested alone; nothing tested the join. This suite drives real `doPost` calls, takes the actual JSON responses, and pushes them through the actual PWA functions lifted out of `pwa/index.html`, asserting on pesos rather than shapes — a Box 4 day with 10 sold and 2 cheese must come to 8×₱50 + 2×₱60 = ₱520 on both sides. It also pins the deliberate asymmetry in the contract: **requests are camelCase, responses are snake_case** (see SPEC.md), and proves the app still reads an older camelCase deployment without zeroing money.

If you change a field name on either side, `contract.test.js` fails. That is its whole job — verified by reintroducing the original bug, which turns 9 assertions red.

### The cutoff seam while the two halves are mid-release (v2.3.0)

The note format, Split and Salary changed on the **server** in 2.3.0. Until the PWA ships its half, its local preview still uses the old model (Split as the residual, no Salary), so `assertCutoffSeam()` asserts what is true of both halves at once:

1. every figure the phone computes itself (`total`, `cash`, `gcash`, `mama`, `supplies`, `octopus`, `other`, `electric`) must equal the server's **to the peso** — this is the assertion that would have caught retiring DailySupplies desyncing the `Supplies` line;
2. the phone must be able to READ `note_text` and the `split` / `per_partner` / `salary` / `remaining` figures — the server is authoritative for those and the phone displays them;
3. **and** the moment the phone's own model exposes a residual, the two notes must match byte for byte again. That third branch arms itself when the PWA lands its half — it is a mid-release bridge, not a permanent exemption.

Both suites still pin the SERVER note byte-exactly against the SPEC sample.

### Proving a test bites

Every 2.3.0 behaviour was verified by mutation: 32 single-behaviour reverts (drop the Salary line, let the residual print `- -2,000`, make Split the residual again, clamp a negative `on_hand`, coerce a blank `opening_date` to today, ignore stocktakes, let `saveSettings` write the token, …) applied to a **scratch copy** of `Code.gs` — never the repo. All 32 turned at least one test red. The three that initially slipped through are now covered: a blank salary on a *closed* legacy row, `saveStockItems` resetting a hand-typed baseline, and `setupSheet` overwriting an edited stock unit.

The v2.4.1 server guards (section 20 of `run-tests.js`) were verified the same way — eight single-behaviour reverts on a scratch `Code.gs`, each red on at least one test, and each of the three findings red on its OWN test:

| revert | reds |
| --- | --- |
| classify history by the CURRENT Prices flag (v2.4.0 behaviour) | 4 — the two flip tests, the byte-identical note after a flip, the seam |
| never write the `in_cutoff` snapshot onto the count row | 9 |
| a blank snapshot falls back to TRUE instead of the sku's flag | 1 |
| a blank snapshot falls back to FALSE | 2 |
| guard `gcashQty` only, as v2.4.0 did | 1 — the bucket test, on the cheese message |
| let `savePrices` take a `group=box` sku out of the cutoff | 2 |
| let `saveDay` save a day against an excluded `group=box` sku | 1 |
| drop `in_cutoff` from the DailyCounts schema | 45 |
| drop excluded money whose sku has left Prices | 1 |

Two of those reverts are the failure modes the release exists to prevent, so they are worth naming: the first one restates a fortnight that has already been sent (a ₱300 of nori vanishing from the excluded block while `total` never contained it), and "guard `gcashQty` only" is how a cheese bucket on an excluded sku had its money priced into `excluded_total` and taken straight out of the day's GCash.

The v2.4.1 PHONE guards (section 16 of `contract.test.js`) were verified the same way — **18 single-behaviour reverts on a scratch copy of the whole repo**, never the repo itself, each red on at least one test:

| revert on `pwa/index.html` | reds |
| --- | --- |
| `computeDay` prices an excluded sku's cheese buckets again | 1 |
| `computeDay` lets an excluded sku's GCash bucket through | 1 |
| `bentaPayload` sends an excluded sku's cheese buckets | 1 |
| `bentaPayload` sends an excluded sku's GCash bucket | 3 |
| `validateBenta` stays silent about a bucket on an excluded sku | 2 |
| `validateBenta` words the refusal differently from the server | 1 |
| `normCount` drops the `in_cutoff` snapshot | 5 |
| `excludedForPeriod` classifies history by the LIVE flag (v2.4.0) | 4 |
| a blank snapshot reads TRUE instead of the sku's flag | 1 |
| a blank snapshot reads FALSE | 2 |
| `applyLocalDay` does not snapshot the flag onto the row it saves | 2 |
| `applyServerDay` ignores the server's per-line snapshot | 1 |
| `excludedForPeriod` drops excluded money whose price row has gone | 1 |
| `renderBenta` shows a cheese price on an excluded box sku | 1 |
| `priceRowError` lets Maintenance take a box sku out of the cutoff | 1 |
| the receipt prints the excluded block on every night again | 1 |
| the day strip shows no tin figure | 1 |
| the day strip shows the tin on every night | 1 |

The last three are the F4/F5 noise findings: `excludedLines` holds a nori line on EVERY night, so the receipt printed a dead "Nori ×0 — not in the total ₱0" and the tautology "Cash in the tin: ₱825 + ₱0 Nori = ₱825" on every ordinary one. `excludedTonight()` is the single rule both the receipt and the strip read, which is why one revert of it turns up in both places.

Three of the phone's guards are pinned against the **source** rather than a rendered DOM (the renderers need one): that the receipt and the strip both call `excludedTonight`, that the tin line sits inside that guard and still below Total/GCash/Cash, and that an excluded card renders `showCheese` rather than `isBox`. The money itself is asserted through the real `computeDay` / `validateBenta` / `excludedForPeriod`, and the wording of both refusals is asserted **equal to the string the real server returns** for the same day.

### The v2.5.0 fix campaign, mutation-proofed

The two v2.5.0 checkpoints (`815511e` backend, `700c76b` frontend) enumerate the fixes for the 42-finding hostile campaign (`TESTING-REPORT.md`). Every behaviour they name was reverted **one at a time on a scratch copy of the whole repo** — never the repo itself — with both suites run after each revert (baseline 126 + 132). **All 42 reverts turned at least one test red; none survived.**

The 14 tests of `contract.test.js` **section 17** were added in this pass to close the gaps the fixers left untested: the sync-engine races (a new `loadSyncClient` lifts the REAL `enqueue` / `drainQueue` / `doBootstrap` / `api` with the wire, the clock-free storage and every toast under test control, so a reply can be held in the air while the test keeps typing), the client-side price snapshot (`storedPricesFor` / `priceOnDay` through the real `computeDay`), the phone's date refusals byte-compared against the live server's own sentences, and the small details (`fmt(-0)`, prototype-safe lookups, the sequential receipt clamp, the attention-storage failure). Four DOM-bound guards (tear-off dirty check, the two confirms, error-cards opening) are pinned against the source, the same way section 16 pins its screen guards.

| revert (one behaviour each) | reds — first test that bites |
| --- | --- |
| split: archived-Cutoffs fallback in the resolution order | 1 — the split remembers the period: entered row, then the ARCHIVED split, then the default |
| split: snapshot written on generate | 1 — the split remembers the period (the writes-one-row assertion) |
| salary backfill of blank legacy cells at migration | 3 — setupSheet backfills BLANK salaries on open rows (+2 migration pins) |
| per-date price snapshots reused on re-save (server) | 1 — re-saving a date reuses THAT DATE's stored prices; a new sku uses current |
| blank in_cutoff reads TRUE | 14 — across both suites |
| case-insensitive trimmed header matching | 1 — headers match case-insensitively and trimmed |
| refuse to migrate a non-empty tab with no recognizable headers | 1 — migrateTab REFUSES a non-empty tab with no recognizable headers |
| seeds only on tab creation | 2 — setupSheet never resurrects a deleted row; no nori planted into a live Prices tab |
| duplicate Prices rows: first wins | 1 — duplicate Prices/DailyLog rows: the FIRST wins |
| duplicate DailyLog rows: first wins | 1 — same test, its DailyLog half |
| saveDay refuses a blank price on an active sku | 1 — saveDay refuses a BLANK price on an ACTIVE sku, naming it |
| DailyLog written last | 1 — a mid-save crash leaves no day that looks complete |
| negative-category refusal at generate | 1 — a NEGATIVE category refuses the real note, naming the rows |
| loose sheet dates normalized on read | 1 — hand-typed dates are NORMALIZED on read |
| future/pre-2020 event dates refused | 2 — the server test AND the phone's byte-compare of the same sentences |
| branch CR/LF stripped | 1 — branch strips CR/LF on both paths |
| null-body guard | 1 — a null body gets the friendly error |
| whole-peso splits | 1 — the split is WHOLE PESOS |
| superseded in-flight reply dropped whole | 1 — a reply that lands after its save was superseded is dropped whole |
| superseded refusal leaves no rejection card | 1 — a refusal of a superseded payload leaves no rejection card |
| stale bootstrap discarded (mutation stamp) | 1 — a bootstrap reply is DISCARDED when a local mutation postdates the request |
| deleting an expense clears its attention entries | 1 — deleting an expense clears its attention entries and its queued save |
| attention persistence failure is visible | 1 — a failed attention write is SAID out loud, never silent |
| legacy gcash card no longer claims not-in-the-sheet | 1 — a legacy-GCash day is NOT "not in the sheet", and its card says so |
| only a rejection means "not in the sheet" | 2 — the save toast is never a claim that outran the server (+1) |
| visible = sent (stale excluded buckets sent, not zeroed) | 3 — an old bucket on an excluded sku is refused with a stepper to fix it (+2) |
| refusal keeps the server sentence byte-exact as its prefix | 1 — the phone refuses a bucket on an excluded sku in the SERVER's own words |
| zeroing the stale bucket frees the day | 3 — the stepper test's clean-row-must-save half (+2) |
| box+excluded stays refused on the phone | 1 — an excluded box sku is refused inline instead of losing its cheese counts |
| date input clamps to today (max attribute) | 1 — the phone refuses the dates the server refuses |
| partial/future date never commits (snap back on change) | 1 — same test, the change-handler pins |
| entryDateError refuses a future date | 1 — same test, behavioural half |
| the cutoff one-tap never dates into the future | 1 — the cutoff one-tap dates money into the period, never into the future |
| preview says when it cannot see a whole period | 1 — the preview says when this phone cannot see a whole period |
| computeDay prices a day at its stored snapshot | 1 — reopening a saved day shows the money it was SAVED at |
| storedPricesFor is prototype-safe | 1 — a sku or product named like an Object property cannot poison a lookup |
| nothing typed during the tear-off is lost | 1 — save day: typed work survives the tear-off (source pin) |
| error-holding cards open themselves | 1 — same test (source pin) |
| an all-zero save asks one plain confirm | 1 — same test (source pin) |
| closing a day with sales asks one plain confirm | 1 — same test (source pin) |
| receipt clamps buckets in sequence, never past sold | 1 — a half-typed row renders a receipt that still adds up to sold |
| fmt() never renders -0 | 1 — fmt never prints -0 |

The three races are worth naming, because they are the campaign's critical #4 and #5: a superseded reply applied anyway stamps **old money over a correction while the pill says "Synced"**; a superseded refusal leaves a **permanent false "not in the sheet" card** whose retry replays stale figures forever; and a stale bootstrap applied after a mid-flight save **deletes the just-saved day from the phone**. Section 17's async tests hold the actual reply in the air (the wire is a promise the test releases) while the real `enqueue` coalesces past it — no simulation of the engine, the engine itself.
