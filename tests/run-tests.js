'use strict';
// Throwaway verification harness: loads the REAL Code.gs into a vm context
// with Apps Script stubs and exercises the reviewed logic.

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const { FakeSheet, FakeSpreadsheet, makeContext, formatDate, FIXED_NOW } = require('./gas-stubs');
const TZ_MANILA = 'Asia/Manila';

// Resolved from this file's location so the suite runs anywhere — a developer
// machine or a CI runner. Absolute paths made CI fail on the first push.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CODE_GS = path.join(ROOT, 'apps-script', 'Code.gs');
const source = fs.readFileSync(CODE_GS, 'utf8');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL  ' + name + '\n        ' + String(err.message).split('\n').join('\n        '));
  }
}

// Fresh context per scenario so sheet state never leaks between tests.
function load(ssOverride) {
  const ss = ssOverride || new FakeSpreadsheet();
  const ctx = makeContext(ss);
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'Code.gs' });
  return { ctx, ss };
}

// Convenience: run setupSheet to get a fully seeded spreadsheet + token.
function freshSetup() {
  const { ctx, ss } = load();
  const token = ctx.setupSheet();
  return { ctx, ss, token };
}

function post(ctx, body) {
  const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.getContent());
}

// ---------------------------------------------------------------------------
console.log('\n--- 1. Cutoff note format (exact-string, spec sample) ---');

// The spec's sample note, verbatim (note the trailing space on "Octopus - ").
//
// v2.3.0 changed this note DELIBERATELY: a "Salary" line, and a final residual
// line whose LABEL carries the sign so a note never reads "- -2,000". Split is
// now an ENTERED amount (₱3,000 = ₱1,500 each by default) and REMAINING is the
// residual — negative here, which is exactly the case the owner needs to see.
const SPEC_NOTE = [
  'Tañong: July 1 - 15 Breakdown',
  '',
  'Total - 11,857',
  '',
  'Cash - 10,530',
  'GCash - 1,327',
  '',
  'Mama - 500',
  'Split - 3,000(1,500 each)',
  'Supplies - 5,440',
  'Octopus - ',
  'Salary - 3,000',
  'Other payments - 1,417',
  'Electric bill - 500',
  '',
  'Short - 2,000'
].join('\n');

const SPEC_FIGURES = {
  total: 11857, cash: 10530, gcash: 1327,
  mama: 500, split: 3000, per_partner: 1500,
  supplies: 5440, octopus: 0, salary: 3000, other: 1417, electric: 500,
  remaining: -2000
};

test('buildNoteText reproduces the spec sample EXACTLY', () => {
  const { ctx } = load();
  const note = ctx.buildNoteText('Tañong', '2025-07-01', '2025-07-15', SPEC_FIGURES);
  assert.strictEqual(note, SPEC_NOTE);
  // Spelled out so a future edit cannot quietly "tidy" one of these away.
  const lines = note.split('\n');
  assert.strictEqual(lines.length, 16);
  assert.deepStrictEqual([lines[1], lines[3], lines[6], lines[14]], ['', '', '', ''],
    'blank-line placement, including the one before the residual');
  assert.strictEqual(lines[8], 'Split - 3,000(1,500 each)', 'no space before the bracket');
  assert.strictEqual(lines[10], 'Octopus - ', 'a zero category keeps the trailing space');
  assert.strictEqual(lines[11], 'Salary - 3,000');
  assert.strictEqual(lines[15], 'Short - 2,000', 'the LABEL carries the sign');
  assert.ok(!/- -/.test(note), 'a note must never print a minus sign after "- "');
});

test('the residual line: "Remaining" when >= 0, "Short" when negative, always a number', () => {
  const { ctx } = load();
  const noteWith = (remaining) => ctx.buildNoteText('Tañong', '2025-07-01', '2025-07-15',
    Object.assign({}, SPEC_FIGURES, { remaining: remaining }));

  assert.strictEqual(noteWith(1000).split('\n').pop(), 'Remaining - 1,000');
  assert.strictEqual(noteWith(-2000).split('\n').pop(), 'Short - 2,000');
  // Zero is a NUMBER on this line, never a blank like the categories above it.
  assert.strictEqual(noteWith(0).split('\n').pop(), 'Remaining - 0');
  assert.strictEqual(noteWith(-0.5).split('\n').pop(), 'Short - 0.50');
  assert.strictEqual(noteWith(12345.5).split('\n').pop(), 'Remaining - 12,345.50');
});

test('a zero Salary blanks like the other categories, and never blanks Total', () => {
  const { ctx } = load();
  const note = ctx.buildNoteText('Tañong', '2025-07-01', '2025-07-15',
    Object.assign({}, SPEC_FIGURES, { salary: 0, total: 0, cash: 0, gcash: 0, remaining: 0 }));
  const lines = note.split('\n');
  assert.strictEqual(lines[11], 'Salary - ', 'a zero Salary keeps the line and blanks the value');
  assert.strictEqual(lines[2], 'Total - 0');
  assert.strictEqual(lines[4], 'Cash - 0');
  assert.strictEqual(lines[5], 'GCash - 0');
  assert.strictEqual(lines[15], 'Remaining - 0');
});

test('periodLabel spans months: "July 30 - August 2"', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.periodLabel('2025-07-30', '2025-08-02'), 'July 30 - August 2');
});

test('fmtAmt: separators, centavos, whole numbers', () => {
  const { ctx } = load();
  assert.strictEqual(ctx.fmtAmt(11857), '11,857');
  assert.strictEqual(ctx.fmtAmt(2000.5), '2,000.50');
  assert.strictEqual(ctx.fmtAmt(1234567), '1,234,567');
  assert.strictEqual(ctx.fmtAmt(0), '0');
  assert.strictEqual(ctx.fmtAmt(4.999999), '5');
});

// ---------------------------------------------------------------------------
console.log('\n--- 2. End-to-end cutoff math + note via apiCutoff (spec figures) ---');

// Seed days/expenses that sum exactly to the spec sample figures.
//
// SALARY is why this seeds all FIFTEEN days of the period: ₱200 a day for 15
// open days is the sample's ₱3,000 Salary line. Two of them carry the money
// (11,857 total, 1,327 GCash); the other thirteen are open days that happened to
// sell nothing, which still cost a day's wage.
function seedSpecPeriod(ctx, token) {
  // GCash is COMPUTED server-side now, so it is produced here by the custom
  // order's GCash part (customGcash) rather than typed in.
  const money = {
    '2025-07-03': { gcashPart: 1000, custom: 6000 },
    '2025-07-10': { gcashPart: 327, custom: 5857 }
  };
  for (let day = 1; day <= 15; day++) {
    const date = '2025-07-' + (day < 10 ? '0' + day : day);
    const m = money[date] || { gcashPart: 0, custom: 0 };
    const res = post(ctx, {
      token, action: 'saveDay',
      payload: {
        date: date, closed: false, staff: 'Mama',
        customAmount: m.custom, customGcash: m.gcashPart,
        notes: '', counts: [], entryId: 'day-' + date
      }
    });
    assert.strictEqual(res.ok, true, 'saveDay failed: ' + res.error);
  }
  // Supplies is Expenses(category=Supplies) ALONE now, so the sample's 5,440
  // is logged here in full.
  const expenses = [
    { category: 'Mama', amount: 500 },
    { category: 'Supplies', amount: 5440 },
    { category: 'Backlog', amount: 1000, backlogRef: 'Utang A' },
    { category: 'Other', amount: 417 },
    { category: 'Electric', amount: 500 }
  ];
  expenses.forEach((x, i) => {
    const res = post(ctx, {
      token, action: 'saveExpense',
      payload: {
        date: '2025-07-05', category: x.category, item: 't', amount: x.amount,
        backlogRef: x.backlogRef || '', notes: '', entryId: 'exp-' + i
      }
    });
    assert.strictEqual(res.ok, true, 'saveExpense failed: ' + res.error);
  });
}

test('apiCutoff computes spec figures and the exact note text', () => {
  const { ctx, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  const res = post(ctx, {
    token, action: 'cutoff',
    payload: { start: '2025-07-01', end: '2025-07-15', dryRun: true }
  });
  assert.strictEqual(res.ok, true, res.error);
  const f = res.data.figures;
  assert.strictEqual(f.total, 11857);
  assert.strictEqual(f.cash, 10530);
  assert.strictEqual(f.gcash, 1327);
  assert.strictEqual(f.mama, 500);
  assert.strictEqual(f.supplies, 5440);
  assert.strictEqual(f.octopus, 0);
  assert.strictEqual(f.other, 1417); // Backlog 1000 + Other 417
  assert.strictEqual(f.electric, 500);
  assert.strictEqual(f.salary, 3000, '15 open days at the seeded ₱200');
  assert.strictEqual(f.split, 3000, 'the Settings default, NOT the residual');
  assert.strictEqual(f.per_partner, 1500);
  assert.strictEqual(f.remaining, -2000, 'the residual, negative and unclamped');
  // Accounting identity
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining);
  // Exact note text
  assert.strictEqual(res.data.note_text, SPEC_NOTE);
});

