/**
 * Octogo Takoyaki — Daily Tracker API (Google Apps Script, V8 runtime)
 * =====================================================================
 * Bound to the tracker Google Sheet. See SPEC.md (authoritative).
 *
 * Deploy: Extensions > Apps Script > Deploy > New deployment > Web app
 *   - Execute as: Me (USER_DEPLOYING)
 *   - Who has access: Anyone (ANYONE_ANONYMOUS)
 * Timezone: appsscript.json must contain "timeZone": "Asia/Manila".
 *
 * First-time setup AND every later schema change: run setupSheet() once from
 * the editor. It is a MIGRATION, not just a creator, and it is idempotent:
 *   - creates any missing tab (with headers + seed rows),
 *   - APPENDS any missing schema column to the RIGHT of an existing tab,
 *   - never reorders, renames or deletes a column that already exists,
 *   - never overwrites an existing token, price or backlog balance,
 *   - re-applies the plain-text "@" format to every date/timestamp column
 *     (including ones it just appended),
 *   - freezes header rows and sets the spreadsheet FILE timezone.
 * Because columns are only ever appended, the sheet's column ORDER is not part
 * of the contract: every reader below maps columns BY HEADER NAME (row 1), so
 * a sheet created before a schema change (9-column DailyCounts) and one
 * created after (12-column) both read correctly.
 *
 * WHY DATES ARE STRINGS: Sheets auto-coerces date-looking values into Date
 * objects whose rendering depends on the spreadsheet's timezone and locale,
 * which silently corrupts day boundaries. We therefore store all dates as
 * plain yyyy-MM-dd strings in columns number-formatted "@" (plain text),
 * format them with Utilities.formatDate(..., 'Asia/Manila', ...), and
 * compare them lexicographically (which is safe for yyyy-MM-dd).
 *
 * Transport: POST with Content-Type text/plain (no CORS preflight — Apps
 * Script cannot answer OPTIONS). Body: JSON {token, action, payload}.
 * Response: JSON {ok:true, data} or {ok:false, error}.
 *
 * KEY CASING — the contract is deliberately asymmetric, do not "tidy" it:
 *   REQUEST  payload keys are camelCase  (cheeseQty, gcashQty, gcashCheeseQty,
 *            customAmount, customGcash, gcashConverted, lidBoxes, customBoxes,
 *            entryId, backlogRef, stockProduct, stockQty, reorderAt,
 *            cheesePrice, unitCost, boxCost, targetPerDay, dryRun)
 *            — see SPEC.md "API contract".
 *   RESPONSE keys are snake_case (cheese_price, custom_amount, custom_gcash,
 *            entry_id, updated_at, cheese_qty, regular_qty, gcash_qty,
 *            gcash_cheese_qty, gcash_amount, backlog_ref, total_amount,
 *            start_date, per_partner, note_text, generated_at, counted_qty,
 *            split_amount, stock_product, stock_qty, on_hand, reorder_at,
 *            baseline_qty, baseline_date, delivered_since, used_since,
 *            delivered_before, used_before, gcash_converted, lid_boxes,
 *            custom_qty, unit_cost, box_cost, days_open, per_ball, per_day,
 *            cost_per_box, margin_per_box, margin_per_ball, break_even_balls,
 *            per_sku)
 *            — they mirror the sheet's own column headers and the shape the
 *            PWA persists in localStorage (state_v1). The only camelCase names
 *            a response may carry are the bootstrap/range CONTAINER keys
 *            (stockItems, stockUsage, stockCounts, stockDeliveries,
 *            cutoffInputs, lastCutoff).
 * Emitting camelCase in a response is a bug: the PWA reads snake_case, so a
 * mismatched key silently arrives as undefined and turns into 0 money.
 *
 * WHAT CHANGED IN v2.3.0 (see SPEC.md for the whole picture):
 *   - the cutoff note gained a "Salary" line and a final residual line whose
 *     LABEL carries the sign ("Remaining - 1,000" / "Short - 2,000"),
 *   - Split is an ENTERED amount (CutoffInputs, else Settings split_default),
 *     so REMAINING is the residual and may legitimately be negative,
 *   - daily salary is snapshotted onto each DailyLog row at save time,
 *   - the daily-supplies path is RETIRED: Supplies on the note is
 *     Expenses(category=Supplies) alone,
 *   - stock is a ledger: whole units opened, deliveries carried on the expense
 *     row that paid for them, stocktakes that re-baseline, and a COMPUTED
 *     on-hand figure that is never stored.
 *
 * WHAT CHANGED IN v2.3.1 — three holes in the SERVER's own guards. The client
 * checks the same things for convenience, but the server is what enforces them:
 *   - savePrices REFUSES a 0 (or blank) price on a sku that is still ACTIVE,
 *     naming it. A selling item priced at nothing books every future sale at
 *     nothing. An inactive sku may keep its 0.
 *   - readStockItems ships reorder_at RAW, so a blank threshold stays blank
 *     instead of arriving as 0 and being written back into the cell.
 *   - whole units are enforced on ALL THREE ledger writers, not just saveDay:
 *     a delivery's stockQty and a stocktake's qty were accepting 1.5.
 *
 * WHAT CHANGED IN v2.4.0 — a sku can now be SOLD AND COUNTED but kept OUT of
 * the cutoff (owner, 2026-08-04: nori at ₱25 is his own line of business — "it
 * must not be added to the bi-monthly cutoff, just show the total per cutoff,
 * and I'll exclude it on my own"):
 *   - Prices gains `in_cutoff`. A BLANK OR MISSING CELL READS TRUE — every row
 *     on the live sheet gets an empty cell at migration, and if blank read as
 *     FALSE every takoyaki sku would drop out of the cutoff and the note would
 *     collapse to almost nothing. Only an explicit false value is FALSE
 *     (asCutoffFlag, which is DELIBERATELY not asBool).
 *   - DailyLog gains `excluded_total`: that day's money from in_cutoff=FALSE
 *     skus, stored apart and NEVER part of total / cash / gcash.
 *   - An excluded sku has no payment split at all: a GCash count on one is
 *     REFUSED (see apiSaveDay) rather than quietly banked somewhere, because
 *     the day's GCash figure exists to be reconciled against GCash history.
 *   - apiCutoff's figures gain `excluded` and `excluded_lines`, DISPLAY ONLY:
 *     they enter no other figure, and buildNoteText is UNTOUCHED — the owner
 *     chose "Cutoff screen only", so what his partner receives does not change
 *     by a single byte.
 *
 * WHAT CHANGED IN v2.4.1 — three holes in the SERVER's own excluded-sku guards.
 * All three are about MONEY MOVING AFTER IT WAS SAVED, or leaving the day's
 * GCash figure short of the GCash app:
 *   - DailyCounts gains `in_cutoff`: the flag is SNAPSHOTTED onto every count
 *     row at save time, exactly as prices are, and HISTORY IS CLASSIFIED BY THE
 *     SNAPSHOT (excludedForPeriod). Classifying it by the CURRENT Prices flag
 *     restated money that was already saved, in both directions: ticking nori
 *     back on made a past ₱300 vanish from the excluded block while `total`
 *     (read off the DailyLog row) still did not contain it, and ticking a
 *     counted sku off made money that IS inside `total` also show up as "kept
 *     out". A blank snapshot on a legacy row falls back to the sku's current
 *     flag — the best available answer for a row written before the column.
 *   - EVERY bucket is refused on an excluded sku, not just gcashQty: cheese and
 *     GCash cheese were accepted, priced into `excluded_total`, and their money
 *     disappeared out of the day's GCash — the exact harm the guard exists to
 *     prevent.
 *   - an excluded sku must be `group=simple`, and both savePrices and saveDay
 *     REFUSE `in_cutoff=FALSE` on a `group=box` sku, naming the item. Otherwise
 *     the Sales card hides the cheese steppers while the payload still carries
 *     cheese quantities, so the phone and the sheet disagree about what sold.
 *
 * WHAT CHANGED IN v2.5.0 — the retroactivity/robustness pass. The note for
 * valid data is byte-identical to what v2.4.1 produced; the deliberate changes
 * only touch invalid or ambiguous data:
 *   - PRICE SNAPSHOT COMPLETED: DailyCounts gains `price` and `cheese_price`,
 *     written at save. Re-saving an existing date reuses THAT DATE's stored
 *     per-sku prices (a re-save is a correction of that night, not a re-pricing
 *     of it); a sku newly added to the day uses current Prices; a blank stored
 *     price (legacy row) falls back to current Prices. saveDay also REFUSES a
 *     blank/zero effective price on an ACTIVE sku (the server mirror of the
 *     savePrices guard) and REFUSES the whole day when the Prices tab has no
 *     readable products at all, instead of silently booking every box at ₱0.
 *   - SPLIT: resolution order is CutoffInputs row -> the archived Cutoffs row's
 *     own split -> Settings split_default, so regenerating an old period after
 *     the default changed can never silently restate its archived Split. A
 *     non-dryRun generation with no CutoffInputs row WRITES one recording the
 *     split it used. saveCutoffSplit and split_default are WHOLE PESOS only.
 *   - SALARY: setupSheet backfills every BLANK salary cell on a non-closed
 *     DailyLog row with the current daily_salary, once, at migration — so a
 *     later rate change can never quietly re-price history that predates the
 *     column. saveSettings treats a BLANK daily_salary (any blank money value)
 *     as leave-alone, never as ₱0.
 *   - DELIBERATE: a BLANK in_cutoff on a DailyCounts row now reads TRUE on its
 *     own (see countCutoffFlag) — the money on a pre-snapshot row was inside
 *     the day's totals when it was saved, so classifying it by the CURRENT
 *     Prices flag double-stated migrated history.
 *   - DELIBERATE: a NEGATIVE expense-category sum REFUSES a non-dryRun cutoff,
 *     naming the offending rows (a negative category is a data error); dryRun
 *     still shows it plainly.
 *   - HEADERS: matched case-insensitively and trimmed everywhere, and
 *     migrateTab REFUSES a non-empty tab whose row 1 has no recognizable
 *     headers instead of appending a second schema beside foreign data.
 *   - SEEDS: Prices/Backlogs/StockItems rows seed ONLY when their tab was just
 *     created — a row the owner deleted on purpose stays deleted. Settings
 *     keeps its key-wise add-if-missing (and the token).
 *   - DUPLICATES: readPrices and readDays dedupe deterministically (first row
 *     wins, matching which row an upsert rewrites).
 *   - DATES: saveDay/saveExpense/saveStockCount refuse a date in the future
 *     (Asia/Manila) or before 2020; readers NORMALIZE non-canonical sheet-typed
 *     dates (2026-7-5, 7/5/2026) to yyyy-MM-dd so hand-typed money is never
 *     invisible to the phone or the cutoff.
 *   - WRITE ORDER: apiSaveDay writes the DailyLog row LAST, so a mid-save crash
 *     leaves detail rows a retry rewrites cleanly instead of a DailyLog row
 *     whose money has no counts behind it.
 *   - branch strips CR/LF on read and in saveSettings (an embedded newline
 *     would corrupt the note's line structure); doPost answers a null/absent
 *     JSON body with the friendly parse error, never a raw TypeError.
 *
 * WHAT CHANGED IN v2.5.1 — the verifier round (the five findings that survived
 * the v2.5.0 pass):
 *   - STOCK SPLIT AT THE WINDOW: bootstrap's stockItems rows gain
 *     `delivered_before` / `used_before` — the ledger totals STRICTLY BEFORE
 *     window_start (and strictly after the baseline). The phone adds its OWN
 *     in-window rows on top, so a local correction/deletion moves on-hand
 *     immediately; its old "carry floor" (topping local sums back up to the
 *     whole-history totals) is deleted.
 *   - SNAPSHOTS TRAVEL WITH THE FIRST SAVE: a saveDay count may carry the
 *     `price` / `cheesePrice` / `inCutoff` the phone DISPLAYED (camelCase,
 *     request side). They are used for a sku's FIRST row on the date, so a
 *     save queued offline lands at the money the receipt and the tin showed.
 *     Stored per-date snapshots still win on a re-save.
 *   - RE-SAVE CLASSIFIES BY THE STORED in_cutoff SNAPSHOT (same precedence as
 *     prices, incl. the bucket guards), so a Maintenance flip never moves an
 *     already-saved day's money between the cutoff and the excluded block —
 *     not even via a note-only re-save from an older phone's queue.
 *
 * RECEIVING STOCK IS ITS OWN ACTION (v2.6.0 — owner, 2026-08-11: "supplies
 * adding must be separate… it's not paid yet"). Suppliers deliver on credit, so
 * goods arriving and money leaving are two different events:
 *   - new tab StockDeliveries (date | product | qty | entry_id | updated_at) and
 *     new action saveStockDelivery {date, product, qty, entryId} — whole units
 *     received, upsert by entry_id, NO MONEY ANYWHERE NEAR IT. bootstrap ships
 *     the window's rows as `stockDeliveries`.
 *   - on-hand's `delivered` = legacy Expenses.stock_qty + StockDeliveries.qty,
 *     both strictly after the baseline and both split at window_start
 *     (delivered_before includes both).
 *   - saveExpense REFUSES new stockProduct/stockQty in one plain sentence and
 *     no longer writes those two columns at all, so a re-save can never wipe a
 *     legacy row's quantity. Existing sheet rows keep counting forever.
 *   - paying the supplier later is an ordinary Supplies expense, so the note's
 *     Supplies line keeps meaning "money actually paid this period" and an
 *     unpaid delivery correctly never touches the cutoff.
 *
 * WHAT CHANGED IN v2.7.0 — the nightly screen, laid out the way the stall
 * works. Every new payload key is OPTIONAL, and absent means the harmless
 * default (0 / empty) — an old phone's queued day lands with the same totals
 * and the same note it always produced:
 *   - MONEY CONVERTED BETWEEN THE TIN AND GCASH: the day's TOTAL is untouched
 *     and only the split moves. saveDay gains `gcashConverted` — SIGNED since
 *     v2.7.3 (positive = tin cash swapped for a GCash transfer, negative =
 *     GCash cashed out of the tin; the phone's direction chip carries the
 *     sign). Each direction is REFUSED, naming both figures, when it exceeds
 *     the day's computed figure on the side it leaves — neither Cash nor
 *     GCash can ever go negative. DailyLog appends `gcash_converted` (blank
 *     legacy cells read 0). The roll-up is gcash = Σ per-sku gcash_amount +
 *     custom_gcash + gcash_converted and cash = total − gcash, so
 *     Total = Cash + GCash still holds by construction, never by argument.
 *   - SPECIAL ORDERS DRAW THEIR BOXES FROM THE COUNTED STACK: saveDay gains
 *     `customBoxes:[{sku, qty}]` — whole units of counted box skus the order
 *     physically used. Per sku qty <= sold, and the sku must be group=box AND
 *     counting in the cutoff (an excluded sku's money is settled separately, so
 *     a special order cannot draw from it). The sku's PRICED quantity is
 *     sold − custom qty: those boxes contribute NO menu-price money — the typed
 *     custom amount is the order's entire value — and the four buckets describe
 *     PRICED sales only, so they bound against sold − custom qty. DailyCounts
 *     appends `custom_qty` (a snapshot like price/cheese_price, rewritten with
 *     the date block; blank legacy cells read 0).
 *   - LID BOXES: saveDay gains `lidBoxes` (whole >= 0); DailyLog appends
 *     `lid_boxes` (blank reads 0). NO price, NO sales money, NO stock tracking,
 *     NO note impact — twice offered, twice declined.
 *   - Settings gains `supply_picklist` (the expense form's one-tap buckets;
 *     since v2.7.1 it seeds the owner's purchase-money buckets "Veggies,
 *     Eggs, Flour, Box" — not the stock list), whitelisted in saveSettings
 *     and editable under Maintenance like `staff`.
 *   - setupSheet backfills StockItems.reorder_at ONLY where the cell is BLANK
 *     (Takoyaki Flour 5, Takoyaki Sauce 1, Japanese Mayo 1 — the owner's
 *     figures), in the salary-backfill shape: it runs on every migration, and a
 *     hand-set value — an explicit 0 included — is never overwritten.
 *
 * WHAT CHANGED IN v2.8.0 — "what it costs" (owner, 2026-08-19: "Costing of the
 * current setup, how much should the price be in correlation with the daily
 * expenses"). It is READ-ONLY MANAGEMENT INFORMATION and that is the whole
 * shape of it: the cutoff note, every figure in it, and every peso already in
 * the sheet are byte-identical with these columns present and absent.
 *   - Prices gains `box_cost` and StockItems gains `unit_cost`, appended like
 *     every other column. Both are read RAW, the way reorder_at is: a BLANK
 *     cell means "NO COST KNOWN", never ₱0. asNum('') is 0, 0 is a legitimate
 *     cost, and a coerced blank comes straight back on the next save and fills
 *     the owner's untouched cells with literal 0s — which would silently price
 *     his balls at less than they cost.
 *   - setupSheet BACKFILLS both, BLANK CELLS ONLY, in the backfillReorderPoints
 *     shape (Flour 120, Sauce 490, Mayo 300, Bonito 900, Aonori 550, Togarashi
 *     320; box4 0.375, box6 3, box10 4.6, nori 0). His live sheet therefore
 *     gets his real figures without him typing them, and any figure he later
 *     corrects — an explicit 0 included — is never overwritten.
 *   - savePrices takes an OPTIONAL `boxCost` and saveStockItems an OPTIONAL
 *     `unitCost`, both omitted-means-leave-alone: a phone on older code carries
 *     neither key, and writing 0 for a key that was never sent would tell the
 *     costing screen that everything is free. An EXPLICIT blank is a real
 *     instruction ("I do not know") and is stored as a blank cell. A negative
 *     cost is refused in one sentence naming the product or the sku.
 *   - new action `costing` {start, end, targetPerDay?} — PURE READ, no lock.
 *     Its two cost sources are NEVER MIXED: consumption (StockUsage x
 *     unit_cost) is what was opened; money out (Supplies + Octopus) is what
 *     left the tin, LESS every row that is a restock of a tracked product,
 *     matched on `item` against StockItems case-insensitively and trimmed.
 *     Without that subtraction a sack of flour is counted twice — once as money
 *     paid, once as flour opened. Containers are per-sku boxes sold x box_cost.
 *     Fixed costs are the open days' snapshotted salaries plus
 *     mama_per_cutoff + electric_per_cutoff, spread over the open days.
 *     Balls are sold x size (a simple sku has no size and contributes none) and
 *     an EXCLUDED sku is out of both sides, classified by the count row's own
 *     in_cutoff SNAPSHOT like every other historical figure in this file.
 *     A product or container with no cost on file is LISTED in `unpriced` and
 *     left OUT — a total that is quietly too low is worse than one that is
 *     visibly absent, because the owner would set his prices from it. With no
 *     balls or no open days every per-ball and per-day figure is `null`, never
 *     a division by zero dressed as ₱0. `targets` says what each price WOULD
 *     need to be for a chosen nightly take and writes NOTHING.
 */

var VERSION = '2.21.0';
var TZ = 'Asia/Manila';

// ---------------------------------------------------------------------------
// Sheet schema (tab names, headers, and which columns hold yyyy-MM-dd /
// timestamp strings and must be plain-text formatted).
//
// `headers` is APPEND-ONLY history: new columns go at the END of the list and
// migration appends them at the right edge of the live sheet. Never reorder,
// rename or remove an entry — a live sheet's existing data would shift.
// `textCols` lists header NAMES (not positions), resolved against row 1.
// ---------------------------------------------------------------------------

var TAB = {
  SETTINGS: 'Settings',
  PRICES: 'Prices',
  DAILY_LOG: 'DailyLog',
  DAILY_COUNTS: 'DailyCounts',
  STOCK_ITEMS: 'StockItems',
  STOCK_USAGE: 'StockUsage',
  STOCK_COUNTS: 'StockCounts',
  STOCK_DELIVERIES: 'StockDeliveries',
  EXPENSES: 'Expenses',
  BACKLOGS: 'Backlogs',
  CUTOFF_INPUTS: 'CutoffInputs',
  CUTOFFS: 'Cutoffs'
};

// RETIRED TABS (2026-08-03): "SupplyItems" and "DailySupplies". The nightly
// "supplies bought today" card was judged redundant with the Expenses tab, so
// nothing reads or writes those two tabs any more and the cutoff's Supplies
// line is Expenses(category=Supplies) ALONE. They are DELIBERATELY absent from
// SCHEMA rather than kept as dead definitions: a tab nothing reads should not
// be re-created on a fresh sheet, and a reader left behind "just in case" is
// how retired data quietly starts counting again. Migration never deletes, so
// a live sheet keeps both tabs (and whatever is in them) untouched.

