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
 * First-time setup: run setupSheet() once from the editor. It is idempotent
 * (safe to re-run): creates missing tabs/headers/seed rows, generates the
 * API token, formats date columns as plain text (whole columns), freezes
 * header rows, and sets the spreadsheet FILE timezone to Asia/Manila.
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
 *   REQUEST  payload keys are camelCase  (cheeseQty, customAmount, entryId,
 *            backlogRef, dryRun) — see SPEC.md "API contract".
 *   RESPONSE keys are snake_case (cheese_price, custom_amount, entry_id,
 *            updated_at, cheese_qty, regular_qty, backlog_ref, total_amount,
 *            start_date, per_partner, note_text, generated_at) — they mirror
 *            the sheet's own column headers and the shape the PWA persists
 *            in localStorage (state_v1).
 * Emitting camelCase in a response is a bug: the PWA reads snake_case, so a
 * mismatched key silently arrives as undefined and turns into 0 money.
 */

var VERSION = '2.0.0';
var TZ = 'Asia/Manila';

// ---------------------------------------------------------------------------
// Sheet schema (tab names, headers, and which columns hold yyyy-MM-dd /
// timestamp strings and must be plain-text formatted).
// ---------------------------------------------------------------------------

var TAB = {
  SETTINGS: 'Settings',
  PRICES: 'Prices',
  DAILY_LOG: 'DailyLog',
  DAILY_COUNTS: 'DailyCounts',
  EXPENSES: 'Expenses',
  BACKLOGS: 'Backlogs',
  CUTOFFS: 'Cutoffs'
};

var SCHEMA = [
  // Settings value column is also "@" so the token (or any numeric-looking
  // value) is never mangled by Sheets' automatic type coercion.
  { name: TAB.SETTINGS, headers: ['key', 'value'], textCols: [2] },
  { name: TAB.PRICES, headers: ['sku', 'label', 'group', 'size', 'price', 'cheese_price', 'active'], textCols: [] },
  { name: TAB.DAILY_LOG, headers: ['date', 'closed', 'staff', 'gcash', 'total', 'cash', 'custom_amount', 'notes', 'entry_id', 'updated_at'], textCols: [1, 10] },
  { name: TAB.DAILY_COUNTS, headers: ['date', 'sku', 'sod', 'eod', 'sold', 'cheese_qty', 'regular_qty', 'amount', 'entry_id'], textCols: [1] },
  { name: TAB.EXPENSES, headers: ['date', 'category', 'item', 'amount', 'backlog_ref', 'notes', 'entry_id', 'updated_at'], textCols: [1, 8] },
  { name: TAB.BACKLOGS, headers: ['name', 'description', 'total_amount', 'start_date', 'active'], textCols: [4] },
  { name: TAB.CUTOFFS, headers: ['start', 'end', 'total', 'cash', 'gcash', 'mama', 'split', 'per_partner', 'supplies', 'octopus', 'other', 'electric', 'note_text', 'generated_at'], textCols: [1, 2, 14] }
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

  var daysAll = readDays(ss);
  daysAll.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  var days = daysAll.slice(-45);

  var wantedDates = {};
  days.forEach(function (d) { wantedDates[d.date] = true; });
  var counts = readCounts(ss).filter(function (c) { return wantedDates[c.date] === true; });

  var since = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), TZ, 'yyyy-MM-dd');
  var expenses = expensesAll.filter(function (x) { return x.date >= since; });

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
    backlogs: backlogs,
    days: days,
    counts: counts,
    expenses: expenses,
    lastCutoff: readLastCutoff(ss)
  };
}

/** REQUEST keys here are camelCase (payload.customAmount, payload.entryId,
 *  counts[].cheeseQty) — that is the documented client->server shape and must
 *  not change. The RESPONSE built at the bottom is snake_case. */