test('Remaining is shown, never clamped: a good cutoff reads "Remaining"', () => {
  const { ctx, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  // The owner deletes the big Supplies expense (it belonged to the next cutoff).
  let r = post(ctx, { token, action: 'deleteExpense', payload: { entryId: 'exp-1' } });
  assert.strictEqual(r.ok, true, r.error);
  r = post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-01', end: '2025-07-15', dryRun: true } });
  assert.strictEqual(r.ok, true, r.error);
  const f = r.data.figures;
  assert.strictEqual(f.supplies, 0);
  assert.strictEqual(f.remaining, 3440, '−2,000 + the 5,440 that left');
  assert.strictEqual(f.split, 3000, 'Split is entered, so it does NOT absorb the difference');
  assert.strictEqual(r.data.note_text, SPEC_NOTE
    .replace('Supplies - 5,440', 'Supplies - ')
    .replace('Short - 2,000', 'Remaining - 3,440'));
});

// ---------------------------------------------------------------------------
console.log('\n--- 3. Cutoffs upsert by (start, end) — finding (d) ---');

test('replaying non-dryRun cutoff does NOT duplicate the archive row', () => {
  const { ctx, ss, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  const payload = { start: '2025-07-01', end: '2025-07-15', dryRun: false };
  const r1 = post(ctx, { token, action: 'cutoff', payload });
  const r2 = post(ctx, { token, action: 'cutoff', payload }); // retry/replay
  assert.strictEqual(r1.ok, true, r1.error);
  assert.strictEqual(r2.ok, true, r2.error);
  const cut = ss.getSheetByName('Cutoffs');
  assert.strictEqual(cut.getDataRange().getValues().length - 1, 1, 'expected exactly 1 Cutoffs data row');
});

test('regenerating after new data UPDATES the same row in place', () => {
  const { ctx, ss, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-01', end: '2025-07-15', dryRun: false } });
  // A late expense changes the figures; regenerate.
  post(ctx, {
    token, action: 'saveExpense',
    payload: { date: '2025-07-14', category: 'Octopus', item: 'bulk', amount: 800, backlogRef: '', notes: '', entryId: 'exp-late' }
  });
  const r = post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-01', end: '2025-07-15', dryRun: false } });
  assert.strictEqual(r.ok, true, r.error);
  const rows = ss.getSheetByName('Cutoffs').getDataRange().getValues();
  assert.strictEqual(rows.length - 1, 1, 'still exactly 1 row for the period');
  assert.strictEqual(rows[1][9], 800, 'octopus column updated in place');
  assert.strictEqual(rows[1][6], 3000, 'split is ENTERED, so a late expense cannot move it');
  // The residual is what moved, and the archived note says so.
  assert.strictEqual(r.data.figures.remaining, -2800);
  assert.match(rows[1][12], /\nShort - 2,800$/, 'the archived note text was rewritten too');
});

test('a different period still APPENDS a new row', () => {
  const { ctx, ss, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-01', end: '2025-07-15', dryRun: false } });
  post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-16', end: '2025-07-31', dryRun: false } });
  const cut = ss.getSheetByName('Cutoffs');
  assert.strictEqual(cut.getDataRange().getValues().length - 1, 2, 'two periods -> two rows');
});

test('dryRun never writes to Cutoffs', () => {
  const { ctx, ss, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-01', end: '2025-07-15', dryRun: true } });
  const cut = ss.getSheetByName('Cutoffs');
  assert.strictEqual(cut.getDataRange().getValues().length - 1, 0);
});

// ---------------------------------------------------------------------------
console.log('\n--- 4. reqDate calendar validation — finding (c) ---');

test('valid dates pass; impossible dates are rejected', () => {
  const { ctx } = load();
  const ok = ['2026-01-01', '2026-12-31', '2026-02-28', '2024-02-29', '2000-02-29', '2026-04-30'];
  ok.forEach(d => assert.strictEqual(ctx.reqDate(d, 'date'), d, d + ' should be accepted'));

  const bad = [
    '2026-13-05',  // month 13
    '2026-00-10',  // month 0
    '2026-02-31',  // Feb 31
    '2026-02-29',  // not a leap year
    '1900-02-29',  // century non-leap
    '2026-04-31',  // April has 30
    '2026-01-00',  // day 0
    '2026-01-32',  // day 32
    '2026-1-05',   // shape
    '05-01-2026',  // shape
    ''             // shape
  ];
  bad.forEach(d => {
    assert.throws(() => ctx.reqDate(d, 'date'), /must be a yyyy-MM-dd string|not a real calendar date/, d + ' should be rejected');
  });
});

test('cutoff with month 13 is rejected before any archive write', () => {
  const { ctx, ss, token } = freshSetup();
  const r = post(ctx, { token, action: 'cutoff', payload: { start: '2026-13-05', end: '2026-13-15', dryRun: false } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not a real calendar date/);
  const cut = ss.getSheetByName('Cutoffs');
  assert.strictEqual(cut.getDataRange().getValues().length - 1, 0, 'nothing archived');
});

test('saveDay with 2026-02-31 is rejected', () => {
  const { ctx, token } = freshSetup();
  const r = post(ctx, {
    token, action: 'saveDay',
    payload: { date: '2026-02-31', closed: true, staff: '', gcash: 0, customAmount: 0, notes: '', counts: [], entryId: 'x1' }
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not a real calendar date/);
});

// ---------------------------------------------------------------------------
console.log('\n--- 5. setupSheet: file timezone + whole-column "@" — finding (b) ---');

test('setupSheet sets the spreadsheet FILE timezone to Asia/Manila', () => {
  const { ss } = freshSetup();
  assert.strictEqual(ss.getSpreadsheetTimeZone(), 'Asia/Manila');
});

test('"@" format is applied as WHOLE-COLUMN (A:A-style) ranges on every textCol', () => {
  const { ss } = freshSetup();
  const expected = {
    Settings: [2], DailyLog: [1, 10], DailyCounts: [1],
    Expenses: [1, 8], Backlogs: [4], Cutoffs: [1, 2, 14]
  };
  Object.keys(expected).forEach(tab => {
    const sh = ss.getSheetByName(tab);
    expected[tab].forEach(col => {
      assert.strictEqual(sh.columnFormats[col], '@',
        tab + ' col ' + col + ' must have a column-level (unbounded) "@" format');
    });
    // and it was applied via a wholeColumn range, not a bounded one
    const fmtOps = sh.log.filter(e => e.op === 'setNumberFormat' && e.fmt === '@');
    assert.ok(fmtOps.length >= expected[tab].length && fmtOps.every(e => e.wholeColumn),
      tab + ': every "@" format op must target a whole column');
  });
});

test('re-running setupSheet never resets an edited stock unit — or resurrects a deleted row', () => {
  // The seeded units are the thing you OPEN (pack/gallon), but the owner may
  // still change one — and setupSheet is run by hand after every release, so it
  // must not touch existing rows. PIN MOVED (v2.5.0, deliberate): row seeds now
  // run ONLY when the tab is CREATED, so a row the owner deleted on purpose
  // stays deleted instead of reappearing on every release.
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(post(ctx, {
    token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Takoyaki Sauce', unit: 'jug', reorderAt: 2, active: true }] }
  }).ok, true);
  deleteFirstColRow(ss, 'StockItems', 'Togarashi'); // and he dropped one he never uses

  ctx.setupSheet();

  const rows = ss.getSheetByName('StockItems').getDataRange().getValues().slice(1);
  const sauce = rows.find(r => r[0] === 'Takoyaki Sauce');
  assert.deepStrictEqual([sauce[1], sauce[6]], ['jug', 2], "the owner's edit must survive");
  assert.strictEqual(rows.filter(r => r[0] === 'Takoyaki Sauce').length, 1, 'no duplicate row');
  assert.strictEqual(rows.filter(r => r[0] === 'Togarashi').length, 0,
    'a row he deleted on purpose must STAY deleted — seeds belong to tab creation only');
});

test('setupSheet is idempotent (re-run keeps token, no duplicate seeds)', () => {
  const { ctx, ss, token } = freshSetup();
  const token2 = ctx.setupSheet();
  assert.strictEqual(token2, token, 'token must survive a re-run');
  const settings = ss.getSheetByName('Settings').getDataRange().getValues();
  const keys = settings.slice(1).map(r => r[0]);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate settings keys');
  const prices = ss.getSheetByName('Prices').getDataRange().getValues();
  assert.strictEqual(prices.length - 1, 4,
    'still exactly 4 seed prices (box4/6/10 + nori, no drinks)');
  const bl = ss.getSheetByName('Backlogs').getDataRange().getValues();
  assert.strictEqual(bl.length - 1, 8, 'still exactly 8 seed backlogs after re-run');
});

// ---------------------------------------------------------------------------
console.log("\n--- 5b. Backlog seeds (owner's real obligations) ---");

test('setupSheet seeds the 8 backlogs with correct names and amounts', () => {
  const { ss } = freshSetup();
  const rows = ss.getSheetByName('Backlogs').getDataRange().getValues().slice(1);
  const got = rows.map(r => [String(r[0]), Number(r[2])]);
  assert.deepStrictEqual(got, [
    ['Takoyaki Flour', 2538], ['Takoyaki Sauce', 114], ['Ref', 6700],
    ['Deposit Nayt', 7500], ['Deposit Lou', 7500], ['Deposit Mama', 7000],
    ['Deposit Ilog Nayt', 40000], ['Deposit Ilog Mama', 10000]
  ]);
  assert.strictEqual(got.reduce((s, r) => s + r[1], 0), 81352, 'total outstanding');
  rows.forEach(r => assert.strictEqual(r[4], true, 'seeded backlogs must be active'));
});

test('bootstrap exposes each backlog balance, reduced by Backlog-category payments', () => {
  const { ctx, token } = freshSetup();
  let r = post(ctx, {
    token, action: 'saveExpense',
    payload: { date: '2026-07-20', category: 'Backlog', item: 'hulog', amount: 700,
      backlogRef: 'Ref', notes: '', entryId: 'bl-pay-1' }
  });
  assert.strictEqual(r.ok, true, r.error);
  r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  const byName = {};
  r.data.backlogs.forEach(b => { byName[b.name] = b; });
  assert.strictEqual(byName['Ref'].balance, 6000, 'Ref: 6,700 - 700 paid');
  assert.strictEqual(byName['Ref'].paid, 700);
  assert.strictEqual(byName['Deposit Ilog Nayt'].balance, 40000, 'untouched backlog unchanged');
});

test('a partly-paid balance is never reset by re-running setupSheet', () => {
  const { ctx, ss, token } = freshSetup();
  post(ctx, {
    token, action: 'saveExpense',
    payload: { date: '2026-07-20', category: 'Backlog', item: 'hulog', amount: 2538,
      backlogRef: 'Takoyaki Flour', notes: '', entryId: 'bl-pay-2' }
  });
  ss.getSheetByName('Backlogs').getRange(2, 3).setValue(1000); // owner edits the total
  ctx.setupSheet();
  const rows = ss.getSheetByName('Backlogs').getDataRange().getValues().slice(1);
  assert.strictEqual(rows.length, 8, 'no duplicate rows appended');
  assert.strictEqual(Number(rows[0][2]), 1000, "owner's edited amount preserved");
});

// ---------------------------------------------------------------------------
console.log('\n--- 6. bootstrap ships numeric settings as numbers — finding (e) ---');

test('mama_per_cutoff / electric_per_cutoff are numbers even when cells hold strings', () => {
  const { ctx, ss, token } = freshSetup();
  // The "@"-formatted Settings column stores everything as text in real
  // Sheets; force that worst case explicitly.
  const sh = ss.getSheetByName('Settings');
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][0] === 'mama_per_cutoff') sh.getRange(i + 1, 2).setValue('500');
    if (vals[i][0] === 'electric_per_cutoff') sh.getRange(i + 1, 2).setValue('500');
  }
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(typeof r.data.settings.mama_per_cutoff, 'number');
  assert.strictEqual(r.data.settings.mama_per_cutoff, 500);
  assert.strictEqual(typeof r.data.settings.electric_per_cutoff, 'number');
  assert.strictEqual(r.data.settings.electric_per_cutoff, 500);
  assert.strictEqual(r.data.settings.token, undefined, 'token never echoed');
});

// ---------------------------------------------------------------------------
console.log('\n--- 7. DailyCounts rewrite at grid-capacity boundary — finding (a) ---');

// Helpers for the boundary simulation ---------------------------------------

function dateFor(i) {
  // Distinct valid yyyy-MM-dd strings: day i of a synthetic calendar.
  const y = 2020 + Math.floor(i / 336);
  const m = 1 + (Math.floor(i / 28) % 12);
  const d = 1 + (i % 28);
  const p = n => (n < 10 ? '0' : '') + n;
  return y + '-' + p(m) + '-' + p(d);
}

/** Fill DailyCounts with `n` synthetic data rows for OTHER dates. */
function fillCounts(ss, n) {
  const sh = ss.getSheetByName('DailyCounts');
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([dateFor(i), 'box' + (4 + (i % 3)), 10, 5, 5, 2, 3, 300, 'seed-' + i]);
  }
  if (n > 0) {
    // Grow the fake grid first if the seed itself would not fit (setup-only).
    const need = n + 1;
    if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    sh.getRange(2, 1, n, 9).setValues(rows);
  }
  sh.log.length = 0; // reset op log so tests observe only apiSaveDay's ops
  return sh;
}

// The production seed ships 3 box skus (no drinks). The grid-capacity tests
// want 4 rows per day, so add a 4th 'simple' sku to the fixture — this also
// covers the owner adding a SKU later.
function addFourthSku(ss) {
  const sh = ss.getSheetByName('Prices');
  const n = sh.getDataRange().getValues().length;
  sh.getRange(n + 1, 1, 1, 7).setValues([['drinks', 'Drinks', 'simple', '', 25, '', true]]);
}

function saveDayWith4Skus(ctx, token, date, ss) {
  if (ss) addFourthSku(ss);
  return post(ctx, {
    token, action: 'saveDay',
    payload: {
      date, closed: false, staff: 'Mama', gcash: 0, customAmount: 0, notes: '',
      counts: [
        { sku: 'box4', sod: 10, eod: 5, cheeseQty: 2 },
        { sku: 'box6', sod: 10, eod: 6, cheeseQty: 1 },
        { sku: 'box10', sod: 8, eod: 4, cheeseQty: 0 },
        { sku: 'drinks', sod: 12, eod: 2 }
      ],
      entryId: 'boundary-day'
    }
  });
}

function countsRowsFor(sh, date) {
  return sh.getDataRange().getValues().slice(1).filter(r => r[0] === date);
}

function nonEmptyDataRows(sh) {
  return sh.getDataRange().getValues().slice(1).filter(r => r.some(c => c !== '' && c !== null));
}

function runBoundaryCase(existingOthers, label) {
  const { ctx, ss, token } = freshSetup();
  const sh = fillCounts(ss, existingOthers);
  assert.strictEqual(sh.getMaxRows(), Math.max(1000, existingOthers + 1), 'precondition grid size');

  const res = saveDayWith4Skus(ctx, token, '2026-07-30', ss);
  assert.strictEqual(res.ok, true, label + ': saveDay must succeed, got: ' + res.error);

  const finalRows = nonEmptyDataRows(sh);
  assert.strictEqual(finalRows.length, existingOthers + 4,
    label + ': all ' + existingOthers + ' old rows + 4 new rows must survive');
  assert.strictEqual(countsRowsFor(sh, '2026-07-30').length, 4, label + ': 4 rows for the saved date');

  // No other date lost a row
  const seedRows = finalRows.filter(r => String(r[8]).indexOf('seed-') === 0);
  assert.strictEqual(seedRows.length, existingOthers, label + ': every seed row intact');

  // Ordering guarantee: the block setValues happens BEFORE any clearContent,
  // and any clearContent starts strictly BELOW the written block.
  const ops = sh.log.filter(e => e.op === 'setValues' || e.op === 'clearContent');
  const firstWrite = ops.findIndex(e => e.op === 'setValues');
  const firstClear = ops.findIndex(e => e.op === 'clearContent');
  assert.ok(firstWrite !== -1, label + ': a block setValues must occur');
  if (firstClear !== -1) {
    assert.ok(firstClear > firstWrite, label + ': setValues must precede clearContent');
    const written = ops[firstWrite];
    ops.filter(e => e.op === 'clearContent').forEach(e => {
      assert.ok(e.r0 >= written.r0 + written.nRows,
        label + ': clearContent (row ' + e.r0 + ') must be below the written block');
    });
  }
  return { ss, sh, ctx, token };
}

test('999 data rows total (995 existing + 4 new): fits the 1000-row grid, no insert', () => {
  const { sh } = runBoundaryCase(995, '999-case');
  assert.strictEqual(sh.getMaxRows(), 1000, 'no grid growth needed');
  assert.ok(!sh.log.some(e => e.op === 'insertRowsAfter'), 'no insertRowsAfter expected');
});

test('1000 data rows total (996 existing + 4 new): grid grows by exactly 1 row', () => {
  const { sh } = runBoundaryCase(996, '1000-case');
  assert.strictEqual(sh.getMaxRows(), 1001, 'grid grown 1000 -> 1001');
  const ins = sh.log.filter(e => e.op === 'insertRowsAfter');
  assert.strictEqual(ins.length, 1);
  assert.strictEqual(ins[0].howMany, 1);
});

test('1001 data rows total (997 existing + 4 new): grid grows by exactly 2 rows', () => {
  const { sh } = runBoundaryCase(997, '1001-case');
  assert.strictEqual(sh.getMaxRows(), 1002, 'grid grown 1000 -> 1002');
  const ins = sh.log.filter(e => e.op === 'insertRowsAfter');
  assert.strictEqual(ins.length, 1);
  assert.strictEqual(ins[0].howMany, 2);
});

test('re-saving an existing date at capacity: surplus rows below block are cleared', () => {
  // 1000 data rows exist (996 others + 4 for our date); re-save the same date
  // with only 3 skus -> 999 kept; the 1 surplus row must be cleared and no
  // other date touched.
  const { ctx, ss, token } = freshSetup();
  const sh = fillCounts(ss, 996);
  let r = saveDayWith4Skus(ctx, token, '2026-07-30', ss); // brings table to 1000 rows, grid to 1001
  assert.strictEqual(r.ok, true, r.error);
  sh.log.length = 0;

  r = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', gcash: 0, customAmount: 0, notes: '',
      counts: [
        { sku: 'box4', sod: 10, eod: 5, cheeseQty: 2 },
        { sku: 'box6', sod: 10, eod: 6, cheeseQty: 1 },
        { sku: 'box10', sod: 8, eod: 4, cheeseQty: 0 }
      ],
      entryId: 'boundary-day-v2'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(nonEmptyDataRows(sh).length, 999, '996 seeds + 3 new lines');
  assert.strictEqual(countsRowsFor(sh, '2026-07-30').length, 3, 'old 4-sku block replaced by 3');
  const clears = sh.log.filter(e => e.op === 'clearContent');
  assert.strictEqual(clears.length, 1, 'exactly one surplus clear');
  assert.strictEqual(clears[0].r0, 1001, 'clears only the single row below the 999-row block');
  assert.strictEqual(clears[0].nRows, 1);
});

test('closed day with existing counts: block rewritten without this date, surplus cleared', () => {
  const { ctx, ss, token } = freshSetup();
  const sh = fillCounts(ss, 50);
  let r = saveDayWith4Skus(ctx, token, '2026-07-30', ss);
  assert.strictEqual(r.ok, true, r.error);
  r = post(ctx, {
    token, action: 'saveDay',
    payload: { date: '2026-07-30', closed: true, staff: 'Mama', gcash: 999, customAmount: 5, notes: '', counts: [{ sku: 'box4', sod: 1, eod: 0 }], entryId: 'closed-1' }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 0, 'closed day total 0');
  assert.strictEqual(countsRowsFor(sh, '2026-07-30').length, 0, 'no counts rows for a closed day');
  assert.strictEqual(nonEmptyDataRows(sh).length, 50, 'other dates untouched');
});

test('crash between setValues and clearContent loses NOTHING (only stale surplus remains)', () => {
  const { ctx, ss, token } = freshSetup();
  const sh = fillCounts(ss, 100);
  let r = saveDayWith4Skus(ctx, token, '2026-07-30', ss);
  assert.strictEqual(r.ok, true, r.error);

  // Simulate the quota-kill: the next save's clearContent throws.
  const RealRangeProto = Object.getPrototypeOf(sh.getRange(1, 1, 1, 1));
  const origClear = RealRangeProto.clearContent;
  RealRangeProto.clearContent = function () { throw new Error('SIMULATED CRASH'); };
  try {
    r = post(ctx, {
      token, action: 'saveDay',
      payload: {
        date: '2026-07-30', closed: false, staff: 'Mama', gcash: 0, customAmount: 0, notes: '',
        counts: [{ sku: 'box4', sod: 9, eod: 3, cheeseQty: 1 }],
        entryId: 'crash-day'
      }
    });
  } finally {
    RealRangeProto.clearContent = origClear;
  }
  assert.strictEqual(r.ok, false, 'the request itself fails');
  // The FULL new table (100 seeds + 1 new line) was already written before the
  // crash; the only residue is stale duplicate rows below it — never a wipe.
  const rows = nonEmptyDataRows(sh);
  const seeds = rows.filter(x => String(x[8]).indexOf('seed-') === 0);
  assert.ok(seeds.length >= 100, 'all 100 seed rows still present (history intact)');
  assert.ok(countsRowsFor(sh, '2026-07-30').some(x => x[8] === 'crash-day'), 'new line written');
});

test('regression guard: without insertRowsAfter the old code WOULD have thrown at 1000 rows', () => {
  // Sanity-check that the stub really reproduces the failure mode the fix
  // targets: a 1000-row block starting at row 2 of a 1000-row grid throws.
  const sh = new FakeSheet('X', 1000);
  assert.throws(() => sh.getRange(2, 1, 1000, 9), /dimensions of the range are invalid/);
});

// ---------------------------------------------------------------------------
console.log('\n--- 8. Idempotency / no regressions ---');

test('replaying the same saveDay does not duplicate DailyLog or DailyCounts rows', () => {
  const { ctx, ss, token } = freshSetup();
  const r1 = saveDayWith4Skus(ctx, token, '2026-07-30', ss);
  const r2 = saveDayWith4Skus(ctx, token, '2026-07-30'); // exact replay
  assert.strictEqual(r1.ok, true, r1.error);
  assert.strictEqual(r2.ok, true, r2.error);
  const logRows = ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .filter(r => r[0] === '2026-07-30');
  assert.strictEqual(logRows.length, 1, 'one DailyLog row per date');
  assert.strictEqual(countsRowsFor(ss.getSheetByName('DailyCounts'), '2026-07-30').length, 4);
  assert.deepStrictEqual(r1.data, r2.data, 'replay returns identical computed result');
});

test('saveDay computed figures: price snapshot, cheese split, cash = total - gcash', () => {
  const { ctx, ss, token } = freshSetup();
  const r = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 50, customGcash: 50, notes: '',
      // sold 6: 2 cheese @60 + 4 reg @50 = 320, and 1 of the 4 regular was GCash
      counts: [{ sku: 'box4', sod: 10, eod: 4, cheeseQty: 2, gcashQty: 1 }],
      entryId: 'figures-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 370); // 320 + 50 custom
  assert.strictEqual(r.data.gcash, 100); // 1 GCash box @50 + 50 custom GCash
  assert.strictEqual(r.data.cash, 270);  // 370 - 100 gcash
  assert.deepStrictEqual(r.data.lines, [{
    sku: 'box4', sold: 6, cheese_qty: 2, gcash_qty: 1, gcash_cheese_qty: 0,
    regular_qty: 3, amount: 320, gcash_amount: 50,
    // Every line says whether its money counted, so the receipt never has to
    // guess from a price list the phone may not have synced yet.
    in_cutoff: true,
    // ...and the prices the money was computed from (v2.5.0), completing the
    // snapshot the amounts began.
    price: 50, cheese_price: 60
  }]);
  assert.strictEqual(r.data.excluded_total, 0,
    'a day with nothing excluded still answers the key, so the phone never guesses');
  const row = countsRowsFor(ss.getSheetByName('DailyCounts'), '2026-07-30')[0];
  assert.strictEqual(row[7], 320, 'amount snapshotted on the row');
  assert.strictEqual(row[11], 50, 'gcash_amount snapshotted on the row');
});

test('replaying the same saveExpense does not duplicate rows', () => {
  const { ctx, ss, token } = freshSetup();
  const payload = { date: '2026-07-30', category: 'Supplies', item: 'flour', amount: 250, backlogRef: '', notes: '', entryId: 'exp-same' };
  post(ctx, { token, action: 'saveExpense', payload });
  post(ctx, { token, action: 'saveExpense', payload });
  const rows = ss.getSheetByName('Expenses').getDataRange().getValues().slice(1)
    .filter(r => r[6] === 'exp-same');
  assert.strictEqual(rows.length, 1);
});

test('saveDay validations still enforced (EOD<=SOD, cheese<=sold, buckets<=sold)', () => {
  const { ctx, token } = freshSetup();
  const base = { date: '2026-07-30', closed: false, staff: '', customAmount: 0, notes: '', entryId: 'v' };
  let r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { counts: [{ sku: 'box4', sod: 3, eod: 5, cheeseQty: 0 }] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /EOD .* cannot be greater than SOD/);
  r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { counts: [{ sku: 'box4', sod: 5, eod: 3, cheeseQty: 4 }] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /cheese qty .* cannot exceed sold/);
  // The three entered buckets must not add up to more than what was sold.
  r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { counts: [{ sku: 'box4', sod: 5, eod: 3, cheeseQty: 1, gcashQty: 1, gcashCheeseQty: 1 }] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /adds up to 3, but only 2 were sold/);
  // The GCash part of a custom order cannot be bigger than the custom order.
  r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { customAmount: 100, customGcash: 150, counts: [] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /GCash part of the custom order .* cannot be more than/);
  // Negative quantities are rejected before anything is written.
  r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { counts: [{ sku: 'box4', sod: 5, eod: 3, gcashQty: -1 }] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /GCash qty cannot be negative/);
});

test('invalid token rejected; doGet ping needs no token', () => {
  const { ctx, token } = freshSetup();
  const r = post(ctx, { token: 'wrong', action: 'ping', payload: {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Invalid token/);
  const g = JSON.parse(ctx.doGet({}).getContent());
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.data.name, 'octogo-api');
  // The release gate. This literal moves with VERSION in Code.gs deliberately:
  // both the ping and the More screen report it, and it is the only way anyone
  // can answer "is the sheet running the new code yet?" — which matters here
  // because the deploy is automatic while setupSheet() is run by hand.
  assert.strictEqual(g.data.version, '2.5.1', 'VERSION was not bumped for this release');
  assert.strictEqual(post(ctx, { token, action: 'ping', payload: {} }).data.version, '2.5.1');
});

// ---------------------------------------------------------------------------
console.log('\n--- 9. Live-sheet migration: append only, never reorder ---');

function makeTab(ss, name, headers, rows) {
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows && rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return sh;
}

const OLD_LOG_HEADERS = ['date', 'closed', 'staff', 'gcash', 'total', 'cash', 'custom_amount', 'notes', 'entry_id', 'updated_at'];
const OLD_COUNT_HEADERS = ['date', 'sku', 'sod', 'eod', 'sold', 'cheese_qty', 'regular_qty', 'amount', 'entry_id'];
const OLD_LOG_ROW = ['2026-07-20', false, 'Mama', 300, 1045, 745, 250, 'party tray', 'old-day-1', '2026-07-20 21:00:00'];
const OLD_COUNT_ROWS = [
  ['2026-07-20', 'box4', 10, 0, 10, 2, 8, 520, 'old-day-1'],
  ['2026-07-20', 'box6', 6, 2, 4, 1, 3, 275, 'old-day-1']
];

/** The owner's sheet as v2.0.0 left it, WITH data: 10-column DailyLog,
 *  9-column DailyCounts, no SupplyItems/DailySupplies/StockItems/StockUsage,
 *  an existing token and a hand-edited Box 4 price. */
function legacySpreadsheet() {
  const ss = new FakeSpreadsheet();
  makeTab(ss, 'Settings', ['key', 'value'], [
    ['token', 'legacy-token-123'],
    ['branch', 'Tañong'],
    ['mama_per_cutoff', 500],
    ['electric_per_cutoff', 500],
    ['partners', 'Nayt, Partner'],
    ['staff', 'Mama']
  ]);
  makeTab(ss, 'Prices', ['sku', 'label', 'group', 'size', 'price', 'cheese_price', 'active'], [
    ['box4', 'Box 4', 'box', 4, 55, 60, true], // owner raised the Box 4 price
    ['box6', 'Box 6', 'box', 6, 65, 80, true],
    ['box10', 'Box 10', 'box', 10, 105, 125, true]
  ]);
  makeTab(ss, 'DailyLog', OLD_LOG_HEADERS, [OLD_LOG_ROW]);
  makeTab(ss, 'DailyCounts', OLD_COUNT_HEADERS, OLD_COUNT_ROWS);
  makeTab(ss, 'Expenses', ['date', 'category', 'item', 'amount', 'backlog_ref', 'notes', 'entry_id', 'updated_at'], [
    ['2026-07-18', 'Supplies', 'flour', 300, '', '', 'old-exp-1', '2026-07-18 20:00:00']
  ]);
  makeTab(ss, 'Backlogs', ['name', 'description', 'total_amount', 'start_date', 'active'], [
    ['Ref', '', 6700, '', true]
  ]);
  makeTab(ss, 'Cutoffs', ['start', 'end', 'total', 'cash', 'gcash', 'mama', 'split', 'per_partner',
    'supplies', 'octopus', 'other', 'electric', 'note_text', 'generated_at'], []);
  return ss;
}

/** Every tab's full contents — for byte-for-byte before/after comparisons. */
function snapshot(ss) {
  const out = {};
  Object.keys(ss.sheets).sort().forEach(n => { out[n] = ss.getSheetByName(n).getDataRange().getValues(); });
  return out;
}

const LEGACY_TOKEN = 'legacy-token-123';

test('a pre-change sheet still READS correctly before setupSheet is re-run', () => {
  // Code is auto-deployed on push; setupSheet() is run by hand. In between, the
  // sheet legitimately lags the code — nothing may throw or zero out.
  const { ctx } = load(legacySpreadsheet());
  const r = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  const box4 = r.data.counts.find(c => c.sku === 'box4');
  assert.strictEqual(box4.cheese_qty, 2, '9-column history must still read its cheese split');
  assert.strictEqual(box4.regular_qty, 8);
  assert.strictEqual(box4.amount, 520);
  assert.strictEqual(box4.gcash_qty, 0, 'a missing column reads as 0, i.e. "it was all cash"');
  assert.strictEqual(box4.gcash_amount, 0);
  const day = r.data.days[0];
  assert.strictEqual(day.total, 1045);
  assert.strictEqual(day.gcash, 300, 'the historical GCash figure is left exactly as it was');
  assert.strictEqual(day.custom_gcash, 0);
  // A pre-v2.3.0 row has no salary cell. An OPEN day counts at the current rate
  // (the seeded ₱200 when Settings has no daily_salary yet) — never 0, which
  // would understate the very first cutoff after the deploy.
  assert.strictEqual(day.salary, 200);
  assert.deepStrictEqual(r.data.stockItems, [], 'no StockItems tab yet -> empty list, not a crash');
  assert.deepStrictEqual(r.data.stockUsage, []);
  assert.deepStrictEqual(r.data.stockCounts, []);
  assert.deepStrictEqual(r.data.cutoffInputs, []);
  assert.strictEqual(r.data.settings.daily_salary, 200, 'the default is stated, not left blank');
  assert.strictEqual(r.data.settings.split_default, 3000);
});

test('setupSheet APPENDS the new columns and moves nothing', () => {
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  const token = ctx.setupSheet();
  assert.strictEqual(token, LEGACY_TOKEN, 'the live token must survive the migration');

  const counts = ss.getSheetByName('DailyCounts').getDataRange().getValues();
  assert.deepStrictEqual(counts[0],
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price']),
    'new DailyCounts columns must be appended to the RIGHT, in schema order');
  assert.deepStrictEqual(counts[1].slice(0, 9), OLD_COUNT_ROWS[0], 'existing cells must not shift');
  assert.deepStrictEqual(counts[2].slice(0, 9), OLD_COUNT_ROWS[1]);
  // A blank in the three GCash cells means "that day was all cash"; a blank
  // in_cutoff means "this row predates the snapshot" and READS TRUE (its money
  // was inside the totals when saved); blank price cells fall back to the
  // current Prices tab. None may be written as a 0 or a FALSE by the migration.
  assert.deepStrictEqual(counts[1].slice(9), ['', '', '', '', '', ''], 'new cells start blank');

  const log = ss.getSheetByName('DailyLog').getDataRange().getValues();
  assert.deepStrictEqual(log[0], OLD_LOG_HEADERS.concat(['custom_gcash', 'salary', 'excluded_total']));
  assert.deepStrictEqual(log[1].slice(0, 10), OLD_LOG_ROW);
  // PIN MOVED (v2.5.0, deliberate): the migration BACKFILLS the salary cell of
  // every non-closed row with the current daily_salary — before it, those rows
  // were resolved at the LIVE rate on every read, so a later rate change
  // silently re-priced history. custom_gcash and excluded_total stay blank.
  assert.deepStrictEqual(log[1].slice(10), ['', 200, ''],
    'salary backfilled at the current rate; the other new cells start blank, not 0');

  const exp = ss.getSheetByName('Expenses').getDataRange().getValues();
  assert.deepStrictEqual(exp[0], ['date', 'category', 'item', 'amount', 'backlog_ref',
    'notes', 'entry_id', 'updated_at', 'stock_product', 'stock_qty']);
  assert.deepStrictEqual(exp[1].slice(0, 8),
    ['2026-07-18', 'Supplies', 'flour', 300, '', '', 'old-exp-1', '2026-07-18 20:00:00']);

  const prices = ss.getSheetByName('Prices').getDataRange().getValues();
  assert.deepStrictEqual(prices[0], ['sku', 'label', 'group', 'size', 'price', 'cheese_price',
    'active', 'in_cutoff'], 'in_cutoff must be APPENDED to the right of active');
  assert.strictEqual(prices[1][4], 55, "the owner's edited Box 4 price must survive");
  assert.strictEqual(prices[1][7], '',
    'every EXISTING price row keeps a BLANK in_cutoff — which must read TRUE');
  // PIN MOVED (v2.5.0, deliberate): row seeds run only when the tab is CREATED,
  // so migrating a live Prices tab adds NO nori row — a sku the owner never set
  // up must not appear because a release happened. His real sheet already has
  // nori; a fresh sheet still gets it (see the freshSetup tests).
  assert.strictEqual(prices.length - 1, 3, 'the three live rows, untouched, and nothing seeded');
  assert.strictEqual(prices.slice(1).find(x => x[0] === 'nori'), undefined,
    'no nori row is planted into a tab that already existed');
});

test('setupSheet creates and seeds the stock + cutoff tabs', () => {
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  ctx.setupSheet();

  // The unit is the thing you OPEN, not a weight — that is what makes usage
  // countable in whole units like the boxes.
  const st = ss.getSheetByName('StockItems').getDataRange().getValues();
  assert.deepStrictEqual(st[0],
    ['product', 'unit', 'active', 'sort', 'opening_qty', 'opening_date', 'reorder_at']);
  assert.deepStrictEqual(st.slice(1).map(r => [r[0], r[1]]), [
    ['Takoyaki Flour', 'pack'], ['Takoyaki Sauce', 'gallon'], ['Japanese Mayo', 'pack'],
    ['Bonito', 'pack'], ['Aonori', 'pack'], ['Togarashi', 'pack']
  ]);
  // Baseline 0 with a BLANK date, and no reorder threshold until he sets one.
  st.slice(1).forEach(r => assert.deepStrictEqual(r.slice(4, 7), [0, '', ''],
    'the baseline is seeded empty: he sets it with "Correct the count"'));

  assert.deepStrictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues()[0],
    ['date', 'product', 'qty', 'entry_id', 'updated_at']);
  assert.deepStrictEqual(ss.getSheetByName('StockCounts').getDataRange().getValues()[0],
    ['date', 'product', 'counted_qty', 'entry_id', 'updated_at']);
  assert.deepStrictEqual(ss.getSheetByName('CutoffInputs').getDataRange().getValues()[0],
    ['start', 'end', 'split_amount', 'entry_id', 'updated_at']);
  // Newly appended/created date + timestamp columns get the plain-text format.
  assert.strictEqual(ss.getSheetByName('StockUsage').columnFormats[1], '@');
  assert.strictEqual(ss.getSheetByName('StockCounts').columnFormats[1], '@');
  assert.strictEqual(ss.getSheetByName('StockCounts').columnFormats[5], '@');
  assert.strictEqual(ss.getSheetByName('StockItems').columnFormats[6], '@',
    'opening_date is a yyyy-MM-dd string, so it must be plain text too');
  assert.strictEqual(ss.getSheetByName('CutoffInputs').columnFormats[1], '@');
  assert.strictEqual(ss.getSheetByName('CutoffInputs').columnFormats[2], '@');

  // The retired tabs are NOT created on a sheet that never had them: nothing
  // reads or writes them, and a tab that looks live but is dead is a trap.
  assert.strictEqual(ss.getSheetByName('SupplyItems'), null);
  assert.strictEqual(ss.getSheetByName('DailySupplies'), null);
});

test('a live sheet KEEPS its retired supplies tabs (migration never deletes)', () => {
  const ss = legacySpreadsheet();
  // His v2.2.0 sheet has both tabs, with rows in them.
  makeTab(ss, 'SupplyItems', ['item', 'active', 'sort'], [['Veggies', true, 1]]);
  makeTab(ss, 'DailySupplies', ['date', 'item', 'amount', 'entry_id', 'updated_at'], [
    ['2026-07-20', 'Veggies', 120, 'old-day-1', '2026-07-20 21:00:00']
  ]);
  const before = JSON.stringify(snapshot(ss).DailySupplies);
  const { ctx } = load(ss);
  ctx.setupSheet();

  assert.strictEqual(JSON.stringify(snapshot(ss).DailySupplies), before,
    'the retired tab must be left exactly as it is — migration never deletes');
  assert.strictEqual(ss.getSheetByName('SupplyItems').getDataRange().getValues().length - 1, 1);

  // ...and its rows no longer count anywhere.
  const r = post(ctx, {
    token: LEGACY_TOKEN, action: 'cutoff',
    payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true }
  });
  assert.strictEqual(r.ok, true, r.error);
  // The period holds one Supplies EXPENSE of ₱300 and one dead DailySupplies row
  // of ₱120. Only the expense counts now.
  assert.strictEqual(r.data.figures.supplies, 300,
    'the ₱120 in DailySupplies must NOT reach the Supplies line any more');
  const boot = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.dailySupplies, undefined, 'bootstrap must not ship a dead collection');
  assert.strictEqual(boot.data.supplyItems, undefined);
});

test('migrating an already-migrated sheet changes NOTHING (byte-for-byte)', () => {
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  ctx.setupSheet();
  const before = JSON.stringify(snapshot(ss));
  const token2 = ctx.setupSheet();
  ctx.setupSheet();
  assert.strictEqual(token2, LEGACY_TOKEN);
  assert.strictEqual(JSON.stringify(snapshot(ss)), before, 'setupSheet must be idempotent');
});

test('after migrating, a new day writes the new columns and old rows are untouched', () => {
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  ctx.setupSheet();
  const r = post(ctx, {
    token: LEGACY_TOKEN, action: 'saveDay',
    payload: {
      date: '2026-07-22', closed: false, staff: 'Mama', customAmount: 100, customGcash: 40, notes: '',
      counts: [{ sku: 'box6', sod: 10, eod: 4, cheeseQty: 1, gcashQty: 2, gcashCheeseQty: 1 }],
      entryId: 'new-day-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  // sold 6: 1 cheese + 2 GCash + 1 GCash cheese -> 2 plain regular
  // amount = (2+2)*65 + (1+1)*80 = 260 + 160 = 420 ; gcash = 2*65 + 1*80 = 210
  assert.strictEqual(r.data.lines[0].regular_qty, 2);
  assert.strictEqual(r.data.lines[0].amount, 420);
  assert.strictEqual(r.data.lines[0].gcash_amount, 210);
  assert.strictEqual(r.data.total, 520);          // 420 + 100 custom
  assert.strictEqual(r.data.gcash, 250);          // 210 + 40 custom GCash
  assert.strictEqual(r.data.cash, 270);

  const counts = ss.getSheetByName('DailyCounts').getDataRange().getValues();
  assert.deepStrictEqual(counts[1].slice(0, 9), OLD_COUNT_ROWS[0], 'legacy row still byte-identical');
  assert.deepStrictEqual(counts[2].slice(0, 9), OLD_COUNT_ROWS[1]);
  const fresh = counts.slice(1).find(x => x[0] === '2026-07-22');
  assert.deepStrictEqual(fresh,
    ['2026-07-22', 'box6', 10, 4, 6, 1, 2, 420, 'new-day-1', 2, 1, 210, true, 65, 80],
    'and the in_cutoff + price snapshots are written beside the money they decided');
});

test('saveDay on a not-yet-migrated sheet self-heals instead of failing', () => {
  // GitHub Actions publishes the new Apps Script on push; setupSheet() is
  // manual. Mama must still be able to save that evening.
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  const r = post(ctx, {
    token: LEGACY_TOKEN, action: 'saveDay',
    payload: {
      date: '2026-07-22', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
      counts: [{ sku: 'box6', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 1 }],
      stock: [{ product: 'Bonito', qty: 2 }],
      entryId: 'heal-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 260);
  assert.strictEqual(r.data.gcash, 65);
  assert.strictEqual(r.data.salary, 200, 'the wage is snapshotted even before setupSheet is re-run');
  // The tabs and columns it needed were created/appended on the fly...
  assert.deepStrictEqual(ss.getSheetByName('DailyCounts').getDataRange().getValues()[0],
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price']));
  assert.deepStrictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues()[0],
    OLD_LOG_HEADERS.concat(['custom_gcash', 'salary', 'excluded_total']));
  const healed = ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .find(x => x[0] === '2026-07-22');
  assert.strictEqual(healed[11], 200, 'the salary column was appended and written');
  assert.strictEqual(healed[12], 0, 'excluded_total was appended and written (nothing excluded)');
  assert.strictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues()[1][2], 2);
  // ...and nothing already in the sheet was disturbed.
  assert.deepStrictEqual(ss.getSheetByName('DailyCounts').getDataRange().getValues()[1].slice(0, 9), OLD_COUNT_ROWS[0]);
  assert.deepStrictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues()[1].slice(0, 10), OLD_LOG_ROW);
});

test('a hand-added column is never overwritten: new columns land to its right', () => {
  const ss = legacySpreadsheet();
  const dc = ss.getSheetByName('DailyCounts');
  dc.getRange(1, 10).setValue('owner_note'); // the owner added his own column
  dc.getRange(2, 10).setValue('sobrang ulan');
  const { ctx } = load(ss);
  ctx.setupSheet();

  assert.deepStrictEqual(dc.getDataRange().getValues()[0],
    OLD_COUNT_HEADERS.concat(['owner_note', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price']),
    'new columns must go to the right of everything already there');
  assert.strictEqual(dc.getDataRange().getValues()[1][9], 'sobrang ulan',
    "the owner's column would have been reinterpreted as a GCash quantity");

  const boot = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.counts.find(c => c.sku === 'box4').amount, 520);

  // A save must write the GCash columns in their REAL positions (11-13).
  assert.strictEqual(post(ctx, {
    token: LEGACY_TOKEN, action: 'saveDay',
    payload: {
      date: '2026-07-23', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
      counts: [{ sku: 'box6', sod: 3, eod: 0, gcashQty: 1 }], entryId: 'hand-1'
    }
  }).ok, true);
  const after = dc.getDataRange().getValues();
  assert.deepStrictEqual(after.slice(1).find(x => x[0] === '2026-07-23'),
    ['2026-07-23', 'box6', 3, 0, 3, 0, 2, 195, 'hand-1', '', 1, 0, 65, true, 65, 80]);
  assert.strictEqual(after[1][9], 'sobrang ulan', 'a block rewrite must carry unknown columns through');
});

test('readers map by header NAME, so a reordered column is still read correctly', () => {
  const ss = legacySpreadsheet();
  delete ss.sheets.DailyCounts;
  // Migration never reorders, but a human dragging a column must not turn
  // "amount" into "sod". This is the whole reason readers are name-based.
  makeTab(ss, 'DailyCounts',
    ['amount', 'entry_id', 'date', 'sku', 'sod', 'eod', 'sold', 'cheese_qty', 'regular_qty'],
    [[520, 'old-day-1', '2026-07-20', 'box4', 10, 0, 10, 2, 8]]);
  const { ctx } = load(ss);
  const r = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  const box4 = r.data.counts.find(c => c.sku === 'box4');
  assert.deepStrictEqual(
    { sod: box4.sod, eod: box4.eod, sold: box4.sold, cheese_qty: box4.cheese_qty, amount: box4.amount },
    { sod: 10, eod: 0, sold: 10, cheese_qty: 2, amount: 520 }
  );
});

test('a column the owner added by hand survives an upsert', () => {
  const { ctx, ss, token } = freshSetup();
  const log = ss.getSheetByName('DailyLog');
  const extraCol = log.getDataRange().getValues()[0].length + 1;
  log.getRange(1, extraCol).setValue('mama_remarks');
  const base = {
    date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
    notes: '', counts: [{ sku: 'box4', sod: 5, eod: 0 }], entryId: 'extra-1'
  };
  assert.strictEqual(post(ctx, { token, action: 'saveDay', payload: base }).ok, true);
  log.getRange(2, extraCol).setValue('mabuti ang araw');
  assert.strictEqual(post(ctx, { token, action: 'saveDay', payload: base }).ok, true);
  assert.strictEqual(log.getDataRange().getValues()[1][extraCol - 1], 'mabuti ang araw',
    'an unknown column must not be blanked by an upsert');
});

// ---------------------------------------------------------------------------
console.log('\n--- 10. Four payment/variant buckets + supplies + stock ---');

const BASE_DAY = {
  date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: ''
};
function saveDay(ctx, token, extra) {
  return post(ctx, { token, action: 'saveDay', payload: Object.assign({}, BASE_DAY, extra) });
}

test('the four buckets sum to sold and produce amount + gcash_amount', () => {
  const { ctx, ss, token } = freshSetup();
  const r = saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 3, gcashCheeseQty: 1 }],
    entryId: 'buckets-1'
  });
  assert.strictEqual(r.ok, true, r.error);
  const l = r.data.lines[0];
  assert.strictEqual(l.sold, 10);
  assert.strictEqual(l.regular_qty, 4, 'regular is DERIVED: 10 - 2 - 3 - 1');
  assert.strictEqual(l.cheese_qty + l.gcash_qty + l.gcash_cheese_qty + l.regular_qty, l.sold,
    'the four buckets must sum to sold');
  // amount = (4 regular + 3 gcash) * 50 + (2 cheese + 1 gcash cheese) * 60
  assert.strictEqual(l.amount, 350 + 180);
  assert.strictEqual(l.gcash_amount, 3 * 50 + 1 * 60);
  assert.strictEqual(r.data.total, 530);
  assert.strictEqual(r.data.gcash, 210);
  assert.strictEqual(r.data.cash, 320);
  const row = countsRowsFor(ss.getSheetByName('DailyCounts'), '2026-07-30')[0];
  assert.deepStrictEqual(row.slice(5), [2, 4, 530, 'buckets-1', 3, 1, 210, true, 50, 60],
    'cheese_qty, regular_qty, amount, entry_id, gcash_qty, gcash_cheese_qty, gcash_amount, in_cutoff, price, cheese_price');
});

test('saveDay ignores a client-sent gcash (an old queued payload cannot write it)', () => {
  const { ctx, ss, token } = freshSetup();
  const r = saveDay(ctx, token, {
    gcash: 5000, // what a phone queued before this release still carries
    counts: [{ sku: 'box4', sod: 5, eod: 0, cheeseQty: 0 }],
    entryId: 'old-queue-1'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 250);
  assert.strictEqual(r.data.gcash, 0, 'GCash must come from the buckets only');
  assert.strictEqual(r.data.cash, 250);
  const row = ss.getSheetByName('DailyLog').getDataRange().getValues()[1];
  assert.strictEqual(row[3], 0, 'the bogus figure must not reach the sheet');
});

test('group=simple splits payment but has no cheese', () => {
  const { ctx, ss, token } = freshSetup();
  addFourthSku(ss); // drinks: group=simple, 25
  let r = saveDay(ctx, token, {
    counts: [{ sku: 'drinks', sod: 12, eod: 2, gcashQty: 4 }],
    entryId: 'simple-1'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.lines[0].amount, 250);
  assert.strictEqual(r.data.lines[0].gcash_amount, 100);
  assert.strictEqual(r.data.lines[0].regular_qty, 6);
  r = saveDay(ctx, token, {
    counts: [{ sku: 'drinks', sod: 12, eod: 2, cheeseQty: 1 }],
    entryId: 'simple-2'
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /has no cheese version/);
  r = saveDay(ctx, token, {
    counts: [{ sku: 'drinks', sod: 12, eod: 2, gcashCheeseQty: 1 }],
    entryId: 'simple-3'
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /has no cheese version/);
});

test('a queued `supplies` array is IGNORED and writes no dead tab', () => {
  // The nightly supplies card is retired. A phone that queued a saveDay before
  // the update still carries the old array; writing it would resurrect a tab
  // nothing reads and quietly re-create the double-counting hazard.
  const { ctx, ss, token } = freshSetup();
  const r = saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0 }],
    supplies: [{ item: 'Veggies', amount: 120 }, { item: 'Egg', amount: 80 }],
    entryId: 'sup-ignored'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 200, 'the sales half of the day is unaffected');
  assert.strictEqual(ss.getSheetByName('DailySupplies'), null, 'no dead tab created');
  assert.strictEqual(ss.getSheetByName('SupplyItems'), null);
  assert.ok(!Object.prototype.hasOwnProperty.call(r.data, 'supplies_total'),
    'a figure that can only ever answer 0 is worse than no figure at all');
});

test('stock usage is WHOLE UNITS OPENED: a fraction is refused in plain English', () => {
  const { ctx, ss, token } = freshSetup();
  let r = saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0 }],
    stock: [{ product: 'Takoyaki Sauce', qty: 1 }, { product: 'Bonito', qty: 0 }],
    entryId: 'stk-1'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 200, 'stock never adds to the day total');
  assert.deepStrictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1)
    .map(x => [x[1], x[2]]), [['Takoyaki Sauce', 1]], 'a zero product gets no row');

  // If a gallon is opened, it counts as used that day. Half a gallon is not a
  // thing you can open.
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Takoyaki Sauce', qty: 0.5 }], entryId: 'stk-frac' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /whole unit/, 'the message must say what to do, not "NaN"');
  assert.match(r.error, /Takoyaki Sauce/, 'and which product it is about');
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Bonito', qty: 2.0001 }], entryId: 'stk-frac2' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /whole unit/);
  // A whole number written as a string is still whole.
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Bonito', qty: '3' }], entryId: 'stk-str' });
  assert.strictEqual(r.ok, true, r.error);

  // Advisory picklist (D1): an unlisted product is accepted, not refused.
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Wasabi', qty: 1 }], entryId: 'stk-2' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 0, 'and it is still not money');
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Bonito', qty: -1 }], entryId: 'stk-3' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /quantity cannot be negative/);
  r = saveDay(ctx, token, { counts: [], stock: [{ product: ' ', qty: 1 }], entryId: 'stk-4' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /missing its product name/);
});