var SCHEMA = [
  // Settings value column is also "@" so the token (or any numeric-looking
  // value) is never mangled by Sheets' automatic type coercion.
  { name: TAB.SETTINGS, headers: ['key', 'value'], textCols: ['value'] },
  // in_cutoff was appended in v2.4.0: FALSE means "sell it, count it, but keep
  // its money out of every cutoff figure". A BLANK CELL IS TRUE — see
  // asCutoffFlag. Every pre-v2.4.0 row is blank after migration.
  // box_cost was appended in v2.8.0: what ONE container for this sku costs —
  // his bundle price divided by the bundle count. It is COST, never money that
  // has moved: it feeds the costing screen alone and reaches no cutoff figure,
  // no note and no DailyLog row. A BLANK cell means "no cost known" and the
  // sku's containers are left OUT of the costing total and listed under
  // `unpriced`; an explicit 0 is a real answer (a sku whose container costs
  // nothing). That is why it is read RAW, like reorder_at — see readPrices.
  { name: TAB.PRICES, headers: ['sku', 'label', 'group', 'size', 'price', 'cheese_price', 'active', 'in_cutoff', 'box_cost'], textCols: [] },
  // custom_gcash was appended in v2.1.0 (how much of custom_amount was GCash).
  // `gcash` is computed server-side now — it is still stored, still returned.
  // salary was appended in v2.3.0: that day's wage, SNAPSHOTTED at save time so
  // a later daily_salary change never rewrites history.
  // excluded_total was appended in v2.4.0: that day's money from in_cutoff=FALSE
  // skus. It is stored NEXT TO the day's money, never inside it — total, cash
  // and gcash all remain the cutoff's figures alone.
  // gcash_converted was appended in v2.7.0: tin cash swapped for a GCash
  // transfer during the day. It moves the SPLIT only — it is already inside
  // `gcash` and out of `cash`, never inside `total` — and a blank legacy cell
  // reads 0 (no cash was converted on a day saved before the column existed).
  // lid_boxes was appended in v2.7.0: a plain count with NO money, NO stock
  // tracking and NO note impact anywhere. Blank reads 0.
  // photo_url was appended in v2.9.0: a link to the PHOTOGRAPH of the paper this
  // night was read from ("Read it from the paper"). A STRING and nothing more —
  // it moves no figure, reaches no cutoff, no note and no costing line, and this
  // project gains NO permission to fetch or store it: the photo is kept by the
  // separate Octogo Vision project (apps-script/Vision.gs), which hands the
  // phone a URL, and the phone passes that URL through on the ordinary saveDay.
  // Blank is the normal state (a night typed in by hand has no photo, and every
  // row written before this column existed has none either).
  { name: TAB.DAILY_LOG, headers: ['date', 'closed', 'staff', 'gcash', 'total', 'cash', 'custom_amount', 'notes', 'entry_id', 'updated_at', 'custom_gcash', 'salary', 'excluded_total', 'gcash_converted', 'lid_boxes', 'photo_url'], textCols: ['date', 'updated_at', 'photo_url'] },
  // gcash_qty / gcash_cheese_qty / gcash_amount were appended in v2.1.0.
  // in_cutoff was appended in v2.4.1: the SNAPSHOT of the sku's flag as it stood
  // when the day was saved, so flipping "counts in the cutoff" later can never
  // restate money that is already in the sheet. A BLANK cell (every row written
  // before this column existed) reads TRUE — the money on such a row was inside
  // the day's totals when it was saved. See countCutoffFlag.
  // price / cheese_price were appended in v2.5.0: the per-unit prices the row's
  // money was computed FROM, completing the snapshot the amounts began. A
  // re-save of the same date reuses them, so correcting a count weeks later can
  // never re-price the night at today's prices. Blank (legacy row) falls back
  // to the current Prices tab.
  // free_qty was appended in v2.10.1: how many of this row's sold units left the
  // tray WITHOUT being paid for — given away or ruined. `sold` keeps its plain
  // physical meaning (what left the tray), so stock usage and the balls the
  // costing counts are unchanged: a ball given away still ate its ingredients.
  // Only the PRICED quantity shrinks. Blank on every row saved before the
  // column existed, and blank reads 0 — an old row claimed nothing was given
  // away, which is exactly what it meant.
  // custom_qty was appended in v2.7.0: how many of this row's sold boxes a
  // special order physically used. Those boxes carry NO menu-price money (the
  // typed custom amount is the order's entire value), so this row's amount was
  // computed from sold − custom_qty. A snapshot like price/cheese_price,
  // rewritten with the date block; a blank legacy cell reads 0.
  { name: TAB.DAILY_COUNTS, headers: ['date', 'sku', 'sod', 'eod', 'sold', 'cheese_qty', 'regular_qty', 'amount', 'entry_id', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price', 'custom_qty', 'free_qty'], textCols: ['date'] },
  // opening_qty / opening_date / reorder_at were appended in v2.3.0 (stock
  // ledger). opening_date is a yyyy-MM-dd string and BLANK means "count the
  // whole history" — see computeStockStatus.
  // unit_cost was appended in v2.8.0: what ONE of this product's units — the
  // thing you OPEN — costs to buy. It prices CONSUMPTION (StockUsage), which is
  // a different question from the money that left the tin, and the two are
  // never added together (see apiCosting). A BLANK cell means "no cost known":
  // that product's consumption is left OUT of the costing total and the product
  // is listed under `unpriced`, because a total that is quietly too low is
  // worse than one that is visibly absent. Read RAW like reorder_at.
  { name: TAB.STOCK_ITEMS, headers: ['product', 'unit', 'active', 'sort', 'opening_qty', 'opening_date', 'reorder_at', 'unit_cost'], textCols: ['opening_date'] },
  { name: TAB.STOCK_USAGE, headers: ['date', 'product', 'qty', 'entry_id', 'updated_at'], textCols: ['date', 'updated_at'] },
  // A physical stocktake. It BECOMES the new baseline, which is what stops
  // estimation drift (spoilage, breakage, miscounts) accumulating forever.
  { name: TAB.STOCK_COUNTS, headers: ['date', 'product', 'counted_qty', 'entry_id', 'updated_at'], textCols: ['date', 'updated_at'] },
  // Goods ARRIVING, with no money anywhere near them (v2.6.0 — owner,
  // 2026-08-11: "supplies adding must be separate… it's not paid yet"). His
  // suppliers deliver on credit, so goods arriving and money leaving are two
  // different events on two different days: the quantity lands here, and paying
  // the supplier later is an ordinary Supplies expense with no stock attached.
  // The old ride-along columns on Expenses (stock_product/stock_qty) stay in the
  // sheet and existing rows keep counting into on-hand forever (never restate
  // the past) — but saveExpense no longer ACCEPTS new stock fields, so from now
  // on there is one door in (here), one door out (StockUsage), and one door for
  // money (Expenses).
  { name: TAB.STOCK_DELIVERIES, headers: ['date', 'product', 'qty', 'entry_id', 'updated_at'], textCols: ['date', 'updated_at'] },
  // stock_product / stock_qty were appended in v2.3.0: a delivery is an
  // ordinary expense row that additionally names what arrived. Money stays in
  // exactly one place (`amount`); the quantity rides along on the same row.
  { name: TAB.EXPENSES, headers: ['date', 'category', 'item', 'amount', 'backlog_ref', 'notes', 'entry_id', 'updated_at', 'stock_product', 'stock_qty', 'paid_from'], textCols: ['date', 'updated_at', 'paid_from'] },
  { name: TAB.BACKLOGS, headers: ['name', 'description', 'total_amount', 'start_date', 'active'], textCols: ['start_date'] },
  // The Split is an ENTERED amount per cutoff (v2.3.0), no longer the residual.
  { name: TAB.CUTOFF_INPUTS, headers: ['start', 'end', 'split_amount', 'entry_id', 'updated_at', 'tin_counted'], textCols: ['start', 'end', 'updated_at'] },
  { name: TAB.CUTOFFS, headers: ['start', 'end', 'total', 'cash', 'gcash', 'mama', 'split', 'per_partner', 'supplies', 'octopus', 'other', 'electric', 'note_text', 'generated_at'], textCols: ['start', 'end', 'generated_at'] }
];

var EXPENSE_CATEGORIES = ['Supplies', 'Octopus', 'Electric', 'Mama', 'Backlog', 'Other'];

/* WHERE THE MONEY CAME FROM (v2.12.0). Owner, 2026-08-28: the tin is emptied
 * "until every cutoff" — cash accumulates across the fortnight and is collected
 * at settlement — and Mama buys supplies out of that same tin. So what the tin
 * should hold at any point in a cutoff is its cash sales less the cash SHE took
 * out of it, and until now no row said which expenses those were.
 *
 * BLANK IS A REAL AND PERMANENT ANSWER HERE: every row written before this
 * column existed says nothing about where the money came from, and nothing can
 * honestly be inferred for it. The reconciliation NAMES that money rather than
 * assuming it either way — the same rule the costing follows for a cost it does
 * not have. */
var PAID_FROM = ['tin', 'gcash', 'own'];

// The ONLY Settings keys the Maintenance screen may write. `token` is
// deliberately absent and must stay absent: an API that can rewrite its own
// shared secret can lock the owner out of his own sheet from a phone.
// Keys not on this list are ignored, so an old or hostile payload cannot
// invent a setting either.
var SETTABLE_SETTINGS = {
  branch: 'text',
  staff: 'text',
  // The expense form's one-tap buckets between Octopus and Other (v2.7.1):
  // comma-separated names, edited under Maintenance like `staff`. 'text' is
  // the VALUE type in this whitelist — on the form the buckets are the whole
  // choice, there is no free-text item box any more.
  supply_picklist: 'text',
  costed_buckets: 'text',
  daily_salary: 'money',
  split_default: 'money',
  mama_per_cutoff: 'money',
  electric_per_cutoff: 'money'
};

// Seeded fallbacks, used when the Settings row is missing or its cell is blank —
// a blank daily_salary must never quietly make a day of work cost ₱0.
var DEFAULT_DAILY_SALARY = 200;
var DEFAULT_SPLIT = 3000;

var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/** Connectivity ping. No token required (read-only, reveals nothing). */
function doGet(e) {
  return jsonOut({ ok: true, data: { name: 'octogo-api', version: VERSION } });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Empty request body. Expected JSON {token, action, payload}.');
    }
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      throw new Error('Request body is not valid JSON.');
    }
    // "null", a bare number or a string all PARSE as valid JSON but are not a
    // request. Reading .action off them would throw a raw TypeError, and the
    // owner would see engine debris instead of a sentence.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Request body is not valid JSON. Expected {token, action, payload}.');
    }
    var action = asStr(body.action);
    var payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

    var ss = SpreadsheetApp.getActive();
    var settings = readSettings(ss);
    var expectedToken = asStr(settings.token);
    if (!expectedToken) {
      throw new Error('API token is not configured. Run setupSheet() from the Apps Script editor.');
    }
    if (asStr(body.token) !== expectedToken) {
      throw new Error('Invalid token.');
    }

    var data;
    switch (action) {
      case 'ping':
        data = { version: VERSION };
        break;
      case 'bootstrap':
        data = apiBootstrap(ss, settings);
        break;
      case 'saveDay':
        data = withLock(function () { return apiSaveDay(ss, settings, payload); });
        break;
      case 'saveExpense':
        data = withLock(function () { return apiSaveExpense(ss, payload); });
        break;
      case 'deleteExpense':
        data = withLock(function () { return apiDeleteExpense(ss, payload); });
        break;
      case 'saveStockCount':
        data = withLock(function () { return apiSaveStockCount(ss, payload); });
        break;
      case 'saveStockDelivery':
        data = withLock(function () { return apiSaveStockDelivery(ss, payload); });
        break;
      case 'saveCutoffSplit':
        data = withLock(function () { return apiSaveCutoffSplit(ss, payload); });
        break;
      case 'saveTinCount':
        data = withLock(function () { return apiSaveTinCount(ss, payload); });
        break;
      case 'savePrices':
        data = withLock(function () { return apiSavePrices(ss, payload); });
        break;
      case 'saveSettings':
        data = withLock(function () { return apiSaveSettings(ss, payload); });
        break;
      case 'saveStockItems':
        data = withLock(function () { return apiSaveStockItems(ss, payload); });
        break;
      case 'range':
        data = apiRange(ss, settings, payload);
        break;
      case 'sheetCheck':
        // Pure read: an integrity audit of the whole sheet for hand-edit
        // damage (v2.7.5). Writes nothing, moves no money.
        data = apiSheetCheck(ss);
        break;
      case 'costing':
        // Pure read (v2.8.0): management information, no lock and no write.
        // It must never reach the note or a cutoff figure — see apiCosting.
        data = apiCosting(ss, settings, payload);
        break;
      case 'cutoff':
        // dryRun is a pure read (preview); only the archiving variant mutates.
        data = asBool(payload.dryRun)
          ? apiCutoff(ss, settings, payload, true)
          : withLock(function () { return apiCutoff(ss, settings, payload, false); });
        break;
      default:
        throw new Error('Unknown action: "' + action + '".');
    }
    return jsonOut({ ok: true, data: data });
  } catch (err) {
    return jsonOut({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Serializes all mutations. Sheets has no transactions, so this is the only
 *  guard against two phones saving at the same moment. */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error('Server is busy (could not obtain lock). Please try again.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// API actions
// ---------------------------------------------------------------------------

function apiBootstrap(ss, settings) {
  var priceInfo = readPrices(ss);
  var prices = priceInfo.list;
  var expensesAll = readExpenses(ss);
  var backlogs = readBacklogs(ss, expensesAll);
  var usageAll = readStockUsage(ss);
  var countsAll = readStockCounts(ss);
  var deliveriesAll = readStockDeliveries(ss);

  // ONE window for everything the phone gets: the last 90 days, by DATE.
  //
  // Sales used to be capped at the last 45 DailyLog ROWS while expenses were
  // capped at 90 days. The Cutoff screen's back-arrows then showed an older
  // period that had its expenses but neither its sales nor its daily supplies,
  // so the preview understated that period badly (and the phone had no way to
  // know a figure was missing rather than zero). Same cutoff for all of them.
  var since = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), TZ, 'yyyy-MM-dd');
  var inWindow = function (row) { return row.date >= since; };

  var daysAll = readDays(ss, dailySalaryOf(settings));
  daysAll.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  var days = daysAll.filter(inWindow);

  var expenses = expensesAll.filter(inWindow);

  // Never echo the API token back inside data payloads.
  var publicSettings = {};
  for (var k in settings) {
    if (k !== 'token') publicSettings[k] = settings[k];
  }
  // The same cleaned branch the note is built with (see cleanBranch): the
  // phone's preview must head its note the way the server will.
  if (publicSettings.branch !== undefined) {
    publicSettings.branch = cleanBranch(publicSettings.branch);
  }
  // The Settings value column is "@"-formatted, so numeric values read back
  // as strings. The API contract ships known-numeric settings as numbers.
  publicSettings.mama_per_cutoff = asNum(settings.mama_per_cutoff);
  publicSettings.electric_per_cutoff = asNum(settings.electric_per_cutoff);
  publicSettings.daily_salary = dailySalaryOf(settings);
  publicSettings.split_default = splitDefaultOf(settings);

  return {
    settings: publicSettings,
    prices: prices,
    // Each stock item carries its COMPUTED on-hand figure and the numbers it is
    // made of, so the phone can show it and explain it without holding history
    // it does not have. Deliveries and usage are counted over the WHOLE history
    // (not the 90-day window) or on-hand would be wrong — and the two totals
    // ship SPLIT at window_start (delivered_before / used_before, v2.5.1), so
    // the phone can add its OWN in-window rows on top of the pre-window parts
    // and a local correction moves on-hand immediately.
    stockItems: stockItemsWithStatus(ss, expensesAll, usageAll, countsAll, deliveriesAll, since),
    backlogs: backlogs,
    // The window this reply SPEAKS FOR. The phone needs it stated explicitly:
    // inferring the window from the dates present cannot distinguish "this date
    // is older than the reply covers" from "this date was deleted in the sheet",
    // so a day or expense removed by hand lingered on the phone forever.
    window_start: since,
    days: days,
    // The SAME 90-day window as `days` and `expenses`, so a cutoff preview can
    // never show one side of a period without the other, and an edited day
    // always reloads complete. Each row carries the `in_cutoff` snapshot that
    // decided its money (a legacy blank reads TRUE — see countCutoffFlag) and
    // the price snapshot it was computed from, with a legacy blank price
    // resolved against the price list read above — so the phone is told what
    // counted, and at what price, rather than inferring either.
    counts: readCounts(ss, priceInfo.map).filter(inWindow),
    stockUsage: usageAll.filter(inWindow),
    stockCounts: countsAll.filter(inWindow),
    // Goods that ARRIVED (v2.6.0) — quantities only, never money. Windowed like
    // usage: the phone adds these to delivered_before for its own on-hand.
    stockDeliveries: deliveriesAll.filter(inWindow),
    expenses: expenses,
    // The entered Split per cutoff. Period-keyed, not date-keyed, so a period
    // that ENDS inside the window is shipped — that is every period the phone
    // can still page back to.
    cutoffInputs: readCutoffInputs(ss).filter(function (r) { return r.end >= since; }),
    lastCutoff: readLastCutoff(ss)
  };
}

/** REQUEST keys here are camelCase (payload.customAmount, payload.customGcash,
 *  payload.entryId, counts[].cheeseQty / gcashQty / gcashCheeseQty) — that is
 *  the documented client->server shape and must not change. The RESPONSE built
 *  at the bottom is snake_case.
 *
 *  FOUR PAYMENT/VARIANT BUCKETS per sku (mirrors the owner's own Sales
 *  Calculator). They are mutually exclusive and must sum to `sold`:
 *    cheese_qty        cheese, paid cash          (entered)
 *    gcash_qty         regular, paid GCash        (entered)
 *    gcash_cheese_qty  cheese, paid GCash         (entered)
 *    regular_qty       regular, paid cash         (DERIVED = the remainder)
 *  amount       = (regular_qty + gcash_qty) * price
 *               + (cheese_qty + gcash_cheese_qty) * cheese_price
 *  gcash_amount = gcash_qty * price + gcash_cheese_qty * cheese_price
 */
function apiSaveDay(ss, settings, payload) {
  var date = reqEntryDate(payload.date, 'date');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var closed = asBool(payload.closed);
  var staff = asStr(payload.staff);
  var notes = asStr(payload.notes);

  // --- Daily salary, SNAPSHOTTED onto the row.
  // 0 on a closed day (nobody worked). Otherwise the payload's own figure when
  // it sends one (a half day), else the CURRENT Settings daily_salary. It is
  // stored per day precisely so a later rate change never rewrites history —
  // the cutoff adds up what each day cost at the time, not today's rate.
  // An explicit 0 is honoured; only a missing/blank value falls back.
  var salary;
  if (closed) {
    salary = 0;
  } else if (payload.salary === null || payload.salary === undefined || asStr(payload.salary) === '') {
    salary = dailySalaryOf(settings);
  } else {
    salary = numOrThrow(payload.salary, "The day's salary");
    if (salary < 0) throw new Error("The day's salary cannot be negative.");
  }

  // A closed day has no sales by definition: counts/supplies/stock empty,
  // total 0. Ignore whatever the client sent for those (offline edits can
  // leave stale values) rather than rejecting the save.
  var custom = closed ? 0 : numOrThrow(payload.customAmount, 'Custom order amount');
  if (custom < 0) throw new Error('Custom order amount cannot be negative.');
  var customGcash = closed ? 0 : numOrThrow(payload.customGcash, 'The GCash part of the custom order');
  if (customGcash < 0) throw new Error('The GCash part of the custom order cannot be negative.');
  if (customGcash > custom) {
    throw new Error('The GCash part of the custom order (' + fmtAmt(customGcash) +
      ') cannot be more than the custom order amount (' + fmtAmt(custom) + ').');
  }
  // --- Money converted between the tin and GCash during the day (v2.7.0;
  // SIGNED since v2.7.3 — owner: "convert income cash to gcash, vice versa").
  // POSITIVE = tin cash swapped for a GCash transfer; NEGATIVE = GCash cashed
  // out of the tin. Either way it moves the SPLIT only — the day's Total is
  // untouched — so both floors are validated against the day's computed
  // figures AFTER the roll-up below, where they exist. Absent/blank (every
  // payload queued before v2.7.0) means 0: nothing was converted, and the
  // split lands exactly where it always did. Payloads queued by v2.7.0–v2.7.2
  // phones are always >= 0, so the sign change breaks nothing queued.
  var gcashConverted = closed ? 0 : numOrThrow(payload.gcashConverted, 'The converted amount');
  // --- Lid boxes used (v2.7.0). A plain count, whole units like everything
  // else that is counted: NO price, NO sales money, NO stock tracking, NO note
  // impact — it is stored, shipped back, and printed on the receipt, nothing
  // more. Absent means 0, like the other money on an old phone's payload.
  var lidBoxes = closed ? 0 : intOrThrow(payload.lidBoxes, 'Lid boxes used');
  if (lidBoxes < 0) throw new Error('Lid boxes used cannot be negative.');
  // --- The photo of the paper this night was read from (v2.9.0). A LINK, kept
  // beside the night purely so the figures can be checked against the paper
  // later; it prices nothing and is read by no total. Absent (every payload
  // queued before v2.9.0, and every night typed in by hand) means blank — and
  // because the row is rebuilt by header name, a save that omits it CLEARS any
  // link already there, deliberately: the reply must describe the payload it
  // was given rather than half of this save and half of an older one.
  var photoUrl = photoLinkOrThrow(payload.photoUrl);
  // payload.gcash is DELIBERATELY IGNORED. GCash used to be typed in from the
  // GCash app; it is now computed from the buckets above. A phone that queued
  // a saveDay before this update still carries the old typed `gcash` field —
  // reading it would write a figure that contradicts the counts.

  var rawCounts = closed ? [] : (payload.counts || []);
  if (!Array.isArray(rawCounts)) throw new Error('counts must be an array.');

  // --- Boxes a special order physically used, per sku (v2.7.0). They come off
  // the counted stack, so each is validated against ITS count line inside the
  // loop below (qty <= sold, group=box, counting in the cutoff) — here the
  // payload is only given shape. Absent (every payload queued before v2.7.0)
  // means no special order drew boxes, and every sku prices all of its sold.
  var rawCustomBoxes = closed ? [] : (payload.customBoxes || []);
  if (!Array.isArray(rawCustomBoxes)) throw new Error('customBoxes must be an array.');
  var customBySku = Object.create(null);
  rawCustomBoxes.forEach(function (cb) {
    cb = cb || {};
    var cbSku = asStr(cb.sku);
    // No sku, no identity — skipped like a blank count row.
    if (!cbSku) return;
    if (customBySku[cbSku] !== undefined) {
      throw new Error('Duplicate special-order boxes for sku "' + cbSku + '".');
    }
    customBySku[cbSku] = cb.qty;
  });
  var customSeen = Object.create(null);

  var priceInfo = readPrices(ss);
  var priceMap = priceInfo.map;
  // A Prices tab with NOTHING readable in it cannot price a single box. Without
  // this guard every sku fell into `dropped_skus` and the day quietly saved at
  // ₱0 — a whole night's money booked as nothing, behind an ok:true. Refusing
  // names the ACTUAL problem; per-sku gaps still go through the dropped path
  // below, because one renamed row must never cost the rest of the day (v2.5.0).
  if (priceInfo.list.length === 0 &&
      rawCounts.some(function (rc) { return asStr((rc || {}).sku) !== ''; })) {
    throw new Error("The Prices tab has no products the app can read, so tonight's boxes cannot " +
      'be priced. Open the Google Sheet and check the Prices tab — row 1 should name the columns ' +
      '(sku, label, group, size, price, cheese_price, active) with one product per row — then ' +
      'save the day again.');
  }
  // The prices already stored on THIS DATE's rows (v2.5.0): a re-save is a
  // correction of that night's counts, never a re-pricing of them.
  var storedPrices = storedPricesFor(ss, date);
  // Prototype-free accumulators throughout: a sku called "toString" must not
  // read as already-seen (which silently swallowed it from `dropped_skus`).
  var seenSkus = Object.create(null);
  var lines = [];
  // Skus the day referenced that are no longer in Prices. Reported to the
  // client as `dropped_skus` so it can say plainly what happened.
  var droppedSkus = [];
  var seenDropped = Object.create(null);

  rawCounts.forEach(function (c) {
    c = c || {};
    var sku = asStr(c.sku);
    // A row with no sku has no identity: it cannot be priced and there is
    // nothing to report about it. Skipped, like the blank filler rows the
    // readers tolerate — never a reason to fail the whole day.
    if (!sku) return;
    var p = priceMap[sku];
    if (!p) {
      // A count row whose sku is gone from Prices CANNOT be priced. Dropping
      // it and reporting it is the only way the rest of the day — including
      // every other sku's sales — can still be saved. Throwing here made the
      // day permanently un-saveable the moment a price row was renamed or
      // deleted, with no way out from the phone. The date's DailyCounts block
      // is rewritten from `lines` below, so the dropped sku's stale row for
      // this date goes with it (which is what the client tells the owner).
      if (!seenDropped[sku]) { seenDropped[sku] = true; droppedSkus.push(sku); }
      return;
    }
    if (seenSkus[sku]) throw new Error('Duplicate counts for sku "' + sku + '".');
    seenSkus[sku] = true;

    // --- Whether THIS LINE's money counts (v2.5.1). Resolved with the same
    // precedence as the prices below, and BEFORE the bucket guards, because it
    // is what they guard:
    //   1. the snapshot already stored on this date's own row — a re-save is a
    //      correction of that night, never a re-classification of it (a blank
    //      legacy snapshot reads TRUE, same as everywhere else: its money
    //      provably reached `total` when the day was saved);
    //   2. the flag the PHONE DISPLAYED when the night was entered, carried on
    //      the payload (`inCutoff`) — so a save queued offline lands telling
    //      the story the receipt and the tin told, not whatever the flag
    //      happens to say when it finally syncs;
    //   3. the current Prices flag — all a fresh save from an older build has.
    var stored = storedPrices[sku];
    var inCutoff;
    if (stored) {
      inCutoff = countCutoffFlag(stored.in_cutoff);
    } else if (c.inCutoff !== null && c.inCutoff !== undefined && asStr(c.inCutoff) !== '') {
      inCutoff = asCutoffFlag(c.inCutoff);
    } else {
      inCutoff = p.in_cutoff;
    }

    var sod = intOrThrow(c.sod, p.label + ' SOD');
    var eod = intOrThrow(c.eod, p.label + ' EOD');
    if (sod < 0) throw new Error(p.label + ': SOD cannot be negative.');
    if (eod < 0) throw new Error(p.label + ': EOD cannot be negative.');

    var sold = sod - eod;
    if (sold < 0) {
      throw new Error(p.label + ': EOD (' + eod + ') cannot be greater than SOD (' + sod + ').');
    }

    var gcashQty = intOrThrow(c.gcashQty, p.label + ' GCash qty');
    if (gcashQty < 0) throw new Error(p.label + ': GCash qty cannot be negative.');
    if (gcashQty > sold) {
      throw new Error(p.label + ': GCash qty (' + gcashQty + ') cannot exceed sold (' + sold + ').');
    }

    var cheeseQty = intOrThrow(c.cheeseQty, p.label + ' cheese qty');
    var gcashCheeseQty = intOrThrow(c.gcashCheeseQty, p.label + ' GCash cheese qty');
    if (p.group === 'box') {
      if (cheeseQty < 0) throw new Error(p.label + ': cheese qty cannot be negative.');
      if (cheeseQty > sold) {
        throw new Error(p.label + ': cheese qty (' + cheeseQty + ') cannot exceed sold (' + sold + ').');
      }
      if (gcashCheeseQty < 0) throw new Error(p.label + ': GCash cheese qty cannot be negative.');
      if (gcashCheeseQty > sold) {
        throw new Error(p.label + ': GCash cheese qty (' + gcashCheeseQty + ') cannot exceed sold (' + sold + ').');
      }
    } else if (cheeseQty !== 0 || gcashCheeseQty !== 0) {
      // group=simple has no cheese version at all.
      throw new Error(p.label + ' has no cheese version, so its cheese counts must be 0.');
    }

    // An EXCLUDED sku has NO variant or payment split at all — not GCash, not
    // cheese, not GCash cheese — and a count in ANY of those buckets is REFUSED
    // rather than accepted-and-hidden. Both options were on the table; this is
    // the only one that cannot make a day's Cash/GCash wrong:
    //   - accepting it and adding it to the day's GCash breaks Total = Cash +
    //     GCash outright (the money is not in Total);
    //   - accepting it and keeping it inside excluded_total only leaves the
    //     day's GCash figure SILENTLY short of the GCash app, and reconciling
    //     the computed GCash against GCash history is the entire reason that
    //     figure is shown. The owner would see a gap with nothing to explain it.
    // Guarding gcashQty alone was NOT enough (v2.4.1): gcashCheeseQty walked
    // straight through, was priced into excluded_total, and its money vanished
    // out of the day's GCash — the precise harm this guard exists to prevent.
    // Refusing says so out loud, names the item and names the bucket to zero.
    // The excluded money then behaves exactly as the owner asked: one plain
    // amount he settles himself, with no cash/GCash split to get wrong.
    // Guarded on the EFFECTIVE flag above, not the live Prices flag: a day
    // saved while the sku counted IN keeps its buckets on a re-save after the
    // sku was excluded, because its money is still classified IN (v2.5.1).
    if (!inCutoff) {
      var buckets = [];
      if (cheeseQty !== 0) buckets.push('cheese');
      if (gcashQty !== 0) buckets.push('GCash');
      if (gcashCheeseQty !== 0) buckets.push('GCash cheese');
      if (buckets.length > 0) {
        throw new Error(p.label + ' is kept out of the cutoff, so its money is not split into ' +
          'cash and GCash: its ' + joinAnd(buckets) + ' count' + (buckets.length > 1 ? 's' : '') +
          ' must be 0. Its total is shown on its own line.');
      }
      // ...and an excluded sku must be `group=simple` in the first place: one
      // plain quantity at one price. A group=box sku kept out of the cutoff is a
      // sheet that contradicts the app — the Sales card hides the cheese
      // steppers (an excluded sku has no split) while the payload can still
      // carry cheese quantities, so the phone and the sheet disagree about what
      // was sold. savePrices refuses to CREATE that state; this refuses to save
      // a day against it if it was made by hand, naming the item and saying what
      // to change. This fires whenever such a sku is PRESENT in the payload,
      // even with sod/eod both 0 — narrowing it to "only when something sold"
      // would reopen the very hole it closes, because the phone hides the cheese
      // steppers for an excluded sku while the payload still carries cheese
      // quantities, and a zero-count row today can be edited to a real one.
      if (p.group === 'box') {
        throw new Error(p.label + ' is kept out of the cutoff, but it is still set up as a box ' +
          'with a cheese version. An item kept out of the cutoff must be a simple item: one ' +
          'price, no cheese and no GCash. In the Prices tab either switch "counts in the ' +
          'cutoff" back on for it, or change its group to simple.');
      }
    }

    // --- Boxes the special order drew from THIS sku's counted stack (v2.7.0).
    // Whole units, at most what sold, and only from a box sku whose money
    // counts in the cutoff: an excluded sku's money is settled separately, so
    // a special order cannot draw from it — its total would silently shrink by
    // boxes the typed custom amount already covers. Those boxes contribute NO
    // menu-price money (the typed custom amount is the order's entire value),
    // so the sku's PRICED quantity below is sold − customQty.
    var customQty = 0;
    if (customBySku[sku] !== undefined) {
      customSeen[sku] = true;
      customQty = intOrThrow(customBySku[sku], p.label + ' special-order boxes');
      if (customQty < 0) throw new Error(p.label + ': special-order boxes cannot be negative.');
      if (customQty > 0) {
        if (!inCutoff) {
          throw new Error(p.label + ' is kept out of the cutoff and its money is settled ' +
            'separately, so a special order cannot use its boxes.');
        }
        if (p.group !== 'box') {
          throw new Error(p.label + ' is not a box, so a special order cannot use boxes from it.');
        }
        if (customQty > sold) {
          throw new Error(p.label + ': the special order used ' + customQty +
            ', but only ' + sold + ' were sold.');
        }
      }
    }

    // --- GIVEN AWAY OR RUINED (v2.10.1). Owner, 2026-08-28: takoyaki does get
    // given away and does get ruined. `sold` is sod − eod, which is what left
    // the TRAY, not what was paid for — so every freebie and every dropped box
    // was being booked at full menu price. That is money the app claimed and
    // the tin never saw, and it also flattered the cost-per-ball comparison.
    // Whole units, never negative, and never more than actually left the tray
    // (less whatever the special order already took).
    var freeQty = 0;
    if (c.freeQty !== undefined && c.freeQty !== null && asStr(c.freeQty) !== '') {
      freeQty = intOrThrow(c.freeQty, p.label + ' given away or ruined');
      if (freeQty < 0) throw new Error(p.label + ': given away or ruined cannot be negative.');
      if (freeQty > sold - customQty) {
        throw new Error(p.label + ': ' + freeQty + ' given away or ruined, but only ' +
          (sold - customQty) + ' left the tray' +
          (customQty > 0 ? ' after the special order took ' + customQty : '') +
          '. Lower it, or check the counts.');
      }
    }

    // The four buckets describe PAID sales only, so they bound against
    // sold − customQty − freeQty (v2.10.1; v2.7.0 for the special order) — with
    // neither of those, that is `sold`, exactly the guard this always was.
    var paid = cheeseQty + gcashQty + gcashCheeseQty;
    if (paid > sold - customQty - freeQty) {
      var roomWhy = [];
      if (customQty > 0) roomWhy.push('the special order used ' + customQty);
      if (freeQty > 0) roomWhy.push(freeQty + ' were given away or ruined');
      throw new Error(p.label + ': cheese (' + cheeseQty + ') + GCash (' + gcashQty +
        ') + GCash cheese (' + gcashCheeseQty + ') adds up to ' + paid +
        ', but only ' + (sold - customQty - freeQty) + ' were sold' +
        (roomWhy.length ? ' at menu price (' + roomWhy.join(', ') + ')' : '') +
        '. Lower one of them.');
    }
    // The remainder is plain cash regular — always derived, never sent — and
    // both the special order's boxes and the give-aways are outside it, so the
    // amounts below price exactly sold − customQty − freeQty units.
    var regularQty = sold - paid - customQty - freeQty;

    // --- The EFFECTIVE prices for this line (v2.5.0). A date being RE-SAVED
    // reuses the prices already stored on its own rows — a correction weeks
    // later fixes the count, it does not re-price the night. A sku's FIRST row
    // on a date uses the prices the PHONE DISPLAYED when the night was entered,
    // carried on the payload (`price`/`cheesePrice`, v2.5.1) — so a save queued
    // offline lands at the money the receipt and the tin showed, never at
    // whatever the price list says when it finally syncs. Only then the current
    // Prices tab — the only answer left for a legacy payload or a blank cell.
    var sentPrice = payloadPriceOrThrow(c.price, p.label + ' price');
    var sentCheese = payloadPriceOrThrow(c.cheesePrice, p.label + ' cheese price');
    var price = (stored && asStr(stored.price) !== '') ? asNum(stored.price)
      : (sentPrice !== '' ? sentPrice : p.price);
    var cheesePrice = (stored && asStr(stored.cheese_price) !== '') ? asNum(stored.cheese_price)
      : (sentCheese !== '' ? sentCheese : p.cheese_price);

    // A blank/zero price on a sku that is still SELLING books the night at
    // nothing — the server-side mirror of the savePrices guard (v2.5.0). Only a
    // hand-cleared cell can reach this state; refuse it, naming the item, so
    // the day is saved right or not at all. An INACTIVE sku is off the Sales
    // screen and out of the payload, so it never trips this.
    if (p.active && !(price > 0)) {
      throw new Error('"' + p.label + '" is switched on but has no price in the Prices tab, so ' +
        'the app would count every ' + p.label + ' sale as free. Set its price under Maintenance ' +
        '(or in the Prices tab), then save the day again.');
    }
    if (p.active && p.group === 'box' && !(cheesePrice > 0)) {
      throw new Error('"' + p.label + '" is switched on but has no cheese price in the Prices ' +
        'tab, so the app would count every cheese box as free. Set its cheese price under ' +
        'Maintenance (or in the Prices tab), then save the day again.');
    }

    // Price snapshot: amounts are computed NOW from the effective prices above
    // and stored on the row — WITH those prices beside them (v2.5.0) — so later
    // price edits never rewrite history.
    var amount = (regularQty + gcashQty) * price + (cheeseQty + gcashCheeseQty) * cheesePrice;
    var gcashAmount = gcashQty * price + gcashCheeseQty * cheesePrice;

    // Line objects are snake_case from here on: they are written to the
    // DailyCounts row AND returned to the client, and both of those are the
    // response side of the contract.
    lines.push({
      sku: sku, sod: sod, eod: eod, sold: sold,
      cheese_qty: cheeseQty, gcash_qty: gcashQty, gcash_cheese_qty: gcashCheeseQty,
      regular_qty: regularQty,
      amount: round2(amount), gcash_amount: round2(gcashAmount),
      // Whether this line's money COUNTED — the EFFECTIVE flag resolved above
      // (stored snapshot, then the payload's, then the live flag). Carried on
      // the line (and returned to the phone) so the receipt can print an
      // excluded sku below the totals instead of leaving the owner to work out
      // why they do not add up.
      in_cutoff: inCutoff,
      // The prices the money above was computed from — the rest of the snapshot.
      price: round2(price), cheese_price: round2(cheesePrice),
      // How many of `sold` the special order used (v2.7.0). Part of the same
      // snapshot: this row's `amount` prices sold − custom_qty units, and the
      // row alone must be able to say so.
      custom_qty: customQty,
      // How many of `sold` were never paid for (v2.10.1). Same snapshot rule:
      // this row's `amount` prices sold − custom_qty − free_qty units, and the
      // row alone must be able to say so.
      free_qty: freeQty
    });
  });

  // A special-order sku the counts do not carry cannot be checked against
  // anything it sold. A sku that was DROPPED above goes quietly with its count
  // line (one renamed price row must never cost the whole day); anything else
  // with a real quantity is refused in the loop's own terms — nothing sold,
  // so nothing for a special order to use.
  for (var cbSku in customBySku) {
    if (customSeen[cbSku] || seenDropped[cbSku]) continue;
    var strayQty = intOrThrow(customBySku[cbSku], cbSku + ' special-order boxes');
    if (strayQty < 0) throw new Error(cbSku + ': special-order boxes cannot be negative.');
    if (strayQty > 0) {
      throw new Error(cbSku + ': the special order used ' + strayQty +
        ', but only 0 were sold.');
    }
  }

  // payload.supplies is DELIBERATELY IGNORED (v2.3.0). The nightly "supplies
  // bought today" card is retired: purchases live in Expenses(Supplies) and
  // nowhere else, so the cutoff can never count one twice. A phone that queued
  // a saveDay before this update still carries the old `supplies` array —
  // writing it would resurrect a tab nothing reads.

  // --- Stock used (quantities) — NEVER money, never touches any total.
  // WHOLE UNITS OPENED, counted like the boxes: if a gallon of sauce is opened
  // it counts as used that day. Integers only — never a fractional weight,
  // never a running estimate.
  // StockItems is advisory, not referential integrity, for the same reason it
  // always was: a renamed product must never cost the owner a whole day of
  // sales, and there would be no way out from the phone.
  var rawStock = closed ? [] : (payload.stock || []);
  if (!Array.isArray(rawStock)) throw new Error('stock must be an array.');
  if (rawStock.length > 0) readTabForWrite(ss, TAB.STOCK_ITEMS);
  var seenStock = Object.create(null);
  var stockRows = [];
  rawStock.forEach(function (s) {
    s = s || {};
    var product = asStr(s.product);
    if (!product) throw new Error('A stock row is missing its product name.');
    if (seenStock[product]) throw new Error('Duplicate stock rows for "' + product + '".');
    seenStock[product] = true;
    var qty = numOrThrow(s.qty, product + ' quantity');
    if (qty < 0) throw new Error(product + ': quantity cannot be negative.');
    wholeUnitsOrThrow(qty, s.qty, product);
    if (qty > 0) stockRows.push({ product: product, qty: qty });
  });

  // --- Day roll-up. Cash = Total − GCash still holds; GCash is now derived
  // from what was actually entered instead of read off the GCash app.
  //
  // ONLY in_cutoff skus reach total/gcash (v2.4.0). An excluded sku's money is
  // summed into excluded_total and goes nowhere else: not into total, not into
  // cash, not into gcash, and therefore into no cutoff figure and no note line.
  // The gcash filter below is belt-and-braces — the guard in the loop above
  // already refuses EVERY bucket on an excluded sku, so its gcash_amount is
  // always 0 — but it is what makes "cash = total - gcash" true by construction
  // rather than by argument.
  var counted = lines.filter(function (l) { return l.in_cutoff; });
  var excludedLines = lines.filter(function (l) { return !l.in_cutoff; });
  var total = round2(counted.reduce(function (s, l) { return s + l.amount; }, 0) + custom);
  var gcashSales = round2(counted.reduce(function (s, l) { return s + l.gcash_amount; }, 0) + customGcash);
  // A conversion can only move money that EXISTS on the side it leaves: at
  // most the day's computed cash when converting cash to GCash, at most the
  // day's computed GCash when cashing GCash out (v2.7.3) — so neither figure
  // can ever go negative. Refused naming both figures — a cap applied
  // silently would save a split the tin does not show.
  var cashBefore = round2(total - gcashSales);
  if (gcashConverted > cashBefore) {
    throw new Error('The cash converted to GCash (' + fmtAmt(gcashConverted) +
      ") cannot be more than the day's cash (" + fmtAmt(cashBefore) + ').');
  }
  if (gcashConverted < 0 && -gcashConverted > gcashSales) {
    throw new Error('The GCash taken out as cash (' + fmtAmt(-gcashConverted) +
      ") cannot be more than the day's GCash (" + fmtAmt(gcashSales) + ').');
  }
  // gcash = per-sku GCash + the custom order's GCash + the signed conversion,
  // and cash is the remainder — Total = Cash + GCash by construction, as ever.
  var gcash = round2(gcashSales + gcashConverted);
  var cash = round2(total - gcash);
  var excludedTotal = round2(excludedLines.reduce(function (s, l) { return s + l.amount; }, 0));

  var stamp = nowStamp();

  // --- Rewrite this date's blocks in the two date-keyed detail tabs FIRST, and
  // write the DailyLog row LAST (v2.5.0). The DailyLog row is the one the phone
  // (and the cutoff) treats as "this day exists, and this is its money" — so if
  // the save dies half way, the failure must leave detail rows a retry rewrites
  // cleanly, never a DailyLog row whose totals have no counts behind them
  // looking like a perfectly saved day. Within the details, DailyCounts stays
  // ahead of StockUsage, and each block is written before its surplus is
  // cleared — see rewriteDateBlock for that half of the ordering.
  rewriteDateBlock(ss, TAB.DAILY_COUNTS, date, lines.map(function (l) {
    return {
      date: date, sku: l.sku, sod: l.sod, eod: l.eod, sold: l.sold,
      cheese_qty: l.cheese_qty, regular_qty: l.regular_qty, amount: l.amount,
      entry_id: entryId,
      gcash_qty: l.gcash_qty, gcash_cheese_qty: l.gcash_cheese_qty, gcash_amount: l.gcash_amount,
      // The flag is SNAPSHOTTED beside the money it decided, exactly as the
      // price is (v2.4.1). Whether this line's money counted is a fact about
      // THIS day, settled when it was saved — so a later flip of "counts in the
      // cutoff" cannot restate a cutoff that has already been sent.
      in_cutoff: l.in_cutoff,
      // ...and the prices themselves (v2.5.0), completing the snapshot: the
      // amounts on this row can now always be explained from the row alone, and
      // a re-save of this date reuses these instead of today's price list.
      price: l.price, cheese_price: l.cheese_price,
      // How many of `sold` the special order used (v2.7.0) and how many were
      // never paid for (v2.10.1) — the rest of the snapshot: `amount` prices
      // sold − custom_qty − free_qty units.
      custom_qty: l.custom_qty, free_qty: l.free_qty
    };
  }));
  rewriteDateBlock(ss, TAB.STOCK_USAGE, date, stockRows.map(function (r) {
    return { date: date, product: r.product, qty: r.qty, entry_id: entryId, updated_at: stamp };
  }));

  // --- Upsert DailyLog by date (one row per date => replays cannot duplicate),
  // LAST — see the write-order note above. The row is built BY HEADER NAME on
  // top of the existing row, so a column the owner added by hand survives the
  // upsert and column order does not matter.
  var log = readTabForWrite(ss, TAB.DAILY_LOG);
  var logWidth = writeWidth(log, TAB.DAILY_LOG);
  var logDateIdx = colOf(log, 'date');
  var found = -1;
  for (var i = 1; i < log.values.length; i++) {
    if (asDateStr(log.values[i][logDateIdx]) === date) { found = i + 1; break; }
  }
  var logObj = {
    date: date, closed: closed, staff: staff, gcash: gcash, total: total, cash: cash,
    custom_amount: custom, custom_gcash: customGcash, notes: notes,
    entry_id: entryId, updated_at: stamp, salary: salary,
    excluded_total: excludedTotal,
    gcash_converted: gcashConverted, lid_boxes: lidBoxes,
    photo_url: photoUrl
  };
  var logRow = buildRow(log, logWidth, logObj, found > 0 ? padRow(log.values[found - 1], logWidth) : null);
  if (found > 0) {
    log.sheet.getRange(found, 1, 1, logWidth).setValues([logRow]);
  } else {
    log.sheet.appendRow(logRow);
  }

  // RESPONSE: snake_case. The PWA's applyServerDay() copies these straight
  // onto its DailyCounts mirror, which is snake_case in localStorage.
  return {
    total: total,
    cash: cash,
    gcash: gcash,
    // The snapshot that was actually stored, so the phone shows the figure the
    // cutoff will use rather than re-deriving it. `supplies_total` is GONE with
    // the retired supplies card: a key that could only ever answer 0 is worse
    // than no key at all.
    salary: salary,
    // The day's money from in_cutoff=FALSE skus. It is NOT inside total/cash/
    // gcash above and must never be added to them — the receipt shows it on its
    // own line BELOW them, because the nori cash sits in the same tin and the
    // tin equals cash + excluded_total. Always present (0 when there is none).
    excluded_total: excludedTotal,
    // The stored snapshots the phone should show, like `salary` above (v2.7.0):
    // the converted cash is already inside `gcash` and out of `cash`, and the
    // receipt prints it only when non-zero; lid boxes are a plain count with no
    // money anywhere. Always present (0 when there is none).
    gcash_converted: gcashConverted,
    lid_boxes: lidBoxes,
    // The link that was stored (v2.9.0), '' when there is none — always present,
    // so the phone shows what the sheet actually holds instead of assuming its
    // own payload landed.
    photo_url: photoUrl,
    // Always present (empty when nothing was dropped) so the client never has
    // to guess whether an older server simply omitted it.
    dropped_skus: droppedSkus,
    lines: lines.map(function (l) {
      return {
        sku: l.sku, sold: l.sold,
        cheese_qty: l.cheese_qty, gcash_qty: l.gcash_qty,
        gcash_cheese_qty: l.gcash_cheese_qty, regular_qty: l.regular_qty,
        amount: l.amount, gcash_amount: l.gcash_amount,
        // Did this line's money count? The phone needs it per line to render an
        // excluded sku correctly instead of inferring it from a stale price list.
        in_cutoff: l.in_cutoff,
        // The prices this line's money was computed from (v2.5.0), so the
        // phone's mirror of the day matches the sheet's snapshot exactly.
        price: l.price, cheese_price: l.cheese_price,
        // How many of `sold` the special order used (v2.7.0), so the receipt
        // can print "Box 10 ×6, less 1 for the special order" from the reply —
        // and how many were given away or ruined (v2.10.1), for the same reason.
        custom_qty: l.custom_qty, free_qty: l.free_qty
      };
    })
  };
}

/**
 * The price/cheese_price snapshots already stored on ONE date's DailyCounts
 * rows, RAW (blank stays '', so the caller can tell "no snapshot" from ₱0),
 * keyed by sku, first row per sku winning like every other reader.
 *
 * This is what makes a RE-SAVE of an existing date keep that date's own prices
 * (v2.5.0): before it, editing last Tuesday's count after a price change
 * silently re-priced last Tuesday at today's prices — history rewritten by the
 * exact mechanism (compute-at-save) that exists to prevent it. Tolerant read:
 * a sheet without the tab, or without the price columns yet, simply answers
 * "no snapshots" and the current Prices tab is used, which is all a fresh save
 * ever did.
 */
function storedPricesFor(ss, date) {
  var out = Object.create(null);
  var t = readTabOptional(ss, TAB.DAILY_COUNTS);
  if (!t || t.col['date'] === undefined) return out;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    if (asDateStr(cellOf(r, t, 'date')) !== date) continue;
    var sku = asStr(cellOf(r, t, 'sku'));
    if (!sku || out[sku]) continue;
    out[sku] = {
      price: cellOf(r, t, 'price'),
      cheese_price: cellOf(r, t, 'cheese_price'),
      // The in_cutoff snapshot stored beside them (v2.5.1): a re-save must also
      // reuse the CLASSIFICATION the date was saved with, or a Maintenance flip
      // moves an already-saved day's money between the cutoff and the excluded
      // block the moment the day is re-saved for a note edit.
      in_cutoff: cellOf(r, t, 'in_cutoff')
    };
  }
  return out;
}

/** A price the PHONE sent on a saveDay count row (v2.5.1) — '' when the payload
 *  does not carry one (an older build's queued save), else a validated number.
 *  It is a price, so a negative one is refused in plain English; ₱0 is passed
 *  through and the active-sku blank-price guard decides whether it may stand. */
function payloadPriceOrThrow(v, label) {
  if (v === null || v === undefined || asStr(v) === '') return '';
  var n = numOrThrow(v, label);
  if (n < 0) throw new Error(label + ' cannot be negative.');
  return n;
}

function apiSaveExpense(ss, payload) {
  var date = reqEntryDate(payload.date, 'date');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var category = asStr(payload.category);
  if (EXPENSE_CATEGORIES.indexOf(category) === -1) {
    throw new Error('Invalid category "' + category + '". Allowed: ' + EXPENSE_CATEGORIES.join(', ') + '.');
  }
  var amount = numOrThrow(payload.amount, 'Amount');
  if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
  // REQUEST keys are camelCase (payload.backlogRef, payload.entryId).
  var backlogRef = asStr(payload.backlogRef);
  if (category === 'Backlog' && !backlogRef) {
    throw new Error('backlogRef is required when category is Backlog.');
  }
  var item = asStr(payload.item);
  var notes = asStr(payload.notes);
  // Where the money came from (v2.12.0). Omitted or blank stays blank — an
  // older phone knows nothing about this and must keep landing exactly as it
  // did. A value that is not one of the three is refused rather than coerced:
  // silently filing an unknown source as "the tin" would invent a shortage.
  var paidFrom = asStr(payload.paidFrom);
  if (paidFrom !== '' && PAID_FROM.indexOf(paidFrom) === -1) {
    throw new Error('Invalid paidFrom "' + paidFrom + '". Allowed: ' + PAID_FROM.join(', ') + ', or blank.');
  }

  // --- An expense carries MONEY ONLY (v2.6.0). Deliveries used to ride on this
  // row (stock_product/stock_qty), which forced a price onto unpaid flour — his
  // suppliers deliver on credit, so goods arriving and money leaving are two
  // different events on two different days. Goods arriving now go through
  // saveStockDelivery ("Stock came in" under Stock on hand), and a payload that
  // still names stock here is REFUSED in one plain sentence — a queued row from
  // an older phone lands on the needs-attention list saying exactly this,
  // instead of quietly writing a delivery that "Stock came in" then double-counts.
  // Only a NON-BLANK value refuses: every ordinary expense the phone has ever
  // queued carries both keys as ''.
  var hasStockField = asStr(payload.stockProduct) !== '' ||
    !(payload.stockQty === null || payload.stockQty === undefined || asStr(payload.stockQty) === '');
  if (hasStockField) {
    throw new Error('Deliveries are recorded under Stock on hand now, so this expense should carry money only.');
  }

  // stock_product / stock_qty are DELIBERATELY absent from this object: the two
  // columns stay in the sheet and EXISTING rows keep counting into on-hand
  // forever (never restate the past), so an upsert must leave those cells
  // exactly as they are — buildRow copies the existing row first, and a column
  // the object does not mention keeps whatever it holds. Writing '' here would
  // let a replayed edit wipe a legacy delivery's quantity off the shelf.
  var obj = {
    date: date, category: category, item: item, amount: amount,
    backlog_ref: backlogRef, notes: notes, entry_id: entryId, updated_at: nowStamp(),
    paid_from: paidFrom
  };

  // Upsert by entry_id: replaying the same mutation rewrites the same row.
  var t = readTabForWrite(ss, TAB.EXPENSES);
  var width = writeWidth(t, TAB.EXPENSES);
  var idIdx = colOf(t, 'entry_id');
  var found = -1;
  for (var i = 1; i < t.values.length; i++) {
    if (asStr(t.values[i][idIdx]) === entryId) { found = i + 1; break; }
  }
  var row = buildRow(t, width, obj, found > 0 ? padRow(t.values[found - 1], width) : null);
  if (found > 0) {
    t.sheet.getRange(found, 1, 1, width).setValues([row]);
  } else {
    t.sheet.appendRow(row);
  }
  return { entry_id: entryId, updated: found > 0, paid_from: paidFrom }; // RESPONSE: snake_case
}

function apiDeleteExpense(ss, payload) {
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var t = readTab(ss, TAB.EXPENSES);
  var idIdx = colOf(t, 'entry_id');
  for (var i = 1; i < t.values.length; i++) {
    if (asStr(t.values[i][idIdx]) === entryId) {
      t.sheet.deleteRow(i + 1);
      return { deleted: true };
    }
  }
  // Not found: already deleted (e.g. queue replay). Idempotent success.
  return { deleted: false };
}

/** A physical stocktake, which BECOMES the new baseline for that product: from
 *  here on, on-hand is this figure plus deliveries and minus usage AFTER this
 *  date. That is what absorbs spoilage, breakage and miscounts instead of
 *  letting them skew on-hand forever.
 *  A count is understood as an END-OF-DAY figure, so the same day's deliveries
 *  and usage are already inside it and are NOT added again. */
function apiSaveStockCount(ss, payload) {
  var date = reqEntryDate(payload.date, 'date');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var product = asStr(payload.product);
  if (!product) throw new Error('Say which product you counted.');
  readTabForWrite(ss, TAB.STOCK_ITEMS);
  if (!readStockItems(ss).map[product]) {
    throw new Error('There is no stock product called "' + product +
      '". Pick one from the list, or add it under Maintenance first.');
  }
  var qty = numOrThrow(payload.qty, 'The counted quantity');
  if (qty < 0) throw new Error('The counted quantity cannot be negative.');
  // A stocktake counts the same WHOLE UNITS as everything else — and it BECOMES
  // the baseline, so a 2.5 typed here is not one bad row: every on-hand figure
  // for that product carries the half from now until the next count.
  wholeUnitsOrThrow(qty, payload.qty, product);

  // Upsert by entry_id: replaying the same queued mutation rewrites its row.
  upsertRows(ss, TAB.STOCK_COUNTS, [{
    date: date, product: product, counted_qty: qty,
    entry_id: entryId, updated_at: nowStamp()
  }], ['entry_id']);

  // The figure the phone should now show. Recomputed from the sheet rather than
  // assumed to equal `qty`: a count backdated behind a later delivery or a
  // later usage row must land on the arithmetic, not on the number typed.
  var status = computeStockStatus(ss)[product];
  return {
    entry_id: entryId,
    product: product,
    on_hand: status ? status.on_hand : qty
  };
}

/** Goods ARRIVING, with no money anywhere near them (v2.6.0). Suppliers deliver
 *  on credit, so the quantity received is its own event: it lands here, raises
 *  on-hand, and touches no total and no note line. Paying the supplier later is
 *  an ordinary Supplies expense with no stock attached.
 *  Same rules as the other two ledger doors: WHOLE UNITS (the thing you open),
 *  the product checked against StockItems (a typo would silently credit a
 *  product that does not exist), and an event date — no future, no pre-2020.
 *  Upsert by entry_id, so a queue replay can never book one delivery twice. */
function apiSaveStockDelivery(ss, payload) {
  var date = reqEntryDate(payload.date, 'date');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var product = asStr(payload.product);
  if (!product) throw new Error('Say which product arrived.');
  // readTabForWrite first, so a sheet that has not been migrated by hand yet
  // gets the tab and its seeds instead of refusing every delivery.
  readTabForWrite(ss, TAB.STOCK_ITEMS);
  if (!readStockItems(ss).map[product]) {
    throw new Error('There is no stock product called "' + product +
      '". Pick one from the list, or add it under Maintenance first.');
  }
  var qty = numOrThrow(payload.qty, 'The quantity that arrived');
  if (qty < 0) throw new Error('The quantity that arrived cannot be negative.');
  // Whole units, in the same words the other two doors use; and at least ONE —
  // a delivery of nothing is not a delivery, and a 0 row would sit in the tab
  // saying something arrived when nothing did.
  wholeUnitsOrThrow(qty, payload.qty, product);
  if (qty < 1) {
    throw new Error(product + ': a delivery must be at least 1 whole unit — for nothing arriving, there is nothing to record.');
  }

  upsertRows(ss, TAB.STOCK_DELIVERIES, [{
    date: date, product: product, qty: qty,
    entry_id: entryId, updated_at: nowStamp()
  }], ['entry_id']);

  // The figure the phone should now show — recomputed from the sheet, exactly
  // as saveStockCount answers, so a backdated delivery behind a later stocktake
  // lands on the arithmetic (a count already contains everything before it).
  var status = computeStockStatus(ss)[product];
  return {
    entry_id: entryId,
    product: product,
    on_hand: status ? status.on_hand : qty
  };
}

/** The entered Split for one cutoff period. Upsert by (start, end) — the period
 *  is the natural key, so re-entering it converges on one row.
 *  WHOLE PESOS only (v2.5.0): the Split is money handed over in cash, and a
 *  centavo split also makes per_partner odd centavos that no note should carry.
 *  Refused plainly rather than rounded — rounding would save a figure the owner
 *  did not type. */
function apiSaveCutoffSplit(ss, payload) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var amount = numOrThrow(payload.amount, 'The split amount');
  if (amount < 0) throw new Error('The split amount cannot be negative.');
  if (Math.floor(amount) !== amount) {
    throw new Error('The split is whole pesos (like 3000), so "' + asStr(payload.amount) +
      '" cannot be saved. Leave out the centavos.');
  }

  upsertRows(ss, TAB.CUTOFF_INPUTS, [{
    start: start, end: end, split_amount: amount,
    entry_id: entryId, updated_at: nowStamp()
  }], ['start', 'end']);
  return {
    entry_id: entryId, start: start, end: end,
    split_amount: amount, per_partner: round2(amount / 2)
  };
}

