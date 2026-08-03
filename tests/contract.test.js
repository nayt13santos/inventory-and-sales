#!/usr/bin/env node
'use strict';
/* ===========================================================================
   CROSS-SEAM CONTRACT TEST  (server response shape  <->  PWA readers)
   ===========================================================================
   This is the test that was missing. The backend suite exercises Code.gs in
   isolation; the PWA tests only ever saw locally-seeded, client-shaped data.
   Nothing joined the two, so the day the Apps Script started answering
   `cheesePrice` while the phone read `cheese_price`, every cheese line
   silently became 0 and no test noticed.

   What this does:
     1. Loads the REAL /apps-script/Code.gs into the Apps Script stubs and
        runs setupSheet().
     2. Saves a real day through the REAL doPost (cheese quantities + a custom
        order), a real Backlog expense, and asks for a real bootstrap.
     3. Extracts the REAL normalizers / applyBootstrap / loadBentaForm /
        bentaPayload / computeDay / backlogBalance / applyServerDay out of
        /pwa/index.html and feeds them those actual JSON responses.
     4. Asserts on MONEY, not on shapes: Box 4 sold 10 / cheese 2 must produce
        a 2 x 60 = 120 cheese line and a day total that contains it; the custom
        order must survive; a Backlog payment must reduce that backlog's
        balance; counts must round-trip their cheese/regular split.
     5. Additionally pins the contract in both directions (section 7):
        - every response object MUST carry the snake_case key and MUST NOT
          carry the camelCase one  -> a server that regresses fails here;
        - the client normalizers must also still cope with a legacy
          camelCase-only server -> the compatibility fallback is tested too.

   Run:  node contract.test.js        (or: node run-all.js for both suites)
   =========================================================================== */

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const { FakeSheet, FakeSpreadsheet, makeContext, formatDate, FIXED_NOW } = require('./gas-stubs');

/** yyyy-MM-dd for "n days ago", in Asia/Manila, off the SAME frozen clock the
 *  stubbed server uses for its 90-day bootstrap window — so a fixture meant to
 *  sit inside that window stays inside it whatever day the suite is run. */
function ymdDaysAgo(n) {
  return formatDate(new Date(FIXED_NOW.getTime() - n * 86400000), 'Asia/Manila', 'yyyy-MM-dd');
}

// Resolved from this file's location so the suite runs anywhere — a developer
// machine or a CI runner. Absolute paths made CI fail on the first push.
const ROOT = path.resolve(__dirname, '..');
const CODE_GS = path.join(ROOT, 'apps-script', 'Code.gs');
const INDEX_HTML = path.join(ROOT, 'pwa', 'index.html');

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

// ---------------------------------------------------------------------------
// SERVER SIDE — the real Code.gs, the real doPost.
// ---------------------------------------------------------------------------

function loadServer() {
  const ss = new FakeSpreadsheet();
  const ctx = makeContext(ss);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), ctx, { filename: 'Code.gs' });
  const token = ctx.setupSheet();
  return { ctx, ss, token };
}

function post(ctx, body) {
  const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.getContent());
}

// ---------------------------------------------------------------------------
// CLIENT SIDE — the real functions, lifted out of the shipped index.html.
//
// Slabs are delimited by unique source markers rather than line numbers, so
// the extraction fails loudly (marker not found / not unique) instead of
// quietly testing nothing after an unrelated edit moves code around.
// ---------------------------------------------------------------------------

const HTML = fs.readFileSync(INDEX_HTML, 'utf8');

/** Locate a marker, ignoring how much WHITESPACE sits between its tokens.
 *  The markers are lines of real PWA source, so re-aligning an assignment
 *  ("let state  =" -> "let state     =") used to break the extraction and take
 *  the whole cross-seam suite down with it — a formatting change must not read
 *  as "the contract is broken". Still fails loudly when a marker is missing or
 *  ambiguous, which is the guard that matters. */
function at(marker) {
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'g');
  const hits = [];
  let m;
  while ((m = re.exec(HTML)) !== null) {
    hits.push(m.index);
    re.lastIndex = m.index + 1;
  }
  if (hits.length === 0) throw new Error('marker not found in index.html: ' + JSON.stringify(marker));
  if (hits.length > 1) {
    throw new Error('marker is not unique in index.html: ' + JSON.stringify(marker));
  }
  return hits[0];
}
function slab(startMarker, endMarker) {
  const s = at(startMarker);
  const e = at(endMarker);
  if (e <= s) throw new Error('markers out of order: ' + startMarker + ' .. ' + endMarker);
  return HTML.slice(s, e);
}

// Storage/loader helpers + ALL FIVE normalizers + sanitizers + ensureShape.
const S_LOADERS   = slab('function readStored(k){', "let state  = sanitizeState(readStored('state_v1'));");
// Dates, money formatting, num/txt/truthy, activePrices, staffList.
const S_UTILS     = slab('const EN_MONTHS  =', 'function computeDay(p){');
// computeDay, currentPeriod, computeCutoff, buildNote.
const S_DOMAIN    = slab('function computeDay(p){', 'function invalidateNoteFor(date){');
// applyLocalDay / applyLocalExpense / reapplyQueue (queue AND attention).
const S_APPLIERS  = slab('function invalidateNoteFor(date){', 'function enqueue(action, payload){');
// The needs-attention list: what did NOT reach the sheet, and what may be said
// about a date because of it.
const S_ATTN      = slab('function noteAttention(kind, action, payload, message){', 'function isLegacyGcashPayload(p){');
// applyServerDay — consumes the saveDay RESPONSE.
const S_SERVERDAY = slab('function applyServerDay(p, data){', 'async function doBootstrap(){');
// applyBootstrap (runs every row through the normalizers) + backlogBalance.
const S_BOOTSTRAP = slab('function applyBootstrap(data){', "let activeTab = 'benta';");
// The Sales form: reads a stored day back out, and re-emits the request payload.
const S_FORM      = slab('function loadBentaForm(date){', '// SKU list to render:');
// The two collapsible Sales cards (wage + stock used) as HTML STRINGS: what is
// escaped, what is collapsed, and what the head says while it is closed.
const S_CARDS     = slab('const CHEV =', 'const COLLAPSE_FLAG =');
// The Maintenance price rule — a sku still being sold must have a real price.
const S_MAINT     = slab('function priceRowError(pr, m){', 'function saveMaintPrices(){');

