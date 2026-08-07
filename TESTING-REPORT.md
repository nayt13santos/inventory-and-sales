# Vigorous test campaign — results (v2.4.1, 2026-08-05)

Ten hostile testers each attacked one dimension of the system, producing 45 findings.
Every finding was then independently verified — 10 by three-skeptic panels told to
refute them, 35 by a single skeptic re-running the reproduction. **Nothing below is
speculation; every item was reproduced against the real code** (in an isolated harness —
the live sheet was never written to).

**Verdict: 42 confirmed (5 critical, 19 major, 18 minor), 2 refuted, 1 duplicate.**

The suites (228 tests) all pass — these are gaps the suites never asked about,
which is exactly what a hostile sweep is for.

---

## The one theme behind most of the money bugs

**"Settings are read live where they should be frozen into history."**
The Maintenance page promises: *"Changing one never rewrites a day or a cutoff that is
already saved."* Prices keep that promise (they're snapshotted). Almost nothing else does:

| You change… | What silently rewrites |
| --- | --- |
| Usual split per cutoff | Split / per-partner / Remaining of cutoffs **already generated and sent**, and the archived note text |
| Wage per day | The Salary line of **every day saved before Aug 3** (their salary cells are blank and read the *current* rate) |
| A price, then re-save any old day | That day's money is re-priced at today's price — receipt, sheet and cutoff all shift |
| "Counts in the cutoff" on a sku with pre-Aug-4 history | Money already inside old totals *also* appears under "Not part of the cutoff" — counted once, shown twice |

**Fix principle (same as prices already use): snapshot the value with the money, backfill
history once, and never classify the past by the present.**

## Critical (5)

1. **A price change reprices a finished day the moment it's re-saved** — editing a typo
   in yesterday's staff name is enough to restate yesterday's takings at today's prices.
2. **The date field accepts a future date** past its own maximum — a whole night's money
   can land on a date that hasn't happened, where no cutoff will find it yet.
3. **Changing a standing amount retroactively rewrites a generated cutoff** (the theme above,
   confirmed 3/3 as its own reproduction).
4. **A save superseded mid-flight leaves a permanent false "not in the sheet" card**
   that replays stale figures over corrected ones, forever.
5. **A sync reply that was already in flight when you saved deletes the just-saved
   day/expense from the phone** — while the pill says "Synced."

## Major (19) — grouped

- **Offline sync races (5):** a synced backlog payment vanishes from its balance; a
  superseded reply overwrites corrections; a deleted expense resurrects on every sync;
  the "not saved" record itself is lost first when phone storage fills; plus critical #4/#5 above.
- **Retroactivity family (4):** the split/wage/price/flag rewrites described above.
- **Hand-edits to the sheet (2):** a header retyped as `Sku` instead of `sku` makes
  migration append a duplicate column, re-seed prices, and (via `Value`) **rotate your
  API token**, locking both phones out; a duplicated sku row makes every day unsaveable.
- **Excluded-sku dead end (2):** a day that recorded GCash on a sku you later mark
  "not in the cutoff" can never be edited again — the app blocks *any* change to that day
  (even fixing the staff name), renders no control to clear the offending count, and the
  only on-screen escape ("Closed today") wipes the day's sales.
- **Dates (2):** one stray keystroke commits a year-000X date and files the night's money
  where nothing will find it; the cutoff preview silently understates a period the phone's
  local history doesn't fully cover.
- **Usability with money consequences (1):** anything typed in the ~450ms after tapping
  "Save day" is silently thrown away (the tear-off animation swallows it).
- **Stock (1):** on-hand ignores every downward correction — fixing an over-count,
  closing a day, or deleting a mistyped delivery springs back, which can suppress the
  low-stock warning while the shelf is empty (confirmed 3/3).

## Minor (18) — highlights

- The note can print `Remaining - -0`, `Supplies - -400`, or split halves that add up to
  one centavo more than the split.
- An expense hand-typed with a date like `2026-7-5` belongs to **no cutoff at all** — its
  money is invisible everywhere, permanently.
- `setupSheet` resurrects hand-deleted seed rows — a paid-off, deleted backlog comes back
  as fully outstanding.
- A newline typed into the branch name forges extra lines *above* the real Total in the note.
- "Closed today" on a saved day destroys its sales with no confirmation; one stray tap on
  "Save day" books an empty day plus ₱200 wage with no confirmation.
- A blank price on an active sku silently books those sales at ₱0 (server side; Maintenance
  already refuses it).
- Full list with reproductions: `confirmed-findings.json` (kept with the test scratchpad)
  and the two campaign outputs.

## What came back CLEAN

Worth as much as the bugs: **the core per-day and per-cutoff arithmetic could not be
broken** — the four buckets, the roll-up, Cash = Total − GCash, the accounting identity,
and the note's byte-exactness under every legitimate input the testers threw at it.
Token security held (no action without a valid token; nothing leaks from ping).
The two refuted findings were both stock-ledger reports that turned out to be symptoms
of the confirmed carry-floor bug, not separate defects.

## What happens next

- **v2.5.0 — fixes only.** All 42, backend and phone, with every fix mutation-proofed in
  the suites. The retroactivity family is the priority: it can misstate money you've
  already paid out.
- **v2.6.0 — the seven features** (low-stock alerts, supplies picklist, carry-over counts,
  cash→GCash conversion, box-with-lid custom orders, special-order box deduction).
  Features ride on a foundation that's just been fixed, not the other way around.
