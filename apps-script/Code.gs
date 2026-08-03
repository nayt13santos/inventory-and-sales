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
 *            customAmount, customGcash, entryId, backlogRef, dryRun)
 *            — see SPEC.md "API contract".
 *   RESPONSE keys are snake_case (cheese_price, custom_amount, custom_gcash,
 *            entry_id, updated_at, cheese_qty, regular_qty, gcash_qty,
 *            gcash_cheese_qty, gcash_amount, supplies_total, backlog_ref,
 *            total_amount, start_date, per_partner, note_text, generated_at)
 *            — they mirror the sheet's own column headers and the shape the
 *            PWA persists in localStorage (state_v1).
 * Emitting camelCase in a response is a bug: the PWA reads snake_case, so a
 * mismatched key silently arrives as undefined and turns into 0 money.
 */

var VERSION = '2.2.0';
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
  SUPPLY_ITEMS: 'SupplyItems',
  DAILY_SUPPLIES: 'DailySupplies',
  STOCK_ITEMS: 'StockItems',
  STOCK_USAGE: 'StockUsage',
  EXPENSES: 'Expenses',
  BACKLOGS: 'Backlogs',
  CUTOFFS: 'Cutoffs'
};

var SCHEMA = [
  // Settings value column is also "@" so the token (or any numeric-looking
  // value) is never mangled by Sheets' automatic type coercion.
  { name: TAB.SETTINGS, headers: ['key', 'value'], textCols: ['value'] },
  { name: TAB.PRICES, headers: ['sku', 'label', 'group', 'size', 'price', 'cheese_price', 'active'], textCols: [] },
  // custom_gcash was appended in v2.1.0 (how much of custom_amount was GCash).
  // `gcash` is computed server-side now — it is still stored, still returned.
  { name: TAB.DAILY_LOG, headers: ['date', 'closed', 'staff', 'gcash', 'total', 'cash', 'custom_amount', 'notes', 'entry_id', 'updated_at', 'custom_gcash'], textCols: ['date', 'updated_at'] },
  // gcash_qty / gcash_cheese_qty / gcash_amount were appended in v2.1.0.
  { name: TAB.DAILY_COUNTS, headers: ['date', 'sku', 'sod', 'eod', 'sold', 'cheese_qty', 'regular_qty', 'amount', 'entry_id', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount'], textCols: ['date'] },
  { name: TAB.SUPPLY_ITEMS, headers: ['item', 'active', 'sort'], textCols: [] },
  { name: TAB.DAILY_SUPPLIES, headers: ['date', 'item', 'amount', 'entry_id', 'updated_at'], textCols: ['date', 'updated_at'] },
  { name: TAB.STOCK_ITEMS, headers: ['product', 'unit', 'active', 'sort'], textCols: [] },
  { name: TAB.STOCK_USAGE, headers: ['date', 'product', 'qty', 'entry_id', 'updated_at'], textCols: ['date', 'updated_at'] },
  { name: TAB.EXPENSES, headers: ['date', 'category', 'item', 'amount', 'backlog_ref', 'notes', 'entry_id', 'updated_at'], textCols: ['date', 'updated_at'] },
  { name: TAB.BACKLOGS, headers: ['name', 'description', 'total_amount', 'start_date', 'active'], textCols: ['start_date'] },
  { name: TAB.CUTOFFS, headers: ['start', 'end', 'total', 'cash', 'gcash', 'mama', 'split', 'per_partner', 'supplies', 'octopus', 'other', 'electric', 'note_text', 'generated_at'], textCols: ['start', 'end', 'generated_at'] }
];

var EXPENSE_CATEGORIES = ['Supplies', 'Octopus', 'Electric', 'Mama', 'Backlog', 'Other'];

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
        data = withLock(function () { return apiSaveDay(ss, payload); });
        break;
      case 'saveExpense':
        data = withLock(function () { return apiSaveExpense(ss, payload); });
        break;
      case 'deleteExpense':
        data = withLock(function () { return apiDeleteExpense(ss, payload); });
        break;
      case 'range':
        data = apiRange(ss, payload);
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
  var prices = readPrices(ss).list;
  var expensesAll = readExpenses(ss);
  var backlogs = readBacklogs(ss, expensesAll);

  // ONE window for everything the phone gets: the last 90 days, by DATE.
  //
  // Sales used to be capped at the last 45 DailyLog ROWS while expenses were
  // capped at 90 days. The Cutoff screen's back-arrows then showed an older
  // period that had its expenses but neither its sales nor its daily supplies,
  // so the preview understated that period badly (and the phone had no way to
  // know a figure was missing rather than zero). Same cutoff for all of them.
  var since = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), TZ, 'yyyy-MM-dd');
  var inWindow = function (row) { return row.date >= since; };

  var daysAll = readDays(ss);
  daysAll.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  var days = daysAll.filter(inWindow);

  var expenses = expensesAll.filter(inWindow);

  // Never echo the API token back inside data payloads.
  var publicSettings = {};
  for (var k in settings) {
    if (k !== 'token') publicSettings[k] = settings[k];
  }
  // The Settings value column is "@"-formatted, so numeric values read back
  // as strings. The API contract ships known-numeric settings as numbers.
  publicSettings.mama_per_cutoff = asNum(settings.mama_per_cutoff);
  publicSettings.electric_per_cutoff = asNum(settings.electric_per_cutoff);

  return {
    settings: publicSettings,
    prices: prices,
    supplyItems: readSupplyItems(ss).list,
    stockItems: readStockItems(ss).list,
    backlogs: backlogs,
    // The window this reply SPEAKS FOR. The phone needs it stated explicitly:
    // inferring the window from the dates present cannot distinguish "this date
    // is older than the reply covers" from "this date was deleted in the sheet",
    // so a day or expense removed by hand lingered on the phone forever.
    window_start: since,
    days: days,
    // The SAME 90-day window as `days` and `expenses`, so a cutoff preview can
    // never show one side of a period without the other, and an edited day
    // always reloads complete.
    counts: readCounts(ss).filter(inWindow),
    dailySupplies: readDailySupplies(ss).filter(inWindow),
    stockUsage: readStockUsage(ss).filter(inWindow),
    expenses: expenses,
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
function apiSaveDay(ss, payload) {
  var date = reqDate(payload.date, 'date');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var closed = asBool(payload.closed);
  var staff = asStr(payload.staff);
  var notes = asStr(payload.notes);

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
  // payload.gcash is DELIBERATELY IGNORED. GCash used to be typed in from the
  // GCash app; it is now computed from the buckets above. A phone that queued
  // a saveDay before this update still carries the old typed `gcash` field —
  // reading it would write a figure that contradicts the counts.

  var rawCounts = closed ? [] : (payload.counts || []);
  if (!Array.isArray(rawCounts)) throw new Error('counts must be an array.');

  var priceMap = readPrices(ss).map;
  var seenSkus = {};
  var lines = [];
  // Skus the day referenced that are no longer in Prices. Reported to the
  // client as `dropped_skus` so it can say plainly what happened.
  var droppedSkus = [];
  var seenDropped = {};

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

    var paid = cheeseQty + gcashQty + gcashCheeseQty;
    if (paid > sold) {
      throw new Error(p.label + ': cheese (' + cheeseQty + ') + GCash (' + gcashQty +
        ') + GCash cheese (' + gcashCheeseQty + ') adds up to ' + paid +
        ', but only ' + sold + ' were sold. Lower one of them.');
    }
    // The remainder is plain cash regular — always derived, never sent.
    var regularQty = sold - paid;

    // Price snapshot: amounts are computed NOW from the current Prices tab and
    // stored on the row, so later price edits never rewrite history.
    var amount = (regularQty + gcashQty) * p.price + (cheeseQty + gcashCheeseQty) * p.cheese_price;
    var gcashAmount = gcashQty * p.price + gcashCheeseQty * p.cheese_price;

    // Line objects are snake_case from here on: they are written to the
    // DailyCounts row AND returned to the client, and both of those are the
    // response side of the contract.
    lines.push({
      sku: sku, sod: sod, eod: eod, sold: sold,
      cheese_qty: cheeseQty, gcash_qty: gcashQty, gcash_cheese_qty: gcashCheeseQty,
      regular_qty: regularQty,
      amount: round2(amount), gcash_amount: round2(gcashAmount)
    });
  });

  // --- Daily supplies (pesos per item) — feeds the cutoff note's Supplies line
  //
  // The SupplyItems picklist is ADVISORY, not referential integrity: ANY
  // non-blank (trimmed) item name is accepted. Rejecting a name that is no
  // longer listed made the whole day permanently un-saveable — INCLUDING its
  // sales — the moment the owner renamed or deleted a picklist row, and there
  // was no way out from the phone. The phone still offers the picklist and
  // shows a quiet note next to a row whose name it no longer lists; it never
  // blocks the save. Amounts must still be >= 0 and names must still be unique.
  var rawSupplies = closed ? [] : (payload.supplies || []);
  if (!Array.isArray(rawSupplies)) throw new Error('supplies must be an array.');
  // The picklist's CONTENTS are not consulted, but a save that carries supply
  // rows still creates and seeds the tab if a live sheet has not been migrated
  // yet, so the next bootstrap can offer the picklist. Same cost as before.
  if (rawSupplies.length > 0) readTabForWrite(ss, TAB.SUPPLY_ITEMS);
  var seenSupply = {};
  var supplyRows = [];
  rawSupplies.forEach(function (s) {
    s = s || {};
    var item = asStr(s.item);
    if (!item) throw new Error('A supplies row is missing its item name.');
    if (seenSupply[item]) throw new Error('Duplicate supplies rows for "' + item + '".');
    seenSupply[item] = true;
    var amount = numOrThrow(s.amount, item + ' amount');
    if (amount < 0) throw new Error(item + ': amount cannot be negative.');
    // Only non-zero items get a row (SPEC) — a zeroed item just disappears.
    if (amount > 0) supplyRows.push({ item: item, amount: round2(amount) });
  });
  var suppliesTotal = round2(supplyRows.reduce(function (s, r) { return s + r.amount; }, 0));

  // --- Stock used (quantities) — NEVER money, never touches any total
  // StockItems is advisory too, for exactly the same reason as SupplyItems
  // above: a renamed product must never cost the owner a whole day of sales.
  var rawStock = closed ? [] : (payload.stock || []);
  if (!Array.isArray(rawStock)) throw new Error('stock must be an array.');
  if (rawStock.length > 0) readTabForWrite(ss, TAB.STOCK_ITEMS);
  var seenStock = {};
  var stockRows = [];
  rawStock.forEach(function (s) {
    s = s || {};
    var product = asStr(s.product);
    if (!product) throw new Error('A stock row is missing its product name.');
    if (seenStock[product]) throw new Error('Duplicate stock rows for "' + product + '".');
    seenStock[product] = true;
    // Quantities can be fractional (kg, gallons), so no whole-number check.
    var qty = numOrThrow(s.qty, product + ' quantity');
    if (qty < 0) throw new Error(product + ': quantity cannot be negative.');
    if (qty > 0) stockRows.push({ product: product, qty: qty });
  });

  // --- Day roll-up. Cash = Total − GCash still holds; GCash is now derived
  // from what was actually entered instead of read off the GCash app.
  var total = round2(lines.reduce(function (s, l) { return s + l.amount; }, 0) + custom);
  var gcash = round2(lines.reduce(function (s, l) { return s + l.gcash_amount; }, 0) + customGcash);
  var cash = round2(total - gcash);

  var stamp = nowStamp();

  // --- Upsert DailyLog by date (one row per date => replays cannot duplicate).
  // The row is built BY HEADER NAME on top of the existing row, so a column the
  // owner added by hand survives the upsert and column order does not matter.
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
    entry_id: entryId, updated_at: stamp
  };
  var logRow = buildRow(log, logWidth, logObj, found > 0 ? padRow(log.values[found - 1], logWidth) : null);
  if (found > 0) {
    log.sheet.getRange(found, 1, 1, logWidth).setValues([logRow]);
  } else {
    log.sheet.appendRow(logRow);
  }

  // --- Rewrite this date's blocks in the three date-keyed detail tabs.
  // DailyCounts stays first so a mid-write failure has the same (safe) shape
  // it always had — see rewriteDateBlock for the write-order reasoning.
  rewriteDateBlock(ss, TAB.DAILY_COUNTS, date, lines.map(function (l) {
    return {
      date: date, sku: l.sku, sod: l.sod, eod: l.eod, sold: l.sold,
      cheese_qty: l.cheese_qty, regular_qty: l.regular_qty, amount: l.amount,
      entry_id: entryId,
      gcash_qty: l.gcash_qty, gcash_cheese_qty: l.gcash_cheese_qty, gcash_amount: l.gcash_amount
    };
  }));
  rewriteDateBlock(ss, TAB.DAILY_SUPPLIES, date, supplyRows.map(function (r) {
    return { date: date, item: r.item, amount: r.amount, entry_id: entryId, updated_at: stamp };
  }));
  rewriteDateBlock(ss, TAB.STOCK_USAGE, date, stockRows.map(function (r) {
    return { date: date, product: r.product, qty: r.qty, entry_id: entryId, updated_at: stamp };
  }));

  // RESPONSE: snake_case. The PWA's applyServerDay() copies these straight
  // onto its DailyCounts mirror, which is snake_case in localStorage.
  return {
    total: total,
    cash: cash,
    gcash: gcash,
    supplies_total: suppliesTotal,
    // Always present (empty when nothing was dropped) so the client never has
    // to guess whether an older server simply omitted it.
    dropped_skus: droppedSkus,
    lines: lines.map(function (l) {
      return {
        sku: l.sku, sold: l.sold,
        cheese_qty: l.cheese_qty, gcash_qty: l.gcash_qty,
        gcash_cheese_qty: l.gcash_cheese_qty, regular_qty: l.regular_qty,
        amount: l.amount, gcash_amount: l.gcash_amount
      };
    })
  };
}