function loadClient() {
  const src = `
'use strict';
const store = { read(){ return null; }, set(){} };
${S_LOADERS}
${S_UTILS}
${S_DOMAIN}
${S_APPLIERS}
${S_ATTN}
${S_SERVERDAY}
${S_BOOTSTRAP}
${S_FORM}
${S_CARDS}
${S_MAINT}
let state = freshState();
let queue = [];
let config = freshConfig();
// The app's other persisted stores. ensureShape() (inside S_LOADERS) normalizes
// every one of them, so each must exist here or the whole client fails to load.
let attention = [];
let drafts = {};
let lastNote = null;
let benta = null;
function persistState(){}
function persistQueue(){}
function persistConfig(){}
function persistAttention(){}
function persistDrafts(){}
// Chrome the extracted slabs call but that has no DOM here.
function updateStatus(){}
function toast(){}
return {
  get state(){ return state; },
  get benta(){ return benta; },
  get queue(){ return queue; },
  get attention(){ return attention; },
  set attention(v){ attention = v; },
  get splitEdits(){ return splitEdits; },
  pick, normPrice, normBacklog, normDay, normCount, normExpense, normStockItem,
  applyBootstrap, applyLocalDay, applyLocalExpense, applyLocalStockCount,
  applyLocalCutoffSplit, applyLocalPrices, applyServerDay, reapplyQueue,
  backlogBalance,
  loadBentaForm, bentaPayload, computeDay, computeCutoff, buildNote,
  // The stock ledger the phone computes for itself (never stored) and the two
  // figures the cutoff needs from Settings.
  stockStatusOf, stockStatusList, qtyWithUnit, daySalary, splitFor, dailySalary,
  currentPeriod, periodKey, num, fmt, fmtShort, activePrices,
  // v2.3.1: the Split field's one reading, the note guard, what may be said
  // about a refused day, the two collapsible cards, and the price rule.
  splitFieldAmount, liveCutoff, pendingSplit, splitDefault,
  noteAttention, attentionForDate, dateNotInSheet, daySavedMessage,
  stockRowSaid, stockCardHTML, wageCardHTML, wageIsCustom, wageSummary,
  priceRowError,
  // Live refs so a test can put the client in demo / API / still-queued states.
  // enqueue() is not in the extracted slabs, so tests push onto q directly.
  cfg: config, q: queue
};`;
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

// ---------------------------------------------------------------------------
// THE CONTRACT. snake_case is canonical on the wire (it matches the sheet
// headers and state_v1); the camelCase spelling is the legacy one that must
// never come back. Section 7 asserts both halves of every pair.
// ---------------------------------------------------------------------------
const CONTRACT = {
  'bootstrap.prices[]':    [['cheese_price', 'cheesePrice']],
  'bootstrap.days[]':      [['custom_amount', 'customAmount'], ['custom_gcash', 'customGcash'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  'bootstrap.counts[]':    [['cheese_qty', 'cheeseQty'], ['regular_qty', 'regularQty'], ['gcash_qty', 'gcashQty'], ['gcash_cheese_qty', 'gcashCheeseQty'], ['gcash_amount', 'gcashAmount'], ['entry_id', 'entryId']],
  'bootstrap.expenses[]':  [['backlog_ref', 'backlogRef'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt'], ['stock_product', 'stockProduct'], ['stock_qty', 'stockQty']],
  'bootstrap.backlogs[]':  [['total_amount', 'totalAmount'], ['start_date', 'startDate']],
  'bootstrap.stockUsage[]':    [['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  // v2.3.0 stock ledger. on_hand and the three numbers behind it are COMPUTED
  // server-side, so a camelCase slip here would show the owner ₱0 of stock.
  'bootstrap.stockItems[]':    [['on_hand', 'onHand'], ['reorder_at', 'reorderAt'], ['opening_qty', 'openingQty'], ['opening_date', 'openingDate'], ['baseline_qty', 'baselineQty'], ['baseline_date', 'baselineDate'], ['delivered_since', 'deliveredSince'], ['used_since', 'usedSince']],
  'bootstrap.stockCounts[]':   [['counted_qty', 'countedQty'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  'bootstrap.cutoffInputs[]':  [['split_amount', 'splitAmount'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  // `supplies_total` is gone with the retired supplies card; dropped_skus is the
  // saveDay key the phone still has to read.
  'saveDay':               [['dropped_skus', 'droppedSkus']],
  'saveDay.lines[]':       [['cheese_qty', 'cheeseQty'], ['regular_qty', 'regularQty'], ['gcash_qty', 'gcashQty'], ['gcash_cheese_qty', 'gcashCheeseQty'], ['gcash_amount', 'gcashAmount']],
  'saveExpense':           [['entry_id', 'entryId']],
  'saveStockCount':        [['entry_id', 'entryId'], ['on_hand', 'onHand']],
  'saveCutoffSplit':       [['entry_id', 'entryId'], ['split_amount', 'splitAmount'], ['per_partner', 'perPartner']],
  'cutoff':                [['note_text', 'noteText']],
  'cutoff.figures':        [['per_partner', 'perPartner']],
  'bootstrap.lastCutoff':  [['per_partner', 'perPartner'], ['note_text', 'noteText'], ['generated_at', 'generatedAt']]
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Assert one response object (or array of them) carries every canonical
 *  snake_case key and none of the legacy camelCase spellings. Shared by
 *  section 7 and by every later section, so a new fixture gets the same
 *  scrutiny as the original one instead of only being checked for money. */
function assertPairs(where, sample, pairs) {
  const objects = Array.isArray(sample) ? sample : [sample];
  assert.ok(objects.length > 0, where + ' is empty, so this asserts nothing');
  for (const o of objects) {
    assert.ok(o && typeof o === 'object', where + ' is not an object: ' + JSON.stringify(o));
    for (const [snake, camel] of pairs) {
      assert.ok(has(o, snake),
        where + ' is missing "' + snake + '" (keys: ' + Object.keys(o).join(', ') + ')');
      assert.ok(!has(o, camel),
        where + ' regressed to camelCase "' + camel + '" — the PWA reads "' + snake + '" and would see 0');
    }
  }
}

// The ONLY camelCase names the response contract allows: the five bootstrap /
// range CONTAINER keys named in SPEC.md. Everything inside a row must be
// snake_case, because rows are stored verbatim in state_v1.
const CAMEL_CONTAINERS = {
  stockItems: true, stockUsage: true, stockCounts: true, cutoffInputs: true, lastCutoff: true
};

/** Walk a whole response tree and fail on ANY camelCase key. This is the guard
 *  the pairs table cannot give us: it also catches a brand-new field that was
 *  added in camelCase and never listed in CONTRACT. */
function assertNoCamelKeys(label, value, path) {
  const here = path || label;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCamelKeys(label, v, here + '[' + i + ']'));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const k in value) {
    if (/[a-z0-9][A-Z]/.test(k) && !CAMEL_CONTAINERS[k]) {
      assert.fail('camelCase response key "' + k + '" at ' + here +
        ' — the PWA reads snake_case, so this money would render as 0');
    }
    assertNoCamelKeys(label, value[k], here + '.' + k);
  }
}

/** Rewrite a response the way the OLD (pre-fix) Apps Script would have sent
 *  it: every canonical snake_case key renamed to its camelCase legacy name.
 *  Used to prove the client's compatibility fallback actually works. */
function toLegacy(value, pairs) {
  if (Array.isArray(value)) return value.map(v => toLegacy(v, pairs));
  const out = {};
  for (const k in value) {
    const hit = pairs.find(p => p[0] === k);
    out[hit ? hit[1] : k] = value[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// FIXTURE — one real day and one real backlog payment, saved through doPost.
//
//   Box 4  : sod 10, eod  0 -> sold 10, cheese 2 -> 2*60 + 8*50 = 520
//   Box 6  : sod  6, eod  2 -> sold  4, cheese 1 -> 1*80 + 3*65 = 275
//   Box 10 : sod  5, eod  5 -> sold  0                          =   0
//   custom order                                                = 250
//   -------------------------------------------------------------------
//   TOTAL 1,045   GCash 250 (the custom order was paid by GCash)   Cash 795
//
// GCash is COMPUTED server-side from customGcash + the per-sku GCash buckets;
// the stale `gcash: 9999` below is what an old queued payload still carries and
// the server must IGNORE it (asserted in section 4).
// ---------------------------------------------------------------------------
const DAY = '2026-07-30';
const PERIOD = { start: '2026-07-16', end: '2026-07-31' };
const SAVE_DAY_PAYLOAD = {
  date: DAY, closed: false, staff: 'Mama', gcash: 9999,
  customAmount: 250, customGcash: 250,
  notes: 'party tray',
  counts: [
    { sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 0, gcashCheeseQty: 0 },
    { sku: 'box6', sod: 6, eod: 2, cheeseQty: 1, gcashQty: 0, gcashCheeseQty: 0 },
    { sku: 'box10', sod: 5, eod: 5, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }
  ],
  entryId: 'seam-day-1'
};
// Stock usage lives on a day in the PREVIOUS cutoff (1-15), deliberately outside
// PERIOD: the point here is that its rows and keys survive the seam. The money
// rule (cutoff Supplies = Expenses(Supplies) alone) is pinned in run-tests.js.
// Usage is WHOLE UNITS OPENED — one pack of flour, not 1.5 kg of it.
const STOCK_DAY = '2026-07-10';
const STOCK_DAY_PAYLOAD = {
  date: STOCK_DAY, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
  notes: '', counts: [],
  // What a phone that has not been updated yet still sends. The server must
  // ignore it rather than resurrecting the retired tab.
  supplies: [{ item: 'Veggies', amount: 120 }, { item: 'Egg', amount: 80 }],
  stock: [{ product: 'Takoyaki Flour', qty: 2 }],
  entryId: 'seam-stock-1'
};
const BACKLOG_PAYLOAD = {
  date: '2026-07-20', category: 'Backlog', item: 'hulog', amount: 700,
  backlogRef: 'Ref', notes: '', entryId: 'seam-exp-1'
};
// A delivery: money on the expense row, quantity riding along on it.
const DELIVERY_PAYLOAD = {
  date: '2026-07-22', category: 'Supplies', item: 'sako ng harina', amount: 500,
  backlogRef: '', notes: '', stockProduct: 'Takoyaki Flour', stockQty: 4,
  entryId: 'seam-deliv-1'
};
const COUNT_PAYLOAD = {
  date: '2026-07-24', product: 'Bonito', qty: 3, entryId: 'seam-count-1'
};
const SPLIT_PAYLOAD = {
  start: PERIOD.start, end: PERIOD.end, amount: 2000, entryId: 'seam-split-1'
};

const EXPECT = {
  box4Amount: 520, box4Cheese: 2, box4Regular: 8, box4CheeseLine: 120,
  box6Amount: 275,
  total: 1045, gcash: 250, cash: 795, custom: 250, customGcash: 250,
  salary: 200,            // one open day inside PERIOD, at the seeded ₱200
  supplies: 500,          // the delivery's peso amount, counted once
  split: 2000, perPartner: 1000,
  remaining: 1045 - 2000 - 500 - 200 - 700,
  refTotal: 6700, refPaid: 700, refBalance: 6000,
  allBacklogsTotal: 81352, allBacklogsRemaining: 81352 - 700
};

function buildFixture() {
  const { ctx, ss, token } = loadServer();
  const saveDay = post(ctx, { token, action: 'saveDay', payload: SAVE_DAY_PAYLOAD });
  assert.strictEqual(saveDay.ok, true, 'saveDay failed: ' + saveDay.error);
  const stockDay = post(ctx, { token, action: 'saveDay', payload: STOCK_DAY_PAYLOAD });
  assert.strictEqual(stockDay.ok, true, 'saveDay (stock) failed: ' + stockDay.error);
  const saveExpense = post(ctx, { token, action: 'saveExpense', payload: BACKLOG_PAYLOAD });
  assert.strictEqual(saveExpense.ok, true, 'saveExpense failed: ' + saveExpense.error);
  const delivery = post(ctx, { token, action: 'saveExpense', payload: DELIVERY_PAYLOAD });
  assert.strictEqual(delivery.ok, true, 'saveExpense (delivery) failed: ' + delivery.error);
  const stockCount = post(ctx, { token, action: 'saveStockCount', payload: COUNT_PAYLOAD });
  assert.strictEqual(stockCount.ok, true, 'saveStockCount failed: ' + stockCount.error);
  const split = post(ctx, { token, action: 'saveCutoffSplit', payload: SPLIT_PAYLOAD });
  assert.strictEqual(split.ok, true, 'saveCutoffSplit failed: ' + split.error);
  const cutoff = post(ctx, { token, action: 'cutoff', payload: { start: PERIOD.start, end: PERIOD.end, dryRun: false } });
  assert.strictEqual(cutoff.ok, true, 'cutoff failed: ' + cutoff.error);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, 'bootstrap failed: ' + boot.error);
  return {
    ctx, ss, token,
    saveDay: saveDay.data, stockDay: stockDay.data,
    saveExpense: saveExpense.data, delivery: delivery.data,
    stockCount: stockCount.data, split: split.data,
    cutoff: cutoff.data, boot: boot.data
  };
}

/** A fresh PWA that has just booted and synced against the real server. */
function syncedClient(bootData) {
  const app = loadClient();
  app.applyBootstrap(bootData);
  return app;
}

const F = buildFixture();

// ---------------------------------------------------------------------------
console.log('\n--- 1. THE REPORTED BUG: cheese price survives the seam ---');

test('bootstrap price -> normPrice: Box 4 cheese_price is 60, not 0', () => {
  const app = syncedClient(F.boot);
  const box4 = app.state.prices.find(p => p.sku === 'box4');
  assert.ok(box4, 'box4 missing from the normalized prices');
  assert.strictEqual(app.num(box4.price), 50);
  assert.strictEqual(app.num(box4.cheese_price), 60,
    'cheese_price arrived as ' + JSON.stringify(box4.cheese_price) +
    ' — the server key and the client reader have diverged again');
});

test('editing the saved day: cheese line is 2 x 60 = 120 and the total includes it', () => {
  const app = syncedClient(F.boot);
  app.loadBentaForm(DAY);                       // reads the stored (snake_case) counts
  const payload = app.bentaPayload();           // re-emits the camelCase request shape
  const box4Row = payload.counts.find(c => c.sku === 'box4');
  assert.strictEqual(box4Row.cheeseQty, EXPECT.box4Cheese, 'cheese split lost on the way back into the form');

  const c = app.computeDay(payload);
  const line = c.lines.find(l => l.sku === 'box4');
  assert.strictEqual(line.cheese_qty, EXPECT.box4Cheese);
  assert.strictEqual(line.regular_qty, EXPECT.box4Regular);
  assert.strictEqual(line.cheese_qty * app.num(line.cheese_price), EXPECT.box4CheeseLine,
    'the cheese line is worth 0 — the classic symptom');
  assert.strictEqual(line.amount, EXPECT.box4Amount, '2 cheese @60 + 8 regular @50');
  assert.strictEqual(c.lines.find(l => l.sku === 'box6').amount, EXPECT.box6Amount);
  assert.strictEqual(c.total, EXPECT.total, 'day total must contain the cheese money and the custom order');
  assert.strictEqual(c.cash, EXPECT.cash);
});

test('client recomputation agrees with the server total to the peso', () => {
  const app = syncedClient(F.boot);
  app.loadBentaForm(DAY);
  const client = app.computeDay(app.bentaPayload());
  const server = F.boot.days.find(d => d.date === DAY);
  assert.strictEqual(client.total, server.total, 'client ' + client.total + ' vs server ' + server.total);
  assert.strictEqual(client.cash, server.cash);
  assert.strictEqual(client.gcash, server.gcash);
});

// ---------------------------------------------------------------------------
console.log('\n--- 2. Custom orders survive the seam ---');

test('bootstrap day -> normDay: custom_amount 250 kept, entry_id and updated_at kept', () => {
  const app = syncedClient(F.boot);
  const day = app.state.days[DAY];
  assert.ok(day, 'the saved day did not reach the phone at all');
  assert.strictEqual(day.custom_amount, EXPECT.custom, 'the custom order vanished from the phone view');
  assert.strictEqual(day.entry_id, 'seam-day-1');
  assert.ok(day.updated_at, 'updated_at is empty — sorting and conflict display break');
  assert.strictEqual(day.total, EXPECT.total);
  assert.strictEqual(day.cash, EXPECT.cash);
});

test('the custom order is pre-filled when the day is opened for editing', () => {
  const app = syncedClient(F.boot);
  app.loadBentaForm(DAY);
  assert.strictEqual(app.benta.custom, EXPECT.custom);
  assert.strictEqual(app.bentaPayload().customAmount, EXPECT.custom);
  // GCash is no longer typed in, so assert it through the day the form would
  // re-emit rather than through whichever field currently holds it.
  assert.strictEqual(app.computeDay(app.bentaPayload()).gcash, EXPECT.gcash,
    'reopening the day lost the GCash part of the custom order');
});

// ---------------------------------------------------------------------------
console.log('\n--- 3. Counts round-trip their cheese/regular split ---');

test('bootstrap counts -> normCount: cheese_qty/regular_qty/amount all intact', () => {
  const app = syncedClient(F.boot);
  const rows = app.state.counts[DAY] || [];
  const box4 = rows.find(r => r.sku === 'box4');
  assert.ok(box4, 'no box4 counts row reached the phone');
  assert.strictEqual(box4.sold, 10);
  assert.strictEqual(box4.cheese_qty, EXPECT.box4Cheese, 'editing a saved day would lose the cheese split');
  assert.strictEqual(box4.regular_qty, EXPECT.box4Regular);
  assert.strictEqual(box4.amount, EXPECT.box4Amount);
  assert.strictEqual(box4.entry_id, 'seam-day-1');
});

test('the form reloads the exact counts that were saved', () => {
  const app = syncedClient(F.boot);
  app.loadBentaForm(DAY);
  const row = app.benta.rows.find(r => r.sku === 'box4');
  assert.deepStrictEqual(
    { sod: row.sod, eod: row.eod, cheese: row.cheese },
    { sod: 10, eod: 0, cheese: 2 }
  );
});

// ---------------------------------------------------------------------------
console.log('\n--- 4. The saveDay RESPONSE lands correctly (applyServerDay) ---');

test('applyServerDay copies the server split onto the local row instead of zeroing it', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  // Exactly what drainQueue() does: optimistic local write, then the server's
  // authoritative numbers on top.
  app.applyLocalDay(SAVE_DAY_PAYLOAD);
  app.applyServerDay(SAVE_DAY_PAYLOAD, F.saveDay);
  const row = (app.state.counts[DAY] || []).find(r => r.sku === 'box4');
  assert.strictEqual(row.cheese_qty, EXPECT.box4Cheese, 'server response zeroed the cheese split');
  assert.strictEqual(row.regular_qty, EXPECT.box4Regular);
  assert.strictEqual(row.amount, EXPECT.box4Amount);
  assert.strictEqual(app.state.days[DAY].total, EXPECT.total);
  assert.strictEqual(app.state.days[DAY].cash, EXPECT.cash);
});

test('the server-computed saveDay lines match the money the phone showed', () => {
  const box4 = F.saveDay.lines.find(l => l.sku === 'box4');
  assert.strictEqual(box4.cheese_qty, EXPECT.box4Cheese);
  assert.strictEqual(box4.regular_qty, EXPECT.box4Regular);
  assert.strictEqual(box4.amount, EXPECT.box4Amount);
  assert.strictEqual(F.saveDay.total, EXPECT.total);
  assert.strictEqual(F.saveDay.cash, EXPECT.cash);
});

test('the server IGNORES a client-sent gcash and computes it from the buckets', () => {
  // SAVE_DAY_PAYLOAD carries gcash: 9999 the way an old queued payload does.
  assert.strictEqual(F.saveDay.gcash, EXPECT.gcash,
    'a stale typed GCash figure reached the sheet');
  assert.strictEqual(F.saveDay.cash, EXPECT.total - EXPECT.gcash);
  const day = F.boot.days.find(d => d.date === DAY);
  assert.strictEqual(day.gcash, EXPECT.gcash, 'the stored day kept the bogus figure');
  assert.strictEqual(day.custom_gcash, EXPECT.customGcash);
});

test('stock rows reach the phone with their own snake_case keys', () => {
  const stock = F.boot.stockUsage.filter(r => r.date === STOCK_DAY);
  assert.deepStrictEqual(stock.map(r => [r.product, r.qty]), [['Takoyaki Flour', 2]]);
  // Stock is never money: it must not appear in the day's total.
  assert.strictEqual(F.boot.days.find(d => d.date === STOCK_DAY).total, 0);
  // The retired supplies path is GONE, and the queued `supplies` array the
  // fixture still sends changed nothing.
  assert.strictEqual(F.boot.dailySupplies, undefined, 'a dead collection must not be shipped');
  assert.strictEqual(F.boot.supplyItems, undefined);
  assert.ok(!has(F.stockDay, 'supplies_total'));
});

test('the day salary reaches the phone on the save reply and in bootstrap', () => {
  assert.strictEqual(F.saveDay.salary, EXPECT.salary, 'the snapshot the server stored');
  assert.strictEqual(F.boot.days.find(d => d.date === DAY).salary, EXPECT.salary,
    'the phone must be told the same figure the note will use');
  // Single-word key, so there is no camelCase spelling to drift to — but it must
  // be a NUMBER, not the "" a blank cell would give.
  assert.strictEqual(typeof F.boot.days.find(d => d.date === DAY).salary, 'number');
});

test('the stock list reaches the phone with its unit and a COMPUTED on-hand', () => {
  const products = F.boot.stockItems.map(r => r.product);
  assert.ok(products.indexOf('Takoyaki Flour') !== -1, 'the stock list is missing');
  const flour = F.boot.stockItems.find(r => r.product === 'Takoyaki Flour');
  assert.strictEqual(flour.unit, 'pack', 'the unit is the thing you OPEN, not a weight');
  // Seeded baseline 0 with a BLANK date, one delivery of 4, two units opened.
  assert.strictEqual(flour.baseline_qty, 0);
  assert.strictEqual(flour.baseline_date, '', 'a blank baseline date must survive the seam');
  assert.strictEqual(flour.delivered_since, 4);
  assert.strictEqual(flour.used_since, 2);
  assert.strictEqual(flour.on_hand, 2, '0 + 4 − 2, computed on the server and shipped');
  assert.strictEqual(flour.low, false);
  // A blank THRESHOLD has to survive the seam for the same reason a blank
  // baseline date does: 0 is a real threshold, and the Maintenance screen hands
  // back whatever it was given — so a coerced 0 is written into the sheet on the
  // first save and the owner's untouched cells stop being blank.
  assert.strictEqual(flour.reorder_at, '', 'a blank reorder point must arrive blank');
  // The stocktake became Bonito's baseline, and the phone is told the figures
  // behind it so it can explain them without holding the history.
  const bonito = F.boot.stockItems.find(r => r.product === 'Bonito');
  assert.strictEqual(bonito.baseline_date, COUNT_PAYLOAD.date);
  assert.strictEqual(bonito.baseline_qty, COUNT_PAYLOAD.qty);
  assert.strictEqual(bonito.on_hand, COUNT_PAYLOAD.qty);
  assert.strictEqual(F.stockCount.on_hand, COUNT_PAYLOAD.qty);
  assert.deepStrictEqual(F.boot.stockCounts.map(c => [c.date, c.product, c.counted_qty]),
    [[COUNT_PAYLOAD.date, COUNT_PAYLOAD.product, COUNT_PAYLOAD.qty]]);
});

test('the phone computes the SAME on-hand figure the server did', () => {
  // On hand is computed on both sides and stored on neither. The phone runs the
  // same arithmetic over its own rows, which is what makes the figure right
  // offline and in demo mode — so the two must agree to the unit.
  const app = syncedClient(F.boot);
  const mine = {};
  app.stockStatusList().forEach(s => { mine[s.product] = s; });
  F.boot.stockItems.filter(x => x.active).forEach(server => {
    const local = mine[server.product];
    assert.ok(local, 'the phone dropped ' + server.product + ' from its stock list');
    assert.strictEqual(local.on_hand, server.on_hand,
      server.product + ': phone says ' + local.on_hand + ', sheet says ' + server.on_hand);
    assert.strictEqual(local.low, server.low, server.product + ': the low mark disagrees');
  });
  // The two products the fixture actually moves, spelled out.
  assert.strictEqual(mine['Takoyaki Flour'].on_hand, 2, '0 + 4 delivered − 2 opened');
  assert.strictEqual(mine['Bonito'].on_hand, COUNT_PAYLOAD.qty, 'the stocktake became the baseline');
  assert.strictEqual(mine['Takoyaki Flour'].unit, 'pack');
  assert.strictEqual(app.qtyWithUnit(2, 'gallon'), '2 gallons');
  assert.strictEqual(app.qtyWithUnit(1, 'gallon'), '1 gallon');
});

test('a delivery then a unit opened leaves the right figure, with no server at all', () => {
  // Demo mode / a brand-new phone: no bootstrap, so every figure here is the
  // phone's own arithmetic. This is the owner's own worked example.
  const app = loadClient();
  app.applyLocalExpense({ date: '2026-08-01', category: 'Supplies', item: 'sauce',
    amount: 900, backlogRef: '', notes: '',
    stockProduct: 'Takoyaki Sauce', stockQty: 2, entryId: 'demo-deliv' });
  let sauce = app.stockStatusList().find(s => s.product === 'Takoyaki Sauce');
  assert.strictEqual(sauce.on_hand, 2, 'the delivery did not reach the ledger');
  app.applyLocalDay({ date: '2026-08-02', closed: false, staff: 'Mama', customAmount: 0,
    customGcash: 0, notes: '', counts: [],
    stock: [{ product: 'Takoyaki Sauce', qty: 1 }], entryId: 'demo-day' });
  sauce = app.stockStatusList().find(s => s.product === 'Takoyaki Sauce');
  assert.strictEqual(sauce.on_hand, 1, '2 gallons in, 1 opened, so 1 left');
  assert.strictEqual(app.qtyWithUnit(sauce.on_hand, sauce.unit), '1 gallon');
  // A stocktake RE-BASELINES: whatever the arithmetic said, the count wins from
  // that day on. This is what absorbs spoilage and miscounts.
  app.applyLocalStockCount({ date: '2026-08-03', product: 'Takoyaki Sauce', qty: 5, entryId: 'demo-count' });
  sauce = app.stockStatusList().find(s => s.product === 'Takoyaki Sauce');
  assert.strictEqual(sauce.on_hand, 5, 'the count did not become the new baseline');
  assert.strictEqual(sauce.baseline_date, '2026-08-03');
  // Replaying the same count (a queue re-send) must not double it up.
  app.applyLocalStockCount({ date: '2026-08-03', product: 'Takoyaki Sauce', qty: 5, entryId: 'demo-count' });
  assert.strictEqual(app.stockStatusList().find(s => s.product === 'Takoyaki Sauce').on_hand, 5);
});

test('on hand may read NEGATIVE on the phone too, never clamped', () => {
  const app = loadClient();
  app.applyLocalDay({ date: '2026-08-02', closed: false, staff: 'Mama', customAmount: 0,
    customGcash: 0, notes: '', counts: [],
    stock: [{ product: 'Japanese Mayo', qty: 9 }], entryId: 'neg-day' });
  const mayo = app.stockStatusList().find(s => s.product === 'Japanese Mayo');
  assert.strictEqual(mayo.on_hand, -9,
    'usage against a zero baseline must read honestly negative, not 0');
});

test('a delivery keeps its quantity on the expense row that paid for it', () => {
  const row = F.boot.expenses.find(e => e.entry_id === DELIVERY_PAYLOAD.entryId);
  assert.strictEqual(row.stock_product, 'Takoyaki Flour');
  assert.strictEqual(row.stock_qty, 4);
  assert.strictEqual(row.amount, DELIVERY_PAYLOAD.amount, 'the money is on the same row');
  // An ordinary expense carries the keys, blank — never undefined, which the
  // phone would render as "undefined" or drop on the floor.
  const plain = F.boot.expenses.find(e => e.entry_id === BACKLOG_PAYLOAD.entryId);
  assert.strictEqual(plain.stock_product, '');
  assert.strictEqual(plain.stock_qty, 0);
  // The client normalizer keeps the row usable either way (it is money).
  const app = syncedClient(F.boot);
  assert.strictEqual(app.state.expenses[DELIVERY_PAYLOAD.entryId].amount, DELIVERY_PAYLOAD.amount);
  assert.strictEqual(app.state.expenses[DELIVERY_PAYLOAD.entryId].category, 'Supplies');
});

// ---------------------------------------------------------------------------
console.log('\n--- 5. Backlog payments keep their attribution and reduce the balance ---');

test('bootstrap backlog -> normBacklog: total_amount and start_date survive', () => {
  const app = syncedClient(F.boot);
  const ref = app.state.backlogs.find(b => b.name === 'Ref');
  assert.ok(ref, 'the Ref backlog did not reach the phone');
  assert.strictEqual(app.num(ref.total_amount), EXPECT.refTotal,
    'total_amount is ' + JSON.stringify(ref.total_amount) + ' — every progress bar would read 0');
  assert.strictEqual(typeof ref.start_date, 'string');
  assert.strictEqual(app.backlogBalance(ref), EXPECT.refBalance, '6,700 - 700 paid');
});

test('"Total remaining" across all backlogs drops by the payment', () => {
  const app = syncedClient(F.boot);
  const active = app.state.backlogs.filter(b => b.active);
  const owed = active.reduce((s, b) => s + app.backlogBalance(b), 0);
  assert.strictEqual(owed, EXPECT.allBacklogsRemaining,
    'Total remaining is ' + owed + ', expected ' + EXPECT.allBacklogsRemaining);
});

test('balance recomputed from expenses alone (no server balance) still finds the payment', () => {
  // This is the path the phone uses offline and in demo mode: it must find the
  // payment by backlog_ref. If backlog_ref is lost at the seam, the payment
  // stops counting and the balance jumps back up to the full amount.
  const app = syncedClient(F.boot);
  const ref = app.state.backlogs.find(b => b.name === 'Ref');
  delete ref.balance;
  delete ref.paid;
  assert.strictEqual(app.backlogBalance(ref), EXPECT.refBalance,
    'backlog payment lost its attribution -> balances wrong');
});

test('bootstrap expense -> normExpense: backlog_ref, entry_id and updated_at kept', () => {
  const app = syncedClient(F.boot);
  const e = app.state.expenses['seam-exp-1'];
  assert.ok(e, 'the Backlog expense did not reach the phone');
  assert.strictEqual(e.backlog_ref, 'Ref');
  assert.strictEqual(e.category, 'Backlog');
  assert.strictEqual(e.amount, EXPECT.refPaid);
  assert.ok(e.updated_at, 'updated_at is empty — the expense list sorts wrongly');
});

// ---------------------------------------------------------------------------
console.log('\n--- 6. Cutoff figures + note text agree across the seam ---');

// The figures the PWA computes for itself out of its own local mirror. Split,
// Salary and the residual are SERVER-owned in v2.3.0 — Split is entered per
// cutoff (CutoffInputs, else Settings split_default) and Salary is summed from
// each day's snapshot — so those three are asserted against the server, and the
// phone is required to READ them rather than invent them.
const SHARED_FIGURES = ['total', 'cash', 'gcash', 'mama', 'supplies', 'octopus', 'other', 'electric'];

/**
 * The cutoff seam, in the only form that is true of BOTH halves at once:
 *   - every figure the phone computes itself must equal the server's to the peso
 *     (this is what caught the "Supplies is short" class of bug, and it is
 *     exactly what retiring DailySupplies could have desynced),
 *   - the phone must be able to READ the server's note text and its Split,
 *     Salary and Remaining figures,
 *   - AND, the moment the phone's own model knows about the residual, the two
 *     notes must match BYTE FOR BYTE again. That last branch arms itself when
 *     the PWA ships its half of this release — it is not a permanent exemption.
 */
function assertCutoffSeam(app, per, served) {
  const local = app.computeCutoff(per);
  const f = served.figures;
  SHARED_FIGURES.forEach(k => {
    assert.strictEqual(local[k], f[k],
      'the phone and the note disagree about "' + k + '": ' + local[k] + ' vs ' + f[k]);
  });
  const note = app.pick(served, 'note_text', 'noteText');
  assert.ok(note, 'the client would fall back to the on-phone note (server note_text unread)');
  ['split', 'per_partner', 'salary', 'remaining'].forEach(k => {
    const v = f[k];
    assert.strictEqual(typeof v, 'number', 'figures.' + k + ' must be a number the phone can show');
    assert.notStrictEqual(app.pick(f, k, k), undefined, 'the phone cannot read figures.' + k);
  });
  if (Object.prototype.hasOwnProperty.call(local, 'remaining')) {
    assert.strictEqual(app.buildNote(local, per), note,
      'the phone now computes the residual itself, so its note must match byte for byte');
  }
  return { local, f, note };
}

test("the server's note_text reaches the client reader, and the shared figures agree", () => {
  const app = syncedClient(F.boot);
  const { note } = assertCutoffSeam(app, PERIOD, F.cutoff);
  // The note the phone shows is the SERVER's, Salary and residual included.
  assert.match(note, /\nSalary - 200\n/);
  assert.match(note, /\nSplit - 2,000\(1,000 each\)\n/);
  assert.match(note, /\n\nShort - 2,355$/);
});

test('cutoff money is identical on both sides, and the identity closes', () => {
  const app = syncedClient(F.boot);
  const { local, f } = assertCutoffSeam(app, PERIOD, F.cutoff);
  assert.strictEqual(local.other, f.other, 'the Backlog payment must land in "Other payments"');
  assert.strictEqual(f.total, EXPECT.total);
  assert.strictEqual(f.other, EXPECT.refPaid);
  assert.strictEqual(f.supplies, EXPECT.supplies, "the delivery's pesos, counted once");
  assert.strictEqual(f.salary, EXPECT.salary);
  assert.strictEqual(f.split, EXPECT.split, 'the amount entered for this period');
  assert.strictEqual(f.per_partner, EXPECT.perPartner);
  assert.strictEqual(f.remaining, EXPECT.remaining);
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining,
    'Total = Mama + Split + Supplies + Octopus + Salary + Other + Electric + Remaining');
});

test('the entered Split reaches the phone so it can pre-fill and preview offline', () => {
  assert.strictEqual(F.split.split_amount, SPLIT_PAYLOAD.amount);
  assert.strictEqual(F.split.per_partner, SPLIT_PAYLOAD.amount / 2);
  assert.deepStrictEqual(F.boot.cutoffInputs.map(r => [r.start, r.end, r.split_amount]),
    [[PERIOD.start, PERIOD.end, SPLIT_PAYLOAD.amount]]);
  // ...and the phone actually READS it, rather than falling back to the default.
  const app = syncedClient(F.boot);
  assert.deepStrictEqual(app.splitFor(PERIOD), { amount: SPLIT_PAYLOAD.amount, entered: true },
    'the phone must pre-fill the amount saved for THIS period');
  const other = { start: '2026-06-01', end: '2026-06-15' };
  assert.deepStrictEqual(app.splitFor(other), { amount: 3000, entered: false },
    'a period with nothing entered falls back to the Settings default');
});

test('the phone shows the same wage per day the note adds up', () => {
  const app = syncedClient(F.boot);
  assert.strictEqual(app.daySalary(app.state.days[DAY]), EXPECT.salary);
  // A day the sheet has no salary column for (an older deployment) counts at the
  // current rate, never at 0 — the same fallback readDays() applies.
  assert.strictEqual(app.daySalary({ closed: false, salary: '' }), app.dailySalary());
  assert.strictEqual(app.daySalary({ closed: true, salary: '' }), 0, 'a closed day costs no wage');
  assert.strictEqual(app.daySalary({ closed: false, salary: 0 }), 0, 'an explicit 0 is a day off, not a blank');
  // Reopening the day for editing shows that figure and sends it back unchanged,
  // so re-saving an old day can never re-price its wage at today's rate.
  app.loadBentaForm(DAY);
  assert.strictEqual(app.benta.salary, EXPECT.salary);
  assert.strictEqual(app.bentaPayload().salary, EXPECT.salary);
});

// ---------------------------------------------------------------------------
console.log('\n--- 7. The contract itself, pinned in BOTH directions ---');

function contractSamples() {
  return {
    'bootstrap.prices[]':   F.boot.prices,
    'bootstrap.days[]':     F.boot.days,
    'bootstrap.counts[]':   F.boot.counts,
    'bootstrap.expenses[]': F.boot.expenses,
    'bootstrap.backlogs[]': F.boot.backlogs,
    'bootstrap.stockUsage[]':    F.boot.stockUsage,
    'bootstrap.stockItems[]':    F.boot.stockItems,
    'bootstrap.stockCounts[]':   F.boot.stockCounts,
    'bootstrap.cutoffInputs[]':  F.boot.cutoffInputs,
    'saveDay':              F.saveDay,
    'saveDay.lines[]':      F.saveDay.lines,
    'saveExpense':          F.saveExpense,
    'saveStockCount':       F.stockCount,
    'saveCutoffSplit':      F.split,
    'cutoff':               F.cutoff,
    'cutoff.figures':       F.cutoff.figures,
    'bootstrap.lastCutoff': F.boot.lastCutoff
  };
}

test('every fixture collection is non-empty (otherwise section 7 asserts nothing)', () => {
  const samples = contractSamples();
  for (const where in CONTRACT) {
    const v = samples[where];
    assert.ok(v != null, where + ' is missing from the response');
    if (where.endsWith('[]')) assert.ok(Array.isArray(v) && v.length > 0, where + ' is empty');
  }
});

for (const where in CONTRACT) {
  test('SERVER sends snake_case, never camelCase: ' + where, () => {
    assertPairs(where, contractSamples()[where], CONTRACT[where]);
  });
}

test('CLIENT prefers snake_case but still reads a legacy camelCase server', () => {
  // Simulate a phone on new code pointed at an older, still-deployed Apps
  // Script. Money must not silently become 0.
  const legacyBoot = {
    settings: F.boot.settings,
    prices:   toLegacy(F.boot.prices, CONTRACT['bootstrap.prices[]']),
    days:     toLegacy(F.boot.days, CONTRACT['bootstrap.days[]']),
    counts:   toLegacy(F.boot.counts, CONTRACT['bootstrap.counts[]']),
    expenses: toLegacy(F.boot.expenses, CONTRACT['bootstrap.expenses[]']),
    backlogs: toLegacy(F.boot.backlogs, CONTRACT['bootstrap.backlogs[]']),
    lastCutoff: F.boot.lastCutoff
  };
  const app = syncedClient(legacyBoot);
  assert.strictEqual(app.num(app.state.prices.find(p => p.sku === 'box4').cheese_price), 60);
  assert.strictEqual(app.state.days[DAY].custom_amount, EXPECT.custom);
  assert.strictEqual(app.state.days[DAY].entry_id, 'seam-day-1');
  assert.strictEqual((app.state.counts[DAY] || []).find(r => r.sku === 'box4').cheese_qty, EXPECT.box4Cheese);
  assert.strictEqual(app.state.expenses['seam-exp-1'].backlog_ref, 'Ref');
  assert.strictEqual(app.num(app.state.backlogs.find(b => b.name === 'Ref').total_amount), EXPECT.refTotal);

  app.loadBentaForm(DAY);
  assert.strictEqual(app.computeDay(app.bentaPayload()).total, EXPECT.total,
    'a legacy server must degrade gracefully, not zero the day');
});

test('CLIENT applyServerDay also reads a legacy camelCase saveDay reply', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  app.applyLocalDay(SAVE_DAY_PAYLOAD);
  app.applyServerDay(SAVE_DAY_PAYLOAD, {
    total: F.saveDay.total, cash: F.saveDay.cash,
    lines: toLegacy(F.saveDay.lines, CONTRACT['saveDay.lines[]'])
  });
  const row = (app.state.counts[DAY] || []).find(r => r.sku === 'box4');
  assert.strictEqual(row.cheese_qty, EXPECT.box4Cheese);
  assert.strictEqual(row.regular_qty, EXPECT.box4Regular);
});

test('REQUEST shape is unchanged: the client still POSTs camelCase', () => {
  // The server parses payload.customAmount / counts[].cheeseQty. If the client
  // ever "tidied" its payload to snake_case, the server would read 0s — so
  // send the client's own payload through the real doPost and check the money.
  const app = syncedClient(F.boot);
  app.loadBentaForm(DAY);
  const payload = app.bentaPayload();
  assert.ok(has(payload, 'customAmount'), 'request payload lost customAmount');
  assert.ok(has(payload.counts[0], 'cheeseQty'), 'request payload lost cheeseQty');
  payload.entryId = 'seam-roundtrip';

  const { ctx, token } = loadServer();
  const r = post(ctx, { token, action: 'saveDay', payload });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, EXPECT.total, 'the server did not understand the client payload');
  assert.strictEqual(r.data.lines.find(l => l.sku === 'box4').amount, EXPECT.box4Amount);
});

// ===========================================================================
// 8. FOUR PAYMENT/VARIANT BUCKETS through the real seam.
//
// The fixture above deliberately has no GCash buckets (it is the original
// cheese-price regression). This one uses all four buckets on two SKUs, which
// is the shape the owner's own Sales Calculator produces:
//
//   Box 4 : sod 10 eod 0 -> sold 10 | cheese 2, gcash 2, gcash cheese 1
//           regular = 10-2-2-1 = 5
//           amount       = (5+2)*50 + (2+1)*60 = 350 + 180 = 530
//           gcash_amount =     2*50 +     1*60 = 100 +  60 = 160
//   Box 6 : sod  8 eod 2 -> sold  6 | cheese 1, gcash 2, gcash cheese 1
//           regular = 6-1-2-1 = 2
//           amount       = (2+2)*65 + (1+1)*80 = 260 + 160 = 420
//           gcash_amount =     2*65 +     1*80 = 130 +  80 = 210
//   custom order 250, of which 100 was GCash
//   ------------------------------------------------------------------------
//   TOTAL 1,200      GCash 470      Cash 730
//
// Every one of those figures has to be identical in three places: the saveDay
// response, the bootstrap round-trip, and the client's own computeDay.
// ===========================================================================
console.log('\n--- 8. Four payment/variant buckets agree on all three sides ---');

const B_DAY = '2026-07-28';
const BUCKET_PAYLOAD = {
  date: B_DAY, closed: false, staff: 'Mama',
  gcash: 9999,                       // stale field from a pre-update queued save
  customAmount: 250, customGcash: 100, notes: 'four buckets',
  counts: [
    { sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 2, gcashCheeseQty: 1 },
    { sku: 'box6', sod: 8, eod: 2, cheeseQty: 1, gcashQty: 2, gcashCheeseQty: 1 },
    { sku: 'box10', sod: 4, eod: 4, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }
  ],
  entryId: 'bucket-day-1'
};
const B = {
  box4: { sold: 10, cheese_qty: 2, gcash_qty: 2, gcash_cheese_qty: 1, regular_qty: 5, amount: 530, gcash_amount: 160 },
  box6: { sold: 6, cheese_qty: 1, gcash_qty: 2, gcash_cheese_qty: 1, regular_qty: 2, amount: 420, gcash_amount: 210 },
  total: 1200, gcash: 470, cash: 730, custom: 250, customGcash: 100
};

function bucketFixture() {
  const { ctx, ss, token } = loadServer();
  const saveDay = post(ctx, { token, action: 'saveDay', payload: BUCKET_PAYLOAD });
  assert.strictEqual(saveDay.ok, true, 'saveDay failed: ' + saveDay.error);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, 'bootstrap failed: ' + boot.error);
  const range = post(ctx, { token, action: 'range', payload: { start: '2026-07-16', end: '2026-07-31' } });
  assert.strictEqual(range.ok, true, 'range failed: ' + range.error);
  return { ctx, ss, token, saveDay: saveDay.data, boot: boot.data, range: range.data };
}
const BK = bucketFixture();

/** The three entered buckets + the derived one, from any row shape. */
const buckets = r => ({
  sold: r.sold, cheese_qty: r.cheese_qty, gcash_qty: r.gcash_qty,
  gcash_cheese_qty: r.gcash_cheese_qty, regular_qty: r.regular_qty,
  amount: r.amount, gcash_amount: r.gcash_amount
});

test('SERVER: both SKUs derive regular_qty and price both cheese and GCash correctly', () => {
  const l4 = BK.saveDay.lines.find(l => l.sku === 'box4');
  const l6 = BK.saveDay.lines.find(l => l.sku === 'box6');
  assert.deepStrictEqual(buckets(l4), B.box4, 'Box 4 buckets/money');
  assert.deepStrictEqual(buckets(l6), B.box6, 'Box 6 buckets/money');
  [l4, l6].forEach(l => {
    assert.strictEqual(l.cheese_qty + l.gcash_qty + l.gcash_cheese_qty + l.regular_qty, l.sold,
      l.sku + ': the four buckets must sum to sold');
  });
  assert.strictEqual(BK.saveDay.total, B.total, 'day total');
  assert.strictEqual(BK.saveDay.gcash, B.gcash, 'day GCash');
  assert.strictEqual(BK.saveDay.cash, B.cash, 'day Cash');
  assert.strictEqual(BK.saveDay.cash, BK.saveDay.total - BK.saveDay.gcash,
    'Cash = Total - GCash must still hold');
});

test('BOOTSTRAP: the stored DailyCounts rows round-trip all four buckets', () => {
  const app = syncedClient(BK.boot);
  const rows = app.state.counts[B_DAY] || [];
  assert.deepStrictEqual(buckets(rows.find(r => r.sku === 'box4')), B.box4,
    'Box 4 lost a bucket between the sheet and the phone');
  assert.deepStrictEqual(buckets(rows.find(r => r.sku === 'box6')), B.box6);
  const day = app.state.days[B_DAY];
  assert.strictEqual(day.total, B.total);
  assert.strictEqual(day.gcash, B.gcash);
  assert.strictEqual(day.cash, B.cash);
  assert.strictEqual(day.custom_gcash, B.customGcash);
});

test('CLIENT: reopening the day re-derives the identical total / GCash / Cash', () => {
  const app = syncedClient(BK.boot);
  app.loadBentaForm(B_DAY);
  // The form loads only the three ENTERED buckets; regular is re-derived.
  const row = app.benta.rows.find(r => r.sku === 'box4');
  assert.deepStrictEqual({ sod: row.sod, eod: row.eod, cheese: row.cheese, gcash: row.gcash, gcashCheese: row.gcashCheese },
    { sod: 10, eod: 0, cheese: 2, gcash: 2, gcashCheese: 1 },
    'a bucket was lost on the way back into the form');

  const payload = app.bentaPayload();
  assert.deepStrictEqual(payload.counts.find(c => c.sku === 'box4'),
    { sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 2, gcashCheeseQty: 1 },
    'the re-emitted REQUEST must stay camelCase and carry all three buckets');
  assert.ok(!has(payload, 'gcash'), 'the client must not send a typed GCash figure any more');

  const c = app.computeDay(payload);
  const pick4 = c.lines.find(l => l.sku === 'box4');
  const pick6 = c.lines.find(l => l.sku === 'box6');
  assert.deepStrictEqual(buckets(pick4), B.box4, 'client Box 4 maths disagrees with the server');
  assert.deepStrictEqual(buckets(pick6), B.box6);
  assert.strictEqual(c.total, B.total);
  assert.strictEqual(c.gcash, B.gcash);
  assert.strictEqual(c.cash, B.cash);
});

test('ALL THREE SIDES agree to the peso (server response / bootstrap / computeDay)', () => {
  const app = syncedClient(BK.boot);
  app.loadBentaForm(B_DAY);
  const client = app.computeDay(app.bentaPayload());
  const stored = BK.boot.days.find(d => d.date === B_DAY);
  const money = o => [o.total, o.gcash, o.cash];
  assert.deepStrictEqual(money(client), money(BK.saveDay), 'computeDay vs saveDay response');
  assert.deepStrictEqual(money(stored), money(BK.saveDay), 'bootstrap vs saveDay response');
  assert.deepStrictEqual(money(client), [B.total, B.gcash, B.cash]);
  // And the day's GCash is exactly the sum of the per-line GCash plus the
  // custom order's GCash part — nothing else may leak in.
  const lineGcash = BK.saveDay.lines.reduce((s, l) => s + l.gcash_amount, 0);
  assert.strictEqual(BK.saveDay.gcash, lineGcash + B.customGcash);
  assert.strictEqual(BK.saveDay.total,
    BK.saveDay.lines.reduce((s, l) => s + l.amount, 0) + B.custom);
});

test('the client payload survives a real round-trip through doPost unchanged', () => {
  const app = syncedClient(BK.boot);
  app.loadBentaForm(B_DAY);
  const payload = app.bentaPayload();
  payload.entryId = 'bucket-roundtrip';
  const { ctx, token } = loadServer();
  const r = post(ctx, { token, action: 'saveDay', payload });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual([r.data.total, r.data.gcash, r.data.cash], [B.total, B.gcash, B.cash]);
  assert.deepStrictEqual(buckets(r.data.lines.find(l => l.sku === 'box4')), B.box4);
});

test('applyServerDay makes the SERVER authoritative for every GCash figure', () => {
  // The optimistic local write happens first, so asserting on it proves nothing
  // about applyServerDay. Give the phone a STALE price mirror — exactly what
  // happens when the owner edits the Prices tab and the phone has not synced —
  // so the local numbers are provably wrong and only the server can fix them.
  const app = loadClient();
  app.applyBootstrap(BK.boot);
  app.state.prices.find(p => p.sku === 'box4').price = 999;
  app.applyLocalDay(BUCKET_PAYLOAD);
  const stale = (app.state.counts[B_DAY] || []).find(r => r.sku === 'box4');
  assert.notStrictEqual(stale.amount, B.box4.amount, 'the fixture must actually be stale');
  assert.notStrictEqual(stale.gcash_amount, B.box4.gcash_amount);
  assert.notStrictEqual(app.state.days[B_DAY].gcash, B.gcash);

  app.applyServerDay(BUCKET_PAYLOAD, BK.saveDay); // authoritative numbers on top
  const row = (app.state.counts[B_DAY] || []).find(r => r.sku === 'box4');
  assert.deepStrictEqual(buckets(row), B.box4,
    'applyServerDay did not overwrite the stale local line with the server figures');
  assert.strictEqual(app.state.days[B_DAY].total, B.total);
  assert.strictEqual(app.state.days[B_DAY].gcash, B.gcash,
    'the day kept a GCash figure the server disagrees with');
  assert.strictEqual(app.state.days[B_DAY].cash, B.cash);
});

test('a legacy "gcash" field in the payload is IGNORED (server computes its own)', () => {
  // BUCKET_PAYLOAD carries gcash: 9999 exactly as a phone that queued a save
  // before this release still does. 9999 must reach nothing.
  assert.strictEqual(BK.saveDay.gcash, B.gcash, 'a stale typed GCash figure won');
  const day = BK.boot.days.find(d => d.date === B_DAY);
  assert.strictEqual(day.gcash, B.gcash, 'the bogus figure reached the sheet');
  assert.strictEqual(day.cash, B.cash);
  const raw = BK.ss.getSheetByName('DailyLog').getDataRange().getValues();
  const gcashCol = raw[0].indexOf('gcash');
  assert.ok(gcashCol >= 0);
  raw.slice(1).forEach(r => assert.notStrictEqual(r[gcashCol], 9999,
    'the DailyLog gcash cell must never be the client-sent figure'));
});

// ===========================================================================
console.log('\n--- 9. custom_gcash counts once: in GCash, never twice in Total ---');

test('the custom order\'s GCash part raises GCash but not Total', () => {
  const { ctx, token } = loadServer();
  const base = {
    date: '2026-07-27', closed: false, staff: 'Mama', notes: '',
    counts: [{ sku: 'box4', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }]
  };
  const noGcash = post(ctx, { token, action: 'saveDay',
    payload: Object.assign({}, base, { customAmount: 250, customGcash: 0, entryId: 'cg-0' }) });
  const withGcash = post(ctx, { token, action: 'saveDay',
    payload: Object.assign({}, base, { customAmount: 250, customGcash: 100, entryId: 'cg-1' }) });
  assert.strictEqual(noGcash.ok, true, noGcash.error);
  assert.strictEqual(withGcash.ok, true, withGcash.error);
  assert.strictEqual(noGcash.data.total, 450);   // 4 x 50 + 250 custom
  assert.strictEqual(withGcash.data.total, 450, 'custom_gcash must not be added to Total again');
  assert.strictEqual(noGcash.data.gcash, 0);
  assert.strictEqual(withGcash.data.gcash, 100, 'custom_gcash must reach the day GCash');
  assert.strictEqual(withGcash.data.cash, 350);
});

test('custom_gcash round-trips to the phone and back out of the form', () => {
  const app = syncedClient(BK.boot);
  assert.strictEqual(app.state.days[B_DAY].custom_gcash, B.customGcash,
    'custom_gcash vanished at the seam');
  app.loadBentaForm(B_DAY);
  assert.strictEqual(app.benta.customGcash, B.customGcash, 'the form did not pre-fill it');
  const payload = app.bentaPayload();
  assert.strictEqual(payload.customGcash, B.customGcash);
  assert.ok(has(payload, 'customGcash'), 'the REQUEST key must stay camelCase');
  // Local maths: exactly the custom GCash, plus the per-line GCash, once.
  const c = app.computeDay(payload);
  assert.strictEqual(c.customGcash, B.customGcash);
  assert.strictEqual(c.gcash - c.lines.reduce((s, l) => s + l.gcash_amount, 0), B.customGcash);
  assert.strictEqual(c.total, c.lines.reduce((s, l) => s + l.amount, 0) + B.custom);
});

test('a custom-order-only day paid entirely by GCash: Cash prints 0, not blank', () => {
  const { ctx, token } = loadServer();
  const day = '2026-06-20';
  const per = { start: '2026-06-16', end: '2026-06-30' };
  const s = post(ctx, { token, action: 'saveDay', payload: {
    date: day, closed: false, staff: 'Mama', customAmount: 300, customGcash: 300,
    notes: '', counts: [], entryId: 'cg-only' } });
  assert.strictEqual(s.ok, true, s.error);
  assert.deepStrictEqual([s.data.total, s.data.gcash, s.data.cash], [300, 300, 0]);

  const cut = post(ctx, { token, action: 'cutoff', payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cut.ok, true, cut.error);
  assert.deepStrictEqual([cut.data.figures.total, cut.data.figures.gcash, cut.data.figures.cash],
    [300, 300, 0], 'custom_gcash must not be double-counted into the period total');
  // Total/Cash/GCash are ALWAYS numeric — only the six category lines blank out.
  const lines = cut.data.note_text.split('\n');
  assert.strictEqual(lines[2], 'Total - 300');
  assert.strictEqual(lines[4], 'Cash - 0', 'a zero Cash line must print 0, never blank');
  assert.strictEqual(lines[5], 'GCash - 300');
  assert.strictEqual(lines[7], 'Mama - ', 'a zero CATEGORY keeps its trailing space');

  // The phone agrees, from its own local mirror.
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  const app = syncedClient(boot.data);
  const local = app.computeCutoff(per);
  assert.deepStrictEqual([local.total, local.gcash, local.cash], [300, 300, 0]);
  assertCutoffSeam(app, per, cut.data);
  // The residual is the day's takings minus the entered Split and the wage.
  assert.strictEqual(cut.data.figures.remaining, 300 - 3000 - 200);
  assert.strictEqual(lines[15], 'Short - 2,900');
});

test('customGcash may never exceed customAmount, and says so in plain English', () => {
  const { ctx, token } = loadServer();
  const r = post(ctx, { token, action: 'saveDay', payload: {
    date: '2026-07-26', closed: false, staff: 'Mama', customAmount: 100, customGcash: 150,
    notes: '', counts: [], entryId: 'cg-bad' } });
  assert.strictEqual(r.ok, false, 'an impossible split was accepted');
  assert.match(r.error, /GCash part of the custom order/);
  assert.ok(!/[{}\[\]]|undefined|NaN/.test(r.error), 'the message must be readable: ' + r.error);
});

// ===========================================================================
// 10. DailySupplies feeds the cutoff Supplies line, and the note stays
//     CHARACTER-IDENTICAL to the SPEC sample.
//
// The period is built so its figures are exactly the spec sample's, with the
// 5,440 Supplies figure now coming from TWO places: 5,000 of bulk
// Expenses(Supplies) and 440 of per-item DailySupplies. If DailySupplies stopped
// feeding the note, Supplies would read 5,000 and Split 4,440 — both visible in
// the diff of one exact string.
// ===========================================================================
console.log('\n--- 10. The v2.3.0 cutoff note, byte-exact across the seam ---');

// The spec's sample note, verbatim. Note the trailing space on "Octopus - ", the
// blank line before the residual, and that the residual's LABEL carries the sign.
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

const SPEC_PERIOD = { start: '2025-07-01', end: '2025-07-15' };
const SPEC_EXPENSE_SUPPLIES = 5440;   // Supplies is Expenses(Supplies) ALONE now
const SPEC_MONEY = {
  '2025-07-03': { customAmount: 6000, customGcash: 1000, stock: [{ product: 'Takoyaki Flour', qty: 2 }] },
  '2025-07-10': { customAmount: 5857, customGcash: 327, stock: [{ product: 'Bonito', qty: 3 }] }
};
// All FIFTEEN days of the period, because Salary is ₱200 per open day and the
// sample's Salary line is ₱3,000. Two of them carry the money; the rest are open
// days that sold nothing and still cost a wage. The queued (retired) `supplies`
// array rides along on one of them and must change nothing.
const SPEC_DAYS = [];
for (let d = 1; d <= 15; d++) {
  const date = '2025-07-' + (d < 10 ? '0' + d : d);
  const m = SPEC_MONEY[date] || {};
  SPEC_DAYS.push({
    date: date, closed: false, staff: 'Mama',
    customAmount: m.customAmount || 0, customGcash: m.customGcash || 0,
    notes: '', counts: [],
    supplies: date === '2025-07-03' ? [{ item: 'Veggies', amount: 200 }] : [],
    stock: m.stock || [],
    entryId: 'spec-day-' + date
  });
}
const SPEC_EXPENSES = [
  { date: '2025-07-05', category: 'Mama', item: 't', amount: 500, backlogRef: '', notes: '', entryId: 'spec-exp-0' },
  { date: '2025-07-05', category: 'Supplies', item: 'sako ng harina', amount: SPEC_EXPENSE_SUPPLIES, backlogRef: '', notes: '', entryId: 'spec-exp-1' },
  { date: '2025-07-05', category: 'Backlog', item: 'hulog', amount: 1000, backlogRef: 'Ref', notes: '', entryId: 'spec-exp-2' },
  { date: '2025-07-05', category: 'Other', item: 'misc', amount: 417, backlogRef: '', notes: '', entryId: 'spec-exp-3' },
  { date: '2025-07-05', category: 'Electric', item: 'kuryente', amount: 500, backlogRef: '', notes: '', entryId: 'spec-exp-4' }
];

// The SPEC period is deliberately a YEAR old: its note text is pinned to the
// owner's real July note. bootstrap ships a 90-DAY window, so those rows do not
// reach the phone through bootstrap at all — an older period reaches it through
// `range` or through the phone's own local writes (that is what specClient()
// models). These two days sit INSIDE the window and carry the same supplies and
// stock shapes, so the "sheet -> bootstrap -> form -> request" leg is asserted
// against rows bootstrap really ships, in whatever year the suite is run.
const RECENT_A = ymdDaysAgo(3);
const RECENT_B = ymdDaysAgo(2);
const RECENT_DAYS = [
  { date: RECENT_A, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [],
    stock: [{ product: 'Takoyaki Flour', qty: 2 }],
    entryId: 'recent-day-0' },
  { date: RECENT_B, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [],
    stock: [{ product: 'Bonito', qty: 3 }],
    entryId: 'recent-day-1' }
];

function specFixture() {
  const { ctx, ss, token } = loadServer();
  SPEC_DAYS.concat(RECENT_DAYS).forEach(p => {
    const r = post(ctx, { token, action: 'saveDay', payload: p });
    assert.strictEqual(r.ok, true, 'saveDay ' + p.date + ' failed: ' + r.error);
  });
  SPEC_EXPENSES.forEach(p => {
    const r = post(ctx, { token, action: 'saveExpense', payload: p });
    assert.strictEqual(r.ok, true, 'saveExpense ' + p.entryId + ' failed: ' + r.error);
  });
  const cutoff = post(ctx, { token, action: 'cutoff', payload: { start: SPEC_PERIOD.start, end: SPEC_PERIOD.end, dryRun: true } });
  assert.strictEqual(cutoff.ok, true, 'cutoff failed: ' + cutoff.error);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, 'bootstrap failed: ' + boot.error);
  const range = post(ctx, { token, action: 'range', payload: { start: SPEC_PERIOD.start, end: SPEC_PERIOD.end } });
  assert.strictEqual(range.ok, true, 'range failed: ' + range.error);
  return { ctx, ss, token, cutoff: cutoff.data, boot: boot.data, range: range.data };
}
const SP = specFixture();

/** A phone that entered this period itself: bootstrap for prices/settings, then
 *  the same local writes the app makes as each day and expense is saved. This is
 *  the real path for a period older than the bootstrap expense window. */
function specClient() {
  const app = loadClient();
  app.applyBootstrap(SP.boot);
  // The days as an UPDATED phone sends them: no daily-supplies rows. A phone
  // still on the old build can keep typing into that card, and its own preview
  // will then read a bigger Supplies than the note — which is exactly why the
  // card is going away. The server, and therefore the note, counts a purchase
  // in one place only.
  SPEC_DAYS.forEach(p => app.applyLocalDay(Object.assign({}, p, { supplies: [] })));
  SPEC_EXPENSES.forEach(p => app.applyLocalExpense(p));
  return app;
}

test('the Supplies figure is Expenses(Supplies) ALONE, exactly', () => {
  const f = SP.cutoff.figures;
  const bulkInPeriod = SP.range.expenses
    .filter(x => x.category === 'Supplies').reduce((s, x) => s + x.amount, 0);
  assert.strictEqual(bulkInPeriod, SPEC_EXPENSE_SUPPLIES);
  assert.strictEqual(f.supplies, bulkInPeriod, 'nothing else may inflate the Supplies line');
  assert.strictEqual(f.supplies, 5440);
  assert.strictEqual(SP.range.dailySupplies, undefined, 'the dead collection must be gone');
  // The retired arrays the fixture still sends are spending nowhere, and sales
  // nowhere either.
  assert.strictEqual(f.total, 11857);
  assert.strictEqual(f.salary, 3000, '15 open days at ₱200');
  assert.strictEqual(f.split, 3000, 'the Settings default, entered not derived');
  assert.strictEqual(f.per_partner, 1500);
  assert.strictEqual(f.remaining, -2000, 'the residual, negative and shown');
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining,
    'the accounting identity must still hold');
});

test('the SERVER note is character-identical to the SPEC sample', () => {
  assert.strictEqual(SP.cutoff.note_text, SPEC_NOTE);
  // Spelled out, so a future edit cannot "tidy" one of these away unnoticed.
  const lines = SP.cutoff.note_text.split('\n');
  assert.strictEqual(lines.length, 16);
  assert.deepStrictEqual([lines[1], lines[3], lines[6], lines[14]], ['', '', '', ''],
    'blank-line placement, including the one before the residual');
  assert.strictEqual(lines[8], 'Split - 3,000(1,500 each)', 'no space before the bracket');
  assert.strictEqual(lines[10], 'Octopus - ', 'a zero category keeps the trailing space');
  assert.strictEqual(lines[11], 'Salary - 3,000');
  assert.strictEqual(lines[15], 'Short - 2,000', 'the label carries the sign, never "- -2,000"');
  assert.ok(!/₱|PHP/.test(SP.cutoff.note_text), 'the note never carries a peso sign');
  assert.ok(!/\.00/.test(SP.cutoff.note_text), 'whole pesos print without decimals');
  assert.ok(!/- -/.test(SP.cutoff.note_text));
});

test('the CLIENT reads that note and agrees on every figure it computes itself', () => {
  const app = specClient();
  assertCutoffSeam(app, SPEC_PERIOD, SP.cutoff);
  const local = app.computeCutoff(SPEC_PERIOD);
  assert.strictEqual(local.supplies, 5440,
    'the phone and the note must not disagree about Supplies after the retirement');
  assert.strictEqual(app.pick(SP.cutoff, 'note_text', 'noteText'), SPEC_NOTE,
    'the phone shows the SERVER note verbatim');
});

test('stock rows round-trip: sheet -> bootstrap -> form -> request -> sheet', () => {
  // The bootstrap leg uses RECENT_A, a day inside the server's 90-day window.
  const app = syncedClient(SP.boot);
  const stored = (app.state.stockUsage[RECENT_A] || []);
  assert.deepStrictEqual(stored.map(r => [r.product, r.qty]), [['Takoyaki Flour', 2]],
    'the per-product rows did not reach the phone');
  stored.forEach(r => {
    assert.strictEqual(r.entry_id, 'recent-day-0', 'entry_id lost -> idempotent replay breaks');
    assert.ok(r.updated_at, 'updated_at lost');
  });

  app.loadBentaForm(RECENT_A);
  const back = app.benta.stock.filter(s => app.num(s.qty) > 0).map(s => [s.product, app.num(s.qty)]);
  assert.deepStrictEqual(back, [['Takoyaki Flour', 2]],
    'reopening the day did not restore the stock card');
  // A product with nothing entered stays out of the request entirely.
  const payload = app.bentaPayload();
  assert.deepStrictEqual(payload.stock, [{ product: 'Takoyaki Flour', qty: 2 }]);
  payload.entryId = 'recent-day-0';
  const again = post(SP.ctx, { token: SP.token, action: 'saveDay', payload });
  assert.strictEqual(again.ok, true, again.error);

  // A day OLDER than the bootstrap window is still re-saveable (the phone
  // replays the payload it queued), and replaying it must not move the note.
  const old = post(SP.ctx, { token: SP.token, action: 'saveDay', payload: SPEC_DAYS[2] });
  assert.strictEqual(old.ok, true, old.error);
  const cut = post(SP.ctx, { token: SP.token, action: 'cutoff', payload: { start: SPEC_PERIOD.start, end: SPEC_PERIOD.end, dryRun: true } });
  assert.strictEqual(cut.data.note_text, SPEC_NOTE, 'a replay must not move the note');
});

// ===========================================================================
console.log('\n--- 11. StockUsage round-trips and is never money ---');

test('the stock card shows the unit that tells Mama what to count', () => {
  const app = syncedClient(SP.boot);
  // RECENT_A / RECENT_B carry stock inside the 90-day window bootstrap ships
  // (the SPEC period is a year old — see RECENT_DAYS).
  assert.deepStrictEqual((app.state.stockUsage[RECENT_B] || []).map(r => [r.product, r.qty]),
    [['Bonito', 3]]);
  app.loadBentaForm(RECENT_A);
  const row = app.benta.stock.find(s => s.product === 'Takoyaki Flour');
  assert.strictEqual(app.num(row.qty), 2);
  assert.strictEqual(row.unit, 'pack',
    'the unit is the thing you OPEN, which is what makes whole units countable');
});

test('stock quantities never touch the day total, cash or GCash', () => {
  const { ctx, token } = loadServer();
  const base = {
    date: '2026-07-25', closed: false, staff: 'Mama', customAmount: 100, customGcash: 40, notes: '',
    counts: [{ sku: 'box4', sod: 6, eod: 0, cheeseQty: 1, gcashQty: 2, gcashCheeseQty: 0 }]
  };
  const without = post(ctx, { token, action: 'saveDay',
    payload: Object.assign({}, base, { stock: [], entryId: 'stk-none' }) });
  const with_ = post(ctx, { token, action: 'saveDay', payload: Object.assign({}, base, {
    stock: [{ product: 'Takoyaki Flour', qty: 3 }, { product: 'Japanese Mayo', qty: 9 }],
    entryId: 'stk-lots' }) });
  assert.strictEqual(without.ok, true, without.error);
  assert.strictEqual(with_.ok, true, with_.error);
  assert.deepStrictEqual([with_.data.total, with_.data.cash, with_.data.gcash],
    [without.data.total, without.data.cash, without.data.gcash],
    'a stock quantity leaked into the money');
  assert.ok(!has(with_.data, 'stock_total'), 'stock must not acquire a money figure');
  assert.ok(!has(with_.data, 'supplies_total'), 'and the retired supplies figure is gone');
  // The quantities did move the ledger, which is the one place they belong.
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.stockItems.find(x => x.product === 'Japanese Mayo').on_hand, -9,
    'usage against a zero baseline reads honestly negative');
});

test('stock never reaches the cutoff figures or the note, on either side', () => {
  // Server: the SPEC period carries real stock rows and the note is still
  // byte-identical (asserted in section 10) — pin the figures explicitly too.
  const f = SP.cutoff.figures;
  const stockUnits = SP.range.stockUsage.reduce((s, r) => s + r.qty, 0);
  assert.strictEqual(stockUnits, 5, 'the fixture must actually carry stock rows');
  assert.strictEqual(f.total, 11857);
  assert.strictEqual(f.supplies, 5440, 'stock quantities were added to Supplies');
  assert.strictEqual(f.salary, 3000);
  assert.strictEqual(f.remaining, -2000);
  assert.ok(!has(f, 'stock') && !has(f, 'stock_total'), 'the note figures gained a stock line');

  // Client: pile absurd usage onto the local mirror; nothing may move.
  const app = specClient();
  const before = app.computeCutoff(SPEC_PERIOD);
  const note = app.buildNote(before, SPEC_PERIOD);
  app.state.stockUsage['2025-07-03'] = [
    { date: '2025-07-03', product: 'Takoyaki Flour', qty: 99999, entry_id: 'x', updated_at: '' }
  ];
  const after = app.computeCutoff(SPEC_PERIOD);
  assert.deepStrictEqual(after, before, 'stock usage moved a cutoff figure');
  assert.strictEqual(app.buildNote(after, SPEC_PERIOD), note);
  // ...and the SERVER note the phone actually shows is unchanged too.
  const again = post(SP.ctx, { token: SP.token, action: 'cutoff',
    payload: { start: SPEC_PERIOD.start, end: SPEC_PERIOD.end, dryRun: true } });
  assert.strictEqual(again.data.note_text, SPEC_NOTE);
});

// ===========================================================================
// 12. MIGRATION of the OWNER'S LIVE SHEET, all the way to the phone.
//
// His sheet is v2.0.0-shaped: 10-column DailyLog, 9-column DailyCounts, no
// SupplyItems / DailySupplies / StockItems / StockUsage tabs, and real rows in
// it. setupSheet() must append only — and the old rows must keep reading
// correctly through the seam afterwards, because readers map by header NAME.
// ===========================================================================
console.log('\n--- 12. Live-sheet migration survives the seam (append-only) ---');

const OLD_LOG_HEADERS = ['date', 'closed', 'staff', 'gcash', 'total', 'cash', 'custom_amount', 'notes', 'entry_id', 'updated_at'];
const OLD_COUNT_HEADERS = ['date', 'sku', 'sod', 'eod', 'sold', 'cheese_qty', 'regular_qty', 'amount', 'entry_id'];
const OLD_DAY = '2026-07-20';
// A real pre-change day: box4 520 + box6 275 + 250 custom = 1,045, of which 300
// was the GCash figure the owner used to type in off the GCash app.
const OLD_LOG_ROWS = [
  [OLD_DAY, false, 'Mama', 300, 1045, 745, 250, 'party tray', 'old-day-1', '2026-07-20 21:00:00'],
  ['2026-07-21', false, 'Mama', 0, 520, 520, 0, '', 'old-day-2', '2026-07-21 21:00:00']
];
const OLD_COUNT_ROWS = [
  [OLD_DAY, 'box4', 10, 0, 10, 2, 8, 520, 'old-day-1'],
  [OLD_DAY, 'box6', 6, 2, 4, 1, 3, 275, 'old-day-1'],
  ['2026-07-21', 'box4', 10, 0, 10, 2, 8, 520, 'old-day-2']
];
const OLD_TOKEN = 'live-token-abcdef';

function putTab(ss, name, headers, rows, gridCols) {
  const sh = gridCols
    ? (ss.sheets[name] = new FakeSheet(name, 1000, gridCols))
    : ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows && rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return sh;
}

/** The owner's sheet exactly as v2.0.0 left it, with data. */
function liveSheet(countsGridCols) {
  const ss = new FakeSpreadsheet();
  putTab(ss, 'Settings', ['key', 'value'], [
    ['token', OLD_TOKEN], ['branch', 'Tañong'], ['mama_per_cutoff', 500],
    ['electric_per_cutoff', 500], ['partners', 'Nayt, Partner'], ['staff', 'Mama']
  ]);
  putTab(ss, 'Prices', ['sku', 'label', 'group', 'size', 'price', 'cheese_price', 'active'], [
    ['box4', 'Box 4', 'box', 4, 50, 60, true],
    ['box6', 'Box 6', 'box', 6, 65, 80, true],
    ['box10', 'Box 10', 'box', 10, 105, 125, true]
  ]);
  putTab(ss, 'DailyLog', OLD_LOG_HEADERS, OLD_LOG_ROWS);
  putTab(ss, 'DailyCounts', OLD_COUNT_HEADERS, OLD_COUNT_ROWS, countsGridCols);
  putTab(ss, 'Expenses', ['date', 'category', 'item', 'amount', 'backlog_ref', 'notes', 'entry_id', 'updated_at'], [
    ['2026-07-18', 'Supplies', 'sako ng harina', 300, '', '', 'old-exp-1', '2026-07-18 20:00:00']
  ]);
  putTab(ss, 'Backlogs', ['name', 'description', 'total_amount', 'start_date', 'active'], [['Ref', '', 6700, '', true]]);
  putTab(ss, 'Cutoffs', ['start', 'end', 'total', 'cash', 'gcash', 'mama', 'split', 'per_partner',
    'supplies', 'octopus', 'other', 'electric', 'note_text', 'generated_at'], []);
  return ss;
}

function loadOn(ss) {
  const ctx = makeContext(ss);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), ctx, { filename: 'Code.gs' });
  return ctx;
}

/** Every existing cell of every existing tab, as a rectangle we can re-read
 *  after the migration to prove nothing moved and nothing was lost. */
function rectangles(ss) {
  const out = {};
  Object.keys(ss.sheets).sort().forEach(n => {
    const v = ss.getSheetByName(n).getDataRange().getValues();
    out[n] = { rows: v.length, cols: v[0].length, values: v };
  });
  return out;
}

test('MIGRATION: setupSheet appends the new columns and moves no existing cell', () => {
  const ss = liveSheet();
  const before = rectangles(ss);
  const ctx = loadOn(ss);
  const token = ctx.setupSheet();
  assert.strictEqual(token, OLD_TOKEN, 'the live API token must survive the migration');

  const counts = ss.getSheetByName('DailyCounts').getDataRange().getValues();
  assert.deepStrictEqual(counts[0],
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount']),
    'the three new DailyCounts columns must be APPENDED, in schema order');
  const log = ss.getSheetByName('DailyLog').getDataRange().getValues();
  assert.deepStrictEqual(log[0], OLD_LOG_HEADERS.concat(['custom_gcash', 'salary']));
  assert.deepStrictEqual(counts[1].slice(9), ['', '', ''],
    'the appended cells start blank on a historical row, i.e. "that day was all cash"');
  assert.deepStrictEqual(log[1].slice(10), ['', ''],
    'a historical day gets no salary written into it — the rate is applied at read time');
  assert.deepStrictEqual(ss.getSheetByName('Expenses').getDataRange().getValues()[0].slice(8),
    ['stock_product', 'stock_qty']);

  // Nothing that existed before may have moved, changed or disappeared.
  for (const tab in before) {
    const after = ss.getSheetByName(tab).getDataRange().getValues();
    assert.ok(after.length >= before[tab].rows, tab + ' lost rows');
    for (let r = 0; r < before[tab].rows; r++) {
      assert.deepStrictEqual(after[r].slice(0, before[tab].cols), before[tab].values[r],
        tab + ' row ' + (r + 1) + ' shifted or lost a cell');
    }
  }
  // ...and the new tabs now exist, seeded.
  ['StockItems', 'StockUsage', 'StockCounts', 'CutoffInputs'].forEach(n => {
    assert.ok(ss.getSheetByName(n), 'missing new tab ' + n);
  });
  assert.strictEqual(ss.getSheetByName('StockItems').getDataRange().getValues().length - 1, 6);
  // The retired tabs are not created: nothing reads them any more.
  assert.strictEqual(ss.getSheetByName('SupplyItems'), null);
  assert.strictEqual(ss.getSheetByName('DailySupplies'), null);
});

test('MIGRATION: a sheet whose grid is only 9 columns wide is widened, not broken', () => {
  // An owner who deleted his unused columns has a grid narrower than the new
  // schema; the migration has to grow it before writing the headers.
  const ss = liveSheet(9);
  const ctx = loadOn(ss);
  assert.strictEqual(ctx.setupSheet(), OLD_TOKEN);
  const counts = ss.getSheetByName('DailyCounts');
  assert.ok(counts.getMaxColumns() >= 12, 'the grid was not widened');
  assert.deepStrictEqual(counts.getDataRange().getValues()[0],
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount']));
  assert.deepStrictEqual(counts.getDataRange().getValues()[1].slice(0, 9), OLD_COUNT_ROWS[0]);
  const boot = post(ctx, { token: OLD_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, boot.error);
  assert.strictEqual(boot.data.counts.find(c => c.date === OLD_DAY && c.sku === 'box4').amount, 520);
});

test('MIGRATION: the pre-change rows still read correctly BY NAME, all the way to the phone', () => {
  const ss = liveSheet();
  const ctx = loadOn(ss);
  ctx.setupSheet();
  const boot = post(ctx, { token: OLD_TOKEN, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, boot.error);

  const app = syncedClient(boot.data);
  const row = (app.state.counts[OLD_DAY] || []).find(r => r.sku === 'box4');
  assert.deepStrictEqual(buckets(row), {
    sold: 10, cheese_qty: 2, gcash_qty: 0, gcash_cheese_qty: 0, regular_qty: 8,
    amount: 520, gcash_amount: 0
  }, 'a 9-column history row must read as "all cash", never as zero money');
  const day = app.state.days[OLD_DAY];
  assert.strictEqual(day.total, 1045, 'the historical total must be untouched');
  assert.strictEqual(day.cash, 745);
  assert.strictEqual(day.gcash, 300, 'the GCash figure the owner typed back then is history — keep it');
  assert.strictEqual(day.custom_amount, 250);
  assert.strictEqual(day.custom_gcash, 0, 'a missing column reads as 0, not undefined');
  assert.strictEqual(day.entry_id, 'old-day-1');

  // Reopening the day for editing restores every bucket it can.
  app.loadBentaForm(OLD_DAY);
  const form = app.benta.rows.find(r => r.sku === 'box4');
  assert.deepStrictEqual({ sod: form.sod, eod: form.eod, cheese: form.cheese, gcash: form.gcash, gcashCheese: form.gcashCheese },
    { sod: 10, eod: 0, cheese: 2, gcash: 0, gcashCheese: 0 });
  const c = app.computeDay(app.bentaPayload());
  assert.strictEqual(c.total, 1045, 'recomputing a legacy day must reproduce its total');
  assert.strictEqual(c.lines.find(l => l.sku === 'box4').amount, 520);
  assert.strictEqual(c.lines.find(l => l.sku === 'box6').amount, 275);
  // DELIBERATE: GCash is computed from the buckets now, so a legacy day that is
  // re-saved reports 0 GCash (nothing in it was entered as a GCash sale). The
  // stored history above is what preserves the old figure.
  assert.strictEqual(c.gcash, 0);
});

test('MIGRATION: a saveDay after migrating works and leaves the legacy rows byte-identical', () => {
  const ss = liveSheet();
  const ctx = loadOn(ss);
  ctx.setupSheet();
  const r = post(ctx, { token: OLD_TOKEN, action: 'saveDay', payload: {
    date: '2026-07-28', closed: false, staff: 'Mama', gcash: 9999,
    customAmount: 250, customGcash: 100, notes: 'after migration',
    counts: BUCKET_PAYLOAD.counts,
    supplies: [{ item: 'Veggies', amount: 120 }],
    stock: [{ product: 'Bonito', qty: 2 }],
    entryId: 'post-migration-1' } });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual([r.data.total, r.data.gcash, r.data.cash], [B.total, B.gcash, B.cash]);
  assert.strictEqual(r.data.salary, 200, 'the new day carries its wage snapshot');
  assert.deepStrictEqual(buckets(r.data.lines.find(l => l.sku === 'box4')), B.box4);

  const counts = ss.getSheetByName('DailyCounts').getDataRange().getValues();
  OLD_COUNT_ROWS.forEach((old, i) => {
    assert.deepStrictEqual(counts[i + 1].slice(0, 9), old, 'legacy DailyCounts row ' + (i + 1) + ' changed');
  });
  OLD_LOG_ROWS.forEach((old, i) => {
    assert.deepStrictEqual(ss.getSheetByName('DailyLog').getDataRange().getValues()[i + 1].slice(0, 10), old,
      'legacy DailyLog row ' + (i + 1) + ' changed');
  });
  // The new columns were written in their REAL positions (10-12), not guessed.
  assert.deepStrictEqual(counts.slice(1).find(x => x[0] === '2026-07-28' && x[1] === 'box4'),
    ['2026-07-28', 'box4', 10, 0, 10, 2, 5, 530, 'post-migration-1', 2, 1, 160]);

  // And the phone reads the mixed-vintage sheet correctly in one bootstrap.
  const boot = post(ctx, { token: OLD_TOKEN, action: 'bootstrap', payload: {} });
  const app = syncedClient(boot.data);
  assert.deepStrictEqual(buckets((app.state.counts['2026-07-28'] || []).find(x => x.sku === 'box4')), B.box4);
  assert.strictEqual(app.state.days[OLD_DAY].total, 1045, 'the legacy day changed on the phone');
  assert.strictEqual(app.state.days['2026-07-28'].gcash, B.gcash);
  assert.deepStrictEqual((app.state.stockUsage['2026-07-28'] || []).map(x => [x.product, x.qty]), [['Bonito', 2]]);
  // The queued (retired) supplies array wrote nothing anywhere.
  assert.strictEqual(ss.getSheetByName('DailySupplies'), null);
});

test('MIGRATION: re-saving one of the OLD days upserts it instead of duplicating it', () => {
  const ss = liveSheet();
  const ctx = loadOn(ss);
  ctx.setupSheet();
  const before = ss.getSheetByName('DailyLog').getDataRange().getValues().length;
  const r = post(ctx, { token: OLD_TOKEN, action: 'saveDay', payload: {
    date: OLD_DAY, closed: false, staff: 'Mama',
    customAmount: 250, customGcash: 250, notes: 'party tray',
    counts: [
      { sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 0, gcashCheeseQty: 0 },
      { sku: 'box6', sod: 6, eod: 2, cheeseQty: 1, gcashQty: 0, gcashCheeseQty: 0 }
    ],
    entryId: 'old-day-1' } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 1045, 'the re-save changed the day total');
  assert.strictEqual(r.data.gcash, 250, 'GCash is recomputed from what was entered');
  const log = ss.getSheetByName('DailyLog').getDataRange().getValues();
  assert.strictEqual(log.length, before, 'the upsert appended a second row for the same date');
  const cgIdx = log[0].indexOf('custom_gcash');
  assert.strictEqual(log.slice(1).find(x => x[0] === OLD_DAY)[cgIdx], 250,
    'the appended column must now hold real data');
  const counts = ss.getSheetByName('DailyCounts').getDataRange().getValues()
    .slice(1).filter(x => x[0] === OLD_DAY && x.some(c => c !== ''));
  assert.strictEqual(counts.length, 2, 'the date block was not rewritten cleanly');
});

// ===========================================================================
console.log('\n--- 13. Every NEW response object, snake_case in both directions ---');

test('all four new fixtures ship snake_case for every contracted key', () => {
  const pairs = CONTRACT;
  assertPairs('bucket saveDay', BK.saveDay, pairs['saveDay']);
  assertPairs('bucket saveDay.lines[]', BK.saveDay.lines, pairs['saveDay.lines[]']);
  assertPairs('bucket bootstrap.days[]', BK.boot.days, pairs['bootstrap.days[]']);
  assertPairs('bucket bootstrap.counts[]', BK.boot.counts, pairs['bootstrap.counts[]']);
  assertPairs('spec bootstrap.stockUsage[]', SP.boot.stockUsage, pairs['bootstrap.stockUsage[]']);
  assertPairs('spec bootstrap.stockItems[]', SP.boot.stockItems, pairs['bootstrap.stockItems[]']);
  assertPairs('spec cutoff', SP.cutoff, pairs['cutoff']);
  assertPairs('spec cutoff.figures', SP.cutoff.figures, pairs['cutoff.figures']);
  // `range` returns the same row shapes as bootstrap and had no coverage at all.
  assertPairs('range.days[]', BK.range.days, pairs['bootstrap.days[]']);
  assertPairs('range.counts[]', BK.range.counts, pairs['bootstrap.counts[]']);
  assertPairs('range.stockUsage[]', SP.range.stockUsage, pairs['bootstrap.stockUsage[]']);
  assertPairs('range.expenses[]', SP.range.expenses, pairs['bootstrap.expenses[]']);
  assertPairs('range.stockCounts[]', F.boot.stockCounts, pairs['bootstrap.stockCounts[]']);
});

test('NO response anywhere contains a camelCase key (only the named containers)', () => {
  // Catches what the pairs table cannot: a brand-new field added in camelCase
  // that nobody remembered to list in CONTRACT.
  assertNoCamelKeys('bootstrap', F.boot);
  assertNoCamelKeys('bucket bootstrap', BK.boot);
  assertNoCamelKeys('spec bootstrap', SP.boot);
  assertNoCamelKeys('range', SP.range);
  assertNoCamelKeys('bucket range', BK.range);
  assertNoCamelKeys('saveDay', F.saveDay);
  assertNoCamelKeys('bucket saveDay', BK.saveDay);
  assertNoCamelKeys('stock saveDay', F.stockDay);
  assertNoCamelKeys('saveExpense', F.saveExpense);
  assertNoCamelKeys('delivery saveExpense', F.delivery);
  assertNoCamelKeys('saveStockCount', F.stockCount);
  assertNoCamelKeys('saveCutoffSplit', F.split);
  assertNoCamelKeys('cutoff', F.cutoff);
  assertNoCamelKeys('spec cutoff', SP.cutoff);
  const ping = post(BK.ctx, { token: BK.token, action: 'ping', payload: {} });
  assertNoCamelKeys('ping', ping.data);
});

test('and the migrated live sheet answers in snake_case too', () => {
  const ss = liveSheet();
  const ctx = loadOn(ss);
  ctx.setupSheet();
  const save = post(ctx, { token: OLD_TOKEN, action: 'saveDay', payload: {
    date: '2026-07-29', closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 5, eod: 0, cheeseQty: 1, gcashQty: 1, gcashCheeseQty: 1 }],
    supplies: [{ item: 'Egg', amount: 60 }], stock: [{ product: 'Aonori', qty: 2 }],
    entryId: 'migrated-1' } });
  assert.strictEqual(save.ok, true, save.error);
  const boot = post(ctx, { token: OLD_TOKEN, action: 'bootstrap', payload: {} });
  assertNoCamelKeys('migrated saveDay', save.data);
  assertNoCamelKeys('migrated bootstrap', boot.data);
  assertPairs('migrated saveDay.lines[]', save.data.lines, CONTRACT['saveDay.lines[]']);
  assertPairs('migrated bootstrap.counts[]', boot.data.counts, CONTRACT['bootstrap.counts[]']);
  assertPairs('migrated bootstrap.days[]', boot.data.days, CONTRACT['bootstrap.days[]']);
  assertPairs('migrated bootstrap.expenses[]', boot.data.expenses, CONTRACT['bootstrap.expenses[]']);
  assertPairs('migrated bootstrap.stockUsage[]', boot.data.stockUsage, CONTRACT['bootstrap.stockUsage[]']);
  assertPairs('migrated bootstrap.stockItems[]', boot.data.stockItems, CONTRACT['bootstrap.stockItems[]']);
});

test('CLIENT still reads a legacy camelCase server for the NEW collections too', () => {
  // A phone on new code pointed at an older, still-deployed Apps Script: the
  // four buckets, custom_gcash, supplies and stock must all degrade safely.
  const legacy = {
    settings: BK.boot.settings,
    prices: toLegacy(BK.boot.prices, CONTRACT['bootstrap.prices[]']),
    days: toLegacy(BK.boot.days, CONTRACT['bootstrap.days[]']),
    counts: toLegacy(BK.boot.counts, CONTRACT['bootstrap.counts[]']),
    expenses: [], backlogs: [],
    stockUsage: toLegacy(SP.boot.stockUsage, CONTRACT['bootstrap.stockUsage[]'])
  };
  const app = syncedClient(legacy);
  assert.deepStrictEqual(buckets((app.state.counts[B_DAY] || []).find(r => r.sku === 'box4')), B.box4,
    'a legacy server must degrade gracefully, not zero the buckets');
  assert.strictEqual(app.state.days[B_DAY].custom_gcash, B.customGcash);
  app.loadBentaForm(B_DAY);
  const c = app.computeDay(app.bentaPayload());
  assert.deepStrictEqual([c.total, c.gcash, c.cash], [B.total, B.gcash, B.cash]);
  assert.deepStrictEqual((app.state.stockUsage[RECENT_B] || []).map(r => [r.product, r.qty]),
    [['Bonito', 3]]);
});

test('CLIENT applyServerDay reads a legacy reply for the GCash buckets as well', () => {
  // Stale local prices again, so the camelCase fallback has to do real work
  // rather than agreeing with numbers the phone had already computed.
  const app = loadClient();
  app.applyBootstrap(BK.boot);
  app.state.prices.find(p => p.sku === 'box4').price = 999;
  app.applyLocalDay(BUCKET_PAYLOAD);
  app.applyServerDay(BUCKET_PAYLOAD, {
    total: BK.saveDay.total, cash: BK.saveDay.cash, gcash: BK.saveDay.gcash,
    lines: toLegacy(BK.saveDay.lines, CONTRACT['saveDay.lines[]'])
  });
  assert.deepStrictEqual(buckets((app.state.counts[B_DAY] || []).find(r => r.sku === 'box4')), B.box4,
    'a legacy camelCase reply must still correct the stale local line');
  assert.strictEqual(app.state.days[B_DAY].gcash, B.gcash);
  assert.strictEqual(app.state.days[B_DAY].cash, B.cash);
});

// ---------------------------------------------------------------------------
console.log('\n--- 11. Deletions in the sheet reach the phone (window_start) ---');

// Inferring the covered window from the dates a reply happens to contain cannot
// tell "older than this reply" from "deleted in the sheet", so a day or expense
// removed by hand lingered on the phone forever — and DailySupplies is money.
// The server therefore states its window; inside it the snapshot is the truth.

test('server states the window it speaks for', () => {
  assert.strictEqual(typeof F.boot.window_start, 'string');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(F.boot.window_start), 'window_start must be yyyy-MM-dd');
  assert.ok(!('windowStart' in F.boot), 'response keys are snake_case');
});

test('a day deleted in the sheet disappears from the phone', () => {
  const app = syncedClient(F.boot);
  const gone = Object.keys(app.state.days)[0];
  assert.ok(gone && gone >= F.boot.window_start, 'precondition: a day inside the window');
  app.applyBootstrap(Object.assign({}, F.boot, {
    days: F.boot.days.filter(d => d.date !== gone),
    counts: F.boot.counts.filter(c => c.date !== gone),
    stockUsage: (F.boot.stockUsage || []).filter(r => r.date !== gone)
  }));
  assert.ok(!app.state.days[gone], 'the deleted day must be gone');
  assert.ok(!app.state.counts[gone], 'its counts must be gone too');
  assert.ok(!app.state.stockUsage[gone], 'and its stock rows with it');
});

test('an expense deleted in the sheet disappears from the phone', () => {
  const app = syncedClient(F.boot);
  const gone = Object.keys(app.state.expenses)[0];
  assert.ok(gone, 'precondition: the phone holds an expense');
  assert.ok(app.state.expenses[gone].date >= F.boot.window_start, 'precondition: inside the window');
  app.applyBootstrap(Object.assign({}, F.boot, {
    expenses: F.boot.expenses.filter(e => (e.entry_id || e.entryId) !== gone)
  }));
  assert.ok(!app.state.expenses[gone], 'the deleted expense must be gone');
});

test('inside a stated window, an omitted day IS deleted (server is authoritative)', () => {
  // saveDay always writes the DailyLog row together with its detail blocks, so
  // "supplies for a date but no day row" is not a state the server can produce.
  // With the window stated, an omitted day means deleted — that is the point.
  const app = syncedClient(F.boot);
  const keep = Object.keys(app.state.days)[0];
  app.applyBootstrap(Object.assign({}, F.boot, { days: [], counts: [] }));
  assert.ok(!app.state.days[keep], 'a day the windowed reply omits must go');
});

test('without a stated window, one collection cannot delete another\'s dates', () => {
  // Sharing one covered set across collections let a date carrying supplies wipe
  // that date's day. On the legacy path each collection judges its own dates.
  const app = syncedClient(F.boot);
  const keep = Object.keys(app.state.days)[0];
  const legacy = Object.assign({}, F.boot, { days: [], counts: [] });
  delete legacy.window_start;
  app.applyBootstrap(legacy);
  assert.ok(app.state.days[keep], 'the day must survive on the cautious path');
});

test('history OLDER than the window is never touched', () => {
  const app = syncedClient(F.boot);
  const old = '2019-01-05';
  app.state.days[old] = { date: old, closed: false, staff: 'Mama', gcash: 0,
    total: 777, cash: 777, custom_amount: 777, notes: '', entry_id: 'ancient', updated_at: '' };
  app.applyBootstrap(F.boot);
  assert.ok(app.state.days[old] && app.state.days[old].total === 777, 'uncovered history survives');
});

test('an older server that omits window_start deletes NOTHING', () => {
  const app = syncedClient(F.boot);
  const keep = Object.keys(app.state.days)[0];
  const legacy = Object.assign({}, F.boot, { days: [], counts: [], expenses: [] });
  delete legacy.window_start;
  app.applyBootstrap(legacy);
  assert.ok(app.state.days[keep], 'without a stated window the phone must stay cautious');
});

// ---------------------------------------------------------------------------
// 14. v2.3.1 — the frontend review findings. Each test here fails on the build
// that shipped 2.3.0, and each one is about money or about not lying to the
// person entering it.
// ---------------------------------------------------------------------------
console.log('\n--- 14. v2.3.1 frontend fixes ---');

/** A saveDay REQUEST for one date, the shape the Sales screen queues. */
function dayPayload(date, sod, entryId) {
  return {
    date: date, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
    salary: '', notes: '',
    counts: [{ sku: 'box4', sod: sod, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }],
    stock: [], entryId: entryId
  };
}

// --- M1: a day the server REFUSED must not be wiped by the next bootstrap ----
// A rejection LEAVES the queue (it would jam every later item) and lives only on
// the needs-attention list. reapplyQueue replayed the queue alone, so
// applyBootstrap saw the date inside window_start, found it absent from the
// reply, and deleted the only copy of that day in existence — while the red card
// still told her to go and fix it.

test('M1: a day the server REFUSED survives the next bootstrap', () => {
  const app = syncedClient(F.boot);
  const day = '2026-07-28';                       // inside the stated window, not in the sheet
  assert.ok(day >= F.boot.window_start, 'the test date must be inside the window to bite');
  assert.ok(!F.boot.days.some(d => d.date === day), 'and the sheet must not have it');

  const payload = dayPayload(day, 100, 'rej-1');
  app.applyLocalDay(payload);                     // the optimistic local write
  assert.strictEqual(app.state.days[day].total, 5000, '100 x ₱50');
  // Exactly what drainQueue does with a server refusal.
  app.noteAttention('rejected', 'saveDay', payload, 'End of day is bigger than start of day.');
  assert.strictEqual(app.queue.length, 0, 'a refused mutation is NOT in the queue any more');

  app.applyBootstrap(F.boot);                     // the very next sync

  assert.ok(app.state.days[day], 'the refused day was WIPED off the phone — the only copy of it');
  assert.strictEqual(app.state.days[day].total, 5000, 'and it must still be worth ₱5,000');
  assert.strictEqual((app.state.counts[day] || []).length, 1, 'its counts must survive too');
  assert.strictEqual(app.dateNotInSheet(day), true, 'it is still missing from the sheet');

  // The card says "Open this day, fix what that message says" — so opening it
  // has to show the numbers she typed.
  app.loadBentaForm(day);
  assert.strictEqual(app.benta.rows.find(r => r.sku === 'box4').sod, 100,
    'the form came back empty: nothing left to fix, and nothing left to re-send');
  assert.strictEqual(app.computeDay(app.bentaPayload()).total, 5000);
});

test('M1: a refused expense and a refused stocktake survive it too', () => {
  const app = syncedClient(F.boot);
  const exp = { date: '2026-07-27', category: 'Supplies', item: 'harina', amount: 340,
    backlogRef: '', notes: '', stockProduct: '', stockQty: '', entryId: 'rej-exp-1' };
  app.applyLocalExpense(exp);
  app.noteAttention('rejected', 'saveExpense', exp, 'refused');
  const cnt = { date: '2026-07-27', product: 'Bonito', qty: 9, entryId: 'rej-cnt-1' };
  app.applyLocalStockCount(cnt);
  app.noteAttention('rejected', 'saveStockCount', cnt, 'refused');

  app.applyBootstrap(F.boot);
  assert.ok(app.state.expenses['rej-exp-1'], 'the refused expense was wiped');
  assert.strictEqual(app.state.expenses['rej-exp-1'].amount, 340);
  const counts = (app.state.stockCounts['2026-07-27'] || []).filter(r => r.entry_id === 'rej-cnt-1');
  assert.strictEqual(counts.length, 1, 'the refused stocktake was wiped');
  assert.strictEqual(counts[0].counted_qty, 9);
});

test('M1: the QUEUE keeps the last word over an older refusal for the same day', () => {
  const app = syncedClient(F.boot);
  const day = '2026-07-28';
  const refused = dayPayload(day, 100, 'rej-2');     // the older, refused figures
  const requeued = dayPayload(day, 60, 'fix-2');     // what she re-entered after
  app.noteAttention('rejected', 'saveDay', refused, 'refused');
  app.queue.push({ action: 'saveDay', payload: requeued, tries: 0 });

  app.applyBootstrap(F.boot);
  assert.strictEqual(app.state.days[day].total, 3000,
    'the stale refused payload overwrote the corrected one that is on its way');
});

test('M1: replaying the attention list is idempotent (no doubled rows)', () => {
  const app = syncedClient(F.boot);
  const cnt = { date: '2026-07-26', product: 'Bonito', qty: 4, entryId: 'rej-cnt-2' };
  app.applyLocalStockCount(cnt);
  app.noteAttention('rejected', 'saveStockCount', cnt, 'refused');
  app.applyBootstrap(F.boot);
  app.applyBootstrap(F.boot);
  app.reapplyQueue();
  const rows = (app.state.stockCounts['2026-07-26'] || []);
  assert.strictEqual(rows.length, 1, 'a replayed stocktake must upsert, never duplicate');
});

// --- M2: never render a note that contradicts the figures above it -----------

test('M2: a typed-but-unsaved Split is a contradiction, and pendingSplit names it', () => {
  const app = syncedClient(F.boot);
  const per = { start: PERIOD.start, end: PERIOD.end };
  const key = app.periodKey(per);
  assert.strictEqual(app.splitFor(per).amount, EXPECT.split, 'the fixture saved 2,000 for this period');
  assert.strictEqual(app.pendingSplit(per), null, 'nothing typed yet, so nothing to warn about');

  app.splitEdits[key] = '6000';                    // typed into the field, not saved
  const pend = app.pendingSplit(per);
  assert.ok(pend, 'the screen shows 6,000 while the note would print 2,000');
  assert.strictEqual(pend.amount, 6000);
  assert.strictEqual(pend.saved, EXPECT.split);

  // This is the contradiction the guard exists to prevent: the preview above and
  // the note below, on one screen, disagreeing about the same money.
  const live = app.liveCutoff(per);
  const note = app.buildNote(app.computeCutoff(per), per);
  assert.strictEqual(live.split, 6000);
  assert.ok(note.indexOf('Split - 2,000(1,000 each)') !== -1,
    'the note is built from the SAVED figure: ' + JSON.stringify(note));
  assert.notStrictEqual(live.remaining, app.computeCutoff(per).remaining,
    'and the residuals differ too, so both cannot be shown at once');

  // Saving it (what "Save this split" does) makes them agree and lifts the guard.
  app.applyLocalCutoffSplit({ start: per.start, end: per.end, amount: 6000, entryId: 'm2-1' });
  delete app.splitEdits[key];
  assert.strictEqual(app.pendingSplit(per), null);
  const after = app.buildNote(app.computeCutoff(per), per);
  assert.ok(after.indexOf('Split - 6,000(3,000 each)') !== -1, after);
  assert.strictEqual(app.liveCutoff(per).remaining, app.computeCutoff(per).remaining);
});

test('M2: re-typing the figure that is already saved is not a contradiction', () => {
  const app = syncedClient(F.boot);
  const per = { start: PERIOD.start, end: PERIOD.end };
  app.splitEdits[app.periodKey(per)] = String(EXPECT.split);
  assert.strictEqual(app.pendingSplit(per), null,
    'the note would print exactly this figure, so it must not be refused');
});

// --- m4: a BLANK Split field means the amount it will actually save ----------

test('m4: an EMPTY Split field previews the default, not ₱0', () => {
  const app = syncedClient(F.boot);
  const per = { start: PERIOD.start, end: PERIOD.end };
  const key = app.periodKey(per);
  assert.strictEqual(app.splitFieldAmount(''), app.splitDefault(), 'blank = the usual amount');
  assert.strictEqual(app.splitFieldAmount(null), app.splitDefault());
  assert.strictEqual(app.splitFieldAmount('2500'), 2500);

  app.splitEdits[key] = '';                        // she cleared the field
  const previewed = app.liveCutoff(per);
  assert.strictEqual(previewed.split, app.splitDefault(),
    'a blank field previewed ₱0, swinging the headline residual by the whole split');

  // The invariant: what the screen promises IS what the save writes.
  app.applyLocalCutoffSplit({ start: per.start, end: per.end,
    amount: app.splitFieldAmount(app.splitEdits[key]), entryId: 'm4-1' });
  delete app.splitEdits[key];
  const saved = app.computeCutoff(per);
  assert.strictEqual(saved.split, previewed.split);
  assert.strictEqual(saved.perPartner, previewed.perPartner);
  assert.strictEqual(saved.remaining, previewed.remaining);
});

// --- M3: a sku still being sold cannot be priced at ₱0 ----------------------

test('M3: clearing a price on a sku still being sold is refused (client)', () => {
  const app = syncedClient(F.boot);
  const box4 = app.state.prices.find(p => p.sku === 'box4');
  // num('') is 0, so a cleared field is a ₱0 price — the Sales card then read
  // "₱0 · Cheese ₱60" and every box counted as free.
  const msg = app.priceRowError(box4, { price: '', cheesePrice: 60, active: true });
  assert.ok(msg, 'a cleared price on an active sku saved ₱0 silently');
  assert.match(msg, /needs a price/);
  assert.match(msg, /Box 4/, 'the message names the row the way the screen does');
  assert.strictEqual(app.priceRowError(box4, { price: 0, cheesePrice: 60, active: true }), msg,
    'a typed 0 is the same hole as a blank');
  // The cheese field is a price too, and just as easy to clear.
  assert.match(app.priceRowError(box4, { price: 50, cheesePrice: '', active: true }), /cheese price/);
  // An INACTIVE sku may keep its 0: it sells nothing, and refusing it would make
  // an old unpriced sku impossible to save.
  assert.strictEqual(app.priceRowError(box4, { price: '', cheesePrice: '', active: false }), '');
  assert.strictEqual(app.priceRowError(box4, { price: 50, cheesePrice: 60, active: true }), '');
  assert.match(app.priceRowError(box4, { price: -1, cheesePrice: 60, active: true }), /less than zero/);
  // group=simple has no cheese version, so a 0 there is correct.
  assert.strictEqual(app.priceRowError({ sku: 'soda', label: 'Soda', group: 'simple' },
    { price: 25, cheesePrice: 0, active: true }), '');
});

test('M3: the REAL server refuses it too — that is the guard that matters', () => {
  const srv = loadServer();
  const bad = post(srv.ctx, { token: srv.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: '', cheesePrice: 60, active: true }] } });
  assert.strictEqual(bad.ok, false, 'the server stored ₱0 for a sku that is still selling');
  assert.match(bad.error, /needs a price/);
  const cheese = post(srv.ctx, { token: srv.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 50, cheesePrice: 0, active: true }] } });
  assert.strictEqual(cheese.ok, false, 'a box sku still selling needs its cheese price too');
  assert.match(cheese.error, /cheese price/);
  // Nothing was written by either refusal.
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.prices.find(p => p.sku === 'box4').price, 50);
  assert.strictEqual(boot.data.prices.find(p => p.sku === 'box4').cheese_price, 60);
  // Switching the sku OFF is how you stop selling it, and that still saves.
  const off = post(srv.ctx, { token: srv.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 0, cheesePrice: 0, active: false }] } });
  assert.strictEqual(off.ok, true, off.error);
});

