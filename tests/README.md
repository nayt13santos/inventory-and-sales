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