function apiSaveExpense(ss, payload) {
  var date = reqDate(payload.date, 'date');
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

  var obj = {
    date: date, category: category, item: item, amount: amount,
    backlog_ref: backlogRef, notes: notes, entry_id: entryId, updated_at: nowStamp()
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
  return { entry_id: entryId, updated: found > 0 }; // RESPONSE: snake_case
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

function apiRange(ss, payload) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');
  var inRange = function (x) { return x.date >= start && x.date <= end; };
  return {
    days: readDays(ss).filter(inRange),
    counts: readCounts(ss).filter(inRange),
    dailySupplies: readDailySupplies(ss).filter(inRange),
    stockUsage: readStockUsage(ss).filter(inRange),
    expenses: readExpenses(ss).filter(inRange)
  };
}

function apiCutoff(ss, settings, payload, dryRun) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');
  var inPeriod = function (x) { return x.date >= start && x.date <= end; };

  var days = readDays(ss).filter(inPeriod);
  var expenses = readExpenses(ss).filter(inPeriod);
  var dailySupplies = readDailySupplies(ss).filter(inPeriod);

  var total = 0, gcash = 0;
  days.forEach(function (d) { total += d.total; gcash += d.gcash; });
  total = round2(total);
  gcash = round2(gcash);
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
  // The Supplies line is the sum of BOTH places a supply purchase can live:
  // bulk buys logged under Expenses(Supplies) and the small daily buys logged
  // per item in DailySupplies. (The UI warns against entering one twice.)
  dailySupplies.forEach(function (s) { supplies += s.amount; });

  mama = round2(mama); supplies = round2(supplies); octopus = round2(octopus);
  electric = round2(electric); other = round2(other);

  // Verified identity: Total = Cash + GCash = Mama + Split + Supplies +
  // Octopus + Other + Electric  =>  Split is the residual profit. A bigger
  // Supplies figure simply leaves a smaller Split.
  var split = round2(total - mama - supplies - octopus - other - electric);
  var perPartner = round2(split / 2);

  // RESPONSE: snake_case (per_partner mirrors the Cutoffs column header).
  var figures = {
    start: start, end: end,
    total: total, cash: cash, gcash: gcash,
    mama: mama, split: split, per_partner: perPartner,
    supplies: supplies, octopus: octopus, other: other, electric: electric
  };

  var branch = asStr(settings.branch) || 'Tañong';
  var noteText = buildNoteText(branch, start, end, figures);

  if (!dryRun) {
    // Upsert by (start, end) — the period is the natural key. Retries and
    // legitimate regenerations converge on ONE archive row per period
    // instead of silently accumulating duplicates.
    var t = readTabForWrite(ss, TAB.CUTOFFS);
    var width = writeWidth(t, TAB.CUTOFFS);
    var startIdx = colOf(t, 'start');
    var endIdx = colOf(t, 'end');
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
    'Supplies - ' + orBlank(f.supplies),
    'Octopus - ' + orBlank(f.octopus),
    'Other payments - ' + orBlank(f.other),
    'Electric bill - ' + orBlank(f.electric)
  ].join('\n');
}