// --- m5: the phone must not seed a sku the sheet has never heard of ---------

test('m5: every sku the phone seeds exists in the sheet, so the first price change lands', () => {
  const app = loadClient();                        // never synced: these are the seeds
  const srv = loadServer();
  const sheetSkus = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} })
    .data.prices.map(p => p.sku);
  app.state.prices.forEach(p => {
    assert.ok(sheetSkus.indexOf(p.sku) !== -1,
      'the phone seeds "' + p.sku + '" but setupSheet() never creates it, so savePrices ' +
      'refuses the WHOLE batch and no price can be changed before the first sync');
  });

  // End to end: exactly the batch Maintenance sends on a phone that has not
  // synced yet must be accepted by the real server.
  const rows = app.state.prices.map(p => ({
    sku: p.sku, price: app.num(p.price), cheesePrice: app.num(p.cheese_price), active: !!p.active
  }));
  const r = post(srv.ctx, { token: srv.token, action: 'savePrices', payload: { rows: rows } });
  assert.strictEqual(r.ok, true, 'a fresh phone could not change a price at all: ' + r.error);
  assert.strictEqual(r.data.saved, rows.length);
});

// --- m6: "Saved" must never be the last word about a refused day ------------

test('m6: the save toast is never a claim that outran the server', () => {
  const app = syncedClient(F.boot);
  const day = '2026-07-25';
  // Demo mode: the phone IS the destination, so saying so is honest.
  app.cfg.apiUrl = '';
  assert.strictEqual(app.daySavedMessage(day), 'Saved on this phone.',
    'with no API there is nowhere else for it to go');

  // With an API set, "Saved" was a RACE: true only if the refusal happened to
  // beat the tear-off animation. While the day is still queued, say that.
  app.cfg.apiUrl = 'https://example.invalid/exec';
  app.q.push({ action:'saveDay', payload: dayPayload(day, 10, 'pending-1'), tries:0 });
  assert.strictEqual(app.daySavedMessage(day), 'Sending ' + app.fmtShort(day) + ' to the sheet…',
    'a day still in the queue has not reached the sheet yet');

  // Once nothing is queued for it, it really is in the sheet.
  app.q.length = 0;
  assert.strictEqual(app.daySavedMessage(day), 'Saved ' + app.fmtShort(day) + '.',
    'an accepted day still says so');
  app.noteAttention('rejected', 'saveDay', dayPayload(day, 10, 'rej-3'), 'refused');
  assert.strictEqual(app.daySavedMessage(day), '',
    'the animation callback fires ~450ms AFTER the rejection toast, so "Saved" landed last');
  // A dropped sku is a note about ONE sku, not a missing day: that day IS saved.
  const other = '2026-07-24';
  app.noteAttention('dropped', 'saveDay', dayPayload(other, 10, 'drop-1'), 'Box 9 is no longer in the Prices tab.');
  assert.strictEqual(app.daySavedMessage(other), 'Saved ' + app.fmtShort(other) + '.');
});

