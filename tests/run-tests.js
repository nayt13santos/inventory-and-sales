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
const SPEC_NOTE = [
  'Tañong: July 1 - 15 Breakdown',
  '',
  'Total - 11,857',
  '',
  'Cash - 10,530',
  'GCash - 1,327',
  '',
  'Mama - 500',
  'Split - 4,000(2,000 each)',
  'Supplies - 5,440',
  'Octopus - ',
  'Other payments - 1,417',
  'Electric bill - 500'
].join('\n');

test('buildNoteText reproduces the spec sample EXACTLY', () => {
  const { ctx } = load();
  const note = ctx.buildNoteText('Tañong', '2025-07-01', '2025-07-15', {
    total: 11857, cash: 10530, gcash: 1327,
    mama: 500, split: 4000, per_partner: 2000,
    supplies: 5440, octopus: 0, other: 1417, electric: 500
  });
  assert.strictEqual(note, SPEC_NOTE);
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
function seedSpecPeriod(ctx, token) {
  // Two days totalling 11,857 with GCash totalling 1,327. GCash is COMPUTED
  // server-side now, so it is produced here by the custom order's GCash part
  // (customGcash) rather than typed in.
  const days = [
    { date: '2025-07-03', gcashPart: 1000, custom: 6000 },
    { date: '2025-07-10', gcashPart: 327, custom: 5857 }
  ];
  days.forEach((d, i) => {
    const res = post(ctx, {
      token, action: 'saveDay',
      payload: {
        date: d.date, closed: false, staff: 'Mama',
        customAmount: d.custom, customGcash: d.gcashPart,
        notes: '', counts: [], entryId: 'day-' + i
      }
    });
    assert.strictEqual(res.ok, true, 'saveDay failed: ' + res.error);
  });
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
  assert.strictEqual(f.split, 4000); // residual
  assert.strictEqual(f.per_partner, 2000);
  // Accounting identity
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total, f.mama + f.split + f.supplies + f.octopus + f.other + f.electric);
  // Exact note text
  assert.strictEqual(res.data.note_text, SPEC_NOTE);
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
  assert.strictEqual(rows[1][6], 3200, 'split recomputed (4000 - 800)');
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

test('setupSheet is idempotent (re-run keeps token, no duplicate seeds)', () => {
  const { ctx, ss, token } = freshSetup();
  const token2 = ctx.setupSheet();
  assert.strictEqual(token2, token, 'token must survive a re-run');
  const settings = ss.getSheetByName('Settings').getDataRange().getValues();
  const keys = settings.slice(1).map(r => r[0]);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate settings keys');
  const prices = ss.getSheetByName('Prices').getDataRange().getValues();
  assert.strictEqual(prices.length - 1, 3, 'still exactly 3 seed prices (box4/6/10, no drinks)');
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
    regular_qty: 3, amount: 320, gcash_amount: 50
  }]);
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
  const { ctx } = freshSetup();
  const r = post(ctx, { token: 'wrong', action: 'ping', payload: {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Invalid token/);
  const g = JSON.parse(ctx.doGet({}).getContent());
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.data.name, 'octogo-api');
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
  assert.deepStrictEqual(r.data.supplyItems, [], 'no SupplyItems tab yet -> empty list, not a crash');
  assert.deepStrictEqual(r.data.dailySupplies, []);
  assert.deepStrictEqual(r.data.stockUsage, []);
});

test('setupSheet APPENDS the new columns and moves nothing', () => {
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  const token = ctx.setupSheet();
  assert.strictEqual(token, LEGACY_TOKEN, 'the live token must survive the migration');

  const counts = ss.getSheetByName('DailyCounts').getDataRange().getValues();
  assert.deepStrictEqual(counts[0],
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount']),
    'new DailyCounts columns must be appended to the RIGHT, in schema order');
  assert.deepStrictEqual(counts[1].slice(0, 9), OLD_COUNT_ROWS[0], 'existing cells must not shift');
  assert.deepStrictEqual(counts[2].slice(0, 9), OLD_COUNT_ROWS[1]);
  assert.deepStrictEqual(counts[1].slice(9), ['', '', ''], 'new cells start blank (= all cash)');

  const log = ss.getSheetByName('DailyLog').getDataRange().getValues();
  assert.deepStrictEqual(log[0], OLD_LOG_HEADERS.concat(['custom_gcash']));
  assert.deepStrictEqual(log[1].slice(0, 10), OLD_LOG_ROW);

  const prices = ss.getSheetByName('Prices').getDataRange().getValues();
  assert.strictEqual(prices[1][4], 55, "the owner's edited Box 4 price must survive");
  assert.strictEqual(prices.length - 1, 3, 'no duplicate price rows');
});