/**
 * WHAT WAS ACTUALLY IN THE TIN, for one cutoff (v2.12.1).
 *
 * The other half of v2.12.0. The app can say what the tin SHOULD hold — cash
 * sales less what was paid out of it — and this is the figure that says what it
 * really held, so the two can be set side by side before the money is collected.
 *
 * It lives on the SAME CutoffInputs row as the split, keyed on (start, end), and
 * writes ONLY its own cell: buildRow starts from the existing row, so saving a
 * count can never disturb a split that was already entered (and the reverse).
 *
 * Centavos are allowed here, unlike the split: a tin holds coins, and rounding
 * her count would manufacture the very difference this screen exists to find.
 */
function apiSaveTinCount(ss, payload) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var counted = numOrThrow(payload.counted, 'The counted cash');
  if (counted < 0) throw new Error('The counted cash cannot be negative — a tin cannot hold less than nothing.');

  upsertRows(ss, TAB.CUTOFF_INPUTS, [{
    start: start, end: end, tin_counted: round2(counted),
    entry_id: entryId, updated_at: nowStamp()
  }], ['start', 'end']);
  return { entry_id: entryId, start: start, end: end, tin_counted: round2(counted) };
}

/** Maintenance screen: edit prices without opening the sheet on a phone.
 *  Upsert by sku, and ONLY the editable fields — price, cheese price, active,
 *  and `inCutoff` WHEN THE PAYLOAD EXPLICITLY SENDS IT. label, group and size
 *  are left exactly as they are, a sku the payload does not mention is not
 *  touched at all, and a payload that says nothing about `inCutoff` leaves that
 *  cell alone rather than defaulting it (see the guard below — defaulting it is
 *  how every takoyaki sku could fall out of the cutoff in one tap).
 *  Price edits apply to FUTURE days only: historical DailyCounts keep their
 *  snapshotted amounts, which is the whole point of computing money at save
 *  time. */