// --- m9: the stock unit is free text, escaped exactly once ------------------

test('m9: a stock unit with an "&" is not double-escaped', () => {
  const app = syncedClient(F.boot);
  const sauce = app.state.stockItems.find(s => s.product === 'Takoyaki Sauce');
  sauce.unit = 'gallon & jug';                     // free text, typed on Maintenance
  app.loadBentaForm(DAY);                          // no usage on this date -> the 0 branch
  const html = app.stockCardHTML();
  assert.ok(html.indexOf('in gallon &amp; jugs') !== -1, 'escaped exactly once: ' + html);
  assert.strictEqual(html.indexOf('&amp;amp;'), -1,
    'double-escaped, so the row prints the entity itself ("in gallon &amp; jugs")');
  // The text itself is PLAIN — whoever renders it escapes it once, and the
  // in-place update writes it with textContent.
  assert.strictEqual(app.stockRowSaid('', 'gallon & jug'), 'in gallon & jugs');
  assert.strictEqual(app.stockRowSaid(2, 'gallon & jug'), '2 gallon & jugs opened');
  assert.strictEqual(app.stockRowSaid(1, 'gallon & jug'), '1 gallon & jug opened');
  assert.strictEqual(app.stockRowSaid(0, ''), '');
  // A quote in a unit must not break out of the attribute either.
  sauce.unit = 'jug "big"';
  app.loadBentaForm(DAY);
  const q = app.stockCardHTML();
  assert.ok(q.indexOf('in jug &quot;big&quot;s') !== -1, q);
  assert.strictEqual(q.indexOf('&amp;quot;'), -1, 'a quote must not be escaped twice either');
});