test('setupSheet creates and seeds the four new tabs', () => {
  const ss = legacySpreadsheet();
  const { ctx } = load(ss);
  ctx.setupSheet();

  const si = ss.getSheetByName('SupplyItems').getDataRange().getValues();
  assert.deepStrictEqual(si[0], ['item', 'active', 'sort']);
  assert.deepStrictEqual(si.slice(1).map(r => r[0]), [
    'Veggies', 'Egg', 'Ginger', 'Water', 'Flour', 'Tissue', 'Toothpick',
    'Fork', 'Bag #3', 'Bag #6', 'Bag #16', 'Cheese', 'Rags', 'Fare'
  ]);
  si.slice(1).forEach(r => assert.strictEqual(r[1], true, 'seeded supply items are active'));

  const st = ss.getSheetByName('StockItems').getDataRange().getValues();
  assert.deepStrictEqual(st[0], ['product', 'unit', 'active', 'sort']);
  assert.deepStrictEqual(st.slice(1).map(r => [r[0], r[1]]), [
    ['Takoyaki Flour', 'kg'], ['Takoyaki Sauce', 'gal'], ['Japanese Mayo', 'kg'],
    ['Bonito', 'g'], ['Aonori', 'g'], ['Togarashi', 'g']
  ]);

  assert.deepStrictEqual(ss.getSheetByName('DailySupplies').getDataRange().getValues()[0],
    ['date', 'item', 'amount', 'entry_id', 'updated_at']);
  assert.deepStrictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues()[0],
    ['date', 'product', 'qty', 'entry_id', 'updated_at']);
  // Newly appended/created date + timestamp columns get the plain-text format.
  assert.strictEqual(ss.getSheetByName('DailySupplies').columnFormats[1], '@');
  assert.strictEqual(ss.getSheetByName('DailySupplies').columnFormats[5], '@');
  assert.strictEqual(ss.getSheetByName('StockUsage').columnFormats[1], '@');
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
  assert.deepStrictEqual(fresh, ['2026-07-22', 'box6', 10, 4, 6, 1, 2, 420, 'new-day-1', 2, 1, 210]);
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
      supplies: [{ item: 'Veggies', amount: 120 }],
      stock: [{ product: 'Bonito', qty: 50 }],
      entryId: 'heal-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 260);
  assert.strictEqual(r.data.gcash, 65);
  assert.strictEqual(r.data.supplies_total, 120);
  // The tabs and columns it needed were created/appended on the fly...
  assert.deepStrictEqual(ss.getSheetByName('DailyCounts').getDataRange().getValues()[0],
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount']));
  assert.deepStrictEqual(ss.getSheetByName('DailySupplies').getDataRange().getValues().slice(1),
    [['2026-07-22', 'Veggies', 120, 'heal-1', ss.getSheetByName('DailySupplies').getDataRange().getValues()[1][4]]]);
  assert.strictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues()[1][2], 50);
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
    OLD_COUNT_HEADERS.concat(['owner_note', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount']),
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
    ['2026-07-23', 'box6', 3, 0, 3, 0, 2, 195, 'hand-1', '', 1, 0, 65]);
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
  assert.deepStrictEqual(row.slice(5), [2, 4, 530, 'buckets-1', 3, 1, 210],
    'cheese_qty, regular_qty, amount, entry_id, gcash_qty, gcash_cheese_qty, gcash_amount');
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

test('supplies: only non-zero rows are written, duplicate/negative/blank rejected', () => {
  const { ctx, ss, token } = freshSetup();
  let r = saveDay(ctx, token, {
    counts: [],
    supplies: [{ item: 'Veggies', amount: 120 }, { item: 'Egg', amount: 0 }, { item: 'Fare', amount: 30 }],
    entryId: 'sup-1'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.supplies_total, 150);
  const rows = ss.getSheetByName('DailySupplies').getDataRange().getValues().slice(1);
  assert.deepStrictEqual(rows.map(x => [x[0], x[1], x[2]]),
    [['2026-07-30', 'Veggies', 120], ['2026-07-30', 'Fare', 30]], 'a zero item gets no row');

  // The picklist is ADVISORY (D1): an item that is not on it is still accepted.
  r = saveDay(ctx, token, { counts: [], supplies: [{ item: 'Truffle Oil', amount: 5 }], entryId: 'sup-2' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.supplies_total, 5);
  // ...but the real validation still holds.
  r = saveDay(ctx, token, { counts: [], supplies: [{ item: 'Egg', amount: 5 }, { item: 'Egg', amount: 6 }], entryId: 'sup-3' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /Duplicate supplies rows/);
  r = saveDay(ctx, token, { counts: [], supplies: [{ item: 'Egg', amount: -5 }], entryId: 'sup-4' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /amount cannot be negative/);
  r = saveDay(ctx, token, { counts: [], supplies: [{ item: '   ', amount: 5 }], entryId: 'sup-5' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /missing its item name/);
});

test('stock: quantities may be fractional and are never money', () => {
  const { ctx, ss, token } = freshSetup();
  let r = saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0 }],
    stock: [{ product: 'Takoyaki Flour', qty: 1.5 }, { product: 'Bonito', qty: 0 }],
    entryId: 'stk-1'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 200, 'stock never adds to the day total');
  const rows = ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1);
  assert.deepStrictEqual(rows.map(x => [x[1], x[2]]), [['Takoyaki Flour', 1.5]]);
  // Advisory picklist again (D1): an unlisted product is accepted, not refused.
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Wasabi', qty: 1 }], entryId: 'stk-2' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 0, 'and it is still not money');
  r = saveDay(ctx, token, { counts: [], stock: [{ product: 'Bonito', qty: -1 }], entryId: 'stk-3' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /quantity cannot be negative/);
  r = saveDay(ctx, token, { counts: [], stock: [{ product: ' ', qty: 1 }], entryId: 'stk-4' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /missing its product name/);
});

test('re-saving a date rewrites only that date in DailySupplies (write, then clear surplus)', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-29', counts: [],
    supplies: [{ item: 'Veggies', amount: 10 }, { item: 'Egg', amount: 20 }, { item: 'Fare', amount: 30 }],
    entryId: 'a'
  }).ok, true);
  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-30', counts: [],
    supplies: [{ item: 'Water', amount: 40 }, { item: 'Flour', amount: 50 }],
    entryId: 'b'
  }).ok, true);
  const sh = ss.getSheetByName('DailySupplies');
  assert.strictEqual(sh.getDataRange().getValues().length - 1, 5);
  sh.log.length = 0;

  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-29', counts: [], supplies: [{ item: 'Veggies', amount: 99 }], entryId: 'a2'
  }).ok, true);

  const rows = sh.getDataRange().getValues().slice(1).filter(r => r.some(c => c !== '' && c !== null));
  assert.strictEqual(rows.length, 3, "2026-07-29's 3 rows became 1; the other date keeps its 2");
  assert.deepStrictEqual(rows.filter(r => r[0] === '2026-07-29').map(r => [r[1], r[2]]), [['Veggies', 99]]);
  assert.deepStrictEqual(rows.filter(r => r[0] === '2026-07-30').map(r => [r[1], r[2]]),
    [['Water', 40], ['Flour', 50]], 'another date must never be touched');
  const ops = sh.log.filter(e => e.op === 'setValues' || e.op === 'clearContent');
  const firstWrite = ops.findIndex(e => e.op === 'setValues');
  const firstClear = ops.findIndex(e => e.op === 'clearContent');
  assert.ok(firstWrite !== -1 && firstClear > firstWrite, 'setValues must precede clearContent');
  assert.ok(ops[firstClear].r0 >= ops[firstWrite].r0 + ops[firstWrite].nRows,
    'the clear must start strictly below the written block');
});