test('re-saving a date rewrites only that date in StockUsage (write, then clear surplus)', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-29', counts: [],
    stock: [{ product: 'Bonito', qty: 1 }, { product: 'Aonori', qty: 2 }, { product: 'Togarashi', qty: 3 }],
    entryId: 'a'
  }).ok, true);
  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-30', counts: [],
    stock: [{ product: 'Japanese Mayo', qty: 4 }, { product: 'Takoyaki Flour', qty: 5 }],
    entryId: 'b'
  }).ok, true);
  const sh = ss.getSheetByName('StockUsage');
  assert.strictEqual(sh.getDataRange().getValues().length - 1, 5);
  sh.log.length = 0;

  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-29', counts: [], stock: [{ product: 'Bonito', qty: 9 }], entryId: 'a2'
  }).ok, true);

  const rows = sh.getDataRange().getValues().slice(1).filter(r => r.some(c => c !== '' && c !== null));
  assert.strictEqual(rows.length, 3, "2026-07-29's 3 rows became 1; the other date keeps its 2");
  assert.deepStrictEqual(rows.filter(r => r[0] === '2026-07-29').map(r => [r[1], r[2]]), [['Bonito', 9]]);
  assert.deepStrictEqual(rows.filter(r => r[0] === '2026-07-30').map(r => [r[1], r[2]]),
    [['Japanese Mayo', 4], ['Takoyaki Flour', 5]], 'another date must never be touched');
  const ops = sh.log.filter(e => e.op === 'setValues' || e.op === 'clearContent');
  const firstWrite = ops.findIndex(e => e.op === 'setValues');
  const firstClear = ops.findIndex(e => e.op === 'clearContent');
  assert.ok(firstWrite !== -1 && firstClear > firstWrite, 'setValues must precede clearContent');
  assert.ok(ops[firstClear].r0 >= ops[firstWrite].r0 + ops[firstWrite].nRows,
    'the clear must start strictly below the written block');
});

test('a closed day clears that date\'s stock too, and costs no salary', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-29', counts: [], stock: [{ product: 'Bonito', qty: 5 }], entryId: 'keep'
  }).ok, true);
  assert.strictEqual(saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 5, eod: 0 }], stock: [{ product: 'Bonito', qty: 5 }], entryId: 'wipe-me'
  }).ok, true);
  const r = saveDay(ctx, token, { closed: true, counts: [], stock: [{ product: 'Bonito', qty: 5 }], entryId: 'closed-day' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 0);
  assert.strictEqual(r.data.salary, 0, 'nobody worked, so the day costs nothing');
  const stk = ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1).filter(x => x[0] === '2026-07-30');
  assert.strictEqual(stk.length, 0);
  // the other date is untouched
  assert.strictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1)
    .filter(x => x[0] === '2026-07-29').length, 1);
  const log = ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .find(x => x[0] === '2026-07-30');
  assert.strictEqual(log[11], 0, 'the stored snapshot is 0, not a blank that later reads as ₱200');
});

test('replaying a saveDay with stock does not duplicate rows', () => {
  const { ctx, ss, token } = freshSetup();
  const payload = {
    counts: [{ sku: 'box4', sod: 5, eod: 0, gcashQty: 1 }],
    stock: [{ product: 'Bonito', qty: 5 }],
    entryId: 'replay-1'
  };
  const r1 = saveDay(ctx, token, payload);
  const r2 = saveDay(ctx, token, payload);
  assert.strictEqual(r1.ok, true, r1.error);
  assert.deepStrictEqual(r1.data, r2.data, 'replay returns identical computed result');
  assert.strictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues().length - 1, 1);
  assert.strictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues().length - 1, 1);
});

test('bootstrap returns stockItems with computed on-hand, stockUsage and stockCounts', () => {
  const { ctx, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, {
    counts: [], stock: [{ product: 'Bonito', qty: 5 }], entryId: 'boot-1'
  }).ok, true);
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.stockItems.length, 6);
  assert.deepStrictEqual(r.data.stockItems[0].product, 'Takoyaki Flour');
  assert.deepStrictEqual(r.data.stockUsage.map(x => [x.date, x.product, x.qty]), [['2026-07-30', 'Bonito', 5]]);
  assert.deepStrictEqual(r.data.stockCounts, [], 'no stocktake yet, but the key is always there');
  // Same window as counts: a stock row for a date with no DailyLog row is
  // outside the window and is not shipped.
  assert.ok(r.data.stockUsage.every(x => r.data.days.some(d => d.date === x.date)));
  // The retired collections are gone, not empty: the phone must not keep a
  // reader for a tab that stopped counting.
  assert.strictEqual(r.data.supplyItems, undefined);
  assert.strictEqual(r.data.dailySupplies, undefined);
});

test('cutoff Supplies is Expenses(Supplies) ALONE — nothing else can inflate it', () => {
  const { ctx, token } = freshSetup();
  seedSpecPeriod(ctx, token); // total 11,857 / gcash 1,327 / Supplies expense 5,440
  // The owner's phone still queues the retired daily-supplies rows, and the day
  // also opens stock. NEITHER may touch the Supplies line.
  assert.strictEqual(saveDay(ctx, token, {
    date: '2025-07-03', customAmount: 6000, customGcash: 1000, counts: [],
    supplies: [{ item: 'Veggies', amount: 200 }, { item: 'Egg', amount: 100 }],
    stock: [{ product: 'Takoyaki Flour', qty: 2 }],
    entryId: 'day-2025-07-03'
  }).ok, true);
  assert.strictEqual(saveDay(ctx, token, {
    date: '2025-07-10', customAmount: 5857, customGcash: 327, counts: [],
    supplies: [{ item: 'Fare', amount: 60 }], entryId: 'day-2025-07-10'
  }).ok, true);

  const r = post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-01', end: '2025-07-15', dryRun: true } });
  assert.strictEqual(r.ok, true, r.error);
  const f = r.data.figures;
  assert.strictEqual(f.supplies, 5440, 'ONLY the Expenses(Supplies) rows');
  assert.strictEqual(f.total, 11857);
  assert.strictEqual(f.salary, 3000, 're-saving two days must not change the salary total');
  assert.strictEqual(f.remaining, -2000);
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining,
    'the accounting identity must still hold');
  // The note is byte-identical to the sample: nothing leaked in.
  assert.strictEqual(r.data.note_text, SPEC_NOTE);
});

// ---------------------------------------------------------------------------
// 11. B1 — the migration's APPEND POINT.
//
// Reproduced on the owner's live sheet: a legacy 9-column DailyCounts whose
// column J holds his own notes with J1 (the header cell) blank. Counting only
// NAMED headers made J the append point, so "gcash_qty" was written into J1 and
// from that moment every reader read his notes as GCash quantities. The append
// point must clear every OCCUPIED column, named or not.
// ---------------------------------------------------------------------------
console.log('\n--- 11. Migration append point: an OCCUPIED column is never claimed ---');

/** The owner's live sheet, with his own data in DailyCounts!J under a BLANK J1.
 *  One row holds a NUMBER (trays he had left over) and one holds text: the
 *  numeric one is the dangerous case, because claiming the column makes it
 *  survive coercion and become a GCash quantity, i.e. money. */
function sheetWithUnnamedDataColumn() {
  const ss = legacySpreadsheet();
  const dc = ss.getSheetByName('DailyCounts');
  dc.getRange(2, 10).setValue(3);                     // his own figure, box4 row
  dc.getRange(3, 10).setValue('kulang ang harina');   // his note, box6 row
  return ss;
}

test('B1: a column holding data under a BLANK header keeps its header blank', () => {
  const ss = sheetWithUnnamedDataColumn();
  const dc = ss.getSheetByName('DailyCounts');
  const { ctx } = load(ss);
  ctx.setupSheet();

  const v = dc.getDataRange().getValues();
  assert.deepStrictEqual(v[0],
    OLD_COUNT_HEADERS.concat(['', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price']),
    'the new columns must be appended BEYOND every occupied column, so J1 stays blank');
  assert.deepStrictEqual([v[1][9], v[2][9]], [3, 'kulang ang harina'],
    "the owner's own column was claimed and its values relabelled as a GCash quantity");
  assert.deepStrictEqual(v[1].slice(0, 9), OLD_COUNT_ROWS[0], 'and nothing else shifted');
  assert.deepStrictEqual(v[2].slice(0, 9), OLD_COUNT_ROWS[1]);
});

test('B1: his notes are never READ as GCash quantities, and money is unchanged', () => {
  const ss = sheetWithUnnamedDataColumn();
  const { ctx } = load(ss);
  ctx.setupSheet();
  const r = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  const box4 = r.data.counts.find(c => c.sku === 'box4');
  assert.strictEqual(box4.gcash_qty, 0,
    "his own figure (3) was read as a GCash quantity — that is money he never took by GCash");
  assert.strictEqual(box4.gcash_cheese_qty, 0);
  assert.strictEqual(box4.gcash_amount, 0);
  assert.strictEqual(box4.amount, 520, 'the historical amount must not move');
  assert.strictEqual(box4.cheese_qty, 2);
  assert.strictEqual(r.data.days[0].total, 1045);
});

test('B1: a later save writes the GCash columns in their REAL positions', () => {
  const ss = sheetWithUnnamedDataColumn();
  const dc = ss.getSheetByName('DailyCounts');
  const { ctx } = load(ss);
  ctx.setupSheet();
  const r = post(ctx, {
    token: LEGACY_TOKEN, action: 'saveDay',
    payload: {
      date: '2026-07-23', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
      counts: [{ sku: 'box6', sod: 3, eod: 0, gcashQty: 1 }], entryId: 'b1-save'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  const v = dc.getDataRange().getValues();
  // gcash_qty / gcash_cheese_qty / gcash_amount live in columns 11-13 here, the
  // in_cutoff snapshot in 14, and the price snapshot in 15-16.
  assert.deepStrictEqual(v.slice(1).find(x => x[0] === '2026-07-23'),
    ['2026-07-23', 'box6', 3, 0, 3, 0, 2, 195, 'b1-save', '', 1, 0, 65, true, 65, 80]);
  assert.strictEqual(v[1][9], 3, 'a block rewrite must carry the unnamed column through');
  assert.strictEqual(v[2][9], 'kulang ang harina');
});

test('B1: append beyond a STRAY value too, leaving the blank gap alone', () => {
  // A value far to the right with no header and blank columns before it. Blank
  // gap columns are free space and cost nothing; an occupied one must not be
  // claimed however far out it sits.
  const ss = legacySpreadsheet();
  const dc = ss.getSheetByName('DailyCounts');
  dc.getRange(3, 12).setValue('ANO ITO');
  const { ctx } = load(ss);
  ctx.setupSheet();

  const v = dc.getDataRange().getValues();
  assert.deepStrictEqual(v[0].slice(9),
    ['', '', '', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price'],
    'columns 10-12 stay blank-headed; the schema lands at 13-18');
  assert.strictEqual(v[2][11], 'ANO ITO', 'a stray value must not be relabelled either');
  assert.strictEqual(post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} })
    .data.counts.find(c => c.sku === 'box4').amount, 520);
});

// ---------------------------------------------------------------------------
// 12. B2 / D1 — the StockItems picklist is ADVISORY for the DAY'S USAGE.
//
// It used to be enforced like a foreign key, so the moment the owner renamed or
// deleted a picklist row, every day that referenced it became permanently
// un-saveable — INCLUDING its sales — with no way out from the phone.
// (A DELIVERY and a STOCKTAKE are checked, because those move an on-hand
// figure — see section 15.)
// ---------------------------------------------------------------------------
console.log('\n--- 12. Advisory picklist (D1): a renamed product never blocks a day ---');

/** The owner editing his sheet: rename the first-column value of a row. */
function renameFirstCol(ss, tab, from, to) {
  const sh = ss.getSheetByName(tab);
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (v[i][0] === from) { sh.getRange(i + 1, 1).setValue(to); return; }
  }
  throw new Error('precondition: ' + tab + ' has no row "' + from + '"');
}

/** The owner editing his sheet: delete the row whose first column matches. */
function deleteFirstColRow(ss, tab, value) {
  const sh = ss.getSheetByName(tab);
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (v[i][0] === value) { sh.deleteRow(i + 1); return; }
  }
  throw new Error('precondition: ' + tab + ' has no row "' + value + '"');
}

test('B2: a day that references a RENAMED stock product still saves', () => {
  const { ctx, ss, token } = freshSetup();
  // Mama entered the day while the list still said "Bonito"...
  assert.strictEqual(saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0 }],
    stock: [{ product: 'Bonito', qty: 1 }], entryId: 'ren-1'
  }).ok, true);
  // ...then the owner renamed that row in the sheet.
  renameFirstCol(ss, 'StockItems', 'Bonito', 'Bonito Flakes');

  const r = saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0, cheeseQty: 1 }],
    stock: [{ product: 'Bonito', qty: 2 }], entryId: 'ren-1'
  });
  assert.strictEqual(r.ok, true,
    'the whole day — sales included — became un-saveable: ' + r.error);
  assert.strictEqual(r.data.total, 3 * 50 + 60, 'the sales half of the day must be intact');
  assert.deepStrictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1)
    .filter(x => x[0] === '2026-07-30').map(x => [x[1], x[2]]), [['Bonito', 2]],
    'the name the day was entered with is what gets stored');
  assert.strictEqual(ss.getSheetByName('StockItems').getDataRange().getValues().length - 1, 6,
    'accepting a name must NOT silently add it to the list');
});