// --- m10: the nightly screen is shorter, without hiding anything entered ----

test('m10: the wage card starts CLOSED on an ordinary night', () => {
  const app = syncedClient(F.boot);
  app.loadBentaForm(DAY);                          // the fixture day: the usual ₱200
  assert.strictEqual(app.daySalary(app.state.days[DAY]), EXPECT.salary);
  assert.strictEqual(app.wageIsCustom(), false);
  assert.strictEqual(app.benta.wageOpen, false, 'the common path to "Save day" must be short');
  const html = app.wageCardHTML();
  assert.ok(html.indexOf('data-act="toggle-wage"') !== -1, 'it has to be openable');
  assert.ok(html.indexOf('aria-expanded="false"') !== -1, html.slice(0, 200));
  assert.ok(/id="wageBody"\s+hidden/.test(html), 'the body starts hidden');
  // Collapsed is not invisible: the figure is in the head, where it can be read
  // without opening anything.
  assert.ok(html.indexOf('₱200') !== -1, 'the wage itself must stay on screen: ' + html);
  assert.strictEqual(app.wageSummary(), '₱200');
});

test('m10: a wage that is NOT the usual rate opens the card by itself', () => {
  const app = syncedClient(F.boot);
  app.state.days[DAY].salary = 100;                // a half day
  app.loadBentaForm(DAY);
  assert.strictEqual(app.benta.salary, 100);
  assert.strictEqual(app.wageIsCustom(), true);
  assert.strictEqual(app.benta.wageOpen, true, 'a figure already entered must never be hidden');
  const html = app.wageCardHTML();
  assert.ok(html.indexOf('aria-expanded="true"') !== -1);
  assert.strictEqual(/id="wageBody"\s+hidden/.test(html), false, 'the body must be open');
  assert.strictEqual(app.wageSummary(), '₱100');

  // A day nobody was paid is a figure too — 0 is not "empty".
  app.state.days[DAY].salary = 0;
  app.loadBentaForm(DAY);
  assert.strictEqual(app.wageIsCustom(), true);
  assert.strictEqual(app.benta.wageOpen, true);
  assert.strictEqual(app.wageSummary(), '₱0');
});