test('a closed day clears that date\'s supplies and stock too', () => {
  const { ctx, ss, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, {
    date: '2026-07-29', counts: [], supplies: [{ item: 'Egg', amount: 20 }],
    stock: [{ product: 'Bonito', qty: 5 }], entryId: 'keep'
  }).ok, true);
  assert.strictEqual(saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 5, eod: 0 }], supplies: [{ item: 'Egg', amount: 20 }],
    stock: [{ product: 'Bonito', qty: 5 }], entryId: 'wipe-me'
  }).ok, true);
  const r = saveDay(ctx, token, { closed: true, counts: [], supplies: [{ item: 'Egg', amount: 20 }], stock: [{ product: 'Bonito', qty: 5 }], entryId: 'closed-day' });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 0);
  assert.strictEqual(r.data.supplies_total, 0);
  const sup = ss.getSheetByName('DailySupplies').getDataRange().getValues().slice(1).filter(x => x[0] === '2026-07-30');
  const stk = ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1).filter(x => x[0] === '2026-07-30');
  assert.strictEqual(sup.length, 0);
  assert.strictEqual(stk.length, 0);
  // the other date is untouched
  assert.strictEqual(ss.getSheetByName('DailySupplies').getDataRange().getValues().slice(1)
    .filter(x => x[0] === '2026-07-29').length, 1);
});