/** "July 1 - 15" (same month) or "July 30 - August 2" (spanning months). */
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
 *  duplicated header cannot shadow the real column. */
function headerMap(headerRow) {
  var m = {};
  for (var i = 0; i < headerRow.length; i++) {
    var h = asStr(headerRow[i]);
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
  migrateTab(ss, def);
  if (AUTO_SEED[name]) AUTO_SEED[name](ss);
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
  var map = {};
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var sku = asStr(cellOf(r, t, 'sku'));
    if (!sku) continue; // tolerate blank filler rows
    var p = {
      sku: sku,
      label: asStr(cellOf(r, t, 'label')) || sku,
      group: asStr(cellOf(r, t, 'group')) || 'simple',
      size: asNum(cellOf(r, t, 'size')),
      price: asNum(cellOf(r, t, 'price')),
      cheese_price: asNum(cellOf(r, t, 'cheese_price')),
      active: asBool(cellOf(r, t, 'active'))
    };
    list.push(p);
    map[sku] = p;
  }
  return { list: list, map: map };
}

function readDays(ss) {
  var t = readTab(ss, TAB.DAILY_LOG);
  var out = [];
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    out.push({
      date: date,
      closed: asBool(cellOf(r, t, 'closed')),
      staff: asStr(cellOf(r, t, 'staff')),
      gcash: asNum(cellOf(r, t, 'gcash')),
      total: asNum(cellOf(r, t, 'total')),
      cash: asNum(cellOf(r, t, 'cash')),
      custom_amount: asNum(cellOf(r, t, 'custom_amount')),
      // Pre-v2.1.0 rows have no custom_gcash column at all -> 0.
      custom_gcash: asNum(cellOf(r, t, 'custom_gcash')),
      notes: asStr(cellOf(r, t, 'notes')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
}

function readCounts(ss) {
  var t = readTab(ss, TAB.DAILY_COUNTS);
  var out = [];
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    out.push({
      date: date,
      sku: asStr(cellOf(r, t, 'sku')),
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
      gcash_amount: asNum(cellOf(r, t, 'gcash_amount'))
    });
  }
  return out;
}

/** The supplies picklist the phone offers. ADVISORY only — saveDay does not
 *  validate against it (D1), so this is a plain tolerant read: a sheet that has
 *  not been migrated yet has no tab and simply offers no picklist. */
function readSupplyItems(ss) {
  var t = readTabOptional(ss, TAB.SUPPLY_ITEMS);
  var list = [], map = {};
  if (t) {
    for (var i = 1; i < t.values.length; i++) {
      var r = t.values[i];
      var item = asStr(cellOf(r, t, 'item'));
      if (!item || map[item]) continue;
      var o = { item: item, active: asBool(cellOf(r, t, 'active')), sort: asNum(cellOf(r, t, 'sort')) };
      list.push(o);
      map[item] = o;
    }
  }
  list.sort(function (a, b) { return a.sort - b.sort; }); // stable for equal keys
  return { list: list, map: map };
}

/** The stock products the phone offers. Advisory too — see readSupplyItems. */
function readStockItems(ss) {
  var t = readTabOptional(ss, TAB.STOCK_ITEMS);
  var list = [], map = {};
  if (t) {
    for (var i = 1; i < t.values.length; i++) {
      var r = t.values[i];
      var product = asStr(cellOf(r, t, 'product'));
      if (!product || map[product]) continue;
      var o = {
        product: product,
        unit: asStr(cellOf(r, t, 'unit')),
        active: asBool(cellOf(r, t, 'active')),
        sort: asNum(cellOf(r, t, 'sort'))
      };
      list.push(o);
      map[product] = o;
    }
  }
  list.sort(function (a, b) { return a.sort - b.sort; });
  return { list: list, map: map };
}

/** Pesos spent per item per day. Feeds the cutoff note's Supplies line. */
function readDailySupplies(ss) {
  var t = readTabOptional(ss, TAB.DAILY_SUPPLIES);
  var out = [];
  if (!t) return out;
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(cellOf(r, t, 'date'));
    if (!date) continue;
    out.push({
      date: date,
      item: asStr(cellOf(r, t, 'item')),
      amount: asNum(cellOf(r, t, 'amount')),
      entry_id: asStr(cellOf(r, t, 'entry_id')),
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
}

/** Quantities consumed per product per day. NEVER money — this never reaches
 *  the note or any total; it exists to show consumption and flag reordering. */
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
      updated_at: asStr(cellOf(r, t, 'updated_at'))
    });
  }
  return out;
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

function asBool(v) {
  if (v === true) return true;
  var s = asStr(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** Dates travel as yyyy-MM-dd strings end-to-end; tolerate a Date object in
 *  case a cell lost its "@" format after hand editing. Duck-typed rather
 *  than instanceof so it also matches Dates from other JS realms. */
function asDateStr(v) {
  if (v && typeof v.getTime === 'function' && typeof v.getMonth === 'function') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return asStr(v);
}

function reqDate(v, label) {
  var s = asDateStr(v);
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
  SCHEMA.forEach(function (def) {
    var r = migrateTab(ss, def);
    if (r.created) changes.push('created tab "' + def.name + '"');
    if (r.added.length > 0) changes.push(def.name + ': appended ' + r.added.join(', '));
  });

  var token = seedSettings(ss);
  seedPrices(ss);
  seedSupplyItems(ss);
  seedStockItems(ss);
  seedBacklogs(ss);

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
 *  Used by readTabForWrite when it has just created the tab, so a deploy that
 *  lands before setupSheet() is re-run still works. Every seeder is idempotent
 *  and keyed by name, so calling one again can never duplicate or reset a row. */
var AUTO_SEED = {};
AUTO_SEED[TAB.SUPPLY_ITEMS] = function (ss) { seedSupplyItems(ss); };
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

/** Existing values of one column, as a {value: true} set. */
function existingKeys(t, name) {
  var have = {};
  for (var i = 1; i < t.values.length; i++) {
    var k = asStr(cellOf(t.values[i], t, name));
    if (k) have[k] = true;
  }
  return have;
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

  var defaults = [
    ['branch', 'Tañong'],
    ['mama_per_cutoff', 500],
    ['electric_per_cutoff', 500],
    ['partners', 'Nayt, Partner'],
    ['staff', 'Mama']
  ];
  defaults.forEach(function (d) {
    if (!have[d[0]]) toAppend.push({ key: d[0], value: d[1] });
  });

  appendObjects(ss, TAB.SETTINGS, toAppend);
  return token;
}

/** Seed Prices rows for skus that don't exist yet (never touches edited rows). */
function seedPrices(ss) {
  var t = readTab(ss, TAB.PRICES);
  var have = existingKeys(t, 'sku');
  // Owner sells takoyaki only — no drinks SKU. To add one later, append a row
  // here or directly in the Prices tab: group 'simple' means SOD/EOD counts with
  // a single price and no cheese split.
  var seeds = [
    { sku: 'box4', label: 'Box 4', group: 'box', size: 4, price: 50, cheese_price: 60, active: true },
    { sku: 'box6', label: 'Box 6', group: 'box', size: 6, price: 65, cheese_price: 80, active: true },
    { sku: 'box10', label: 'Box 10', group: 'box', size: 10, price: 105, cheese_price: 125, active: true }
  ];
  appendObjects(ss, TAB.PRICES, seeds.filter(function (s) { return !have[s.sku]; }));
}

/** The daily supplies picklist, from the owner's old DailyWeekly Supplies
 *  columns. `sort` fixes the order the phone shows them in. */
function seedSupplyItems(ss) {
  var t = readTab(ss, TAB.SUPPLY_ITEMS);
  var have = existingKeys(t, 'item');
  var names = ['Veggies', 'Egg', 'Ginger', 'Water', 'Flour', 'Tissue', 'Toothpick',
    'Fork', 'Bag #3', 'Bag #6', 'Bag #16', 'Cheese', 'Rags', 'Fare'];
  var seeds = names.map(function (n, i) {
    return { item: n, active: true, sort: i + 1 };
  });
  appendObjects(ss, TAB.SUPPLY_ITEMS, seeds.filter(function (s) { return !have[s.item]; }));
}

/** Stock products, from the owner's Supplies Calculator. Quantities only —
 *  StockUsage is never money. */
function seedStockItems(ss) {
  var t = readTab(ss, TAB.STOCK_ITEMS);
  var have = existingKeys(t, 'product');
  var seeds = [
    { product: 'Takoyaki Flour', unit: 'kg', active: true, sort: 1 },
    { product: 'Takoyaki Sauce', unit: 'gal', active: true, sort: 2 },
    { product: 'Japanese Mayo', unit: 'kg', active: true, sort: 3 },
    { product: 'Bonito', unit: 'g', active: true, sort: 4 },
    { product: 'Aonori', unit: 'g', active: true, sort: 5 },
    { product: 'Togarashi', unit: 'g', active: true, sort: 6 }
  ];
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