function apiSavePrices(ss, payload) {
  var rows = payload.rows;
  if (!Array.isArray(rows)) throw new Error('rows must be an array.');
  var known = readPrices(ss).map;
  var updated = [];
  rows.forEach(function (r) {
    r = r || {};
    var sku = asStr(r.sku);
    if (!sku) throw new Error('A price row is missing its sku.');
    if (!known[sku]) {
      // Deliberately NOT created: a price row also needs a group (box vs simple)
      // and a size, and guessing them would misprice every cheese box sold under
      // that sku. Adding a product is a sheet job, done once.
      throw new Error('There is no price called "' + sku +
        '". Add the row in the Prices tab first, then edit it here.');
    }
    var price = numOrThrow(r.price, sku + ' price');
    if (price < 0) throw new Error(sku + ': price cannot be negative.');
    var cheesePrice = numOrThrow(r.cheesePrice, sku + ' cheese price');
    if (cheesePrice < 0) throw new Error(sku + ': cheese price cannot be negative.');
    var active = asBool(r.active);
    // A ₱0 price on an item that is still SELLING is not a price, it is a
    // silent hole: every future day computes that sku's amount at nothing, the
    // receipt shows a box sold for free, and nothing anywhere says why. A blank
    // field arrives here as 0 (numOrThrow), so this catches the far more likely
    // case of a field cleared by accident on the Maintenance screen.
    // An INACTIVE sku may keep its 0 — it is off the Sales screen and sells
    // nothing, and refusing that would make an unpriced old sku un-saveable.
    if (active && !(price > 0)) {
      throw new Error('"' + sku + '" is switched on, so it needs a price. At 0 the app ' +
        'would count every sale as free. Type a price, or switch the item off first.');
    }
    // The cheese price is a price too, and clearing that field is exactly as
    // easy: it would sell every cheese box for nothing. Only group=box HAS a
    // cheese version — a group=simple sku must keep its 0 there.
    if (active && known[sku].group === 'box' && !(cheesePrice > 0)) {
      throw new Error('"' + sku + '" is switched on, so it needs a cheese price too. At 0 ' +
        'the app would count every cheese box as free. Type a price, or switch the item off first.');
    }
    var o = {
      sku: sku, price: round2(price), cheese_price: round2(cheesePrice),
      active: active
    };
    // box_cost follows the SAME omitted-means-leave-alone rule as in_cutoff
    // below, and for a stronger reason: it is not a flag with a safe default at
    // all. An older phone (or a batch queued before v2.8.0) sends nothing here,
    // and writing numOrThrow(undefined) === 0 would tell the costing screen
    // that every container is free. An EXPLICIT blank means the same thing the
    // sheet's blank cell means — no cost known — so it is written back blank,
    // never coerced to 0.
    if (!(r.boxCost === null || r.boxCost === undefined)) {
      if (asStr(r.boxCost) === '') {
        o.box_cost = '';
      } else {
        var boxCost = numOrThrow(r.boxCost, sku + ' box cost');
        if (boxCost < 0) throw new Error(sku + ': the box cost cannot be negative.');
        // NOT round2'd, unlike price and cheese_price. A container costs a
        // FRACTION of a centavo — box4 is ₱0.375, his bundle price over the
        // bundle count — and rounding it to 2 places would quietly restate the
        // owner's own figure as ₱0.38 the first time the Maintenance screen
        // loaded it and handed it back, which is ₱0.005 on every box he sells.
        // What is stored is what he typed; the costing figures round only where
        // they are shown.
        o.box_cost = boxCost;
      }
    }
    // in_cutoff is written ONLY when the payload explicitly says so. Omitted (or
    // blank) means "leave it exactly as it is": upsertRows copies the existing
    // row before applying these keys, so an unmentioned column keeps its cell —
    // including a BLANK one, which still reads TRUE. That is what makes the
    // ordinary Maintenance save safe. A price screen that knows nothing about
    // this flag (an older phone, or a batch queued before v2.4.0) sends
    // `undefined`; coercing that to false would take every takoyaki sku out of
    // the cutoff in one tap.
    // An explicit value goes through the SAME reader the sheet is read with, so
    // what lands in the cell is what comes back out.
    if (!(r.inCutoff === null || r.inCutoff === undefined || asStr(r.inCutoff) === '')) {
      o.in_cutoff = asCutoffFlag(r.inCutoff);
      // Keeping money out of the cutoff means ONE plain quantity at ONE price:
      // no cheese variant and no cash/GCash split. A `group=box` sku cannot be
      // that, so switching one out of the cutoff is REFUSED here rather than
      // half-honoured later — the Sales card would hide its cheese steppers
      // while the payload still carried cheese quantities, and the phone and the
      // sheet would then disagree about what was sold. saveDay refuses the same
      // combination for a sheet hand-edited into it.
      // Only an EXPLICIT false is checked: a payload that says nothing about the
      // flag (an older phone) must still be able to edit an existing row's price.
      if (o.in_cutoff === false && known[sku].group === 'box') {
        throw new Error('"' + sku + '" is a box with a cheese version, so it cannot be kept out ' +
          'of the cutoff: an item kept out is a simple item with one price and no cheese. ' +
          'Leave it counting in the cutoff, or change its group to simple in the Prices tab first.');
      }
    }
    updated.push(o);
  });
  // Validate the whole batch BEFORE writing any of it, so a typo in the third
  // row cannot leave the first two applied and the rest not.
  upsertRows(ss, TAB.PRICES, updated, ['sku']);
  return { saved: updated.length };
}

/** Maintenance screen: edit the handful of Settings the owner actually changes.
 *  WHITELISTED keys only and `token` is not on the list — an API that can
 *  rewrite its own shared secret can lock the owner out of his own sheet.
 *  A key that is not on the list is IGNORED (reported back as untouched), and
 *  every Settings row the payload does not mention is left alone. */
function apiSaveSettings(ss, payload) {
  var incoming = (payload.settings && typeof payload.settings === 'object') ? payload.settings : null;
  if (!incoming) throw new Error('settings must be an object.');

  var accepted = {};
  var ignored = [];
  for (var key in incoming) {
    // hasOwnProperty, not a plain lookup: "toString" and "constructor" are
    // inherited from Object.prototype and would otherwise read as whitelisted.
    var kind = Object.prototype.hasOwnProperty.call(SETTABLE_SETTINGS, key)
      ? SETTABLE_SETTINGS[key] : '';
    if (!kind) { ignored.push(key); continue; }
    if (kind === 'money') {
      // A BLANK money value means "leave it as it is", NEVER ₱0 (v2.5.0): a
      // cleared daily_salary field would otherwise make every following day
      // cost nothing, silently. Reported under `ignored` so the reply says
      // plainly that the key was not written.
      if (incoming[key] === null || incoming[key] === undefined || asStr(incoming[key]) === '') {
        ignored.push(key);
        continue;
      }
      var n = numOrThrow(incoming[key], key);
      if (n < 0) throw new Error(key + ' cannot be negative.');
      // The default Split is whole pesos for the same reason the entered one is
      // (see apiSaveCutoffSplit) — this is the figure that pre-fills it.
      if (key === 'split_default' && Math.floor(n) !== n) {
        throw new Error('The split is whole pesos (like 3000), so "' + asStr(incoming[key]) +
          '" cannot be saved as the default. Leave out the centavos.');
      }
      accepted[key] = n;
    } else {
      // The branch heads the note; a CR/LF pasted into it (easy on a phone)
      // would break the note's line structure, so line breaks become spaces.
      var s = key === 'branch' ? cleanBranch(incoming[key]) : asStr(incoming[key]);
      if (key === 'branch' && !s) throw new Error('The branch name cannot be empty.');
      accepted[key] = s;
    }
  }

  var t = readTab(ss, TAB.SETTINGS);
  var valueCol = colOf(t, 'value') + 1;
  var keyIdx = colOf(t, 'key');
  var rowOf = {};
  for (var i = 1; i < t.values.length; i++) {
    var k = asStr(t.values[i][keyIdx]);
    if (k && rowOf[k] === undefined) rowOf[k] = i + 1;
  }
  var toAppend = [];
  var savedKeys = [];
  for (var ak in accepted) {
    savedKeys.push(ak);
    if (rowOf[ak]) t.sheet.getRange(rowOf[ak], valueCol).setValue(accepted[ak]);
    else toAppend.push({ key: ak, value: accepted[ak] });
  }
  appendObjects(ss, TAB.SETTINGS, toAppend);
  savedKeys.sort();
  ignored.sort();
  return { saved: savedKeys, ignored: ignored };
}

/** Maintenance screen: edit each stock product's unit, reorder point, unit cost
 *  (v2.8.0) and whether it is still in use. Upsert by product; opening_qty /
 *  opening_date are never touched here (the baseline is moved by "Correct the
 *  count"), and a product the payload does not mention is left alone. */
function apiSaveStockItems(ss, payload) {
  var rows = payload.rows;
  if (!Array.isArray(rows)) throw new Error('rows must be an array.');
  readTabForWrite(ss, TAB.STOCK_ITEMS);
  var existing = readStockItems(ss);
  var maxSort = 0;
  existing.list.forEach(function (x) { if (x.sort > maxSort) maxSort = x.sort; });

  var out = [];
  rows.forEach(function (r) {
    r = r || {};
    var product = asStr(r.product);
    if (!product) throw new Error('A stock row is missing its product name.');
    var reorderAt = '';
    if (!(r.reorderAt === null || r.reorderAt === undefined || asStr(r.reorderAt) === '')) {
      reorderAt = numOrThrow(r.reorderAt, product + ' reorder point');
      if (reorderAt < 0) throw new Error(product + ': the reorder point cannot be negative.');
    }
    var o = {
      product: product,
      unit: asStr(r.unit),
      active: asBool(r.active),
      reorder_at: reorderAt
    };
    // unit_cost is written ONLY when the payload carries the key at all — the
    // same rule savePrices' box_cost and in_cutoff follow, and the same rule
    // saveDay's v2.7.0 keys follow. reorder_at above can be unconditional
    // because the Maintenance screen has always sent it; unit_cost cannot,
    // because a phone on older code sends no such key and coercing that to 0
    // would price the owner's whole consumption at nothing. An EXPLICIT blank
    // is a real instruction ("I do not know what this costs") and is written
    // back as a blank cell, not as ₱0.
    if (!(r.unitCost === null || r.unitCost === undefined)) {
      if (asStr(r.unitCost) === '') {
        o.unit_cost = '';
      } else {
        var unitCost = numOrThrow(r.unitCost, product + ' unit cost');
        if (unitCost < 0) throw new Error(product + ': the unit cost cannot be negative.');
        // Stored exactly as typed, for the same reason box_cost is (see
        // apiSavePrices): a cost derived by dividing a bundle price carries
        // more than two decimals, and a save that rounds it makes the figure
        // drift a little further every time the screen is opened.
        o.unit_cost = unitCost;
      }
    }
    // A brand-new product is safe to create here (unlike a price): it carries no
    // money at all. It starts with a zero baseline and no baseline date, exactly
    // like the seeded six.
    if (!existing.map[product]) {
      maxSort += 1;
      o.sort = maxSort;
      o.opening_qty = 0;
      o.opening_date = '';
    }
    out.push(o);
  });
  upsertRows(ss, TAB.STOCK_ITEMS, out, ['product']);
  return { saved: out.length };
}

/** Duplicate key values in a tab's RAW rows (the readers dedupe first-wins,
 *  so only a raw scan can SEE the stray row a hand-edit left behind). */
function rawDuplicates(ss, tabName, keyCols) {
  var t = readTabOptional(ss, tabName);
  var dups = [];
  if (!t) return dups;
  var seen = Object.create(null);
  for (var i = 1; i < t.values.length; i++) {
    var parts = [];
    for (var k = 0; k < keyCols.length; k++) parts.push(asDateStr(cellOf(t.values[i], t, keyCols[k])));
    var key = parts.join('');
    if (parts.join('') === '') continue;               // blank filler row
    if (seen[key] && dups.indexOf(parts.join(' + ')) === -1) dups.push(parts.join(' + '));
    seen[key] = true;
  }
  return dups;
}

/** Date cells that are NOT a date the readers can use. asDateStr normalises
 *  the shapes it knows and otherwise returns the cell VERBATIM — so a hand-
 *  retyped date like "28-07-2026" survives into every reader as if it were a
 *  date, and because every period filter is a STRING compare, that row falls
 *  outside every cutoff forever. Nothing else in this audit can see it: the
 *  row is present, its money is real, and no total complains (v2.7.5). */
function badDateCells(ss, tabName, cols) {
  var t = readTabOptional(ss, tabName);
  var out = [];
  if (!t) return out;
  for (var i = 1; i < t.values.length && out.length < 5; i++) {
    for (var c = 0; c < cols.length; c++) {
      var raw = cellOf(t.values[i], t, cols[c]);
      if (raw === '' || raw === null || raw === undefined) continue;   // blank is fine
      var norm = asDateStr(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
        out.push({ row: i + 1, col: cols[c], shown: asStr(raw) });
        break;
      }
    }
  }
  return out;
}

/** An integrity audit of the whole sheet (v2.7.5): everything a hand-edit can
 *  quietly break, said in plain sentences. Pure read — it writes nothing,
 *  moves no money, and finding nothing is the expected answer. */
function apiSheetCheck(ss) {
  var findings = [];
  var say = function (s) { if (findings.length < 40) findings.push(s); };

  // 1. Stray duplicate rows: every reader keeps the FIRST and ignores the
  // rest, so a duplicate is data the owner can see in the sheet but the app
  // silently does not use.
  var DUP_TABS = [
    [TAB.PRICES, ['sku'], 'Prices', 'sku'],
    [TAB.DAILY_LOG, ['date'], 'DailyLog', 'date'],
    [TAB.STOCK_ITEMS, ['product'], 'StockItems', 'product'],
    [TAB.CUTOFF_INPUTS, ['start', 'end'], 'CutoffInputs', 'period'],
    [TAB.EXPENSES, ['entry_id'], 'Expenses', 'entry_id'],
    [TAB.STOCK_DELIVERIES, ['entry_id'], 'StockDeliveries', 'entry_id'],
    [TAB.STOCK_COUNTS, ['entry_id'], 'StockCounts', 'entry_id'],
    [TAB.BACKLOGS, ['name'], 'Backlogs', 'name']
  ];
  for (var d = 0; d < DUP_TABS.length; d++) {
    var dups = rawDuplicates(ss, DUP_TABS[d][0], DUP_TABS[d][1]);
    for (var i = 0; i < dups.length && i < 5; i++) {
      say(DUP_TABS[d][2] + ': two rows share the ' + DUP_TABS[d][3] + ' "' + dups[i] +
        '" — the app uses the first and ignores the rest. Delete the stray row.');
    }
  }

  // 2. Prices that book money at nothing, or break the excluded-sku rule.
  var prices = readPrices(ss).list;
  for (var p = 0; p < prices.length; p++) {
    var pr = prices[p];
    if (pr.active && !(pr.price > 0)) {
      say('Prices: "' + pr.label + '" is active with price ' + pr.price +
        ' — every sale of it books ₱0. Set a price or set active to FALSE.');
    }
    if (pr.active && pr.group === 'box' && !(pr.cheese_price > 0)) {
      say('Prices: "' + pr.label + '" is an active box with cheese price ' + pr.cheese_price +
        ' — every cheese sale books ₱0.');
    }
    if (pr.group === 'box' && !pr.in_cutoff) {
      say('Prices: "' + pr.label + '" is a box sku marked out of the cutoff — an excluded item must be group=simple. The app refuses saves against it.');
    }
  }

  // 3. Expenses that would fold into the wrong note line.
  var backlogNames = Object.create(null);
  var backlogs = readBacklogs(ss, readExpenses(ss));
  for (var b = 0; b < backlogs.length; b++) backlogNames[backlogs[b].name] = true;
  var expenses = readExpenses(ss);
  var badCat = 0, badRef = 0, badAmt = 0;
  for (var e = 0; e < expenses.length; e++) {
    var x = expenses[e];
    if (EXPENSE_CATEGORIES.indexOf(x.category) === -1 && badCat++ < 3) {
      say('Expenses: "' + (x.item || x.entry_id) + '" (' + x.date + ') has category "' + x.category +
        '" — not one the note knows, so its ₱' + x.amount + ' folds into "Other payments".');
    }
    if (x.category === 'Backlog' && !backlogNames[x.backlog_ref] && badRef++ < 3) {
      say('Expenses: the backlog payment "' + (x.item || x.entry_id) + '" (' + x.date + ') points at "' +
        (x.backlog_ref || 'nothing') + '", which is not a Backlogs row — no balance drops for it.');
    }
    if (!(x.amount > 0) && badAmt++ < 3) {
      say('Expenses: "' + (x.item || x.entry_id) + '" (' + x.date + ') has amount ' + x.amount +
        ' — the app never saves money like that, so a hand-edit made it. Fix or delete the row; ' +
        'if it drags a whole note category below zero, the note refuses to generate.');
    }
  }

  // 4. Detail rows whose day is missing: saveDay writes DailyLog LAST, so an
  // orphan means a save died halfway (or a hand-deleted day left debris).
  var dayDates = Object.create(null);
  var days = readDays(ss, 0);
  for (var dd = 0; dd < days.length; dd++) dayDates[days[dd].date] = true;
  var orphanCounts = Object.create(null);
  var counts = readCounts(ss, null);
  for (var c = 0; c < counts.length; c++) {
    if (!dayDates[counts[c].date]) orphanCounts[counts[c].date] = true;
  }
  var orphanList = Object.keys(orphanCounts);
  for (var o = 0; o < orphanList.length && o < 3; o++) {
    say('DailyCounts: rows exist for ' + orphanList[o] + ' but DailyLog has no such day — a save died halfway, or the day row was deleted by hand. Re-save that day from the app.');
  }

  // 5. Stock rows naming products the stock list does not know: their
  // quantities count into NOTHING on the Stock on hand card.
  var known = readStockItems(ss).map;
  var UNKNOWN = [
    [readStockUsage(ss), 'StockUsage'],
    [readStockCounts(ss), 'StockCounts'],
    [readStockDeliveries(ss), 'StockDeliveries']
  ];
  for (var u = 0; u < UNKNOWN.length; u++) {
    var said = 0;
    for (var r = 0; r < UNKNOWN[u][0].length; r++) {
      var row = UNKNOWN[u][0][r];
      if (row.product && !known[row.product] && said++ < 3) {
        say(UNKNOWN[u][1] + ': "' + row.product + '" (' + row.date + ') is not on the StockItems list — its quantity counts into no on-hand figure. Fix the name, or add the product.');
      }
    }
  }
  for (var e2 = 0; e2 < expenses.length; e2++) {
    var xe = expenses[e2];
    if (xe.stock_product && !known[xe.stock_product]) {
      say('Expenses: the legacy delivery on "' + (xe.item || xe.entry_id) + '" (' + xe.date + ') names "' +
        xe.stock_product + '", which is not on the StockItems list — those units count into no on-hand figure.');
      break;
    }
  }

  // 6. Days whose stored money disagrees with itself.
  for (var d2 = 0; d2 < days.length; d2++) {
    var day = days[d2];
    if (Math.abs(day.total - day.cash - day.gcash) > 0.01) {
      say('DailyLog: ' + day.date + ' stores Total ' + day.total + ' but Cash ' + day.cash +
        ' + GCash ' + day.gcash + ' — the cells were edited by hand. Re-save that day from the app.');
    }
  }

  // 7. Date cells that are not dates. The most common hand-edit there is, and
  // the most silent: the row keeps its money and every period filter skips it,
  // so a cutoff is quietly short and nothing else here would ever notice.
  var DATE_TABS = [
    [TAB.DAILY_LOG, ['date'], 'DailyLog'],
    [TAB.DAILY_COUNTS, ['date'], 'DailyCounts'],
    [TAB.EXPENSES, ['date'], 'Expenses'],
    [TAB.STOCK_USAGE, ['date'], 'StockUsage'],
    [TAB.STOCK_COUNTS, ['date'], 'StockCounts'],
    [TAB.STOCK_DELIVERIES, ['date'], 'StockDeliveries'],
    [TAB.CUTOFF_INPUTS, ['start', 'end'], 'CutoffInputs'],
    [TAB.BACKLOGS, ['start_date'], 'Backlogs']
  ];
  for (var dt = 0; dt < DATE_TABS.length; dt++) {
    var bad = badDateCells(ss, DATE_TABS[dt][0], DATE_TABS[dt][1]);
    for (var bi = 0; bi < bad.length; bi++) {
      say(DATE_TABS[dt][2] + ': row ' + bad[bi].row + ' has "' + bad[bi].shown +
        '" in its ' + bad[bi].col + ' cell, which is not a date the app can read — ' +
        'that row is skipped by every cutoff. Retype it as yyyy-mm-dd (2026-07-28).');
    }
  }

  return { findings: findings, checked_rows: expenses.length + days.length + counts.length };
}

function apiRange(ss, settings, payload) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');
  var inRange = function (x) { return x.date >= start && x.date <= end; };
  return {
    days: readDays(ss, dailySalaryOf(settings)).filter(inRange),
    // Same row shape as bootstrap, `in_cutoff` snapshot included.
    counts: readCounts(ss, readPrices(ss).map).filter(inRange),
    stockUsage: readStockUsage(ss).filter(inRange),
    stockCounts: readStockCounts(ss).filter(inRange),
    expenses: readExpenses(ss).filter(inRange)
  };
}

