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

`run-tests.js` 146 → 152 (section 24). The release adds a **standalone** backup project (`standalone-scripts/Backups.gs`) and `sheetCheck`, a pure-read integrity audit surfaced as More → "Check the sheet".

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

**The v2.8.0 gate (53 agents) found the costing model WRONG, and it was my design that was wrong.** Nine confirmed findings; the three that mattered:

- **MT-1 (critical)** — the double-count guard could never fire on anything the app itself writes. It matched an expense's `item` against StockItems product names, but the expense form writes BUCKET names ("Flour", "Box") and no bucket equals a product ("Takoyaki Flour"). So every sack of flour was counted twice (money paid AND flour opened) and **MT-2 (major)** every box twice (the Box bucket AND boxes sold × `box_cost`) — the critic's own probe measured cost overstated **~59%** on a fortnight logged the way the phone logs it. Fixed by *declaring* the mapping in Settings `costed_buckets` rather than guessing it: inference was rejected because guessing wrong the other way removes real money from the cost and makes a price look safe to cut. The set-aside total now ships as `variable.counted_per_unit` and is shown on screen, so the subtraction cannot read as a mistake.
- **MT-3 (major)** — the target factor was calibrated on TOTAL revenue but applied only to each sku's plain `price`, so cheese money and typed custom-order amounts never scaled: asked for ₱2,500 a night, the advised prices delivered **₱1,957**. Fixed by scaling the *scalable* takings only (revenue less custom orders) and applying the factor to the cheese price too. The test no longer checks algebra on paper — it SETS the advised prices, replays the identical nights and asserts the night really leaves the figure asked for (now exact to 10 centavos of rounding).
- **MIG-2 (major)** — the unpriced guard tested for a literally BLANK cell, so a hand-typed "₱120" or "12,50" fell to 0 through `asNum` and was costed at nothing with every honesty guard silent. Fixed at the reader: `costCell` treats anything that is not a finite figure ≥ 0 exactly like blank. Zero is still an answer.

Two screen findings closed too: a late-failing request for a period already navigated away from deleted the good answer on screen (the catch is period-guarded like the success path), and a negative target left the whole section mute (it is now said, and the section keeps rendering). Five reverts on scratch copies, all red: buckets unrecognised, the legacy ride-along row not set aside, cheese not scaled, custom money scaled, and junk coerced to zero.

Suites: `run-tests.js` 155 → 170, `contract.test.js` 163 → 180.

### v2.9.0 — "Read it from the paper", mutation-proofed

`run-tests.js` 170 → 203 (**section 26**, the standalone `Vision.gs`) and `contract.test.js` 180 → 202 (**section 21**, plus two CONTRACT loop pins for the `readSheet` response). The release photographs the page Mama already writes and pre-fills the Sales form from it, so the whole test story is about two things: **a machine reading handwriting must never be allowed to look more certain than it is**, and **nothing about it may save a night**.

Every Gemini reply in both suites is **canned**. No test makes a live call; `gas-stubs.js` grew a `UrlFetchApp` that records each request whole (so "the API key is in the HEADER, not the body or the URL" is an assertion and not a hope) and a `DriveApp.createFile` with a settable failure, because "the photo could not be kept" is a path the reading has to survive. The stub is present in **every** context on purpose: if `Code.gs` ever grew a `UrlFetchApp` call it would *work* here, so the source-level fence is the only thing holding that line and it has to be the thing that fails.

The cross-seam suite lifts the feature out of the shipped file whole — four new slabs (`S_BLANKS`, `S_SKULIST`, `S_LISTPHR`, `S_PAPER`) — and drives ONE photograph through **both projects**: a canned model reply → the real `Vision.gs` → the phone's own `normReading` → `applyReadingToForm` → the real `bentaPayload`/`computeDay` → the real `doPost`. The owner's own page is the fixture (`B4 | 31-28 | 1c = 60`, a Box 10 row, the crossed-out `2735 → 2605`) and its money is hand-computed in the source: **₱2,365 total, ₱1,470 GCash, ₱895 cash, ₱50 beside the day in the tin**. A wrong prefill is therefore a wrong *figure*, not a wrong shape.