test('B2: a DELETED stock product still saves; names are trimmed', () => {
  const { ctx, ss, token } = freshSetup();
  deleteFirstColRow(ss, 'StockItems', 'Bonito');
  const r = saveDay(ctx, token, {
    counts: [], stock: [{ product: '  Bonito  ', qty: 2 }], entryId: 'ren-2'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1)
    .map(x => [x[1], x[2]]), [['Bonito', 2]], 'stored trimmed, exactly as entered');
  assert.strictEqual(ss.getSheetByName('StockItems').getDataRange().getValues().length - 1, 5,
    'the list is not extended behind the owner’s back');
});

test('B2: trimmed names still collide, and the other checks still bite', () => {
  const { ctx, token } = freshSetup();
  let r = saveDay(ctx, token, {
    counts: [], stock: [{ product: 'Bonito', qty: 1 }, { product: ' Bonito ', qty: 2 }], entryId: 'ren-4'
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /Duplicate stock rows/);
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Wasabi', qty: -1 }], entryId: 'ren-6' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /quantity cannot be negative/);
});

// ---------------------------------------------------------------------------
// 13. B3 — ONE bootstrap window.
//
// Expenses covered 90 days but days/counts/dailySupplies/stockUsage only the
// last 45 DailyLog ROWS, so the Cutoff screen's back-arrows reached a period
// that had its expenses and none of its sales: the preview showed a loss that
// never happened, and the phone could not tell a missing figure from a zero.
// ---------------------------------------------------------------------------
console.log('\n--- 13. bootstrap: ONE 90-day window for every collection ---');

/** yyyy-MM-dd, n days before the harness's frozen "now", in Asia/Manila. */
function ymdDaysAgo(n) {
  return formatDate(new Date(FIXED_NOW.getTime() - n * 86400000), TZ_MANILA, 'yyyy-MM-dd');
}

/** Append raw rows under a tab's existing (schema-order) headers. Writing the
 *  history directly keeps this test fast: 61 days through saveDay would be 61
 *  full-sheet read/write cycles. */
function pushRows(ss, name, rows) {
  const sh = ss.getSheetByName(name);
  const at = sh.lastDataRow() + 1;
  sh.getRange(at, 1, rows.length, rows[0].length).setValues(rows);
}

const WINDOW_DAYS = 60;                 // more than the old 45-ROW cap
const IN_WINDOW = [];
for (let i = WINDOW_DAYS; i >= 1; i--) IN_WINDOW.push(ymdDaysAgo(i));
const OUT_OF_WINDOW = ymdDaysAgo(120);  // older than 90 days, so nobody ships it

/** A sheet with 60 days of complete history plus one day outside the window;
 *  every day carries sales, counts, stock usage, a stocktake and an expense. */
function historySpreadsheet() {
  const { ctx, ss, token } = freshSetup();
  const dates = [OUT_OF_WINDOW].concat(IN_WINDOW);
  const stamp = '2026-08-01 20:00:00';
  pushRows(ss, 'DailyLog', dates.map(d => [d, false, 'Mama', 0, 100, 100, 0, '', 'log-' + d, stamp, 0, 200]));
  pushRows(ss, 'DailyCounts', dates.map(d => [d, 'box4', 2, 0, 2, 0, 2, 100, 'log-' + d, 0, 0, 0]));
  pushRows(ss, 'StockUsage', dates.map(d => [d, 'Bonito', 1, 'log-' + d, stamp]));
  pushRows(ss, 'StockCounts', dates.map(d => [d, 'Aonori', 3, 'cnt-' + d, stamp]));
  pushRows(ss, 'Expenses', dates.map(d => [d, 'Supplies', 'harina', 50, '', '', 'exp-' + d, stamp, '', '']));
  return { ctx, ss, token };
}

test('B3: days, counts, stock usage, stocktakes and expenses all cover the SAME window', () => {
  const { ctx, token } = historySpreadsheet();
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);

  assert.deepStrictEqual(r.data.days.map(d => d.date), IN_WINDOW,
    'every day inside the 90-day window must ship, in date order');
  assert.strictEqual(r.data.days.length, WINDOW_DAYS,
    'the old cap was the last 45 ROWS, so the 15 oldest days went missing');
  ['counts', 'stockUsage', 'stockCounts', 'expenses'].forEach(k => {
    assert.deepStrictEqual(r.data[k].map(x => x.date), IN_WINDOW,
      k + ' covers a different window than days — a cutoff preview would understate a period');
  });
  ['days', 'counts', 'stockUsage', 'stockCounts', 'expenses'].forEach(k => {
    assert.ok(r.data[k].every(x => x.date !== OUT_OF_WINDOW),
      k + ' shipped a row older than the 90-day window');
  });
});

test('B3: the oldest reachable period has its SALES, not just its expenses', () => {
  // The 15 oldest in-window days are exactly the ones the row cap dropped.
  const { ctx, token } = historySpreadsheet();
  const older = IN_WINDOW.slice(0, 15);
  const inOlder = x => older.indexOf(x.date) !== -1;
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });

  const sales = r.data.days.filter(inOlder);
  assert.strictEqual(sales.length, 15, 'the phone cannot preview a period it was never sent');
  assert.strictEqual(sales.reduce((s, d) => s + d.total, 0), 1500, 'sales for that period');
  assert.strictEqual(sales.reduce((s, d) => s + d.salary, 0), 3000, 'and the wages behind them');
  assert.strictEqual(r.data.expenses.filter(inOlder).reduce((s, x) => s + x.amount, 0), 750);
  assert.strictEqual(r.data.counts.filter(inOlder).length, 15);
  assert.strictEqual(r.data.stockUsage.filter(inOlder).length, 15);

  // What the Cutoff screen would compute for that period: Total − everything.
  // With the sales missing it showed a loss that never happened.
  const total = sales.reduce((s, d) => s + d.total, 0);
  const supplies = r.data.expenses.filter(inOlder).reduce((s, x) => s + x.amount, 0);
  const salary = sales.reduce((s, d) => s + d.salary, 0);
  assert.strictEqual(total - supplies - salary, -2250);
});

// On-hand is computed over the WHOLE history, not the shipped window: usage from
// 120 days ago still counts against stock the owner still has.
test('B3: on-hand counts history OLDER than the 90-day window', () => {
  const { ctx, token } = historySpreadsheet();
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  const bonito = r.data.stockItems.find(x => x.product === 'Bonito');
  assert.strictEqual(bonito.used_since, 61, 'all 61 usage rows, window or not');
  assert.strictEqual(bonito.on_hand, -61, 'seeded baseline 0, so it reads honestly negative');
});

// ---------------------------------------------------------------------------
// 14. B4 / D2 — a count row whose sku has left Prices cannot be priced, so the
// save DROPS it and says so in `dropped_skus`. Throwing made the day
// permanently un-saveable the moment the owner deleted or renamed a price row.
// ---------------------------------------------------------------------------
console.log('\n--- 14. dropped_skus (D2): a deleted price never dead-ends a day ---');

test('B4: an unpriceable count row is dropped, REPORTED, and the day still saves', () => {
  const { ctx, ss, token } = freshSetup();
  const counts = [
    { sku: 'box4', sod: 10, eod: 0, cheeseQty: 2 },  // 8*50 + 2*60 = 520
    { sku: 'box6', sod: 6, eod: 2 }                  // sold 4      = 260
  ];
  let r = saveDay(ctx, token, { counts: counts, entryId: 'drop-1' });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.dropped_skus, [], 'nothing is dropped on a normal save');
  assert.strictEqual(r.data.total, 780);

  deleteFirstColRow(ss, 'Prices', 'box6');   // the owner removes Box 6

  r = saveDay(ctx, token, { counts: counts, entryId: 'drop-1' });
  assert.strictEqual(r.ok, true, 'the day must still be saveable: ' + r.error);
  assert.deepStrictEqual(r.data.dropped_skus, ['box6']);
  assert.deepStrictEqual(r.data.lines.map(l => l.sku), ['box4'], 'the unpriceable line is gone');
  assert.strictEqual(r.data.total, 520, 'and its money with it');
  assert.strictEqual(r.data.cash, 520);
  assert.strictEqual(r.data.gcash, 0);
  // The stale row for that date goes too — which is exactly what the phone says.
  assert.deepStrictEqual(countsRowsFor(ss.getSheetByName('DailyCounts'), '2026-07-30').map(x => x[1]),
    ['box4']);
  assert.strictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues()[1][4], 520,
    'the DailyLog total must agree with the lines that survived');
});

test('B4: dropped_skus is deduped and snake_case; a sku-less row is just ignored', () => {
  const { ctx, ss, token } = freshSetup();
  deleteFirstColRow(ss, 'Prices', 'box6');
  deleteFirstColRow(ss, 'Prices', 'box10');
  const r = saveDay(ctx, token, {
    counts: [
      { sku: 'box6', sod: 6, eod: 2 },
      { sku: 'box6', sod: 1, eod: 0 },              // dropped twice, reported once
      { sku: 'box10', sod: 3, eod: 1 },
      { sku: 'box4', sod: 4, eod: 0, gcashQty: 1 }, // 3*50 cash + 1*50 GCash
      { sod: 9, eod: 0 }                            // no sku: nothing to price OR report
    ],
    stock: [{ product: 'Bonito', qty: 1 }],
    entryId: 'drop-2'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.dropped_skus, ['box6', 'box10'], 'once each, in payload order');
  assert.deepStrictEqual(r.data.lines.map(l => l.sku), ['box4']);
  assert.strictEqual(r.data.total, 200);
  assert.strictEqual(r.data.gcash, 50);
  assert.strictEqual(r.data.salary, 200, 'the rest of the day saved normally');
  assert.ok(Object.prototype.hasOwnProperty.call(r.data, 'dropped_skus'),
    'the client reads dropped_skus');
  assert.ok(!Object.prototype.hasOwnProperty.call(r.data, 'droppedSkus'),
    'a camelCase response key arrives as undefined on the phone');
});

test('B4: dropping never masks a real validation error', () => {
  const { ctx, ss, token } = freshSetup();
  deleteFirstColRow(ss, 'Prices', 'box10');
  // A genuine duplicate of a sku that DOES exist is still an error...
  let r = saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0 }, { sku: 'box4', sod: 2, eod: 0 }], entryId: 'drop-3'
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /Duplicate counts for sku "box4"/);
  // ...and so is an impossible count, even alongside a dropped sku.
  r = saveDay(ctx, token, {
    counts: [{ sku: 'box10', sod: 1, eod: 0 }, { sku: 'box4', sod: 2, eod: 5 }], entryId: 'drop-4'
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /EOD \(5\) cannot be greater than SOD \(2\)/);
  // A closed day reports an empty list rather than omitting the key.
  r = saveDay(ctx, token, { closed: true, counts: [{ sku: 'box10', sod: 1, eod: 0 }], entryId: 'drop-5' });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.dropped_skus, []);
});

// ---------------------------------------------------------------------------
// 15. Daily salary — a SNAPSHOT per day, so a rate change never rewrites
// history, and a blank on a pre-v2.3.0 row still costs the current rate.
// ---------------------------------------------------------------------------
console.log('\n--- 15. Daily salary: snapshotted per day ---');

/** Read the salary cell of one date straight out of the sheet, by header name. */
function salaryCellFor(ss, date) {
  const sh = ss.getSheetByName('DailyLog');
  const rows = sh.getDataRange().getValues();
  const col = rows[0].indexOf('salary');
  const row = rows.slice(1).find(r => r[0] === date);
  return row[col];
}
function setSalaryCell(ss, date, value) {
  const sh = ss.getSheetByName('DailyLog');
  const rows = sh.getDataRange().getValues();
  const col = rows[0].indexOf('salary');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === date) { sh.getRange(i + 1, col + 1).setValue(value); return; }
  }
  throw new Error('precondition: no DailyLog row for ' + date);
}

test('saveDay snapshots the CURRENT rate, and a later rate change leaves it alone', () => {
  const { ctx, ss, token } = freshSetup();
  let r = saveDay(ctx, token, { date: '2026-07-20', counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'sal-1' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.salary, 200, 'the seeded daily_salary');
  assert.strictEqual(salaryCellFor(ss, '2026-07-20'), 200);

  // The owner raises the wage half way through the cutoff.
  r = post(ctx, { token, action: 'saveSettings', payload: { settings: { daily_salary: 250 } } });
  assert.strictEqual(r.ok, true, r.error);

  r = saveDay(ctx, token, { date: '2026-07-21', counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'sal-2' });
  assert.strictEqual(r.data.salary, 250, 'the new day costs the new rate');
  assert.strictEqual(salaryCellFor(ss, '2026-07-20'), 200,
    'the day already saved must NOT be rewritten at the new rate');

  r = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(r.data.figures.salary, 450, '200 at the old rate + 250 at the new one');
});

test('a blank salary on a pre-v2.3.0 row counts at the CURRENT rate', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-20', counts: [], entryId: 'sal-3' }).ok, true);
  setSalaryCell(ss, '2026-07-20', ''); // the row as v2.2.0 left it

  let r = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(r.data.figures.salary, 200, 'a blank must never count as ₱0');
  r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.data.days.find(d => d.date === '2026-07-20').salary, 200,
    'the phone is told the same figure the note will use');

  // Change the rate: a BLANK row follows it (there is no snapshot to honour).
  assert.strictEqual(post(ctx, { token, action: 'saveSettings', payload: { settings: { daily_salary: 300 } } }).ok, true);
  r = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(r.data.figures.salary, 300);

  // A pre-v2.3.0 CLOSED day is blank too — and nobody worked, so it is free.
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-21', closed: true, counts: [], entryId: 'sal-3b' }).ok, true);
  setSalaryCell(ss, '2026-07-21', '');
  r = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(r.data.figures.salary, 300, 'a blank on a CLOSED day must stay 0');
  r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.data.days.find(d => d.date === '2026-07-21').salary, 0);
});

test('an explicit salary is honoured, including 0 for a half day off', () => {
  const { ctx, ss, token } = freshSetup();
  let r = saveDay(ctx, token, { date: '2026-07-20', salary: 100, counts: [], entryId: 'sal-4' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.salary, 100, 'a half day is entered, not derived');
  r = saveDay(ctx, token, { date: '2026-07-21', salary: 0, counts: [], entryId: 'sal-5' });
  assert.strictEqual(r.data.salary, 0);
  assert.strictEqual(salaryCellFor(ss, '2026-07-21'), 0,
    'a real 0 must be STORED, not left blank to be re-inflated later');

  r = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(r.data.figures.salary, 100, 'the 0 day adds nothing');

  r = saveDay(ctx, token, { date: '2026-07-22', salary: -5, counts: [], entryId: 'sal-6' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /salary cannot be negative/);
  r = saveDay(ctx, token, { date: '2026-07-22', salary: 'abc', counts: [], entryId: 'sal-7' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /must be a number/);
});

test('a closed day is free, even when the payload insists otherwise', () => {
  const { ctx, token } = freshSetup();
  const r = saveDay(ctx, token, { date: '2026-07-20', closed: true, salary: 200, counts: [], entryId: 'sal-8' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.salary, 0);
  const c = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(c.data.figures.salary, 0);
  assert.match(c.data.note_text, /\nSalary - \n/, 'a zero Salary blanks like the other categories');
});

// ---------------------------------------------------------------------------
// 16. The ENTERED Split (CutoffInputs) — Remaining is the residual now.
// ---------------------------------------------------------------------------
console.log('\n--- 16. Split is entered; Remaining is the residual ---');

const SPLIT_PERIOD = { start: '2026-07-16', end: '2026-07-31' };

function splitFixture() {
  const { ctx, ss, token } = freshSetup();
  // One day: 4 boxes of Box 4 = 200, all cash. One open day = ₱200 salary.
  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-20', counts: [{ sku: 'box4', sod: 4, eod: 0 }], entryId: 'sp-day'
  }).ok, true);
  return { ctx, ss, token };
}

test('with nothing entered, the cutoff uses the Settings default (3,000 = 1,500 each)', () => {
  const { ctx, token } = splitFixture();
  const r = post(ctx, { token, action: 'cutoff', payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, dryRun: true } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.figures.split, 3000);
  assert.strictEqual(r.data.figures.per_partner, 1500);
  assert.strictEqual(r.data.figures.remaining, 200 - 3000 - 200, 'total − split − salary');
  assert.match(r.data.note_text, /\nSplit - 3,000\(1,500 each\)\n/);
  assert.match(r.data.note_text, /\nShort - 3,000$/);
});

test('changing split_default moves the fallback; an entered amount overrides it', () => {
  const { ctx, ss, token } = splitFixture();
  assert.strictEqual(post(ctx, { token, action: 'saveSettings', payload: { settings: { split_default: 2000 } } }).ok, true);
  let r = post(ctx, { token, action: 'cutoff', payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, dryRun: true } });
  assert.strictEqual(r.data.figures.split, 2000, 'the new default');
  assert.strictEqual(r.data.figures.per_partner, 1000);

  // The owner enters ₱1,000 for THIS cutoff only.
  r = post(ctx, {
    token, action: 'saveCutoffSplit',
    payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, amount: 1000, entryId: 'split-1' }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.split_amount, 1000);
  assert.strictEqual(r.data.per_partner, 500);

  r = post(ctx, { token, action: 'cutoff', payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, dryRun: true } });
  assert.strictEqual(r.data.figures.split, 1000, 'the entered amount wins over the default');
  assert.strictEqual(r.data.figures.per_partner, 500);
  assert.strictEqual(r.data.figures.remaining, 200 - 1000 - 200);
  assert.match(r.data.note_text, /\nSplit - 1,000\(500 each\)\n/);
  assert.match(r.data.note_text, /\nShort - 1,000$/);

  // Another period is NOT affected — it still takes the default.
  r = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-01', end: '2026-07-15', dryRun: true } });
  assert.strictEqual(r.data.figures.split, 2000);

  // Re-entering the same period upserts one row, and bootstrap ships it.
  assert.strictEqual(post(ctx, {
    token, action: 'saveCutoffSplit',
    payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, amount: 1200, entryId: 'split-2' }
  }).ok, true);
  const rows = ss.getSheetByName('CutoffInputs').getDataRange().getValues();
  assert.strictEqual(rows.length - 1, 1, 'the period is the natural key — one row, not two');
  assert.strictEqual(rows[1][2], 1200);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.deepStrictEqual(boot.data.cutoffInputs.map(x => [x.start, x.end, x.split_amount]),
    [[SPLIT_PERIOD.start, SPLIT_PERIOD.end, 1200]]);
});

test('an entered split of 0 blanks the Split line and is not a missing row', () => {
  const { ctx, token } = splitFixture();
  assert.strictEqual(post(ctx, {
    token, action: 'saveCutoffSplit',
    payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, amount: 0, entryId: 'split-0' }
  }).ok, true);
  const r = post(ctx, { token, action: 'cutoff', payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, dryRun: true } });
  assert.strictEqual(r.data.figures.split, 0, '0 must NOT fall back to the default');
  assert.match(r.data.note_text, /\nSplit - \n/);
  assert.strictEqual(r.data.figures.remaining, 0);
  assert.match(r.data.note_text, /\nRemaining - 0$/);
  // A negative split is nonsense and is refused in plain English.
  const bad = post(ctx, {
    token, action: 'saveCutoffSplit',
    payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, amount: -1, entryId: 'split-neg' }
  });
  assert.strictEqual(bad.ok, false); assert.match(bad.error, /cannot be negative/);
});

// ---------------------------------------------------------------------------
// 17. The stock ledger: on hand is COMPUTED (never stored) from a baseline,
// deliveries carried on the expense row that paid for them, and usage.
// ---------------------------------------------------------------------------
console.log('\n--- 17. Stock on hand: baseline + delivered − used ---');

function onHand(ctx, token, product) {
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  return r.data.stockItems.find(x => x.product === product);
}
function useStock(ctx, token, date, product, qty, id) {
  const r = saveDay(ctx, token, { date: date, counts: [], stock: [{ product: product, qty: qty }], entryId: id });
  assert.strictEqual(r.ok, true, r.error);
}
/** The v2.6.0 delivery flow: the QUANTITY through saveStockDelivery (its own
 *  event — the goods arrive on credit), and the MONEY, when the test gives one,
 *  as an ordinary expense with no stock attached (the payment, later). */
function deliver(ctx, token, date, product, qty, amount, id, category) {
  const d = post(ctx, {
    token, action: 'saveStockDelivery',
    payload: { date: date, product: product, qty: qty, entryId: id }
  });
  assert.strictEqual(d.ok, true, d.error);
  if (amount) {
    const r = post(ctx, {
      token, action: 'saveExpense',
      payload: { date: date, category: category || 'Supplies', item: 'delivery paid',
        amount: amount, backlogRef: '', notes: '', entryId: id + '-pay' }
    });
    assert.strictEqual(r.ok, true, r.error);
  }
  return d;
}

/** A LEGACY delivery row — a pre-v2.6.0 expense carrying stock_product /
 *  stock_qty. saveExpense refuses NEW rows like this, so tests write one the
 *  only way it exists in the wild: already sitting in the sheet. Placed by
 *  header name via Code.gs's own appendObjects. */
function legacyDeliver(ctx, ss, date, product, qty, amount, id, category) {
  ctx.appendObjects(ss, 'Expenses', [{
    date: date, category: category || 'Supplies', item: 'delivery (legacy)',
    amount: amount, backlog_ref: '', notes: '', entry_id: id,
    updated_at: '2026-07-01 20:00:00', stock_product: product, stock_qty: qty
  }]);
}

test('a BLANK opening_date counts the WHOLE history, not just today', () => {
  const { ctx, token } = freshSetup();
  // Deliveries and usage from long before anyone thought about stock tracking.
  deliver(ctx, token, '2026-01-05', 'Takoyaki Sauce', 4, 3200, 'deliv-old');
  useStock(ctx, token, '2026-02-10', 'Takoyaki Sauce', 1, 'use-old');
  useStock(ctx, token, '2026-07-30', 'Takoyaki Sauce', 1, 'use-new');

  const it = onHand(ctx, token, 'Takoyaki Sauce');
  assert.strictEqual(it.baseline_date, '', 'the seeded baseline date must stay blank');
  assert.strictEqual(it.baseline_qty, 0);
  assert.strictEqual(it.delivered_since, 4,
    'a blank baseline date coerced to today would silently drop this delivery');
  assert.strictEqual(it.used_since, 2);
  assert.strictEqual(it.on_hand, 2, '0 + 4 delivered − 2 used');
  assert.strictEqual(it.unit, 'gallon', 'the unit is the thing you open');
});

test('on hand may be NEGATIVE before the first stocktake, and is shown as-is', () => {
  const { ctx, token } = freshSetup();
  useStock(ctx, token, '2026-07-30', 'Bonito', 3, 'use-neg');
  const it = onHand(ctx, token, 'Bonito');
  assert.strictEqual(it.on_hand, -3,
    'clamping to 0 would hide exactly the fact that a count is needed');
  assert.strictEqual(it.low, false, 'with no reorder point there is no warning to give');
});