function apiCutoff(ss, settings, payload, dryRun) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');
  var inPeriod = function (x) { return x.date >= start && x.date <= end; };

  var days = readDays(ss, dailySalaryOf(settings)).filter(inPeriod);
  var expenses = readExpenses(ss).filter(inPeriod);

  var total = 0, gcash = 0, salary = 0;
  days.forEach(function (d) {
    total += d.total;
    gcash += d.gcash;
    // readDays already resolved this: 0 on a closed day, the day's snapshotted
    // wage when it has one, else the CURRENT daily_salary for a row saved
    // before salary was stored at all.
    salary += d.salary;
  });
  total = round2(total);
  gcash = round2(gcash);
  salary = round2(salary);
  var cash = round2(total - gcash);

  var mama = 0, supplies = 0, octopus = 0, electric = 0, other = 0;
  expenses.forEach(function (x) {
    switch (x.category) {
      case 'Mama': mama += x.amount; break;
      case 'Supplies': supplies += x.amount; break;
      case 'Octopus': octopus += x.amount; break;
      case 'Electric': electric += x.amount; break;
      case 'Backlog': // Backlog payments + misc = the note's "Other payments".
      case 'Other':
      default: // Unknown categories (hand-edited typos) fold into "other" so
        other += x.amount; // the accounting identity still balances.
        break;
    }
  });
  // Supplies is Expenses(category=Supplies) ALONE (v2.3.0). The nightly daily-
  // supplies card is retired, so a purchase now lives in exactly one place and
  // cannot be counted twice.

  mama = round2(mama); supplies = round2(supplies); octopus = round2(octopus);
  electric = round2(electric); other = round2(other);

  // A NEGATIVE category sum is a data error, full stop — saveExpense refuses
  // amounts <= 0, so only a hand-edited row can produce one — and a note built
  // on it states money that never existed. A non-dryRun REFUSES (v2.5.0,
  // DELIBERATE), naming the rows so the owner can fix them; a dryRun still
  // shows the negative plainly, because the preview is where he will see it.
  if (!dryRun) {
    var negCats = [];
    if (mama < 0) negCats.push('Mama');
    if (supplies < 0) negCats.push('Supplies');
    if (octopus < 0) negCats.push('Octopus');
    if (electric < 0) negCats.push('Electric');
    if (other < 0) negCats.push('Other payments');
    if (negCats.length > 0) {
      var noteCat = function (x) {
        switch (x.category) {
          case 'Mama': case 'Supplies': case 'Octopus': case 'Electric': return x.category;
          default: return 'Other payments';
        }
      };
      var offenders = expenses.filter(function (x) {
        return x.amount < 0 && negCats.indexOf(noteCat(x)) !== -1;
      }).map(function (x) {
        return x.date + ' ' + x.category + (x.item ? ' "' + x.item + '"' : '') +
          ' (' + fmtAmt(x.amount) + ')';
      });
      throw new Error('Cannot make the note: ' + joinAnd(negCats) +
        (negCats.length > 1 ? ' add up to less than zero' : ' adds up to less than zero') +
        ' for this period, because of ' +
        (offenders.length === 1 ? 'this expense row: ' : 'these expense rows: ') +
        offenders.join('; ') +
        '. A negative expense is a data mistake — fix or delete ' +
        (offenders.length === 1 ? 'that row' : 'those rows') +
        ' in the Expenses tab, then generate the note again.');
    }
  }

  // Split is an ENTERED amount, not the residual (owner, 2026-08-03). The
  // resolution order (v2.5.0) is: the CutoffInputs row saved for THIS period ->
  // the split this period's ARCHIVED note was built with -> the Settings
  // default. The middle step is what keeps an old period stable: without it,
  // regenerating January after split_default changed silently restated a note
  // that was already sent. Half each.
  var entered = readCutoffInputs(ss).filter(function (r) {
    return r.start === start && r.end === end;
  });
  var split;
  if (entered.length > 0) {
    split = round2(entered[0].split_amount);
  } else {
    var archived = archivedSplitFor(ss, start, end);
    split = archived === null ? splitDefaultOf(settings) : round2(archived);
  }
  var perPartner = round2(split / 2);

  // REMAINING is the residual now — what is left in the business after
  // everything, and the figure backlog payments are funded from. It MAY BE
  // NEGATIVE (a short cutoff); it is never clamped, because a clamp would hide
  // exactly the fortnight the owner most needs to see.
  var remaining = round2(total - mama - split - supplies - octopus - salary - other - electric);

  // --- Excluded skus: DISPLAY ONLY, and deliberately computed AFTER `remaining`
  // so it is obvious that nothing above can depend on it.
  //
  // Built from this period's DailyCounts joined to Prices: the AMOUNT is the one
  // snapshotted on the count row when the day was saved (so a later price edit
  // never rewrites history), and Prices is consulted only for the label and the
  // flag. `excluded` is the sum of the lines returned beside it, so the block
  // shown on the Cutoff screen always adds up to its own total.
  //
  // These two figures enter NOTHING: not total, cash, gcash, supplies or
  // remaining, and above all not buildNoteText — the owner chose "Cutoff screen
  // only", so the note his partner receives is byte-for-byte what it was.
  var excludedBlock = excludedForPeriod(ss, start, end);
  var excludedLines = excludedBlock.lines;
  var excluded = excludedBlock.total;

  // RESPONSE: snake_case (per_partner mirrors the Cutoffs column header).
  /* SUPPLIES USED, IN MONEY (v2.15.0). Owner, 2026-09-01: "theres a breakdown in
     the cutoff, but its still not shown in note."

     It is NOT an allocation and must never become one: the seven lines above sum
     with `remaining` to `total`, and that identity is what his partner checks.
     This is the value of stock OPENED, which answers a different question from
     the "Supplies" line (money PAID). So it is computed here, printed BELOW the
     residual, and left out of every sum.

     A product with no unit_cost on file is not costed at nothing — it is left
     out and the line says how many products it could not price, exactly as the
     costing screen does. */
  var usedByProduct = Object.create(null);
  readStockUsage(ss).forEach(function (u) {
    if (!inPeriod(u)) return;
    var name = asStr(u.product);
    var q = asNum(u.qty);
    if (!name || !(q > 0)) return;
    usedByProduct[name] = (usedByProduct[name] || 0) + q;
  });
  var stockList = readStockItems(ss).list;
  var costOf = Object.create(null);
  stockList.forEach(function (it) { costOf[asStr(it.product).toLowerCase()] = it.unit_cost; });
  var suppliesUsed = 0, suppliesUsedUnpriced = 0;
  for (var pname in usedByProduct) {
    var uc = costOf[pname.toLowerCase()];
    if (usableCost(uc)) suppliesUsed += usedByProduct[pname] * asNum(uc);
    else suppliesUsedUnpriced++;
  }
  suppliesUsed = round2(suppliesUsed);

  /* SUPPLIES (MINOR) — ONE LINE FOR EVERYTHING PAID (v2.20.0). The owner, after
     his ₱3,957 of daily buying went in under the "Other" bucket and so never
     reached the Supplies line: "supplies minor must sum all the entries,
     regardless of what it is, the only things that are not included in the
     minor are the major."

     So minor is every category entered on the Expenses screen — Supplies,
     Octopus and Other — and it REPLACES those three lines rather than joining
     them, or the same money would be counted twice. Mama, Electric, Split and
     Salary keep their own lines: they are not entered on that screen, and a
     partner reads them individually.

     `remaining` does not move by a centavo: it was already total minus all
     seven, and supplies + octopus + other is exactly the part being renamed.
     The three parts are STILL returned and still written to their own Cutoffs
     columns, so the archive keeps the detail the note no longer prints. */
  var suppliesMinor = round2(supplies + octopus + other);

  var figures = {
    start: start, end: end,
    total: total, cash: cash, gcash: gcash,
    mama: mama, split: split, per_partner: perPartner,
    supplies: supplies, octopus: octopus, salary: salary,
    other: other, electric: electric, remaining: remaining,
    // The one line the note and the Cutoff card print (v2.20.0).
    supplies_minor: suppliesMinor,
    // Display only. See above; and see the identity asserted in the tests:
    // total = mama + split + supplies_minor + salary + electric + remaining,
    // with `excluded` and `supplies_used` nowhere in it.
    excluded: excluded, excluded_lines: excludedLines,
    // Display only, like `excluded`, and outside the identity above.
    supplies_used: suppliesUsed, supplies_used_unpriced: suppliesUsedUnpriced
  };

  // Branch is read CLEANED (CR/LF -> space, v2.5.0): a line break pasted into
  // the Settings cell would otherwise split the note's first line in two.
  var branch = cleanBranch(settings.branch) || 'Tañong';
  var noteText = buildNoteText(branch, start, end, figures);

  if (!dryRun) {
    // A real generation with NO CutoffInputs row RECORDS the split it used
    // (v2.5.0), so the figure this note was built with is a fact in the sheet —
    // never something a later split_default edit can quietly move. An entered
    // row, when there is one, already is that record.
    if (entered.length === 0) {
      upsertRows(ss, TAB.CUTOFF_INPUTS, [{
        start: start, end: end, split_amount: split,
        entry_id: Utilities.getUuid(), updated_at: nowStamp()
      }], ['start', 'end']);
    }

    // Upsert by (start, end) — the period is the natural key. Retries and
    // legitimate regenerations converge on ONE archive row per period
    // instead of silently accumulating duplicates.
    var t = readTabForWrite(ss, TAB.CUTOFFS);
    var width = writeWidth(t, TAB.CUTOFFS);
    var startIdx = colOf(t, 'start');
    var endIdx = colOf(t, 'end');
    // The archive keeps the columns SPEC defines for it. Salary and Remaining
    // are not columns of their own: the archived note_text carries them
    // verbatim, and both are recomputed from DailyLog + Expenses + CutoffInputs
    // whenever the period is asked for again.
    var obj = {
      start: start, end: end, total: total, cash: cash, gcash: gcash,
      mama: mama, split: split, per_partner: perPartner, supplies: supplies,
      octopus: octopus, other: other, electric: electric,
      note_text: noteText, generated_at: nowStamp()
    };
    var found = -1;
    for (var i = 1; i < t.values.length; i++) {
      if (asDateStr(t.values[i][startIdx]) === start && asDateStr(t.values[i][endIdx]) === end) {
        found = i + 1;
        break;
      }
    }
    var row = buildRow(t, width, obj, found > 0 ? padRow(t.values[found - 1], width) : null);
    if (found > 0) {
      t.sheet.getRange(found, 1, 1, width).setValues([row]);
    } else {
      t.sheet.appendRow(row);
    }
  }

  return { figures: figures, note_text: noteText };
}

/**
 * The Split the ARCHIVED note for (start, end) was built with, or null when the
 * period was never archived (or the archive predates the split column — a blank
 * cell is "no answer", never ₱0, because ₱0 is a real entered split that blanks
 * the note's Split line). First matching row wins, like the upsert that writes
 * it. This is the middle step of the split resolution (v2.5.0): an already-sent
 * period keeps ITS split when it is regenerated, whatever the default says now.
 */
function archivedSplitFor(ss, start, end) {
  var t = readTabOptional(ss, TAB.CUTOFFS);
  if (!t) return null;
  var si = t.col['start'], ei = t.col['end'], pi = t.col['split'];
  if (si === undefined || ei === undefined || pi === undefined) return null;
  for (var i = 1; i < t.values.length; i++) {
    if (asDateStr(t.values[i][si]) === start && asDateStr(t.values[i][ei]) === end) {
      var raw = t.values[i][pi];
      return asStr(raw) === '' ? null : asNum(raw);
    }
  }
  return null;
}

/**
 * The period's money from in_cutoff=FALSE skus, per sku and in total.
 *
 * DISPLAY ONLY — nothing this returns may reach a cutoff figure or the note.
 * It exists because the owner asked to SEE the excluded total per cutoff while
 * keeping it out of everything ("just show the total per cutoff, and I'll
 * exclude it on my own").
 *
 *   qty    = Σ sold      over the period's DailyCounts rows for that sku
 *   amount = Σ amount    the SNAPSHOTTED money on those same rows, so a later
 *                        price edit cannot rewrite what a past day earned
 *
 * WHICH ROWS ARE EXCLUDED IS ALSO A SNAPSHOT (v2.4.1). Each row carries the
 * `in_cutoff` that decided its money when the day was saved, and that — never the
 * current Prices flag — is what classifies it here. Classifying history by the
 * live flag restated money the sheet had already banked, in BOTH directions:
 *   - tick nori back ON: the ₱300 that `total` never contained dropped out of the
 *     excluded block too, so it existed nowhere on the screen;
 *   - tick a counted sku OFF: money that IS inside `total` also appeared under
 *     "not part of this cutoff", i.e. shown twice, in two contradictory ways.
 * Neither is a display quirk — the owner reconciles his tin against these figures.
 * A row with a blank snapshot counts IN (see countCutoffFlag, v2.5.0): its money
 * was put inside the day's totals when it was saved, so listing it here as well
 * would state the same money twice.
 *
 * A count row whose sku is no longer in Prices keeps the same treatment it always
 * had: with no snapshot it counts IN (the flag's job is to remove one sku the
 * owner set up on purpose, never to quietly remove money nobody asked it to). But
 * an explicit FALSE snapshot on such a row IS still excluded money and is still
 * shown — listed after the priced skus, under its sku as its own label — because
 * `excluded` must always equal the lines printed beneath it.
 *
 * Skus are listed in Prices order so the block reads the same every time, and a
 * sku with nothing sold is left out rather than printed as a zero line.
 */
function excludedForPeriod(ss, start, end) {
  var prices = readPrices(ss);
  var agg = Object.create(null);
  var orphans = [];
  readCounts(ss, prices.map).forEach(function (c) {
    if (c.date < start || c.date > end) return;
    if (c.in_cutoff) return;
    if (!agg[c.sku]) {
      agg[c.sku] = { qty: 0, amount: 0 };
      if (!prices.map[c.sku]) orphans.push(c.sku);
    }
    agg[c.sku].qty += asNum(c.sold);
    agg[c.sku].amount += asNum(c.amount);
  });
  var lines = [];
  var total = 0;
  var emitted = Object.create(null);
  var emit = function (sku, label) {
    if (emitted[sku]) return;
    var a = agg[sku];
    if (!a || (a.qty === 0 && a.amount === 0)) return;
    emitted[sku] = true;
    lines.push({ sku: sku, label: label, qty: round2(a.qty), amount: round2(a.amount) });
    total += a.amount;
  };
  prices.list.forEach(function (p) { emit(p.sku, p.label); });
  orphans.forEach(function (sku) { emit(sku, sku); });
  return { lines: lines, total: round2(total) };
}


/**
 * "WHAT IT COSTS" (v2.8.0) — the costing the owner asked for on 2026-08-19
 * ("Costing of the current setup, how much should the price be in correlation
 * with the daily expenses"), answered from what was actually logged.
 *
 * PURE READ. No lock, no write, not one cell — and above all it NEVER touches
 * the cutoff note or any figure in it. Costing is management INFORMATION;
 * the note is money that has moved, and money that has moved is never restated.
 * The one figure the two share is `revenue`, which is deliberately the SAME
 * number the cutoff calls `total` (Σ DailyLog.total), read, not recomputed.
 *
 * TWO COST SOURCES, NEVER MIXED — the load-bearing rule of this whole action:
 *   variable.stock = Σ StockUsage.qty × StockItems.unit_cost
 *                    what was OPENED this period, whenever it was paid for.
 *   variable.money = Σ Expenses.amount in Supplies/Octopus, MINUS every row
 *                    that is a restock of a tracked product — money that LEFT
 *                    this period, whenever it is opened.
 * Adding a sack of flour to both counts it twice: once as money paid, once as
 * flour opened. The subtraction is what closes that, and it is a name match
 * (case-insensitive, trimmed) of the expense's `item` against StockItems —
 * the same list `stock` prices its consumption from, so the two sides can never
 * disagree about which products are tracked.
 * Over a short window the two genuinely differ (his suppliers deliver on
 * credit), which is why the screen says which is which rather than blending
 * them into one word.
 *
 * variable.boxes = Σ per-sku boxes sold × Prices.box_cost — the container the
 * balls leave in, priced per sku because that is how it varies.
 *
 * FIXED, not per ball: fixed.salary is Σ each open day's SNAPSHOTTED wage (the
 * cutoff's own figure), fixed.shares is mama_per_cutoff + electric_per_cutoff
 * for the period, and fixed.per_day spreads the two across the OPEN days.
 *
 * BALLS come from sold × the sku's `size`, so a `simple` sku (no size)
 * contributes none, and an EXCLUDED sku is out of BOTH sides — its money was
 * never in the cutoff either. Which rows are excluded is the count row's own
 * `in_cutoff` SNAPSHOT, never today's Prices flag: the same rule that keeps a
 * Maintenance tick from restating a cutoff that has already been sent.
 *
 * THE UNPRICED RULE: a product consumed (or a container sold) with no cost on
 * file is LISTED in `unpriced` and left OUT of the total. A cost that is
 * quietly too low is worse than one that is visibly absent — the owner would
 * price his boxes off it. A blank cell means "no cost known"; an explicit 0
 * (nori's container) is a real answer and counts as zero.
 *
 * NULL, NEVER ₱0: with no balls, or no open days, every per-ball and per-day
 * figure comes back `null`. A division by zero dressed as ₱0 would read as
 * "these balls cost nothing".
 *
 * TARGETS ARE ADVICE AND ARE NEVER APPLIED: `targets` says what each price
 * WOULD need to be for a chosen nightly take, holding the sales mix as it
 * actually was. Nothing here writes to Prices, and nothing here may.
 */
/** A cost cell, read the only honest way (v2.8.0): a usable figure, or BLANK.
 *  Blank means "not known" and is the documented case. But a hand-typed "P120",
 *  "12,50" or "-5" is NOT blank, and asNum would turn the first two into 0 and
 *  keep the third negative — costing at nothing, or at less than nothing, with
 *  every honesty guard staying silent because the cell "had a value". Anything
 *  that is not a finite figure of zero or more therefore reads exactly like
 *  blank: reported as unpriced, left out, and shown as empty so it gets
 *  retyped. Zero itself IS an answer (nori's box costs nothing). */
function costCell(v) {
  if (asStr(v) === '') return '';
  var n = Number(v);
  return (isFinite(n) && n >= 0) ? n : '';
}

/** Whether a cost cell holds a figure this screen may use (v2.8.0). BLANK is
 *  "not known" — that is the documented case. But a hand-typed "P120", "12,50"
 *  or "-5" is NOT blank, and asNum coerces the first two to 0 and keeps the
 *  third negative: costing at nothing, or at less than nothing, while the
 *  honesty guard stays silent. Anything that is not a finite figure of zero or
 *  more is therefore treated exactly like blank — reported as unpriced and
 *  left out. Zero itself IS an answer (nori's box costs nothing). */
function usableCost(v) {
  if (v === '' || v === null || v === undefined) return false;
  var n = Number(v);
  return isFinite(n) && n >= 0;
}

/** Whether a costed bucket name is about CONTAINERS — the promise `boxesCost`
 *  keeps by itself. Matched against the sku labels the owner actually sells
 *  ("Box 4" contains "box"), so a bucket he names "Box" or "Boxes" is
 *  recognised without a second setting to keep in step (v2.9.2). */
function boxBucket_(item, prices) {
  var k = asStr(item).toLowerCase();
  if (!k) return false;
  if (k === 'box' || k === 'boxes') return true;
  var list = (prices && prices.list) || [];
  for (var i = 0; i < list.length; i++) {
    var label = asStr(list[i].label).toLowerCase();
    if (label && (label === k || label.indexOf(k) === 0)) return true;
  }
  return false;
}

function apiCosting(ss, settings, payload) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');
  var inPeriod = function (x) { return x.date >= start && x.date <= end; };

  // The nightly take the targets aim at: what is LEFT per open day after every
  // cost above, i.e. the same figure as per_day.left. Omitted means "show me a
  // ladder of round figures" — illustrative, so the screen has something to
  // read before the owner types his own.
  var wants;
  if (payload.targetPerDay === null || payload.targetPerDay === undefined ||
      asStr(payload.targetPerDay) === '') {
    wants = [500, 1000, 1500];
  } else {
    var want = numOrThrow(payload.targetPerDay, 'the nightly target');
    if (want < 0) throw new Error('The nightly target cannot be negative.');
    wants = [want];
  }

  var prices = readPrices(ss);
  var items = readStockItems(ss);
  var days = readDays(ss, dailySalaryOf(settings)).filter(inPeriod);
  var counts = readCounts(ss, prices.map).filter(inPeriod);
  var usage = readStockUsage(ss).filter(inPeriod);
  var expenses = readExpenses(ss).filter(inPeriod);

  // Product names are matched case-insensitively and trimmed, on BOTH sides of
  // the double-count guard: "takoyaki flour " typed into an expense row is the
  // same sack as "Takoyaki Flour" on the stock list, and a match that missed
  // would count it twice.
  var lower = function (v) { return asStr(v).toLowerCase(); };
  var itemByName = Object.create(null);
  items.list.forEach(function (it) {
    var k = lower(it.product);
    if (k && itemByName[k] === undefined) itemByName[k] = it;
  });

  // --- The period's shape. `revenue` and `salary` are the cutoff's own sums,
  // so the two screens can never tell different stories about one fortnight.
  // dayByDate also answers "was this date entered at all", which the caveats
  // below need: a day that is simply missing is not a day with no sales.
  var dayByDate = Object.create(null);
  days.forEach(function (d) { dayByDate[d.date] = d; });
  var daysOpen = 0, revenue = 0, salary = 0, customMoney = 0;
  days.forEach(function (d) {
    if (!d.closed) daysOpen++;
    revenue += d.total;
    salary += d.salary;   // already 0 on a closed day (readDays resolves it)
    // A special order's money is a figure he TYPED, not a menu price, so it
    // cannot move when a menu price moves. The targets below must leave it
    // out of what they scale, or the advice quietly under-delivers.
    customMoney += d.custom_amount;
  });
  revenue = round2(revenue);
  salary = round2(salary);
  customMoney = round2(customMoney);

  // --- Balls, containers, and what sold. Driven by the count rows' OWN
  // in_cutoff snapshot; `sold` (not sold − custom_qty) is the right driver for
  // both, because a special order's boxes were physically made and physically
  // used — only their MONEY moved to the typed custom amount, and that amount
  // is already inside `revenue`.
  var soldBySku = Object.create(null);
  var balls = 0, boxesCost = 0;
  var unpricedBox = Object.create(null);
  counts.forEach(function (c) {
    if (!c.in_cutoff) return;            // excluded money is out of BOTH sides
    var sold = asNum(c.sold);
    soldBySku[c.sku] = (soldBySku[c.sku] || 0) + sold;
    var p = prices.map[c.sku];
    // A simple sku has no size and contributes no balls; so does a count row
    // whose sku has left the Prices tab.
    balls += sold * (p ? asNum(p.size) : 0);
    if (sold === 0) return;
    if (!p || !usableCost(p.box_cost)) {
      unpricedBox[c.sku] = (unpricedBox[c.sku] || 0) + sold;
      return;
    }
    boxesCost += sold * asNum(p.box_cost);
  });

  // --- Consumption: what was OPENED, at the cost of the unit it is counted in.
  var stockCost = 0;
  var unpricedStock = Object.create(null);
  var unpricedStockOrder = [];
  usage.forEach(function (u) {
    var qty = asNum(u.qty);
    if (qty === 0) return;
    var it = itemByName[lower(u.product)];
    if (!it || !usableCost(it.unit_cost)) {
      // No cost on file (or a name the stock list does not know at all): the
      // quantity is REPORTED and left out, never costed at nothing.
      var name = it ? it.product : asStr(u.product);
      if (unpricedStock[name] === undefined) { unpricedStock[name] = 0; unpricedStockOrder.push(name); }
      unpricedStock[name] += qty;
      return;
    }
    stockCost += qty * asNum(it.unit_cost);
  });

  // --- Money out: Supplies + Octopus, less every purchase this ledger ALREADY
  // prices per unit. Getting this wrong is the worst thing the screen can do,
  // and the first version DID get it wrong: it matched an expense's item name
  // against StockItems products, but the expense form's buckets are money
  // buckets — "Flour", "Box" — and no bucket name equals a product name
  // ("Takoyaki Flour"). The guard could therefore never fire on anything the
  // app itself writes: a sack of flour was counted twice (money paid AND flour
  // opened) and every box twice (the Box bucket AND boxes sold x box_cost),
  // reading ~30-60% too dear on a fortnight logged the way the phone logs it.
  //
  // So the mapping is DECLARED, not guessed: Settings `costed_buckets` lists
  // the bucket names whose money is already counted per unit. A guess would be
  // worse than a declaration here, because guessing wrong in the other
  // direction removes real money from the cost and makes a price look safe to
  // cut. Three ways a row can be recognised, all of them explicit:
  //   1. its item is one of `costed_buckets` (the phone's own buckets), or
  //   2. its item IS a tracked product name (a hand-typed "Takoyaki Flour"), or
  //   3. it carries a legacy stock_product (a pre-2.6.0 delivery row).
  var costedBuckets = Object.create(null);
  asStr(settings.costed_buckets).split(',').forEach(function (b) {
    var k = lower(asStr(b).trim());
    if (k) costedBuckets[k] = true;
  });
  // The set-aside is split by WHICH PROMISE it rests on (v2.9.2). Money held
  // back for containers is honoured by `boxesCost` the moment a box sells, so
  // that promise keeps itself. Money held back for STOCK is only honoured when
  // something is logged as opened — and the owner buys when things run out and
  // does not always log an opening, so that promise can quietly go unkept and
  // take his flour money out of the cost with it.
  var moneyCost = 0, asideStock = 0, asideBoxes = 0;
  expenses.forEach(function (x) {
    if (x.category !== 'Supplies' && x.category !== 'Octopus') return;
    var item = lower(x.item);
    var isStockRestock = !!itemByName[item] || asStr(x.stock_product) !== '';
    if (isStockRestock || costedBuckets[item]) {
      // A bucket that names a tracked product (or a legacy delivery row) is a
      // stock promise; any other costed bucket is a container promise.
      if (isStockRestock || !boxBucket_(item, prices)) asideStock += x.amount;
      else asideBoxes += x.amount;
      return;
    }
    moneyCost += x.amount;
  });
  var countedPerUnit = asideStock + asideBoxes;

  stockCost = round2(stockCost);
  moneyCost = round2(moneyCost);
  boxesCost = round2(boxesCost);
  balls = round2(balls);

  var variableTotal = round2(stockCost + moneyCost + boxesCost);
  // mama_per_cutoff / electric_per_cutoff are per PERIOD by definition, so they
  // are taken whole and then spread; a missing Settings row reads 0 rather than
  // inventing a share the owner never entered.
  // ONE LUMP PER CUTOFF PERIOD THE WINDOW TOUCHES (v2.9.4). Taking it once
  // regardless of the window's length understated a multi-period window's
  // fixed cost — and understating cost is the dangerous direction, the one
  // that makes a price look safe to cut. The phone only ever asks for a single
  // period, so this was never wrong on screen; the API accepts any range.
  var periods = periodsTouched_(start, end);
  var perCutoff = round2(asNum(settings.mama_per_cutoff) + asNum(settings.electric_per_cutoff));
  var shares = round2(perCutoff * Math.max(1, periods.count));
  var fixedTotal = round2(salary + shares);

  // The per-ball figures. `perBall` carries the containers; `ingredientPerBall`
  // deliberately does NOT, because per_sku prices each sku's own container
  // separately and adding both would charge every box for its box twice.
  // Neither is rounded before it is multiplied — only what is returned is.
  var perBall = balls > 0 ? round2(variableTotal / balls) : null;
  var ingredientPerBall = balls > 0 ? (stockCost + moneyCost) / balls : null;

  // --- Per sku: the pricing table, so this is the CURRENT price and the
  // CURRENT flag (the question is what to charge tomorrow). `sold` beside it is
  // the period's fact, classified by the snapshot like everything above — the
  // two answer different questions on purpose.
  var perSku = [];
  prices.list.forEach(function (p) {
    if (!p.in_cutoff) return;                       // out of both sides, so out of here
    var sold = round2(soldBySku[p.sku] || 0);
    if (!p.active && sold === 0) return;            // a retired sku nobody sold
    var size = asNum(p.size);
    var costPerBox = null, marginPerBox = null, marginPerBall = null;
    if (ingredientPerBall !== null && p.box_cost !== '') {
      costPerBox = round2(asNum(p.box_cost) + size * ingredientPerBall);
      marginPerBox = round2(p.price - costPerBox);
      // A simple sku has no balls to divide by, so it gets no per-ball margin.
      if (size > 0) marginPerBall = round2(marginPerBox / size);
    }
    perSku.push({
      sku: p.sku, label: p.label, sold: sold, price: round2(p.price),
      cost_per_box: costPerBox, margin_per_box: marginPerBox,
      margin_per_ball: marginPerBall
    });
  });

  // --- Break-even, for the PERIOD (divide by days_open for a nightly figure).
  // How many balls this fortnight had to sell for the margin on each to cover
  // the fixed costs. Null when there are no balls to average, and null when the
  // average ball loses money — there is no break-even then, and a number would
  // pretend there is.
  var breakEven = null;
  if (balls > 0) {
    var contribution = (revenue / balls) - (variableTotal / balls);
    if (contribution > 0) breakEven = round2(fixedTotal / contribution);
  }

  var perDay = { revenue: null, cost: null, left: null };
  if (daysOpen > 0) {
    var revPerDay = revenue / daysOpen;
    var costPerDay = (variableTotal + fixedTotal) / daysOpen;
    perDay = {
      revenue: round2(revPerDay),
      cost: round2(costPerDay),
      left: round2(revPerDay - costPerDay)
    };
  }

  // --- Targets: ADVICE. Holding the sales mix exactly as it was, every price
  // moves by one factor — the ratio between the revenue a night would need and
  // the revenue a night actually made. With no open days, or no revenue to
  // scale, there is no factor and the list is empty rather than full of
  // invented prices.
  // --- TARGETS. What every menu price would have to be for a night to LEAVE
  // the figure he asks for, selling the same mix. Two things the first version
  // got wrong, both of which made the advice under-deliver (the gate measured
  // P542 a night short on a cheese-heavy fortnight):
  //   - the factor was calibrated on TOTAL revenue but applied only to each
  //     sku's plain `price`, so cheese money never scaled with it;
  //   - the typed custom-order amount was inside that revenue too, and a menu
  //     price cannot move it at all.
  // So the base is the SCALABLE money only (revenue less custom orders), and
  // the factor is applied to BOTH the plain price and the cheese price of every
  // sku, which together are exactly that scalable money.
  var targets = [];
  var scalablePerDay = daysOpen > 0 ? (revenue - customMoney) / daysOpen : 0;
  var customPerDay = daysOpen > 0 ? customMoney / daysOpen : 0;
  if (daysOpen > 0 && scalablePerDay > 0) {
    var costsPerDay = (variableTotal + fixedTotal) / daysOpen;
    wants.forEach(function (w) {
      // needed scalable takings = costs + what he wants left - what the custom
      // orders already bring in (which no price change can alter).
      var needScalable = costsPerDay + w - customPerDay;
      if (needScalable <= 0) return;      // already there without touching a price
      var factor = needScalable / scalablePerDay;
      var rows = [];
      prices.list.forEach(function (p) {
        if (!p.in_cutoff || !p.active) return;
        rows.push({
          sku: p.sku,
          price: round2(p.price * factor),
          // Cheese moves with it: it is part of the same scalable takings, and
          // an unchanged cheese price is why the old advice fell short.
          cheese_price: p.cheese_price === '' || asNum(p.cheese_price) === 0
            ? asNum(p.cheese_price) : round2(asNum(p.cheese_price) * factor)
        });
      });
      targets.push({ per_day: round2(w), prices: rows, custom_orders_held: customPerDay > 0 });
    });
  }

  // --- What was left out, and why. Stock products in StockItems order first
  // (then any name the list does not know), then containers in Prices order
  // (then any sku the Prices tab no longer has), so the block reads the same
  // every time.
  var unpriced = [];
  var emittedStock = Object.create(null);
  items.list.forEach(function (it) {
    if (unpricedStock[it.product] === undefined) return;
    emittedStock[it.product] = true;
    unpriced.push({ kind: 'stock', name: it.product, label: it.product, qty: round2(unpricedStock[it.product]) });
  });
  unpricedStockOrder.forEach(function (name) {
    if (emittedStock[name]) return;
    emittedStock[name] = true;
    unpriced.push({ kind: 'stock', name: name, label: name, qty: round2(unpricedStock[name]) });
  });
  var emittedBox = Object.create(null);
  prices.list.forEach(function (p) {
    if (unpricedBox[p.sku] === undefined) return;
    emittedBox[p.sku] = true;
    unpriced.push({ kind: 'box', name: p.sku, label: p.label, qty: round2(unpricedBox[p.sku]) });
  });
  for (var sku in unpricedBox) {
    if (emittedBox[sku]) continue;
    emittedBox[sku] = true;
    unpriced.push({ kind: 'box', name: sku, label: sku, qty: round2(unpricedBox[sku]) });
  }

  // RESPONSE: snake_case throughout. start/end echo the window the figures were
  // computed over, because the screen has to STATE its window — the same reason
  // apiCutoff's figures carry them.
  // --- CAVEATS: what this period cannot honestly tell him (v2.8.0). The
  // figures above are only ever as complete as the logging, and an
  // UNDER-stated cost is the dangerous direction: it makes a price look
  // safe to cut. His real Aug 16-31 proved it — with no purchases logged
  // yet, cost per ball read 1.57 instead of ~5.80 and the targets advised
  // dropping Box 10 from 105 to 83. So the caveats are stated plainly AND
  // the targets are WITHHELD while any of them holds: advice computed from
  // data we know is incomplete is worse than no advice.
  // Two KINDS of caveat, and only one of them may switch the advice off. A
  // caveat that makes the cost a FLOOR biases every target price DOWNWARD —
  // "safe to cut" — and that is the one mistake this screen exists to prevent,
  // so the targets are withheld while it holds. A caveat that merely thins the
  // period (days not entered) spreads the per-cutoff shares across fewer
  // nights, which biases the advice UPWARD; that is conservative, still useful,
  // and stays on screen WITH its warning rather than being suppressed.
  var caveats = [];
  var costIsFloor = false;
  // A PROMISE THAT WAS NOT KEPT (v2.9.2). This money was withheld from the cost
  // because the ledger says it is counted as stock is opened — but nothing was
  // logged as opened in this period, so it is counted NOWHERE. It is the
  // dangerous direction (cost too low makes a price look safe to cut) and the
  // old floor gate could not see it: one octopus purchase makes moneyCost
  // positive and stands the whole floor warning down while the flour money sits
  // withheld against a stockCost of zero. Said as the app's own limitation —
  // he buys when things run out and logging an opening is not a duty he took on.
  if (asideStock > 0 && stockCost === 0) {
    costIsFloor = true;
    caveats.push(fmtAmt(round2(asideStock)) + ' of what you paid for stock in this period is in NO figure here. ' +
      'It is left out because this screen prices stock as it is OPENED, and nothing was logged as opened in ' +
      'these nights — so the cost per ball below is a floor, not the real cost.');
  }
  if (!(moneyCost > 0)) {
    costIsFloor = true;
    caveats.push('No purchases are logged in this period, so the cost per ball counts only what came out of stock. ' +
      'It is a floor, not the real cost — log the octopus, eggs, veggies and gas for these days first.');
  }
  if (unpriced.length > 0) {
    costIsFloor = true;
    caveats.push(unpriced.map(function (u) { return asStr(u.label || u.name); }).join(', ') +
      (unpriced.length === 1 ? ' has' : ' have') + ' no cost set, so what was used of ' +
      (unpriced.length === 1 ? 'it' : 'them') + ' is left out of every figure here. Set it under Maintenance.');
  }
  // Days with nothing entered, counted only up to YESTERDAY: tonight has not
  // been logged yet at nine in the morning, and calling that a gap would cry
  // wolf every single day.
  var yday = addDaysStr(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), -1);
  var lastDay = end < yday ? end : yday;
  var blankDays = 0;
  for (var walk = start; walk <= lastDay; walk = addDaysStr(walk, 1)) {
    if (!dayByDate[walk]) blankDays++;
  }
  if (blankDays > 0) {
    caveats.push(blankDays + (blankDays === 1 ? ' day in this period has' : ' days in this period have') +
      ' nothing entered, so every per-night figure is worked out from the ' + daysOpen +
      (daysOpen === 1 ? ' night' : ' nights') + ' that are — and the per-cutoff shares are spread across those alone. ' +
      'That makes the cost per night read HIGH, so the prices below are the cautious end.');
  }
  // THE CUTOFF IS NOT OVER YET (v2.9.4). This is the DEFAULT view: the phone
  // opens the costing on the period he is living in. The per-cutoff lumps are
  // charged whole — that money is owed for the period however far into it we
  // are — so spread across the nights so far they make the cost per night read
  // HIGH, and there was no line on screen saying so. Same direction as the
  // thin-period caveat above (upward, cautious), so the advice stays with its
  // warning rather than being withheld.
  var lastP = periods.last;
  if (lastP && perCutoff > 0 && lastP.end > yday) {
    var fullNights = 0;
    for (var fw = lastP.start; fw <= lastP.end; fw = addDaysStr(fw, 1)) fullNights++;
    var soFar = 0;
    var stopAt = yday < lastP.end ? yday : lastP.end;
    for (var sw = lastP.start; sw <= stopAt; sw = addDaysStr(sw, 1)) soFar++;
    // The peso figure is named through the THINGS it pays for, not with a bare
    // number: in a sentence that already counts nights, "1,000" on its own
    // could be read as one more count. (House style is fmtAmt without a sign.)
    caveats.push('This cutoff is not finished — ' + soFar + ' of its ' + fullNights +
      (fullNights === 1 ? ' night' : ' nights') + ' have gone by. ' +
      "Mama's share and the electric come to " + fmtAmt(perCutoff) +
      ' for the WHOLE cutoff however far into it you are, so charged against ' +
      soFar + (soFar === 1 ? ' night' : ' nights') + ' they make the cost per night read HIGH. ' +
      'It settles as the cutoff fills — the last finished cutoff is the one to price from.');
  }

  if (costIsFloor) targets = [];

  return {
    start: start, end: end,
    days_open: daysOpen,
    balls: balls,
    revenue: revenue,
    caveats: caveats,
    variable: {
      stock: stockCost, money: moneyCost, boxes: boxesCost, per_ball: perBall,
      // What was paid for things this ledger prices per unit instead — shown
      // so the subtraction is visible rather than a figure that quietly
      // disagrees with his Expenses screen.
      counted_per_unit: round2(countedPerUnit),
      // Split by the promise each part rests on, so the screen can say which
      // one was actually kept (v2.9.2).
      counted_as_stock: round2(asideStock),
      counted_as_boxes: round2(asideBoxes)
    },
    fixed: {
      salary: salary, shares: shares, periods: periods.count,
      // Purely a fact about dates: whether the last cutoff the window touches
      // has run out. Whether it is WORTH warning about also depends on there
      // being a share to spread, which is the caveat's business, not this key's.
      period_finished: !(periods.last && periods.last.end > yday),
      per_day: daysOpen > 0 ? round2(fixedTotal / daysOpen) : null
    },
    per_sku: perSku,
    break_even_balls: breakEven,
    per_day: perDay,
    targets: targets,
    unpriced: unpriced
  };
}

