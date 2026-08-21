# Tests

Run everything:

```bash
node run-all.js
```

Two suites, both loading the **real** `apps-script/Code.gs` into a Node VM with Google Apps Script stubs (`gas-stubs.js`) — no mocks of the logic under test.

**`run-tests.js`** — the backend on its own: exact cutoff-note text (both the `Remaining` and the `Short` branch), cutoff maths and the accounting identity, salary snapshotting and the blank-cell fallback, the entered Split and its default, the computed stock ledger (baseline, deliveries, stocktakes, the reorder warning), the Maintenance writers, the DailyCounts grid-capacity boundary (the case that could once wipe per-item history), calendar-date validation, Cutoffs upsert, idempotent replays, price snapshots, the backlog seeds, and — v2.8.0 — the `costing` arithmetic against hand-computed figures, with the two fences that make it safe (a restock counted once, and a cutoff note byte-identical whether costs are on file or not).

**`contract.test.js`** — the seam between the two halves, and the reason it exists: the "cheese total is ₱0" bug shipped because the server sent `cheesePrice` while the app read `cheese_price`. Each half was well tested alone; nothing tested the join. This suite drives real `doPost` calls, takes the actual JSON responses, and pushes them through the actual PWA functions lifted out of `pwa/index.html`, asserting on pesos rather than shapes — a Box 4 day with 10 sold and 2 cheese must come to 8×₱50 + 2×₱60 = ₱520 on both sides. It also pins the deliberate asymmetry in the contract: **requests are camelCase, responses are snake_case** (see SPEC.md), and proves the app still reads an older camelCase deployment without zeroing money. Since v2.8.0 it renders the costing screen's real markup from the real `costing` reply, and holds the sharpest version of the blank-is-not-zero rule: a cost cell that arrives as 0 is written back into the owner's sheet on his next Maintenance save, so every leg of that round trip is pinned.

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

### The v2.5.1 verifier round, mutation-proofed

The independent verifier re-ran every v2.5.0 finding and five survived: the stock carry floor undoing every local reduction, a queued first save re-priced in flight, an `in_cutoff` flip restating a saved day on re-save, a drained backlog payment counted nowhere, and a cleared wage written as ₱0 — plus the fallback note printing the very line the server's refusal exists to prevent, and the split-refusal toast blaming an expense. `contract.test.js` **section 18** covers all of them (the sync ones through the real `enqueue`/`drainQueue`/`doBootstrap` against the real server; `generateNote`'s two stops are source-pinned like the other DOM-bound guards, with the byte-compare of `noteRefusal` against the live server's sentence carrying the behavioural weight).

Every new behaviour was reverted **one at a time on a scratch copy of the whole repo** — never the repo itself — with both suites run after each revert (baseline 126 + 140). **All 18 reverts turned at least one test red; none survived.**

| revert (one behaviour each) | reds — first test that bites |
| --- | --- |
| phone: reinstate the carry floor (top local sums back up to server totals) | 1 — a local stock reduction moves on-hand at once |
| server: bootstrap stops splitting the ledger totals at window_start | 1 — deliveries older than the bootstrap window still count |
| server: a first save ignores the payload's displayed prices | 1 — a save queued through a price change lands at the money the tin showed |
| server: a re-save ignores the stored in_cutoff snapshot | 1 — flipping "Counts in the cutoff" cannot move a saved day |
| server: a first save ignores the payload's inCutoff flag | 1 — same test (the queued-through-the-flip night) |
| server: storedPricesFor drops the in_cutoff snapshot | 2 — the flip test + the v2.5.0 stepper test |
| phone: bentaPayload stops carrying the displayed snapshot | 3 — the re-emitted-REQUEST pin, the queued-night test, the flip test |
| phone: computeDay classifies a loaded day by the LIVE flag | 1 — the flip test (Sales screen says ₱700) |
| phone: validateBenta judges by the LIVE flag | 1 — the flip test (refuses a day the server accepts) |
| phone: sentBuckets reads the LIVE flag | 1 — the flip test (stray cheese silent-zero half) |
| phone: the Sales card renders by the LIVE flag | 1 — the screens-show-nori-apart source pin |
| phone: storedPricesFor drops the in_cutoff snapshot | 2 — the flip test + the client price-snapshot test |
| phone: the drain no longer re-bootstraps after landing work | 1 — a drained backlog payment stays subtracted |
| phone: a blank standing amount travels as 0 again | 1 — a cleared "Wage per day" never writes ₱0 |
| phone: a server refusal falls back to the local note again | 1 — a refused note is refused on the phone too |
| phone: the demo/offline note skips the local refusal | 1 — same test (the demo-build pin) |
| phone: noteRefusal never refuses anything | 1 — same test (the byte-compare against the live server) |
| phone: a refused split is toasted as an expense again | 1 — a refused split is announced as a split |