test('a delivery with NO money raises on hand; the LATER payment touches Supplies and never stock', () => {
  const { ctx, token } = freshSetup();
  const before = onHand(ctx, token, 'Takoyaki Flour');
  assert.strictEqual(before.on_hand, 0);

  // The goods arrive first — on credit, so there is no money to log yet.
  const arr = post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'Takoyaki Flour', qty: 10, entryId: 'deliv-1' } });
  assert.strictEqual(arr.ok, true, arr.error);
  assert.strictEqual(arr.data.on_hand, 10, 'the reply already carries the recomputed shelf figure');
  const after = onHand(ctx, token, 'Takoyaki Flour');
  assert.strictEqual(after.delivered_since, 10);
  assert.strictEqual(after.on_hand, 10);

  // NO money moved: the unpaid delivery touches no cutoff figure and no note line.
  let cut = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(cut.data.figures.supplies, 0, 'an unpaid delivery must not appear as money paid');
  assert.strictEqual(cut.data.figures.total, 0);
  assert.match(cut.data.note_text, /\nSupplies - \n/, 'the note line stays blank');

  // The supplier is paid days later: an ORDINARY Supplies expense, money only.
  assert.strictEqual(post(ctx, { token, action: 'saveExpense',
    payload: { date: '2026-07-25', category: 'Supplies', item: 'binayaran ang harina', amount: 2500,
      backlogRef: '', notes: '', entryId: 'deliv-1-pay' } }).ok, true);
  cut = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(cut.data.figures.supplies, 2500, 'the payment is counted once, when it is paid');
  assert.ok(!Object.prototype.hasOwnProperty.call(cut.data.figures, 'stock'));

  // ...and the payment moved NOTHING on the shelf.
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.stockItems.find(x => x.product === 'Takoyaki Flour').on_hand, 10,
    'money leaving is not goods arriving');
  const pay = boot.data.expenses.find(x => x.entry_id === 'deliv-1-pay');
  assert.strictEqual(pay.stock_product, '', 'the payment row carries no stock');
  assert.strictEqual(pay.stock_qty, 0);
  // The delivery ships in its own windowed collection, snake_case rows.
  assert.deepStrictEqual(boot.data.stockDeliveries.map(r => [r.date, r.product, r.qty, r.entry_id]),
    [['2026-07-20', 'Takoyaki Flour', 10, 'deliv-1']]);
});

test('a stocktake becomes the new baseline; that day is already inside it', () => {
  const { ctx, token } = freshSetup();
  deliver(ctx, token, '2026-07-10', 'Aonori', 8, 800, 'deliv-2');
  useStock(ctx, token, '2026-07-11', 'Aonori', 2, 'use-a');
  assert.strictEqual(onHand(ctx, token, 'Aonori').on_hand, 6);

  // He counts on the 12th and finds 5 (one pack spoiled). Same-day activity is
  // already reflected in an end-of-day count, so it must not be added again.
  useStock(ctx, token, '2026-07-12', 'Aonori', 1, 'use-b');
  let r = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-12', product: 'Aonori', qty: 5, entryId: 'count-1' }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.on_hand, 5, 'the count IS the figure, drift absorbed');

  let it = onHand(ctx, token, 'Aonori');
  assert.strictEqual(it.baseline_date, '2026-07-12');
  assert.strictEqual(it.baseline_qty, 5);
  assert.strictEqual(it.delivered_since, 0, 'the 10th is before the baseline');
  assert.strictEqual(it.used_since, 0, "the 12th's own usage is inside the count");
  assert.strictEqual(it.on_hand, 5);

  // Life after the count carries on from there.
  useStock(ctx, token, '2026-07-13', 'Aonori', 2, 'use-c');
  deliver(ctx, token, '2026-07-14', 'Aonori', 3, 300, 'deliv-3');
  it = onHand(ctx, token, 'Aonori');
  assert.deepStrictEqual([it.baseline_qty, it.delivered_since, it.used_since, it.on_hand], [5, 3, 2, 6]);

  // A LATER count wins over the earlier one...
  assert.strictEqual(post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-14', product: 'Aonori', qty: 99, entryId: 'count-2' }
  }).ok, true);
  assert.strictEqual(onHand(ctx, token, 'Aonori').on_hand, 99);
  // ...and a second count on the SAME day replaces it (he recounted).
  const again = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-14', product: 'Aonori', qty: 7, entryId: 'count-3' }
  });
  assert.strictEqual(again.data.on_hand, 7);
  assert.strictEqual(onHand(ctx, token, 'Aonori').on_hand, 7);
});

test('a count is upserted by entry_id, and only ever one baseline per replay', () => {
  const { ctx, ss, token } = freshSetup();
  const payload = { date: '2026-07-12', product: 'Bonito', qty: 4, entryId: 'count-replay' };
  const r1 = post(ctx, { token, action: 'saveStockCount', payload });
  const r2 = post(ctx, { token, action: 'saveStockCount', payload });
  assert.strictEqual(r1.ok, true, r1.error);
  assert.deepStrictEqual(r1.data, r2.data, 'a replay must return the same figure');
  assert.strictEqual(ss.getSheetByName('StockCounts').getDataRange().getValues().length - 1, 1);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.deepStrictEqual(boot.data.stockCounts.map(c => [c.date, c.product, c.counted_qty]),
    [['2026-07-12', 'Bonito', 4]]);
});

test('a backdated count still lands on the arithmetic, not on the number typed', () => {
  const { ctx, token } = freshSetup();
  deliver(ctx, token, '2026-07-20', 'Togarashi', 6, 600, 'deliv-4');
  useStock(ctx, token, '2026-07-21', 'Togarashi', 1, 'use-d');
  // He remembers he counted 2 on the 15th and enters it late.
  const r = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-15', product: 'Togarashi', qty: 2, entryId: 'count-back' }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.on_hand, 7, '2 counted + 6 delivered − 1 used, not the 2 he typed');
});

test('the reorder warning fires at or below the threshold, never without one', () => {
  const { ctx, token } = freshSetup();
  let r = post(ctx, {
    token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Bonito', unit: 'pack', reorderAt: 2, active: true }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  deliver(ctx, token, '2026-07-20', 'Bonito', 5, 500, 'deliv-5');
  assert.strictEqual(onHand(ctx, token, 'Bonito').low, false, '5 on hand, threshold 2');

  useStock(ctx, token, '2026-07-21', 'Bonito', 3, 'use-e');
  let it = onHand(ctx, token, 'Bonito');
  assert.strictEqual(it.on_hand, 2);
  assert.strictEqual(it.low, true, 'AT the threshold counts as low');
  assert.strictEqual(it.reorder_at, 2, 'the threshold reaches the phone');

  // A product with no threshold never warns, however low it goes.
  useStock(ctx, token, '2026-07-22', 'Aonori', 9, 'use-f');
  assert.strictEqual(onHand(ctx, token, 'Aonori').low, false);
});

test('deliveries and counts are CHECKED against the product list, unlike usage', () => {
  const { ctx, token } = freshSetup();
  // A typo here would credit a product that never shows up anywhere.
  let r = post(ctx, {
    token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'Bonitoo', qty: 2, entryId: 'bad-1' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /no stock product called "Bonitoo"/);
  // A quantity with nothing named is meaningless.
  r = post(ctx, {
    token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', qty: 2, entryId: 'bad-2' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /which product arrived/);
  r = post(ctx, {
    token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'Bonito', qty: -1, entryId: 'bad-3' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /cannot be negative/);
  // An ordinary expense with neither is completely normal.
  r = post(ctx, {
    token, action: 'saveExpense',
    payload: { date: '2026-07-20', category: 'Other', item: 'load', amount: 100, entryId: 'plain-1' }
  });
  assert.strictEqual(r.ok, true, r.error);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  const plain = boot.data.expenses.find(x => x.entry_id === 'plain-1');
  assert.strictEqual(plain.stock_product, '');
  assert.strictEqual(plain.stock_qty, 0);

  r = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-20', product: 'Wasabi', qty: 1, entryId: 'bad-4' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /no stock product called "Wasabi"/);
  r = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-20', product: 'Bonito', qty: -1, entryId: 'bad-5' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /cannot be negative/);
});

test('a fractional delivery and a fractional stocktake are refused, like usage', () => {
  // Whole units is a promise about the whole ledger, not about saveDay. All three
  // writers feed the same arithmetic, so a 1.5 accepted at any one of them puts
  // half a gallon on the shelf and contradicts every screen that says otherwise.
  const { ctx, ss, token } = freshSetup();

  // You receive 2 gallons, never 1.5, and the quantity goes straight into on hand.
  let r = post(ctx, {
    token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'Takoyaki Sauce', qty: 1.5, entryId: 'frac-deliv' }
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /whole unit/, 'the same plain English saveDay already uses');
  assert.match(r.error, /Takoyaki Sauce/, 'and which product it is about');
  assert.strictEqual(ss.getSheetByName('StockDeliveries').getDataRange().getValues().length - 1, 0,
    'nothing fractional may land in the tab');

  // A stocktake BECOMES the baseline, so a 2.5 typed here is not one bad row:
  // every on-hand figure for that product carries the half until the next count.
  r = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-20', product: 'Takoyaki Sauce', qty: 2.5, entryId: 'frac-count' }
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /whole unit/);
  assert.match(r.error, /Takoyaki Sauce/);
  assert.strictEqual(ss.getSheetByName('StockCounts').getDataRange().getValues().length - 1, 0);
  assert.strictEqual(onHand(ctx, token, 'Takoyaki Sauce').on_hand, 0,
    'nothing fractional reached the ledger by either door');

  // Whole numbers still go through, including one written as a string.
  deliver(ctx, token, '2026-07-20', 'Takoyaki Sauce', '3', 1600, 'ok-deliv');
  assert.strictEqual(post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-21', product: 'Takoyaki Sauce', qty: '2', entryId: 'ok-count' }
  }).ok, true);
  assert.strictEqual(onHand(ctx, token, 'Takoyaki Sauce').on_hand, 2, 'the count is the baseline');

  // A negative is still answered in its own words, not the fraction message.
  r = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-21', product: 'Bonito', qty: -0.5, entryId: 'neg-count' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /cannot be negative/);
  r = post(ctx, {
    token, action: 'saveStockDelivery',
    payload: { date: '2026-07-21', product: 'Bonito', qty: -0.5, entryId: 'neg-deliv' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /cannot be negative/);
});

// ---------------------------------------------------------------------------
// 18. The Maintenance writers: upsert by natural key, touch nothing else, and
// NEVER the token.
// ---------------------------------------------------------------------------
console.log('\n--- 18. savePrices / saveSettings / saveStockItems ---');

function settingsMap(ss) {
  const out = {};
  ss.getSheetByName('Settings').getDataRange().getValues().slice(1)
    .forEach(r => { if (r[0]) out[r[0]] = r[1]; });
  return out;
}

test('savePrices edits only price/cheese_price/active, and only the listed skus', () => {
  const { ctx, ss, token } = freshSetup();
  const before = ss.getSheetByName('Prices').getDataRange().getValues();
  const r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 55, cheesePrice: 65, active: true }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  const after = ss.getSheetByName('Prices').getDataRange().getValues();
  assert.strictEqual(after.length, before.length, 'no row appended');
  assert.deepStrictEqual(after[1], ['box4', 'Box 4', 'box', 4, 55, 65, true, true],
    'label, group, size and in_cutoff must be left exactly as they were');
  assert.deepStrictEqual(after[2], before[2], 'box6 was not listed, so it must not change');
  assert.deepStrictEqual(after[3], before[3]);
  assert.deepStrictEqual(after[4], before[4], 'and nori keeps its in_cutoff FALSE');

  // A sku the sheet does not have is refused, not invented: a price row also
  // needs a group and a size, and guessing those misprices cheese.
  const bad = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'drinks', price: 25, cheesePrice: 0, active: true }] }
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /no price called "drinks"/);
  assert.strictEqual(ss.getSheetByName('Prices').getDataRange().getValues().length, after.length);

  const neg = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: -1, cheesePrice: 80, active: true }] }
  });
  assert.strictEqual(neg.ok, false); assert.match(neg.error, /cannot be negative/);
});

test('an ACTIVE sku must have a price; only a switched-off one may sit at 0', () => {
  // ₱0 on an item that is still selling is not a price, it is a silent hole:
  // every future day computes that sku at nothing and no screen says why.
  const { ctx, ss, token } = freshSetup();
  const prices = () => ss.getSheetByName('Prices').getDataRange().getValues();
  const before = prices();

  let r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: 0, cheesePrice: 80, active: true }] }
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /box6/, 'the message must name the sku');
  assert.match(r.error, /needs a price/, 'and say plainly what to do about it');

  // A field cleared by accident is the likelier way this happens, and a blank
  // arrives here as 0 — so it must be refused in exactly the same way.
  [{ price: '' }, { price: null }, {}].forEach(patch => {
    const row = Object.assign({ sku: 'box6', cheesePrice: 80, active: true }, patch);
    const bad = post(ctx, { token, action: 'savePrices', payload: { rows: [row] } });
    assert.strictEqual(bad.ok, false,
      'a blank price is a ₱0 price: ' + JSON.stringify(patch));
    assert.match(bad.error, /box6/);
  });
  assert.deepStrictEqual(prices(), before, 'a refused batch writes nothing at all');

  // The whole batch is refused together, so the good row beside it is not applied.
  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 55, cheesePrice: 65, active: true },
                      { sku: 'box10', price: 0, cheesePrice: 125, active: true }] }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /box10/);
  assert.deepStrictEqual(prices(), before, 'box4 must not be half-applied');

  // Switched OFF it sells nothing, so 0 is legitimate — and it stays saveable.
  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: 0, cheesePrice: 0, active: false }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  const row6 = prices().slice(1).find(x => x[0] === 'box6');
  assert.deepStrictEqual([row6[4], row6[5], row6[6]], [0, 0, false]);
  // ...and it is off the phone's list, so nothing can be sold at nothing.
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.prices.find(p => p.sku === 'box6').active, false);

  // A real price on a selling sku is of course still fine.
  assert.strictEqual(post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 55, cheesePrice: 65, active: true }] }
  }).ok, true);
  assert.strictEqual(prices().slice(1).find(x => x[0] === 'box4')[4], 55);
});

test('a price edit applies to FUTURE days only — history keeps its snapshot', () => {
  const { ctx, token } = freshSetup();
  let r = saveDay(ctx, token, { date: '2026-07-20', counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'px-1' });
  assert.strictEqual(r.data.total, 100, '2 x 50 at the old price');
  assert.strictEqual(post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 60, cheesePrice: 70, active: true }] }
  }).ok, true);

  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.days.find(d => d.date === '2026-07-20').total, 100,
    'the stored amount is a snapshot: an old day must never be re-priced');
  assert.strictEqual(boot.data.prices.find(p => p.sku === 'box4').cheese_price, 70,
    'and the new price reaches the phone as cheese_price, not cheesePrice');

  r = saveDay(ctx, token, { date: '2026-07-21', counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'px-2' });
  assert.strictEqual(r.data.total, 120, 'the next day uses the new price');
});

test('saveSettings writes the whitelist, NEVER the token, and ignores the rest', () => {
  const { ctx, ss, token } = freshSetup();
  const before = settingsMap(ss);
  const r = post(ctx, {
    token, action: 'saveSettings',
    payload: { settings: {
      branch: 'Marikina', daily_salary: 250, split_default: 2500,
      mama_per_cutoff: 600, electric_per_cutoff: 550, staff: 'Mama, Ate',
      token: 'hijacked', partners: 'Somebody Else', nonsense: 1
    } }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.saved, ['branch', 'daily_salary', 'electric_per_cutoff',
    'mama_per_cutoff', 'split_default', 'staff']);
  assert.deepStrictEqual(r.data.ignored, ['nonsense', 'partners', 'token'],
    'an unknown key is reported, not written');

  const after = settingsMap(ss);
  assert.strictEqual(after.token, before.token,
    'an API that can rewrite its own secret can lock the owner out of his sheet');
  assert.strictEqual(after.partners, before.partners, 'a key off the whitelist is untouched');
  assert.strictEqual(after.branch, 'Marikina');
  assert.strictEqual(after.daily_salary, 250);
  assert.strictEqual(after.split_default, 2500);
  assert.strictEqual(after.mama_per_cutoff, 600);
  assert.strictEqual(after.staff, 'Mama, Ate');
  assert.strictEqual(ss.getSheetByName('Settings').getDataRange().getValues().length - 1,
    Object.keys(before).length, 'no duplicate rows appended for keys that exist');

  // The old token still authenticates — proof it was not rotated underneath.
  assert.strictEqual(post(ctx, { token, action: 'ping', payload: {} }).ok, true);
  assert.strictEqual(post(ctx, { token: 'hijacked', action: 'ping', payload: {} }).ok, false);

  // And the new figures are what the next cutoff uses.
  const cut = post(ctx, { token, action: 'cutoff', payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true } });
  assert.strictEqual(cut.data.figures.split, 2500);
  assert.match(cut.data.note_text, /^Marikina: July 16 - 31 Breakdown/);
});

test('an inherited property name is not a whitelisted setting or a product', () => {
  // "toString" and "constructor" exist on every plain object, so a lookup that
  // is not hasOwnProperty-guarded reads them as valid — and then writes them.
  const { ctx, ss, token } = freshSetup();
  const before = JSON.stringify(snapshot(ss).Settings);
  let r = post(ctx, {
    token, action: 'saveSettings',
    payload: { settings: { toString: 'x', constructor: 'y', hasOwnProperty: 'z' } }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.saved, [], 'nothing on this payload is settable');
  assert.deepStrictEqual(r.data.ignored, ['constructor', 'hasOwnProperty', 'toString']);
  assert.strictEqual(JSON.stringify(snapshot(ss).Settings), before, 'the tab must be untouched');

  // Same trap on the product lookups a delivery and a stocktake go through.
  r = post(ctx, {
    token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'toString', qty: 1, entryId: 'proto-1' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /no stock product called "toString"/);
  r = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-20', product: 'constructor', qty: 1, entryId: 'proto-2' }
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /no stock product called "constructor"/);
  // ...and on the price lookup, where it would otherwise price a box at NaN.
  r = saveDay(ctx, token, { counts: [{ sku: 'toString', sod: 5, eod: 0 }], entryId: 'proto-3' });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.dropped_skus, ['toString'], 'unpriceable, so dropped and reported');
  assert.strictEqual(r.data.total, 0, 'never a NaN total');
});

test('saveSettings rejects nonsense values and appends a key that is missing', () => {
  const { ctx, ss, token } = freshSetup();
  let r = post(ctx, { token, action: 'saveSettings', payload: { settings: { daily_salary: -1 } } });
  assert.strictEqual(r.ok, false); assert.match(r.error, /cannot be negative/);
  r = post(ctx, { token, action: 'saveSettings', payload: { settings: { split_default: 'lots' } } });
  assert.strictEqual(r.ok, false); assert.match(r.error, /must be a number/);
  r = post(ctx, { token, action: 'saveSettings', payload: { settings: { branch: '  ' } } });
  assert.strictEqual(r.ok, false); assert.match(r.error, /branch name cannot be empty/);
  r = post(ctx, { token, action: 'saveSettings', payload: {} });
  assert.strictEqual(r.ok, false); assert.match(r.error, /settings must be an object/);
  assert.strictEqual(settingsMap(ss).daily_salary, 200, 'a rejected batch changes nothing');

  // A sheet whose Settings tab predates a key gets it appended, once.
  deleteFirstColRow(ss, 'Settings', 'daily_salary');
  assert.strictEqual(settingsMap(ss).daily_salary, undefined);
  assert.strictEqual(post(ctx, { token, action: 'saveSettings', payload: { settings: { daily_salary: 175 } } }).ok, true);
  assert.strictEqual(settingsMap(ss).daily_salary, 175);
  assert.strictEqual(post(ctx, { token, action: 'saveSettings', payload: { settings: { daily_salary: 180 } } }).ok, true);
  const keys = ss.getSheetByName('Settings').getDataRange().getValues().slice(1).map(r2 => r2[0]);
  assert.strictEqual(keys.filter(k => k === 'daily_salary').length, 1, 'appended once, then updated');
});

test('saveStockItems edits unit/reorder point/active and keeps the baseline', () => {
  const { ctx, ss, token } = freshSetup();
  // The owner typed his first stocktake straight into the sheet: 12 packs as of
  // the 1st. That baseline is not the phone's to touch.
  const sh = ss.getSheetByName('StockItems');
  const rows0 = sh.getDataRange().getValues();
  const bonitoRow = rows0.findIndex(x => x[0] === 'Bonito') + 1;
  sh.getRange(bonitoRow, 5).setValue(12);
  sh.getRange(bonitoRow, 6).setValue('2026-07-01');
  const before = sh.getDataRange().getValues();

  const r = post(ctx, {
    token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Bonito', unit: 'box', reorderAt: 3, active: false }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  const after = ss.getSheetByName('StockItems').getDataRange().getValues();
  assert.strictEqual(after.length, before.length, 'no row appended for a product that exists');
  const row = after.slice(1).find(x => x[0] === 'Bonito');
  assert.deepStrictEqual([row[1], row[2], row[6]], ['box', false, 3]);
  assert.deepStrictEqual([row[3], row[4], row[5]], [4, 12, '2026-07-01'],
    'sort, opening_qty and opening_date are not the phone\'s business');
  assert.deepStrictEqual(after.slice(1).find(x => x[0] === 'Aonori'),
    before.slice(1).find(x => x[0] === 'Aonori'), 'an unlisted product must not change');
  // The baseline still stands, and a stocktake still moves it.
  assert.strictEqual(onHand(ctx, token, 'Bonito').on_hand, 12);
  assert.strictEqual(post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-07-12', product: 'Bonito', qty: 4, entryId: 'si-count' }
  }).ok, true);
  assert.strictEqual(onHand(ctx, token, 'Bonito').on_hand, 4);

  // A brand-new product IS created (it carries no money), after the existing six.
  assert.strictEqual(post(ctx, {
    token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Wasabi', unit: 'tub', reorderAt: '', active: true }] }
  }).ok, true);
  const wasabi = ss.getSheetByName('StockItems').getDataRange().getValues().slice(1)
    .find(x => x[0] === 'Wasabi');
  assert.deepStrictEqual(wasabi, ['Wasabi', 'tub', true, 7, 0, '', ''],
    'a new product starts at sort 7 with an empty baseline and no threshold');
  const neg = post(ctx, {
    token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Bonito', unit: 'pack', reorderAt: -2, active: true }] }
  });
  assert.strictEqual(neg.ok, false); assert.match(neg.error, /reorder point cannot be negative/);
});

test('a BLANK reorder point stays blank through a full round trip, never becomes 0', () => {
  const { ctx, ss, token } = freshSetup();
  const cells = () => ss.getSheetByName('StockItems').getDataRange().getValues().slice(1)
    .map(r => [r[0], r[6]]);
  assert.deepStrictEqual(cells().map(x => x[1]), ['', '', '', '', '', ''],
    'the six seeded products start with no threshold at all');

  // (1) What the phone is TOLD. A blank cell coerced to 0 is a DIFFERENT fact:
  // 0 is a real threshold value, and it is what the Maintenance screen then
  // loads into its input and hands straight back.
  let items = post(ctx, { token, action: 'bootstrap', payload: {} }).data.stockItems;
  assert.strictEqual(items.length, 6);
  items.forEach(it => {
    assert.strictEqual(it.reorder_at, '', it.product + ': a blank cell must arrive blank');
    assert.strictEqual(it.low, false, it.product + ': a blank threshold warns about nothing');
  });

  // (2) The round trip the phone actually makes: the owner changes ONE unit and
  // the screen saves the whole list back, echoing every reorder point it was
  // given. A 0 shipped in step 1 is written into six cells he never touched.
  const echo = items.map(it => ({
    product: it.product, unit: it.unit, reorderAt: it.reorder_at, active: it.active
  }));
  echo.find(x => x.product === 'Japanese Mayo').unit = 'bottle';
  const r = post(ctx, { token, action: 'saveStockItems', payload: { rows: echo } });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(cells().map(x => x[1]), ['', '', '', '', '', ''],
    'saving the list back must not write a 0 into every blank cell');
  assert.strictEqual(cells().length, 6, 'and no row was duplicated');

  // (3) A real threshold still round-trips as a NUMBER, so the sheet can still
  // tell "no warning wanted" from "warn me at 2".
  assert.strictEqual(post(ctx, {
    token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Bonito', unit: 'pack', reorderAt: 2, active: true }] }
  }).ok, true);
  assert.deepStrictEqual(cells(), [['Takoyaki Flour', ''], ['Takoyaki Sauce', ''],
    ['Japanese Mayo', ''], ['Bonito', 2], ['Aonori', ''], ['Togarashi', '']],
    'a product that batch never mentioned keeps its blank');
  items = post(ctx, { token, action: 'bootstrap', payload: {} }).data.stockItems;
  assert.strictEqual(items.find(x => x.product === 'Bonito').reorder_at, 2);
  items.forEach(it => assert.strictEqual(it.low, it.product === 'Bonito',
    'only the product with a threshold can be low (0 on hand, warn at 2)'));
});

