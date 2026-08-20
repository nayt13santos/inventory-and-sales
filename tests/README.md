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