Two of these reverts are the money-movers the round exists to prevent: "a re-save ignores the stored in_cutoff snapshot" is one Maintenance tick restating a fortnight that has already been sent the moment the day is re-saved for a note edit, and "a first save ignores the payload's displayed prices" is a queued night booked ₱100 above what is physically in the tin, with nothing said.

### v2.6.0 — receiving stock is its own action, mutation-proofed

Suppliers deliver on credit, so v2.6.0 separates goods arriving from money leaving: **`saveStockDelivery`** ("Stock came in" under More → Stock on hand) records a quantity with no money anywhere near it, **`saveExpense` refuses** a payload that still names stock (one plain sentence, nothing written), and legacy expense-attached rows keep counting into on-hand forever. `run-tests.js` grew 126 → 132 and `contract.test.js` 140 → 145; the two v2.5.1 stock-ledger tests now seed their deliveries through the new door — every behaviour they pinned is unchanged, and each also keeps a hand-placed legacy row in play so the old door stays covered.

Every new behaviour was reverted **one at a time on a scratch copy of the whole repo** — never the repo itself — with both suites run after each revert. **All 15 reverts turned at least one test red; none survived.** Three of them only bite because the round found the hole first and the test was added before its revert: a queued delivery was silently dropped from the replay map, a delivery hand-deleted in the sheet lingered on the phone, and the app-restart restore (`sanitizeState`) rebuilt the mirror without its deliveries. (One revert had to be sharpened, not the test: keying the upsert on `updated_at` too is a no-op under the stubs' frozen clock — the honest "forgot the upsert" mutant is empty key columns, an unconditional append.)

| revert (one behaviour each) | reds — first test that bites |
| --- | --- |
| server: saveExpense accepts stock fields again | 1 — saveExpense REFUSES new stock fields in one plain sentence |
| server: bootstrap stops shipping stockDeliveries | 11 — a delivery with NO money raises on hand |
| server: the ledger ignores StockDeliveries rows | 13 — a BLANK opening_date counts the WHOLE history |
| server: the ledger ignores legacy expense-attached rows | 5 — a LEGACY delivery keeps counting forever |
| server: deliveries no longer split at window_start | 2 — delivered_before carries BOTH doors |
| server: a replayed delivery books twice (append, no upsert) | 1 — a replay never books a delivery twice |
| server: a delivery of 0 accepted | 1 — at least 1 whole unit |
| server: the reply's on_hand goes camelCase | 6 — a delivery with NO money raises on hand |
| server: the StockDeliveries date column loses its plain-text format | 1 — setupSheet creates StockDeliveries with plain-text date columns |
| server: hand-typed loose dates no longer normalized on read | 1 — a hand-typed loose date on a StockDeliveries row is normalized |
| phone: the ledger ignores "Stock came in" rows | 4 — the phone computes the SAME on-hand figure the server did |
| phone: a local delivery appends instead of upserting by entry_id | 1 — a local stock reduction moves on-hand at once |
| phone: an app restart drops the delivery mirror (sanitizeState) | 1 — the delivery mirror survives an app restart |
| phone: the replay map loses saveStockDelivery | 1 — a QUEUED delivery survives a bootstrap that lands before it drains |
| phone: the bootstrap merge keeps deliveries deleted in the sheet | 4 — a delivery deleted in the sheet disappears from the phone (+3) |

The money-mover here is the first revert: with it, "10 flours arrived, not paid yet" forces a price onto unpaid goods again — the exact flaw the owner reported — and the same quantity can enter on-hand through two doors at once.

### v2.7.0 — the nightly screen, mutation-proofed

The eight owner-locked items: reorder-point backfill, the supplies picklist (category hidden when obvious), SOD prefilled from the previous close, **`gcashConverted`** (tin cash swapped for a GCash transfer — moves the split, never the Total, refused past the day's cash), the lid-box count (never money), **`customBoxes`** (a special order draws whole boxes off the counted stack; priced qty = sold − custom), and the three-section Sales screen. `run-tests.js` grew 133 → 146 (section 23) and `contract.test.js` 148 → 156 (section 19, including the CONTRACT pairs for `gcash_converted`/`lid_boxes` on days and `custom_qty` on counts and saveDay lines, both directions). Fifteen existing pins moved with the appended columns and the backfill — each re-anchored deliberately, never loosened (the three that changed *meaning*, not just width, carry an explicit `PIN MOVED (v2.7.0, deliberate)` source note): the migration pins now assert the *wider* header rows and the still-blank appended cells byte-for-byte, and the blank-reorder-point round trip keeps its blank-stays-blank teeth on the three products the backfill does not name.

Every new behaviour was reverted **one at a time on a scratch copy of the whole repo** (rsync, never the repo itself) with both suites run after each revert. **All 13 reverts turned at least one test red; none survived.**

| revert (one behaviour each) | reds — first test that bites |
| --- | --- |
| server: gcashConverted dropped from gcash | 3 — gcashConverted moves the split only: total untouched, Total = Cash + GCash holds |
| server: the cash-floor refusal removed | 2 — the cash floor: converted cash above the day's cash is refused naming both figures |
| server: customBoxes stops reducing priced qty (the double-count) | 4 — special-order boxes price sold − custom, and the snapshot rides the row |
| server: the bucket bound forgets the custom qty | 1 — the bucket bound counts the special order — and keeps the old wording when there is none |
| server: excluded-sku customBoxes accepted | 1 — an excluded sku and a non-box sku cannot feed a special order |
| server: lidBoxes gains money (added into total) | 3 — lidBoxes is stored and shipped, and moves no money anywhere |
| server: the backfill overwrites a hand-set reorder_at | 2 — re-running setupSheet never resets an edited stock unit |
| phone: the prefill reads the SAME day's EOD (`d <= date`) | 1 — SOD prefill: a fresh date opens at the previous close; a saved day loads its own |
| phone: the picklist stops setting the category | 1 — the supplies picklist crosses the seam, and picking files under Supplies |
| phone: normDay drops gcash_converted | 4 — the new figures survive the whole seam |
| phone: bentaPayload stops sending customBoxes | 3 — the new figures survive the whole seam |
| phone: gcashHeld ignores the converted cash | 1 — the GCash card starts collapsed only when every figure in it is 0 |
| server: supply_picklist dropped from the saveSettings whitelist | 1 — supply_picklist: seeded, added on migration, whitelisted, and an edit survives setupSheet |

Two of these reverts are the money-movers the release exists to prevent: "customBoxes stops reducing priced qty" books a special order's boxes **twice** — once at menu price and once as the typed amount — so the night reads richer than the tin; and "gcashConverted dropped from gcash" saves a split the GCash app will never reconcile against, on the one figure that exists to be reconciled. The old-payload guarantee has its own pins on both sides: a pre-2.7.0 saveDay computes byte-identical totals and a byte-identical note (`run-tests.js` 23), and a queued pre-2.7.0 day drains through the real `enqueue`/`drainQueue` and lands byte-identical to the explicit defaults (`contract.test.js` 19, async).

### v2.7.1–v2.7.4 — four owner-driven releases, and the gate that caught STOCKIN-1

Four same-day releases reshaped the owner-facing forms: the expense form became one bucket row (v2.7.1), "Stock came in" lists every product with a stepper (v2.7.2), the conversion went two-way and signed (v2.7.3), and the Cutoff screen gained the computed "Stock this cutoff" block (v2.7.4). `contract.test.js` grew 156 → 160 (`run-tests.js` holds at 146 with pins moved deliberately: the conversion's "negative refused" became the cash-out direction's own arithmetic and floor, byte-exact).

Scratch-copy mutation reverts across the four, ALL red: bucket files as Supplies / item name dropped / colliding bucket name offered (v2.7.1); one shared entryId collapsing a multi-product delivery (v2.7.2); each conversion floor removed and the sign path dropped (v2.7.3); the cutoff card unwired and its period filter dropped (v2.7.4).

A 34-agent hostile gate then swept all four surfaces (buckets, conversion, cutoff card and every standing regression came back clean — 50 checks) and **confirmed STOCKIN-1, 3/3 skeptics**: the v2.7.2 arrival form kept quantities in a bare index-parallel array resolved against `activeStockItems()` at SAVE time, so a stock-list change while the form was open (a Maintenance save, a background sync) silently booked a quantity typed on one product against a DIFFERENT product — the probe watched 5 packs of Flour become 5 gallons of Sauce, with no error anywhere. Fixed the way the Sales screen's stock card always worked: rows SNAPSHOT their `{product, unit, qty}` when the form opens and resolve by the name they carry. The regression test drives the real `arriveStep`/`saveArrival` through the sync harness (new slabs `S_ARRSTATE`/`S_ARRFNS`), reproduces the gate's exact scenario, and the live-list-resolution mutant turns it red.

### v2.7.5 — backups in their own project, and the sheet checker

`run-tests.js` 146 → 152 (section 24). The release adds a **standalone** backup project (`apps-script/Backups.gs`) and `sheetCheck`, a pure-read integrity audit surfaced as More → "Check the sheet".

The separation is itself a pinned behaviour: one test reads `Code.gs` and fails if `DriveApp`, `ScriptApp`, `MailApp`, `GmailApp` or `UrlFetchApp` ever appears in it, because Apps Script grants permissions per project and the bound project serves the phones — growing its permission set can break an ordinary night's save until the owner re-authorises. `gas-stubs.js` grew a fake Drive (named folders of named files, trashing) and a trigger registry so the backup logic is exercised for real rather than mocked, and `loadBackups()` runs the standalone file in its own VM context with the sheet id filled in the way the owner fills it.

Five scratch-copy reverts, all red: a `DriveApp` call reintroduced into `Code.gs` (the fence); the trigger cleanup removed so schedules stack; the prune order flipped so it trashes the NEWEST copies; the placeholder-id guard removed so it arms against nothing; and the duplicate-day scan dropped from the checker. A sixth, on the phone, proves the findings stay escaped (they carry product and item names straight from the sheet).

**The v2.7.5 gate** (29 agents, two dimensions no local stub can reach) found the checker **clean on false positives** — twelve reproductions of the live sheet's shapes (legacy blank cells, closed days, pre-2.6.0 expense-attached deliveries, retired tabs, filler rows, inactive zero-price rows, nori, loose-but-parseable dates) all returned an empty findings list, and all 22 promised damage classes fire. It confirmed two gaps worth the release:

- **SC-1 (major)** — the audit never asked whether a date cell *is* a date. `asDateStr` normalises the shapes it knows and returns anything else verbatim, so a hand-retyped `28-07-2026` survives into every reader as a date; period filters are string compares, so that row's money falls outside **every** cutoff forever while nothing complains. Section 7 of `apiSheetCheck` now checks the shape across all eight date-bearing tabs, and the test proves the money really is invisible first (`supplies: 0`) before asserting the sentence. Two reverts red: the section removed, and the shape test blunted to accept anything.
- **GAS-1/2 (backups)** — the Apps Script editor never displays a return value, so a *successful* `setupBackups` printed nothing while a failure printed a red stack; both functions now `Logger.log` their result. And `atHour(6)` is read in the **script project's** timezone — a project the owner creates fresh, rarely Manila — so the trigger is now pinned with `.inTimezone(TZ)`, asserted through the stub's recorded timezone. The gate's refuted GAS-3 still improved the design: the project reads the sheet's name through `DriveApp.getFileById(...).getName()` and never touches `SpreadsheetApp`, so it asks for no permission to read spreadsheet content at all — pinned both ways (`DriveApp.getFileById` present, `SpreadsheetApp.` absent).

### v2.7.6 — the Cutoff screen names what is missing

`contract.test.js` 162 → 163. A note is built from the days that exist, so an unlogged night reads as a lean night: the owner's real Aug 7–15 gap (nine days, no entry) made a fortnight preview say **Short** with nothing on screen explaining why. `missingDaysInPeriod` now lists those dates on the Cutoff screen with **Enter it** / **Was closed**, and a period with no purchases at all gets its own line.

The test measures everything against the CLIENT's own `todayStr()`, because its first cut hardcoded dates and went red when the system clock rolled past midnight mid-session — the exact bug class the rule itself guards. Four reverts, all red: the card unwired; a **closed** day counted as missing (it is an answer, not a gap); the walk allowed past today; and the `previewIncomplete` guard dropped, which would invent gaps out of history the phone does not hold. A fifth pin asserts `generateNote` never consults it — an unlogged day may be deliberate, so it is said, never enforced.

### v2.8.0 — "What it costs", mutation-proofed

`run-tests.js` 155 → 166 (**section 25**) and `contract.test.js` 163 → 178 (**section 20**, plus five CONTRACT loop pins for the `costing` response). The release is READ-ONLY management information, so the suites carry two kinds of test: the arithmetic, hand-computed figure by figure from a fixture built through the real doors (two open nights, one closed, the seeded costs), and the **fences** — the cutoff note and every figure in it byte-identical whether costs are on file or not, and `costing` proven a pure read against a full sheet snapshot.

Four existing pins moved with the two appended columns, each re-anchored deliberately and **widened, never loosened** (all four carry a `PIN MOVED (v2.8.0, deliberate)` source note): the two migration header pins now name `box_cost` / `unit_cost` in order *and* assert the backfilled values byte-for-byte, and the two Maintenance-writer row pins now assert that an ordinary price or unit edit leaves the cost cell **exactly as it was** — the omitted-means-leave-alone rule pinned on the very row such an edit rewrites. The two appended columns behave *oppositely* on purpose and both halves are pinned at the migration: `in_cutoff` stays blank (a blank reads TRUE, so the money stays in the cutoff) while `box_cost` is backfilled (a blank would mean "no cost known" and drop his boxes out of the costing).

The load-bearing rule has the first test in section 25 to itself: **a restock is consumption OR money out, never both.** The subtraction is a name match against the same StockItems list the consumption side prices from, so the fixture proves it shouted (`  JAPANESE MAYO  `), space-padded, filed under Octopus instead of Supplies — and proves it is a *name* match and not a guess (an expense called `flour` is not the product `Takoyaki Flour`, so its money stays in).

Every new behaviour was reverted **one at a time on a scratch copy of the whole repo** (rsync, never the repo itself) with both suites run after each revert. **All 25 reverts turned at least one test red; none survived.** Two of them had to be caught by *sharpening a test rather than the mutant*, and both are noted below.

| revert (one behaviour each) | reds — first test that bites |
| --- | --- |
| server: the restock is NOT subtracted from money out (the double count) | 3 — THE double-count guard: a restock is consumption OR money out, never both |
| server: a blank `unit_cost` is costed at 0 instead of listed `unpriced` | 2 + 1 — a cost NOT on file is listed and left OUT, never quietly costed at 0 |
| server: containers dropped from the variable total | 5 — the costing arithmetic, figure by hand-computed figure |
| server: fixed costs spread over ALL days, not the OPEN ones | 3 — costing spends the fixed costs on OPEN days only, never on a dark stall |
| server: a `simple` sku counted as one ball | 1 — balls come from size: a simple sku sells, prices and contributes none |
| server: excluded skus counted on both sides | 2 — an EXCLUDED sku is out of both sides — by the count row's own snapshot |
| server: every `null` per-ball / per-day figure returned as 0 | 1 + 1 — no balls and no open days give NULL, never a division by zero dressed as ₱0 |
| server: the backfill overwrites a hand-set cost | 1 — the cost backfills fill BLANK cells only, and re-running is a no-op |
| server: `savePrices` blanks `box_cost` when the key is absent | 2 — savePrices edits only price/cheese_price/active, and only the listed skus |
| server: `box_cost` dropped from the `prices` response | 7 + 5 — the costing arithmetic (and the whole seam) |
| server: `unit_cost` coerced with `asNum`, so a blank arrives as 0 | 2 + 2 — a cost NOT on file is listed and left OUT |
| server: `saveStockItems` writes 0 for an omitted `unitCost` | 2 — saveStockItems edits unit/reorder point/active and keeps the baseline |
| server: both negative-cost refusals removed | 1 + 1 — an omitted cost key leaves the cell alone; a negative one is refused by name |
| server: `savePrices` rounds the box cost (0.375 → 0.38) | 1 — same test (**the mutant survived the first pass**; the test now saves 0.375 *through the writer* and reads it back, instead of only pinning the seeded cell) |
| phone: `normPrice` coerces `box_cost`, so a blank becomes 0 | 1 — box_cost and unit_cost round-trip the normalizers — blank stays BLANK, 0.375 stays 0.375 |
| phone: `normStockItem` coerces `unit_cost` | 1 — same test |
| phone: `applyLocalPrices` applies an absent `boxCost` | 1 — a cost the payload does not mention is LEFT ALONE on the phone too |
| phone: `applyLocalStockItems` applies an absent `unitCost` | 1 — same test |
| phone: the Maintenance payload sends a blank `boxCost` as 0 | 1 — the Maintenance payload OMITS a blank cost field, on both cards |
| phone: the Maintenance payload sends a blank `unitCost` as 0 | 1 — same test |
| phone: a `null` renders as ₱0 instead of a dash | 1 — a NULL from the server is a dash with a reason, never ₱0 |
| phone: the per-sku label reaches the DOM unescaped | 1 — sheet data in the costing reply is escaped exactly once, label and name |
| phone: the stale target table stays under a figure it no longer answers | 1 — the target field never shows prices that answer a figure it no longer holds |
| phone: a blank target sends `targetPerDay: 0` | 1 — the costing section is wired, closed by default, and asks the SERVER for everything |
| phone: `costInvalidate` throws nothing away after a Maintenance save | 1 — the Maintenance payload OMITS a blank cost field (**the mutant survived the first pass**; the test now drives the real `costInvalidate` and asserts the answer is gone and the screen says so, instead of only counting its three call sites) |

Three of these reverts are the money-movers the release exists to prevent, and they are worth naming because each one would be read as *fact* off a screen the owner sets his prices from. The double count makes a fortnight's supplies read ₱600 too dear, so every margin on the screen is understated and he would raise prices he did not need to raise. Costing a blank `unit_cost` at 0 does the opposite and is worse: the total comes out quietly too low, every box looks more profitable than it is, and nothing anywhere says a figure is missing — which is exactly why an uncosted product is *named and excluded* instead. And a blank cost coerced to 0 anywhere on the round trip (`normPrice`, `applyLocal*`, the Maintenance payload, `savePrices`) does not merely display wrong: it is **written back into the sheet** on the next Maintenance save, so his own ₱120 pack of flour becomes ₱0 permanently, with no error and nothing to notice.

The seam section renders the **real** markup from the **real** server reply: two new slabs (`S_SKULABEL`, `S_COSTING`) lift `costingHTML` / `costFiguresHTML` / `costTargetOutHTML` / `costInvalidate` and the null helpers out of `index.html` whole, with `api()` throwing by default — because "no server" is a state this screen must survive without drawing a page of zeros. Four DOM-bound guards are source-pinned the way sections 16–19 pin theirs (the render call inside `renderIbapa`'s try/catch, the six `data-act` handlers asserted to be **both offered and handled**, the `targetPerDay`-only-when-typed payload rule, and the two Maintenance blank-omission lines with a check that neither is wrapped in `r2`).

### v2.8.0 — "What it costs", and the caveat that switches the advice off

`run-tests.js` 155 → 168, `contract.test.js` 163 → 179. The costing the owner asked for, computed by the app from what was logged: consumption (StockUsage × `unit_cost`) and money out (Supplies/Octopus **minus restocks of tracked products** — the load-bearing double-count guard) and containers (boxes sold × `box_cost`), never mixed; fixed costs spread over open nights; balls from sold × size; unpriced products named and left out rather than costed at 0; nulls, never zeros, at zero balls.

The release's most important behaviour came from running it over the owner's **real** logged data before shipping: over Aug 16–31, where he had logged no purchases yet, cost per ball read **₱1.57** instead of ~₱5.80 and the target table advised dropping Box 10 from **₱105 to ₱83**. An under-stated cost is the one direction that loses money, so `costing` now returns `caveats` and distinguishes their kind: a **floor** (no purchases logged, or a used product with no cost) empties `targets`; a **thin period** (days not entered) keeps the advice, because spreading the per-cutoff shares over fewer nights biases it the *cautious* way. Blank days count only to **yesterday** — tonight is not a gap at nine in the morning.

Five reverts on scratch copies, all red: the advice not withheld; the floor caveat silenced; a thin period wrongly withholding (8 red — it takes the advice away from every ordinary fixture); the blank-day walk including today (cries wolf daily); and the screen dropping the caveat card. That last one **survived the first pass** — the card had no test — and the hole was closed with a renderer test that also pins the caveat text is escaped once and that the wording matches whether the advice is off or merely cautious.
