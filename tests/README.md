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