test('every config writer takes the lock and is a no-op for an empty batch', () => {
  const { ctx, ss, token } = freshSetup();
  const before = JSON.stringify(snapshot(ss));
  ['savePrices', 'saveStockItems'].forEach(action => {
    const r = post(ctx, { token, action, payload: { rows: [] } });
    assert.strictEqual(r.ok, true, action + ': ' + r.error);
    assert.strictEqual(r.data.saved, 0);
  });
  const r = post(ctx, { token, action: 'saveSettings', payload: { settings: {} } });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.saved, []);
  assert.strictEqual(JSON.stringify(snapshot(ss)), before, 'an empty batch must change nothing');
  // A bad shape is refused rather than silently ignored.
  ['savePrices', 'saveStockItems'].forEach(action => {
    const bad = post(ctx, { token, action, payload: { rows: 'nope' } });
    assert.strictEqual(bad.ok, false); assert.match(bad.error, /rows must be an array/);
  });
});

// ---------------------------------------------------------------------------
// 19. v2.4.0 — a sku that is SOLD AND COUNTED but kept OUT of the cutoff.
//
// Nori at ₱25 is the owner's own line of business: he wants it entered like
// anything else, wants to see its total per cutoff, and wants its money out of
// every cutoff figure and out of the note he sends his partner.
//
// The dangerous half of this is not nori. It is `in_cutoff` reading FALSE by
// accident: migration APPENDS the column, so every price row on the live sheet
// has a BLANK cell in it, and a blank that read FALSE would drop box4/box6/box10
// out of the cutoff and collapse the note — with every figure still looking like
// a perfectly good number. The first three tests are about that blank.
// ---------------------------------------------------------------------------
console.log('\n--- 19. Excluded skus: in_cutoff, excluded_total, excluded lines ---');

const NORI_PRICE = 25;

/** A day payload: box4 sold `boxSold`, nori sold `noriSold`. */
function dayWithNori(date, boxSold, noriSold, entryId) {
  return {
    date: date, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [
      { sku: 'box4', sod: boxSold, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 },
      { sku: 'nori', sod: noriSold, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }
    ],
    entryId: entryId
  };
}

function priceCells(ss) {
  return ss.getSheetByName('Prices').getDataRange().getValues();
}

/** Hand-edit one sku's in_cutoff cell, by header NAME (like every reader in
 *  Code.gs, so a column that moved cannot make a test write into the wrong cell
 *  and pass). Some states below can only be reached this way — savePrices
 *  refuses to create them — and a sheet the owner types in himself is exactly
 *  where they come from. */
function setPriceFlag(ss, sku, v) {
  const sh = ss.getSheetByName('Prices');
  const vals = sh.getDataRange().getValues();
  const col = vals[0].indexOf('in_cutoff') + 1;
  assert.ok(col > 0, 'precondition: the Prices tab has an in_cutoff column');
  const row = vals.findIndex(r => r[0] === sku) + 1;
  assert.ok(row > 1, 'precondition: there is a "' + sku + '" price row');
  sh.getRange(row, col).setValue(v);
}

/** Erase every in_cutoff SNAPSHOT in DailyCounts — precisely the state of every
 *  count row written before v2.4.1 appended that column. */
function clearCountFlags(ss) {
  const sh = ss.getSheetByName('DailyCounts');
  const vals = sh.getDataRange().getValues();
  const col = vals[0].indexOf('in_cutoff') + 1;
  assert.ok(col > 0, 'precondition: the DailyCounts tab has an in_cutoff column');
  let cleared = 0;
  for (let i = 2; i <= vals.length; i++) {
    if (String(vals[i - 1][0]) === '') continue;
    assert.notStrictEqual(vals[i - 1][col - 1], '', 'precondition: row ' + i + ' had a snapshot');
    sh.getRange(i, col).setValue('');
    cleared++;
  }
  assert.ok(cleared > 0, 'precondition: there were snapshots to clear');
}

/** savePrices for one sku, spelled out so the tests below read as the owner's
 *  own Maintenance tap rather than a payload. */
function setCutoffFlag(ctx, token, sku, price, cheesePrice, inCutoff) {
  return post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: sku, price: price, cheesePrice: cheesePrice, active: true, inCutoff: inCutoff }] }
  });
}

function cutoffFor(ctx, token, start, end, dryRun) {
  return post(ctx, { token, action: 'cutoff', payload: { start: start, end: end, dryRun: dryRun !== false } });
}

test('a MISSING in_cutoff column counts every sku IN (a sheet not yet migrated)', () => {
  // The live sheet before setupSheet() is re-run: the Prices tab has seven
  // columns and no in_cutoff at all. Code is auto-deployed on push and
  // setupSheet() is manual, so this state happens on EVERY release — and it is
  // the state in which "blank means FALSE" would empty the cutoff.
  const { ctx, ss } = load(legacySpreadsheet());
  assert.deepStrictEqual(priceCells(ss)[0],
    ['sku', 'label', 'group', 'size', 'price', 'cheese_price', 'active'],
    'precondition: this sheet has never heard of in_cutoff');

  const boot = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, boot.error);
  boot.data.prices.forEach(p => assert.strictEqual(p.in_cutoff, true,
    p.sku + ': a sku on a pre-v2.4.0 sheet MUST still count in the cutoff'));

  // ...and the money proves it, not just the flag. Box 4 is 55 on this sheet.
  const r = post(ctx, {
    token: LEGACY_TOKEN, action: 'saveDay',
    payload: {
      date: '2026-07-22', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
      notes: '', counts: [{ sku: 'box4', sod: 10, eod: 0 }], entryId: 'legacy-nori-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 550, 'the day must be worth its sales, not 0');
  assert.strictEqual(r.data.excluded_total, 0, 'nothing on this sheet is excluded');
  assert.strictEqual(r.data.lines[0].in_cutoff, true);

  // The period also contains this sheet's one historical day (1,045), so the
  // cutoff is that plus the day just saved.
  const cut = post(ctx, {
    token: LEGACY_TOKEN, action: 'cutoff',
    payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true }
  });
  assert.strictEqual(cut.ok, true, cut.error);
  assert.strictEqual(cut.data.figures.total, 1045 + 550, 'the cutoff must still see the sales');
  assert.strictEqual(cut.data.figures.excluded, 0);
  assert.deepStrictEqual(cut.data.figures.excluded_lines, []);
  assert.match(cut.data.note_text, /\nTotal - 1,595\n/,
    'the note must not collapse on a sheet that has not been migrated yet');
});

test('a BLANK in_cutoff cell counts IN, and only nori is out', () => {
  // Straight after the migration: the column exists and every EXISTING row's
  // cell is empty. Seeds now belong to tab CREATION only (v2.5.0), so the
  // migration plants no nori row — the owner's live sheet already has one, and
  // this fixture adds it the same way his sheet got it.
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  ctx.setupSheet();
  ss.getSheetByName('Prices').appendRow(['nori', 'Nori', 'simple', '', 25, '', true, false]);
  const rows = priceCells(ss);
  assert.strictEqual(rows[0][7], 'in_cutoff', 'precondition: the column was appended');
  assert.deepStrictEqual(rows.slice(1, 4).map(r => [r[0], r[7]]),
    [['box4', ''], ['box6', ''], ['box10', '']],
    'precondition: every migrated row has an EMPTY in_cutoff cell');
  assert.strictEqual(rows[4][7], false, 'precondition: the nori row says FALSE');

  const boot = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, boot.error);
  const flag = sku => boot.data.prices.find(p => p.sku === sku).in_cutoff;
  assert.strictEqual(flag('box4'), true, 'a BLANK cell is TRUE');
  assert.strictEqual(flag('box6'), true);
  assert.strictEqual(flag('box10'), true);
  assert.strictEqual(flag('nori'), false, 'and only the explicit FALSE is out');

  // Box 4 is 55 on this sheet: 10 boxes = 550 in the cutoff, 12 nori = 300 out.
  const r = post(ctx, {
    token: LEGACY_TOKEN, action: 'saveDay',
    payload: dayWithNori('2026-07-22', 10, 12, 'blank-cell-1')
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 550, 'the boxes with a blank flag are IN');
  assert.strictEqual(r.data.excluded_total, 300, 'and nori alone is out');
});

test('an unrecognised in_cutoff value counts IN, because losing money is worse', () => {
  // A typo in that cell must not silently remove a sku's money from the note.
  // Only an explicitly false-y value takes one out.
  const { ctx, ss, token } = freshSetup();
  const sh = ss.getSheetByName('Prices');
  // By header NAME, like every reader in Code.gs — a column that moved must not
  // make this test quietly write into the wrong cell and pass.
  const colNum = sh.getDataRange().getValues()[0].indexOf('in_cutoff') + 1;
  assert.ok(colNum > 0, 'precondition: the tab has an in_cutoff column');
  const rowOf = sku => sh.getDataRange().getValues().findIndex(r => r[0] === sku) + 1;
  const set = (sku, v) => sh.getRange(rowOf(sku), colNum).setValue(v);
  const flag = sku => post(ctx, { token, action: 'bootstrap', payload: {} })
    .data.prices.find(p => p.sku === sku).in_cutoff;

  ['TRUE', 'true', true, 1, 'yes', 'Flase', 'oo', '  '].forEach(v => {
    set('box4', v);
    assert.strictEqual(flag('box4'), true, JSON.stringify(v) + ' must count IN');
  });
  [false, 'FALSE', 'false', 'no', 0, '0', 'off'].forEach(v => {
    set('box4', v);
    assert.strictEqual(flag('box4'), false, JSON.stringify(v) + ' must count OUT');
  });
});

test("nori's money is stored apart: excluded_total, never total/cash/gcash", () => {
  const { ctx, ss, token } = freshSetup();
  // box4: 10 sold, 2 of them by GCash = 500, of which 100 GCash.
  // nori: 12 sold = 300, entirely outside the cutoff.
  const r = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 50, customGcash: 50,
      notes: '', counts: [
        { sku: 'box4', sod: 10, eod: 0, cheeseQty: 0, gcashQty: 2, gcashCheeseQty: 0 },
        { sku: 'nori', sod: 20, eod: 8 }
      ],
      entryId: 'excl-day-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 550, '500 boxes + 50 custom, and NOT the 300 nori');
  assert.strictEqual(r.data.gcash, 150, '2 GCash boxes + 50 custom GCash, no nori');
  assert.strictEqual(r.data.cash, 400, 'Cash = Total - GCash still holds');
  assert.strictEqual(r.data.excluded_total, 300, '12 nori at 25');
  assert.strictEqual(r.data.total + r.data.excluded_total, 850,
    'the tin holds Cash + excluded_total, so both figures have to be right');

  const lineOf = sku => r.data.lines.find(l => l.sku === sku);
  assert.strictEqual(lineOf('box4').in_cutoff, true);
  assert.strictEqual(lineOf('nori').in_cutoff, false,
    'the line says it did not count, so the receipt can print it below the totals');
  assert.strictEqual(lineOf('nori').amount, 300, 'its own amount is still computed and returned');
  assert.strictEqual(lineOf('nori').gcash_amount, 0);

  // ...and the same on the sheet, and on the way back out to the phone.
  const log = ss.getSheetByName('DailyLog').getDataRange().getValues();
  const head = log[0];
  const row = log.slice(1).find(x => x[0] === '2026-07-30');
  assert.strictEqual(row[head.indexOf('total')], 550);
  assert.strictEqual(row[head.indexOf('cash')], 400);
  assert.strictEqual(row[head.indexOf('gcash')], 150);
  assert.strictEqual(row[head.indexOf('excluded_total')], 300);
  const day = post(ctx, { token, action: 'bootstrap', payload: {} })
    .data.days.find(d => d.date === '2026-07-30');
  assert.strictEqual(day.total, 550);
  assert.strictEqual(day.excluded_total, 300);

  // Re-saving with the nori steppers back at 0 clears it: excluded_total is
  // recomputed from the day, never accumulated.
  const again = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 50, customGcash: 50,
      notes: '', counts: [
        { sku: 'box4', sod: 10, eod: 0, cheeseQty: 0, gcashQty: 2, gcashCheeseQty: 0 },
        { sku: 'nori', sod: 20, eod: 20 }
      ],
      entryId: 'excl-day-1'
    }
  });
  assert.strictEqual(again.ok, true, again.error);
  assert.strictEqual(again.data.excluded_total, 0);
  assert.strictEqual(again.data.total, 550, 'and the cutoff money did not move');
  const row2 = ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .find(x => x[0] === '2026-07-30');
  assert.strictEqual(row2[head.indexOf('excluded_total')], 0);
});

test('a closed day has no excluded money either', () => {
  const { ctx, token } = freshSetup();
  const r = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-29', closed: true, staff: '', customAmount: 0, customGcash: 0, notes: '',
      counts: [{ sku: 'nori', sod: 20, eod: 0 }], entryId: 'excl-closed'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 0);
  assert.strictEqual(r.data.excluded_total, 0, 'a closed day sold nothing, nori included');
  assert.deepStrictEqual(r.data.lines, []);
});

test('a GCash count on an excluded sku is REFUSED, and the day writes nothing', () => {
  // The decision (v2.4.0): an excluded sku has no payment split at all. Its
  // money is out of the cutoff, so its GCash must not feed the day's GCash — and
  // accepting it silently would leave the day's GCash figure short of the GCash
  // app, which is the one thing that figure exists to be checked against.
  const { ctx, ss, token } = freshSetup();
  const before = JSON.stringify(snapshot(ss));
  const bad = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
      notes: '', counts: [{ sku: 'nori', sod: 10, eod: 0, gcashQty: 4 }],
      entryId: 'excl-gcash-1'
    }
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /Nori/, 'the message must name the item');
  assert.match(bad.error, /GCash count must be 0/, 'and say exactly what to do');
  assert.ok(!/undefined|NaN/.test(bad.error), 'in plain English, with no debris in it');
  assert.strictEqual(JSON.stringify(snapshot(ss)), before,
    'a refused day must not half-write itself');

  // Nori still has no cheese version either (group=simple), in its own words.
  const cheese = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
      notes: '', counts: [{ sku: 'nori', sod: 10, eod: 0, cheeseQty: 1 }],
      entryId: 'excl-cheese-1'
    }
  });
  assert.strictEqual(cheese.ok, false);
  assert.match(cheese.error, /no cheese version/);

  // With the GCash count back at 0 the same day saves, and its money is out.
  const good = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
      notes: '', counts: [{ sku: 'nori', sod: 10, eod: 0, gcashQty: 0 }],
      entryId: 'excl-gcash-1'
    }
  });
  assert.strictEqual(good.ok, true, good.error);
  assert.strictEqual(good.data.total, 0);
  assert.strictEqual(good.data.gcash, 0);
  assert.strictEqual(good.data.excluded_total, 250);
});

test('the cutoff shows nori as excluded and in NOTHING else, and the identity closes', () => {
  // The same fixture twice: once with nori sold on two days, once without it at
  // all. Every figure and the note itself must be IDENTICAL — the only
  // difference allowed is the excluded block.
  function run(withNori) {
    const { ctx, token } = freshSetup();
    [['2026-07-20', 10, 12, 'p-1'], ['2026-07-21', 6, 4, 'p-2']].forEach(d => {
      const r = post(ctx, {
        token, action: 'saveDay',
        payload: dayWithNori(d[0], d[1], withNori ? d[2] : 0, d[3])
      });
      assert.strictEqual(r.ok, true, r.error);
    });
    [['Supplies', 300], ['Mama', 500], ['Electric', 500], ['Octopus', 250],
     ['Backlog', 200]].forEach((x, i) => {
      const r = post(ctx, {
        token, action: 'saveExpense',
        payload: {
          date: '2026-07-20', category: x[0], item: 'x', amount: x[1],
          backlogRef: x[0] === 'Backlog' ? 'Ref' : '', notes: '', entryId: 'x-' + i
        }
      });
      assert.strictEqual(r.ok, true, r.error);
    });
    const cut = post(ctx, {
      token, action: 'cutoff',
      payload: { start: '2026-07-16', end: '2026-07-31', dryRun: false }
    });
    assert.strictEqual(cut.ok, true, cut.error);
    return cut.data;
  }

  const withNori = run(true);
  const without = run(false);
  const f = withNori.figures;

  // (1) nori is visible, per sku, with its own quantity and money.
  assert.strictEqual(f.excluded, 400, '12 nori + 4 nori at 25');
  assert.deepStrictEqual(f.excluded_lines,
    [{ sku: 'nori', label: 'Nori', qty: 16, amount: 400 }],
    'one line per excluded sku: what it is, how many, how much');
  assert.strictEqual(f.excluded,
    f.excluded_lines.reduce((s, l) => s + l.amount, 0),
    'the total shown must be the sum of the lines shown beneath it');

  // (2) ...and NOWHERE else. Every other figure, and the note, is byte-identical
  // to the same cutoff with no nori sold at all.
  const strip = d => {
    const g = Object.assign({}, d.figures);
    delete g.excluded; delete g.excluded_lines;
    return g;
  };
  assert.deepStrictEqual(strip(withNori), strip(without),
    'nori may not move total, cash, gcash, supplies, remaining or any other figure');
  assert.strictEqual(withNori.note_text, without.note_text,
    'and the note the partner receives must not change by one byte');
  assert.strictEqual(without.figures.excluded, 0, 'no nori sold, nothing excluded');
  assert.deepStrictEqual(without.figures.excluded_lines, []);

  // (3) The identity still closes exactly, with nori nowhere in it.
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining,
    'Total = Mama + Split + Supplies + Octopus + Salary + Other + Electric + Remaining');
  assert.notStrictEqual(f.excluded, 0, 'and that identity closed while money WAS excluded');

  // (4) The note names no excluded sku and gains no line of its own: it is the
  // same fifteen lines it has always been.
  assert.ok(!/nori/i.test(withNori.note_text), 'nori must not be named in the note');
  assert.strictEqual(withNori.note_text.split('\n').length, 16,
    'the note is still exactly 16 lines — no "Excluded" line was added to it');
});

test('the note is BYTE-IDENTICAL to the spec sample with nori sales present', () => {
  // The strongest form of the owner's "Cutoff screen only" decision: the exact
  // spec note, produced from a period that also sold nori.
  const { ctx, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  // Two of the fifteen open days also sold nori. Same dates, same money, same
  // entryIds — only nori counts are added.
  [['2025-07-05', 12], ['2025-07-08', 4]].forEach(d => {
    const r = post(ctx, {
      token, action: 'saveDay',
      payload: {
        date: d[0], closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
        counts: [{ sku: 'nori', sod: d[1], eod: 0 }], entryId: 'day-' + d[0]
      }
    });
    assert.strictEqual(r.ok, true, r.error);
  });

  const res = post(ctx, {
    token, action: 'cutoff',
    payload: { start: '2025-07-01', end: '2025-07-15', dryRun: true }
  });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.data.note_text, SPEC_NOTE,
    'the note is what the owner sends his partner: nori must be invisible to it');
  assert.strictEqual(res.data.figures.excluded, 400, 'while still being visible on screen');
  assert.deepStrictEqual(res.data.figures.excluded_lines,
    [{ sku: 'nori', label: 'Nori', qty: 16, amount: 400 }]);
  // The archived copy is the same text, so a regenerated note cannot differ.
  const archived = post(ctx, {
    token, action: 'cutoff',
    payload: { start: '2025-07-01', end: '2025-07-15', dryRun: false }
  });
  assert.strictEqual(archived.data.note_text, SPEC_NOTE);
});

test('excluded_lines carry the SNAPSHOTTED money, not a later price', () => {
  // Same rule as every other amount: money is computed at save time. A nori
  // price change must not rewrite what a past day earned.
  const { ctx, token } = freshSetup();
  let r = post(ctx, { token, action: 'saveDay', payload: dayWithNori('2026-07-20', 0, 12, 'snap-1') });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.excluded_total, 12 * NORI_PRICE);

  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'nori', price: 30, cheesePrice: 0, active: true }] }
  });
  assert.strictEqual(r.ok, true, r.error);

  const cut = post(ctx, {
    token, action: 'cutoff',
    payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true }
  });
  assert.strictEqual(cut.data.figures.excluded, 300, 'still 12 x 25, not 12 x 30');
  assert.strictEqual(cut.data.figures.excluded_lines[0].amount, 300);
});

test('a sku that LEFT Prices is treated as counting in, never as excluded', () => {
  // in_cutoff removes ONE sku the owner set up on purpose. A count row whose sku
  // has been deleted is unpriceable history, not excluded money — the same
  // default a blank cell gets.
  const { ctx, ss, token } = freshSetup();
  const r = post(ctx, { token, action: 'saveDay', payload: dayWithNori('2026-07-20', 10, 12, 'gone-1') });
  assert.strictEqual(r.ok, true, r.error);
  deleteFirstColRow(ss, 'Prices', 'box4');
  const cut = post(ctx, {
    token, action: 'cutoff',
    payload: { start: '2026-07-16', end: '2026-07-31', dryRun: true }
  });
  assert.strictEqual(cut.ok, true, cut.error);
  assert.deepStrictEqual(cut.data.figures.excluded_lines.map(l => l.sku), ['nori'],
    'the deleted sku must not appear in the excluded block');
  assert.strictEqual(cut.data.figures.total, 500,
    "and the day's stored total is untouched by the deletion");
});

test('savePrices can SET in_cutoff, and never flips a row it was not told to', () => {
  const { ctx, ss, token } = freshSetup();
  const cellOfSku = sku => {
    const rows = priceCells(ss);
    const i = rows[0].indexOf('in_cutoff');
    return rows.slice(1).find(r => r[0] === sku)[i];
  };
  const flagOf = sku => post(ctx, { token, action: 'bootstrap', payload: {} })
    .data.prices.find(p => p.sku === sku).in_cutoff;
  const before = priceCells(ss).map(r => r.slice());

  // (1) The ordinary Maintenance save says nothing about in_cutoff — which is
  // exactly what an older phone, or a batch queued before v2.4.0, sends. Nothing
  // may move: not box4's TRUE, and above all not nori's FALSE.
  let r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [
      { sku: 'box4', price: 55, cheesePrice: 65, active: true },
      { sku: 'nori', price: 25, cheesePrice: 0, active: true }
    ] }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(cellOfSku('box4'), true, 'a silent payload must not switch box4 off');
  assert.strictEqual(cellOfSku('nori'), false, 'nor switch nori back in');
  assert.strictEqual(flagOf('box4'), true);
  assert.strictEqual(flagOf('nori'), false);
  assert.strictEqual(priceCells(ss)[1][4], 55, 'the price it WAS told to change did change');

  // (2) A row whose cell is BLANK (every row on the live sheet) stays blank
  // rather than being written to FALSE behind the owner's back.
  const legacy = legacySpreadsheet();
  const l = load(legacy);
  l.ctx.setupSheet();
  const blankCell = () => {
    const rows = legacy.getSheetByName('Prices').getDataRange().getValues();
    const i = rows[0].indexOf('in_cutoff');
    assert.ok(i > -1, 'precondition: the column was appended by the migration');
    return rows.slice(1).find(x => x[0] === 'box6')[i];
  };
  assert.strictEqual(blankCell(), '', 'precondition: box6 is blank');
  r = post(l.ctx, {
    token: LEGACY_TOKEN, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: 70, cheesePrice: 85, active: true }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(blankCell(), '', 'a blank in_cutoff must stay blank');
  assert.strictEqual(post(l.ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} })
    .data.prices.find(p => p.sku === 'box6').in_cutoff, true, 'and still read TRUE');

  // (3) An EXPLICIT value is written, both ways, and only for the listed sku.
  // It is set on NORI, because an excluded sku must be group=simple — a box with
  // a cheese version cannot be kept out of the cutoff at all (see the group=box
  // refusals below).
  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: true }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(cellOfSku('nori'), true);
  assert.strictEqual(flagOf('nori'), true, 'nori is now IN the cutoff');
  assert.strictEqual(flagOf('box4'), true, 'and box4 was not listed, so it did not move');
  assert.strictEqual(flagOf('box10'), true);
  // Money follows the flag immediately: nori sales now reach the day's total.
  let day = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-27', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
      notes: '', counts: [{ sku: 'nori', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 0 }],
      entryId: 'flip-1'
    }
  });
  assert.strictEqual(day.data.total, 100);
  assert.strictEqual(day.data.excluded_total, 0);

  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: false }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(cellOfSku('nori'), false);
  assert.strictEqual(flagOf('nori'), false, 'and back out again');
  day = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-28', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
      notes: '', counts: [{ sku: 'nori', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 0 }],
      entryId: 'flip-2'
    }
  });
  assert.strictEqual(day.data.total, 0);
  assert.strictEqual(day.data.excluded_total, 100);

  // (4) Nothing else in the tab moved through all of that: same rows, same
  // labels, same groups, same sizes.
  const after = priceCells(ss);
  assert.strictEqual(after.length, before.length, 'no row appended or lost');
  after.forEach((row, i) => {
    if (i === 0) return;
    assert.deepStrictEqual(row.slice(0, 4), before[i].slice(0, 4),
      'row ' + i + ': sku/label/group/size must be untouched');
  });
  assert.deepStrictEqual(after[3], before[3], 'box10 was never listed, so it never changed');
});