Two pins moved with the appended `photo_url` column, both marked `PIN MOVED (v2.9.0, deliberate)` and **widened, not loosened** — they still name every DailyLog column in order, so a reorder or a rename is as red as it ever was: the migration header pin, and the appended-cells pin, which asserts `photo_url` stays **blank** on a historical row (a night saved before the column existed was typed in by hand and has no photograph anywhere). The self-healing writer pin gained the same column, asserted blank for the same reason.

Three behaviours have a test each because each one is the whole feature:

- **Blank is not zero.** An omitted field is how the structured-output schema lets the model say "I could not read this", and it stays empty from the reply to the box on screen. `"31 in, end of day unread"` must not show `Sold: 31`, and the unread overlap must not show `0`. A zero it really *did* read is a zero, and is not listed as unread — both halves asserted on the same reading.
- **The cross-check.** The page carries its own total in Mama's hand, so agreement is real evidence. Pinned in all four states: agreement, a mismatch that names the gap **in pesos** (`₱240 short`) and points at the row the reading was least sure of, the **excluded-money** case where the paper's total counts nori in and the two therefore *do* agree (crying mismatch there would be a false alarm on an ordinary night), and no-total-read, which claims nothing. A mismatch never blocks the save.
- **Nothing auto-saves.** Driven for real: one whole reading through the sync harness, asserting exactly **one** request left the phone, that it went to the reader's own URL with the reader's own token (and `notStrictEqual` the sheet's), that the queue is empty, that local state is byte-identical, and that the sheet is byte-identical — then that the ordinary `Save day` still lands the night. Backed by a source pin over the whole module: no `enqueue`, `saveBenta`, `persistState`, `drainQueue`, `applyLocalDay`; exactly one `fetch(`, and it goes to `config.visionUrl`; and the module never reads `config.apiUrl` or `config.token` at all.

Sixteen reverts, **one behaviour each, on a fresh scratch copy of the whole repo** (rsync, never the repo itself) with both suites run after each. **All sixteen turned at least one test red; none survived.**

| revert (one behaviour each) | reds — first test that bites |
| --- | --- |
| phone: the cross-check removed | 2 — THE CROSS-CHECK agrees: the paper's own total and the form's, in one sentence |
| phone: a mismatch reported as agreement | 1 — THE CROSS-CHECK names the gap IN PESOS and points at the rows it was least sure of |
| server: an unread field defaulted to 0 instead of blank | 1 + 2 — a HALF-READ row is BLANK, never 0, and every blank is NAMED in unread |
| phone: the reading auto-saves the day it just read | 2 — SOURCE PIN: the photo-reader module cannot save, queue or persist anything, then NOTHING AUTO-SAVES |
| server: the photo saved AFTER the model call | 2 — the photo is saved BEFORE the model is asked (a failed call would lose the paper) |
| server: the token check dropped | 2 — the WRONG TOKEN refuses without echoing the token or the key, and spends nothing |
| server: the key echoed back in a refusal (`scrub_` gutted) | 1 — a rejected KEY never appears in the refusal that reports it |
| phone: `photoUrl` absent from the saveDay payload | 2 — THE PREFILL, then the photo link travels the whole loop |
| server: the image cap removed | 1 — an image OVER the cap is refused BEFORE a byte of quota or Drive is spent |
| server: the DATE taken from the model instead of the phone | 1 — the model does not get to decide WHICH NIGHT this was |
| phone: an unknown sku accepted instead of dropped | 1 — the reading survives the phone's own normalizer |
| phone: the model's own remarks reach the DOM unescaped | 1 — everything the model says is escaped exactly once on its way to the screen |
| phone: excluded money treated as a mismatch | 1 — money kept OUT of the cutoff is not a mismatch — the paper counts the tin |
| phone: the card drawn on a phone with no reader configured | 1 — no photo reader configured = no button anywhere, and no request possible |
| phone: the over-cap refusal removed, so the ladder's last try is sent regardless | 1 — the phone never sends a photo the reader would refuse for its size |
| server: `photo_url` dropped from the `bootstrap.days[]` response | 1 + 5 — photo_url: the tracker stores the link and gains NOTHING else |

Four of these are the ones worth naming, because each would be read as *fact* off a screen the owner checks his night's takings against.

**An unread field defaulted to 0** is the worst thing this feature could do. A blank that becomes 0 looks like an answer nobody gave: an unread end-of-day count reads as "the whole shelf sold", and the total above it looks perfectly ordinary while it does. That is why the schema makes every field but `sku` optional — an *omitted* field is the model's way of saying "I could not read this" — why the phone re-applies the same rule on its own side rather than trusting the other one did, and why the screen has its own reader (`stepVal`/`uiVal`/`soldVal`) whose only job is to show an empty box as empty. The suite also pins the one blank that *invents* money out loud: a start count with no end count is called out by name on the cross-check card, and the sentence clears the moment the count is filled in.

**The cross-check removed, or a mismatch quietly accepted**, takes away the only independent witness there is. Nothing else in this feature can tell the owner that a machine read his handwriting correctly — the paper's own total, in Mama's hand, is a second source, and two sources agreeing is the same principle every other figure in this app rests on. Note what the mapping *cannot* get wrong: a night's total depends only on how many boxes were cheese altogether, so a misread of *which* cheese box was paid by GCash moves money between Cash and GCash and never changes the Total. That is asserted directly (total identical, cash different), which is exactly why an agreeing total is still evidence and why the payment split is printed in the form's own words for the eye instead.

**The photo saved after the model call** loses the paper on the one night it matters — the night the reading failed and there is nothing to check. And **the token check dropped** hands an unauthenticated caller both a Drive folder to fill and a metered API key to spend; the order in `doPost` (token first, before Drive, before Gemini, before anything costs anything) is asserted by counting the recorded requests as well as reading the refusal.

Suites: `run-tests.js` 170 → 203, `contract.test.js` 180 → 202.

### v2.9.0 — reading the paper, and the disaster the gate caught first

`run-tests.js` 170 → 203, `contract.test.js` 180 → 204. The 60-agent gate found four confirmed reading/cross-check defects — and its critic found a fifth that no finder did, which was the one that mattered most.

**The deploy would have broken every phone.** `.github/workflows/deploy.yml` runs `clasp push --force` from `apps-script/` with `rootDir "."`, so EVERY `.gs` in that folder lands in the BOUND project — and `Vision.gs` and `Code.gs` both define `doPost`. Every file in an Apps Script project shares one global scope, so one handler silently overwrites the other and every phone request hits the wrong one. (`Backups.gs` had been riding along since v2.7.5, harmless only by luck: no `doPost`, and its `TZ` matched.) The standalone projects now live in `standalone-scripts/`, and THE FENCE test grew into the deploy invariant: the pushed folder may hold exactly `Code.gs` + `appsscript.json`, exactly one pushed file may define `doPost`, and no pushed file may name a permission-bearing service. Copying `Vision.gs` back into `apps-script/` turns the suite red.

The four reading findings, all fixed with their own tests:
- **RI-2 (major)** — an unread end count leaves the box empty, every sum reads empty as 0, and a start count of 55 prices all 55 as sold. The only warning lived in the paper card, which is dismissible AND not persisted, so after "Hide this" or a reload the inflated night saved silently. The refusal now lives in `validateBenta`, checked last so an ordinary counting mistake is still named first, and a typed **0 is always accepted** — that is the whole distinction. Its mutant **survived the first pass** (the existing test only checked the card), which is exactly what the mutation round is for.
- **RI-3 + XC-1 (major)** — the cross-check could say "every figure was read clearly, so the difference is more likely in the adding-up on the paper itself" while the same reading listed unread figures, or was missing a whole product row (which appears in no list, since an omitted row cannot name itself). `paperGaps` now names all three kinds of gap — the model's own `unread`, blank custom/total figures, and rows that never came back — and they are reported BEFORE any low-confidence line.
- **XC-2 (major)** — the excluded-money branch declared "Good." whenever `mine + excluded === paper`, which a reading that fell short by exactly the nori amount also satisfies. It now states the assumption and names the other reading of the same arithmetic, because that is all the arithmetic supports.

Six reverts on scratch copies, all red: the blank end count accepted, gaps ignored, a missing row invisible, the excluded branch declaring "Good.", plus the deploy invariant breached two ways.

**v2.9.1 — the page's own date.** Found while walking the owner through his first real photo: his sample page is dated 5/18, and photographing it while the form sat on today would have filled *today* with May's figures — and the cross-check would have AGREED, because those figures match that page's own total perfectly. Nothing on screen would have objected. The reading now carries `date_on_paper` verbatim, the phone claims a mismatch only when neither reading of those digits can be the night on screen (no year, no agreed order — and silence for anything unparsable), and the warning sits above every figure it qualifies with a one-tap move to the night the page actually is. Two reverts red — and the first cut of the test **passed while the check was dead**, because it pinned the source rather than the rendered card; it now asserts on the markup the owner would see.

### v2.9.2 — what a product review found that the gates had not

A six-lens product review (30 proposals, three judges from different seats) over the live app and the real sheet. Three findings were money-honesty defects in code that had already passed its own gate, and all three are fixed with tests that bite:

- **The unkept promise (the serious one).** v2.8.0's costing withholds money paid on a `costed_buckets` row because that money "is counted as stock is opened" — but the owner buys when things run out and does not always log an opening, so it could be counted **nowhere**, and the floor gate could not see it: `!(moneyCost > 0)` means a single octopus purchase stands the whole warning down. Three independent probes reproduced ₱2,780 withheld with `caveats: []`, live targets, and advice to cut Box 10 to ₱88. The set-aside is now split by **which promise it rests on** — containers keep their own (`boxesCost` charges them as boxes sell), stock does not — and an unkept stock promise names its peso figure and empties `targets`.
- **The warning silenced by the app's own suggestion.** The Cutoff screen's "no purchases logged" line was gated on Mama's share and the electric bill as well, so one tap on the `+ Mama ₱500` chip *the same screen offers a few cards down* switched off a warning about supplies and octopus while both were still ₱0.
- **Tonight is not a missing night.** `missingDaysInPeriod` walked to today while the server's own costing deliberately stops at yesterday — one system, two answers — so every evening before closing the card announced "1 day has nothing entered" about tonight. Said daily, it stops being read on the evening a night really is missing. Tonight now gets its own quieter line, keeping both buttons (on the last night of a cutoff, "Was closed" is the tap that matters).

Four reverts red: the unkept-promise caveat silenced, container money raising the floor, the Mama gate restored, and tonight counted as a gap again.

### v2.9.3 — the screen she reads, and the wait that used to have no end

Two defects, both from measuring rather than looking, plus one hole in this harness.

- **The palette is now arithmetic.** The hairline `--line` on `--bg` measures **1.25:1** where a boundary that tells her which box a figure goes in needs **3:1**, and `--accent` used as *text* is **4.04:1** against a 4.5 minimum. Three new tests recompute the ratios **from the shipped file** on every run (a WCAG relative-luminance implementation, ~10 lines), check that `.card`/`.input`/`.chip`/`.step-btn`/`.step-val` all draw their borders with the strong token, and check that the selected tab carries a shape cue rather than colour alone. Six reverts red: the token softened back, the card border reverted, the accent-text reverted, the tab returned to colour-only, the `color-scheme` meta dropped, and a stepper border returned to the hairline. One of these tests **was wrong first**: `src.indexOf('.step-btn{')` matches inside `.stepper.sm .step-btn{`, so it read the wrong rule's body and would have let a hairline through while going green — the lookup is now anchored to the start of a line.

- **Nothing waits forever.** A `fetch()` with no timeout, against a socket held open by a tower that has gone away, blocked the whole in-order queue at *Syncing…* with nothing on screen. Three tests: a wire that never settles must end the drain with the night still queued (and the retry must land **one** row, which is what makes giving up safe); a WebView that accepts the abort signal and then **ignores** it must still be released, proving the deadline is the app's race and not the platform's favour; and a throw on the failure path must not leave `syncing` stuck true — asserted by the thing that matters, the *next* night reaching the sheet. `hooks.timerCap` shadows `setTimeout` in the sandbox so a 30-second deadline is checkable in milliseconds while the code still asks for its real 30000 and still says "30 seconds".

- **A hang used to read as a PASS.** Mutation-proofing found this, not the code: with the deadline removed, an `await` on a promise that never settles does not hang node — it **empties the event loop, and node exits 0**, skipping the summary and every test still queued behind it. The mutant `signal_only_no_race` "survived" for exactly that reason. Every async test now runs against a 10s watchdog (cleared on the winning path, deliberately **not** unref'd, so a real hang reaches it and gets named), and an `exit` guard fails the run if the summary was never printed and says which test started last. With the watchdog in place all three timeout mutants are caught, and the hang reports itself as `TIMED OUT after 10s`.

Suites: **204** (`run-tests.js`) + **211** (`contract.test.js`).

### v2.9.4 — the costing window

- **One lump per cutoff.** `fixed.shares` was `mama_per_cutoff + electric_per_cutoff` taken once, however many periods the window spanned — probe-proven: a 16 Jul – 22 Aug window owed three and was charged one. Not reachable from the phone (it asks for a single period), but understating fixed cost is the direction that makes a price look safe to cut. Tested across a month boundary, February, a **leap** February, and a full year (24 cutoffs), plus the zero case, so the period walk cannot wander or loop. Six reverts red, including an off-by-one in the walk (which broke four tests) and a February that forgot leap years.

- **A cutoff still running says so.** The reachable half, and the default view. Seven nights into a sixteen-night cutoff, the whole period's lumps land on seven nights and the cost per night reads high — previously with no line on screen at all, because the existing blank-days caveat only covers nights *before yesterday* that have nothing in them, and there were none. The new caveat counts the nights, names the direction, and is checked to stay **quiet** on a finished cutoff and quiet when no shares are entered (nothing to spread). Two guarantees are pinned by their own mutants: the caveat must **not** switch the price advice off (upward bias is safe, and this is the default view), and the peso figure is named through what it pays for — in a sentence that already counts nights, a bare `1,000` reads as one more count.

- **The jump is a walk.** The caveat says which cutoff to price from, so the phone offers it. Pinned three ways: the button appears only on an explicit `period_finished === false` (an older server that never sends the key must not sprout a dead button), the walk keeps stepping back while `end >= today` — tested from a cutoff *three periods in the future*, where "the previous one" is still unfinished — and it discards the answer belonging to the old window. Four client mutants red.

One existing pin was **narrowed, deliberately**: the test asserting a live cutoff produced no caveats at all was about blank nights, and now says so instead of demanding silence about everything.

Suites: **206** (`run-tests.js`) + **214** (`contract.test.js`).

### v2.9.5 — the model retired

His first real photograph, 2026-08-27. Not a defect in the app: `gemini-2.5-flash` was withdrawn for new keys, and the reader said so. The v2.9.0 guarantees all held — photo filed first, **nothing** filled in, night still enterable.

One test, built from the **verbatim** failure body, covering five cases: the real refusal names the model asked for and the model to type and where to type it; a suggestion falling **past** the 160-character phone cut still reaches him; the suggestion is found whichever way round the service words the sentence; a bare 404 says the right kind of thing without inventing a name; and a 404 naming only the model we already use suggests nothing.

The first cut of this test was **unrealistic and failed for the right reason**: it fed the old-model message while the code already asked for the new one, a state Google would never produce. Fixed by pointing the test's `MODEL` at 2.5 — which is what makes it his failure rather than an approximation of it.

Then one mutant **survived**: reading the *truncated* message instead of the whole one still passed, because in his particular message the replacement sits at character ~110, inside the cut. Working by luck is not working. A case with a longer preamble (asserted to place the suggestion past character 160) now makes reading the whole message load-bearing — and with it, all five mutants are red.

Suites: **207** (`run-tests.js`) + **214** (`contract.test.js`).

### v2.9.6 — a typed delivery counts

His report: typing into "Stock came in" did nothing; only + counted. **Reproduced in the browser before touching the code** — typed `10`, state stayed `'0'`, then one + gave `'1'` rather than `'11'`, which is the part that could have logged a ten-pack delivery as one.

Not reachable through the test harness (it is a document-level `input` listener, not a lifted function), so it is pinned at the source the way the other dispatch invariants are — but pinned on the things that actually broke: the arrival box carries `data-arr`, it is read **before** `const id = ev.target.id`, the unreachable `id.startsWith('in-arr-')` branch is gone rather than reordered, and the Sales branch requires a `sku` so it can only claim Sales steppers. Three mutants red: the attribute removed, the handling moved back below the id branches, and the Sales branch made greedy again.

Two of my own assertions were wrong first, both for the same reason — the comment I added to explain the bug *quotes the code it describes*, so `indexOf` found the prose and a 500-character window fell short of the branch body. Anchored to `else if (id.startsWith('in-')){` with a window wide enough for the comment.

Suites: **207** (`run-tests.js`) + **215** (`contract.test.js`).

### v2.9.7 — an unsaved night must not freeze the version

His two words after 2.9.6 shipped: *"still .5"*. The update gate refused flatly on `benta.dirty`, and a restored draft sets that on every load — so one unsaved night pinned the phone to old code indefinitely, silently. A fault that hides every later fix is worse than the faults it hides.

Previously **stubbed** in this harness (`function applyUpdateIfSafe(){}`), which is why no test could see it. Now lifted as a real slab with a faked world around it — `document.activeElement`, `location.reload`, `stashBentaDraft`, `syncing`, `paperBusy` — so the question "does a half-entered night keep this phone on old code forever" is one the suite can answer. Eight cases: the stuck case updates **and stashes first**; a focused INPUT/TEXTAREA/SELECT still waits and does **not** stash behind her back; a request in flight and a photograph being read still block; a clean form updates with nothing to stash; no pending update does nothing; and one reload per page load.

One mutant survived the first pass: deleting `reloadingForUpdate = true` still passed, because clearing `updateWaiting` masked it. That guard exists for a race the test wasn't modelling — `location.reload()` is asynchronous, so another worker can claim the page before it unloads and set `updateWaiting` again. With that race added, all six mutants are red.

Suites: **207** (`run-tests.js`) + **216** (`contract.test.js`).

### v2.9.8 — the start count carries for every sku, nori included

Owner: *"Bug in the starting count of nori, doesnt get the count from the previous day."*

Reproduced in the browser before touching anything, which located it precisely: `prevEodFor('nori', today)` returned **8** all along, and `if (!isBoxSku(r.sku)) continue;` threw it away. Since the spec requires an excluded sku to be `group=simple`, nori was the one sku the prefill could never carry — and `sold` is `sod − eod` for every sku, so counting 8 left against a start of 0 read as `max(0, 0 − 8)` = **nothing sold**. His own line of business, quietly zeroed.

An existing test pinned the old behaviour — `'a simple sku is not prefilled — boxes only'` — so this release **reverses a pinned decision**. It is recorded as owner-directed: v2.7.0 gave no reason for the narrowing, not in the test and not in SPEC, and the arithmetic contradicts it.

Six cases: the reported carry-over (and that the corrected start is what gets **sent**, not merely shown); reaching back past a night that did not count nori; an unread close inventing nothing and **not** reaching further back; a typed zero carrying as a real answer; a saved day keeping its own figures; and an empty history answering with no figure.

One mutant survived first: restoring `num(eod)` for a blank close still passed, because a fresh row's SOD default is already 0 — so "prefilled 0" and "not prefilled" are indistinguishable through the form. Moved to assert on the lookup, where the distinction actually lives. Six mutants now red, including a reversed date comparison that would take the oldest close instead of the latest.

Suites: **207** (`run-tests.js`) + **217** (`contract.test.js`).

### v2.10.0 — "Does this night look right?"

The first feature in a while that is not a bug fix, and it exists **because** of the bug fixes: two of this week's four defects (nori's stuck start count, the delivery logging as one) were perfectly self-consistent and invisible to every guard in the app. The owner found them by eye. Nothing compared tonight to the other nights, so nothing could.

Four tests, 13 mutants, all red. The interesting part was how many guards my first tests could not **see**:

- `closed_night_judged` survived because a closed night's payload totals 0 anyway, so the band check was already silent — rearmed with a closed night whose rows carry the zero signature.
- `closed_drags_the_usual` survived because the `total > 0` filter already excluded my zero-total closed night — rearmed with a closed night carrying a figure, which a hand-edited sheet can genuinely produce.
- `card_ignores_complaints` survived because in that state there was nothing to say anyway — rearmed with a night where a check WOULD fire *and* a real complaint stands, so the gate is load-bearing.
- `uncounted_row_silent` survived because the blank-row branch was never exercised. Chasing it turned up something worth knowing: a count row can only go blank on both sides through the **photo reader** (the schema requires only `sku`, so an omitted field is how the model says "unread"), so the test now goes through `applyReadingToForm` rather than hand-setting `''`.
- `zero_ignores_empty_shelf` survived because I had not tested a night with no stock to sell — where "nothing sold" is the only possible outcome and flagging it would be pure noise.

One fixture bug of my own: I set the historical totals to ₱4,600 while the counts behind them produced ~₱1,500, so the band check fired on a night I had called "normal" — the check was right and my numbers were not. The usual take is now derived from the very counts the fixture builds.

Suites: **207** (`run-tests.js`) + **221** (`contract.test.js`).

### v2.10.1 — given away or ruined

He confirmed it happens, so `sold = sod − eod` was overstating revenue on every freebie and every dropped box. This is the first schema change in a while and it touches the money path, so it is tested from both ends and mutated on both sides.

The contract test walks the whole seam on one night: ten leave the tray, two given away — `sold` stays 10, `regular_qty` is 8, the total drops by exactly two boxes' worth, the request carries `freeQty` camelCase, **the sheet agrees to the peso**, the response carries `free_qty` snake_case, reopening the night remembers it, and the costing still counts **all ten boxes as made** because a free ball costs the same to make. The server test covers the four refusals and, importantly, that a payload which says nothing about give-aways still lands exactly as an older phone's would.

12 mutants across both files, all red — including `free` not subtracted on either side, the bucket bound ignoring it, the snapshot not stored, bootstrap dropping the column, the reopen forgetting it, and the receipt going quiet. One survived first: the **client** guard, because only the server's refusals were tested — but the phone guard exists precisely so a night that cannot land never queues, so it now has its own assertions, including that the complaint lands in its own slot rather than being reported as a counting mistake.

Two of my own errors, both worth recording: I hard-coded a late-August date into a server test while the stub's clock is frozen in early August, so every refusal I was asserting on was really "that date has not happened yet" — the test now passes an explicit clock. And I asserted on `errs['sku:box4']` in a state where the row had already been reset, which passed for the wrong reason until I pinned it to a state that genuinely arms the guard.

Suites: **208** (`run-tests.js`) + **222** (`contract.test.js`).