// ---------------------------------------------------------------------------
// Cutoff note text — format must match the owner's real notes EXACTLY
// (blank line placement, "- " with empty value for zero categories,
// thousands separators, no peso sign, no decimals for whole numbers).
// ---------------------------------------------------------------------------

function buildNoteText(branch, start, end, f) {
  // Zero categories keep the line with a blank value: "Octopus - "
  var orBlank = function (n) { return n === 0 ? '' : fmtAmt(n); };
  // f is the snake_case `figures` response object (per_partner, not perPartner).
  var splitVal = f.split === 0 ? '' : (fmtAmt(f.split) + '(' + fmtAmt(f.per_partner) + ' each)');
  // The final line is the residual and its LABEL carries the sign, so a note
  // never reads "Remaining - -2,000": "Remaining - 1,000" when >= 0,
  // "Short - 2,000" when negative. It ALWAYS prints a number.
  var residual = (f.remaining < 0)
    ? 'Short - ' + fmtAmt(-f.remaining)
    : 'Remaining - ' + fmtAmt(f.remaining);
  return [
    branch + ': ' + periodLabel(start, end) + ' Breakdown',
    '',
    'Total - ' + fmtAmt(f.total),
    '',
    'Cash - ' + fmtAmt(f.cash),
    'GCash - ' + fmtAmt(f.gcash),
    '',
    'Mama - ' + orBlank(f.mama),
    'Split - ' + splitVal,
    'Supplies (minor) - ' + orBlank(minorVal(f)),
    // Beside the Supplies line it belongs with, at the owner's direction
    // (2026-09-01): "I just want to see it in the supplies section in the cutoff
    // notes, ill handle the deduction for now." It is the value of what was
    // OPENED — his suppliers deliver on credit, so that is what he owes at the
    // cutoff — where the line above is what he has actually PAID.
    // IT IS STILL IN NO SUM. `remaining` is computed from the seven allocations
    // only, and the tests assert the identity with this line present.
    'Supplies used (opened) - ' + usedVal(f),
    // Octopus and "Other payments" are GONE from the note (v2.20.0): both are now
    // inside Supplies (minor) above, and printing them as well would show the
    // same money twice and stop the block from adding up.
    'Salary - ' + orBlank(f.salary),
    'Electric bill - ' + orBlank(f.electric),
    '',
    residual
  ].join('\n');
}

/** The value of what was OPENED, for the line beside Supplies (v2.15.1).
 *
 *  Blank when there is nothing to say — the same rule every other category line
 *  follows, so a fortnight with no usage logged (or no costs on file) reads
 *  "Supplies used (opened) - " exactly as an empty Octopus reads "Octopus - ".
 *  A product with no cost is NOT priced at nothing: it is left out of the money
 *  and counted, so the figure is never quietly understated. */
/** The minor figure, from either side's casing — and falling back to the three
 *  parts when an older reply (or an archived row) carries no merged figure. */
function minorVal(f) {
  var o = f || {};
  var direct = o.suppliesMinor !== undefined ? o.suppliesMinor : o.supplies_minor;
  if (direct !== undefined && direct !== null && direct !== '') return asNum(direct);
  return round2(asNum(o.supplies) + asNum(o.octopus) + asNum(o.other));
}

function usedVal(f) {
  var used = asNum(f.supplies_used);
  var unpriced = asNum(f.supplies_used_unpriced);
  if (!(used > 0) && !(unpriced > 0)) return '';
  return (used > 0 ? fmtAmt(used) : '0') +
    (unpriced > 0 ? ' + ' + unpriced + ' with no cost set' : '');
}

/** "July 1 - 15" (same month) or "July 30 - August 2" (spanning months). */
/** The 1-15 / 16-end cutoff periods a window TOUCHES, in order (v2.9.4).
 *  `mama_per_cutoff` and `electric_per_cutoff` are lumps per PERIOD, so a
 *  window that spans three of them owes three, and one that stops halfway
 *  through the third still owes that third's lump — the money is due for the
 *  period, not by the night. Callers use `count` for the arithmetic and `last`
 *  to say whether the final period has actually finished. */
function periodsTouched_(start, end) {
  var out = [];
  var cur = periodStartOf_(start);
  var guard = 0;
  while (cur.start <= end && guard++ < 400) {
    out.push(cur);
    cur = periodStartOf_(addDaysStr(cur.end, 1));
  }
  return { count: out.length, list: out, last: out.length ? out[out.length - 1] : null };
}

/** The cutoff period a date falls in: {start, end}. */
function periodStartOf_(ds) {
  var p = parseYmd(ds);
  if (p.d <= 15) {
    return { start: ymdOf_(p.y, p.m, 1), end: ymdOf_(p.y, p.m, 15) };
  }
  return { start: ymdOf_(p.y, p.m, 16), end: ymdOf_(p.y, p.m, daysInMonth_(p.y, p.m)) };
}

function ymdOf_(y, m, d) {
  return String(y) + '-' + (m < 10 ? '0' + m : String(m)) + '-' + (d < 10 ? '0' + d : String(d));
}

function daysInMonth_(y, m) {
  return [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function periodLabel(start, end) {
  var s = parseYmd(start);
  var e = parseYmd(end);
  if (s.y === e.y && s.m === e.m) {
    return MONTHS[s.m - 1] + ' ' + s.d + ' - ' + e.d;
  }
  return MONTHS[s.m - 1] + ' ' + s.d + ' - ' + MONTHS[e.m - 1] + ' ' + e.d;
}

/** Parse "yyyy-MM-dd" by hand — never via new Date(str), which is UTC-based
 *  and can shift the day in Asia/Manila. */
function parseYmd(s) {
  var p = String(s).split('-');
  return { y: Number(p[0]), m: Number(p[1]), d: Number(p[2]) };
}

/** 11857 -> "11,857"; 2000.5 -> "2,000.50"; whole numbers get no decimals. */
function fmtAmt(n) {
  n = round2(n);
  var neg = n < 0;
  var abs = Math.abs(n);
  var whole = Math.floor(abs);
  var cents = Math.round((abs - whole) * 100);
  if (cents === 100) { whole += 1; cents = 0; } // guard fp edge, e.g. 4.999999
  var s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (cents > 0) s += '.' + (cents < 10 ? '0' : '') + cents;
  return (neg ? '-' : '') + s;
}

// ---------------------------------------------------------------------------
// Tab access — exactly ONE getDataRange().getValues() per tab per request.
//
// Columns are addressed BY HEADER NAME (row 1), never by a hard-coded index.
// That is what makes the append-only migration safe: a 9-column DailyCounts
// written before v2.1.0 and a 12-column one written after both read correctly,
// and an owner who drags a column sideways does not silently corrupt money.
// ---------------------------------------------------------------------------

/** name -> 0-based column index, from row 1. First occurrence wins so a
 *  duplicated header cannot shadow the real column.
 *  Matching is CASE-INSENSITIVE and TRIMMED (v2.5.0): a hand-retyped "Date" or
 *  " sku " is the same column as "date" — refusing to see it made the owner's
 *  own repairs invisible, and migration then appended a duplicate column. Every
 *  lookup key in this file is already lowercase, so normalizing here covers all
 *  of them. */
function headerMap(headerRow) {
  var m = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = asStr(headerRow[i]).toLowerCase();
    if (h !== '' && m[h] === undefined) m[h] = i;
  }
  return m;
}

/** Returns null when the tab does not exist (used by readers for tabs a
 *  pre-migration sheet may not have yet — they degrade to "no rows"). */
function readTabOptional(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) return null;
  var values = sheet.getDataRange().getValues();
  var head = values[0] || [];
  return { sheet: sheet, name: name, values: values, col: headerMap(head), width: head.length };
}

function readTab(ss, name) {
  var t = readTabOptional(ss, name);
  if (!t) {
    throw new Error('Missing sheet "' + name + '". Run setupSheet() from the Apps Script editor.');
  }
  return t;
}

/** Read a tab that is about to be WRITTEN. Guarantees the tab exists and that
 *  every schema column is present, running the append-only migration for that
 *  one tab if it is not. New code is auto-deployed on push while setupSheet()
 *  is run by hand, so the sheet can legitimately lag the code by a few
 *  minutes — a save must never fail (or silently drop a column) because of it.
 *  Costs one extra read ONLY when a migration was actually needed. */
function readTabForWrite(ss, name) {
  var def = schemaFor(name);
  var t = readTabOptional(ss, name);
  if (t) {
    var complete = true;
    for (var i = 0; i < def.headers.length; i++) {
      if (t.col[def.headers[i]] === undefined) { complete = false; break; }
    }
    if (complete) return t;
  }
  var r = migrateTab(ss, def);
  // Seed rows belong to tab CREATION only (v2.5.0): a migration that merely
  // appended a column to a live tab must not re-plant rows the owner deleted.
  if (r.created && AUTO_SEED[name]) AUTO_SEED[name](ss);
  return readTab(ss, name);
}

/** Width to write: the sheet's own width, never narrower than the schema. */
function writeWidth(t, name) {
  return Math.max(t.width, schemaFor(name).headers.length);
}

/** 0-based index of a column that MUST exist. */
function colOf(t, name) {
  var i = t.col[name];
  if (i === undefined) {
    throw new Error('Tab "' + t.name + '" has no "' + name +
      '" column. Run setupSheet() from the Apps Script editor to update the sheet.');
  }
  return i;
}

/** Lenient cell read: a column the sheet does not have yet reads as blank. */
function cellOf(row, t, name) {
  var i = t.col[name];
  return (i === undefined || i >= row.length) ? '' : row[i];
}

/** Build a row array of `width` cells, placing each value of `obj` under its
 *  own header. `base` (an existing row) is copied first so columns nobody
 *  knows about — e.g. one the owner added by hand — survive an upsert. */
function buildRow(t, width, obj, base) {
  var row = [];
  for (var i = 0; i < width; i++) row.push(base ? base[i] : '');
  for (var k in obj) {
    var idx = t.col[k];
    if (idx === undefined) {
      throw new Error('Tab "' + t.name + '" has no "' + k +
        '" column. Run setupSheet() from the Apps Script editor to update the sheet.');
    }
    row[idx] = obj[k];
  }
  return row;
}

/** Grow the grid so `need` rows exist. getRange/setValues never expand it and
 *  throw once the table outgrows the initial grid. Returns the inserted range
 *  ({from, count}) or null. */
function ensureRows(sheet, need) {
  var maxRows = sheet.getMaxRows();
  if (need <= maxRows) return null;
  sheet.insertRowsAfter(maxRows, need - maxRows);
  return { from: maxRows + 1, count: need - maxRows };
}

/**
 * Replace every row of ONE date in a date-keyed tab, keeping all other dates.
 *
 * Write order is deliberate (history must survive a mid-write failure):
 *   (1) grow the grid if the block would not fit,
 *   (2) overwrite rows 2..N with the full new block,
 *   (3) clear only the surplus rows BELOW the written block.
 * A crash between (2) and (3) leaves stale duplicate rows at the bottom
 * (recoverable), whereas clear-then-write could wipe the whole history.
 */
function rewriteDateBlock(ss, name, date, newRows) {
  var t = readTabForWrite(ss, name);
  var width = writeWidth(t, name);
  var dateIdx = colOf(t, 'date');

  var kept = [];
  for (var r = 1; r < t.values.length; r++) {
    if (asDateStr(t.values[r][dateIdx]) !== date) kept.push(padRow(t.values[r], width));
  }
  newRows.forEach(function (o) { kept.push(buildRow(t, width, o, null)); });

  if (kept.length > 0) {
    var grown = ensureRows(t.sheet, kept.length + 1); // +1 for the header row
    if (grown) {
      // Keep date/timestamp columns plain text on the new rows (belt-and-braces
      // to setupSheet's whole-column "@" format) so the yyyy-MM-dd strings
      // written below are never coerced into Date cells.
      (schemaFor(name).textCols || []).forEach(function (h) {
        var i = t.col[h];
        if (i !== undefined) t.sheet.getRange(grown.from, i + 1, grown.count, 1).setNumberFormat('@');
      });
    }
    t.sheet.getRange(2, 1, kept.length, width).setValues(kept);
  }
  var oldDataRows = t.values.length - 1;
  if (oldDataRows > kept.length) {
    t.sheet.getRange(2 + kept.length, 1, oldDataRows - kept.length, width).clearContent();
  }
}

// ---------------------------------------------------------------------------
// Tab readers.
//
// Everything these return is shipped verbatim in a RESPONSE (bootstrap/range),
// so every key here is snake_case and matches the sheet's column header.
// Renaming one to camelCase breaks the PWA silently (undefined -> 0).
// ---------------------------------------------------------------------------

function readSettings(ss) {
  var t = readTab(ss, TAB.SETTINGS);
  var out = {};
  for (var i = 1; i < t.values.length; i++) {
    var key = asStr(cellOf(t.values[i], t, 'key'));
    if (key) out[key] = cellOf(t.values[i], t, 'value');
  }
  return out;
}

function readPrices(ss) {
  var t = readTab(ss, TAB.PRICES);
  var list = [];
  // Prototype-free lookup: a sku (or product, below) called "toString" must not
  // resolve to Object.prototype.toString and then price a box at NaN.
  var map = Object.create(null);
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var sku = asStr(cellOf(r, t, 'sku'));
    if (!sku) continue; // tolerate blank filler rows
    // Duplicate sku rows (a hand-copied row, a paste gone long): the FIRST row
    // wins, deterministically — the same row an upsert rewrites — and the
    // duplicate is simply not listed, so one stray row can never double a sku
    // on the Sales screen or flip which price a save uses (v2.5.0).
    if (map[sku]) continue;
    // box_cost is read RAW for the same reason reorder_at is (see
    // readStockItems): asNum('') is 0, 0 is a legitimate container cost, and a
    // coerced blank would come straight back on the next savePrices and fill
    // the owner's untouched cells with literal 0s — turning "no cost known"
    // into "costs nothing" and quietly understating every ball he sells.
    var rawBoxCost = cellOf(r, t, 'box_cost');
    var p = {
      sku: sku,
      label: asStr(cellOf(r, t, 'label')) || sku,
      group: asStr(cellOf(r, t, 'group')) || 'simple',
      size: asNum(cellOf(r, t, 'size')),
      price: asNum(cellOf(r, t, 'price')),
      cheese_price: asNum(cellOf(r, t, 'cheese_price')),
      active: asBool(cellOf(r, t, 'active')),
      // What one container costs (v2.8.0). Blank = no cost known, shipped blank.
      box_cost: costCell(rawBoxCost),
      // in_cutoff=FALSE means "sell it, count it, but keep its money out of
      // every cutoff figure". asCutoffFlag, NOT asBool: a blank cell (every
      // pre-v2.4.0 row) and a missing column both have to read TRUE.
      in_cutoff: asCutoffFlag(cellOf(r, t, 'in_cutoff'))
    };
    list.push(p);
    map[sku] = p;
  }
  return { list: list, map: map };
}

/**
 * One row per date. `dailySalary` is the CURRENT Settings rate and is used only
 * to resolve a BLANK salary cell (a row saved before v2.3.0 stored one).
 *
 * The `salary` shipped here is the EFFECTIVE figure — 0 on a closed day, the
 * day's own snapshot when it has one, else the current rate — because it is the
 * exact number the cutoff adds up. Shipping the raw blank instead would leave
 * the phone to guess, and a phone that guessed 0 would preview a salary line
 * ₱200 per legacy day short of the note it is previewing.
 */