// ---------------------------------------------------------------------------
// 20. v2.4.1 — the three server guards around an excluded sku.
//
// All three are about money that is ALREADY SAVED, or about a figure the owner
// reconciles against something physical:
//   F2  history is classified by the in_cutoff SNAPSHOT on the count row, never
//       by the current Prices flag, so a tick in Maintenance cannot restate a
//       cutoff that has already been sent — in either direction;
//   F1  EVERY bucket is refused on an excluded sku (cheese and GCash cheese went
//       straight through and their money left the day's GCash);
//   F3  an excluded sku must be group=simple, refused by savePrices AND saveDay.
// ---------------------------------------------------------------------------
console.log('\n--- 20. Snapshotted flag, every bucket, and simple-only exclusion ---');

test('F2: the in_cutoff SNAPSHOT classifies history — a later flip moves no saved money', () => {
  const { ctx, ss, token } = freshSetup();
  // Two ordinary nights: ₱1,000 of Box 4 inside the cutoff, ₱300 of nori outside
  // it. This is the owner's proven case.
  [['2026-07-20', 10, 6, 'snapshot-a'], ['2026-07-21', 10, 6, 'snapshot-b']].forEach(d => {
    const r = post(ctx, { token, action: 'saveDay', payload: dayWithNori(d[0], d[1], d[2], d[3]) });
    assert.strictEqual(r.ok, true, r.error);
  });
  const before = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(before.figures.total, 1000);
  assert.strictEqual(before.figures.excluded, 300, 'precondition: 12 nori at 25, kept out');

  // --- Direction one: the owner ticks "counts in the cutoff" back ON for nori.
  // The fortnight he has already sent must not change by one peso, because the
  // money in it was banked under the flag as it stood that night.
  assert.strictEqual(setCutoffFlag(ctx, token, 'nori', 25, 0, true).ok, true);
  const after = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(after.figures.excluded, 300,
    'the ₱300 was in NO total, so losing it from the excluded block loses it everywhere');
  assert.strictEqual(after.figures.total, 1000, 'and it must not climb into the total either');
  assert.deepStrictEqual(after.figures, before.figures, 'not one figure may move');
  assert.strictEqual(after.note_text, before.note_text, 'and the note not one byte');

  // --- Direction two: money saved while a sku COUNTED must never later be shown
  // as kept out. nori is in the cutoff now, so this night banks it in `total`...
  const counted = post(ctx, {
    token, action: 'saveDay',
    payload: dayWithNori('2026-07-22', 0, 4, 'snapshot-c')
  });
  assert.strictEqual(counted.ok, true, counted.error);
  assert.strictEqual(counted.data.total, 100, '4 nori at 25, inside the day total');
  assert.strictEqual(counted.data.excluded_total, 0);
  const mid = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(mid.figures.total, 1100);
  assert.strictEqual(mid.figures.excluded, 300);

  // ...and then he ticks nori off again.
  assert.strictEqual(setCutoffFlag(ctx, token, 'nori', 25, 0, false).ok, true);
  const end = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(end.figures.total, 1100, 'the money stays where it was banked');
  assert.strictEqual(end.figures.excluded, 300,
    'the ₱100 that COUNTED must not also be shown as kept out — that is the same money twice');
  assert.deepStrictEqual(end.figures, mid.figures);
  assert.strictEqual(end.note_text, mid.note_text);

  // The two halves of the sheet agree, which is the invariant that makes the tin
  // reconcile: every day's stored excluded_total sums to the period's `excluded`.
  const days = post(ctx, { token, action: 'bootstrap', payload: {} }).data.days
    .filter(d => d.date >= '2026-07-16' && d.date <= '2026-07-31');
  assert.strictEqual(days.reduce((s, d) => s + d.excluded_total, 0), end.figures.excluded,
    'Σ DailyLog.excluded_total must equal the period\'s excluded figure');
  // And the identity still closes, with the excluded money nowhere in it.
  const f = end.figures;
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining,
    'Total = Mama + Split + Supplies + Octopus + Salary + Other + Electric + Remaining');
});

test('F2: a count row with NO snapshot counts IN — its money was saved inside the totals', () => {
  // PIN MOVED (v2.5.0, deliberate): a BLANK in_cutoff on a count row now reads
  // TRUE outright, replacing the fallback to the sku's CURRENT flag. Every
  // pre-snapshot row was written by code that put ALL of a day's money inside
  // total/cash/gcash — so classifying such rows by today's flag showed migrated
  // money BOTH inside the totals AND under "kept out": the same pesos stated
  // twice, in two contradictory ways, on the screen the owner reconciles his
  // tin against.
  const { ctx, ss, token } = freshSetup();
  // The pre-v2.4.0 world: nori counted IN when this fortnight was saved...
  assert.strictEqual(setCutoffFlag(ctx, token, 'nori', 25, 0, true).ok, true);
  const r = post(ctx, { token, action: 'saveDay', payload: dayWithNori('2026-07-20', 10, 12, 'legacy-flag-1') });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 800, 'precondition: 500 of boxes + 300 of nori, ALL inside the total');
  // ...and its rows predate the snapshot column, like every migrated row.
  clearCountFlags(ss);
  // Today, the owner's live sheet excludes nori again.
  assert.strictEqual(setCutoffFlag(ctx, token, 'nori', 25, 0, false).ok, true);

  const cut = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(cut.figures.total, 800, "the day's stored money is history and does not move");
  assert.strictEqual(cut.figures.excluded, 0,
    'the ₱300 is INSIDE the total: listing it under "kept out" too would state the same money twice');
  assert.deepStrictEqual(cut.figures.excluded_lines, []);

  // The resolved flag is what the phone receives, per row, so both sides tell
  // the owner the same thing: this money counted.
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} }).data;
  const rowOf = sku => boot.counts.find(c => c.date === '2026-07-20' && c.sku === sku);
  assert.strictEqual(rowOf('nori').in_cutoff, true,
    'a blank snapshot reads TRUE — the money was inside the totals when it was saved');
  assert.strictEqual(rowOf('box4').in_cutoff, true);

  // And the current Prices flag has NO say over it in either direction: flip
  // nori back in, and nothing about the saved fortnight moves.
  assert.strictEqual(setCutoffFlag(ctx, token, 'nori', 25, 0, true).ok, true);
  const after = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(after.figures.excluded, 0);
  assert.strictEqual(after.figures.total, 800);
});

test('F2: an excluded sku deleted from Prices keeps its money VISIBLE, under its sku', () => {
  // The snapshot is now what classifies a row, so money can be excluded even
  // though the sku it belonged to is gone. It must still be shown: `excluded` has
  // to equal the lines printed beneath it, and this money is in no total, so a
  // line silently dropped is money that exists nowhere on the screen.
  const { ctx, ss, token } = freshSetup();
  const r = post(ctx, { token, action: 'saveDay', payload: dayWithNori('2026-07-20', 10, 12, 'orphan-1') });
  assert.strictEqual(r.ok, true, r.error);
  deleteFirstColRow(ss, 'Prices', 'nori');

  const cut = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(cut.figures.excluded, 300);
  assert.deepStrictEqual(cut.figures.excluded_lines,
    [{ sku: 'nori', label: 'nori', qty: 12, amount: 300 }],
    'with no price row left there is no label but the sku itself');
  assert.strictEqual(cut.figures.excluded,
    cut.figures.excluded_lines.reduce((s, l) => s + l.amount, 0),
    'the total shown must always be the sum of the lines shown beneath it');
  assert.strictEqual(cut.figures.total, 500, 'and the counted money is untouched');
  assert.ok(!/nori/i.test(cut.note_text), 'the note still names no excluded sku');
});

test('F1: EVERY bucket is refused on an excluded sku, and the day writes nothing', () => {
  const { ctx, ss, token } = freshSetup();
  // A box sku taken out of the cutoff BY HAND — savePrices refuses to create this
  // state (below), and saveDay refuses to save a day against it, but the bucket
  // guard is the one that stops the money moving: a cheese count here was priced
  // into excluded_total and its GCash simply left the day's GCash figure.
  setPriceFlag(ss, 'box6', false);
  const before = JSON.stringify(snapshot(ss));
  const day = (count, id) => post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
      notes: '', counts: [count], entryId: id
    }
  });
  [
    [{ sku: 'box6', sod: 4, eod: 0, cheeseQty: 1 }, /its cheese count must be 0/],
    [{ sku: 'box6', sod: 4, eod: 0, gcashQty: 1 }, /its GCash count must be 0/],
    [{ sku: 'box6', sod: 4, eod: 0, gcashCheeseQty: 1 }, /its GCash cheese count must be 0/],
    [{ sku: 'box6', sod: 4, eod: 0, cheeseQty: 1, gcashQty: 1, gcashCheeseQty: 1 },
      /its cheese, GCash and GCash cheese counts must be 0/]
  ].forEach((c, i) => {
    const r = day(c[0], 'excl-bucket-' + i);
    assert.strictEqual(r.ok, false, 'ACCEPTED a bucket on an excluded sku: ' + JSON.stringify(c[0]));
    assert.match(r.error, /Box 6/, 'the message must name the item');
    assert.match(r.error, c[1], 'and name the bucket to zero: ' + r.error);
    assert.ok(!/undefined|NaN/.test(r.error), 'in plain English, with no debris in it');
    assert.strictEqual(JSON.stringify(snapshot(ss)), before, 'a refused day must not half-write itself');
  });

  // nori is group=simple and excluded: its GCash bucket is refused in the same
  // words, and its cheese buckets by the rule that it has no cheese version at
  // all — a message that fits the card the owner is looking at.
  const noriGcash = day({ sku: 'nori', sod: 10, eod: 0, gcashQty: 2 }, 'excl-nori-g');
  assert.strictEqual(noriGcash.ok, false);
  assert.match(noriGcash.error, /Nori is kept out of the cutoff/);
  assert.match(noriGcash.error, /its GCash count must be 0/);
  const noriCheese = day({ sku: 'nori', sod: 10, eod: 0, gcashCheeseQty: 2 }, 'excl-nori-c');
  assert.strictEqual(noriCheese.ok, false);
  assert.match(noriCheese.error, /no cheese version/);
  assert.strictEqual(JSON.stringify(snapshot(ss)), before);

  // With every bucket at 0 the same night saves, and the money is kept apart.
  const ok = day({ sku: 'nori', sod: 10, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }, 'excl-nori-ok');
  assert.strictEqual(ok.ok, true, ok.error);
  assert.strictEqual(ok.data.total, 0);
  assert.strictEqual(ok.data.gcash, 0);
  assert.strictEqual(ok.data.excluded_total, 250);
});

test('F3: savePrices REFUSES to take a group=box sku out of the cutoff, writing nothing', () => {
  const { ctx, ss, token } = freshSetup();
  const before = priceCells(ss).map(r => r.slice());
  let r = setCutoffFlag(ctx, token, 'box6', 65, 80, false);
  assert.strictEqual(r.ok, false,
    'a box with a cheese version cannot be an excluded sku: the card hides the cheese ' +
    'steppers while the payload still carries cheese quantities');
  assert.match(r.error, /box6/, 'the message must name the item');
  assert.match(r.error, /simple/, 'and say what would have to change');
  assert.ok(!/undefined|NaN/.test(r.error), 'in plain English, with no debris in it');
  assert.deepStrictEqual(priceCells(ss), before, 'nothing may be written');

  // The WHOLE batch is refused, not just the offending row.
  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [
      { sku: 'box4', price: 55, cheesePrice: 65, active: true, inCutoff: true },
      { sku: 'box10', price: 105, cheesePrice: 125, active: true, inCutoff: false }
    ] }
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /box10/);
  assert.deepStrictEqual(priceCells(ss), before, 'the good first row must not have been applied');

  // What IS allowed: a group=simple sku out of the cutoff, and any sku in it.
  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [
      { sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: false },
      { sku: 'box6', price: 65, cheesePrice: 80, active: true, inCutoff: true }
    ] }
  });
  assert.strictEqual(r.ok, true, r.error);

  // And a payload that says NOTHING about the flag is not a claim about it: an
  // older phone must still be able to edit the price of a hand-broken row, or
  // Maintenance locks up on the one sheet that needs fixing.
  setPriceFlag(ss, 'box6', false);
  r = post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: 70, cheesePrice: 85, active: true }] }
  });
  assert.strictEqual(r.ok, true, r.error);
  const box6 = post(ctx, { token, action: 'bootstrap', payload: {} }).data.prices
    .find(p => p.sku === 'box6');
  assert.strictEqual(box6.price, 70, 'the price it WAS told to change did change');
  assert.strictEqual(box6.in_cutoff, false, 'and the flag it said nothing about did not move');
});

test('F3: saveDay REFUSES a day that counts an excluded group=box sku, naming it', () => {
  const { ctx, ss, token } = freshSetup();
  setPriceFlag(ss, 'box6', false);          // only a hand edit can reach this state
  const before = JSON.stringify(snapshot(ss));
  const r = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
      counts: [
        { sku: 'box4', sod: 2, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 },
        { sku: 'box6', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }
      ],
      entryId: 'excl-box-day'
    }
  });
  assert.strictEqual(r.ok, false,
    'the phone hides this sku\'s cheese steppers, so the sheet and the phone would ' +
    'disagree about what was sold');
  assert.match(r.error, /Box 6/, 'the message must name the item');
  assert.match(r.error, /simple/, 'and say what to change');
  assert.ok(!/undefined|NaN/.test(r.error), 'in plain English, with no debris in it');
  assert.strictEqual(JSON.stringify(snapshot(ss)), before,
    'nothing written — not even the Box 4 line of the same day');

  // The refusal is scoped to a payload that CARRIES that sku, so there is always
  // a way through from the phone: switch the sku off (an inactive sku is not on
  // the Sales screen and not in the payload), or put the Prices row right.
  const okDay = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
      counts: [{ sku: 'box4', sod: 2, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }],
      entryId: 'excl-box-day'
    }
  });
  assert.strictEqual(okDay.ok, true, okDay.error);
  assert.strictEqual(okDay.data.total, 100);

  // ...and once the sheet is put right, the same day saves in full.
  setPriceFlag(ss, 'box6', true);
  const fixed = post(ctx, {
    token, action: 'saveDay',
    payload: {
      date: '2026-07-30', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
      counts: [
        { sku: 'box4', sod: 2, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 },
        { sku: 'box6', sod: 4, eod: 0, cheeseQty: 1, gcashQty: 0, gcashCheeseQty: 0 }
      ],
      entryId: 'excl-box-day'
    }
  });
  assert.strictEqual(fixed.ok, true, fixed.error);
  assert.strictEqual(fixed.data.total, 100 + 3 * 65 + 80);
  assert.strictEqual(fixed.data.excluded_total, 0);
});

test('the note stays BYTE-IDENTICAL to the spec sample when the flag is flipped later', () => {
  // The owner's "Cutoff screen only" decision, at its strongest: the exact spec
  // note, from a period that also sold nori, BEFORE and AFTER nori is ticked back
  // into the cutoff. Nothing about a fortnight already sent may move.
  const { ctx, token } = freshSetup();
  seedSpecPeriod(ctx, token);
  [['2025-07-05', 12], ['2025-07-08', 4]].forEach(d => {
    const r = post(ctx, {
      token, action: 'saveDay',
      payload: {
        date: d[0], closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
        counts: [{ sku: 'nori', sod: d[1], eod: 0 }], entryId: 'day-' + d[0]
      }
    });
    assert.strictEqual(r.ok, true, r.error);
  });
  const first = cutoffFor(ctx, token, '2025-07-01', '2025-07-15').data;
  assert.strictEqual(first.note_text, SPEC_NOTE);
  assert.strictEqual(first.figures.excluded, 400);

  assert.strictEqual(setCutoffFlag(ctx, token, 'nori', 25, 0, true).ok, true);
  const again = cutoffFor(ctx, token, '2025-07-01', '2025-07-15').data;
  assert.strictEqual(again.note_text, SPEC_NOTE,
    'the note the partner receives must regenerate byte for byte after any flag change');
  assert.deepStrictEqual(again.figures, first.figures, 'and not one figure may move');
  assert.strictEqual(again.figures.excluded, 400,
    'the ₱400 was never in the total, so it must still be shown as kept out');
});

// ---------------------------------------------------------------------------
// 21. v2.5.0 — the retroactivity / robustness pass. Each test here is the
// repro of a confirmed finding, kept as a pin.
// ---------------------------------------------------------------------------
console.log('\n--- 21. v2.5.0: price snapshots, split memory, and the server guards ---');

test("re-saving a date reuses THAT DATE's stored prices; a new sku uses current", () => {
  const { ctx, token } = freshSetup();
  let r = saveDay(ctx, token, { date: '2026-07-20', counts: [{ sku: 'box4', sod: 2, eod: 0, cheeseQty: 1 }], entryId: 'snap-1' });
  assert.strictEqual(r.data.total, 110, '1 regular x 50 + 1 cheese x 60');
  // The owner raises prices mid-cutoff...
  assert.strictEqual(post(ctx, {
    token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 60, cheesePrice: 75, active: true },
                      { sku: 'box6', price: 70, cheesePrice: 90, active: true }] }
  }).ok, true);
  // ...then corrects the 20th's counts. A correction fixes the COUNT — it must
  // never re-price the night at today's prices.
  r = saveDay(ctx, token, {
    date: '2026-07-20',
    counts: [{ sku: 'box4', sod: 3, eod: 0, cheeseQty: 1 }, { sku: 'box6', sod: 1, eod: 0 }],
    entryId: 'snap-1'
  });
  assert.strictEqual(r.ok, true, r.error);
  const box4 = r.data.lines.find(l => l.sku === 'box4');
  assert.deepStrictEqual([box4.price, box4.cheese_price], [50, 60], "the 20th keeps the 20th's prices");
  assert.strictEqual(box4.amount, 2 * 50 + 60);
  const box6 = r.data.lines.find(l => l.sku === 'box6');
  assert.deepStrictEqual([box6.price, box6.cheese_price], [70, 90],
    'a sku NEW to the day has no snapshot to reuse, so it uses the current price');
  assert.strictEqual(r.data.total, 160 + 70);
  // A brand-new date prices at the new list, as always.
  r = saveDay(ctx, token, { date: '2026-07-21', counts: [{ sku: 'box4', sod: 1, eod: 0 }], entryId: 'snap-2' });
  assert.strictEqual(r.data.total, 60);
});

test('a legacy count row with BLANK stored prices falls back to the current Prices tab', () => {
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  ctx.setupSheet();
  // Bootstrap resolves the blank against the CURRENT list (box4 is 55 here) —
  // the only answer a pre-v2.5.0 row has — while its stored money is untouched.
  const boot = post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} });
  const c = boot.data.counts.find(x => x.sku === 'box4');
  assert.deepStrictEqual([c.price, c.cheese_price], [55, 60]);
  assert.strictEqual(c.amount, 520, 'the stored amount itself never moves');
  // A re-save of that date has the same nothing to reuse, so it prices current.
  const r = post(ctx, {
    token: LEGACY_TOKEN, action: 'saveDay',
    payload: {
      date: '2026-07-20', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
      counts: [{ sku: 'box4', sod: 10, eod: 0, cheeseQty: 2 }], entryId: 'old-day-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual([r.data.lines[0].price, r.data.lines[0].cheese_price], [55, 60]);
});

test('saveDay refuses a BLANK price on an ACTIVE sku, naming it (mirror of savePrices)', () => {
  const { ctx, ss, token } = freshSetup();
  // Only a hand edit can reach this state — savePrices refuses to create it.
  const sh = ss.getSheetByName('Prices');
  const v = sh.getDataRange().getValues();
  const row = v.findIndex(x => x[0] === 'box6') + 1;
  sh.getRange(row, v[0].indexOf('price') + 1).setValue('');
  const before = JSON.stringify(snapshot(ss));
  const r = saveDay(ctx, token, { counts: [{ sku: 'box6', sod: 4, eod: 0 }], entryId: 'blank-price' });
  assert.strictEqual(r.ok, false, 'a night must never be silently booked at ₱0');
  assert.match(r.error, /Box 6/, 'the message names the item');
  assert.match(r.error, /price/);
  assert.ok(!/undefined|NaN/.test(r.error), 'in plain English');
  assert.strictEqual(JSON.stringify(snapshot(ss)), before, 'and nothing was written');
  // A cleared CHEESE price is the same hole on a box sku.
  sh.getRange(row, v[0].indexOf('price') + 1).setValue(65);
  sh.getRange(row, v[0].indexOf('cheese_price') + 1).setValue('');
  const r2 = saveDay(ctx, token, { counts: [{ sku: 'box6', sod: 4, eod: 0 }], entryId: 'blank-price' });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /cheese price/);
});

test('a Prices tab with nothing readable REFUSES the day, naming the actual problem', () => {
  const { ctx, ss, token } = freshSetup();
  ['box4', 'box6', 'box10', 'nori'].forEach(s => deleteFirstColRow(ss, 'Prices', s));
  const r = saveDay(ctx, token, { counts: [{ sku: 'box4', sod: 4, eod: 0 }], entryId: 'no-prices' });
  assert.strictEqual(r.ok, false,
    'an unreadable Prices tab used to drop every sku and book the night at ₱0 behind ok:true');
  assert.match(r.error, /Prices tab/, 'the message names where the problem is');
  assert.ok(!/undefined|NaN/.test(r.error));
  // The guard is scoped to a payload that NEEDS pricing: a custom-only day and a
  // closed day still save.
  assert.strictEqual(saveDay(ctx, token, { counts: [], customAmount: 100, entryId: 'no-prices-ok' }).ok, true);
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-29', closed: true, counts: [], entryId: 'no-prices-closed' }).ok, true);
});

test('duplicate Prices/DailyLog rows: the FIRST wins, deterministically, and nothing blocks', () => {
  const { ctx, ss, token } = freshSetup();
  // A hand-copied duplicate box4 row at a nonsense price.
  ss.getSheetByName('Prices').appendRow(['box4', 'Box 4 copy', 'box', 4, 999, 999, true, '']);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  const rows4 = boot.data.prices.filter(p => p.sku === 'box4');
  assert.strictEqual(rows4.length, 1, 'one sku, one row on the phone');
  assert.strictEqual(rows4[0].price, 50, 'the FIRST row wins — the same row an upsert rewrites');
  const r = saveDay(ctx, token, { counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'dup-1' });
  assert.strictEqual(r.ok, true, 'a duplicate row must never make the day unsaveable: ' + r.error);
  assert.strictEqual(r.data.total, 100, 'priced by the first row');

  // A duplicate DATE row typed into DailyLog by hand, contradicting the real one.
  ss.getSheetByName('DailyLog').appendRow(['2026-07-30', false, 'Mama', 0, 77777, 77777, 0, '', 'dup-hand', '']);
  const days = post(ctx, { token, action: 'bootstrap', payload: {} }).data.days.filter(d => d.date === '2026-07-30');
  assert.strictEqual(days.length, 1, 'one date, one day');
  assert.strictEqual(days[0].total, 100, 'the FIRST row wins — the one apiSaveDay updates');
  const cut = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(cut.figures.total, 100, 'the duplicate must not double the cutoff');
});

test('headers match case-insensitively and trimmed, so a retyped header still reads', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-20', counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'case-1' }).ok, true);
  // The owner retypes two headers, with a capital and a stray space.
  const sh = ss.getSheetByName('DailyLog');
  sh.getRange(1, 1).setValue(' Date ');
  sh.getRange(1, 5).setValue('Total');
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, boot.error);
  assert.strictEqual(boot.data.days.find(d => d.date === '2026-07-20').total, 100,
    'a retyped header must not make its column — and its money — invisible');
  // Saving upserts the SAME row, and migration appends no duplicate column.
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-20', counts: [{ sku: 'box4', sod: 3, eod: 0 }], entryId: 'case-1' }).ok, true);
  assert.strictEqual(sh.getDataRange().getValues().slice(1).filter(x => String(x[0]) === '2026-07-20').length, 1);
  ctx.setupSheet();
  const heads = sh.getDataRange().getValues()[0].map(h => String(h).trim().toLowerCase());
  assert.strictEqual(heads.filter(h => h === 'date').length, 1, 'no second "date" column appended');
  assert.strictEqual(heads.filter(h => h === 'total').length, 1);
});