test('m10: the wage still round-trips through the request payload', () => {
  const app = syncedClient(F.boot);
  app.state.days[DAY].salary = 100;
  app.loadBentaForm(DAY);
  assert.strictEqual(app.bentaPayload().salary, 100, 'collapsing a card must not drop its figure');
  const srv = loadServer();
  const r = post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: Object.assign(app.bentaPayload(), { entryId: 'm10-1' }) });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.salary, 100, 'the sheet snapshots the wage the card was holding');
});

// --- The call sites. The guards above are only fixes if the screens use them,
// and these four live inside render/save functions that need a DOM, so they are
// pinned against the SOURCE — the same way the slab markers are. A guard nothing
// calls is not a fix. ------------------------------------------------------
test('the screens actually use the guards: note, toast, wage card, prices, split', () => {
  const gen = slab('async function generateNote(){', 'async function copyNote(){');
  assert.ok(/pendingSplit\(/.test(gen),
    'generateNote must refuse while the Split field disagrees with the saved figure');
  assert.ok(gen.indexOf('pendingSplit(') < gen.indexOf('buildNote('),
    'the check must come BEFORE the offline copy is built');
  assert.ok(gen.indexOf('pendingSplit(') < gen.indexOf("api('cutoff'"),
    'and before the server is asked to archive one');

  const save = slab('function saveBenta(){', 'function prefersReduced(){');
  assert.ok(/daySavedMessage\(/.test(save),
    'the tear-off callback must ask before it says "Saved"');
  assert.strictEqual(/toast\('Saved '/.test(save), false,
    'an unconditional "Saved" toast is exactly the bug');

  const render = slab('function renderBenta(){', 'const CHEV =');
  assert.ok(/wageCardHTML\(\)/.test(render), 'the Sales screen must render the collapsible wage card');
  assert.ok(/stockCardHTML\(\)/.test(render), 'and the stock card as before');

  const prices = slab('function saveMaintPrices(){', 'function saveMaintSettings(){');
  assert.ok(/priceRowError\(/.test(prices), 'saving prices must run the price rule');

  const cutoff = slab('function renderCutoff(){', 'async function generateNote(){');
  assert.ok(/liveCutoff\(/.test(cutoff), 'the preview must read the Split field the way a save does');
  const live = slab('function updateSplitLive(){', 'function saveSplit(){');
  assert.ok(/liveCutoff\(/.test(live), 'and so must the live update while she types');
  // A note ALREADY on screen was built from the saved split, so it must come off
  // the screen while the field disagrees — the same contradiction, two taps away.
  assert.ok(/noteBlock/.test(cutoff) && /pendingSplit\(/.test(cutoff),
    'the rendered note block must be hidden when the Split field is unsaved');
  assert.ok(/noteBlock/.test(live), 'and hidden/shown as she types, without a re-render');
});

// ---------------------------------------------------------------------------
console.log('\n============================================');
console.log('  ' + passed + ' passed, ' + failed + ' failed  (' + path.basename(__filename) + ')');
console.log('============================================');
if (failed > 0) {
  failures.forEach(f => console.error('\nFAILED: ' + f.name + '\n' + f.err.stack));
  process.exit(1);
}

// ---------------------------------------------------------------------------