test('replaying a saveDay with supplies and stock does not duplicate rows', () => {
  const { ctx, ss, token } = freshSetup();
  const payload = {
    counts: [{ sku: 'box4', sod: 5, eod: 0, gcashQty: 1 }],
    supplies: [{ item: 'Egg', amount: 20 }], stock: [{ product: 'Bonito', qty: 5 }],
    entryId: 'replay-1'
  };
  const r1 = saveDay(ctx, token, payload);
  const r2 = saveDay(ctx, token, payload);
  assert.strictEqual(r1.ok, true, r1.error);
  assert.deepStrictEqual(r1.data, r2.data, 'replay returns identical computed result');
  assert.strictEqual(ss.getSheetByName('DailySupplies').getDataRange().getValues().length - 1, 1);
  assert.strictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues().length - 1, 1);
  assert.strictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues().length - 1, 1);
});

test('bootstrap returns supplyItems, stockItems, dailySupplies and stockUsage', () => {
  const { ctx, token } = freshSetup();
  assert.strictEqual(saveDay(ctx, token, {
    counts: [], supplies: [{ item: 'Egg', amount: 20 }], stock: [{ product: 'Bonito', qty: 5 }], entryId: 'boot-1'
  }).ok, true);
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.supplyItems.length, 14);
  assert.deepStrictEqual(r.data.supplyItems[0], { item: 'Veggies', active: true, sort: 1 });
  assert.strictEqual(r.data.stockItems.length, 6);
  assert.deepStrictEqual(r.data.dailySupplies.map(x => [x.date, x.item, x.amount]), [['2026-07-30', 'Egg', 20]]);
  assert.deepStrictEqual(r.data.stockUsage.map(x => [x.date, x.product, x.qty]), [['2026-07-30', 'Bonito', 5]]);
  // Same window as counts: a supplies row for a date with no DailyLog row is
  // outside the window and is not shipped.
  assert.ok(r.data.dailySupplies.every(x => r.data.days.some(d => d.date === x.date)));
});

test('cutoff Supplies = Expenses(Supplies) + DailySupplies, identity still balances', () => {
  const { ctx, token } = freshSetup();
  seedSpecPeriod(ctx, token); // total 11,857 / gcash 1,327 / Supplies expense 5,440
  // The owner also logged small daily buys on two days inside the period.
  assert.strictEqual(saveDay(ctx, token, {
    date: '2025-07-03', customAmount: 6000, customGcash: 1000, counts: [],
    supplies: [{ item: 'Veggies', amount: 200 }, { item: 'Egg', amount: 100 }], entryId: 'day-0'
  }).ok, true);
  assert.strictEqual(saveDay(ctx, token, {
    date: '2025-07-10', customAmount: 5857, customGcash: 327, counts: [],
    supplies: [{ item: 'Fare', amount: 60 }], entryId: 'day-1'
  }).ok, true);
  // ...and one OUTSIDE the period, which must not count.
  assert.strictEqual(saveDay(ctx, token, {
    date: '2025-07-20', counts: [], supplies: [{ item: 'Water', amount: 999 }], entryId: 'day-out'
  }).ok, true);

  const r = post(ctx, { token, action: 'cutoff', payload: { start: '2025-07-01', end: '2025-07-15', dryRun: true } });
  assert.strictEqual(r.ok, true, r.error);
  const f = r.data.figures;
  assert.strictEqual(f.supplies, 5440 + 360, 'bulk Expenses(Supplies) + the daily buys');
  assert.strictEqual(f.total, 11857, 'daily supplies are spending, not sales');
  assert.strictEqual(f.split, 4000 - 360, 'Split absorbs the bigger Supplies figure as the residual');
  assert.strictEqual(f.per_partner, (4000 - 360) / 2);
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total, f.mama + f.split + f.supplies + f.octopus + f.other + f.electric,
    'the verified accounting identity must still hold');
  // Format is untouched: only the Supplies figure got bigger.
  assert.strictEqual(r.data.note_text, SPEC_NOTE
    .replace('Supplies - 5,440', 'Supplies - 5,800')
    .replace('Split - 4,000(2,000 each)', 'Split - 3,640(1,820 each)'));
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
    OLD_COUNT_HEADERS.concat(['', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount']),
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
  // gcash_qty / gcash_cheese_qty / gcash_amount live in columns 11-13 here.
  assert.deepStrictEqual(v.slice(1).find(x => x[0] === '2026-07-23'),
    ['2026-07-23', 'box6', 3, 0, 3, 0, 2, 195, 'b1-save', '', 1, 0, 65]);
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
    ['', '', '', 'gcash_qty', 'gcash_cheese_qty', 'gcash_amount'],
    'columns 10-12 stay blank-headed; the schema lands at 13-15');
  assert.strictEqual(v[2][11], 'ANO ITO', 'a stray value must not be relabelled either');
  assert.strictEqual(post(ctx, { token: LEGACY_TOKEN, action: 'bootstrap', payload: {} })
    .data.counts.find(c => c.sku === 'box4').amount, 520);
});