function readDays(ss, dailySalary) {
  var t = readTab(ss, TAB.DAILY_LOG);
  var rate = asNum(dailySalary);
  var out = [];
  var seenDates = Object.create(null);
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    // Duplicate date rows (hand edits — an upsert can't create them): the FIRST
    // row wins, deterministically, because that is the row apiSaveDay's upsert
    // finds and rewrites. Counting both would double the day in every cutoff;
    // disagreeing with the upsert would make an edited day look unsaved (v2.5.0).
    if (seenDates[date]) continue;
    seenDates[date] = true;
    var closed = asBool(cellOf(r, t, 'closed'));
    var rawSalary = asStr(cellOf(r, t, 'salary'));
    out.push({
      date: date,
      closed: closed,
      // Nobody worked on a closed day; a blank on an open day predates the
      // column and counts at today's rate; an explicit 0 (half day off) stands.
      salary: closed ? 0 : (rawSalary === '' ? rate : asNum(rawSalary)),
      staff: asStr(cellOf(r, t, 'staff')),
      gcash: asNum(cellOf(r, t, 'gcash')),
      total: asNum(cellOf(r, t, 'total')),
      cash: asNum(cellOf(r, t, 'cash')),
      custom_amount: asNum(cellOf(r, t, 'custom_amount')),
      // Pre-v2.1.0 rows have no custom_gcash column at all -> 0.
      custom_gcash: asNum(cellOf(r, t, 'custom_gcash')),
      // That day's money from in_cutoff=FALSE skus (v2.4.0). It sits BESIDE the
      // day's money and is never inside `total`, `cash` or `gcash`; the receipt
      // shows it below them so the cash tin (Cash + excluded_total) reconciles.
      // Pre-v2.4.0 rows have no column at all -> 0, which is exactly right:
      // there was no excluded sku to sell.
      excluded_total: asNum(cellOf(r, t, 'excluded_total')),
      // Tin cash swapped for a GCash transfer that day (v2.7.0). Already inside
      // `gcash` and out of `cash` — the split, not the total. Pre-v2.7.0 rows
      // have no column at all -> 0: nothing was converted on those days.
      gcash_converted: asNum(cellOf(r, t, 'gcash_converted')),
      // Lid boxes used (v2.7.0): a plain count, no money anywhere. Blank -> 0.
      lid_boxes: asNum(cellOf(r, t, 'lid_boxes')),
      // The photograph this night was read from (v2.9.0). Blank -> '', which is
      // the normal state; it is provenance, never a figure.
      photo_url: asStr(cellOf(r, t, 'photo_url')),
      notes: asStr(cellOf(r, t, 'notes')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
}

/**
 * One row per sku per date, with the money that was computed when the day was
 * saved. `priceMap` (from readPrices) is used for ONE thing: resolving a BLANK
 * `price`/`cheese_price` snapshot on a row written before v2.5.0 appended those
 * columns — the current price is the only available answer for such a row, and
 * it is the fallback apiSaveDay itself uses when it re-saves that date.
 */
function readCounts(ss, priceMap) {
  var t = readTab(ss, TAB.DAILY_COUNTS);
  var out = [];
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    var sku = asStr(cellOf(r, t, 'sku'));
    var p = priceMap ? priceMap[sku] : null;
    var rawPrice = cellOf(r, t, 'price');
    var rawCheese = cellOf(r, t, 'cheese_price');
    out.push({
      date: date,
      sku: sku,
      sod: asNum(cellOf(r, t, 'sod')),
      eod: asNum(cellOf(r, t, 'eod')),
      sold: asNum(cellOf(r, t, 'sold')),
      cheese_qty: asNum(cellOf(r, t, 'cheese_qty')),
      regular_qty: asNum(cellOf(r, t, 'regular_qty')),
      amount: asNum(cellOf(r, t, 'amount')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      // Pre-v2.1.0 rows have no GCash columns -> 0, i.e. "all cash", which is
      // exactly what those days were.
      gcash_qty: asNum(cellOf(r, t, 'gcash_qty')),
      gcash_cheese_qty: asNum(cellOf(r, t, 'gcash_cheese_qty')),
      gcash_amount: asNum(cellOf(r, t, 'gcash_amount')),
      // Whether THIS row's money counted, as decided when the day was saved
      // (v2.4.1). Resolved, so a legacy blank never reaches a caller as an
      // undecided cell — and a blank reads TRUE (see countCutoffFlag).
      in_cutoff: countCutoffFlag(cellOf(r, t, 'in_cutoff')),
      // The per-unit prices this row's money was computed FROM (v2.5.0),
      // resolved the same way apiSaveDay resolves them on a re-save: the stored
      // snapshot, else the sku's current price. The phone shows a loaded day's
      // arithmetic with these, so editing an old night never re-prices it.
      price: asStr(rawPrice) === '' ? (p ? p.price : 0) : asNum(rawPrice),
      cheese_price: asStr(rawCheese) === '' ? (p ? p.cheese_price : 0) : asNum(rawCheese),
      // How many of `sold` a special order used (v2.7.0): this row's `amount`
      // prices sold − custom_qty units. A blank legacy cell reads 0 — no
      // special order ever drew from a row written before the column existed.
      custom_qty: asNum(cellOf(r, t, 'custom_qty')),
      // How many of `sold` were never paid for (v2.10.1): given away or ruined.
      // A blank legacy cell reads 0 — a row written before the column existed
      // claimed nothing was given away, which is exactly what it meant.
      free_qty: asNum(cellOf(r, t, 'free_qty'))
    });
  }
  return out;
}

/**
 * The `in_cutoff` SNAPSHOT on one DailyCounts row.
 *
 * An explicit cell is the answer, full stop: it is what the sku's flag said when
 * this day was saved, and that is a fact about the day, not about the Prices tab
 * as it stands today. Classifying saved money by the CURRENT flag is what let a
 * tick in Maintenance restate a cutoff that had already been sent — in both
 * directions (money vanishing from the excluded block, or money that is inside
 * `total` also appearing as "kept out").
 *
 * A BLANK cell means there IS no snapshot: the row was written before v2.4.1, or
 * the column has not been appended yet (cellOf reads a missing column as ''). A
 * blank reads TRUE (v2.5.0 — DELIBERATE change from the current-flag fallback):
 * every pre-snapshot row was saved by code that put ALL of a day's money inside
 * `total`/`cash`/`gcash`, so its money is in the totals as a matter of record.
 * The old fallback re-classified such rows by today's Prices flag, which showed
 * migrated history's money BOTH inside the totals AND under "kept out" the
 * moment a sku was excluded — the same money stated twice, in two contradictory
 * ways. TRUE is not a guess here; it is what actually happened at save time.
 */
function countCutoffFlag(raw) {
  if (asStr(raw) !== '') return asCutoffFlag(raw);
  return true; // no snapshot: the row predates exclusion, its money IS in the totals
}

/** The stock products the phone offers, plus their ledger settings.
 *  ADVISORY for the day's usage list — saveDay does not validate against it, so
 *  a renamed product can never cost the owner a whole day of sales. Deliveries
 *  and stocktakes DO check it, because those move an on-hand figure.
 *  Tolerant read: a sheet that has not been migrated yet has no tab and simply
 *  offers no list. */
function readStockItems(ss) {
  var t = readTabOptional(ss, TAB.STOCK_ITEMS);
  var list = [], map = Object.create(null);
  if (t) {
    for (var i = 1; i < t.values.length; i++) {
      var r = t.values[i];
      var product = asStr(cellOf(r, t, 'product'));
      if (!product || map[product]) continue;
      // reorder_at is the ONE figure here that is NOT coerced with asNum: a
      // blank cell must stay blank all the way to the phone. asNum('') is 0, and
      // 0 is a real threshold value, so a coerced blank made the Maintenance
      // screen's deliberate blank-preserving path dead code — it loaded 0 into
      // every empty box and the first "Save stock list" wrote literal 0s back
      // into six blank cells the owner had never touched. `low` still computes
      // off asNum(reorder_at), so a blank still means no warning at all.
      var rawReorder = cellOf(r, t, 'reorder_at');
      // unit_cost joins reorder_at as a RAW read, for the same reason and one
      // more: a blank here does not mean ₱0, it means the owner has not told
      // the app what this product costs, and apiCosting must be able to say so
      // out loud instead of costing his consumption at nothing.
      var rawUnitCost = cellOf(r, t, 'unit_cost');
      var o = {
        product: product,
        unit: asStr(cellOf(r, t, 'unit')),
        active: asBool(cellOf(r, t, 'active')),
        sort: asNum(cellOf(r, t, 'sort')),
        opening_qty: asNum(cellOf(r, t, 'opening_qty')),
        // NOT coerced to today. A blank opening_date means "count the WHOLE
        // history" — '' < any yyyy-MM-dd string, so every delivery and every
        // usage row counts. Defaulting it to today would silently drop every
        // delivery already logged.
        opening_date: asDateStr(cellOf(r, t, 'opening_date')),
        reorder_at: asStr(rawReorder) === '' ? '' : asNum(rawReorder),
        // What one unit costs to buy (v2.8.0). Blank = no cost known, shipped
        // blank so the phone can show an empty box and save it back empty.
        unit_cost: costCell(rawUnitCost)
      };
      list.push(o);
      map[product] = o;
    }
  }
  list.sort(function (a, b) { return a.sort - b.sort; }); // stable for equal keys
  return { list: list, map: map };
}

/** Physical stocktakes. The latest one per product becomes that product's
 *  baseline, so miscounts and spoilage are absorbed instead of accumulating. */
function readStockCounts(ss) {
  var t = readTabOptional(ss, TAB.STOCK_COUNTS);
  var out = [];
  if (!t) return out;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    out.push({
      date: date,
      product: asStr(cellOf(r, t, 'product')),
      counted_qty: asNum(cellOf(r, t, 'counted_qty')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
}

/** The Split entered for a cutoff period. Period-keyed, not date-keyed. */
function readCutoffInputs(ss) {
  var t = readTabOptional(ss, TAB.CUTOFF_INPUTS);
  var out = [];
  if (!t) return out;
  // Duplicate (start, end) rows — only a hand-edit can make them, the app
  // upserts — follow the v2.5.0 dedupe standard: the FIRST row wins,
  // deterministically, the same row an upsert rewrites. Without this the note
  // read the LAST duplicate while "Save split" rewrote the FIRST, so a saved
  // split appeared not to take until the stray row was deleted by hand.
  var seen = Object.create(null);
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var start = asDateStr(cellOf(r, t, 'start'));
    var end = asDateStr(cellOf(r, t, 'end'));
    if (!start || !end) continue;
    var key = start + '\u0001' + end; // same separator upsertRows uses
    if (seen[key]) continue;
    seen[key] = true;
    out.push({
      start: start,
      end: end,
      split_amount: asNum(cellOf(r, t, 'split_amount')),
      // What the tin actually held (v2.12.1). Kept RAW: a blank means nobody has
      // counted this cutoff yet, which is different from counting it and finding
      // nothing — and only the raw value can tell those apart.
      tin_counted: asStr(cellOf(r, t, 'tin_counted')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
}

/** Quantities consumed per product per day — WHOLE UNITS OPENED. NEVER money:
 *  this never reaches the note or any total; it drives on-hand and the reorder
 *  warning. */
function readStockUsage(ss) {
  var t = readTabOptional(ss, TAB.STOCK_USAGE);
  var out = [];
  if (!t) return out;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    out.push({
      date: date,
      product: asStr(cellOf(r, t, 'product')),
      qty: asNum(cellOf(r, t, 'qty')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
}

/** Goods that ARRIVED, per product per day — WHOLE UNITS, NEVER money (v2.6.0).
 *  The second half of `delivered` beside the legacy expense-attached
 *  quantities. Tolerant read like the other stock tabs: a sheet not migrated
 *  yet has no tab and simply answers "no rows". Dates go through asDateStr, so
 *  a hand-typed "2026/7/5" still counts. */
function readStockDeliveries(ss) {
  var t = readTabOptional(ss, TAB.STOCK_DELIVERIES);
  var out = [];
  if (!t) return out;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    out.push({
      date: date,
      product: asStr(cellOf(r, t, 'product')),
      qty: asNum(cellOf(r, t, 'qty')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
}

function readExpenses(ss) {
  var t = readTab(ss, TAB.EXPENSES);
  var out = [];
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    out.push({
      date: date,
      category: asStr(cellOf(r, t, 'category')),
      item: asStr(cellOf(r, t, 'item')),
      amount: asNum(cellOf(r, t, 'amount')),
      backlog_ref: asStr(cellOf(r, t, 'backlog_ref')),
      notes: asStr(cellOf(r, t, 'notes')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at')),
      // A delivery names what arrived and how much of it. Blank on most rows —
      // most expenses are not tracked stock. `amount` is the money and is
      // counted exactly once, as it always was; stock_qty feeds only the ledger.
      // Where the money came from (v2.12.0). A blank legacy cell stays blank —
      // it is genuinely unknown, and the tin figure says so out loud.
      paid_from: asStr(cellOf(r, t, 'paid_from')),
      stock_product: asStr(cellOf(r, t, 'stock_product')),
      stock_qty: asNum(cellOf(r, t, 'stock_qty'))
    });
  }
  return out;
}

/**
 * On hand is COMPUTED, never stored — the same principle as a backlog balance.
 *
 *   baseline   = latest StockCounts row for the product (by date, then
 *                updated_at), else { date: opening_date, qty: opening_qty }
 *   delivered  = Σ Expenses.stock_qty   (legacy expense-attached rows)
 *              + Σ StockDeliveries.qty  (v2.6.0 — the only door new arrivals
 *                use), both for the product, date > baseline.date
 *   used       = Σ StockUsage.qty       for the product, date > baseline.date
 *   on_hand    = baseline.qty + delivered − used
 *   low        = reorder_at > 0 && on_hand <= reorder_at
 *
 * BOTH delivery sources count, forever: the Expenses ride-along columns are
 * retired for NEW entries, but a quantity already in the sheet is history and
 * history is never restated — dropping it would empty shelves that are full.
 *
 * STRICTLY AFTER the baseline date: a stocktake is an end-of-day figure that
 * already reflects that day's deliveries and usage.
 *
 * A BLANK baseline date means the whole history counts ('' < any yyyy-MM-dd).
 * on_hand MAY BE NEGATIVE — the seeded baseline is 0, so usage logged against
 * stock delivered before tracking began legitimately reads below zero. It is
 * returned as-is: a negative figure is honest information that a count is
 * needed, and clamping it to 0 would hide exactly that.
 *
 * The row collections are passed in so one request reads each tab once.
 */
function computeStockStatus(ss, expensesAll, usageAll, countsAll, deliveriesAll) {
  return stockStatusFor(readStockItems(ss).list, ss, expensesAll, usageAll, countsAll, deliveriesAll);
}

/** The arithmetic itself, over an already-read item list (so one request never
 *  reads StockItems twice). See computeStockStatus for the rules.
 *
 *  `since` (optional, yyyy-MM-dd) additionally SPLITS the two sums at that
 *  date: `delivered_before`/`used_before` are the rows STRICTLY BEFORE it (and
 *  still strictly after the baseline — a baseline dated inside the window
 *  leaves them 0, because everything after it is inside the window). This is
 *  what bootstrap ships (v2.5.1): the phone adds its OWN in-window rows on top
 *  of these pre-window parts, so a local correction or deletion moves on-hand
 *  immediately. The old alternative — shipping only the whole-history totals
 *  and letting the phone top its local sums back up to them — could not tell
 *  "rows this phone cannot see" from "rows this phone just corrected", and
 *  silently undid every downward fix. */
function stockStatusFor(items, ss, expensesAll, usageAll, countsAll, deliveriesAll, since) {
  var expenses = expensesAll || readExpenses(ss);
  var usage = usageAll || readStockUsage(ss);
  var counts = countsAll || readStockCounts(ss);
  var arrivals = deliveriesAll || readStockDeliveries(ss);

  // Latest stocktake per product: by date, then updated_at as the tie-break for
  // two counts on the same day.
  var latest = Object.create(null);
  counts.forEach(function (c) {
    if (!c.product) return;
    var best = latest[c.product];
    if (!best || c.date > best.date ||
        (c.date === best.date && c.updated_at >= best.updated_at)) {
      latest[c.product] = c;
    }
  });

  var out = Object.create(null);
  items.forEach(function (it) {
    var base = latest[it.product]
      ? { date: latest[it.product].date, qty: latest[it.product].counted_qty }
      : { date: it.opening_date, qty: it.opening_qty };
    var delivered = 0, deliveredBefore = 0;
    // BOTH doors goods ever came in through: the legacy expense-attached rows
    // (kept counting forever) and the StockDeliveries tab (v2.6.0, the only
    // door new arrivals use). Split identically at `since`, so the phone's
    // delivered_before carries the pre-window part of BOTH.
    expenses.forEach(function (x) {
      if (x.stock_product !== it.product || !(x.date > base.date)) return;
      delivered += x.stock_qty;
      if (since && x.date < since) deliveredBefore += x.stock_qty;
    });
    arrivals.forEach(function (a) {
      if (a.product !== it.product || !(a.date > base.date)) return;
      delivered += a.qty;
      if (since && a.date < since) deliveredBefore += a.qty;
    });
    var used = 0, usedBefore = 0;
    usage.forEach(function (u) {
      if (u.product !== it.product || !(u.date > base.date)) return;
      used += u.qty;
      if (since && u.date < since) usedBefore += u.qty;
    });
    delivered = round2(delivered);
    used = round2(used);
    var onHand = round2(base.qty + delivered - used);
    // reorder_at reaches here RAW ('' for a blank cell, see readStockItems), so
    // the threshold is resolved with asNum right where it is compared: a blank
    // (and a 0) means there is no warning to give, however low the shelf gets.
    var threshold = asNum(it.reorder_at);
    out[it.product] = {
      baseline_qty: round2(base.qty),
      baseline_date: base.date,
      delivered_since: delivered,
      used_since: used,
      // The pre-window parts of the two figures above (0 without a `since`).
      delivered_before: round2(deliveredBefore),
      used_before: round2(usedBefore),
      on_hand: onHand,
      low: threshold > 0 && onHand <= threshold
    };
  });
  return out;
}

/** Stock items with their computed ledger figures attached — the shape
 *  bootstrap ships so the phone can show on-hand AND explain it without
 *  holding history it does not have. */
function stockItemsWithStatus(ss, expensesAll, usageAll, countsAll, deliveriesAll, since) {
  var items = readStockItems(ss).list;
  var status = stockStatusFor(items, ss, expensesAll, usageAll, countsAll, deliveriesAll, since);
  return items.map(function (it) {
    var s = status[it.product] || {
      baseline_qty: 0, baseline_date: '', delivered_since: 0, used_since: 0,
      delivered_before: 0, used_before: 0,
      on_hand: 0, low: false
    };
    return {
      product: it.product,
      unit: it.unit,
      active: it.active,
      sort: it.sort,
      opening_qty: it.opening_qty,
      opening_date: it.opening_date,
      reorder_at: it.reorder_at,
      // What one unit costs (v2.8.0), shipped RAW like reorder_at: the phone
      // shows it beside the reorder point under Maintenance and saves it back,
      // and a blank must survive the round trip as a blank.
      unit_cost: it.unit_cost,
      on_hand: s.on_hand,
      low: s.low,
      baseline_qty: s.baseline_qty,
      baseline_date: s.baseline_date,
      delivered_since: s.delivered_since,
      used_since: s.used_since,
      // The two totals SPLIT at window_start (v2.5.1): the phone's own
      // arithmetic is `before + its own in-window rows`, so a local correction
      // moves on-hand immediately instead of being topped back up.
      delivered_before: s.delivered_before,
      used_before: s.used_before
    };
  });
}

/** Backlog balance is always computed (never stored):
 *  balance = total_amount − Σ(Expenses where category=Backlog, ref=name). */
function readBacklogs(ss, expensesAll) {
  var t = readTab(ss, TAB.BACKLOGS);
  var paidByName = {};
  // expensesAll comes from readExpenses(), i.e. already snake_case.
  expensesAll.forEach(function (x) {
    if (x.category === 'Backlog' && x.backlog_ref) {
      paidByName[x.backlog_ref] = (paidByName[x.backlog_ref] || 0) + x.amount;
    }
  });
  var out = [];
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var name = asStr(cellOf(r, t, 'name'));
    if (!name) continue;
    var totalAmount = asNum(cellOf(r, t, 'total_amount'));
    var paid = round2(paidByName[name] || 0);
    out.push({
      name: name,
      description: asStr(cellOf(r, t, 'description')),
      total_amount: totalAmount,
      start_date: asDateStr(cellOf(r, t, 'start_date')),
      active: asBool(cellOf(r, t, 'active')),
      paid: paid,
      balance: round2(totalAmount - paid)
    });
  }
  return out;
}

function readLastCutoff(ss) {
  var t = readTab(ss, TAB.CUTOFFS);
  if (t.values.length < 2) return null;
  var r = t.values[t.values.length - 1];
  return {
    start: asDateStr(cellOf(r, t, 'start')),
    end: asDateStr(cellOf(r, t, 'end')),
    total: asNum(cellOf(r, t, 'total')),
    cash: asNum(cellOf(r, t, 'cash')),
    gcash: asNum(cellOf(r, t, 'gcash')),
    mama: asNum(cellOf(r, t, 'mama')),
    split: asNum(cellOf(r, t, 'split')),
    per_partner: asNum(cellOf(r, t, 'per_partner')),
    supplies: asNum(cellOf(r, t, 'supplies')),
    octopus: asNum(cellOf(r, t, 'octopus')),
    other: asNum(cellOf(r, t, 'other')),
    electric: asNum(cellOf(r, t, 'electric')),
    note_text: asStr(cellOf(r, t, 'note_text')),
    generated_at: asStr(cellOf(r, t, 'generated_at'))
  };
}

// ---------------------------------------------------------------------------
// Coercion / validation helpers — cells may be blank, numbers may arrive as
// strings (from JSON, or from hand-edited "@"-formatted cells).
// ---------------------------------------------------------------------------

function asStr(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

/** The branch name with any line break collapsed to a single space (v2.5.0).
 *  The branch heads the cutoff note, so an embedded CR/LF — pasted into the
 *  Settings cell, or typed on a phone keyboard — would split the note's first
 *  line in two. Applied on READ (apiCutoff, bootstrap) as well as on write
 *  (saveSettings), because the cell can be edited by hand. */
function cleanBranch(v) {
  return asStr(v).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** The current daily wage. The Settings value column is "@"-formatted, so it
 *  reads back as a string; a blank or unparseable cell falls back to the seeded
 *  rate rather than silently costing the day ₱0. */
function dailySalaryOf(settings) {
  var s = asStr(settings ? settings.daily_salary : '');
  return s === '' ? DEFAULT_DAILY_SALARY : asNum(s);
}

/** The Split a cutoff uses when no amount was entered for that period. */
function splitDefaultOf(settings) {
  var s = asStr(settings ? settings.split_default : '');
  return s === '' ? DEFAULT_SPLIT : asNum(s);
}

/** Lenient number: blank/garbage -> 0. Use for reading sheet cells. */
function asNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = asStr(v).replace(/[,\s]/g, '');
  if (s === '') return 0;
  var n = Number(s);
  return isFinite(n) ? n : 0;
}

/** Strict number: blank -> 0, but garbage is rejected. Use for client input. */
function numOrThrow(v, label) {
  if (v === null || v === undefined || asStr(v) === '') return 0;
  var n = (typeof v === 'number') ? v : Number(asStr(v).replace(/[,\s]/g, ''));
  if (!isFinite(n)) throw new Error(label + ' must be a number (got "' + v + '").');
  return n;
}

function intOrThrow(v, label) {
  var n = numOrThrow(v, label);
  if (Math.floor(n) !== n) throw new Error(label + ' must be a whole number (got "' + v + '").');
  return n;
}

/**
 * Stock moves in WHOLE UNITS — the thing you OPEN, never a weight — and that is
 * true of every door into the ledger, not just the day's usage list: usage
 * (saveDay), a delivery's quantity (saveExpense) and a stocktake (saveStockCount)
 * all feed the SAME arithmetic, on_hand = baseline + delivered − used. A fraction
 * accepted at any one of them puts a 2.5 on the shelf and quietly contradicts
 * what SPEC promises and what the screens say. One guard, one wording, called
 * from all three.
 *
 * `n` is already parsed and already known not to be negative — the caller says
 * that in its own words — so this only has to explain the fraction. `raw` is the
 * value as it arrived, so the message can quote what was actually typed.
 */
function wholeUnitsOrThrow(n, raw, product) {
  if (Math.floor(n) !== n) {
    throw new Error(product + ': count whole units opened (1, 2, 3), so "' +
      asStr(raw) + '" is not a whole unit.');
  }
  return n;
}

function asBool(v) {
  if (v === true) return true;
  var s = asStr(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** ["cheese"] -> "cheese"; ["cheese","GCash"] -> "cheese and GCash";
 *  ["a","b","c"] -> "a, b and c". Error messages are read by the owner on a
 *  phone, so they are written like a sentence, not like a list dump. */
function joinAnd(list) {
  if (list.length < 2) return list.join('');
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

/**
 * The `in_cutoff` flag, and the ONE cell in this file whose blank means TRUE.
 *
 * THIS IS NOT asBool AND MUST NEVER BE REPLACED BY IT. asBool('') is false; a
 * blank in_cutoff cell has to be TRUE, because:
 *   - migration APPENDS the column, so every price row already on the owner's
 *     live sheet has an EMPTY cell in it, and
 *   - a sheet that has not been migrated yet has no such column at all, which
 *     cellOf() also reads as ''.
 * If either of those read FALSE, box4/box6/box10 would silently drop out of the
 * cutoff and the note the owner sends his partner would collapse to almost
 * nothing — with every figure still looking like a perfectly good number.
 *
 * So the default is IN, and only an explicitly false-y value takes a sku out.
 * An unrecognised value (a typo, a stray word) also reads IN: the flag's job is
 * to remove ONE sku the owner set up on purpose, never to quietly remove money
 * nobody asked it to.
 */
function asCutoffFlag(v) {
  if (v === true) return true;
  if (v === false) return false;
  var s = asStr(v).toLowerCase();
  if (s === '') return true; // blank / missing column => counts IN
  return !(s === 'false' || s === '0' || s === 'no' || s === 'n' || s === 'off');
}

/** Dates travel as yyyy-MM-dd strings end-to-end; tolerate a Date object in
 *  case a cell lost its "@" format after hand editing. Duck-typed rather
 *  than instanceof so it also matches Dates from other JS realms.
 *
 *  Since v2.5.0 this also NORMALIZES the shapes a human types into a plain-text
 *  cell — "2026-7-5", "2026/07/05", "7/5/2026" — to canonical yyyy-MM-dd.
 *  Every reader and every date-keyed row match goes through here, so a day or
 *  expense the owner typed by hand is FOUND (by the phone, by the cutoff, and
 *  by the upsert that would otherwise write a duplicate row beside it) instead
 *  of being silently invisible money. Slash dates read as month/day/year (the
 *  Philippine Sheets convention); day/month is accepted only when month/day is
 *  impossible (13/5/2026), because an unambiguous guess is the only safe one.
 *  Anything that is not a real calendar date is returned untouched — this
 *  normalizes, it never invents. */
/** The date n days after a yyyy-MM-dd string, built from its PARTS so a
 *  timezone can never shift it (mirrors the phone's addDays). Used to walk a
 *  period looking for days with nothing in them. */
function addDaysStr(s, n) {
  var d = asDateStr(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  var p = d.split('-');
  var t = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + Number(n), 12, 0, 0));
  return Utilities.formatDate(t, 'UTC', 'yyyy-MM-dd');
}

function asDateStr(v) {
  if (v && typeof v.getTime === 'function' && typeof v.getMonth === 'function') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  var s = asStr(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already canonical (the usual case)
  var y, mo, d;
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s);
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) {
      y = Number(m[3]); mo = Number(m[1]); d = Number(m[2]);
      if (mo > 12 && d >= 1 && d <= 12) { var t = mo; mo = d; d = t; } // 13/5/2026: only d/M fits
    }
  }
  if (m && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }
  return s;
}

/** Validate a REQUEST date. Deliberately strict about shape — the phone always
 *  sends canonical yyyy-MM-dd, so a request that does not is a broken client,
 *  not a hand-typed cell — which is why this does NOT run the lenient
 *  normalization asDateStr applies to sheet reads. */
function reqDate(v, label) {
  var s = (v && typeof v.getTime === 'function' && typeof v.getMonth === 'function')
    ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : asStr(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error((label || 'date') + ' must be a yyyy-MM-dd string (got "' + asStr(v) + '").');
  }
  // Shape alone is not enough: "2026-13-05" or "2026-02-31" would otherwise
  // flow into period labels (MONTHS[12] -> undefined) and archived rows.
  var p = parseYmd(s);
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > daysInMonth(p.y, p.m)) {
    throw new Error((label || 'date') + ' is not a real calendar date (got "' + s + '").');
  }
  return s;
}

/** Validate the date of a RECORDED EVENT — a day of sales, an expense, a
 *  stocktake. Unlike a cutoff period's bounds (which legitimately reach to the
 *  end of the month), an event cannot be in the future, and one before 2020
 *  predates the stall — both are almost always a mangled year from a hand-typed
 *  or half-edited date, and both would file real money where nobody looks.
 *  "Today" is Asia/Manila's today, never the server's locale. */
function reqEntryDate(v, label) {
  var s = reqDate(v, label);
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (s > today) {
    throw new Error('That date (' + s + ') has not happened yet. Pick today or an earlier day.');
  }
  if (s < '2020-01-01') {
    throw new Error('That date (' + s + ') is before 2020, which cannot be right. Check the year.');
  }
  return s;
}

/**
 * The photo link on a saveDay (v2.9.0), or ''. Blank/absent is the normal case.
 * A non-blank value must be an ordinary http(s) link: this cell is provenance,
 * and a "link" that cannot be opened is worse than none at all — it looks like
 * a night that can be checked against its paper when it cannot. Refused in one
 * plain sentence, like every other request the server will not take.
 */
function photoLinkOrThrow(v) {
  var s = asStr(v);
  if (!s) return '';
  if (!/^https?:\/\/\S+$/.test(s) || s.length > 2000) {
    throw new Error('The photo link for this day is not a web address the sheet can store, so ' +
      'the day was not saved. Save the night without the photo and it will be kept as usual.');
  }
  return s;
}

/** Days in a month (m is 1-12), leap-year aware. */
function daysInMonth(y, m) {
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function nowStamp() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Normalize a raw sheet row to exactly n cells (stray extra columns or short
 *  rows would otherwise break the block setValues). */
function padRow(row, n) {
  var out = row.slice(0, n);
  while (out.length < n) out.push('');
  return out;
}

/** 1 -> "A", 2 -> "B", 27 -> "AA" — for building whole-column A1 ranges. */
function colLetter(col) {
  var s = '';
  while (col > 0) {
    var rem = (col - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

function schemaFor(name) {
  for (var i = 0; i < SCHEMA.length; i++) {
    if (SCHEMA[i].name === name) return SCHEMA[i];
  }
  throw new Error('No schema defined for tab "' + name + '".');
}

// ---------------------------------------------------------------------------
// setupSheet — run from the Apps Script editor (Run > setupSheet) at first
// install AND after any release that adds columns or tabs.
//
// It is a MIGRATION and it is idempotent: it creates what is missing, appends
// what is new, and touches nothing that already exists. Re-running never
// duplicates tabs, headers or seed rows, never regenerates the token, and
// never resets an edited price, setting or backlog balance.
// ---------------------------------------------------------------------------

function setupSheet() {
  var ss = SpreadsheetApp.getActive();

  // The spreadsheet FILE timezone is a separate setting from appsscript.json's
  // script timezone. It must also be Asia/Manila so that a yyyy-MM-dd string
  // ever coerced into a Date cell (hand edit, lost "@" format) round-trips
  // back to the SAME day via Utilities.formatDate(..., 'Asia/Manila', ...).
  ss.setSpreadsheetTimeZone(TZ);

  var changes = [];
  var createdTab = {};
  SCHEMA.forEach(function (def) {
    var r = migrateTab(ss, def);
    createdTab[def.name] = r.created;
    if (r.created) changes.push('created tab "' + def.name + '"');
    if (r.added.length > 0) changes.push(def.name + ': appended ' + r.added.join(', '));
  });

  // Settings keeps its key-wise add-if-missing (and the token) — a missing KEY
  // is a hole every request falls into. The ROW seeders below run ONLY when
  // their tab was just created (v2.5.0): a price, backlog or stock row the
  // owner deleted on purpose must stay deleted, not reappear on every release.
  var token = seedSettings(ss);
  if (createdTab[TAB.PRICES]) seedPrices(ss);
  if (createdTab[TAB.STOCK_ITEMS]) seedStockItems(ss);
  if (createdTab[TAB.BACKLOGS]) seedBacklogs(ss);

  // Backfill (v2.5.0, once): every non-closed DailyLog row whose salary cell is
  // BLANK gets the CURRENT daily_salary written into it. Such rows predate the
  // salary column and were counted at the live rate on every read — so the
  // moment the owner changed the rate, history silently re-priced itself. The
  // backfill freezes those days at the rate that was current when the sheet was
  // migrated, which is the closest available answer to what those days cost.
  var filled = backfillSalaries(ss, dailySalaryOf(readSettings(ss)));
  if (filled > 0) changes.push('DailyLog: wrote the current daily salary onto ' + filled + ' blank row(s)');

  // Backfill (v2.7.0): the owner's reorder points for the three products he
  // named, written ONLY into BLANK reorder_at cells — the salary-backfill
  // shape, so a threshold he has set by hand (an explicit 0 included) is never
  // overwritten, and re-running setupSheet changes nothing the second time.
  var thresholds = backfillReorderPoints(ss);
  if (thresholds > 0) changes.push('StockItems: wrote reorder points onto ' + thresholds + ' blank row(s)');

  // Backfill (v2.8.0): the owner's costs, in the SAME shape — BLANK cells only,
  // on every migration, so the live sheet he has been logging into since August
  // gets its real figures and every one he later edits stays his. Costing is
  // read-only management information: neither of these touches a cutoff figure,
  // the note, or a single peso that has already moved.
  var unitCosts = backfillUnitCosts(ss);
  if (unitCosts > 0) changes.push('StockItems: wrote unit costs onto ' + unitCosts + ' blank row(s)');
  var boxCosts = backfillBoxCosts(ss);
  if (boxCosts > 0) changes.push('Prices: wrote box costs onto ' + boxCosts + ' blank row(s)');

  Logger.log('setupSheet complete (v' + VERSION + '). ' +
    (changes.length ? 'Changes: ' + changes.join('; ') : 'Nothing to change.'));
  Logger.log('API token: ' + token);
  Logger.log('Sheet URL: ' + ss.getUrl());
  return token;
}

/**
 * Bring ONE tab up to the current schema, append-only.
 *   - creates the tab if it does not exist,
 *   - appends every schema header the tab does not already have, at the RIGHT
 *     of whatever is there (existing columns keep their position AND data),
 *   - never reorders, renames or deletes a column,
 *   - re-applies the whole-column "@" plain-text format to every date /
 *     timestamp column, INCLUDING ones just appended.
 * Returns {created, added:[headerNames]}.
 */
function migrateTab(ss, def) {
  var sh = ss.getSheetByName(def.name);
  var created = false;
  if (!sh) {
    sh = ss.insertSheet(def.name);
    created = true;
  }

  var maxCols = sh.getMaxColumns();
  var headers = sh.getRange(1, 1, 1, maxCols).getValues()[0];
  var map = headerMap(headers);

  // A tab that already holds data but whose row 1 has NOT ONE recognizable
  // header is not an older version of this tab — it is something else wearing
  // its name (or a tab whose header row was deleted). Appending the schema
  // beside it would lay a second layout over foreign data and every reader
  // would then see half of each. REFUSE, plainly, naming the tab. A tab that
  // is completely empty is fine: it gets the headers exactly like a created
  // one.
  if (!created && sh.getLastRow() > 0) {
    var recognized = 0;
    for (var r = 0; r < def.headers.length; r++) {
      if (map[def.headers[r]] !== undefined) recognized++;
    }
    if (recognized === 0) {
      throw new Error('The tab "' + def.name + '" already has data in it, but row 1 has none of ' +
        'the column names the app knows (it expects headers like "' +
        def.headers.slice(0, 3).join('", "') + '"). Nothing was changed. Fix that tab\'s ' +
        'header row — or rename the tab if it holds something else — then run setupSheet() again.');
    }
  }

  // Append point = the last OCCUPIED column, not the last NAMED one.
  //
  // A column can hold the owner's own data under a BLANK header — his live
  // sheet has exactly that (a 9-column DailyCounts with his notes in column J
  // and J1 empty). Counting only named headers would put "gcash_qty" into J1
  // and from that moment every reader would read his notes as GCash
  // quantities. getLastColumn() is sheet-wide, so it also sees data that no
  // header announces.
  //
  // Leaving a blank GAP column behind is harmless (headerMap ignores unnamed
  // columns and buildRow/padRow carry them through untouched); claiming an
  // occupied one silently corrupts data. Anything named — even a header we do
  // not know — is likewise left exactly where it is.
  var used = 0;
  for (var i = 0; i < headers.length; i++) {
    if (asStr(headers[i]) !== '') used = i + 1;
  }
  used = Math.max(used, sh.getLastColumn());

  var added = def.headers.filter(function (h) { return map[h] === undefined; });
  if (added.length > 0) {
    var need = used + added.length;
    if (need > maxCols) sh.insertColumnsAfter(maxCols, need - maxCols);
    sh.getRange(1, used + 1, 1, added.length).setValues([added]);
    // Re-read so the new columns are in the map for the format pass below.
    map = headerMap(sh.getRange(1, 1, 1, Math.max(need, maxCols)).getValues()[0]);
  }

  sh.setFrozenRows(1);

  // Plain-text ("@") format on date/timestamp columns so Sheets never coerces
  // yyyy-MM-dd strings into locale-dependent Date values. Applied to the WHOLE
  // column (unbounded "A:A"-style range) — not just the rows that exist now —
  // so rows auto-added later by appendRow/insertRowsAfter keep the text format
  // as the grid grows. Resolved by header NAME, so it lands on the right column
  // whatever the sheet's column order happens to be.
  (def.textCols || []).forEach(function (name) {
    var idx = map[name];
    if (idx === undefined) return;
    var letter = colLetter(idx + 1);
    sh.getRange(letter + ':' + letter).setNumberFormat('@');
  });

  return { created: created, added: added };
}

/** Tabs whose seed rows must exist before a save can validate against them.
 *  Used by readTabForWrite ONLY when it has just CREATED the tab (v2.5.0 — a
 *  migration that merely appended a column must not re-plant deleted rows), so
 *  a deploy that lands before setupSheet() is re-run still works. Every seeder
 *  is idempotent and keyed by name, so a race can never duplicate a row. */
var AUTO_SEED = {};
AUTO_SEED[TAB.STOCK_ITEMS] = function (ss) { seedStockItems(ss); };

/** Append object rows (values placed by header name) below the last data row. */
function appendObjects(ss, name, objs) {
  if (objs.length === 0) return;
  var t = readTab(ss, name);
  var width = writeWidth(t, name);
  var rows = objs.map(function (o) { return buildRow(t, width, o, null); });
  var at = t.values.length + 1;
  ensureRows(t.sheet, at + rows.length - 1);
  t.sheet.getRange(at, 1, rows.length, width).setValues(rows);
}

/**
 * Upsert object rows by a NATURAL KEY (one or more columns), append-only for
 * keys that are new. ONE read of the tab; rows that exist are rewritten in
 * place, the rest go out as one appended block.
 *
 * Two guarantees the config writers depend on:
 *   - a row the batch does not mention is never touched (no rewrite of the
 *     whole tab), and
 *   - a column the object does not mention keeps whatever it holds, because
 *     buildRow copies the existing row first — so `sort`, `opening_qty` and any
 *     column the owner added by hand all survive an edit from the phone.
 */
function upsertRows(ss, name, objs, keyCols) {
  if (!objs || objs.length === 0) return 0;
  var t = readTabForWrite(ss, name);
  var width = writeWidth(t, name);
  var idx = keyCols.map(function (k) { return colOf(t, k); });
  // Key parts are joined on a character no sheet cell can contain, so the
  // pair ("2026-08-01", "15") can never collide with ("2026-08-0", "115").
  // Both sides go through asDateStr, so a date cell that lost its "@" format
  // and became a real Date still matches the yyyy-MM-dd string being written.
  var SEP = '\u0001';
  var rowKey = function (row) {
    return idx.map(function (i) { return asDateStr(row[i]); }).join(SEP);
  };
  var objKey = function (o) {
    return keyCols.map(function (k) { return asDateStr(o[k]); }).join(SEP);
  };

  var rowAt = Object.create(null);
  for (var i = 1; i < t.values.length; i++) {
    var k = rowKey(t.values[i]);
    if (k !== '' && rowAt[k] === undefined) rowAt[k] = i + 1;
  }

  var buffer = [];  // new rows, in the order they arrived
  var bufAt = Object.create(null);
  objs.forEach(function (o) {
    var key = objKey(o);
    if (rowAt[key] !== undefined) {
      var at = rowAt[key];
      var row = buildRow(t, width, o, padRow(t.values[at - 1], width));
      t.sheet.getRange(at, 1, 1, width).setValues([row]);
      t.values[at - 1] = row; // keep the cached copy in step for a repeated key
    } else if (bufAt[key] !== undefined) {
      buffer[bufAt[key]] = buildRow(t, width, o, buffer[bufAt[key]]);
    } else {
      bufAt[key] = buffer.length;
      buffer.push(buildRow(t, width, o, null));
    }
  });

  if (buffer.length > 0) {
    var start = t.values.length + 1;
    var grown = ensureRows(t.sheet, start + buffer.length - 1);
    if (grown) {
      (schemaFor(name).textCols || []).forEach(function (h) {
        var c = t.col[h];
        if (c !== undefined) t.sheet.getRange(grown.from, c + 1, grown.count, 1).setNumberFormat('@');
      });
    }
    t.sheet.getRange(start, 1, buffer.length, width).setValues(buffer);
  }
  return objs.length;
}

/** Existing values of one column, as a {value: true} set. */
function existingKeys(t, name) {
  var have = {};
  for (var i = 1; i < t.values.length; i++) {
    var k = asStr(cellOf(t.values[i], t, name));
    if (k) have[k] = true;
  }
  return have;
}

/**
 * Write the CURRENT daily_salary into every non-closed DailyLog row whose
 * salary cell is BLANK (v2.5.0, run by setupSheet). Rows like that predate the
 * salary column and were resolved at READ time against the live rate — so the
 * moment the owner changed the rate, every one of those historical days
 * silently changed what it had cost, cutoffs already sent included. Writing
 * the rate in freezes them, exactly as a normal save would have.
 * Idempotent: a filled cell is never touched, an explicit 0 stands, and a
 * closed day stays blank-or-0 (nobody worked). Returns how many were filled.
 */
function backfillSalaries(ss, rate) {
  var t = readTab(ss, TAB.DAILY_LOG);
  var salIdx = t.col['salary'];
  if (salIdx === undefined) return 0; // cannot happen after migrateTab, but never throw here
  var filled = 0;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    if (asDateStr(cellOf(r, t, 'date')) === '') continue; // blank filler row
    if (asBool(cellOf(r, t, 'closed'))) continue;         // closed: 0 by definition, resolved on read
    if (asStr(cellOf(r, t, 'salary')) !== '') continue;   // already snapshotted (0 included)
    t.sheet.getRange(i + 1, salIdx + 1).setValue(rate);
    filled++;
  }
  return filled;
}

/**
 * Write the owner's reorder points (v2.7.0 — his figures, 2026-08-05) into
 * every StockItems row for the three products below whose reorder_at cell is
 * BLANK. The salary-backfill shape exactly: it runs on every setupSheet, and a
 * cell that already holds a value — an explicit 0 included, which means "no
 * warning, on purpose" — is never touched, so re-running is a no-op and a
 * threshold the owner later edits stays his. A product not on the list keeps
 * its blank (no warning) until he sets one himself.
 * Returns how many cells were filled.
 */
function backfillReorderPoints(ss) {
  var t = readTab(ss, TAB.STOCK_ITEMS);
  var idx = t.col['reorder_at'];
  if (idx === undefined) return 0; // cannot happen after migrateTab, but never throw here
  var wanted = Object.create(null);
  wanted['Takoyaki Flour'] = 5;
  wanted['Takoyaki Sauce'] = 1;
  wanted['Japanese Mayo'] = 1;
  var filled = 0;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var product = asStr(cellOf(r, t, 'product'));
    if (!product || wanted[product] === undefined) continue;
    if (asStr(cellOf(r, t, 'reorder_at')) !== '') continue; // hand-set (0 included) stands
    t.sheet.getRange(i + 1, idx + 1).setValue(wanted[product]);
    filled++;
  }
  return filled;
}

/**
 * Write the owner's unit costs (v2.8.0 — his figures, 2026-08-19) into every
 * StockItems row for the six products below whose unit_cost cell is BLANK.
 * The backfillReorderPoints shape exactly, and for the same reasons: it runs on
 * every setupSheet, so his LIVE sheet gets its real figures without him typing
 * them; a cell that already holds a value — an explicit 0 included — is never
 * touched, so a cost he corrects later stays his and re-running is a no-op.
 * A product not on the list keeps its blank, and a blank means "no cost known":
 * apiCosting lists it under `unpriced` and leaves its consumption out of the
 * total, rather than costing it at nothing.
 * Returns how many cells were filled.
 */
function backfillUnitCosts(ss) {
  var t = readTab(ss, TAB.STOCK_ITEMS);
  var idx = t.col['unit_cost'];
  if (idx === undefined) return 0; // cannot happen after migrateTab, but never throw here
  var wanted = Object.create(null);
  wanted['Takoyaki Flour'] = 120;
  wanted['Takoyaki Sauce'] = 490;
  wanted['Japanese Mayo'] = 300;
  wanted['Bonito'] = 900;
  wanted['Aonori'] = 550;
  wanted['Togarashi'] = 320;
  var filled = 0;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var product = asStr(cellOf(r, t, 'product'));
    if (!product || wanted[product] === undefined) continue;
    if (asStr(cellOf(r, t, 'unit_cost')) !== '') continue; // hand-set (0 included) stands
    t.sheet.getRange(i + 1, idx + 1).setValue(wanted[product]);
    filled++;
  }
  return filled;
}

/**
 * The container half of the same backfill (v2.8.0): the owner's bundle price
 * divided by the bundle count, written into every Prices row below whose
 * box_cost cell is BLANK. Same shape, same guarantee — a figure he has set by
 * hand, an explicit 0 included, is never overwritten.
 * Nori's 0 is deliberate and is written like any other value: it is sold in no
 * container, so 0 is the ANSWER. Leaving it blank would put it in `unpriced`
 * and read as "the owner has not told us yet", which is not true.
 * Returns how many cells were filled.
 */
function backfillBoxCosts(ss) {
  var t = readTab(ss, TAB.PRICES);
  var idx = t.col['box_cost'];
  if (idx === undefined) return 0; // cannot happen after migrateTab, but never throw here
  var wanted = Object.create(null);
  wanted['box4'] = 0.375;
  wanted['box6'] = 3;
  wanted['box10'] = 4.6;
  wanted['nori'] = 0;
  var filled = 0;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var sku = asStr(cellOf(r, t, 'sku'));
    if (!sku || wanted[sku] === undefined) continue;
    if (asStr(cellOf(r, t, 'box_cost')) !== '') continue; // hand-set (0 included) stands
    t.sheet.getRange(i + 1, idx + 1).setValue(wanted[sku]);
    filled++;
  }
  return filled;
}

/** Seed Settings rows that are missing; generate the token if absent/blank.
 *  Returns the current token. */
function seedSettings(ss) {
  var t = readTab(ss, TAB.SETTINGS);
  var valueCol = colOf(t, 'value') + 1;
  var have = {};
  for (var i = 1; i < t.values.length; i++) {
    var key = asStr(cellOf(t.values[i], t, 'key'));
    if (key) have[key] = { row: i + 1, value: cellOf(t.values[i], t, 'value') };
  }

  var token;
  var toAppend = [];
  if (!have.token) {
    token = randomToken();
    toAppend.push({ key: 'token', value: token });
  } else if (asStr(have.token.value) === '') {
    token = randomToken();
    t.sheet.getRange(have.token.row, valueCol).setValue(token);
  } else {
    token = asStr(have.token.value);
  }

  // ONLY the keys that are missing are appended — an existing value is never
  // overwritten, so an owner who lowered daily_salary keeps his figure across
  // every future setupSheet() run.
  var defaults = [
    ['branch', 'Tañong'],
    ['mama_per_cutoff', 500],
    ['electric_per_cutoff', 500],
    ['partners', 'Nayt, Partner'],
    ['staff', 'Mama'],
    // v2.3.0: the daily wage added to every non-closed day, and the Split the
    // Cutoff screen pre-fills (₱1,500 each).
    ['daily_salary', DEFAULT_DAILY_SALARY],
    ['split_default', DEFAULT_SPLIT],
    // The expense form's buckets between Octopus and Other (v2.7.1, the
    // owner's list). Purchase MONEY buckets, not the stock list — quantities
    // enter under Stock on hand, this is what the peso was for.
    ['supply_picklist', 'Veggies, Eggs, Flour, Box'],
    // v2.8.0: which expense buckets are already priced PER UNIT elsewhere, so
    // "What it costs" does not count their money a second time. Seeded to match
    // the picklist above (Flour restocks a tracked product; Box buys the
    // containers that boxes-sold x box_cost already charges for). Editable —
    // add a bucket here the day it gets a per-unit cost, and not before.
    ['costed_buckets', 'Flour, Sauce, Mayo, Bonito, Aonori, Togarashi, Box']
  ];
  defaults.forEach(function (d) {
    if (!have[d[0]]) toAppend.push({ key: d[0], value: d[1] });
  });

  appendObjects(ss, TAB.SETTINGS, toAppend);
  return token;
}

/**
 * Seed Prices rows for skus that don't exist yet (never touches edited rows).
 *
 * NORI (v2.4.0) is the first row with `in_cutoff` FALSE: it is sold and counted
 * exactly like anything else, but its money stays out of every cutoff figure —
 * the owner settles it himself. It is `group: 'simple'`, so start/end counts, one
 * price, no cheese — and being excluded it MUST be simple: an excluded sku has no
 * variant or payment split at all, so saveDay refuses a cheese, GCash or GCash
 * cheese count on it, and savePrices refuses to take a `group=box` sku out of the
 * cutoff in the first place.
 *
 * Matched by sku like every other seeder, so a sheet that already has a `nori`
 * row keeps it exactly as it is — including an in_cutoff the owner set himself.
 *
 * Since v2.5.0 the row seeders run ONLY when their tab was just created: on a
 * live sheet, a row the owner deleted on purpose must stay deleted, and a sku
 * he never sold must not appear because a release happened. Adding a product
 * to a live sheet is a Prices-tab job, done once, on purpose.
 */
function seedPrices(ss) {
  var t = readTab(ss, TAB.PRICES);
  var have = existingKeys(t, 'sku');
  // Owner sells takoyaki only — no drinks SKU. To add one later, append a row
  // here or directly in the Prices tab: group 'simple' means SOD/EOD counts with
  // a single price and no cheese split.
  // box_cost (v2.8.0) is the owner's bundle price divided by the bundle count,
  // i.e. what ONE container costs. Nori seeds an EXPLICIT 0 — it is sold in no
  // container at all, and 0 here is an answer, not a missing figure, so it must
  // not land in `unpriced`. A live sheet gets the same figures from
  // backfillBoxCosts, blank cells only.
  var seeds = [
    { sku: 'box4', label: 'Box 4', group: 'box', size: 4, price: 50, cheese_price: 60, active: true, in_cutoff: true, box_cost: 0.375 },
    { sku: 'box6', label: 'Box 6', group: 'box', size: 6, price: 65, cheese_price: 80, active: true, in_cutoff: true, box_cost: 3 },
    { sku: 'box10', label: 'Box 10', group: 'box', size: 10, price: 105, cheese_price: 125, active: true, in_cutoff: true, box_cost: 4.6 },
    { sku: 'nori', label: 'Nori', group: 'simple', size: '', price: 25, cheese_price: '', active: true, in_cutoff: false, box_cost: 0 }
  ];
  appendObjects(ss, TAB.PRICES, seeds.filter(function (s) { return !have[s.sku]; }));
}

/**
 * Stock products. Quantities only — StockUsage is never money.
 *
 * The unit is the thing you OPEN, not a weight (owner, 2026-08-03: "if a gallon
 * of sauce is opened, it's considered used in that day"), which is what makes
 * usage countable in whole units like the boxes.
 *
 * opening_qty seeds at 0 and opening_date seeds BLANK: the owner sets his real
 * figures with "Correct the count" after his first stocktake rather than typing
 * them up front, and a blank baseline date means the whole history counts.
 * reorder_at seeds blank, i.e. no warning until he sets a threshold.
 *
 * Rows are matched by product name, so a row that already exists is left
 * completely alone — an owner who changed a unit or set a reorder point keeps
 * both, and the seeded units below only ever reach a brand-new row.
 */
function seedStockItems(ss) {
  var t = readTab(ss, TAB.STOCK_ITEMS);
  var have = existingKeys(t, 'product');
  // unit_cost is the owner's own figure per the unit above — per PACK of flour,
  // per GALLON of sauce — which is what makes StockUsage.qty x unit_cost a
  // consumption cost rather than a guess (v2.8.0). It seeds on a NEW tab; a
  // live sheet gets the same figures from backfillUnitCosts, blank cells only.
  var seeds = [
    { product: 'Takoyaki Flour', unit: 'pack', active: true, sort: 1, unit_cost: 120 },
    { product: 'Takoyaki Sauce', unit: 'gallon', active: true, sort: 2, unit_cost: 490 },
    { product: 'Japanese Mayo', unit: 'pack', active: true, sort: 3, unit_cost: 300 },
    { product: 'Bonito', unit: 'pack', active: true, sort: 4, unit_cost: 900 },
    { product: 'Aonori', unit: 'pack', active: true, sort: 5, unit_cost: 550 },
    { product: 'Togarashi', unit: 'pack', active: true, sort: 6, unit_cost: 320 }
  ];
  seeds.forEach(function (s) {
    s.opening_qty = 0;
    s.opening_date = '';
    s.reorder_at = '';
  });
  appendObjects(ss, TAB.STOCK_ITEMS, seeds.filter(function (s) { return !have[s.product]; }));
}

/** Seed the owner's standing obligations. total_amount is the OUTSTANDING
 *  balance at setup time; the app subtracts every Backlog-category expense
 *  logged against the name, so the displayed balance only ever goes down.
 *  Rows are matched by name — an existing name is never overwritten, so
 *  re-running setupSheet cannot reset a partly-paid balance. */
function seedBacklogs(ss) {
  var t = readTab(ss, TAB.BACKLOGS);
  var have = existingKeys(t, 'name');
  var seeds = [
    { name: 'Takoyaki Flour', description: '', total_amount: 2538, start_date: '', active: true },
    { name: 'Takoyaki Sauce', description: '', total_amount: 114, start_date: '', active: true },
    { name: 'Ref', description: '', total_amount: 6700, start_date: '', active: true },
    { name: 'Deposit Nayt', description: '', total_amount: 7500, start_date: '', active: true },
    { name: 'Deposit Lou', description: '', total_amount: 7500, start_date: '', active: true },
    { name: 'Deposit Mama', description: '', total_amount: 7000, start_date: '', active: true },
    { name: 'Deposit Ilog Nayt', description: '', total_amount: 40000, start_date: '', active: true },
    { name: 'Deposit Ilog Mama', description: '', total_amount: 10000, start_date: '', active: true }
  ];
  appendObjects(ss, TAB.BACKLOGS, seeds.filter(function (s) { return !have[s.name]; }));
}

/** 32-char random token built from UUID entropy (~122 random bits). */
function randomToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}