function apiSaveDay(ss, payload) {
  var date = reqDate(payload.date, 'date');
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var closed = asBool(payload.closed);
  var staff = asStr(payload.staff);
  var notes = asStr(payload.notes);

  // A closed day has no sales by definition: counts empty, total 0.
  // Ignore whatever counts/gcash/custom the client sent (offline edits can
  // leave stale values) rather than rejecting the save.
  var gcash = closed ? 0 : numOrThrow(payload.gcash, 'GCash');
  var custom = closed ? 0 : numOrThrow(payload.customAmount, 'Custom order amount');
  if (gcash < 0) throw new Error('GCash cannot be negative.');
  if (custom < 0) throw new Error('Custom order amount cannot be negative.');

  var rawCounts = closed ? [] : (payload.counts || []);
  if (!Array.isArray(rawCounts)) throw new Error('counts must be an array.');

  var priceMap = readPrices(ss).map;
  var seenSkus = {};
  var lines = [];

  rawCounts.forEach(function (c) {
    c = c || {};
    var sku = asStr(c.sku);
    var p = priceMap[sku];
    if (!p) throw new Error('Unknown sku "' + sku + '". Check the Prices tab.');
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

    var cheeseQty = 0;
    var regularQty = sold;
    var amount;
    if (p.group === 'box') {
      cheeseQty = intOrThrow(c.cheeseQty, p.label + ' cheese qty');
      if (cheeseQty < 0) throw new Error(p.label + ': cheese qty cannot be negative.');
      if (cheeseQty > sold) {
        throw new Error(p.label + ': cheese qty (' + cheeseQty + ') cannot exceed sold (' + sold + ').');
      }
      regularQty = sold - cheeseQty;
      // Price snapshot: amount is computed NOW from the current Prices tab and
      // stored on the row, so later price edits never rewrite history.
      amount = cheeseQty * p.cheese_price + regularQty * p.price;
    } else {
      // group=simple: single price, no cheese split (cheeseQty ignored).
      amount = sold * p.price;
    }
    // Line objects are snake_case from here on: they are written to the
    // DailyCounts row AND returned to the client, and both of those are the
    // response side of the contract.
    lines.push({
      sku: sku, sod: sod, eod: eod, sold: sold,
      cheese_qty: cheeseQty, regular_qty: regularQty, amount: round2(amount)
    });
  });

  var total = round2(lines.reduce(function (s, l) { return s + l.amount; }, 0) + custom);
  if (gcash > total) {
    throw new Error('GCash (' + fmtAmt(gcash) + ') cannot exceed total (' + fmtAmt(total) + ').');
  }
  var cash = round2(total - gcash);

  // --- Upsert DailyLog by date (one row per date => replays cannot duplicate)
  var log = readTab(ss, TAB.DAILY_LOG);
  var logRow = [date, closed, staff, gcash, total, cash, custom, notes, entryId, nowStamp()];
  var found = -1;
  for (var i = 1; i < log.values.length; i++) {
    if (asDateStr(log.values[i][0]) === date) { found = i + 1; break; }
  }
  if (found > 0) {
    log.sheet.getRange(found, 1, 1, logRow.length).setValues([logRow]);
  } else {
    log.sheet.appendRow(logRow);
  }

  // --- Rewrite this date's DailyCounts block: keep all other dates' rows,
  // drop this date's old rows, append the fresh lines, write back.
  // Write order is deliberate (history must survive a mid-write failure):
  //   (1) grow the grid if the block would not fit — getRange/setValues never
  //       expand it and would throw once the table outgrows the initial grid,
  //   (2) overwrite rows 2..N with the full new block,
  //   (3) clear only the surplus rows BELOW the written block.
  // A crash between (2) and (3) leaves stale duplicate rows at the bottom
  // (recoverable), whereas clear-then-write could wipe the whole history.
  var COUNT_COLS = 9;
  var ct = readTab(ss, TAB.DAILY_COUNTS);
  var kept = [];
  for (var r = 1; r < ct.values.length; r++) {
    if (asDateStr(ct.values[r][0]) !== date) kept.push(padRow(ct.values[r], COUNT_COLS));
  }
  lines.forEach(function (l) {
    kept.push([date, l.sku, l.sod, l.eod, l.sold, l.cheese_qty, l.regular_qty, l.amount, entryId]);
  });
  if (kept.length > 0) {
    var needRows = kept.length + 1; // +1 for the header row
    var maxRows = ct.sheet.getMaxRows();
    if (needRows > maxRows) {
      ct.sheet.insertRowsAfter(maxRows, needRows - maxRows);
      // Keep the date column plain text on the new rows (belt-and-braces to
      // setupSheet's whole-column "@" format) so the yyyy-MM-dd strings
      // written below are never coerced into Date cells.
      ct.sheet.getRange(maxRows + 1, 1, needRows - maxRows, 1).setNumberFormat('@');
    }
    ct.sheet.getRange(2, 1, kept.length, COUNT_COLS).setValues(kept);
  }
  var oldDataRows = ct.values.length - 1;
  if (oldDataRows > kept.length) {
    ct.sheet.getRange(2 + kept.length, 1, oldDataRows - kept.length, COUNT_COLS).clearContent();
  }

  // RESPONSE: snake_case. The PWA's applyServerDay() copies these straight
  // onto its DailyCounts mirror, which is snake_case in localStorage.
  return {
    total: total,
    cash: cash,
    lines: lines.map(function (l) {
      return { sku: l.sku, sold: l.sold, cheese_qty: l.cheese_qty, regular_qty: l.regular_qty, amount: l.amount };
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

  var row = [date, category, item, amount, backlogRef, notes, entryId, nowStamp()];

  // Upsert by entry_id: replaying the same mutation rewrites the same row.
  var t = readTab(ss, TAB.EXPENSES);
  var found = -1;
  for (var i = 1; i < t.values.length; i++) {
    if (asStr(t.values[i][6]) === entryId) { found = i + 1; break; }
  }
  if (found > 0) {
    t.sheet.getRange(found, 1, 1, row.length).setValues([row]);
  } else {
    t.sheet.appendRow(row);
  }
  return { entry_id: entryId, updated: found > 0 }; // RESPONSE: snake_case
}

function apiDeleteExpense(ss, payload) {
  var entryId = asStr(payload.entryId);
  if (!entryId) throw new Error('entryId is required.');
  var t = readTab(ss, TAB.EXPENSES);
  for (var i = 1; i < t.values.length; i++) {
    if (asStr(t.values[i][6]) === entryId) {
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
    expenses: readExpenses(ss).filter(inRange)
  };
}

function apiCutoff(ss, settings, payload, dryRun) {
  var start = reqDate(payload.start, 'start');
  var end = reqDate(payload.end, 'end');
  if (start > end) throw new Error('start (' + start + ') must be on or before end (' + end + ').');

  var days = readDays(ss).filter(function (d) { return d.date >= start && d.date <= end; });
  var expenses = readExpenses(ss).filter(function (x) { return x.date >= start && x.date <= end; });

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
  mama = round2(mama); supplies = round2(supplies); octopus = round2(octopus);
  electric = round2(electric); other = round2(other);

  // Verified identity: Total = Cash + GCash = Mama + Split + Supplies +
  // Octopus + Other + Electric  =>  Split is the residual profit.
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
    var t = readTab(ss, TAB.CUTOFFS);
    var row = [start, end, total, cash, gcash, mama, split, perPartner,
      supplies, octopus, other, electric, noteText, nowStamp()];
    var found = -1;
    for (var i = 1; i < t.values.length; i++) {
      if (asDateStr(t.values[i][0]) === start && asDateStr(t.values[i][1]) === end) {
        found = i + 1;
        break;
      }
    }
    if (found > 0) {
      t.sheet.getRange(found, 1, 1, row.length).setValues([row]);
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
// Tab readers — exactly ONE getDataRange().getValues() per tab per request.
//
// Everything these return is shipped verbatim in a RESPONSE (bootstrap/range),
// so every key here is snake_case and matches the sheet's column header.
// Renaming one to camelCase breaks the PWA silently (undefined -> 0).
// ---------------------------------------------------------------------------

function readTab(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('Missing sheet "' + name + '". Run setupSheet() from the Apps Script editor.');
  }
  return { sheet: sheet, values: sheet.getDataRange().getValues() };
}

function readSettings(ss) {
  var t = readTab(ss, TAB.SETTINGS);
  var out = {};
  for (var i = 1; i < t.values.length; i++) {
    var key = asStr(t.values[i][0]);
    if (key) out[key] = t.values[i][1];
  }
  return out;
}

function readPrices(ss) {
  var t = readTab(ss, TAB.PRICES);
  var list = [];
  var map = {};
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var sku = asStr(r[0]);
    if (!sku) continue; // tolerate blank filler rows
    var p = {
      sku: sku,
      label: asStr(r[1]) || sku,
      group: asStr(r[2]) || 'simple',
      size: asNum(r[3]),
      price: asNum(r[4]),
      cheese_price: asNum(r[5]),
      active: asBool(r[6])
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
    var date = asDateStr(r[0]);
    if (!date) continue;
    out.push({
      date: date,
      closed: asBool(r[1]),
      staff: asStr(r[2]),
      gcash: asNum(r[3]),
      total: asNum(r[4]),
      cash: asNum(r[5]),
      custom_amount: asNum(r[6]),
      notes: asStr(r[7]),
      entry_id: asStr(r[8]),
      updated_at: asStr(r[9])
    });
  }
  return out;
}

function readCounts(ss) {
  var t = readTab(ss, TAB.DAILY_COUNTS);
  var out = [];
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(r[0]);
    if (!date) continue;
    out.push({
      date: date,
      sku: asStr(r[1]),
      sod: asNum(r[2]),
      eod: asNum(r[3]),
      sold: asNum(r[4]),
      cheese_qty: asNum(r[5]),
      regular_qty: asNum(r[6]),
      amount: asNum(r[7]),
      entry_id: asStr(r[8])
    });
  }
  return out;
}

function readExpenses(ss) {
  var t = readTab(ss, TAB.EXPENSES);
  var out = [];
  for (var i = 1; i < t.values.length; i++) {
    var r = t.values[i];
    var date = asDateStr(r[0]);
    if (!date) continue;
    out.push({
      date: date,
      category: asStr(r[1]),
      item: asStr(r[2]),
      amount: asNum(r[3]),
      backlog_ref: asStr(r[4]),
      notes: asStr(r[5]),
      entry_id: asStr(r[6]),
      updated_at: asStr(r[7])
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
    var name = asStr(r[0]);
    if (!name) continue;
    var totalAmount = asNum(r[2]);
    var paid = round2(paidByName[name] || 0);
    out.push({
      name: name,
      description: asStr(r[1]),
      total_amount: totalAmount,
      start_date: asDateStr(r[3]),
      active: asBool(r[4]),
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
    start: asDateStr(r[0]),
    end: asDateStr(r[1]),
    total: asNum(r[2]),
    cash: asNum(r[3]),
    gcash: asNum(r[4]),
    mama: asNum(r[5]),
    split: asNum(r[6]),
    per_partner: asNum(r[7]),
    supplies: asNum(r[8]),
    octopus: asNum(r[9]),
    other: asNum(r[10]),
    electric: asNum(r[11]),
    note_text: asStr(r[12]),
    generated_at: asStr(r[13])
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

// ---------------------------------------------------------------------------
// setupSheet — run ONCE manually from the Apps Script editor (Run > setupSheet).
// Idempotent: re-running never duplicates tabs, headers, or seed rows, and
// never overwrites an existing token or edited prices/settings.
// ---------------------------------------------------------------------------

function setupSheet() {
  var ss = SpreadsheetApp.getActive();

  // The spreadsheet FILE timezone is a separate setting from appsscript.json's
  // script timezone. It must also be Asia/Manila so that a yyyy-MM-dd string
  // ever coerced into a Date cell (hand edit, lost "@" format) round-trips
  // back to the SAME day via Utilities.formatDate(..., 'Asia/Manila', ...).
  ss.setSpreadsheetTimeZone(TZ);

  SCHEMA.forEach(function (def) {
    var sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);

    // Write headers only when row 1 doesn't already match.
    var width = def.headers.length;
    var current = sh.getRange(1, 1, 1, width).getValues()[0];
    var mismatch = false;
    for (var i = 0; i < width; i++) {
      if (asStr(current[i]) !== def.headers[i]) { mismatch = true; break; }
    }
    if (mismatch) sh.getRange(1, 1, 1, width).setValues([def.headers]);

    sh.setFrozenRows(1);

    // Plain-text ("@") format on date/timestamp columns so Sheets never
    // coerces yyyy-MM-dd strings into locale-dependent Date values. Applied
    // to the WHOLE column (unbounded "A:A"-style range) — not just the rows
    // that exist now — so rows auto-added later by appendRow/insertRowsAfter
    // keep the text format as the grid grows.
    (def.textCols || []).forEach(function (col) {
      var letter = colLetter(col);
      sh.getRange(letter + ':' + letter).setNumberFormat('@');
    });
  });

  var token = seedSettings(ss);
  seedPrices(ss);
  seedBacklogs(ss);

  Logger.log('setupSheet complete. API token: ' + token);
  Logger.log('Sheet URL: ' + ss.getUrl());
  return token;
}

/** Seed Settings rows that are missing; generate the token if absent/blank.
 *  Returns the current token. */
function seedSettings(ss) {
  var sh = ss.getSheetByName(TAB.SETTINGS);
  var values = sh.getDataRange().getValues();
  var have = {};
  for (var i = 1; i < values.length; i++) {
    var key = asStr(values[i][0]);
    if (key) have[key] = { row: i + 1, value: values[i][1] };
  }

  var token;
  var toAppend = [];
  if (!have.token) {
    token = randomToken();
    toAppend.push(['token', token]);
  } else if (asStr(have.token.value) === '') {
    token = randomToken();
    sh.getRange(have.token.row, 2).setValue(token);
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
    if (!have[d[0]]) toAppend.push(d);
  });

  if (toAppend.length > 0) {
    sh.getRange(values.length + 1, 1, toAppend.length, 2).setValues(toAppend);
  }
  return token;
}

/** Seed Prices rows for skus that don't exist yet (never touches edited rows). */
function seedPrices(ss) {
  var sh = ss.getSheetByName(TAB.PRICES);
  var values = sh.getDataRange().getValues();
  var have = {};
  for (var i = 1; i < values.length; i++) {
    var sku = asStr(values[i][0]);
    if (sku) have[sku] = true;
  }
  // Owner sells takoyaki only — no drinks SKU. To add one later, append a row
  // here or directly in the Prices tab: group 'simple' means SOD/EOD counts with
  // a single price and no cheese split.
  var seeds = [
    ['box4', 'Box 4', 'box', 4, 50, 60, true],
    ['box6', 'Box 6', 'box', 6, 65, 80, true],
    ['box10', 'Box 10', 'box', 10, 105, 125, true]
  ];
  var toAppend = seeds.filter(function (s) { return !have[s[0]]; });
  if (toAppend.length > 0) {
    sh.getRange(values.length + 1, 1, toAppend.length, seeds[0].length).setValues(toAppend);
  }
}

/** Seed the owner's standing obligations. total_amount is the OUTSTANDING
 *  balance at setup time; the app subtracts every Backlog-category expense
 *  logged against the name, so the displayed balance only ever goes down.
 *  Rows are matched by name — an existing name is never overwritten, so
 *  re-running setupSheet cannot reset a partly-paid balance. */
function seedBacklogs(ss) {
  var sh = ss.getSheetByName(TAB.BACKLOGS);
  var values = sh.getDataRange().getValues();
  var have = {};
  for (var i = 1; i < values.length; i++) {
    var name = asStr(values[i][0]);
    if (name) have[name] = true;
  }
  // name, description, total_amount, start_date, active
  var seeds = [
    ['Takoyaki Flour', '', 2538, '', true],
    ['Takoyaki Sauce', '', 114, '', true],
    ['Ref', '', 6700, '', true],
    ['Deposit Nayt', '', 7500, '', true],
    ['Deposit Lou', '', 7500, '', true],
    ['Deposit Mama', '', 7000, '', true],
    ['Deposit Ilog Nayt', '', 40000, '', true],
    ['Deposit Ilog Mama', '', 10000, '', true]
  ];
  var toAppend = seeds.filter(function (s) { return !have[s[0]]; });
  if (toAppend.length > 0) {
    sh.getRange(values.length + 1, 1, toAppend.length, seeds[0].length).setValues(toAppend);
  }
}

/** 32-char random token built from UUID entropy (~122 random bits). */
function randomToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}