// ---------------------------------------------------------------------------
// 12. B2 / D1 — the SupplyItems and StockItems picklists are ADVISORY.
//
// They used to be enforced like foreign keys, so the moment the owner renamed
// or deleted a picklist row, every day that referenced it became permanently
// un-saveable — INCLUDING its sales — with no way out from the phone.
// ---------------------------------------------------------------------------
console.log('\n--- 12. Advisory picklists (D1): a renamed item never blocks a day ---');

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

function suppliesFor(ss, date) {
  return ss.getSheetByName('DailySupplies').getDataRange().getValues().slice(1)
    .filter(r => r[0] === date).map(r => [r[1], r[2]]);
}

test('B2: a day that references a RENAMED supply item still saves', () => {
  const { ctx, ss, token } = freshSetup();
  // Mama entered the day while the picklist still said "Veggies"...
  assert.strictEqual(saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0 }],
    supplies: [{ item: 'Veggies', amount: 120 }], entryId: 'ren-1'
  }).ok, true);
  // ...then the owner renamed that row in the sheet.
  renameFirstCol(ss, 'SupplyItems', 'Veggies', 'Gulay');

  const r = saveDay(ctx, token, {
    counts: [{ sku: 'box4', sod: 4, eod: 0, cheeseQty: 1 }],
    supplies: [{ item: 'Veggies', amount: 150 }], entryId: 'ren-1'
  });
  assert.strictEqual(r.ok, true,
    'the whole day — sales included — became un-saveable: ' + r.error);
  assert.strictEqual(r.data.supplies_total, 150);
  assert.strictEqual(r.data.total, 3 * 50 + 60, 'the sales half of the day must be intact');
  assert.deepStrictEqual(suppliesFor(ss, '2026-07-30'), [['Veggies', 150]],
    'the name the day was entered with is what gets stored');
  assert.strictEqual(ss.getSheetByName('SupplyItems').getDataRange().getValues().length - 1, 14,
    'accepting a name must NOT silently add it to the picklist');
});

