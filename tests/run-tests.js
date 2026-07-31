'use strict';
// Throwaway verification harness: loads the REAL Code.gs into a vm context
// with Apps Script stubs and exercises the reviewed logic.

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const { FakeSheet, FakeSpreadsheet, makeContext } = require('./gas-stubs');

const CODE_GS = '/Users/naytsantos/Claude/Web App/apps-script/Code.gs';
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
  // Two days totalling 11,857 with GCash totalling 1,327.
  const days = [
    { date: '2025-07-03', gcash: 1000, custom: 6000 },
    { date: '2025-07-10', gcash: 327, custom: 5857 }
  ];
  days.forEach((d, i) => {
    const res = post(ctx, {
      token, action: 'saveDay',
      payload: {
        date: d.date, closed: false, staff: 'Mama', gcash: d.gcash,
        customAmount: d.custom, notes: '', counts: [], entryId: 'day-' + i
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
      date: '2026-07-30', closed: false, staff: 'Mama', gcash: 100, customAmount: 50, notes: '',
      counts: [{ sku: 'box4', sod: 10, eod: 4, cheeseQty: 2 }], // sold 6: 2 cheese @60 + 4 reg @50 = 320
      entryId: 'figures-1'
    }
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 370); // 320 + 50 custom
  assert.strictEqual(r.data.cash, 270);  // 370 - 100 gcash
  assert.deepStrictEqual(r.data.lines, [{ sku: 'box4', sold: 6, cheese_qty: 2, regular_qty: 4, amount: 320 }]);
  const row = countsRowsFor(ss.getSheetByName('DailyCounts'), '2026-07-30')[0];
  assert.strictEqual(row[7], 320, 'amount snapshotted on the row');
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

test('saveDay validations still enforced (EOD<=SOD, cheese<=sold, gcash<=total)', () => {
  const { ctx, token } = freshSetup();
  const base = { date: '2026-07-30', closed: false, staff: '', gcash: 0, customAmount: 0, notes: '', entryId: 'v' };
  let r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { counts: [{ sku: 'box4', sod: 3, eod: 5, cheeseQty: 0 }] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /EOD .* cannot be greater than SOD/);
  r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { counts: [{ sku: 'box4', sod: 5, eod: 3, cheeseQty: 4 }] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /cheese qty .* cannot exceed sold/);
  r = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, { gcash: 9999, counts: [{ sku: 'box4', sod: 5, eod: 3, cheeseQty: 0 }] }) });
  assert.strictEqual(r.ok, false); assert.match(r.error, /GCash .* cannot exceed total/);
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
console.log('\n============================================');
console.log('  ' + passed + ' passed, ' + failed + ' failed');
console.log('============================================');
if (failed > 0) {
  failures.forEach(f => console.error('\nFAILED: ' + f.name + '\n' + f.err.stack));
  process.exit(1);
}