test('migrateTab REFUSES a non-empty tab with no recognizable headers', () => {
  const ss = new FakeSpreadsheet();
  makeTab(ss, 'Settings', ['key', 'value'], [['token', 'x']]);
  // Something else entirely, wearing the DailyLog name.
  makeTab(ss, 'DailyLog', ['fecha', 'monto'], [['2026-07-01', 99]]);
  const { ctx } = load(ss);
  assert.throws(() => ctx.setupSheet(), /DailyLog/, 'the error must name the tab');
  assert.throws(() => ctx.setupSheet(), /header/i, 'and say what is wrong, plainly');
  assert.deepStrictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues()[0],
    ['fecha', 'monto'], 'a second schema must NOT be appended beside foreign data');
});

test('the split remembers the period: entered row, then the ARCHIVED split, then the default', () => {
  const { ctx, ss, token } = splitFixture();
  // Generate the note for real at the default...
  let r = cutoffFor(ctx, token, SPLIT_PERIOD.start, SPLIT_PERIOD.end, false);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.figures.split, 3000);
  // ...which RECORDS the split it used, so the period now owns its figure.
  const inputs = ss.getSheetByName('CutoffInputs').getDataRange().getValues().slice(1);
  assert.strictEqual(inputs.length, 1, 'a real generation with no entered split writes one row');
  assert.strictEqual(inputs[0][2], 3000);
  // Changing the default later moves NOTHING about this period.
  assert.strictEqual(post(ctx, { token, action: 'saveSettings', payload: { settings: { split_default: 5000 } } }).ok, true);
  r = cutoffFor(ctx, token, SPLIT_PERIOD.start, SPLIT_PERIOD.end);
  assert.strictEqual(r.data.figures.split, 3000, 'an already-generated period keeps ITS split');
  // Even with the CutoffInputs row gone (hand edit), the ARCHIVED split answers
  // before the default does.
  ss.getSheetByName('CutoffInputs').deleteRow(2);
  r = cutoffFor(ctx, token, SPLIT_PERIOD.start, SPLIT_PERIOD.end);
  assert.strictEqual(r.data.figures.split, 3000, 'the archived split outranks a newer default');
  // A period never generated still falls through to the default.
  r = cutoffFor(ctx, token, '2026-06-16', '2026-06-30');
  assert.strictEqual(r.data.figures.split, 5000);
});

test('duplicate CutoffInputs rows: the FIRST wins — the same row "Save split" rewrites', () => {
  // Only a hand-edit can make two rows for one (start, end) — the app upserts.
  // Before v2.6.0 the note read the LAST duplicate while saveCutoffSplit
  // rewrote the FIRST, so a saved split appeared not to take: the owner types
  // 2,500, the note keeps printing the stray row's 9,999 forever.
  const { ctx, ss, token } = splitFixture();
  assert.strictEqual(post(ctx, { token, action: 'saveCutoffSplit',
    payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, amount: 2000, entryId: 'dup-1' } }).ok, true);
  // The stray duplicate, as a hand-copied row would sit in the sheet.
  ctx.appendObjects(ss, 'CutoffInputs', [{
    start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, split_amount: 9999,
    entry_id: 'dup-stray', updated_at: '2026-07-20 09:00:00' }]);

  let r = cutoffFor(ctx, token, SPLIT_PERIOD.start, SPLIT_PERIOD.end);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.figures.split, 2000, 'the note must be built from the first (saved) row');

  // Saving a correction rewrites that SAME first row, and the note follows it.
  assert.strictEqual(post(ctx, { token, action: 'saveCutoffSplit',
    payload: { start: SPLIT_PERIOD.start, end: SPLIT_PERIOD.end, amount: 2500, entryId: 'dup-1' } }).ok, true);
  r = cutoffFor(ctx, token, SPLIT_PERIOD.start, SPLIT_PERIOD.end);
  assert.strictEqual(r.data.figures.split, 2500, 'a saved correction must take despite the stray row');
  assert.strictEqual(r.data.figures.per_partner, 1250);

  // And bootstrap ships ONE row for the period — the winning one — so the
  // phone's Split field shows the figure the note will actually use.
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  const rows = boot.data.cutoffInputs.filter(x => x.start === SPLIT_PERIOD.start && x.end === SPLIT_PERIOD.end);
  assert.deepStrictEqual(rows.map(x => x.split_amount), [2500],
    'the duplicate must not reach the phone at all');
});

test('the split is WHOLE PESOS: centavos are refused on entry and on the default', () => {
  const { ctx, ss, token } = freshSetup();
  const r = post(ctx, {
    token, action: 'saveCutoffSplit',
    payload: { start: '2026-07-16', end: '2026-07-31', amount: 3000.5, entryId: 'c-split' }
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /whole pesos/);
  assert.ok(!/undefined|NaN/.test(r.error));
  assert.strictEqual(ss.getSheetByName('CutoffInputs').getDataRange().getValues().length - 1, 0, 'nothing written');
  const r2 = post(ctx, { token, action: 'saveSettings', payload: { settings: { split_default: 1500.25 } } });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /whole pesos/);
  assert.strictEqual(settingsMap(ss).split_default, 3000, 'the default is untouched');
  // Whole pesos still save — including an odd figure, whose half is x.50.
  const ok = post(ctx, {
    token, action: 'saveCutoffSplit',
    payload: { start: '2026-07-16', end: '2026-07-31', amount: 3001, entryId: 'c-split' }
  });
  assert.strictEqual(ok.ok, true, ok.error);
  assert.strictEqual(ok.data.per_partner, 1500.5);
});

test('a BLANK money value in saveSettings means leave-alone, never ₱0', () => {
  const { ctx, ss, token } = freshSetup();
  const r = post(ctx, {
    token, action: 'saveSettings',
    payload: { settings: { daily_salary: '', split_default: null, branch: 'Marikina' } }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.saved, ['branch']);
  assert.deepStrictEqual(r.data.ignored, ['daily_salary', 'split_default'],
    'the blank keys are reported back as untouched');
  assert.strictEqual(settingsMap(ss).daily_salary, 200, 'a cleared field must not zero the wage');
  assert.strictEqual(settingsMap(ss).split_default, 3000);
});

test('setupSheet backfills BLANK salaries on open rows — and never touches 0 or closed', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-20', counts: [], entryId: 'bf-1' }).ok, true);
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-21', salary: 0, counts: [], entryId: 'bf-2' }).ok, true);
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-22', closed: true, counts: [], entryId: 'bf-3' }).ok, true);
  setSalaryCell(ss, '2026-07-20', ''); // the rows as v2.2.0 left them
  setSalaryCell(ss, '2026-07-22', '');

  ctx.setupSheet();
  assert.strictEqual(salaryCellFor(ss, '2026-07-20'), 200, 'a blank OPEN row is written at the current rate');
  assert.strictEqual(salaryCellFor(ss, '2026-07-21'), 0, 'an explicit 0 (a day off) stands');
  assert.strictEqual(salaryCellFor(ss, '2026-07-22'), '', 'a closed day stays blank — nobody worked');
  // ...so a LATER rate change no longer re-prices that history.
  assert.strictEqual(post(ctx, { token, action: 'saveSettings', payload: { settings: { daily_salary: 500 } } }).ok, true);
  const cut = cutoffFor(ctx, token, '2026-07-16', '2026-07-31').data;
  assert.strictEqual(cut.figures.salary, 200, 'the backfilled fortnight keeps what it actually cost');
});

test('a NEGATIVE category refuses the real note, naming the rows; dryRun shows it plainly', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-20', counts: [{ sku: 'box4', sod: 4, eod: 0 }], entryId: 'neg-day' }).ok, true);
  // Only a hand edit can make a negative amount — saveExpense refuses them.
  const sh = ss.getSheetByName('Expenses');
  sh.appendRow(['2026-07-21', 'Supplies', 'refund', -500, '', '', 'neg-exp', '']);

  const dry = cutoffFor(ctx, token, '2026-07-16', '2026-07-31');
  assert.strictEqual(dry.ok, true, 'the PREVIEW still answers: ' + dry.error);
  assert.strictEqual(dry.data.figures.supplies, -500, 'and shows the negative plainly');

  const real = cutoffFor(ctx, token, '2026-07-16', '2026-07-31', false);
  assert.strictEqual(real.ok, false, 'the real note is refused — it would state money that never existed');
  assert.match(real.error, /Supplies/);
  assert.match(real.error, /2026-07-21/, 'the offending row is named by date');
  assert.match(real.error, /refund/, '...and by item');
  assert.ok(!/undefined|NaN/.test(real.error));
  assert.strictEqual(ss.getSheetByName('Cutoffs').getDataRange().getValues().length - 1, 0, 'nothing archived');

  // Fix the row, and the same generation goes through.
  const v = sh.getDataRange().getValues();
  sh.getRange(v.findIndex(x => x[6] === 'neg-exp') + 1, 4).setValue(500);
  const ok = cutoffFor(ctx, token, '2026-07-16', '2026-07-31', false);
  assert.strictEqual(ok.ok, true, ok.error);
});

test('event dates: the future and the deep past are refused; periods still reach ahead', () => {
  const { ctx, token } = freshSetup(); // frozen "now" is 2026-08-01, Manila
  const dayF = saveDay(ctx, token, { date: '2026-08-02', counts: [], entryId: 'fut-1' });
  assert.strictEqual(dayF.ok, false); assert.match(dayF.error, /has not happened yet/);
  const expF = post(ctx, {
    token, action: 'saveExpense',
    payload: { date: '2026-08-02', category: 'Other', item: 'x', amount: 10, backlogRef: '', notes: '', entryId: 'fut-2' }
  });
  assert.strictEqual(expF.ok, false); assert.match(expF.error, /has not happened yet/);
  const cntF = post(ctx, {
    token, action: 'saveStockCount',
    payload: { date: '2026-08-02', product: 'Bonito', qty: 1, entryId: 'fut-3' }
  });
  assert.strictEqual(cntF.ok, false); assert.match(cntF.error, /has not happened yet/);
  const old = saveDay(ctx, token, { date: '2019-12-31', counts: [], entryId: 'old-1' });
  assert.strictEqual(old.ok, false); assert.match(old.error, /before 2020/);
  // TODAY is not the future.
  assert.strictEqual(saveDay(ctx, token, { date: '2026-08-01', counts: [], entryId: 'today-1' }).ok, true);
  // A cutoff PERIOD legitimately reaches into the future (the 1-15 of "now"),
  // and so does the split saved for it — period bounds are not event dates.
  assert.strictEqual(cutoffFor(ctx, token, '2026-08-01', '2026-08-15').ok, true);
  assert.strictEqual(post(ctx, {
    token, action: 'saveCutoffSplit',
    payload: { start: '2026-08-01', end: '2026-08-15', amount: 3000, entryId: 'sp-f' }
  }).ok, true);
});

test('hand-typed dates are NORMALIZED on read, so that money is never invisible', () => {
  const { ctx, ss, token } = freshSetup();
  // The owner types a day and an expense straight into the sheet, shorthand.
  ss.getSheetByName('DailyLog').appendRow(['2026-7-5', false, 'Mama', 0, 400, 400, 0, '', 'hand-day', '']);
  ss.getSheetByName('Expenses').appendRow(['7/5/2026', 'Supplies', 'sauce', 120, '', '', 'hand-exp', '']);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.days.find(d => d.date === '2026-07-05').total, 400,
    'the hand-typed day reaches the phone, canonical');
  assert.strictEqual(boot.data.expenses.find(x => x.entry_id === 'hand-exp').date, '2026-07-05');
  const cut = cutoffFor(ctx, token, '2026-07-01', '2026-07-15').data;
  assert.strictEqual(cut.figures.total, 400, 'hand-typed money reaches the cutoff');
  assert.strictEqual(cut.figures.supplies, 120);
  // Saving that date from the phone UPDATES the hand-typed row, not a duplicate.
  const r = saveDay(ctx, token, { date: '2026-07-05', counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'hand-day' });
  assert.strictEqual(r.ok, true, r.error);
  const logRows = ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .filter(x => String(x[0]) === '2026-7-5' || String(x[0]) === '2026-07-05');
  assert.strictEqual(logRows.length, 1, 'no duplicate row for the same real day');
  // 13/5/2026 can only be day/month; it reads as May 13 rather than vanishing.
  ss.getSheetByName('Expenses').appendRow(['13/5/2026', 'Other', 'x', 10, '', '', 'hand-exp2', '']);
  const range = post(ctx, { token, action: 'range', payload: { start: '2026-05-01', end: '2026-05-31' } });
  assert.strictEqual(range.data.expenses.find(x => x.entry_id === 'hand-exp2').date, '2026-05-13');
});

test('branch strips CR/LF on both paths, and a null body gets the friendly error', () => {
  const { ctx, ss, token } = freshSetup();
  // On write:
  let r = post(ctx, { token, action: 'saveSettings', payload: { settings: { branch: 'Tañong\nAnnex' } } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(settingsMap(ss).branch, 'Tañong Annex');
  // On read — a cell edited by hand:
  const sh = ss.getSheetByName('Settings');
  const v = sh.getDataRange().getValues();
  sh.getRange(v.findIndex(x => x[0] === 'branch') + 1, 2).setValue('Tañong\r\nMain');
  const cut = cutoffFor(ctx, token, '2026-07-16', '2026-07-31');
  assert.strictEqual(cut.ok, true, cut.error);
  assert.match(cut.data.note_text, /^Tañong Main: /, 'the note heading stays ONE line');
  assert.strictEqual(cut.data.note_text.split('\n').length, 16, 'and the line structure is intact');
  assert.strictEqual(post(ctx, { token, action: 'bootstrap', payload: {} }).data.settings.branch,
    'Tañong Main', 'the phone previews with the same cleaned branch');

  // A JSON body that parses to null (or a non-object) answers plainly.
  ['null', '"hello"', '42', '[]'].forEach(body => {
    const out = ctx.doPost({ postData: { contents: body } });
    const res = JSON.parse(out.getContent());
    assert.strictEqual(res.ok, false, body + ' must be refused');
    assert.match(res.error, /not valid JSON|Empty request body/, body + ' must answer plainly');
    assert.ok(!/TypeError|Cannot read/.test(res.error), 'never a raw engine error');
  });
});

test('the DailyLog row is written LAST: a mid-save crash leaves no day that looks complete', () => {
  const { ctx, ss, token } = freshSetup();
  // A first good save so every tab exists; then the DailyCounts write dies.
  assert.strictEqual(saveDay(ctx, token, { date: '2026-07-20', counts: [{ sku: 'box4', sod: 2, eod: 0 }], entryId: 'wo-1' }).ok, true);
  const dc = ss.getSheetByName('DailyCounts');
  const proto = Object.getPrototypeOf(dc.getRange(1, 1, 1, 1));
  const orig = proto.setValues;
  proto.setValues = function () {
    if (this.sheet && this.sheet.name === 'DailyCounts') throw new Error('SIMULATED CRASH');
    return orig.apply(this, arguments);
  };
  let r;
  try {
    r = saveDay(ctx, token, { date: '2026-07-25', counts: [{ sku: 'box4', sod: 9, eod: 0 }], entryId: 'wo-2' });
  } finally {
    proto.setValues = orig;
  }
  assert.strictEqual(r.ok, false, 'the request itself fails');
  assert.strictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .filter(x => x[0] === '2026-07-25').length, 0,
    'no DailyLog row may claim a day whose counts were never written — the retry rewrites cleanly');
});

// ---------------------------------------------------------------------------
// 22. Receiving stock is its OWN action (v2.6.0). Suppliers deliver on credit:
// goods arriving (StockDeliveries) and money leaving (Expenses) are two events
// on two days. One door in, one door out, one door for money — and the legacy
// expense-attached rows keep counting into on-hand forever.
// ---------------------------------------------------------------------------
console.log('\n--- 22. Receiving stock is its OWN action (v2.6.0) ---');

// The refusal, byte for byte. The phone shows this sentence on the red card, so
// the wording is part of the contract.
const EXPENSE_STOCK_REFUSAL =
  'Deliveries are recorded under Stock on hand now, so this expense should carry money only.';

test('saveExpense REFUSES new stock fields in one plain sentence, and writes nothing', () => {
  const { ctx, ss, token } = freshSetup();
  const attempts = [
    { stockProduct: 'Takoyaki Flour', stockQty: 4 },   // the old delivery shape
    { stockProduct: 'Takoyaki Flour' },                // a product with no quantity
    { stockQty: 4 },                                   // a quantity with no product
    { stockProduct: 'Bonitoo', stockQty: 0 }           // even a zero, even a typo
  ];
  attempts.forEach((extra, i) => {
    const r = post(ctx, { token, action: 'saveExpense',
      payload: Object.assign({ date: '2026-07-20', category: 'Supplies', item: 'harina',
        amount: 500, backlogRef: '', notes: '', entryId: 'refuse-' + i }, extra) });
    assert.strictEqual(r.ok, false, 'attempt ' + i + ' must be refused');
    assert.strictEqual(r.error, EXPENSE_STOCK_REFUSAL,
      'the sentence must point at Stock came in, byte for byte');
  });
  assert.strictEqual(ss.getSheetByName('Expenses').getDataRange().getValues().length - 1, 0,
    'no half-expense may land: the money goes with the refusal');
  // BLANK stock fields are what every ordinary queued expense carries — normal.
  const ok = post(ctx, { token, action: 'saveExpense',
    payload: { date: '2026-07-20', category: 'Supplies', item: 'harina', amount: 500,
      backlogRef: '', notes: '', stockProduct: '', stockQty: '', entryId: 'plain-ok' } });
  assert.strictEqual(ok.ok, true, ok.error);
});

test('a LEGACY expense-attached delivery keeps counting forever — even through a re-save', () => {
  const { ctx, ss, token } = freshSetup();
  legacyDeliver(ctx, ss, '2026-07-10', 'Takoyaki Sauce', 3, 900, 'leg-1');
  assert.strictEqual(onHand(ctx, token, 'Takoyaki Sauce').on_hand, 3,
    'a quantity already in the sheet is history, and history is never restated');

  // Mixed doors: a new-flow delivery adds on TOP of the legacy row.
  assert.strictEqual(post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'Takoyaki Sauce', qty: 2, entryId: 'leg-new' } }).ok, true);
  const it = onHand(ctx, token, 'Takoyaki Sauce');
  assert.strictEqual(it.delivered_since, 5, 'legacy 3 + new 2, both doors');
  assert.strictEqual(it.on_hand, 5);

  // A replayed EDIT of that legacy row (money only — the new shape) must not
  // wipe its stock cells: saveExpense no longer writes those two columns at all.
  assert.strictEqual(post(ctx, { token, action: 'saveExpense',
    payload: { date: '2026-07-10', category: 'Supplies', item: 'delivery (legacy, edited)',
      amount: 950, backlogRef: '', notes: '', entryId: 'leg-1' } }).ok, true);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  const row = boot.data.expenses.find(x => x.entry_id === 'leg-1');
  assert.strictEqual(row.amount, 950, 'the money edit lands');
  assert.strictEqual(row.stock_product, 'Takoyaki Sauce',
    're-saving the expense wiped the legacy stock cells — the shelf just lost 3 gallons');
  assert.strictEqual(row.stock_qty, 3);
  assert.strictEqual(boot.data.stockItems.find(x => x.product === 'Takoyaki Sauce').on_hand, 5);
});

test('saveStockDelivery: at least 1 whole unit, and a replay never books a delivery twice', () => {
  const { ctx, ss, token } = freshSetup();
  // Zero is not a delivery.
  let r = post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'Bonito', qty: 0, entryId: 'zero-1' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /at least 1 whole unit/);
  // The event-date clamps, same words as every other recorded event.
  r = post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: '2027-01-01', product: 'Bonito', qty: 1, entryId: 'fut-1' } });
  assert.strictEqual(r.ok, false); assert.match(r.error, /has not happened yet/);
  r = post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: '2019-12-31', product: 'Bonito', qty: 1, entryId: 'old-1' } });
  assert.strictEqual(r.ok, false); assert.match(r.error, /before 2020/);

  // Idempotent replay: the same entryId converges on ONE row...
  const payload = { date: '2026-07-20', product: 'Bonito', qty: 4, entryId: 'replay-1' };
  const r1 = post(ctx, { token, action: 'saveStockDelivery', payload });
  const r2 = post(ctx, { token, action: 'saveStockDelivery', payload });
  assert.strictEqual(r1.ok, true, r1.error);
  assert.deepStrictEqual(r1.data, r2.data, 'a replay must answer the same figure');
  assert.strictEqual(r1.data.on_hand, 4);
  assert.strictEqual(ss.getSheetByName('StockDeliveries').getDataRange().getValues().length - 1, 1,
    'a queue replay must not put the same gallons on the shelf twice');
  // ...and a corrected re-send moves the figure instead of adding to it.
  const fixed = post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: '2026-07-20', product: 'Bonito', qty: 2, entryId: 'replay-1' } });
  assert.strictEqual(fixed.data.on_hand, 2, 'a correction replaces, never accumulates');
  assert.strictEqual(onHand(ctx, token, 'Bonito').on_hand, 2);
});

test('delivered_before carries BOTH doors, and bootstrap ships only the window', () => {
  const { ctx, ss, token } = freshSetup();
  const OLD_LEGACY = ymdDaysAgo(120);   // both strictly before the 90-day window
  const OLD_NEW = ymdDaysAgo(100);
  const RECENT = ymdDaysAgo(5);
  legacyDeliver(ctx, ss, OLD_LEGACY, 'Takoyaki Flour', 3, 600, 'win-leg');
  assert.strictEqual(post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: OLD_NEW, product: 'Takoyaki Flour', qty: 2, entryId: 'win-old' } }).ok, true);
  assert.strictEqual(post(ctx, { token, action: 'saveStockDelivery',
    payload: { date: RECENT, product: 'Takoyaki Flour', qty: 4, entryId: 'win-new' } }).ok, true);
  useStock(ctx, token, ymdDaysAgo(4), 'Takoyaki Flour', 1, 'win-use');

  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  const flour = r.data.stockItems.find(x => x.product === 'Takoyaki Flour');
  assert.strictEqual(flour.delivered_since, 9, '3 legacy + 2 old + 4 recent — the whole history');
  assert.strictEqual(flour.delivered_before, 5,
    'the pre-window part must carry BOTH doors: the legacy 3 AND the StockDeliveries 2');
  assert.strictEqual(flour.on_hand, 8, '0 + 9 − 1');
  assert.deepStrictEqual(r.data.stockDeliveries.map(x => [x.date, x.qty]), [[RECENT, 4]],
    'only in-window delivery rows ship — the phone adds them on top of delivered_before');
});

test('a hand-typed loose date on a StockDeliveries row is normalized on read', () => {
  const { ctx, ss, token } = freshSetup();
  // The owner types straight into the tab: slash date, no leading zeros.
  const inWin = ymdDaysAgo(10);                       // e.g. 2026-07-22
  const loose = inWin.replace(/-0?(\d+)-0?(\d+)$/, '/$1/$2'); // -> 2026/7/22
  ctx.appendObjects(ss, 'StockDeliveries', [{
    date: loose, product: 'Aonori', qty: 6, entry_id: 'hand-dlv', updated_at: ''
  }]);
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.deepStrictEqual(r.data.stockDeliveries.map(x => [x.date, x.product, x.qty]),
    [[inWin, 'Aonori', 6]], 'the loose date must arrive canonical, not invisible');
  assert.strictEqual(r.data.stockItems.find(x => x.product === 'Aonori').on_hand, 6,
    'hand-typed goods still reach the shelf');
});

test('setupSheet creates StockDeliveries with plain-text date columns, append-only', () => {
  const { ss } = freshSetup();
  const sh = ss.getSheetByName('StockDeliveries');
  assert.ok(sh, 'the tab must exist after migration');
  assert.deepStrictEqual(
    sh.getRange(1, 1, 1, 5).getValues()[0],
    ['date', 'product', 'qty', 'entry_id', 'updated_at']);
  // date (col 1) and updated_at (col 5) are "@" so Sheets never coerces the
  // yyyy-MM-dd strings into locale-dependent Date cells.
  assert.strictEqual(sh.columnFormats[1], '@', 'date column must be plain text');
  assert.strictEqual(sh.columnFormats[5], '@', 'updated_at column must be plain text');
  assert.strictEqual(sh.frozenRows, 1);
});

// ---------------------------------------------------------------------------
console.log('\n============================================');
console.log('  ' + passed + ' passed, ' + failed + ' failed');
console.log('============================================');
if (failed > 0) {
  failures.forEach(f => console.error('\nFAILED: ' + f.name + '\n' + f.err.stack));
  process.exit(1);
}