test('B2: a DELETED stock product still saves; names are trimmed', () => {
  const { ctx, ss, token } = freshSetup();
  deleteFirstColRow(ss, 'StockItems', 'Bonito');
  const r = saveDay(ctx, token, {
    counts: [], stock: [{ product: '  Bonito  ', qty: 250 }],
    supplies: [{ item: '  Egg  ', amount: 40 }], entryId: 'ren-2'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(ss.getSheetByName('StockUsage').getDataRange().getValues().slice(1)
    .map(x => [x[1], x[2]]), [['Bonito', 250]], 'stored trimmed, exactly as entered');
  assert.deepStrictEqual(suppliesFor(ss, '2026-07-30'), [['Egg', 40]]);
  assert.strictEqual(ss.getSheetByName('StockItems').getDataRange().getValues().length - 1, 5,
    'the picklist is not extended behind the owner’s back');
});

test('B2: trimmed names still collide, and the other checks still bite', () => {
  const { ctx, token } = freshSetup();
  let r = saveDay(ctx, token, {
    counts: [], supplies: [{ item: 'Egg', amount: 5 }, { item: ' Egg ', amount: 6 }], entryId: 'ren-3'
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /Duplicate supplies rows/);
  r = saveDay(ctx, token, {
    counts: [], stock: [{ product: 'Bonito', qty: 1 }, { product: ' Bonito ', qty: 2 }], entryId: 'ren-4'
  });
  assert.strictEqual(r.ok, false); assert.match(r.error, /Duplicate stock rows/);
  r = saveDay(ctx, token, { counts: [], supplies: [{ item: 'Gulay', amount: -1 }], entryId: 'ren-5' });
  assert.strictEqual(r.ok, false); assert.match(r.error, /amount cannot be negative/);
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
 *  every day carries sales, counts, daily supplies, stock usage and an expense. */
function historySpreadsheet() {
  const { ctx, ss, token } = freshSetup();
  const dates = [OUT_OF_WINDOW].concat(IN_WINDOW);
  const stamp = '2026-08-01 20:00:00';
  pushRows(ss, 'DailyLog', dates.map(d => [d, false, 'Mama', 0, 100, 100, 0, '', 'log-' + d, stamp, 0]));
  pushRows(ss, 'DailyCounts', dates.map(d => [d, 'box4', 2, 0, 2, 0, 2, 100, 'log-' + d, 0, 0, 0]));
  pushRows(ss, 'DailySupplies', dates.map(d => [d, 'Egg', 10, 'log-' + d, stamp]));
  pushRows(ss, 'StockUsage', dates.map(d => [d, 'Bonito', 5, 'log-' + d, stamp]));
  pushRows(ss, 'Expenses', dates.map(d => [d, 'Supplies', 'harina', 50, '', '', 'exp-' + d, stamp]));
  return { ctx, ss, token };
}

test('B3: days, counts, supplies, stock and expenses all cover the SAME window', () => {
  const { ctx, token } = historySpreadsheet();
  const r = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(r.ok, true, r.error);

  assert.deepStrictEqual(r.data.days.map(d => d.date), IN_WINDOW,
    'every day inside the 90-day window must ship, in date order');
  assert.strictEqual(r.data.days.length, WINDOW_DAYS,
    'the old cap was the last 45 ROWS, so the 15 oldest days went missing');
  ['counts', 'dailySupplies', 'stockUsage', 'expenses'].forEach(k => {
    assert.deepStrictEqual(r.data[k].map(x => x.date), IN_WINDOW,
      k + ' covers a different window than days — a cutoff preview would understate a period');
  });
  ['days', 'counts', 'dailySupplies', 'stockUsage', 'expenses'].forEach(k => {
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
  assert.strictEqual(r.data.dailySupplies.filter(inOlder).reduce((s, x) => s + x.amount, 0), 150);
  assert.strictEqual(r.data.expenses.filter(inOlder).reduce((s, x) => s + x.amount, 0), 750);
  assert.strictEqual(r.data.counts.filter(inOlder).length, 15);
  assert.strictEqual(r.data.stockUsage.filter(inOlder).length, 15);

  // What the Cutoff screen would compute for that period, both ways round:
  // Split = Total - Supplies. With sales missing it read -900 instead of +600.
  const total = sales.reduce((s, d) => s + d.total, 0);
  const supplies = r.data.expenses.filter(inOlder).reduce((s, x) => s + x.amount, 0)
    + r.data.dailySupplies.filter(inOlder).reduce((s, x) => s + x.amount, 0);
  assert.strictEqual(total - supplies, 600);
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
    supplies: [{ item: 'Egg', amount: 20 }],
    entryId: 'drop-2'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.data.dropped_skus, ['box6', 'box10'], 'once each, in payload order');
  assert.deepStrictEqual(r.data.lines.map(l => l.sku), ['box4']);
  assert.strictEqual(r.data.total, 200);
  assert.strictEqual(r.data.gcash, 50);
  assert.strictEqual(r.data.supplies_total, 20, 'the rest of the day saved normally');
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
console.log('\n============================================');
console.log('  ' + passed + ' passed, ' + failed + ' failed');
console.log('============================================');
if (failed > 0) {
  failures.forEach(f => console.error('\nFAILED: ' + f.name + '\n' + f.err.stack));
  process.exit(1);
}
