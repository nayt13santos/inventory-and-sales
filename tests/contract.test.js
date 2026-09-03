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
// validateBenta + excludedRowError: every rule apiSaveDay enforces, mirrored on the
// phone so it never queues a day the server will refuse.
const S_VALIDATE  = slab('function isWhole(v){', "/** 'sku:box4' -> 'err-sku-box4'");
// BLANK IS NOT ZERO (v2.9.0): the display-only readers, needed by validateBenta
// too — its empty-end-count refusal is the guard that stops an inflated night.
const S_BLANKS   = slab('function rowUI(r){', 'function syncRowInputs(sku, r){');
// v2.7.4: the Cutoff screen's stock block, plus the window guard it consults.
// v2.17.0 extended the end marker by exactly one function to bring in
// cutoffExpenseDate, which was sitting in the gap between two slabs and so had
// never been lifted or tested. The Expenses screen now depends on it for
// correctness — it is what stops an entry typed on an earlier cutoff from being
// dated today and vanishing from the list it was saved on.
const S_PREVINC   = slab('function missingDaysInPeriod(per){', 'function splitHintText(per, f){');
const S_STOCKCUT  = slab('function stockCutoffHTML(per){', 'function excludedBlockHTML(f){');
// The readable name for a sku — what the target table prints, and the one thing
// in the costing screen that reads a sku out of state rather than the response.
const S_SKULABEL  = slab('function prettySku(sku){', 'function listPhrase(names){');
// v2.8.0 "What it costs": costInvalidate, the null helpers, and the three
// builders that turn a `costing` response into the screen. Lifted whole so the
// tests render the REAL markup from the REAL server reply.
const S_COSTING   = slab('let costOpen = false;', 'async function testConnection(){');

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
${S_VALIDATE}
${S_BLANKS}
${S_PREVINC}
${S_STOCKCUT}
${S_SKULABEL}
${S_COSTING}
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
// The costing screen's chrome. api() throws by default: the DEFAULT state here
// is "no server", which is exactly the state the screen must survive without
// drawing a page of zeros.
let activeTab = 'ibapa';
let lastErr = {};
function $(){ return null; }
function setErr(id, msg){ lastErr[id] = msg; }
function renderIbapa(){}
// v2.13.1: catchUpFill moves her to the Sales screen. No DOM here, so the two
// calls are RECORDED — being taken to the night it filled in is part of what
// the action promises, not incidental.
const moved = [];
function showTab(t){ moved.push(String(t)); }
function renderPanel(t){ moved.push('render:' + String(t)); }
function friendlyError(err, nextStep){ return String((err && err.message) || err) + ' ' + nextStep; }
async function api(){ throw new Error('no wire in this harness'); }
return {
  get state(){ return state; },
  get benta(){ return benta; },
  get queue(){ return queue; },
  get attention(){ return attention; },
  set attention(v){ attention = v; },
  // v2.22.0: the note on screen, so a test can prove a cost edit drops it.
  get lastNote(){ return lastNote; },
  set lastNote(v){ lastNote = v; },
  get splitEdits(){ return splitEdits; },
  pick, normPrice, normBacklog, normDay, normCount, normExpense, normStockItem,
  normStockDelivery, sanitizeQueue, sanitizeState,
  applyBootstrap, applyLocalDay, applyLocalExpense, applyLocalStockCount,
  applyLocalStockDelivery,
  applyLocalCutoffSplit, applyLocalPrices, applyLocalStockItems, applyServerDay, reapplyQueue,
  backlogBalance,
  loadBentaForm, bentaPayload, computeDay, computeCutoff, buildNote,
  // The stock ledger the phone computes for itself (never stored) and the two
  // figures the cutoff needs from Settings.
  stockStatusOf, stockStatusList, qtyWithUnit, daySalary, splitFor, dailySalary,
  // v2.10.2: how long what is on the shelf will last, at the rate it is going.
  stockRunway, stockRunwayText,
  // v2.12.1: the tin count and what the difference means.
  tinCountFor, tinVerdict, applyLocalTinCount, applyLocalCutoffSplit,
  // v2.13.0: the run of nights nobody logged anything as opened.
  openedGap, openedGapText, stockCardHTML, logsNoSupplies,
  // v2.19.0: what a day save would DESTROY, and the shelf-emptying challenge.
  daySaveRisk, catchEmptyWarning,
  // v2.13.1: what was opened, worked out from what is left on the shelf.
  catchUpPlan, catchUpNight, catchUpFill,
  // v2.14.0: what was used between two counts — measured, not remembered.
  countsFor, usedBetweenCounts, usedBetweenText,
  // v2.14.1: the night the catch-up lands on, including a cutoff that has ended.
  catchUpTarget, catchLandsText, sameDayCountClash,
  // v2.16.0: supplies in two lines — major is opened, minor is the daily buying.
  suppliesSplit,
  // v2.17.0: the Expenses screen can be stepped back to a cutoff that has ended,
  // and a new entry lands in the cutoff on screen rather than always today.
  gastosFor, cutoffExpenseDate, gastosWords, periodLabel,
  // v2.22.0: the opened value as an allocation, and the raw figure behind it.
  noteUsedFig,
  // v2.20.0: minor is EVERYTHING entered on the Expenses screen.
  noteMinorVal,
  // v2.18.0: a list of dated amounts, typed once instead of ten at a time.
  parseDatedAmounts, datedAmountId,
  stashBentaDraft,
  get drafts(){ return drafts; },
  get catchNightPick(){ return catchNightPick; },
  set catchNightPick(v){ catchNightPick = v; },
  get moved(){ return moved; },
  get catchDraft(){ return catchDraft; },
  // v2.11.0: how the nights compare.
  trendNights, trendByWeekday, trendBySku, trendCutoffs, trendHTML, weekdayName,
  trendState(v){ if (v && 'open' in v) trendOpen = v.open; },
  currentPeriod, shiftPeriod, periodKey, num, r2, fmt, fmtShort, activePrices,
  // v2.3.1: the Split field's one reading, the note guard, what may be said
  // about a refused day, the two collapsible cards, and the price rule.
  splitFieldAmount, liveCutoff, pendingSplit, splitDefault, cutoffWithSplit,
  noteAttention, attentionForDate, dateNotInSheet, daySavedMessage,
  stockRowSaid, stockCardHTML, stockCutoffHTML, wageCardHTML, wageIsCustom, wageSummary,
  // v2.21.0: what a cutoff STARTED with, so "1 came in, 2 opened" adds up,
  // and the date a stock correction is FOR.
  openingCountFor, countDateFor, countDateHint,
  get countDateDraft(){ return countDateDraft; },
  set countDateDraft(v){ countDateDraft = v; },
  priceRowError,
  // v2.4.0: the flag whose BLANK means TRUE, the per-sku lookup the screens read,
  // and the period's excluded block (display only).
  inCutoffFlag, skuInCutoff, excludedForPeriod,
  // v2.4.1: the count row's own SNAPSHOT (raw, then resolved at read time), the one
  // rule the receipt and the day strip both read for "is there excluded money
  // tonight", the tin, and the day validator with its excluded-sku refusals.
  rawCutoffFlag, countInCutoff, excludedTonight, tinTotal,
  validateBenta, excludedRowError, isBoxSku,
  // v2.5.1: the day-effective flag beside the day's prices, the local applier
  // for a deleted expense (the stock ledger must move at once), the blank-
  // omitting settings payload, and the phone's own note refusal.
  cutoffOnDay, storedPricesFor, priceOnDay, applyLocalDeleteExpense,
  missingDaysInPeriod, previewIncomplete, addDays, todayStr,
  maintSettingsPayload, noteRefusal,
  // v2.7.0: the SOD prefill's lookup, the one rule for the GCash card starting
  // open, the expense form's picklist, and the two display-only builders.
  prevEodFor, gcashHeld, supplyPicklist, cashRecapHTML, gcashSummaryText,
  // v2.8.0: the costing screen. The three builders, the null helpers, the
  // invalidator a Maintenance save calls, and live handles on the section's
  // state so a test can put it in any of its rendering states.
  costingHTML, costFiguresHTML, costTargetOutHTML, costInvalidate,
  isNone, costPeso, costNum, costWhyNone, skuLabel,
  // v2.10.0: "does this night look right?" — tonight judged against the others.
  nightChecks, nightCheckHTML, soldHistory, totalHistory, medianOf,
  costState(v){
    if (v && 'open' in v) costOpen = v.open;
    if (v && 'per' in v) costPer = v.per;
    if (v && 'res' in v) costRes = v.res;
    if (v && 'err' in v) costErr = v.err;
    if (v && 'busy' in v) costBusy = v.busy;
    if (v && 'stale' in v) costStale = v.stale;
    if (v && 'target' in v) costTarget = v.target;
    return { open: costOpen, per: costPer, res: costRes, err: costErr,
      busy: costBusy, stale: costStale, target: costTarget };
  },
  errs: lastErr,
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
  // in_cutoff (v2.4.0): FALSE means "sold and counted, but its money stays out
  // of every cutoff figure". A camelCase slip here would arrive as undefined —
  // and the phone's fallback for an unknown flag has to be "counts in", so the
  // owner's excluded sku would quietly rejoin the note.
  // box_cost (v2.8.0) is what ONE container for this sku costs. A camelCase slip
  // would arrive as undefined, rawNum('') it to blank, and the costing screen
  // would report every box the owner sells as having no cost on file — or, worse
  // on the way back, write a literal 0 into the cell and price his boxes free.
  'bootstrap.prices[]':    [['cheese_price', 'cheesePrice'], ['in_cutoff', 'inCutoff'], ['box_cost', 'boxCost']],
  // gcash_converted (v2.7.0) is tin cash swapped for a GCash transfer — already
  // inside the stored `gcash` and out of `cash`. lid_boxes is a plain count with
  // no money. A camelCase slip on either would read as 0 on the phone: the
  // receipt's converted-cash line would vanish while the split it explains stays.
  // photo_url (v2.9.0) is the link to the photograph the night was read from. It
  // is provenance, never a figure — but a camelCase slip would arrive as
  // undefined, and the Sales screen's "this came from the paper" link would
  // silently disappear from every night that HAS one, which is the one case
  // where the owner most wants to see it.
  'bootstrap.days[]':      [['custom_amount', 'customAmount'], ['custom_gcash', 'customGcash'], ['excluded_total', 'excludedTotal'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt'], ['gcash_converted', 'gcashConverted'], ['lid_boxes', 'lidBoxes'], ['photo_url', 'photoUrl']],
  // in_cutoff on a COUNT row is the v2.4.1 snapshot: what the flag said when that
  // day was saved. History is classified by it, so a camelCase slip would make
  // every row look unsnapshotted and hand the classification back to the live flag.
  // custom_qty (v2.7.0) is the special-order snapshot: this row's `amount`
  // prices sold − custom_qty units, and only the row can say so. A camelCase
  // slip would read 0 and the receipt would re-price the order's boxes.
  'bootstrap.counts[]':    [['cheese_qty', 'cheeseQty'], ['regular_qty', 'regularQty'], ['gcash_qty', 'gcashQty'], ['gcash_cheese_qty', 'gcashCheeseQty'], ['gcash_amount', 'gcashAmount'], ['entry_id', 'entryId'], ['in_cutoff', 'inCutoff'], ['custom_qty', 'customQty']],
  'bootstrap.expenses[]':  [['backlog_ref', 'backlogRef'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt'], ['stock_product', 'stockProduct'], ['stock_qty', 'stockQty']],
  'bootstrap.backlogs[]':  [['total_amount', 'totalAmount'], ['start_date', 'startDate']],
  'bootstrap.stockUsage[]':    [['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  // v2.3.0 stock ledger. on_hand and the three numbers behind it are COMPUTED
  // server-side, so a camelCase slip here would show the owner ₱0 of stock.
  // delivered_before/used_before (v2.5.1) are the pre-window parts the phone
  // ADDS to its own in-window rows — a slip here silently drops every delivery
  // older than the bootstrap window from on-hand.
  // unit_cost (v2.8.0) is what one of THIS unit costs — the pack, the gallon —
  // and it is what makes StockUsage.qty x unit_cost an answer at all.
  'bootstrap.stockItems[]':    [['on_hand', 'onHand'], ['reorder_at', 'reorderAt'], ['opening_qty', 'openingQty'], ['opening_date', 'openingDate'], ['baseline_qty', 'baselineQty'], ['baseline_date', 'baselineDate'], ['delivered_since', 'deliveredSince'], ['used_since', 'usedSince'], ['delivered_before', 'deliveredBefore'], ['used_before', 'usedBefore'], ['unit_cost', 'unitCost']],
  'bootstrap.stockCounts[]':   [['counted_qty', 'countedQty'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  // v2.6.0: goods arriving are their own rows now. A camelCase slip here would
  // read as 0 delivered on the phone — a full shelf shown empty.
  'bootstrap.stockDeliveries[]': [['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  'bootstrap.cutoffInputs[]':  [['split_amount', 'splitAmount'], ['entry_id', 'entryId'], ['updated_at', 'updatedAt']],
  // `supplies_total` is gone with the retired supplies card; dropped_skus is the
  // saveDay key the phone still has to read. excluded_total is the day's money
  // from excluded skus — the receipt prints it BELOW the totals, and the cash tin
  // only reconciles as Cash + excluded_total, so a misread key is a tin that
  // never balances.
  'saveDay':               [['dropped_skus', 'droppedSkus'], ['excluded_total', 'excludedTotal'], ['gcash_converted', 'gcashConverted'], ['lid_boxes', 'lidBoxes'], ['photo_url', 'photoUrl']],
  'saveDay.lines[]':       [['cheese_qty', 'cheeseQty'], ['regular_qty', 'regularQty'], ['gcash_qty', 'gcashQty'], ['gcash_cheese_qty', 'gcashCheeseQty'], ['gcash_amount', 'gcashAmount'], ['in_cutoff', 'inCutoff'], ['custom_qty', 'customQty']],
  'saveExpense':           [['entry_id', 'entryId']],
  'saveStockCount':        [['entry_id', 'entryId'], ['on_hand', 'onHand']],
  'saveStockDelivery':     [['entry_id', 'entryId'], ['on_hand', 'onHand']],
  'sheetCheck':            [['checked_rows', 'checkedRows']],
  'saveCutoffSplit':       [['entry_id', 'entryId'], ['split_amount', 'splitAmount'], ['per_partner', 'perPartner']],
  'cutoff':                [['note_text', 'noteText']],
  // excluded_lines is the DISPLAY-ONLY block under the note. It enters no other
  // figure, but the Cutoff screen has to be able to read it.
  'cutoff.figures':        [['per_partner', 'perPartner'], ['excluded_lines', 'excludedLines']],
  'bootstrap.lastCutoff':  [['per_partner', 'perPartner'], ['note_text', 'noteText'], ['generated_at', 'generatedAt']],
  // v2.8.0 `costing`. Every one of these is read by the costing screen and by
  // nothing else, so a camelCase slip is silent: costPeso(undefined) prints the
  // dash the screen reserves for "no cost on file", and the owner would read a
  // page of dashes as "the app cannot cost this" instead of a key mismatch.
  'costing':               [['days_open', 'daysOpen'], ['per_sku', 'perSku'], ['break_even_balls', 'breakEvenBalls'], ['per_day', 'perDay']],
  'costing.variable':      [['per_ball', 'perBall']],
  'costing.fixed':         [['per_day', 'perDay']],
  'costing.per_sku[]':     [['cost_per_box', 'costPerBox'], ['margin_per_box', 'marginPerBox'], ['margin_per_ball', 'marginPerBall']],
  'costing.targets[]':     [['per_day', 'perDay']],
  // v2.9.0 `readSheet` — the READING, and the one response in this app that
  // comes from a DIFFERENT project (standalone-scripts/Vision.gs, its own deployment,
  // its own token, its own key). It obeys the same standing rule for the same
  // reason: the phone reads snake_case, and a camelCase slip on any of these is
  // silent. total_on_paper is the worst of them — it is the figure the whole
  // cross-check rests on, so an undefined there would not show a wrong number,
  // it would quietly turn the cross-check OFF and leave a machine reading of a
  // photograph as the only witness to the night's money.
  'readSheet':             [['custom_amount', 'customAmount'], ['custom_gcash', 'customGcash'], ['total_on_paper', 'totalOnPaper'], ['photo_url', 'photoUrl'], ['photo_id', 'photoId'], ['photo_saved', 'photoSaved'], ['photo_error', 'photoError']],
  'readSheet.counts[]':    [['gcash_cheese', 'gcashCheese']]
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
  stockItems: true, stockUsage: true, stockCounts: true, stockDeliveries: true,
  cutoffInputs: true, lastCutoff: true
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
// A delivery is its OWN event now (v2.6.0): the QUANTITY through
// saveStockDelivery — no money anywhere near it, because the goods arrive on
// credit — and the PAYMENT, days or weeks later, as an ordinary Supplies
// expense with no stock attached.
const DELIVERY_PAYLOAD = {
  date: '2026-07-22', product: 'Takoyaki Flour', qty: 4, entryId: 'seam-deliv-1'
};
const PAYMENT_PAYLOAD = {
  date: '2026-07-22', category: 'Supplies', item: 'sako ng harina (paid)', amount: 500,
  backlogRef: '', notes: '', entryId: 'seam-pay-1'
};
// A LEGACY delivery — a pre-v2.6.0 expense row carrying stock_product/stock_qty.
// saveExpense refuses NEW rows like this, so the fixture writes it the only way
// it exists in the wild: already sitting in the sheet. It must keep counting
// into on-hand forever. Dated in the PREVIOUS cutoff so EXPECT.supplies stays
// the payment alone.
const LEGACY_DELIVERY_ROW = {
  date: '2026-07-08', category: 'Supplies', item: 'delivery (legacy)', amount: 350,
  backlog_ref: '', notes: '', entry_id: 'seam-legacy-1',
  updated_at: '2026-07-08 20:00:00', stock_product: 'Japanese Mayo', stock_qty: 2
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
  supplies: 500,          // the PAYMENT's peso amount, counted once, when paid
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
  const delivery = post(ctx, { token, action: 'saveStockDelivery', payload: DELIVERY_PAYLOAD });
  assert.strictEqual(delivery.ok, true, 'saveStockDelivery failed: ' + delivery.error);
  const payment = post(ctx, { token, action: 'saveExpense', payload: PAYMENT_PAYLOAD });
  assert.strictEqual(payment.ok, true, 'saveExpense (payment) failed: ' + payment.error);
  // The legacy expense-attached delivery, hand-placed by header name.
  ctx.appendObjects(ss, 'Expenses', [LEGACY_DELIVERY_ROW]);
  const stockCount = post(ctx, { token, action: 'saveStockCount', payload: COUNT_PAYLOAD });
  assert.strictEqual(stockCount.ok, true, 'saveStockCount failed: ' + stockCount.error);
  const split = post(ctx, { token, action: 'saveCutoffSplit', payload: SPLIT_PAYLOAD });
  assert.strictEqual(split.ok, true, 'saveCutoffSplit failed: ' + split.error);
  const cutoff = post(ctx, { token, action: 'cutoff', payload: { start: PERIOD.start, end: PERIOD.end, dryRun: false } });
  assert.strictEqual(cutoff.ok, true, 'cutoff failed: ' + cutoff.error);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, 'bootstrap failed: ' + boot.error);
  const check = post(ctx, { token, action: 'sheetCheck', payload: {} });
  assert.strictEqual(check.ok, true, 'sheetCheck failed: ' + check.error);
  // The costing over the SAME period the cutoff above covers (v2.8.0). A target
  // is asked for so `targets` is populated — an empty collection would make the
  // contract pins on it assert nothing.
  const costing = post(ctx, { token, action: 'costing',
    payload: { start: PERIOD.start, end: PERIOD.end, targetPerDay: 800 } });
  assert.strictEqual(costing.ok, true, 'costing failed: ' + costing.error);
  return {
    ctx, ss, token,
    saveDay: saveDay.data, stockDay: stockDay.data,
    saveExpense: saveExpense.data, delivery: delivery.data, payment: payment.data,
    stockCount: stockCount.data, split: split.data,
    cutoff: cutoff.data, boot: boot.data, sheetCheck: check.data,
    costing: costing.data
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
// v2.9.0 "Read it from the paper" — the READING fixture, off the REAL third
// project. It lives up here because the contract pins in section 7 read it, and
// those run before the sync harness exists. The behavioural tests are in
// section 21.
//
// The photo reader is a THIRD Apps Script project (standalone-scripts/Vision.gs) with
// its own deployment, its own token and its own Gemini key, so it is loaded the
// way it runs: alone, in its own context, with a CANNED model reply. The suite
// must never make a live call — and a canned reply is also the only way to
// exercise a half-read page, a quota wall or prose-instead-of-a-reading at all.
// ---------------------------------------------------------------------------
const VISION_GS = path.join(ROOT, 'standalone-scripts', 'Vision.gs');
// Shaped like a real Google API key and a real random token, and never equal to
// each other or to the sheet's: half the point of the third project is that the
// secret that writes money and the key that costs money never share a file.
const SEAM_KEY = 'AIzaSyB9fakeKeyForTestsOnly_0000000000';
const SEAM_TOK = 'vision-seam-4f9c1a7e2b8d05364a1f';

function loadVisionSeam() {
  const ctx = makeContext(new FakeSpreadsheet());
  vm.createContext(ctx);
  const src = fs.readFileSync(VISION_GS, 'utf8')
    .replace("var GEMINI_API_KEY = 'PASTE_THE_GEMINI_API_KEY_HERE';",
      "var GEMINI_API_KEY = '" + SEAM_KEY + "';")
    .replace("var VISION_TOKEN = 'PASTE_A_LONG_RANDOM_TOKEN_HERE';",
      "var VISION_TOKEN = '" + SEAM_TOK + "';");
  vm.runInContext(src, ctx, { filename: 'Vision.gs' });
  return ctx;
}
const vpost = (ctx, body) =>
  JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
/** A Gemini 200 body wrapping whatever the model "said". */
const geminiSaid = (obj) => ({
  candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }]
});
// Real base64 (the reader checks the alphabet before it spends anything) and small.
const SEAM_IMG = Buffer.from('a photograph of the paper for ' + DAY).toString('base64');

// The phone's OWN product vocabulary at THIS DAY's stored figures — what travels
// with the photograph, so the vision app never reads the sheet and "B4" becomes
// box4 by the owner's own labels. Written out here, and section 21 asserts it is
// byte-identical to what the shipped paperSkus() really produces: if the two
// ever drift, the fixture stops describing the phone and that test goes red.
// REQUEST keys are camelCase — cheesePrice, inCutoff — the standing rule.
const PAPER_SKUS = [
  { sku: 'box4',  label: 'Box 4',  size: 4,  price: 50,  cheesePrice: 60,  inCutoff: true },
  { sku: 'box6',  label: 'Box 6',  size: 6,  price: 65,  cheesePrice: 80,  inCutoff: true },
  { sku: 'box10', label: 'Box 10', size: 10, price: 105, cheesePrice: 125, inCutoff: true },
  { sku: 'nori',  label: 'Nori',   size: 0,  price: 25,  cheesePrice: 0,   inCutoff: false }
];

// The owner's own page, transcribed against those prices, and the money it has
// to come to — worked out by hand here, so a wrong prefill is a wrong FIGURE and
// not a wrong shape:
//   Box 4   31-28 -> sold  3, one of them cheese : 1x60 +  2x50  =   160
//   Box 6   12-12 -> sold  0                                     =     0
//   Box 10  55-34 -> sold 21, 14 paid by GCash   :      21x105   = 2,205
//   Nori    10-8  -> sold  2  (in_cutoff FALSE)  :       2x25    =    50  (BESIDE the day)
//   ------------------------------------------------------------------------
//   TOTAL 2,365    GCash 1,470 (14 x 105)    Cash 895    Excluded 50 (tin 945)
const PAPER_READ = {
  counts: [
    { sku: 'box4',  sod: 31, eod: 28, cheese: 1, gcash: 0,  gcash_cheese: 0, confidence: 0.95 },
    { sku: 'box6',  sod: 12, eod: 12, cheese: 0, gcash: 0,  gcash_cheese: 0, confidence: 0.95 },
    { sku: 'box10', sod: 55, eod: 34, cheese: 0, gcash: 14, gcash_cheese: 0, confidence: 0.95 },
    { sku: 'nori',  sod: 10, eod: 8,  cheese: 0, gcash: 0,  gcash_cheese: 0, confidence: 0.95 }
  ],
  custom_amount: 0, custom_gcash: 0, total_on_paper: 2365, notes: '', unread: []
};
const PAPER_TOTAL = 2365, PAPER_GCASH = 1470, PAPER_CASH = 895, PAPER_EXCL = 50;

/** ONE photograph through the REAL Vision.gs: a canned model reply in, the
 *  reading the phone will consume out. */
function visionRead(said, over) {
  const ctx = loadVisionSeam();
  ctx.UrlFetchApp._reply(200, geminiSaid(said));
  const r = vpost(ctx, { token: SEAM_TOK, action: 'readSheet', payload: Object.assign({
    date: DAY, mimeType: 'image/jpeg', imageBase64: SEAM_IMG, skus: PAPER_SKUS }, over || {}) });
  assert.strictEqual(r.ok, true, 'readSheet failed: ' + r.error);
  return { ctx, reading: r.data };
}
const RD = visionRead(PAPER_READ);

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
  // PIN MOVED (v2.7.0, deliberate): setupSheet backfills the owner's reorder
  // point for flour (5), so 2 on hand is at-or-below it and the warning fires.
  assert.strictEqual(flour.reorder_at, 5, 'the backfilled threshold ships with the row');
  assert.strictEqual(flour.low, true, '2 on hand at a threshold of 5 must warn');
  // A blank THRESHOLD has to survive the seam for the same reason a blank
  // baseline date does: 0 is a real threshold, and the Maintenance screen hands
  // back whatever it was given — so a coerced 0 is written into the sheet on the
  // first save and the owner's untouched cells stop being blank. Aonori is not
  // on the backfill list, so its cell is still the seeded blank.
  const aonori = F.boot.stockItems.find(r => r.product === 'Aonori');
  assert.strictEqual(aonori.reorder_at, '', 'a blank reorder point must arrive blank');
  assert.strictEqual(aonori.low, false, 'a blank threshold warns about nothing');
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
  // phone's own arithmetic. This is the owner's own worked example — through
  // "Stock came in" (v2.6.0), with no money anywhere in it.
  const app = loadClient();
  app.applyLocalStockDelivery({ date: '2026-08-01', product: 'Takoyaki Sauce', qty: 2,
    entryId: 'demo-deliv' });
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

test('a delivery is quantity only; a legacy expense-attached row keeps counting (v2.6.0)', () => {
  // The NEW door: the delivery ships as its own row, no money anywhere on it.
  assert.deepStrictEqual(
    F.boot.stockDeliveries.map(r => [r.date, r.product, r.qty, r.entry_id]),
    [[DELIVERY_PAYLOAD.date, 'Takoyaki Flour', 4, DELIVERY_PAYLOAD.entryId]]);
  assert.strictEqual(F.delivery.on_hand, 2, 'the reply carries the recomputed shelf figure (4 in − 2 opened)');
  // The PAYMENT is an ordinary expense with blank stock cells.
  const pay = F.boot.expenses.find(e => e.entry_id === PAYMENT_PAYLOAD.entryId);
  assert.strictEqual(pay.amount, PAYMENT_PAYLOAD.amount);
  assert.strictEqual(pay.stock_product, '', 'money leaving is not goods arriving');
  assert.strictEqual(pay.stock_qty, 0);
  // The LEGACY door: a pre-v2.6.0 row still carries its quantity AND its money,
  // and both still count — history is never restated.
  const legacy = F.boot.expenses.find(e => e.entry_id === LEGACY_DELIVERY_ROW.entry_id);
  assert.strictEqual(legacy.stock_product, 'Japanese Mayo');
  assert.strictEqual(legacy.stock_qty, 2);
  assert.strictEqual(legacy.amount, 350, 'the legacy money is on the same row, counted once');
  assert.strictEqual(F.boot.stockItems.find(x => x.product === 'Japanese Mayo').on_hand, 2,
    'a quantity already in the sheet keeps counting into on-hand forever');
  // An ordinary expense carries the keys, blank — never undefined, which the
  // phone would render as "undefined" or drop on the floor.
  const plain = F.boot.expenses.find(e => e.entry_id === BACKLOG_PAYLOAD.entryId);
  assert.strictEqual(plain.stock_product, '');
  assert.strictEqual(plain.stock_qty, 0);
  // The client normalizers keep every row usable.
  const app = syncedClient(F.boot);
  assert.strictEqual(app.state.expenses[PAYMENT_PAYLOAD.entryId].amount, PAYMENT_PAYLOAD.amount);
  assert.strictEqual(app.state.expenses[PAYMENT_PAYLOAD.entryId].category, 'Supplies');
  assert.deepStrictEqual((app.state.stockDeliveries[DELIVERY_PAYLOAD.date] || []).map(r => [r.product, r.qty]),
    [['Takoyaki Flour', 4]], 'the delivery must survive the seam into the phone mirror');
});

test('"Stock came in" lists every product with a stepper — nothing to choose (v2.7.2, source pins)', () => {
  // The form is DOM-bound, so its shape is pinned at source. The owner:
  // "dont let me choose, just present all the stocks with + button".
  const slab2 = slab('function stockOnHandHTML(){', 'function stockExplain(s){');
  // PIN MOVED (v2.7.4, deliberate): the rows are a SNAPSHOT carrying product
  // names now — the gate's STOCKIN-1 proved live-list index resolution could
  // book a quantity typed on one product against another.
  assert.ok(/asArr\(arrival\.rows\)\.forEach\(\(s, i\) =>/.test(slab2), 'one row per snapshotted product');
  assert.ok(/data-arrstep="' \+ i \+ '"/.test(slab2), 'steppers addressed by row index within the snapshot');
  assert.ok(!/arrProduct/.test(slab2), 'the product dropdown is gone');
  const save = slab('function saveArrival(){', 'let maintOpen = false;');
  assert.ok(/for \(const s of asArr\(arrival\.rows\)\)/.test(save),
    'the save iterates the SNAPSHOT rows, never the live list');
  assert.ok(/const payload = { date, product: r\.product, qty: r\.qty, entryId: uuid\(\) };/.test(save),
    'each product is its OWN saveStockDelivery with its OWN entryId — one shared id would make ' +
    'the local upsert keep only the last product of a multi-product delivery');
  assert.ok(/if \(!bad && !rows\.length\) bad = /.test(save), 'an all-zero save is refused, not silently empty');
  assert.ok(/count whole units \(1, 2, 3\)/.test(save), 'fractions refused naming the product, in the usual words');
});

test('"Check the sheet" is a pure read that speaks in escaped sentences (v2.7.5)', () => {
  // The fixture's sheet is HEALTHY (its one legacy delivery row names a real
  // product): the checker must invent nothing.
  assert.deepStrictEqual(F.sheetCheck.findings, [], 'a clean sheet stays silent');
  assert.ok(F.sheetCheck.checked_rows > 0);
  // The button and its renderer are DOM-bound: source pins.
  assert.ok(/data-act="sheet-check"/.test(HTML), 'the button exists');
  assert.ok(HTML.indexOf("(config.apiUrl") < HTML.indexOf('data-act="sheet-check"'),
    'and only when an API is configured — demo mode has no sheet to check');
  const run = slab('async function runSheetCheck(btn){', 'let maintPrices = null;');
  assert.ok(/await api\('sheetCheck', {}\)/.test(run), 'it asks the server, never guesses locally');
  assert.ok(/esc\(txt\(f\)\)/.test(run), 'every finding is escaped exactly once — findings carry sheet data');
  assert.ok(/Nothing looks wrong\./.test(run), 'a clean sheet is SAID, not left blank');
});

test('the Cutoff screen names the days with nothing in them (v2.7.6)', () => {
  // The silence this closes, from the owner's real sheet: Aug 7-15 had no entry
  // at all, so a fortnight of missing work read as a lean fortnight and the
  // preview said "Short". Everything below is measured against the CLIENT's own
  // today — the first cut of this test hardcoded dates and broke when the clock
  // rolled past midnight mid-session, which is exactly the bug class it guards.
  const app = loadClient();
  const T = app.todayStr();
  const day = (d, closed) => app.applyLocalDay({ date: d, closed: !!closed, staff: 'Mama',
    customAmount: closed ? 0 : 500, customGcash: 0, notes: '', counts: [], stock: [],
    entryId: 'md-' + d });
  const per = { start: app.addDays(T, -3), end: app.addDays(T, 5) };
  day(app.addDays(T, -3));
  day(app.addDays(T, -2), true);                  // dark on purpose: that IS an answer
  assert.deepStrictEqual(app.missingDaysInPeriod(per), [app.addDays(T, -1), T],
    'only the days with nothing at all, and never past today');
  // PIN ADDED (v2.9.2): the RULE stays the same — today is still a day with
  // nothing in it — but the card no longer calls tonight a missing night. The
  // warning counts up to yesterday; tonight gets its own quieter line, with
  // both buttons, because on the last night of a cutoff "Was closed" is the tap
  // that matters. Saying "1 day has nothing entered" about tonight every single
  // evening is how the card stops being read on the evening one really is.
  const card = HTML;
  assert.match(card, /const blanks = allBlanks\.filter\(d => d < today\);/,
    'the warning covers up to yesterday');
  assert.match(card, /Tonight is not entered yet/, 'and tonight is said separately');
  assert.ok(card.indexOf('days have nothing entered') < card.indexOf('Tonight is not entered yet'),
    'the real gaps come first');
  assert.match(card, /const tonight = allBlanks\.indexOf\(today\) !== -1/,
    'tonight is still FOUND — it is only said differently');

  // A period this phone cannot fully see says NOTHING rather than inventing
  // gaps out of history it does not hold.
  app.cfg.apiUrl = 'https://api.example/exec';
  app.state.window_start = app.addDays(T, -1);
  assert.deepStrictEqual(app.missingDaysInPeriod(per), [],
    'no guessing outside the snapshot window');
  app.state.window_start = app.addDays(T, -30);
  assert.strictEqual(app.missingDaysInPeriod(per).length, 2, 'and it speaks again once it can see');

  // Month, year and leap rolls, since the walk is date arithmetic.
  assert.strictEqual(app.addDays('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(app.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(app.addDays('2024-02-28', 1), '2024-02-29');

  // Source pins for the DOM-bound half: the card, both actions, the
  // no-purchases line — and the rule that none of it blocks the note.
  assert.match(HTML, /const allBlanks = missingDaysInPeriod\(per\);/);
  assert.match(HTML, /data-act="cut-open-day"/);
  assert.match(HTML, /data-act="cut-closed-day"/);
  // PIN MOVED (v2.9.2, deliberate): the warning names ONLY the two purchase
  // categories now. Gating it on Mama and the electric bill too meant one tap
  // on the "+ Mama ₱500" chip THIS SCREEN OFFERS silenced a warning about
  // supplies and octopus while both were still zero.
  assert.match(HTML, /No supplies and no octopus are logged in this cutoff yet\./);
  assert.match(HTML, /if \(!num\(f\.supplies\) && !num\(f\.octopus\)\)\{/,
    'and it is gated on those two alone');
  const gen = slab('async function generateNote(){', 'function copyNote(){');
  assert.ok(!/missingDaysInPeriod/.test(gen),
    'an unlogged day may be deliberate — it is said, never used to refuse the note');
});

test('the Cutoff screen counts the period\'s stock for you (v2.7.4)', () => {
  // The owner's paper "Last Cutoff supplies count", computed. Demo client:
  // every row below is the phone's own arithmetic.
  const app = loadClient();
  const per = { start: '2026-07-16', end: '2026-07-31' };
  app.applyLocalStockDelivery({ date: '2026-07-20', product: 'Takoyaki Flour', qty: 10, entryId: 'sc-d1' });
  app.applyLocalDay({ date: '2026-07-21', closed: false, staff: 'Mama', customAmount: 0,
    customGcash: 0, notes: '', counts: [],
    stock: [{ product: 'Takoyaki Flour', qty: 3 }], entryId: 'sc-day' });
  app.applyLocalStockCount({ date: '2026-07-31', product: 'Takoyaki Flour', qty: 9, entryId: 'sc-c1' });
  // The NEXT cutoff's delivery must not leak in.
  app.applyLocalStockDelivery({ date: '2026-08-01', product: 'Takoyaki Flour', qty: 99, entryId: 'sc-d2' });
  const html = app.stockCutoffHTML(per);
  assert.match(html, /Stock this cutoff/);
  assert.match(html, /10 packs came in/);
  assert.match(html, /3 packs opened/);
  assert.match(html, /counted 9 packs/);
  assert.ok(!/99/.test(html), "the next cutoff's delivery stays out");
  assert.ok(!/Togarashi/.test(html), 'a product with no movement is left out, not zero-padded');
  // A period this phone cannot fully see shows NOTHING, not partial sums.
  app.cfg.apiUrl = 'https://api.example/exec';
  app.state.window_start = '2026-07-20';
  assert.strictEqual(app.stockCutoffHTML(per), '',
    'a period older than the snapshot window must not dress partial sums as truth');
  // Source pin: the Cutoff screen actually renders it.
  assert.match(HTML, /h \+= stockCutoffHTML\(per\);/);
});

test('the delivery mirror survives an app restart (state_v1 round trip) (v2.6.0)', () => {
  // Closing and reopening the app rebuilds the whole mirror through
  // sanitizeState. A collection dropped there under-reads on-hand on every
  // app start until the next sync — with no error anywhere.
  const app = syncedClient(F.boot);
  app.applyLocalStockDelivery({ date: '2026-07-23', product: 'Takoyaki Sauce', qty: 2,
    entryId: 'restart-dlv' });
  const restored = app.sanitizeState(JSON.parse(JSON.stringify(app.state)));
  assert.deepStrictEqual((restored.stockDeliveries[DELIVERY_PAYLOAD.date] || []).map(r => [r.product, r.qty]),
    [['Takoyaki Flour', 4]], 'the synced delivery must survive the restart');
  assert.deepStrictEqual((restored.stockDeliveries['2026-07-23'] || []).map(r => [r.product, r.qty, r.entry_id]),
    [['Takoyaki Sauce', 2, 'restart-dlv']], 'a still-queued delivery must survive the restart too');
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
const SHARED_FIGURES = ['total', 'cash', 'gcash', 'mama', 'supplies', 'octopus', 'other',
  'electric', 'salary', 'split', 'remaining'];
/* Figures the two sides spell DIFFERENTLY (requests camelCase, responses
   snake_case — the asymmetry pinned throughout). Compared by pair, because a
   seam that only checks same-spelled keys quietly skips exactly the ones added
   most recently. `remaining` was never in the seam until v2.22.0 — the note
   comparison covered it only as formatted text, which fmt() can round into
   agreement when the raw figures are a centavo apart. */
const SHARED_FIGURES_MAPPED = [
  ['supplies_used', 'suppliesUsed'],
  ['supplies_minor', 'suppliesMinor'],
  ['backlog_in_minor', 'backlogInMinor'],
  ['per_partner', 'perPartner']
];

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
/** A note with the supplies-used line taken out — everything his partner does
 *  arithmetic on. From v2.15.1 that line sits INSIDE the category block (his
 *  instruction), so it can no longer be split off by position; it is removed by
 *  name instead, which keeps "the sums cannot move" checkable in one place. */
/** The note minus the ONLY two lines a unit cost may move (v2.22.0): the
 *  supplies-used line and the residual. Everything else must be byte-identical
 *  whatever the costs are, and that is what this compares. */
function noteFixed(text) {
  return String(text).split('\n')
    .filter(l => l.indexOf('Supplies used (opened') !== 0 && !/^(Remaining|Short) - /.test(l))
    .join('\n');
}

function noteSums(text) {
  return String(text).split('\n').filter(l => l.indexOf('Supplies used (opened)') !== 0).join('\n');
}

function assertCutoffSeam(app, per, served) {
  const local = app.computeCutoff(per);
  const f = served.figures;
  SHARED_FIGURES.forEach(k => {
    assert.strictEqual(local[k], f[k],
      'the phone and the note disagree about "' + k + '": ' + local[k] + ' vs ' + f[k]);
  });
  SHARED_FIGURES_MAPPED.forEach(([snake, camel]) => {
    assert.strictEqual(local[camel], f[snake],
      'the phone and the note disagree about "' + snake + '": ' + local[camel] + ' vs ' + f[snake]);
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
    'bootstrap.stockDeliveries[]': F.boot.stockDeliveries,
    'bootstrap.cutoffInputs[]':  F.boot.cutoffInputs,
    'saveDay':              F.saveDay,
    'saveDay.lines[]':      F.saveDay.lines,
    'saveExpense':          F.saveExpense,
    'saveStockCount':       F.stockCount,
    'saveStockDelivery':    F.delivery,
    'sheetCheck':           F.sheetCheck,
    'saveCutoffSplit':      F.split,
    'cutoff':               F.cutoff,
    'cutoff.figures':       F.cutoff.figures,
    'bootstrap.lastCutoff': F.boot.lastCutoff,
    'costing':              F.costing,
    'costing.variable':     F.costing.variable,
    'costing.fixed':        F.costing.fixed,
    'costing.per_sku[]':    F.costing.per_sku,
    'costing.targets[]':    F.costing.targets,
    // The reading off the REAL Vision.gs (built in section 21, below).
    'readSheet':           RD.reading,
    'readSheet.counts[]':  RD.reading.counts
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
  // PIN MOVED (v2.5.1, deliberate): each count row now ALSO carries the
  // price/cheesePrice/inCutoff the screen displayed (camelCase, request side),
  // so a save that sits queued through a Maintenance change still lands at the
  // money — and the classification — the receipt and the tin showed.
  assert.deepStrictEqual(payload.counts.find(c => c.sku === 'box4'),
    { sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 2, gcashCheeseQty: 1,
      // Given away or ruined (v2.10.1) — always present, like sod and eod, so
      // the server never has to guess whether the phone knows about the field.
      freeQty: 0,
      price: 50, cheesePrice: 60, inCutoff: true },
    'the re-emitted REQUEST must stay camelCase and carry all three buckets plus the displayed snapshot');
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
  // about applyServerDay. Give the phone a STALE price mirror — a legacy phone
  // whose stored rows carry NO price snapshot (pre-v2.5.0), after the owner
  // edited the Prices tab — so the local numbers are provably wrong and only
  // the server can fix them. (Blanking the snapshots is load-bearing since
  // v2.5.0: WITH them, a re-save of this date deliberately keeps the date's own
  // prices and the live 999 could never leak in — which is finding the price
  // snapshot exists to fix.)
  const app = loadClient();
  app.applyBootstrap(BK.boot);
  (app.state.counts[B_DAY] || []).forEach(r => { r.price = ''; r.cheese_price = ''; });
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
  // Index -1 net: v2.15.1 added a line above, v2.20.0 removed two.
  assert.strictEqual(lines[14], 'Short - 2,900');
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
  // v2.20.0, owner-directed: ONE line for everything entered on the Expenses
  // screen — Supplies 5,440 + Octopus 0 + Other 1,417 = 6,857. The Octopus and
  // "Other payments" lines are GONE: printing them as well would show the same
  // money twice and stop the block adding up.
  'Supplies (minor) - 6,857',
  // v2.15.1, owner-directed: beside the Supplies line it belongs with, and it
  // ALWAYS prints — blank when there is nothing, exactly as a zero category.
  // It is in no sum; the identity is asserted with it present.
  'Supplies used (opened) - ',
  'Salary - 3,000',
  'Electric bill - 500',
  '',
  'Short - 2,000'
].join('\n');

/* The same note when the period's stock usage CAN be priced (v2.15.0,
   owner-directed). The value of what was OPENED prints BESIDE the Supplies
   line it belongs with — his instruction, 2026-09-01: "I just want to see it in
   the supplies section in the cutoff notes, ill handle the deduction for now" —
   and is in no sum — the seven lines above still add with the residual to Total, which
   is the identity his partner checks and which is asserted separately. Derived
   from SPEC_NOTE rather than retyped, so the two can never drift. */
/* THE SPEC NOTE WHEN THE PERIOD'S USAGE CAN BE PRICED. Since v2.22.0 the opened
   value is an ALLOCATION, so it shows in two places: on its own line, and in a
   residual that is lower by exactly that much. Derived from SPEC_NOTE rather
   than written out, so the sample and this can never drift. */
const SPEC_NOTE_USED = SPEC_NOTE
  .replace('Supplies used (opened) - ', 'Supplies used (opened) - 2,940')
  .replace('Short - 2,000', 'Short - 4,940');

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
  // v2.22.0: the fixture's opened stock is DEDUCTED now, so the residual is
  // lower than the -2,000 it read for four releases. What this test exists to
  // prove is unchanged: the drop came from the opened stock, not from the
  // Supplies line, which is still 5,440 exactly.
  assert.strictEqual(f.supplies_used, 2940, 'the fixture prices its opened stock');
  assert.strictEqual(f.remaining, -2000 - 2940, 'the residual, negative and shown');
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies_minor + f.supplies_used + f.salary +
    f.electric + f.remaining,
    'the accounting identity must still hold');
  // ...and the seven parts plus the opened value do too — proof this is one
  // extra allocation, not a re-derivation of the others.
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric +
    f.supplies_used + f.remaining);
});

test('the SERVER note is character-identical to the SPEC sample', () => {
  // v2.22.0: the opened value is an allocation, so it moves the residual too.
  // SPEC_NOTE_USED carries the value; the residual it implies is 2,940 lower.
  assert.strictEqual(SP.cutoff.note_text, SPEC_NOTE_USED);
  assert.strictEqual(noteFixed(SP.cutoff.note_text), noteFixed(SPEC_NOTE),
    'every line but the opened value and the residual is the note it always was');
  // Spelled out, so a future edit cannot "tidy" one of these away unnoticed.
  const lines = SP.cutoff.note_text.split('\n');
  assert.strictEqual(lines.length, 15,
    'v2.20.0: Octopus and Other payments folded into Supplies (minor), so two fewer');
  assert.deepStrictEqual([lines[1], lines[3], lines[6], lines[13]], ['', '', '', ''],
    'blank-line placement, including the one before the residual');
  assert.strictEqual(lines[8], 'Split - 3,000(1,500 each)', 'no space before the bracket');
  assert.strictEqual(lines[9], 'Supplies (minor) - 6,857',
    'EVERYTHING paid on the Expenses screen: 5,440 + 0 octopus + 1,417 other');
  // Directly beneath the Supplies line it belongs with — the owner's placement.
  assert.strictEqual(lines[10], 'Supplies used (opened) - 2,940', 'the value OPENED');
  assert.strictEqual(lines[11], 'Salary - 3,000');
  assert.strictEqual(lines[12], 'Electric bill - 500');
  assert.strictEqual(lines[14], 'Short - 4,940',
    'the label carries the sign, never "- -4,940" — and it is 2,940 lower than ' +
    'it was before v2.22.0 deducted the opened stock');
  assert.ok(!/^Octopus - /m.test(SP.cutoff.note_text), 'the folded lines are GONE, not blank');
  assert.ok(!/^Other payments - /m.test(SP.cutoff.note_text));
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
  assert.strictEqual(app.pick(SP.cutoff, 'note_text', 'noteText'), SPEC_NOTE_USED,
    'the phone shows the SERVER note verbatim, footer and all');
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
  // The footer rides along now (the period's usage is priceable), and the point
  // of this assertion is unchanged: REPLAYING a day must not move the note. It
  // is compared whole, footer included, because a replay must not move that
  // either — the same usage rewritten is the same value.
  assert.strictEqual(cut.data.note_text, SPEC_NOTE_USED, 'a replay must not move the note');
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

test('stock QUANTITIES never reach the cutoff figures — only their COST does', () => {
  /* v2.22.0 renamed and re-pointed this. It began as "stock never reaches the
     cutoff figures or the note" and that is no longer true: the COST of what was
     opened is an allocation now, at the owner's instruction. What was always the
     real danger, and still is, is a stock QUANTITY leaking into a money figure —
     5 packs turning up as ₱5 somewhere, or Supplies swelling by a delivery. That
     is what this pins. */
  const f = SP.cutoff.figures;
  const stockUnits = SP.range.stockUsage.reduce((s, r) => s + r.qty, 0);
  assert.strictEqual(stockUnits, 5, 'the fixture must actually carry stock rows');
  assert.strictEqual(f.total, 11857, 'quantities are not sales');
  assert.strictEqual(f.supplies, 5440, 'stock quantities were added to Supplies');
  assert.strictEqual(f.salary, 3000);
  // The residual carries the COST of those 5 units, never the count of them.
  assert.strictEqual(f.supplies_used, 2940, 'their cost, not their number');
  assert.strictEqual(f.remaining, -2000 - 2940);
  assert.notStrictEqual(f.remaining, -2000 - stockUnits,
    'a quantity must never be spent as if it were pesos');
  assert.ok(!has(f, 'stock') && !has(f, 'stock_total'), 'the note figures gained a stock line');

  // Client: pile absurd usage onto the local mirror; nothing may move.
  const app = specClient();
  const before = app.computeCutoff(SPEC_PERIOD);
  const note = app.buildNote(before, SPEC_PERIOD);
  app.state.stockUsage['2025-07-03'] = [
    { date: '2025-07-03', product: 'Takoyaki Flour', qty: 99999, entry_id: 'x', updated_at: '' }
  ];
  const after = app.computeCutoff(SPEC_PERIOD);
  // v2.14.0 adds DISPLAY-ONLY keys that stock usage is SUPPOSED to move — the
  // owner asked to see the value of what was opened on the Cutoff tab. So the
  // comparison now names the figures that must never move: every allocation,
  // every total, and the residual. The display keys are asserted separately,
  // and the note is still compared byte for byte below, which is the line that
  // actually protects what his partner receives.
  // `remaining` LEFT this list in v2.22.0 — usage is an allocation now, and the
  // assertion below pins the exact amount it may move it by, which is stricter
  // than simply forbidding it. Everything else here still may not budge.
  const MONEY = ['total', 'cash', 'gcash', 'mama', 'supplies', 'suppliesMinor',
    'octopus', 'electric', 'other', 'salary', 'split', 'perPartner', 'excluded',
    'daysWithSales', 'openDays', 'tinOut', 'tinUnknown', 'tinExpected'];
  for (const k of MONEY){
    assert.deepStrictEqual(after[k], before[k], 'stock usage moved ' + k);
  }
  assert.strictEqual(app.r2(before.remaining - after.remaining),
    app.r2(after.suppliesUsed - before.suppliesUsed),
    'the residual moved by exactly the change in the value opened, to the centavo — ' +
    '99,999 packs at 120 is a monstrous figure, and it is the RIGHT monstrous figure');
  assert.ok(!has(after, 'stock') && !has(after, 'stock_total'),
    'and it still adds no stock line to the figures the note is built from');
  // The display keys DO move, which is the point of them.
  assert.ok(after.suppliesUsed > before.suppliesUsed,
    'the supplies-used figure is exactly what should follow the usage');
  /* v2.15.0, owner-directed: the note now carries that figure as a FOOTER, so
     it is no longer byte-identical — and it should not be. What still cannot
     move is the part his partner does arithmetic on: every allocation above,
     and the note down to and including the residual. */
  assert.strictEqual(noteFixed(app.buildNote(after, SPEC_PERIOD)), noteFixed(note),
    'every line but the opened value and the residual is byte-identical');
  assert.match(app.buildNote(after, SPEC_PERIOD), /Supplies used \(opened\) - [0-9]/,
    'the supplies-used line carries it');
  // ...and the SERVER note the phone actually shows is unchanged too.
  const again = post(SP.ctx, { token: SP.token, action: 'cutoff',
    payload: { start: SPEC_PERIOD.start, end: SPEC_PERIOD.end, dryRun: true } });
  assert.strictEqual(again.data.note_text, SPEC_NOTE_USED);
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
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price', 'custom_qty', 'free_qty']),
    'the new DailyCounts columns must be APPENDED, in schema order');
  const log = ss.getSheetByName('DailyLog').getDataRange().getValues();
  assert.deepStrictEqual(log[0],
    OLD_LOG_HEADERS.concat(['custom_gcash', 'salary', 'excluded_total', 'gcash_converted', 'lid_boxes', 'photo_url']));
  assert.deepStrictEqual(counts[1].slice(9), ['', '', '', '', '', '', '', ''],
    'the appended cells start blank on a historical row: "that day was all cash", ' +
    'an in_cutoff with no snapshot (which reads TRUE — the money was inside the ' +
    'totals when saved), prices that fall back to the current Prices tab, and a ' +
    'custom_qty and a free_qty that read 0 — nothing was drawn from, or given away on, a pre-column row');
  // PIN MOVED (v2.5.0, deliberate): the migration BACKFILLS the salary cell of
  // every non-closed historical row with the CURRENT daily_salary — resolving
  // it at read time meant a later rate change silently re-priced history.
  // gcash_converted / lid_boxes (v2.7.0) stay blank: nothing was converted and
  // no lids were counted on a day saved before the columns existed.
  // PIN MOVED (v2.9.0, deliberate): photo_url is appended after lid_boxes and
  // stays blank on every historical row — those nights were typed in by hand.
  assert.deepStrictEqual(log[1].slice(10), ['', 200, '', '', '', ''],
    'salary backfilled at the current rate; the other appended cells stay blank');
  assert.deepStrictEqual(log[2].slice(10), ['', 200, '', '', '', ''],
    'every non-closed historical row gets the backfill');
  // The one appended column whose BLANK means TRUE. Asserted here, at the
  // migration itself, because this is the moment every live price row gets one.
  const priceRows = ss.getSheetByName('Prices').getDataRange().getValues();
  // PIN MOVED (v2.8.0, deliberate): box_cost is appended after in_cutoff, and
  // the two appended columns behave OPPOSITELY on purpose — in_cutoff stays
  // BLANK (a blank reads TRUE, so the money stays in the cutoff), while
  // box_cost is BACKFILLED with the owner's own container costs (a blank would
  // mean "no cost known" and drop his boxes out of the costing total). Both
  // halves are pinned here, at the migration, because this is the moment every
  // live price row gets both cells.
  assert.deepStrictEqual(priceRows[0], ['sku', 'label', 'group', 'size', 'price',
    'cheese_price', 'active', 'in_cutoff', 'box_cost']);
  assert.deepStrictEqual(priceRows.slice(1, 4).map(r => r[7]), ['', '', ''],
    'box4/box6/box10 keep a BLANK in_cutoff — and a blank must read TRUE');
  assert.deepStrictEqual(priceRows.slice(1, 4).map(r => [r[0], r[8]]),
    [['box4', 0.375], ['box6', 3], ['box10', 4.6]],
    'box_cost is backfilled onto the live rows — his bundle price per container');
  assert.deepStrictEqual(ss.getSheetByName('Expenses').getDataRange().getValues()[0].slice(8),
    ['stock_product', 'stock_qty', 'paid_from']);

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
  assert.ok(counts.getMaxColumns() >= 16, 'the grid was not widened');
  assert.deepStrictEqual(counts.getDataRange().getValues()[0],
    OLD_COUNT_HEADERS.concat(['gcash_qty', 'gcash_cheese_qty', 'gcash_amount', 'in_cutoff', 'price', 'cheese_price', 'custom_qty', 'free_qty']));
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
  // The new columns were written in their REAL positions (10-16), not guessed.
  assert.deepStrictEqual(counts.slice(1).find(x => x[0] === '2026-07-28' && x[1] === 'box4'),
    ['2026-07-28', 'box4', 10, 0, 10, 2, 5, 530, 'post-migration-1', 2, 1, 160, true, 50, 60, 0, 0]);

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
  assertPairs('bootstrap.stockDeliveries[]', F.boot.stockDeliveries, pairs['bootstrap.stockDeliveries[]']);
  assertPairs('saveStockDelivery', F.delivery, pairs['saveStockDelivery']);
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
  assertNoCamelKeys('saveStockDelivery', F.delivery);
  assertNoCamelKeys('payment saveExpense', F.payment);
  assertNoCamelKeys('saveStockCount', F.stockCount);
  assertNoCamelKeys('saveCutoffSplit', F.split);
  assertNoCamelKeys('cutoff', F.cutoff);
  assertNoCamelKeys('spec cutoff', SP.cutoff);
  assertNoCamelKeys('costing', F.costing);
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

test('a delivery deleted in the sheet disappears from the phone (v2.6.0)', () => {
  const app = syncedClient(F.boot);
  const d = DELIVERY_PAYLOAD.date;
  assert.ok((app.state.stockDeliveries[d] || []).length, 'precondition: the phone holds the delivery');
  assert.ok(d >= F.boot.window_start, 'precondition: inside the window');
  app.applyBootstrap(Object.assign({}, F.boot, { stockDeliveries: [] }));
  assert.ok(!app.state.stockDeliveries[d],
    'a delivery removed in the sheet must leave the phone — and the shelf figure with it');
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

test('M1: a QUEUED delivery survives a bootstrap that lands before it drains (v2.6.0)', () => {
  // Mama logs an arrival with no signal; a sync completes before the queue
  // drains. The snapshot covers the date, so without a replay the delivery —
  // and its shelf figure — would vanish until the sheet answered.
  const app = syncedClient(F.boot);
  const before = app.stockStatusList().find(s => s.product === 'Takoyaki Sauce').on_hand;
  const dlv = { date: '2026-07-27', product: 'Takoyaki Sauce', qty: 3, entryId: 'q-dlv-1' };
  app.applyLocalStockDelivery(dlv);
  app.queue.push({ action: 'saveStockDelivery', payload: dlv, tries: 0 });
  app.applyBootstrap(F.boot);
  const rows = (app.state.stockDeliveries[dlv.date] || []).filter(r => r.entry_id === 'q-dlv-1');
  assert.strictEqual(rows.length, 1, 'the queued delivery was wiped by the snapshot');
  assert.strictEqual(rows[0].qty, 3);
  assert.strictEqual(app.stockStatusList().find(s => s.product === 'Takoyaki Sauce').on_hand,
    before + 3, 'the shelf must keep showing the queued arrival');
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

// ===========================================================================
// 15. v2.4.0 — an EXCLUDED sku across the seam.
//
// nori is sold and counted like anything else, and its money must be invisible
// to every cutoff figure and to the note the owner sends his partner. The note
// is the artefact that matters here, so it is asserted BYTE FOR BYTE on both
// sides of the seam with nori sales present.
//
// The phone's own arithmetic is part of this test on purpose: computeCutoff sums
// the DAY ROWS the server stored, so an excluded sku is already absent from the
// phone's figures without the phone knowing the flag exists — which is what
// makes shipping this backend before the screens safe rather than merely
// tolerable.
// ===========================================================================
console.log('\n--- 15. Excluded skus (in_cutoff) across the seam ---');

const N_DAY_A = '2026-07-26';
const N_DAY_B = '2026-07-27';
const N_EXPENSE = { date: N_DAY_A, category: 'Supplies', item: 'harina', amount: 300, backlogRef: '', notes: '', entryId: 'nori-exp-1' };
// box4: 10 sold, 2 of them by GCash -> 500, of which 100 GCash.  nori 12 -> 300.
// box6:  4 sold, all cash            -> 260.                     nori  4 -> 100.
const N_EXPECT = { total: 760, gcash: 100, cash: 660, excluded: 400, salary: 400 };

function noriDay(date, sku, sod, gcashQty, noriSod, entryId) {
  const counts = [{ sku: sku, sod: sod, eod: 0, cheeseQty: 0, gcashQty: gcashQty, gcashCheeseQty: 0 }];
  if (noriSod > 0) counts.push({ sku: 'nori', sod: noriSod, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 });
  return { date: date, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '', counts: counts, entryId: entryId };
}

/** The same fortnight twice: with nori sold, and with none sold at all. */
function noriFixture(withNori) {
  const { ctx, ss, token } = loadServer();
  const dayA = post(ctx, { token, action: 'saveDay', payload: noriDay(N_DAY_A, 'box4', 10, 2, withNori ? 12 : 0, 'nori-day-a') });
  assert.strictEqual(dayA.ok, true, 'saveDay A failed: ' + dayA.error);
  const dayB = post(ctx, { token, action: 'saveDay', payload: noriDay(N_DAY_B, 'box6', 4, 0, withNori ? 4 : 0, 'nori-day-b') });
  assert.strictEqual(dayB.ok, true, 'saveDay B failed: ' + dayB.error);
  const exp = post(ctx, { token, action: 'saveExpense', payload: N_EXPENSE });
  assert.strictEqual(exp.ok, true, 'saveExpense failed: ' + exp.error);
  const cutoff = post(ctx, { token, action: 'cutoff', payload: { start: PERIOD.start, end: PERIOD.end, dryRun: false } });
  assert.strictEqual(cutoff.ok, true, 'cutoff failed: ' + cutoff.error);
  const boot = post(ctx, { token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, 'bootstrap failed: ' + boot.error);
  return { ctx, ss, token, dayA: dayA.data, dayB: dayB.data, cutoff: cutoff.data, boot: boot.data };
}
const NF = noriFixture(true);
const NF_NONE = noriFixture(false);

test('the excluded keys cross the seam in snake_case, or the money renders as 0', () => {
  assertPairs('bootstrap.prices[]', NF.boot.prices, CONTRACT['bootstrap.prices[]']);
  assertPairs('bootstrap.days[]', NF.boot.days, CONTRACT['bootstrap.days[]']);
  assertPairs('saveDay', NF.dayA, CONTRACT['saveDay']);
  assertPairs('saveDay.lines[]', NF.dayA.lines, CONTRACT['saveDay.lines[]']);
  assertPairs('cutoff.figures', NF.cutoff.figures, CONTRACT['cutoff.figures']);
  assertNoCamelKeys('saveDay(nori)', NF.dayA);
  assertNoCamelKeys('cutoff(nori)', NF.cutoff);
  assertNoCamelKeys('bootstrap(nori)', NF.boot);
  // The flag itself, on the row the phone stores.
  const flag = sku => NF.boot.prices.find(p => p.sku === sku).in_cutoff;
  assert.strictEqual(flag('box4'), true);
  assert.strictEqual(flag('nori'), false, 'the phone must be able to see which sku is excluded');
});

test("the day rows the phone receives keep nori's money BESIDE the day's, never in it", () => {
  const a = NF.boot.days.find(d => d.date === N_DAY_A);
  assert.strictEqual(a.total, 500, 'the boxes only');
  assert.strictEqual(a.gcash, 100);
  assert.strictEqual(a.cash, 400);
  assert.strictEqual(a.excluded_total, 300, 'nori, stored apart');
  assert.strictEqual(a.total, a.cash + a.gcash, 'Cash = Total - GCash still holds');
  // The count row still exists in full — nori IS counted, it just is not banked.
  const nori = (NF.boot.counts || []).find(c => c.date === N_DAY_A && c.sku === 'nori');
  assert.ok(nori, 'nori must still be counted like any other sku');
  assert.strictEqual(nori.sold, 12);
  assert.strictEqual(nori.amount, 300, 'with its own snapshotted money on the row');
  assert.strictEqual(nori.gcash_amount, 0);
  // ...and the save reply said the same thing, per line.
  assert.strictEqual(NF.dayA.excluded_total, 300);
  assert.strictEqual(NF.dayA.lines.find(l => l.sku === 'nori').in_cutoff, false);
  assert.strictEqual(NF.dayA.lines.find(l => l.sku === 'box4').in_cutoff, true);
});

test('the phone and the note agree with nori sold, and both notes are byte-identical', () => {
  const app = syncedClient(NF.boot);
  // The full cutoff seam: every figure the phone computes itself must equal the
  // server's, and (because the phone computes the residual) its own note must
  // match the server's byte for byte.
  const { local, f, note } = assertCutoffSeam(app, PERIOD, NF.cutoff);
  assert.strictEqual(f.total, N_EXPECT.total);
  assert.strictEqual(f.gcash, N_EXPECT.gcash);
  assert.strictEqual(f.cash, N_EXPECT.cash);
  assert.strictEqual(f.salary, N_EXPECT.salary);
  assert.strictEqual(local.total, f.total, 'nori is absent from the phone\'s figures too');
  // The excluded block is there to be SHOWN, and is in nothing else.
  assert.strictEqual(f.excluded, N_EXPECT.excluded);
  assert.deepStrictEqual(f.excluded_lines, [{ sku: 'nori', label: 'Nori', qty: 16, amount: 400 }]);
  assert.strictEqual(f.total, f.cash + f.gcash);
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining,
    'Total = Mama + Split + Supplies + Octopus + Salary + Other + Electric + Remaining');
  assert.ok(!/nori/i.test(note), 'the note must not name an excluded sku');

  // And the decisive comparison: the SAME fortnight with no nori sold at all
  // produces the same note, from both sides.
  const clean = syncedClient(NF_NONE.boot);
  assert.strictEqual(NF.cutoff.note_text, NF_NONE.cutoff.note_text,
    'the note the partner receives must be byte-identical with nori sales present');
  assert.strictEqual(app.buildNote(local, PERIOD), clean.buildNote(clean.computeCutoff(PERIOD), PERIOD),
    "and so must the phone's own offline copy of it");
  assert.strictEqual(NF_NONE.cutoff.figures.excluded, 0);
  assert.deepStrictEqual(NF_NONE.cutoff.figures.excluded_lines, []);
});

test('the phone computes the SAME split the server does: nori out of total, kept apart', () => {
  // v2.4.0 frontend: computeDay reads in_cutoff and mirrors apiSaveDay exactly, so
  // the receipt shows the figure the sheet will store instead of being corrected
  // afterwards. (Before the screens shipped, the phone counted nori and the save
  // reply put it right; now the two agree before anything is sent.)
  const app = syncedClient(NF.boot);
  const payload = noriDay(N_DAY_A, 'box4', 10, 2, 12, 'nori-day-a');
  const c = app.computeDay(payload);
  assert.strictEqual(c.total, 500, 'the boxes only — nori is not in the day total');
  assert.strictEqual(c.gcash, 100);
  assert.strictEqual(c.cash, 400);
  assert.strictEqual(c.excluded, 300, '12 nori at 25, kept apart');
  assert.strictEqual(c.total, c.cash + c.gcash, 'Cash = Total − GCash still holds');
  // Line by line, and the server's own reply for the same day agrees to the peso.
  assert.strictEqual(c.lines.find(l => l.sku === 'box4').in_cutoff, true);
  assert.strictEqual(c.lines.find(l => l.sku === 'nori').in_cutoff, false);
  assert.deepStrictEqual(c.excludedLines.map(l => [l.sku, l.sold, l.amount]), [['nori', 12, 300]]);
  assert.strictEqual(c.excluded, c.excludedLines.reduce((s, l) => s + l.amount, 0),
    'the excluded lines must add up to the excluded total, or the receipt lies');
  assert.strictEqual(c.total, NF.dayA.total, 'phone vs server total');
  assert.strictEqual(c.cash, NF.dayA.cash);
  assert.strictEqual(c.gcash, NF.dayA.gcash);
  assert.strictEqual(c.excluded, NF.dayA.excluded_total, 'phone vs server excluded_total');

  // The optimistic local write stores it the way the sheet does — beside the day's
  // money, never inside it — and the server reply lands on the same figures.
  app.applyLocalDay(payload);
  assert.strictEqual(app.state.days[N_DAY_A].total, 500);
  assert.strictEqual(app.state.days[N_DAY_A].excluded_total, 300);
  app.applyServerDay(payload, NF.dayA);
  assert.strictEqual(app.state.days[N_DAY_A].total, 500,
    'the server reply is authoritative and says the same thing');
  assert.strictEqual(app.state.days[N_DAY_A].gcash, 100);
  assert.strictEqual(app.state.days[N_DAY_A].cash, 400);
  assert.strictEqual(app.state.days[N_DAY_A].excluded_total, 300);
  // nori IS counted: its count row survives in full, with its own money on it.
  const row = (app.state.counts[N_DAY_A] || []).find(r => r.sku === 'nori');
  assert.strictEqual(row.sold, 12);
  assert.strictEqual(row.amount, 300);
  // ...and the period the phone previews is right.
  assert.strictEqual(app.computeCutoff(PERIOD).total, N_EXPECT.total);
});

// THE most dangerous line of this release. Every price row on the owner's live
// sheet gets an EMPTY in_cutoff cell at migration, and a state_v1 written by the
// old build has no key at all. If either read FALSE, every takoyaki sku would
// drop out of the cutoff and the note would collapse — with every figure still
// looking like a perfectly good number.
test('a BLANK in_cutoff reads TRUE on the phone too, and only an explicit false is out', () => {
  const app = loadClient();
  [undefined, null, '', '   ', 'TRUE', 'true', true, 1, 'yes', 'maybe', 'nori'].forEach(v => {
    assert.strictEqual(app.inCutoffFlag(v), true,
      JSON.stringify(v) + ' must count IN — losing money silently is the worse failure');
  });
  [false, 'FALSE', 'false', 'False', '0', 'no', 'n', 'off'].forEach(v => {
    assert.strictEqual(app.inCutoffFlag(v), false, JSON.stringify(v) + ' must be OUT');
  });
  // Through the normalizer, which is what every stored and every bootstrapped row
  // goes through.
  assert.strictEqual(app.normPrice({ sku:'box4', price:50 }).in_cutoff, true,
    'a row with NO in_cutoff key (the old build, or an unmigrated sheet) counts IN');
  assert.strictEqual(app.normPrice({ sku:'box4', price:50, in_cutoff:'' }).in_cutoff, true,
    'a BLANK cell counts IN — this is the migration case, on every existing row');
  assert.strictEqual(app.normPrice({ sku:'nori', price:25, in_cutoff:false }).in_cutoff, false);
  assert.strictEqual(app.normPrice({ sku:'nori', price:25, in_cutoff:'FALSE' }).in_cutoff, false,
    'the sheet writes booleans as FALSE text through the API too');
  // A legacy camelCase server must not lose the flag either.
  assert.strictEqual(app.normPrice({ sku:'nori', price:25, inCutoff:false }).in_cutoff, false);

  // A phone whose sheet has never heard of in_cutoff: every sku counts IN, so the
  // day, the preview and the note are exactly what they were before this release.
  const noFlag = { prices: NF.boot.prices.map(p => {
    const o = Object.assign({}, p); delete o.in_cutoff; return o;
  }) };
  const legacy = syncedClient(noFlag);
  legacy.state.prices.forEach(p => assert.strictEqual(p.in_cutoff, true, p.sku + ' fell out of the cutoff'));
  const payload = noriDay(N_DAY_A, 'box4', 10, 2, 12, 'nori-day-a');
  assert.strictEqual(legacy.computeDay(payload).total, 800,
    'with no flag anywhere, nori counts IN (500 + 300) — nothing is dropped');
  assert.strictEqual(legacy.computeDay(payload).excluded, 0);
});

test('the seeded phone knows nori, so demo mode and the first price save both work', () => {
  const app = loadClient();                        // never synced: these are the seeds
  const nori = app.state.prices.find(p => p.sku === 'nori');
  assert.ok(nori, 'demo mode must be able to sell nori on day one');
  assert.strictEqual(app.num(nori.price), 25);
  assert.strictEqual(nori.group, 'simple', 'start/end counts, one price, no cheese');
  assert.strictEqual(nori.in_cutoff, false);
  assert.strictEqual(app.skuInCutoff('nori'), false);
  assert.strictEqual(app.skuInCutoff('box4'), true);
  assert.strictEqual(app.skuInCutoff('who-knows'), true, 'an unknown sku counts IN');
  // A brand-new phone computes the excluded money for itself, with no server.
  app.applyLocalDay(noriDay('2026-07-26', 'box4', 10, 0, 3, 'demo-nori'));
  const day = app.state.days['2026-07-26'];
  assert.strictEqual(day.total, 500, 'Box 4 sold 10 at 50');
  assert.strictEqual(day.cash, 500, 'the nori money is NOT in Cash');
  assert.strictEqual(day.excluded_total, 75, '3 nori at 25');
});

test('an old bucket on an excluded sku is refused with a stepper to fix it, then saves (v2.5.0)', () => {
  // v2.5.0 pin move (was: "the phone never sends a GCash count on an excluded
  // sku, so the day always saves"). Silently zeroing the buckets in the payload
  // while validateBenta refused the RAW figures was the dead end of finding
  // i=0/i=27: the save was blocked over numbers that were neither sent nor
  // fixable, so the day could never be saved again. Now the payload sends the
  // buckets EXACTLY as the row holds them (what is shown is what is sent),
  // validateBenta judges those same values, and the card renders a stepper for
  // any non-zero one — so the figure is zeroed on purpose, never behind her back.
  const app = syncedClient(NF.boot);
  app.loadBentaForm(N_DAY_A);
  const nori = app.benta.rows.find(r => r.sku === 'nori');
  assert.ok(nori, 'nori must be on the Sales form like any other sku');
  assert.strictEqual(nori.sod, 12, 'and it reloads the counts that were saved');
  nori.gcash = 4;                                  // a draft from a hand-edited row
  nori.cheese = 2;                                 // and nori has no cheese version
  const payload = app.bentaPayload();
  const sent = payload.counts.find(c => c.sku === 'nori');
  assert.strictEqual(sent.gcashQty, 4, 'what is shown is what is sent — never a silent 0');
  assert.strictEqual(sent.cheeseQty, 2);
  assert.strictEqual(app.computeDay(payload).excluded, 300,
    'the receipt still prices the excluded money whole and unsplit');
  // validateBenta refuses the day BEFORE it can queue, over exactly the values
  // the payload carries — and the card now renders steppers for them.
  const errs = app.validateBenta();
  assert.ok(errs['sku:nori'], 'a non-zero bucket on an excluded sku must block the save');
  const render = slab('function renderBenta(){', 'const CHEV =');
  assert.ok(/oldBuckets/.test(render) && /num\(row\[b\.field\]\) !== 0/.test(render),
    'the card must render a stepper for any non-zero bucket the loaded row holds');
  // Zeroed deliberately (what the steppers are for), the day saves — editing
  // unrelated fields of such a day must never be blocked once the row is clean.
  nori.gcash = 0; nori.cheese = 0;
  assert.deepStrictEqual(Object.keys(app.validateBenta()), [], 'a clean row must save');
  const clean = app.bentaPayload();
  const sentClean = clean.counts.find(c => c.sku === 'nori');
  assert.deepStrictEqual([sentClean.cheeseQty, sentClean.gcashQty, sentClean.gcashCheeseQty], [0, 0, 0]);
  const box4 = clean.counts.find(c => c.sku === 'box4');
  assert.strictEqual(box4.gcashQty, 2, 'a normal sku still sends its real buckets');
  // The real server takes it.
  const r = post(NF.ctx, { token: NF.token, action: 'saveDay',
    payload: Object.assign(clean, { entryId: 'nori-day-a' }) });
  assert.strictEqual(r.ok, true, 'the phone queued a day the server refuses: ' + r.error);
  assert.strictEqual(r.data.excluded_total, 300);
  assert.strictEqual(r.data.total, 500);
});

test('the Cutoff screen block matches the server: excluded apart, note untouched', () => {
  const app = syncedClient(NF.boot);
  const local = app.computeCutoff(PERIOD);
  const f = NF.cutoff.figures;
  assert.strictEqual(local.excluded, f.excluded, 'the phone and the sheet must agree: ' +
    local.excluded + ' vs ' + f.excluded);
  assert.deepStrictEqual(local.excludedLines, f.excluded_lines,
    'the block under the note is the same block the server computed');
  assert.strictEqual(local.excluded, local.excludedLines.reduce((s, l) => s + l.amount, 0));
  // And it is in NOTHING else: the identity still closes with nori nowhere in it.
  assert.strictEqual(local.total, f.total);
  assert.strictEqual(local.total, local.cash + local.gcash);
  assert.strictEqual(local.total, app.num(local.mama) + local.split + local.supplies +
    local.octopus + local.salary + local.other + local.electric + local.remaining,
    'Total = Mama + Split + Supplies + Octopus + Salary + Other + Electric + Remaining');
  assert.notStrictEqual(local.excluded, 0, 'and that identity closed while money WAS excluded');
  // The note is the artefact that must not move by a byte.
  const note = app.buildNote(local, PERIOD);
  assert.strictEqual(note, NF.cutoff.note_text, 'the phone note must equal the server note');
  assert.ok(!/nori/i.test(note), 'the note must not name an excluded sku');
  const clean = syncedClient(NF_NONE.boot);
  assert.strictEqual(note, clean.buildNote(clean.computeCutoff(PERIOD), PERIOD),
    'and it must be identical to the same fortnight with no nori sold at all');
  // Nothing sold, nothing to show.
  assert.strictEqual(clean.computeCutoff(PERIOD).excluded, 0);
  assert.deepStrictEqual(clean.computeCutoff(PERIOD).excludedLines, []);
  // A count row with NO snapshot whose sku the phone cannot look up counts IN, so it
  // never appears in this block by accident...
  const orphan = syncedClient(NF.boot);
  orphan.state.prices = orphan.state.prices.filter(p => p.sku !== 'nori');
  orphan.state.counts[N_DAY_A].forEach(r => { r.in_cutoff = ''; });
  orphan.state.counts[N_DAY_B].forEach(r => { r.in_cutoff = ''; });
  assert.deepStrictEqual(orphan.excludedForPeriod(PERIOD).lines, [],
    'a sku with no price row and no snapshot must not be silently excluded');
  // ...but an explicit FALSE snapshot on such a row IS excluded money that is in no
  // total, so it is still shown — under its sku as its own label, exactly as the
  // server lists it (v2.4.1). Dropping it would leave `excluded` unequal to the lines
  // printed beneath it, and money the owner keeps out visible nowhere at all.
  const gone = syncedClient(NF.boot);
  gone.state.prices = gone.state.prices.filter(p => p.sku !== 'nori');
  const orphanBlock = gone.excludedForPeriod(PERIOD);
  assert.deepStrictEqual(orphanBlock.lines, [{ sku: 'nori', label: 'nori', qty: 16, amount: 400 }],
    'excluded money whose price row has gone must still be listed');
  assert.strictEqual(orphanBlock.total, orphanBlock.lines.reduce((s, l) => s + l.amount, 0),
    'the total must always equal the lines printed beneath it');
});

// The guards above are only fixes if the screens use them, and these live inside
// render functions that need a DOM — so they are pinned against the SOURCE, the
// same way the slab markers are.
test('the screens show nori apart: card badge, receipt line, tin, cutoff block, toggle', () => {
  const render = slab('function renderBenta(){', 'const CHEV =');
  // PIN MOVED (v2.5.1, deliberate): the card reads THE DAY's effective flag —
  // the loaded row's own snapshot first, then the live price-row flag — the
  // same reading computeDay, validateBenta and the payload use, so one flip in
  // Maintenance cannot make the card and the receipt tell two stories.
  assert.ok(/cutoffOnDay\(daySnap,\s*pr\)/.test(render),
    'the Sales card must read the DAY\'s effective flag (snapshot first, then the price row)');
  assert.ok(/badge-excl/.test(render), 'an excluded sku must be visibly marked on its card');
  assert.ok(/excl-note/.test(render), 'and say in one short line where its money goes');
  assert.ok(/inCut \?/.test(render), 'no payment buckets on a sku with no payment split');

  const receipt = slab('function updateReceipt(){', 'function rLine(label, amt){');
  assert.ok(/if \(!l\.in_cutoff\) continue;/.test(receipt),
    'an excluded sku must NOT sit among the lines that add up to the TOTAL');
  assert.ok(receipt.indexOf('excludedLines') > receipt.indexOf('>Cash<'),
    'its own line comes BELOW Total / GCash / Cash');
  assert.ok(/Cash in the tin/.test(receipt),
    'the tin holds Cash PLUS this money — without that line it can never reconcile');

  const cutoff = slab('function renderCutoff(){', 'async function generateNote(){');
  assert.ok(/excludedBlockHTML\(f\)/.test(cutoff), 'the Cutoff screen must render the block');
  assert.ok(cutoff.indexOf('excludedBlockHTML(f)') > cutoff.indexOf('notePre'),
    'and it must come BELOW the note');
  assert.ok(/Not part of this cutoff/.test(cutoff) && /NOT in the note/.test(cutoff),
    'labelled so it cannot be mistaken for part of the cutoff or the note');
  const noteFn = slab('function buildNote(f, per){', '/* ------------------------------------------------------------\n   STOCK ON HAND');
  assert.strictEqual(/exclu/i.test(noteFn), false,
    'buildNote must not read the excluded figures at all — the note does not change');

  const maint = slab('function maintenanceHTML(){', 'function priceRowError(pr, m){');
  assert.ok(/data-mcutoff/.test(maint), 'Maintenance must offer the per-sku cutoff toggle');
  assert.ok(/Counts in the cutoff/.test(maint), 'in words the owner can read');
  const savePrices = slab('function saveMaintPrices(){', 'function saveMaintSettings(){');
  assert.ok(/inCutoff/.test(savePrices), 'and send it — this screen knows the flag');
});

test('Maintenance can retune nori and switch the flag, and the server agrees', () => {
  const app = syncedClient(NF.boot);
  // Exactly the batch saveMaintPrices() builds out of the fields on screen.
  const rows = app.state.prices.map(p => ({
    sku: p.sku, price: app.num(p.price), cheesePrice: app.num(p.cheese_price),
    active: !!p.active, inCutoff: p.in_cutoff !== false
  }));
  const nori = rows.find(r => r.sku === 'nori');
  assert.strictEqual(nori.inCutoff, false, 'the toggle starts off for nori');
  nori.price = 30;                                  // nori's price is editable
  const r = post(NF.ctx, { token: NF.token, action: 'savePrices', payload: { rows } });
  assert.strictEqual(r.ok, true, 'the batch the screen sends must be accepted: ' + r.error);
  const boot = post(NF.ctx, { token: NF.token, action: 'bootstrap', payload: {} });
  const after = boot.data.prices.find(p => p.sku === 'nori');
  assert.strictEqual(after.price, 30, 'nori is priced like any other item');
  assert.strictEqual(after.in_cutoff, false, 'and it stayed out of the cutoff');
  boot.data.prices.filter(p => p.sku !== 'nori').forEach(p => assert.strictEqual(p.in_cutoff, true,
    'one ordinary price save must never take a takoyaki sku out of the cutoff'));
  // The local applier honours the same rule the server does: a payload that says
  // nothing about the flag leaves it exactly as it is.
  const old = syncedClient(NF.boot);
  old.applyLocalPrices({ rows: [{ sku:'nori', price:30, cheesePrice:0, active:true }] });
  assert.strictEqual(old.state.prices.find(p => p.sku === 'nori').in_cutoff, false,
    'a batch queued before v2.4.0 must not switch a flag it has never heard of');
  old.applyLocalPrices({ rows: [{ sku:'nori', price:30, cheesePrice:0, active:true, inCutoff:true }] });
  assert.strictEqual(old.state.prices.find(p => p.sku === 'nori').in_cutoff, true,
    'an explicit value is applied');
});

// v2.4.1. Whether a line's money counted is a fact about the NIGHT IT WAS SAVED,
// so the flag is snapshotted onto the count row and travels with it. Ticking
// "counts in the cutoff" is an ordinary thing to do in Maintenance, and it must
// not restate a fortnight that has already been sent — on either side of the seam.
test('the in_cutoff SNAPSHOT crosses the seam, and a later flip restates nothing', () => {
  const SNAP = noriFixture(true);          // its own server: nori sold on two days
  // Every count row the phone receives says whether ITS OWN money counted.
  const rowOf = (date, sku) => SNAP.boot.counts.find(c => c.date === date && c.sku === sku);
  assert.strictEqual(rowOf(N_DAY_A, 'nori').in_cutoff, false,
    'the snapshot must reach the phone, or history is classified by a live flag again');
  assert.strictEqual(rowOf(N_DAY_A, 'box4').in_cutoff, true);
  assertPairs('bootstrap.counts[]', SNAP.boot.counts, CONTRACT['bootstrap.counts[]']);
  assertNoCamelKeys('bootstrap(snapshot)', SNAP.boot.counts);

  // The owner ticks nori back into the cutoff, a fortnight after the fact.
  const flip = post(SNAP.ctx, { token: SNAP.token, action: 'savePrices',
    payload: { rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: true }] } });
  assert.strictEqual(flip.ok, true, flip.error);
  const after = post(SNAP.ctx, { token: SNAP.token, action: 'cutoff',
    payload: { start: PERIOD.start, end: PERIOD.end, dryRun: true } });
  assert.strictEqual(after.ok, true, after.error);
  assert.deepStrictEqual(after.data.figures, SNAP.cutoff.figures,
    'a flag flip may not move one figure of a fortnight that is already saved');
  assert.strictEqual(after.data.note_text, SNAP.cutoff.note_text,
    'and the note his partner already has must regenerate byte for byte');
  assert.strictEqual(after.data.figures.excluded, N_EXPECT.excluded,
    'the ₱400 was in no total, so dropping it from the block loses it everywhere');

  // ...and a phone that re-bootstraps afterwards is told the same money it was
  // told before: the day rows, and therefore every figure it computes off them.
  const boot2 = post(SNAP.ctx, { token: SNAP.token, action: 'bootstrap', payload: {} });
  assert.deepStrictEqual(boot2.data.days, SNAP.boot.days,
    'the stored day money is history and a flag flip must not touch it');
  const app = syncedClient(boot2.data);
  const { local } = assertCutoffSeam(app, PERIOD, after.data);
  assert.strictEqual(local.total, N_EXPECT.total);
  assert.strictEqual(local.total, local.cash + local.gcash);
});

// The bucket guard and the simple-only rule, at the seam: the phone can never
// build a payload that trips either of them, and the server refuses them anyway.
test('no bucket on an excluded sku, and an excluded sku is always group=simple', () => {
  const app = syncedClient(NF.boot);
  const nori = app.state.prices.find(p => p.sku === 'nori');
  assert.strictEqual(nori.group, 'simple', 'an excluded sku must be a simple item');
  assert.strictEqual(nori.in_cutoff, false);
  // v2.5.0: what is SHOWN is what is SENT. The old force-to-zero made a stale
  // GCash count invisible and unsaveable — the campaign's dead-end finding (i=0).
  // A stale draft's buckets now travel as-is, the phone refuses the save with
  // the escape route named, and zeroing the now-visible steppers frees the day.
  app.loadBentaForm(N_DAY_A);
  const row = app.benta.rows.find(r => r.sku === 'nori');
  row.cheese = 3; row.gcash = 2; row.gcashCheese = 1;
  const sent = app.bentaPayload().counts.find(c => c.sku === 'nori');
  assert.deepStrictEqual([sent.cheeseQty, sent.gcashQty, sent.gcashCheeseQty], [3, 2, 1],
    'visible = sent: the phone never silently drops a count it is showing');
  const errs = app.validateBenta();
  assert.ok(errs['sku:nori'], 'and it refuses to save while a bucket is non-zero');
  assert.match(errs['sku:nori'], /back to 0|Counts in the cutoff/,
    'naming the way out, not just the rule');
  // Zeroing the (now visible) buckets is the escape — the same day then saves.
  row.cheese = 0; row.gcash = 0; row.gcashCheese = 0;
  const cleared = app.bentaPayload().counts.find(c => c.sku === 'nori');
  assert.deepStrictEqual([cleared.cheeseQty, cleared.gcashQty, cleared.gcashCheeseQty], [0, 0, 0]);
  assert.ok(!app.validateBenta()['sku:nori'], 'no error once zeroed');

  // The server refuses each bucket by name if one ever arrives, and refuses the
  // whole configuration if a box sku is hand-edited out of the cutoff.
  const { ctx, ss, token } = loadServer();
  const day = counts => post(ctx, { token, action: 'saveDay', payload: {
    date: N_DAY_A, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: counts, entryId: 'seam-excl-1' } });
  const gcash = day([{ sku: 'nori', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 1, gcashCheeseQty: 0 }]);
  assert.strictEqual(gcash.ok, false);
  assert.match(gcash.error, /Nori/);
  assert.match(gcash.error, /its GCash count must be 0/);

  // A box sku switched out of the cutoff: savePrices will not create it...
  const bad = post(ctx, { token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 50, cheesePrice: 60, active: true, inCutoff: false }] } });
  assert.strictEqual(bad.ok, false, 'a box with a cheese version cannot be kept out of the cutoff');
  assert.match(bad.error, /box4/);
  // ...and a sheet hand-edited into it cannot have a day saved against it, because
  // the Sales card would hide the cheese steppers the payload still carries.
  const prices = ss.getSheetByName('Prices');
  const head = prices.getDataRange().getValues()[0];
  prices.getRange(2, head.indexOf('in_cutoff') + 1).setValue(false);
  assert.strictEqual(prices.getDataRange().getValues()[1][0], 'box4', 'precondition: row 2 is box4');
  const handEdited = day([{ sku: 'box4', sod: 4, eod: 0, cheeseQty: 1, gcashQty: 0, gcashCheeseQty: 0 }]);
  assert.strictEqual(handEdited.ok, false);
  assert.match(handEdited.error, /Box 4/, 'the message must name the item');
  assert.match(handEdited.error, /its cheese count must be 0|simple/,
    'and say what to zero or what to change');
});

// ---------------------------------------------------------------------------
console.log("\n--- 16. v2.4.1 on the PHONE: snapshot, buckets, and the nightly screen ---");

// F2. The phone classified a SAVED day's money by the LIVE Prices flag, so ticking
// "counts in the cutoff" in Maintenance restated a fortnight it had already shown —
// in both directions. Whether a line's money counted is a fact about the night it
// was saved, and the count row now carries it.
test('the phone reads the SNAPSHOT off each count row, not the live flag', () => {
  const app = syncedClient(NF.boot);
  const rowOf = (date, sku) => app.state.counts[date].find(r => r.sku === sku);
  assert.strictEqual(rowOf(N_DAY_A, 'nori').in_cutoff, false,
    'the snapshot the server sent must survive normCount, or history is classified by a live flag');
  assert.strictEqual(rowOf(N_DAY_A, 'box4').in_cutoff, true);
  assert.strictEqual(app.countInCutoff(rowOf(N_DAY_A, 'nori')), false);
  assert.strictEqual(app.countInCutoff(rowOf(N_DAY_A, 'box4')), true);

  const before = app.computeCutoff(PERIOD);
  assert.strictEqual(before.excluded, N_EXPECT.excluded, 'precondition: ₱400 of nori is kept out');

  // The owner ticks nori BACK INTO the cutoff, a fortnight after the fact — an
  // ordinary thing to do on the Maintenance screen.
  app.applyLocalPrices({ rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: true }] });
  assert.strictEqual(app.skuInCutoff('nori'), true, 'precondition: the live flag really did flip');
  const after = app.computeCutoff(PERIOD);
  assert.strictEqual(after.excluded, N_EXPECT.excluded,
    'the ₱400 was in NO total, so dropping it from the block makes it vanish from the phone entirely');
  assert.deepStrictEqual(after.excludedLines, before.excludedLines);
  assert.strictEqual(after.total, before.total, 'and the saved day money is history — it must not move');
  assert.strictEqual(app.buildNote(after, PERIOD), app.buildNote(before, PERIOD),
    'the note is built from figures a flag flip may not touch');

  // The other direction: a sku that WAS counted must not also appear as "kept out"
  // — its money is inside `total`, so it would be shown twice, contradicting itself.
  const out = syncedClient(NF.boot);
  out.state.prices.find(p => p.sku === 'box4').in_cutoff = false;   // as a hand-edited sheet would arrive
  const flipped = out.computeCutoff(PERIOD);
  assert.deepStrictEqual(flipped.excludedLines, before.excludedLines,
    "box4's saved money is inside total — it cannot also be listed as kept out");
  assert.strictEqual(flipped.total, before.total);
});

test('a count row with no snapshot falls back to the sku flag, and only then', () => {
  const app = loadClient();
  // Raw at the normalizer: an explicit value survives, a blank stays blank.
  assert.strictEqual(app.normCount({ sku: 'nori', date: N_DAY_A, in_cutoff: false }).in_cutoff, false);
  assert.strictEqual(app.normCount({ sku: 'box4', date: N_DAY_A, in_cutoff: true }).in_cutoff, true);
  assert.strictEqual(app.normCount({ sku: 'box4', date: N_DAY_A, in_cutoff: 'FALSE' }).in_cutoff, false,
    'the sheet writes booleans as text through the API');
  assert.strictEqual(app.normCount({ sku: 'box4', date: N_DAY_A }).in_cutoff, '',
    'a row written before v2.4.1 has NO snapshot and must not pretend to have one');
  assert.strictEqual(app.normCount({ sku: 'box4', date: N_DAY_A, in_cutoff: '' }).in_cutoff, '');
  assert.strictEqual(app.normCount({ sku: 'nori', date: N_DAY_A, inCutoff: false }).in_cutoff, false,
    'a legacy camelCase server must not lose the snapshot either');
  assert.strictEqual(app.rawCutoffFlag(undefined), '');
  assert.strictEqual(app.rawCutoffFlag('no'), false);

  // Resolved at USE time: blank -> the sku's current flag; explicit -> itself.
  assert.strictEqual(app.countInCutoff({ sku: 'nori', in_cutoff: '' }), false, "nori's flag is off");
  assert.strictEqual(app.countInCutoff({ sku: 'box4', in_cutoff: '' }), true);
  assert.strictEqual(app.countInCutoff({ sku: 'who-knows', in_cutoff: '' }), true,
    'a sku with no price row counts IN — never drop money nobody asked to drop');
  assert.strictEqual(app.countInCutoff({ sku: 'box4', in_cutoff: false }), false,
    'an explicit snapshot beats the live flag, which is the whole point');

  // A whole fortnight of pre-v2.4.1 rows: classified by the sku's flag, which is the
  // best answer such a row can give — and NOT silently dropped.
  const legacy = syncedClient(NF.boot);
  [N_DAY_A, N_DAY_B].forEach(d => legacy.state.counts[d].forEach(r => { r.in_cutoff = ''; }));
  assert.strictEqual(legacy.excludedForPeriod(PERIOD).total, N_EXPECT.excluded);
  assert.strictEqual(legacy.computeCutoff(PERIOD).total, N_EXPECT.total);
});

test('the phone snapshots the flag when IT saves a day, and the server reply agrees', () => {
  const app = syncedClient(NF.boot);
  const payload = noriDay(N_DAY_A, 'box4', 10, 2, 12, 'nori-day-a');
  app.applyLocalDay(payload);
  const nori = app.state.counts[N_DAY_A].find(r => r.sku === 'nori');
  assert.strictEqual(nori.in_cutoff, false,
    'the optimistic write must snapshot the flag beside the money it decided');
  assert.strictEqual(app.state.counts[N_DAY_A].find(r => r.sku === 'box4').in_cutoff, true);
  // Offline, before any reply: flipping the flag must not restate what was just saved.
  app.applyLocalPrices({ rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: true }] });
  assert.strictEqual(app.excludedForPeriod(PERIOD).total, N_EXPECT.excluded);
  // And the server's own per-line snapshot lands on the row when the reply arrives.
  app.applyServerDay(payload, NF.dayA);
  assert.strictEqual(app.state.counts[N_DAY_A].find(r => r.sku === 'nori').in_cutoff, false);
  assert.strictEqual(app.excludedForPeriod(PERIOD).total, N_EXPECT.excluded);
});

test('the server reply corrects a snapshot the phone guessed wrong', () => {
  const app = syncedClient(NF.boot);
  // This phone has not seen the Maintenance change yet: its price list still says
  // nori counts IN. On a date it holds NO stored rows for, the live flag is all
  // it has, so its own optimistic write snapshots the wrong answer. (With stored
  // rows the snapshot wins instead — the v2.5.1 test below this one.)
  app.state.prices.find(p => p.sku === 'nori').in_cutoff = true;
  delete app.state.counts[N_DAY_A];                 // a phone that never held this date
  const payload = noriDay(N_DAY_A, 'box4', 10, 2, 12, 'nori-day-a');
  app.applyLocalDay(payload);
  assert.strictEqual(app.state.counts[N_DAY_A].find(r => r.sku === 'nori').in_cutoff, true,
    'precondition: the phone guessed IN, because that is what its price list said');
  assert.strictEqual(app.state.days[N_DAY_A].total, 800, 'and banked nori inside the day total');
  // The sheet knows better, and its reply is authoritative — the money AND which
  // line of it counted.
  app.applyServerDay(payload, NF.dayA);
  assert.strictEqual(app.state.days[N_DAY_A].total, 500);
  assert.strictEqual(app.state.days[N_DAY_A].excluded_total, 300);
  assert.strictEqual(app.state.counts[N_DAY_A].find(r => r.sku === 'nori').in_cutoff, false,
    'the row must be reclassified too, or that ₱300 is in no total AND in no excluded block');
  assert.strictEqual(app.excludedForPeriod(PERIOD).total, N_EXPECT.excluded,
    'which is exactly the block the Cutoff screen shows');
});

// F1/F3. An excluded sku has NO variant and NO payment split at all. Guarding the
// GCash bucket alone let a cheese count be priced at the CHEESE price into the
// excluded money the receipt shows — money the sheet would never store.
test('an excluded sku prices and sends NO bucket, even when the sheet calls it a box', () => {
  const app = syncedClient(NF.boot);
  // The sheet has been hand-edited into the state savePrices refuses to create:
  // nori kept out of the cutoff, but still a box with a cheese price.
  const nori = app.state.prices.find(p => p.sku === 'nori');
  nori.group = 'box'; nori.cheese_price = 60;
  // A payload an older build queued (or a hand-edited row) with every bucket filled.
  const stale = { date: N_DAY_A, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'nori', sod: 12, eod: 0, cheeseQty: 2, gcashQty: 3, gcashCheeseQty: 1 }] };
  const c = app.computeDay(stale);
  assert.strictEqual(c.excluded, 300,
    '12 nori at the ONE price of 25 — a cheese bucket must never be priced at 60 here');
  assert.strictEqual(c.gcash, 0, 'and none of it may reach the day GCash figure');
  assert.strictEqual(c.total, 0, 'nor the day total');
  const line = c.lines.find(l => l.sku === 'nori');
  assert.deepStrictEqual([line.cheese_qty, line.gcash_qty, line.gcash_cheese_qty], [0, 0, 0]);
  assert.strictEqual(line.regular_qty, 12, 'all twelve are plain quantity');

  // v2.5.0: the form sends what it shows — and refuses to save until the
  // now-visible buckets are zeroed, so nothing is silently dropped and the
  // pricing above (one plain price) can never disagree with a saved sheet row.
  app.loadBentaForm(N_DAY_A);
  const row = app.benta.rows.find(r => r.sku === 'nori');
  row.cheese = 2; row.gcash = 3; row.gcashCheese = 1;
  const sent = app.bentaPayload().counts.find(x => x.sku === 'nori');
  assert.deepStrictEqual([sent.cheeseQty, sent.gcashQty, sent.gcashCheeseQty], [2, 3, 1],
    'visible = sent, even on a hand-broken excluded box sku');
  assert.ok(app.validateBenta()['sku:nori'],
    'and the save is refused until they are zeroed, so [2,3,1] can never land');
  // Zeroing clears the BUCKET complaint, but this sku is the hand-broken
  // box+excluded CONFIGURATION, which stays refused in its own words until the
  // sheet is fixed — that is the next test's subject, and the server's rule.
  row.cheese = 0; row.gcash = 0; row.gcashCheese = 0;
  const still = app.validateBenta()['sku:nori'];
  assert.ok(still, 'the configuration itself is still refused at zero');
  assert.match(still, /simple|Counts in the cutoff|Prices tab/,
    'in configuration words, not bucket words');
});

test("the phone refuses a bucket on an excluded sku in the SERVER's own words", () => {
  const app = syncedClient(NF.boot);
  // A GCash count on nori (simple + excluded): word for word what the server says.
  const srv = loadServer();
  const day = counts => post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: N_DAY_A, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: counts, entryId: 'phone-excl-1' } });
  const served = day([{ sku: 'nori', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 1, gcashCheeseQty: 0 }]);
  assert.strictEqual(served.ok, false, 'precondition: the server refuses it');
  // v2.5.0: the phone keeps the server's sentence BYTE-EXACT as its prefix (so
  // the two can never describe the same money differently) and then appends the
  // escape route the server cannot know about — the campaign's dead-end finding
  // (i=0) was precisely that this refusal named no way out.
  const phoneMsg = app.excludedRowError('nori', { gcash: 1 });
  assert.ok(phoneMsg.startsWith(served.error),
    'the server sentence must survive byte-exact at the front of the phone message');
  assert.match(phoneMsg, /back to 0/, 'and the way out is named: zero the visible count');
  assert.match(phoneMsg, /Counts in the cutoff|Maintenance/, 'or re-include the sku');

  // Through the validator, which is what actually blocks the save.
  app.loadBentaForm(N_DAY_A);
  app.benta.rows.find(r => r.sku === 'nori').gcash = 4;
  const errs = app.validateBenta();
  assert.match(errs['sku:nori'], /its GCash count must be 0/);
  assert.ok(!errs['sku:box4'] && !errs['sku:box6'], 'and it complains about nothing else');

  // All three buckets at once, on a sheet hand-edited into box + excluded: the
  // server names them with "and", and so must the phone.
  const prices = srv.ss.getSheetByName('Prices');
  const head = prices.getDataRange().getValues()[0];
  assert.strictEqual(prices.getDataRange().getValues()[1][0], 'box4', 'precondition: row 2 is box4');
  prices.getRange(2, head.indexOf('in_cutoff') + 1).setValue(false);
  const three = day([{ sku: 'box4', sod: 9, eod: 0, cheeseQty: 1, gcashQty: 1, gcashCheeseQty: 1 }]);
  assert.strictEqual(three.ok, false);
  assert.match(three.error, /its cheese, GCash and GCash cheese counts must be 0/);
  const app2 = syncedClient(NF.boot);
  app2.state.prices.find(p => p.sku === 'box4').in_cutoff = false;
  const phoneThree = app2.excludedRowError('box4', { cheese: 1, gcash: 1, gcashCheese: 1 });
  assert.ok(phoneThree.startsWith(three.error),
    "the multi-bucket 'and' sentence survives byte-exact, escape route appended");

  // A nightly save must NEVER trip any of this: nori is on the form every night
  // with nothing in its buckets, and the day has to save.
  const ok = syncedClient(NF.boot);
  ok.loadBentaForm('2026-07-28');
  ok.benta.rows.find(r => r.sku === 'box4').sod = 10;
  assert.deepStrictEqual(Object.keys(ok.validateBenta()), [],
    'an ordinary night with nori on the form and none sold must save without a word');
});

test('an excluded box sku is refused inline instead of losing its cheese counts', () => {
  const app = syncedClient(NF.boot);
  const nori = app.state.prices.find(p => p.sku === 'nori');
  nori.group = 'box'; nori.cheese_price = 60;
  app.loadBentaForm(N_DAY_A);
  const errs = app.validateBenta();
  assert.ok(errs['sku:nori'], 'the server refuses this whole configuration — the phone must say so first');
  assert.match(errs['sku:nori'], /kept out of the cutoff/);
  assert.match(errs['sku:nori'], /simple/, 'and say what to change');
  assert.match(errs['sku:nori'], /Counts in the cutoff/, 'naming the toggle that is one tap away');
  // The card renders plain — one price, no cheese price, no buckets — so it can never
  // show a cheese figure the save is about to refuse.
  const render = slab('function renderBenta(){', 'const CHEV =');
  assert.ok(/const showCheese = isBox && inCut;/.test(render),
    'an excluded sku must render as a plain quantity card whatever its group says');
  assert.ok(/showCheese \? ' · Cheese '/.test(render), 'so no cheese price appears on it');

  // Maintenance cannot CREATE that state either: the same rule the server enforces.
  const box4 = app.state.prices.find(p => p.sku === 'box4');
  const msg = app.priceRowError(box4, { price: 50, cheesePrice: 60, active: true, inCutoff: false });
  assert.match(msg, /cannot be kept out of the cutoff/);
  assert.match(msg, /Box 4/);
  assert.strictEqual(app.priceRowError(box4, { price: 50, cheesePrice: 60, active: false, inCutoff: false }),
    msg, 'switching the sku off does not make a box excludable');
  assert.strictEqual(app.priceRowError(box4, { price: 50, cheesePrice: 60, active: true, inCutoff: true }), '');
  assert.strictEqual(app.priceRowError(box4, { price: 50, cheesePrice: 60, active: true }), '',
    'a batch that says nothing about the flag means leave it alone — it must still save');
  assert.strictEqual(app.priceRowError({ sku: 'nori', label: 'Nori', group: 'simple' },
    { price: 25, cheesePrice: 0, active: true, inCutoff: false }),
    '', 'a simple sku is exactly what an excluded sku should be');
  const srv = loadServer();
  const bad = post(srv.ctx, { token: srv.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 50, cheesePrice: 60, active: true, inCutoff: false }] } });
  assert.strictEqual(bad.ok, false, 'the server refuses the batch this screen would have queued');
});

// F4/F5. The nightly screen. There is a nori line in `excludedLines` on EVERY night,
// so the receipt printed a dead "Nori ×0 — not in the total ₱0" and the tautology
// "Cash in the tin: ₱825 + ₱0 Nori = ₱825" on every ordinary one.
test('an ordinary night shows no excluded line and no tin line at all', () => {
  const app = syncedClient(NF.boot);
  app.loadBentaForm('2026-07-28');                 // a fresh night, nori on the form as always
  app.benta.rows.find(r => r.sku === 'box4').sod = 10;
  const c = app.computeDay(app.bentaPayload());
  assert.strictEqual(c.total, 500);
  assert.strictEqual(c.cash, 500);
  assert.strictEqual(c.excluded, 0);
  assert.strictEqual(c.excludedLines.length, 1,
    'precondition: the dead nori line IS there — the filter is what keeps it off the screen');
  assert.deepStrictEqual(app.excludedTonight(c), [], 'so nothing excluded is printed');

  // The same night with 3 nori sold: one line, and the tin the money actually sits in.
  app.benta.rows.find(r => r.sku === 'nori').sod = 3;
  const withNori = app.computeDay(app.bentaPayload());
  assert.strictEqual(withNori.total, 500, 'nori is still in no total');
  assert.strictEqual(withNori.cash, 500);
  assert.strictEqual(withNori.excluded, 75);
  const shown = app.excludedTonight(withNori);
  assert.deepStrictEqual(shown.map(l => [l.label, l.sold, l.amount]), [['Nori', 3, 75]]);
  assert.strictEqual(app.tinTotal(withNori), 575, 'Cash 500 + the 75 that shares the tin');
  assert.strictEqual(app.tinTotal(withNori), withNori.cash + withNori.excluded);

  // A closed day, and a night where nothing at all was entered: still silent.
  app.benta.closed = true;
  assert.deepStrictEqual(app.excludedTonight(app.computeDay(app.bentaPayload())), []);
});

test('the receipt and the day strip read the SAME rule for the tin', () => {
  const receipt = slab('function updateReceipt(){', 'function rLine(label, amt){');
  assert.ok(/const xl = excludedTonight\(c\);/.test(receipt),
    'the receipt must ask whether there is excluded money tonight');
  assert.ok(/if \(xl\.length\)\{/.test(receipt), 'and print the block only then');
  assert.ok(!/asArr\(c\.excludedLines\)\.length/.test(receipt),
    'the unconditional test is what printed a ₱0 line every single night');
  assert.ok(receipt.indexOf('r-tin') > receipt.indexOf('const xl = excludedTonight(c);'),
    'the tin line lives inside that guard');
  assert.ok(receipt.indexOf('excludedTonight') > receipt.indexOf('>Cash<'),
    'and still comes BELOW Total / GCash / Cash');

  const strip = slab('function updateDayStrip(c){', 'function isWhole(v){');
  assert.ok(/excludedTonight\(d\)\.length/.test(strip),
    'the strip must use the same rule as the receipt, or the two disagree about the tin');
  assert.ok(/Tin <b>' \+ peso\(tinTotal\(d\)\)/.test(strip),
    'one short item showing the tin — the strip exists because the receipt is screens away');
  assert.ok(/\? '<span class="tin">/.test(strip) && /: ''/.test(strip),
    'and nothing at all when there is no excluded money');
  assert.ok(/<\/span>' \+ tin \+ '<\/div>/.test(strip), 'appended after Cash and GCash');
});

// ---------------------------------------------------------------------------
console.log('\n--- 17. v2.5.0 on the PHONE: queue races, price snapshots, dates, details ---');

// The sync engine itself, lifted the same way as everything else. These slabs
// fill the gaps between the ones above, so the whole stretch from the appliers
// to applyBootstrap is the REAL shipped code.
const S_ENQUEUE  = slab('function enqueue(action, payload){', 'function noteAttention(kind, action, payload, message){');
const S_WIRE     = slab('function isLegacyGcashPayload(p){', 'function applyServerDay(p, data){');
const S_DOBOOT   = slab('async function doBootstrap(){', 'function applyBootstrap(data){');
const S_PERSISTA = slab('function persistAttention(){', 'function persistDrafts(){');
const S_ATTNCOPY = slab('function attnCopy(a){', 'function attentionCardHTML(){');
const S_CUTHELP  = slab('function cutoffMissingDays(per){', 'function renderCutoff(){');
// v2.7.4: the "Stock came in" form's state and save path — rows snapshot their
// product NAME at open, so a list change mid-form can never move typed work.
const S_ARRSTATE = slab("let countingProduct = '';", 'function stockOnHandHTML(){');
const S_ARRFNS   = slab('function arriveStep(i, dir){', 'let maintOpen = false;');

// v2.9.0 "Read it from the paper". Four slabs, because the feature's code is
// spread across four places in the shipped file and every one of them is real
// behaviour a test here has to drive rather than re-describe:
//   S_BLANKS  — BLANK IS NOT ZERO: the display-only readers (isBlankVal /
//               stepVal / uiVal / soldVal) that decide what a count box SHOWS.
//               Lifted with rowUI, which they are the presentation half of.
//   S_SKULIST — bentaSkuList: the phone's OWN product vocabulary, which is what
//               travels to the vision app instead of the sheet being read.
//   S_LISTPHR — listPhrase, which the cross-check's "the end count is empty on
//               X and Y" sentence is built with.
//   S_PAPER   — the whole photo-reader module: visionApi, shrinkPhoto, the
//               reading's normalizer, THE PREFILL, THE CROSS-CHECK, and every
//               builder that turns model text into markup.
const S_SKULIST  = slab('function bentaSkuList(){', '// Plain-English breakdown of one sku row:');
const S_LISTPHR  = slab('function listPhrase(names){', 'function applyDroppedSkus(p, skus){');
// The update gate (v2.9.7): when a downloaded version is allowed to take over.
const S_UPDATE   = slab('let updateWaiting = false;', "if ('serviceWorker' in navigator){");
const S_PAPER    = slab('function visionReady(){ return !!(txt(config.visionUrl)',
  '/* ============================================================ ' +
  'Event wiring — delegated clicks/inputs per panel + globals');

/** A client whose sync engine is REAL: enqueue, drainQueue, doBootstrap, api —
 *  with the wire (fetch), storage success and every toast/render under the
 *  test's control via `hooks`. drainQueue and doBootstrap return promises, so
 *  the tests that race them are async (see atest below). */
function loadSyncClient() {
  const src = `
'use strict';
const hooks = {
  fetch: () => { throw new Error('this test made no wire'); },
  storeFail: false, toasts: [], panels: [],
  // v2.9.0: the photo reader's surroundings. els is the tiny DOM the paper
  // card writes into; bitmap is what the camera decoded; jpegChars is how many
  // base64 characters a JPEG of that size comes to, so the shrink ladder is
  // walked for real.
  els: {}, confirms: [], confirmAnswer: true, encodes: [],
  bitmap: () => ({ width: 3000, height: 4000, close(){} }),
  jpegChars: (w, h, q) => Math.max(4, Math.round(w * h * (q || 0.8) * 0.02))
};
const store = { read(){ return null; }, set(k, v){ return !hooks.storeFail; } };
const navigator = { onLine: true };
${S_LOADERS}
${S_UTILS}
${S_DOMAIN}
${S_APPLIERS}
${S_ENQUEUE}
${S_ATTN}
${S_WIRE}
${S_SERVERDAY}
${S_DOBOOT}
${S_BOOTSTRAP}
${S_FORM}
${S_CARDS}
${S_MAINT}
${S_VALIDATE}
${S_ATTNCOPY}
${S_CUTHELP}
${S_PERSISTA}
${S_ARRSTATE}
${S_ARRFNS}
${S_SKULABEL}
${S_LISTPHR}
${S_BLANKS}
${S_SKULIST}
${S_PAPER}
let state = freshState();
let queue = [];
let config = freshConfig();
let attention = [];
let drafts = {};
let lastNote = null;
let benta = null;
let activeTab = 'benta';
let storageFull = false;
function pruneState(){}
function persistState(){}
function persistQueue(){}
function persistConfig(){}
function persistDrafts(){}
function updateStatus(){}
function renderIbapa(){}
function applyUpdateIfSafe(){}
const $ = (id) => (hooks.els[String(id)] || null);
function renderPanel(t){ hooks.panels.push(String(t)); }
function toast(m){ hooks.toasts.push(String(m)); }
function fetch(url, opts){ return hooks.fetch(url, opts); }
/* Timers, so a 30-SECOND deadline is checkable in milliseconds. hooks.timerCap
   is the longest any wait may actually last; the code still asks for its real
   30000/75000, and the message it writes still says "30 seconds". Without this
   the only honest test of the deadline would take half a minute. */
const _realST = globalThis.setTimeout, _realCT = globalThis.clearTimeout;
function setTimeout(fn, ms){
  return _realST(fn, hooks.timerCap === undefined ? ms : Math.min(ms, hooks.timerCap));
}
function clearTimeout(t){ return _realCT(t); }
// v2.9.0. The camera and the canvas, as thin as they can be and still exercise
// the REAL shrink ladder: createImageBitmap hands back the dimensions the test
// chose, and toDataURL reports a base64 body whose LENGTH is what the test says
// a JPEG of that size and quality would be. So shrinkPhoto's own arithmetic
// (b64Bytes, the 4 MB cap, the ladder walking down until something fits) is the
// code under test, not a mock of it.
function createImageBitmap(file, opts){ return hooks.bitmap(file, opts); }
const document = {
  activeElement: null,
  createElement(tag){
    if (String(tag) !== 'canvas') return {};
    return {
      width: 0, height: 0,
      getContext(){ return { fillStyle:'', fillRect(){}, drawImage(){} }; },
      toDataURL(mime, q){
        hooks.encodes.push({ w: this.width, h: this.height, mime: String(mime), q: q });
        return 'data:image/jpeg;base64,' + 'A'.repeat(hooks.jpegChars(this.width, this.height, q));
      }
    };
  }
};
function confirm(msg){ hooks.confirms.push(String(msg)); return hooks.confirmAnswer; }
return {
  get state(){ return state; },
  get benta(){ return benta; },
  get queue(){ return queue; },
  get attention(){ return attention; },
  get storageFull(){ return storageFull; },
  get syncing(){ return syncing; },
  get lastSyncError(){ return lastSyncError; },
  hooks, cfg: config, nav: navigator,
  applyBootstrap, applyLocalDay, applyLocalExpense, applyLocalStockCount,
  applyLocalStockDelivery, applyLocalDeleteExpense, sanitizeQueue,
  applyServerDay, reapplyQueue,
  enqueue, drainQueue, doBootstrap,
  // v2.19.0: the resume refresh, and the stamp it throttles on.
  maybeRefresh,
  get lastBootstrapAt(){ return lastBootstrapAt; },
  set lastBootstrapAt(v){ lastBootstrapAt = v; },
  noteAttention, attentionForDate, dateNotInSheet, daySavedMessage, clearAttentionFor,
  attnCopy, persistAttention, isLegacyGcashPayload,
  loadBentaForm, bentaPayload, computeDay, computeCutoff, validateBenta,
  entryDateError, cutoffExpenseDate, previewIncomplete, cutoffMissingDays,
  cutoffMissingMoney,
  currentPeriod, periodKey, storedPricesFor, priceOnDay,
  // v2.5.1: the server-derived figures the drain must refresh, the day-effective
  // flag, the blank-omitting settings payload and the phone's note refusal.
  backlogBalance, cutoffOnDay, stockStatusOf, stockStatusList,
  maintSettingsPayload, noteRefusal,
  // v2.7.4: the arrival form's save path, with its rows settable by tests.
  get arrival(){ return arrival; }, set arrival(v){ arrival = v; },
  arriveStep, saveArrival,
  // v2.9.0 "Read it from the paper". The whole module, plus live handles on the
  // one piece of state it owns, so a test can put the screen in any of its
  // states and drive the real flow end to end.
  visionReady, visionApi, paperTake, paperShoot, shrinkPhoto, b64Bytes, paperSkus,
  normReading, applyReadingToForm, paperCross, paperCrossHTML, paperCardHTML,
  paperPageDate, todayStr, d2parts,
  paperReviewHTML, paperFormFigures, paperSuspects, paperLink, paperInt, paperMoney,
  paperClear, paperShowingFor, bentaSkuList,
  isBlankVal, stepVal, uiVal, soldVal,
  // v2.10.0: tonight judged against the other nights.
  nightChecks, nightCheckHTML, soldHistory, totalHistory, medianOf,
  get paper(){ return paper; },
  set paper(v){ paper = v; },
  get paperErr(){ return paperErr; },
  get paperBusy(){ return paperBusy; },
  num, fmt, peso, esc, skuLabel
};`;
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

/** The REAL update gate, with the small world it touches faked around it, so
 *  "does a half-entered night keep this phone on old code forever" is a
 *  question the suite can actually answer. */
function loadUpdateGate(world) {
  const src = `
'use strict';
const log = { reloads: 0, stashes: 0, cachesDeleted: [], unregistered: 0, storeWrites: 0, hint: '' };
let benta = ${JSON.stringify(world.benta || null)};
let syncing = ${world.syncing ? 'true' : 'false'};
let paperBusy = ${JSON.stringify(world.paperBusy || '')};
const focused = ${JSON.stringify(world.focusedTag || '')};
const queue = ${JSON.stringify(world.queue || [])};
const document = {
  activeElement: focused ? { tagName: focused, isContentEditable: false } : null
};
const location = { reload(){ log.reloads++; } };
function stashBentaDraft(){ log.stashes++; }
// v2.13.3: what forceUpdate touches, and what it must NOT. store.set is counted
// so the test can prove localStorage was never written — the queue and the
// drafts live there, and that is the whole reason the button is safe to offer.
const store = { set(){ log.storeWrites++; return true; }, read(){ return null; } };
const caches = {
  async keys(){ return ['octogo-shell-v1.0.0', 'octogo-fonts-v1']; },
  async delete(k){ log.cachesDeleted.push(k); return true; }
};
const window = { caches: caches };
const navigator = {
  onLine: true,
  serviceWorker: {
    controller: ${world.controlled === false ? 'null' : '{}'},
    async getRegistrations(){ return [{ async unregister(){ log.unregistered++; return true; } }]; },
    addEventListener(){}
  }
};
function $(id){ return id === 'forceHint' ? { set textContent(v){ log.hint = String(v); } } : null; }
function asArr(v){ return Array.isArray(v) ? v : []; }
${S_UPDATE}
return {
  log, applyUpdateIfSafe, isTypingNow, forceUpdate, swStateText,
  get reloadingForUpdate(){ return reloadingForUpdate; },
  get updateWaiting(){ return updateWaiting; },
  set updateWaiting(v){ updateWaiting = v; },
  get benta(){ return benta; }
};`;
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

// Async tests: registered here, awaited IN ORDER by the runner at the bottom
// of the file (the summary waits for them).
const ASYNC_TESTS = [];
function atest(name, fn) { ASYNC_TESTS.push({ name, fn }); }
const WATCHDOG_MS = 10000;   // generous: the slowest real test is milliseconds
let summaryPrinted = false;
let lastStarted = '';

/** A wire that forwards every request to a REAL server's doPost. */
function liveWire(srv) {
  return (url, opts) => Promise.resolve({
    ok: true,
    text: async () => srv.ctx.doPost({ postData: { contents: opts.body } }).getContent()
  });
}

// Today/tomorrow on the CLIENT's clock (the PWA is not frozen — it runs on the
// phone's real clock), Asia/Manila like everything else.
function clientYmd(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' })
    .format(new Date(Date.now() + (offsetDays || 0) * 86400000));
}

// --- The two in-flight races (critical findings #4 and #5) -------------------
// A reply belongs to THE ITEM THAT WAS SENT. While it is in the air, enqueue
// may replace that item (a newer save for the same day coalesces) — and the
// stale reply must then be dropped whole, never applied over newer local rows.

atest('a reply that lands after its save was superseded is dropped whole', async () => {
  const srv = loadServer();
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  const D = ymdDaysAgo(2);

  const v1 = dayPayload(D, 100, 'race-old');       // the save that goes out first
  app.applyLocalDay(v1);
  app.enqueue('saveDay', v1);

  let release = null;
  let sent = 0;
  app.hooks.fetch = (url, opts) => {
    sent++;
    if (sent === 1) {
      // The request LEFT (the sheet write happens — it is harmless, the
      // replacement re-sends over the same upsert key), but the reply hangs
      // in the air until the test lets it land.
      const reply = srv.ctx.doPost({ postData: { contents: opts.body } }).getContent();
      return new Promise(res => { release = () => res({ ok: true, text: async () => reply }); });
    }
    // The network drops before the replacement can follow.
    return Promise.reject(new TypeError('Failed to fetch'));
  };

  const drained = app.drainQueue();
  assert.strictEqual(sent, 1, 'precondition: the old save is on the wire');

  // While it is in flight she corrects the same day: ₱3,000, not ₱5,000.
  const v2 = dayPayload(D, 60, 'race-new');
  app.applyLocalDay(v2);
  app.enqueue('saveDay', v2);                       // coalesces onto the same slot
  assert.strictEqual(app.state.days[D].total, 3000);

  release();                                        // the STALE reply lands now
  await drained;

  assert.strictEqual(app.state.days[D].total, 3000,
    'the superseded reply stamped OLD money (₱5,000) over the corrected row — while the pill said Synced');
  assert.strictEqual(app.queue.length, 1, 'the replacement must still be queued');
  assert.strictEqual(app.queue[0].payload.entryId, 'race-new');
  assert.strictEqual(app.attention.length, 0, 'nothing to warn about: the correction is on its way');
});

atest('a refusal of a superseded payload leaves no rejection card', async () => {
  const srv = loadServer();
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  const D = ymdDaysAgo(3);

  // An old queued item the server WILL refuse (EOD > SOD) — exactly the state
  // after typing a slip and losing signal before the drain could report it.
  const bad = dayPayload(D, 5, 'stale-bad');
  bad.counts[0].eod = 9;
  app.queue.push({ action: 'saveDay', payload: bad, tries: 0 });

  let release = null;
  let sent = 0;
  app.hooks.fetch = (url, opts) => {
    sent++;
    const reply = srv.ctx.doPost({ postData: { contents: opts.body } }).getContent();
    if (sent === 1) return new Promise(res => { release = () => res({ ok: true, text: async () => reply }); });
    return Promise.resolve({ ok: true, text: async () => reply });
  };

  const drained = app.drainQueue();
  assert.strictEqual(sent, 1, 'precondition: the bad save is on the wire');

  // She fixes the day while the refusal is still in the air.
  const fix = dayPayload(D, 8, 'stale-fix');
  app.applyLocalDay(fix);
  app.enqueue('saveDay', fix);

  release();
  await drained;

  assert.strictEqual(app.attention.length, 0,
    'the stale refusal left a permanent false "not in the sheet" card for a day the sheet HAS');
  assert.strictEqual(app.dateNotInSheet(D), false);
  assert.strictEqual(app.queue.length, 0, 'the fixed day went through behind it');
  assert.ok(!app.hooks.toasts.some(t => /Not saved/.test(t)), 'and no false refusal was announced');
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.days.find(d => d.date === D).total, 400, '8 x ₱50 is in the sheet');
});

atest('a bootstrap reply is DISCARDED when a local mutation postdates the request', async () => {
  const srv = loadServer();
  const D1 = ymdDaysAgo(6);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: dayPayload(D1, 4, 'boot-d1') }).ok, true);

  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;

  let release = null;
  app.hooks.fetch = (url, opts) => {
    const reply = srv.ctx.doPost({ postData: { contents: opts.body } }).getContent();
    return new Promise(res => { release = () => res({ ok: true, text: async () => reply }); });
  };

  const booting = app.doBootstrap();               // the snapshot request leaves…

  const D2 = ymdDaysAgo(1);                        // …and she saves a day meanwhile
  const p = dayPayload(D2, 7, 'boot-d2');
  app.applyLocalDay(p);
  app.enqueue('saveDay', p);

  release();                                       // the stale snapshot lands now
  assert.strictEqual(await booting, false, 'a stale snapshot must be discarded, not applied');
  assert.ok(app.state.days[D2],
    'the reply deleted the just-saved day off the phone — while the pill said Synced');
  assert.strictEqual(app.state.days[D2].total, 350);
  assert.ok(!app.state.days[D1], 'no part of the stale snapshot may be applied either');

  // With nothing in flight, the NEXT sync lands normally and both days stand.
  app.hooks.fetch = liveWire(srv);
  await app.drainQueue();
  assert.strictEqual(await app.doBootstrap(), true, 'a current snapshot applies fine');
  assert.ok(app.state.days[D1] && app.state.days[D2]);
  assert.strictEqual(app.state.days[D2].total, 350);
});

// --- The rest of the v2.5.0 phone fixes are synchronous ----------------------

test('deleting an expense clears its attention entries and its queued save', () => {
  const app = loadSyncClient();
  const exp = { date: ymdDaysAgo(4), category: 'Supplies', item: 'harina', amount: 300,
    backlogRef: '', notes: '', stockProduct: '', stockQty: '', entryId: 'del-exp-1' };
  app.applyLocalExpense(exp);
  app.noteAttention('rejected', 'saveExpense', exp, 'refused');
  app.queue.push({ action: 'saveExpense', payload: exp, tries: 0 });
  assert.strictEqual(app.attention.length, 1, 'precondition: the red card is up');

  app.enqueue('deleteExpense', { entryId: 'del-exp-1' });

  assert.strictEqual(app.attention.length, 0,
    'the card kept telling her to re-send an expense she has just chosen not to have');
  assert.ok(!app.queue.some(q => q.action === 'saveExpense'), 'the queued save went with it');
  assert.strictEqual(app.queue.filter(q => q.action === 'deleteExpense').length, 1);
});

test('a failed attention write is SAID out loud, never silent', () => {
  const app = loadSyncClient();
  app.hooks.storeFail = true;                      // the phone is out of storage
  app.noteAttention('rejected', 'saveDay', dayPayload(ymdDaysAgo(5), 3, 'full-1'), 'refused');
  assert.strictEqual(app.storageFull, true,
    'the attention list is the ONE copy of "this day is not in the sheet" — losing it must set the flag');
  assert.ok(app.hooks.toasts.some(t => /storage/i.test(t)),
    'a warning that cannot be persisted must be announced, not dropped');
  assert.ok(app.hooks.panels.length > 0, 'and the screen re-rendered so it shows now');
  // Storage comes back: the same write succeeds and the flag it set is its own.
  app.hooks.storeFail = false;
  assert.strictEqual(app.persistAttention(), true);
});

test('a legacy-GCash day is NOT "not in the sheet", and its card says so', () => {
  const app = loadSyncClient();
  const D = ymdDaysAgo(2);
  const legacy = { date: D, closed: false, staff: 'Mama', gcash: 450, customAmount: 0,
    customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 10, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }],
    entryId: 'legacy-1' };
  assert.strictEqual(app.isLegacyGcashPayload(legacy), true, 'precondition: the flagger sees it');
  app.noteAttention('gcash', 'saveDay', legacy, '');

  assert.strictEqual(app.dateNotInSheet(D), false,
    'a gcash note is about a day the sheet HOLDS — claiming otherwise says money is missing that is sitting right there');
  assert.deepStrictEqual(app.cutoffMissingDays({ start: D, end: D }), [],
    'and it must not badge the cutoff preview as missing days');
  const copy = app.attnCopy(app.attention[0]);
  assert.ok(!/NOT in the Google Sheet/.test(copy.why), 'the card must not claim the day is missing');
  assert.match(copy.why, /GCash for this day needs re-entering/);
  assert.match(copy.help, /counts as all cash/);

  // A real refusal still says it all, plainly.
  app.noteAttention('rejected', 'saveDay', dayPayload(D, 5, 'rej-x'), 'refused');
  assert.strictEqual(app.dateNotInSheet(D), true);
  assert.strictEqual(app.cutoffMissingDays({ start: D, end: D }).length, 1);
});

test('a stock-list change while "Stock came in" is open cannot move a typed quantity (v2.7.4)', () => {
  // The gate's STOCKIN-1: quantities resolved by INDEX at save time booked 5
  // packs typed on Flour as 5 gallons of Sauce after a Maintenance edit landed
  // mid-form. Rows carry their product NAME from the moment the form opens.
  const app = loadSyncClient();
  app.arrival = { rows: [
    { product: 'Takoyaki Flour', unit: 'pack', qty: '' },
    { product: 'Takoyaki Sauce', unit: 'gallon', qty: '' },
  ], date: '2026-08-19' };
  for (let k = 0; k < 5; k++) app.arriveStep(0, 1);
  // The list changes underneath — Flour deactivated, Sauce now index 0.
  app.state.stockItems = [{ product: 'Takoyaki Sauce', unit: 'gallon', active: true, sort: 1 }];
  app.saveArrival();
  const q = app.queue.filter(x => x.action === 'saveStockDelivery');
  assert.deepStrictEqual(q.map(x => [x.payload.product, x.payload.qty]), [['Takoyaki Flour', 5]],
    'the 5 typed on Flour must save as Flour — never slide onto Sauce');
  assert.deepStrictEqual((app.state.stockDeliveries['2026-08-19'] || []).map(r => [r.product, r.qty]),
    [['Takoyaki Flour', 5]], 'and the mirror tells the same story');
  // An all-zero form still refuses: nothing new enqueued.
  app.arrival = { rows: [{ product: 'Bonito', unit: 'bag', qty: '' }], date: '2026-08-19' };
  app.saveArrival();
  assert.strictEqual(app.queue.filter(x => x.action === 'saveStockDelivery').length, 1);
});

atest('a refused DELIVERY is not a missing day: nothing blocks the note (v2.6.0)', async () => {
  // The ship gate's QXD-1: any dated rejection used to read as "a day is not
  // in the sheet", so a refused stock delivery — no money in it at all —
  // showed the red missing-day banner, refused the note with "the note would
  // be short", and pointed at a Sales screen with nothing to fix. Every
  // pre-2.6.0 phone replaying a queued stock-carrying expense would have hit
  // this on its FIRST sync after the upgrade.
  const srv = loadServer();
  const D = ymdDaysAgo(3);
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  app.hooks.fetch = async (url, opts) => {
    const reply = srv.ctx.doPost({ postData: { contents: opts.body } }).getContent();
    return { ok: true, text: async () => reply };
  };

  // The day itself reaches the sheet.
  const day = dayPayload(D, 10, 'qxd-day');
  app.applyLocalDay(day);
  app.enqueue('saveDay', day);
  await app.drainQueue();
  assert.strictEqual(app.attention.length, 0, 'precondition: the day saved clean');

  // A delivery for a product the sheet does not know is refused by the server.
  const dlv = { date: D, product: 'Renamed Product', qty: 3, entryId: 'qxd-dlv' };
  app.applyLocalStockDelivery(dlv);
  app.enqueue('saveStockDelivery', dlv);
  await app.drainQueue();
  assert.strictEqual(app.attention.length, 1, 'the refusal lands as a red card');
  assert.strictEqual(app.attention[0].action, 'saveStockDelivery');

  const per = { start: D, end: D };
  assert.strictEqual(app.dateNotInSheet(D), false,
    'the day IS in the sheet — a refused delivery must not say otherwise');
  assert.deepStrictEqual(app.cutoffMissingDays(per), [],
    'no missing-day banner and no note block for a refusal that carries no money');
  assert.deepStrictEqual(app.cutoffMissingMoney(per), [],
    'a delivery is not money either');
  assert.match(app.daySavedMessage(D), /^Saved /,
    'the "already saved" message stays for a day the sheet holds');
  // And the note is provably not short: the server's own dryRun total matches
  // the phone's preview to the peso with the refused delivery on the list.
  const dry = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(dry.ok, true, dry.error);
  assert.strictEqual(dry.data.figures.total, app.computeCutoff(per).total);
});

test('a refused EXPENSE blocks the note as MONEY, honestly — never as a missing day', () => {
  const app = loadSyncClient();
  const D = ymdDaysAgo(2);
  // Exactly what drainQueue does with a server refusal of an expense.
  app.noteAttention('rejected', 'saveExpense', { date: D, category: 'Supplies',
    item: 'flour (unpaid)', amount: 500, backlogRef: '', notes: '', entryId: 'qxd-exp' }, 'refused');
  const per = { start: D, end: D };
  assert.strictEqual(app.dateNotInSheet(D), false, 'the DAY is not what was refused');
  assert.deepStrictEqual(app.cutoffMissingDays(per), [], 'no false missing-day claim');
  assert.strictEqual(app.cutoffMissingMoney(per).length, 1,
    'but the note must wait: the preview and the sheet disagree about this money');
  // A refused stocktake joins the delivery on the no-money side.
  app.noteAttention('rejected', 'saveStockCount', { date: D, product: 'Bonito', qty: 2,
    entryId: 'qxd-cnt' }, 'refused');
  assert.strictEqual(app.cutoffMissingMoney(per).length, 1, 'a stocktake is not money');
  assert.deepStrictEqual(app.cutoffMissingDays(per), [], 'nor a day');
  // And a refused saveDay still fires the day-missing machinery, unchanged.
  app.noteAttention('rejected', 'saveDay', dayPayload(D, 5, 'qxd-day2'), 'refused');
  assert.strictEqual(app.dateNotInSheet(D), true);
  assert.strictEqual(app.cutoffMissingDays(per).length, 1);
});

test('the note waits on refused money with its own sentence (source pins)', () => {
  // generateNote's second stop and the Cutoff screen's second banner are
  // DOM-bound, so pin the shipped source: the guard call and both sentences.
  assert.match(HTML, /const missingMoney = cutoffMissingMoney\(per\);/,
    'generateNote/renderCutoff must consult the money list');
  assert.match(HTML, /has not reached the sheet, so the note would be wrong\. Fix it from the red card under More first\./,
    'the refusal toast names money, not a missing day');
  assert.match(HTML, /An expense needs attention first/,
    'the Cutoff banner names an expense, not a missing day');
});

test('reopening a saved day shows the money it was SAVED at (client price snapshot)', () => {
  const srv = loadServer();
  const D = ymdDaysAgo(8);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 0, gcashCheeseQty: 0 }],
    entryId: 'psnap-1' } }).ok, true);
  // The owner raises the price AFTER that night was saved…
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'savePrices', payload: {
    rows: [{ sku: 'box4', price: 60, cheesePrice: 75, active: true }] } }).ok, true);

  const app = loadSyncClient();
  app.applyBootstrap(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  assert.strictEqual(app.num(app.state.prices.find(p => p.sku === 'box4').price), 60,
    'precondition: the live price list moved');

  // …the phone's own snapshot map still answers that date at ITS prices —
  // and carries the day's in_cutoff snapshot beside them (v2.5.1)…
  const stored = app.storedPricesFor(D);
  assert.deepStrictEqual(stored['box4'], { price: 50, cheese_price: 60, in_cutoff: true },
    'storedPricesFor must read the snapshot off the count rows');
  assert.deepStrictEqual(app.priceOnDay(stored, app.state.prices.find(p => p.sku === 'box4')),
    { price: 50, cheese_price: 60 });

  // …and REOPENING the day prices it at what it was saved at, not at today.
  app.loadBentaForm(D);
  const c = app.computeDay(app.bentaPayload());
  assert.strictEqual(c.total, 8 * 50 + 2 * 60,
    'the receipt re-priced a finished night at today\'s prices');
  assert.strictEqual(c.total, app.num(app.state.days[D].total), 'agreeing with the stored day to the peso');

  // A date with no snapshot — a fresh entry — prices at the current list.
  app.loadBentaForm(ymdDaysAgo(0));
  app.benta.rows.find(r => r.sku === 'box4').sod = 1;
  assert.strictEqual(app.computeDay(app.bentaPayload()).total, 60);
});

test('the phone refuses the dates the server refuses — in the server\'s own words', () => {
  const app = loadSyncClient();
  const today = clientYmd(0), tomorrow = clientYmd(1);
  assert.strictEqual(app.entryDateError(today), '');
  assert.match(app.entryDateError(tomorrow), /has not happened yet/);
  assert.match(app.entryDateError('2019-12-31'), /before 2020/);
  assert.match(app.entryDateError('0002-07-30'), /before 2020/,
    'a half-edited year-000X state must read as an error, never commit');
  assert.match(app.entryDateError('2026-07'), /not complete/);
  assert.match(app.entryDateError(''), /not complete/);

  // Byte-for-byte the sentences the real server refuses the same dates with.
  const srv = loadServer();
  const served = d => post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: dayPayload(d, 1, 'date-x') }).error;
  assert.strictEqual(app.entryDateError(tomorrow), served(tomorrow));
  assert.strictEqual(app.entryDateError('2019-12-31'), served('2019-12-31'));

  // Through the validator — and a CLOSED day cannot smuggle a bad date past it.
  app.loadBentaForm(today);
  app.benta.date = tomorrow;
  app.benta.closed = true;
  assert.match(app.validateBenta().date || '', /has not happened yet/);

  // The pickers themselves clamp to today, and the change handler snaps back
  // instead of committing a partial date (these live in DOM code, so they are
  // pinned against the source like the other screen guards).
  assert.ok(/id="bentaDate"[^>]*max="' \+ todayStr\(\) \+ '"/.test(HTML),
    'the Sales date input must carry max=today');
  assert.ok(/id="gxDate"[^>]*max="' \+ todayStr\(\) \+ '"/.test(HTML),
    'the expense date input must carry max=today');
  const onDate = slab("if (id === 'bentaDate'){", "else if (id === 'closedToggle'){");
  assert.ok(/entryDateError\(v\)/.test(onDate), 'the change handler must judge the typed date');
  assert.ok(/ev\.target\.value = benta\.date;/.test(onDate),
    'and snap back to the day it was on rather than committing the bad one');
});

test('the cutoff one-tap dates money into the period, never into the future', () => {
  const app = loadSyncClient();
  const today = clientYmd(0);
  assert.strictEqual(app.cutoffExpenseDate(app.currentPeriod(today)), today,
    'current cutoff: today');
  assert.strictEqual(app.cutoffExpenseDate({ start: '2026-01-01', end: '2026-01-15' }), '2026-01-15',
    'an earlier cutoff: its last day');
  assert.strictEqual(app.cutoffExpenseDate({ start: '2031-01-16', end: '2031-01-31' }), '',
    'a FUTURE cutoff books nothing — that date has not happened and the server refuses it');
});

test('the preview says when this phone cannot see a whole period', () => {
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.state.window_start = '2026-05-05';
  assert.strictEqual(app.previewIncomplete({ start: '2026-05-01', end: '2026-05-15' }), true,
    'a period reaching behind the stated window may be missing money');
  assert.strictEqual(app.previewIncomplete({ start: '2026-05-05', end: '2026-05-15' }), false);
  app.cfg.apiUrl = '';
  assert.strictEqual(app.previewIncomplete({ start: '2026-05-01', end: '2026-05-15' }), false,
    'demo mode has no window: this phone IS the whole archive');
  // and the Cutoff screen actually renders the warning from that one rule
  const cutoffRender = slab('function renderCutoff(){', 'async function generateNote(){');
  assert.ok(/previewIncomplete\(per\)/.test(cutoffRender), 'the screen must ask the rule');
  assert.ok(/cannot see the whole of this cutoff/.test(cutoffRender), 'and say it plainly');
});

test('fmt never prints -0', () => {
  const app = loadSyncClient();
  assert.strictEqual(app.fmt(-0), '0');
  assert.strictEqual(app.fmt(-0.004), '0',
    'rounding lands on negative zero and toLocaleString prints it as "-0"');
  assert.strictEqual(app.peso(-0.004), '₱0');
});

test('a sku or product named like an Object property cannot poison a lookup', () => {
  const app = loadSyncClient();
  app.state.counts['2026-07-01'] = [
    { date: '2026-07-01', sku: '__proto__', sod: 2, eod: 0, sold: 2, amount: 82,
      price: 41, cheese_price: '', entry_id: 'x', in_cutoff: true },
    { date: '2026-07-01', sku: 'toString', sod: 1, eod: 0, sold: 1, amount: 7,
      price: 7, cheese_price: '', entry_id: 'x', in_cutoff: true }
  ];
  const stored = app.storedPricesFor('2026-07-01');
  assert.strictEqual(stored['toString'] && stored['toString'].price, 7,
    'a name that exists on Object.prototype must not read as already-seen');
  assert.strictEqual(stored['__proto__'] && stored['__proto__'].price, 41);
  assert.strictEqual(app.priceOnDay(stored, { sku: 'toString', price: 99, cheese_price: '' }).price, 7);
  // validateBenta's error map takes hostile names too (namespaced, null-proto).
  app.loadBentaForm(clientYmd(0));
  app.benta.stock = [{ product: '__proto__', qty: 1.5, unit: 'pack' }];
  assert.match(app.validateBenta()['stock:__proto__'] || '', /whole unit/);
});

test('a half-typed row renders a receipt that still adds up to sold', () => {
  const app = loadSyncClient();
  app.loadBentaForm(clientYmd(0));
  const r = app.benta.rows.find(x => x.sku === 'box4');
  r.sod = 3; r.eod = 0; r.cheese = 2; r.gcash = 2; r.gcashCheese = 2;
  const c = app.computeDay(app.bentaPayload());
  const line = c.lines.find(l => l.sku === 'box4');
  assert.deepStrictEqual(
    [line.cheese_qty, line.gcash_qty, line.gcash_cheese_qty, line.regular_qty],
    [2, 1, 0, 0],
    'each bucket may only claim what is still unclaimed — three "clamped" buckets each judged against sold alone still listed more boxes than were sold');
  assert.strictEqual(line.cheese_qty + line.gcash_qty + line.gcash_cheese_qty + line.regular_qty,
    line.sold, 'what the receipt prints must sum to sold');
  assert.strictEqual(line.amount, 1 * 50 + 2 * 60);
  // The clamp only keeps the PREVIEW honest — the validator still refuses the save.
  assert.match(app.validateBenta()['sku:box4'] || '', /adds up to 6, but only 3 were sold/);
});

// These guards live inside DOM handlers, so they are pinned against the SOURCE
// exactly like the section-16 screen guards.
test('save day: typed work survives the tear-off, slips ask one question, error cards open', () => {
  const save = slab('function saveBenta(){', 'function prefersReduced(){');
  // f: nothing typed during the ~450ms tear-off is lost — the callback may only
  // reload a form nobody has touched since the save.
  assert.ok(/benta\.dirty = false;/.test(save), 'the save marks the form clean');
  assert.ok(/isObj\(benta\) && benta\.date === savedDate && !benta\.dirty/.test(save),
    'the tear-off callback must check dirty again before reloading the form');
  assert.ok(/updateReceipt\(\);/.test(save),
    'the kept-typing branch refreshes the receipt without touching the form');
  // f: a save with no money on it asks one plain question (it books a wage).
  assert.ok(/No sales are entered/.test(save) && /if \(!confirm\(ask\)\) return;/.test(save),
    'an all-zero save must ask before booking an empty day plus the wage');
  // f: every collapsed card holding an error opens itself before the scroll.
  assert.ok(/toggleCollapse\('stock'\)/.test(save) && /toggleCollapse\('wage'\)/.test(save),
    'a message inside a closed card is invisible');
  // f: "Closed today" over entered sales asks once, naming the money.
  const onToggle = slab("else if (id === 'closedToggle'){", 'document.addEventListener(\'focusout\'');
  assert.ok(/confirm\('This day has ' \+ peso\(money\)/.test(onToggle),
    'closing a day with sales on the form must ask, naming the amount');
  assert.ok(/ev\.target\.checked = false;/.test(onToggle), 'and a "no" leaves the day open');
});

// ---------------------------------------------------------------------------
console.log('\n--- 18. v2.5.1: the verifier round — stock reductions, queued snapshots, drains, blanks ---');

// F#1 (stock-ledger, major). The old "carry floor" topped the phone's local sums
// back up to the server's whole-history totals, so every LOCAL REDUCTION — a
// corrected usage, a re-closed day, a deleted delivery — was silently undone
// until the next full bootstrap. The floor is DELETED: bootstrap now ships the
// pre-window parts (delivered_before/used_before) and the phone adds its own
// in-window rows, so its mirror is the truth for everything it can see.
test('a local stock reduction moves on-hand at once — the carry floor is gone (v2.5.1)', () => {
  const srv = loadServer();
  const D = ymdDaysAgo(6);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Takoyaki Flour', unit: 'pack', reorderAt: 2, active: true }] } }).ok, true);
  // Goods arrive through their OWN door now (v2.6.0) — no money anywhere on it.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockDelivery', payload: {
    date: D, product: 'Takoyaki Flour', qty: 6, entryId: 'st-deliv' } }).ok, true);
  const day = { date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [], stock: [{ product: 'Takoyaki Flour', qty: 5 }], entryId: 'st-day' };
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: day }).ok, true);

  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const flour = () => app.stockStatusList().find(s => s.product === 'Takoyaki Flour');
  assert.strictEqual(flour().on_hand, 1, 'precondition: 0 + 6 delivered − 5 opened');

  // (a) a usage typo corrected 5 -> 2: three packs come straight back.
  app.applyLocalDay(Object.assign({}, day, { stock: [{ product: 'Takoyaki Flour', qty: 2 }] }));
  assert.strictEqual(flour().on_hand, 4,
    'the corrected figure was topped back up to the server total — the reduction never landed on screen');
  assert.strictEqual(flour().used_since, 2, 'and the card explains it with the corrected figure');

  // (b) the day re-saved Closed returns its units.
  app.applyLocalDay(Object.assign({}, day, { closed: true }));
  assert.strictEqual(flour().on_hand, 6, 'a closed day opened nothing');

  // (c) the delivery retyped (same entryId) counts at its corrected size, and
  // the low warning fires on the corrected figure NOW — not at the next
  // bootstrap — and clears again when the correction says it no longer holds.
  const deliv = qty => app.applyLocalStockDelivery({ date: D, product: 'Takoyaki Flour', qty,
    entryId: 'st-deliv' });
  deliv(1);
  assert.strictEqual(flour().on_hand, 1, '6 retyped as 1: five packs leave the shelf at once');
  assert.strictEqual(flour().low, true,
    'reorder point 2: the warning must fire on the corrected figure, not wait for the next bootstrap');
  deliv(40);
  assert.strictEqual(flour().on_hand, 40, '40 mistyped');
  deliv(4);
  assert.strictEqual(flour().on_hand, 4, 'retyped as 4: the mirror is the truth');
  assert.strictEqual(flour().low, false, 'a false low must clear with the correction');

  // (d) a LEGACY expense-attached delivery this phone still holds: deleting
  // that expense takes its quantity off the shelf the moment the row goes.
  app.state.expenses['st-legacy'] = { date: D, category: 'Supplies', item: 'harina (legacy)',
    amount: 600, backlog_ref: '', notes: '', entry_id: 'st-legacy', updated_at: '',
    stock_product: 'Takoyaki Flour', stock_qty: 3 };
  assert.strictEqual(flour().on_hand, 7, 'the legacy row still counts into on-hand');
  app.applyLocalDeleteExpense({ entryId: 'st-legacy' });
  assert.strictEqual(flour().on_hand, 4, 'a deleted legacy delivery must leave the shelf');
});

test('deliveries older than the bootstrap window still count — split out, never topped up (v2.5.1)', () => {
  const srv = loadServer();
  const OLD = ymdDaysAgo(120);                      // strictly before window_start
  const D = ymdDaysAgo(4);
  // BOTH pre-window doors: a v2.6.0 StockDeliveries row, and a legacy
  // expense-attached row — hand-placed, because saveExpense refuses new ones —
  // that must keep counting forever.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockDelivery', payload: {
    date: OLD, product: 'Takoyaki Flour', qty: 10, entryId: 'old-deliv' } }).ok, true);
  srv.ctx.appendObjects(srv.ss, 'Expenses', [{
    date: OLD, category: 'Supplies', item: 'harina (legacy)', amount: 500,
    backlog_ref: '', notes: '', entry_id: 'old-legacy', updated_at: OLD + ' 09:00:00',
    stock_product: 'Takoyaki Flour', stock_qty: 5 }]);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [], stock: [{ product: 'Takoyaki Flour', qty: 3 }], entryId: 'st-day2' } }).ok, true);

  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const item = boot.data.stockItems.find(x => x.product === 'Takoyaki Flour');
  assert.strictEqual(item.delivered_before, 15, 'the pre-window part of BOTH doors must ship split out');
  assert.strictEqual(item.used_before, 0, 'the usage is inside the window');
  assert.strictEqual(item.on_hand, 12, 'the server counts the whole history');
  assert.ok(!boot.data.stockDeliveries.some(e => e.entry_id === 'old-deliv'),
    'precondition: the old delivery is OUTSIDE the snapshot — the phone cannot see its row');
  assert.ok(!boot.data.expenses.some(e => e.entry_id === 'old-legacy'),
    'precondition: the legacy row is OUTSIDE the snapshot too');

  const app = syncedClient(boot.data);
  const onHand = () => app.stockStatusList().find(s => s.product === 'Takoyaki Flour').on_hand;
  assert.strictEqual(onHand(), 12,
    'delivered_before + the phone\'s own in-window rows must reach the server figure — counted once');

  // A phone that still HOLDS those pre-window rows (kept local history from an
  // earlier, wider snapshot) must not count them twice — both are already
  // inside delivered_before.
  app.state.stockDeliveries[OLD] = [{ date: OLD, product: 'Takoyaki Flour', qty: 10,
    entry_id: 'old-deliv', updated_at: '' }];
  app.state.expenses['old-legacy'] = { date: OLD, category: 'Supplies', item: 'harina (legacy)',
    amount: 500, backlog_ref: '', notes: '', entry_id: 'old-legacy', updated_at: '',
    stock_product: 'Takoyaki Flour', stock_qty: 5 };
  assert.strictEqual(onHand(), 12,
    'pre-window rows this phone kept are already inside delivered_before — once, not twice');

  // A NEWER local stocktake re-baselines: the pre-window parts are already
  // inside the counted figure, so they must NOT be added a second time.
  app.applyLocalStockCount({ date: ymdDaysAgo(2), product: 'Takoyaki Flour', qty: 9, entryId: 'st-cnt' });
  assert.strictEqual(onHand(), 9,
    'a local count is an end-of-day truth — nothing before it may be re-added');
});

// F#15 repro B (money-arithmetic, major). A night entered offline is priced by
// the phone at the prices ON SCREEN; if the queued save only reaches the sheet
// after a Maintenance price change, the sheet must still book the money that is
// physically in the tin. The payload now carries the displayed snapshot and the
// server uses it for a sku's first row on the date.
atest('a save queued through a price change lands at the money the tin showed (v2.5.1)', async () => {
  const srv = loadServer();
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  app.applyBootstrap(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);

  const D = ymdDaysAgo(1);
  app.loadBentaForm(D);
  const row = app.benta.rows.find(r => r.sku === 'box4');
  row.sod = 10; row.cheese = 2;
  const shown = app.computeDay(app.bentaPayload());
  assert.strictEqual(shown.total, 520, 'precondition: the receipt and the tin said ₱520 (8×50 + 2×60)');
  const payload = Object.assign(app.bentaPayload(), { entryId: 'queued-night' });
  const sent = payload.counts.find(c => c.sku === 'box4');
  assert.deepStrictEqual([sent.price, sent.cheesePrice, sent.inCutoff], [50, 60, true],
    'the payload must carry the DISPLAYED snapshot, camelCase like every request key');
  app.applyLocalDay(payload);
  app.enqueue('saveDay', payload);                  // offline: it just sits queued

  // The owner raises the prices while that save is still in the queue.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box4', price: 60, cheesePrice: 70, active: true }] } }).ok, true);

  app.hooks.fetch = liveWire(srv);
  await app.drainQueue();
  assert.strictEqual(app.queue.length, 0, 'the night must land');

  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.data.days.find(d => d.date === D).total, 520,
    'the sheet booked the night at the NEW prices — ₱100 more than is physically in the tin, with nothing said');
  const line = boot.data.counts.find(c => c.date === D && c.sku === 'box4');
  assert.strictEqual(line.price, 50, 'the stored snapshot is the price the night was SOLD at');
  assert.strictEqual(line.cheese_price, 60);
  // And the phone's own mirror agrees after the drain's refresh.
  assert.strictEqual(app.state.days[D].total, 520);
  // A fresh night after the change prices at the new list, as it should.
  const fresh = post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: dayPayload(ymdDaysAgo(0), 1, 'fresh-night') });
  assert.strictEqual(fresh.data.total, 60);
});

// F#16 (money-arithmetic, major). Flipping "Counts in the cutoff" must never
// move an already-saved day's money between the cutoff and the excluded block —
// on the Sales screen, on the Cutoff screen, or in the sheet via a re-save.
atest('flipping "Counts in the cutoff" cannot move a saved day — one story everywhere (v2.5.1)', async () => {
  const srv = loadServer();
  const D = ymdDaysAgo(2);
  const day = { date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [
      { sku: 'box4', sod: 10, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 },
      { sku: 'nori', sod: 8, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }
    ], entryId: 'flip-day' };
  const saved = post(srv.ctx, { token: srv.token, action: 'saveDay', payload: day });
  assert.strictEqual(saved.data.total, 500, 'precondition: box4 counted');
  assert.strictEqual(saved.data.excluded_total, 200, 'precondition: nori kept out');

  // The owner flips nori INTO the cutoff, after the night was saved.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'savePrices',
    payload: { rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: true }] } }).ok, true);

  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  app.applyBootstrap(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);

  // SALES screen: the loaded day still reads ₱500 counted + ₱200 kept out.
  app.loadBentaForm(D);
  const c = app.computeDay(app.bentaPayload());
  assert.strictEqual(c.total, 500,
    'the Sales screen re-classified a saved night by the LIVE flag — it said ₱700 while the Cutoff screen said ₱500');
  assert.strictEqual(c.excluded, 200);
  // CUTOFF screen: the same story.
  const per = app.currentPeriod(D);
  const f = app.computeCutoff(per);
  assert.strictEqual(f.total, 500);
  assert.strictEqual(f.excluded, 200);

  // A note-only re-save writes the SAME classification back to the sheet.
  app.benta.notes = 'left the light on';
  const resave = Object.assign(app.bentaPayload(), { entryId: 'flip-day' });
  assert.strictEqual(resave.counts.find(x => x.sku === 'nori').inCutoff, false,
    'the payload carries the day\'s own snapshot, not the live flag');
  app.applyLocalDay(resave);
  app.enqueue('saveDay', resave);
  app.hooks.fetch = liveWire(srv);
  await app.drainQueue();
  const after = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const sheetDay = after.data.days.find(d => d.date === D);
  assert.strictEqual(sheetDay.total, 500,
    'a note-only re-save moved ₱200 into a cutoff figure that may already have been sent');
  assert.strictEqual(sheetDay.excluded_total, 200);
  // An OLD build's queued re-save carries no snapshot keys at all — the sheet's
  // own stored snapshot must still win over the live flag.
  const plain = post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: Object.assign({}, day, { notes: 'sent by a v2.5.0 phone' }) });
  assert.strictEqual(plain.ok, true, plain.error);
  assert.strictEqual(plain.data.total, 500,
    'a legacy re-save payload re-classified the night by the live flag');
  assert.strictEqual(plain.data.excluded_total, 200);
  // Tonight — a date with no stored rows — the flip applies, as it should.
  const fresh = post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: ymdDaysAgo(0), closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'nori', sod: 4, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }],
    entryId: 'fresh-nori' } });
  assert.strictEqual(fresh.data.total, 100, 'a NEW day counts nori in — that is what the flip is for');
  assert.strictEqual(fresh.data.excluded_total, 0);

  // The other direction — the old dead end: a night saved while nori counted IN
  // (with a GCash bucket) keeps its buckets and its money after nori is
  // excluded. No refusal, no stepper dance, nothing moves.
  const srv2 = loadServer();
  assert.strictEqual(post(srv2.ctx, { token: srv2.token, action: 'savePrices',
    payload: { rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: true }] } }).ok, true);
  const D2 = ymdDaysAgo(3);
  const inDay = post(srv2.ctx, { token: srv2.token, action: 'saveDay', payload: {
    date: D2, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'nori', sod: 6, eod: 0, cheeseQty: 0, gcashQty: 2, gcashCheeseQty: 0 }],
    entryId: 'in-day' } });
  assert.strictEqual(inDay.data.total, 150, 'precondition: nori counted in, 6 × 25');
  assert.strictEqual(inDay.data.gcash, 50);

  // A queued FIRST save crosses the flip too: this phone entered a night while
  // its price list still said nori counts IN (with a GCash bucket), and the
  // flip lands before its queued save does. The payload's own flag must win —
  // judged by the live flag the server would REFUSE the bucket and bounce a
  // legitimately sold night into a rejection card.
  const app3 = loadSyncClient();
  app3.cfg.apiUrl = 'https://api.example/exec';
  app3.cfg.token = srv2.token;
  app3.applyBootstrap(post(srv2.ctx, { token: srv2.token, action: 'bootstrap', payload: {} }).data);
  const D3 = ymdDaysAgo(1);
  app3.loadBentaForm(D3);
  const n3 = app3.benta.rows.find(r => r.sku === 'nori');
  n3.sod = 5; n3.gcash = 2;
  const queued3 = Object.assign(app3.bentaPayload(), { entryId: 'queued-in-day' });
  assert.strictEqual(queued3.counts.find(x => x.sku === 'nori').inCutoff, true,
    'precondition: the payload snapshots what the screen showed');

  // NOW the owner takes nori out of the cutoff…
  assert.strictEqual(post(srv2.ctx, { token: srv2.token, action: 'savePrices',
    payload: { rows: [{ sku: 'nori', price: 25, cheesePrice: 0, active: true, inCutoff: false }] } }).ok, true);

  // …and the queued night lands AFTER the flip, telling the story it was sold in.
  const landed3 = post(srv2.ctx, { token: srv2.token, action: 'saveDay', payload: queued3 });
  assert.strictEqual(landed3.ok, true,
    'the live flag refused a night sold while nori counted in: ' + landed3.error);
  assert.strictEqual(landed3.data.total, 125, '5 × 25 in the total, as the receipt showed');
  assert.strictEqual(landed3.data.gcash, 50, 'the GCash she actually took stays in the GCash figure');
  assert.strictEqual(landed3.data.lines.find(l => l.sku === 'nori').in_cutoff, true,
    'and the row snapshots the flag the night was sold under');
  const app2 = loadSyncClient();
  app2.cfg.apiUrl = 'https://api.example/exec';
  app2.cfg.token = srv2.token;
  app2.applyBootstrap(post(srv2.ctx, { token: srv2.token, action: 'bootstrap', payload: {} }).data);
  app2.loadBentaForm(D2);
  // The silent-zero rule follows the DAY's flag too: nori counts IN for this
  // day, and a simple sku counting in has no cheese version — a stray draft
  // figure is sent as 0, exactly what the server will accept.
  const noriRow = app2.benta.rows.find(r => r.sku === 'nori');
  noriRow.cheese = 1;
  assert.strictEqual(app2.bentaPayload().counts.find(x => x.sku === 'nori').cheeseQty, 0,
    'a stray cheese figure on a simple sku counting IN must be sent as 0 — judged by the day\'s flag');
  noriRow.cheese = 0;
  assert.deepStrictEqual(Object.keys(app2.validateBenta()), [],
    'the phone refused a day the server accepts — the excluded-nori dead end again');
  const re = post(srv2.ctx, { token: srv2.token, action: 'saveDay',
    payload: Object.assign(app2.bentaPayload(), { entryId: 'in-day' }) });
  assert.strictEqual(re.ok, true, 'the re-save must land: ' + re.error);
  assert.strictEqual(re.data.total, 150, 'its money stays IN the cutoff, where it was saved');
  assert.strictEqual(re.data.gcash, 50, 'its GCash bucket stays too');
});

// F#22 (offline-queue, major). A backlog payment that DRAINED successfully was
// counted nowhere: no longer queued (so no local subtraction) and not in the
// stale server balance. The drain now re-bootstraps after anything lands.
atest('a drained backlog payment stays subtracted — the drain re-bootstraps (v2.5.1)', async () => {
  const srv = loadServer();
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  app.hooks.fetch = liveWire(srv);
  assert.strictEqual(await app.doBootstrap(), true);

  const bl = app.state.backlogs.find(b => b.name === 'Deposit Ilog Mama');
  assert.ok(bl && app.num(bl.total_amount) === 10000, 'precondition: the seeded ₱10,000 backlog');
  assert.strictEqual(app.backlogBalance(bl), 10000);

  const D = ymdDaysAgo(1);
  for (let i = 1; i <= 4; i++){
    const p = { date: D, category: 'Backlog', item: 'hulog ' + i, amount: 1000,
      backlogRef: 'Deposit Ilog Mama', notes: '', stockProduct: '', stockQty: '',
      entryId: 'blg-' + i };
    app.applyLocalExpense(p);
    app.enqueue('saveExpense', p);
  }
  assert.strictEqual(app.backlogBalance(app.state.backlogs.find(b => b.name === 'Deposit Ilog Mama')),
    6000, 'while QUEUED the payments are subtracted locally');

  await app.drainQueue();
  assert.strictEqual(app.queue.length, 0, 'all four payments landed');
  const fresh = app.state.backlogs.find(b => b.name === 'Deposit Ilog Mama');
  assert.strictEqual(app.num(fresh.balance), 6000,
    'the drain must refresh the server-computed balance in the SAME sync');
  assert.strictEqual(app.backlogBalance(fresh), 6000,
    'four drained payments read as if they never happened until the next app start');
});

// F#31 (config-writers, major). A cleared "Wage per day" travelled as ₱0 (num('')
// is 0) and silently wrote daily_salary = 0 — every later day snapshotted a ₱0
// wage and Remaining was overstated by a day's wage at a time. Blank fields are
// now OMITTED from the payload entirely; an explicit 0 must be typed.
test('a cleared "Wage per day" never writes ₱0 — blank means unchanged (v2.5.1)', () => {
  const app = loadSyncClient();
  const cleared = app.maintSettingsPayload({ daily_salary: '', split_default: 4000,
    mama_per_cutoff: '', electric_per_cutoff: 500, branch: 'Tañong', staff: '' });
  assert.deepStrictEqual(cleared, { branch: 'Tañong', split_default: 4000, electric_per_cutoff: 500 },
    'a blank field must be OMITTED — not sent as 0, not sent as ""');
  assert.strictEqual(app.maintSettingsPayload({ daily_salary: 0, branch: 'Tañong' }).daily_salary, 0,
    'an explicit 0 is a figure ("nobody is paid") and travels');
  assert.strictEqual(app.maintSettingsPayload({ daily_salary: '0', branch: 'Tañong' }).daily_salary, 0,
    'typed as text too');
  // The screen must actually build its payload from that one rule (DOM code ->
  // source pin, like the other screen guards).
  const save = slab('function saveMaintSettings(){', 'function saveMaintStock(){');
  assert.ok(/maintSettingsPayload\(maintConst\)/.test(save),
    'saveMaintSettings must send maintSettingsPayload(maintConst), nothing hand-rolled');

  // End to end: the cleared field reaches the server as NO key at all, so the
  // next day still snapshots the standing rate.
  const srv = loadServer();
  const r = post(srv.ctx, { token: srv.token, action: 'saveSettings',
    payload: { settings: cleared, entryId: 'wage-clear' } });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.data.saved.indexOf('daily_salary') === -1, 'daily_salary must not be written');
  const dayR = post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: dayPayload(ymdDaysAgo(1), 2, 'wage-day') });
  assert.strictEqual(dayR.data.salary, 200,
    'clear-then-save costed the wage: the next saved day snapshotted ₱0');
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} })
    .data.settings.daily_salary, 200, 'the sheet keeps its figure');
});

// F#8 residual (new_defects #1). When the server REFUSES the note, the phone
// must not build its own copy — the local note would contain exactly the line
// the refusal exists to prevent ("Supplies - -400"). Demo/offline apply the
// same refusal before building anything.
test('a refused note is refused on the phone too — no local fallback, no Copy/Share (v2.5.1)', () => {
  const srv = loadServer();
  const D = ymdDaysAgo(3);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: dayPayload(D, 10, 'neg-day') }).ok, true);
  // Only a hand-edited row can be negative (saveExpense refuses ≤ 0), so edit
  // the sheet by hand exactly as the finding did.
  srv.ss.getSheetByName('Expenses').appendRow(
    [D, 'Supplies', 'refund', -500, '', '', 'neg-x', '2026-08-01T00:00:00', '', '']);

  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const per = app.currentPeriod(D);
  const served = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: false } });
  assert.strictEqual(served.ok, false, 'precondition: the server refuses the note');
  assert.match(served.error, /adds up to less than zero/);

  assert.strictEqual(app.noteRefusal(per), served.error,
    'the phone must refuse its OWN copy in the server\'s sentence, byte for byte');
  assert.strictEqual(app.noteRefusal({ start: '2020-01-01', end: '2020-01-15' }), '',
    'a clean period builds normally');
  // and the phone note it would otherwise have built is exactly the artifact
  // the refusal names — proof the local guard is load-bearing, not decoration.
  assert.match(app.buildNote(app.computeCutoff(per), per), /Supplies \(minor\) - -500/);

  // generateNote wires both stops (it renders, so: source pins).
  const gen = slab('async function generateNote(){', 'async function copyNote(){');
  const srvStop = gen.indexOf('if (err && err.server)');
  assert.ok(srvStop !== -1, 'a server refusal must be shown and STOP — no fallback note');
  assert.ok(srvStop < gen.indexOf('Showing the copy from this phone'),
    'checked BEFORE the network-trouble fallback can offer a local copy');
  const localGuard = gen.indexOf('noteRefusal(per)');
  assert.ok(localGuard !== -1 && localGuard < gen.lastIndexOf('demo:true'),
    'the demo/offline note must apply the same refusal before it is built');
});

// The cosmetic third new_defect: a refused split was toasted as "refused an
// expense", sending her to the wrong screen's entries.
atest('a refused split is announced as a split, not an expense (v2.5.1)', async () => {
  const srv = loadServer();
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  app.hooks.fetch = liveWire(srv);
  app.enqueue('saveCutoffSplit', { start: '2026-07-16', end: '2026-07-31',
    amount: 3000.01, entryId: 'split-centavos' });
  await app.drainQueue();
  assert.strictEqual(app.attention.length, 1, 'the refusal must card');
  assert.strictEqual(app.attention[0].action, 'saveCutoffSplit');
  const toasts = app.hooks.toasts.join(' | ');
  assert.match(toasts, /refused the split/, 'the toast must name the split');
  assert.ok(!/refused an expense/.test(toasts),
    'a split refusal announced as "an expense" sends her hunting through the wrong screen');
});

// ===========================================================================
// 19. v2.7.0 across the seam: converted cash, lid boxes, special-order boxes,
// the SOD prefill, the collapsed GCash card and the display-only cash recap.
//
// One night with every new figure on it. Box 4: sold 10, cheese 2, GCash 1,
// 3 boxes into the special order -> regular 4, amount (4+1)*50 + 2*60 = 370.
// Custom order 500 of which 100 GCash; ₱120 of tin cash converted; 4 lid boxes.
// TOTAL 870,  GCash 50 + 100 + 120 = 270,  Cash 600.
// ===========================================================================
console.log('\n--- 19. v2.7.0 across the seam: converted cash, special orders, prefill ---');

const V27_DAY = ymdDaysAgo(2);
const V27_PAYLOAD = {
  date: V27_DAY, closed: false, staff: 'Mama',
  customAmount: 500, customGcash: 100,
  gcashConverted: 120, lidBoxes: 4,
  customBoxes: [{ sku: 'box4', qty: 3 }],
  notes: '', counts: [
    { sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 1, gcashCheeseQty: 0 }
  ],
  entryId: 'v27-day-1'
};
function v27Fixture() {
  const srv = loadServer();
  const save = post(srv.ctx, { token: srv.token, action: 'saveDay', payload: V27_PAYLOAD });
  assert.strictEqual(save.ok, true, save.error);
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  assert.strictEqual(boot.ok, true, boot.error);
  return { srv, save: save.data, boot: boot.data };
}

test('the new figures survive the whole seam: reply, bootstrap, form, payload, preview', () => {
  const { srv, save, boot } = v27Fixture();
  assert.strictEqual(save.total, 870);
  assert.strictEqual(save.gcash, 270, 'sku 50 + custom 100 + converted 120');
  assert.strictEqual(save.cash, 600);
  assert.strictEqual(save.gcash_converted, 120);
  assert.strictEqual(save.lid_boxes, 4);
  const line = save.lines.find(l => l.sku === 'box4');
  assert.strictEqual(line.custom_qty, 3);
  assert.strictEqual(line.regular_qty, 4, '10 − 3 paid − 3 custom');
  assert.strictEqual(line.amount, 370, 'the order\'s boxes carry NO menu-price money');
  assertNoCamelKeys('saveDay', save);

  // Into the phone's mirror through the real normalizers...
  const app = syncedClient(boot);
  const day = app.state.days[V27_DAY];
  assert.strictEqual(day.gcash_converted, 120);
  assert.strictEqual(day.lid_boxes, 4);
  assert.strictEqual((app.state.counts[V27_DAY] || []).find(r => r.sku === 'box4').custom_qty, 3);

  // ...back onto the form...
  app.loadBentaForm(V27_DAY);
  assert.strictEqual(app.num(app.benta.gcashConverted), 120);
  assert.strictEqual(app.num(app.benta.lidBoxes), 4);
  assert.strictEqual(app.num(app.benta.rows.find(r => r.sku === 'box4').custom), 3);
  assert.strictEqual(app.benta.gcashOpen, true, 'a day holding GCash figures opens the card');

  // ...out as the same camelCase request...
  const payload = app.bentaPayload();
  assert.strictEqual(payload.gcashConverted, 120);
  assert.strictEqual(payload.lidBoxes, 4);
  assert.deepStrictEqual(payload.customBoxes, [{ sku: 'box4', qty: 3 }],
    'only rows holding a figure travel');

  // ...priced identically by the phone's own preview...
  const c = app.computeDay(payload);
  assert.strictEqual(c.total, save.total);
  assert.strictEqual(c.gcash, save.gcash);
  assert.strictEqual(c.cash, save.cash);
  assert.strictEqual(c.gcashConverted, 120);
  assert.strictEqual(c.lidBoxes, 4);
  const cl = c.lines.find(l => l.sku === 'box4');
  assert.strictEqual(cl.custom_qty, 3);
  assert.strictEqual(cl.regular_qty, 4);
  assert.strictEqual(cl.amount, 370);

  // ...and accepted back by the real server at the same money (a re-save).
  payload.entryId = 'v27-resave';
  const r2 = post(srv.ctx, { token: srv.token, action: 'saveDay', payload });
  assert.strictEqual(r2.ok, true, r2.error);
  ['total', 'cash', 'gcash', 'gcash_converted', 'lid_boxes', 'excluded_total'].forEach(k => {
    assert.strictEqual(r2.data[k], save[k], k + ' moved on a no-change re-save');
  });
  assert.deepStrictEqual(r2.data.lines.find(l => l.sku === 'box4'), line);
});

test('normDay/normCount read the new keys snake-first, legacy camelCase second, blank as 0', () => {
  const app = loadClient();
  assert.strictEqual(app.normDay({ date: V27_DAY, gcash_converted: 120, lid_boxes: 4 }).gcash_converted, 120);
  assert.strictEqual(app.normDay({ date: V27_DAY, gcash_converted: 120, lid_boxes: 4 }).lid_boxes, 4);
  // An older still-deployed server may answer camelCase; money must not zero.
  const legacy = app.normDay({ date: V27_DAY, gcashConverted: 120, lidBoxes: 4 });
  assert.strictEqual(legacy.gcash_converted, 120);
  assert.strictEqual(legacy.lid_boxes, 4);
  // A day saved before the columns existed carries neither key: 0, never NaN.
  const old = app.normDay({ date: V27_DAY, total: 500 });
  assert.strictEqual(old.gcash_converted, 0);
  assert.strictEqual(old.lid_boxes, 0);
  assert.strictEqual(app.normCount({ date: V27_DAY, sku: 'box4', custom_qty: 3 }).custom_qty, 3);
  assert.strictEqual(app.normCount({ date: V27_DAY, sku: 'box4', customQty: 3 }).custom_qty, 3);
  assert.strictEqual(app.normCount({ date: V27_DAY, sku: 'box4' }).custom_qty, 0);
});

test('GIVEN AWAY OR RUINED: what left the tray unpaid is not revenue (v2.10.1)', () => {
  // Owner, 2026-08-28: takoyaki does get given away and does get ruined. `sold`
  // is sod − eod, which is what left the TRAY — so every freebie and every
  // dropped box was booked at full menu price. Money the app claimed and the
  // tin never saw, and it flattered the cost per ball too.
  const srv = loadServer();
  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const D = ymdDaysAgo(2);
  app.loadBentaForm(D);
  const box4 = app.benta.rows.find(r => r.sku === 'box4');
  box4.sod = 10; box4.eod = 0;                 // ten left the tray
  const priceOf = Number(app.computeDay(app.bentaPayload()).lines.find(l => l.sku === 'box4').price);
  assert.ok(priceOf > 0, 'precondition: box4 has a price');

  // All ten paid for: the honest baseline.
  const allPaid = Number(app.computeDay(app.bentaPayload()).total);
  assert.strictEqual(allPaid, 10 * priceOf);

  // Two given away. The tray still emptied by ten — but only eight were paid.
  box4.free = 2;
  const c = app.computeDay(app.bentaPayload());
  const line = c.lines.find(l => l.sku === 'box4');
  assert.strictEqual(line.sold, 10, '`sold` still means what LEFT THE TRAY');
  assert.strictEqual(line.free_qty, 2, 'and the row says how many were never paid for');
  assert.strictEqual(line.regular_qty, 8, 'only eight are priced');
  assert.strictEqual(Number(c.total), 8 * priceOf, 'the two given away add NO money');

  // The receipt says it out loud, so the tin can be reconciled by eye.
  const rec = app.cashRecapHTML(c);
  assert.ok(/8 regular/.test(rec), 'the recap prices eight: ' + rec);

  // THE SEAM: the server must agree to the peso, and store the snapshot.
  const payload = app.bentaPayload();
  assert.strictEqual(payload.counts.find(x => x.sku === 'box4').freeQty, 2,
    'the request carries it camelCase');
  const r = post(srv.ctx, { token: srv.token, action: 'saveDay', payload:
    Object.assign({}, payload, { entryId: 'free-1' }) });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.total, 8 * priceOf, 'the SHEET agrees to the peso');
  const sline = r.data.lines.find(l => l.sku === 'box4');
  assert.strictEqual(sline.free_qty, 2, 'the response is snake_case and carries the snapshot');
  assert.strictEqual(sline.sold, 10, 'and `sold` is untouched — the tray did empty');
  assert.strictEqual(sline.regular_qty, 8);

  // Reopening the day must show the give-away again, not silently drop it.
  app.applyBootstrap(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  app.loadBentaForm(D);
  assert.strictEqual(Number(app.benta.rows.find(x => x.sku === 'box4').free), 2,
    'a reopened night remembers what was given away');
  assert.strictEqual(Number(app.computeDay(app.bentaPayload()).total), 8 * priceOf,
    're-derived from the reopened form, to the peso');

  // THE PHONE REFUSES FIRST. The server would reject an impossible figure, but
  // a phone that stayed quiet would queue a night that can never land — and the
  // refusal has to arrive in the server's own words, beside its own stepper.
  const b2 = app.benta.rows.find(r => r.sku === 'box4');
  b2.sod = 10; b2.eod = 8; b2.free = 5;
  let errs = app.validateBenta();
  assert.match(String(errs['free:box4']),
    /5 given away or ruined, but only 2 left the tray/,
    'the phone says it, in the words the sheet would have used');
  b2.free = 1.5;
  assert.match(String(app.validateBenta()['free:box4']), /whole number/, 'and refuses a fraction');
  b2.free = -1;
  assert.match(String(app.validateBenta()['free:box4']), /cannot be negative/);
  // Its own slot, so the complaint appears under its own stepper rather than
  // blaming the counts.
  b2.sod = 10; b2.eod = 8; b2.free = 5;
  const both = app.validateBenta();
  assert.ok(!both['sku:box4'],
    'a give-away mistake must not be reported as a counting mistake: ' + JSON.stringify(both));
  b2.sod = 10; b2.eod = 0; b2.free = 2;
  assert.deepStrictEqual(Object.keys(app.validateBenta()).filter(k => app.validateBenta()[k]), [],
    'and the honest figure clears');

  // THE COSTING STILL COUNTS EVERY BALL MADE: a ball given away ate its
  // ingredients exactly like a sold one, so cost per ball must not shrink.
  const per = app.currentPeriod(D);
  const cost = post(srv.ctx, { token: srv.token, action: 'costing',
    payload: { start: per.start, end: per.end } });
  assert.strictEqual(cost.ok, true, cost.error);
  assert.strictEqual(cost.data.balls, 10 * 4,
    'all ten boxes of four were MADE — free ones cost the same to make');
});

test('ASKED AT THE SAVE, every night, and only when it is empty (v2.13.0)', () => {
  // Owner's own design, after losing a fortnight to it: "check if she logs used
  // supplies, if yes then no need for nudging, if no logs for the supplies, only
  // then we need the nudge." So the question is asked at the SAVE, on the night
  // being saved — not five nights later.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const D = ymdDaysAgo(1);
  app.loadBentaForm(D);
  const pay = () => app.bentaPayload();

  // Nothing logged: it asks.
  assert.strictEqual(app.logsNoSupplies(pay()), true, 'an empty stock card is asked about');

  // SHE LOGGED SOMETHING: no question at all. This is the whole point — the
  // nudge must cost nothing on a night she did the job.
  const row = app.benta.stock[0];
  assert.ok(row, 'precondition: there is a product to log');
  row.qty = 1;
  assert.strictEqual(app.logsNoSupplies(pay()), false, 'a logged figure ends the matter');

  // A logged ZERO is not a figure. A stepper left at 0 is the absence of an
  // answer, exactly as it is everywhere else in this app.
  row.qty = 0;
  assert.strictEqual(app.logsNoSupplies(pay()), true, 'zero is not "she logged it"');
  // ...and asserted DIRECTLY too, because bentaPayload already drops zero rows
  // before they travel — so through the payload alone the `> 0` test is
  // unobservable, and an untested guard is the kind that quietly rots.
  assert.strictEqual(app.logsNoSupplies({ closed: false, stock: [{ product: 'Takoyaki Flour', qty: 0 }] }),
    true, 'a zero row reaching this function directly is still "nothing logged"');
  assert.strictEqual(app.logsNoSupplies({ closed: false, stock: [{ product: 'Takoyaki Flour', qty: 2 }] }),
    false, 'and a real figure is still a figure');

  // A CLOSED night opened nothing, so asking would be nonsense.
  app.benta.closed = true;
  assert.strictEqual(app.logsNoSupplies(pay()), false, 'a closed night is never asked');
  app.benta.closed = false;

  // A phone with NOTHING ACTIVE on its stock list cannot answer the question, so
  // it is not put. Reached by switching every product off under Maintenance —
  // emptying the list outright is NOT reachable, because an empty list falls
  // back to the seeds by design ("the stock card is never blank").
  const bare = loadClient();
  bare.applyBootstrap(F.boot);
  bare.state.stockItems.forEach(x => { x.active = false; });
  bare.loadBentaForm(D);
  assert.strictEqual(bare.logsNoSupplies(bare.bentaPayload()), false,
    'nothing active means no question');
});

test('SOURCE PIN: the save asks about supplies, once, and never refuses (v2.13.0)', () => {
  const save = slab('function saveBenta(){', 'function prefersReduced(){');

  // Wired into the SAVE path, gated on the payload actually being empty.
  assert.match(save, /else if \(logsNoSupplies\(p\)\)\{/,
    'the question is asked at the save, on the payload being saved');
  // ...as an ELSE of the no-sales question, so a night with nothing on it gets
  // ONE dialog rather than two in a row.
  const noSales = save.indexOf('No sales are entered for');
  const supplies = save.indexOf('logsNoSupplies(p)');
  assert.ok(noSales > 0 && supplies > noSales,
    'it comes after the no-sales question, as its else — two dialogs in a row is how both stop being read');

  // HER WORD IS FINAL: one confirm, and a no simply returns.
  assert.match(save, /if \(!confirm\(ask\)\) return;[\s\S]{0,80}\}\n  \}/,
    'a refusal returns without saving; there is no second ask and no override');
  assert.ok(!/logsNoSupplies[\s\S]{0,400}errs\[/.test(save),
    'it must never become a validation error — a night that opened nothing is a real night');

  // It says what it costs, in her terms, and counts the run when there is one.
  assert.match(save, /what is on the shelf ' \+\n *'and the cost per ball both come from it/,
    'both consequences are named');
  assert.match(save, /nights in a row with nothing logged/,
    'and a run is counted, so a habit reads as a habit');
});

atest('THE SERVICE WORKER: the page is network-first, everything else is not (v2.13.4)', async () => {
  // Owner, 2026-08-28: "its not updating." The page was served cache-first with
  // no revalidation, which is exactly how a phone gets pinned to an old version:
  // the cached page is served forever, and a new worker only takes over if the
  // page it is serving decides to reload. Any hiccup in that handshake froze the
  // app on whatever version it happened to hold, silently.
  //
  // The sw is loaded and EXERCISED here rather than pattern-matched, because a
  // mistake in it does not show up as a failing screen — it shows up as a phone
  // that cannot be fixed from the phone.
  const SW = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');

  // A tiny world: one cache, a controllable fetch, and the two globals the
  // worker reaches for.
  function loadSW(opts){
    const o = opts || {};
    const log = { fetched: [], put: [], matched: [] };
    const store = new Map(o.cached || []);
    const cache = {
      // Keys are compared by FILENAME: the worker stores './index.html' and asks
      // with 'https://x.test/index.html'. Comparing those as substrings is what
      // made the icon case look like a network fetch when it was my fake that
      // could not match.
      async match(reqOrUrl){
        const key = String(reqOrUrl && reqOrUrl.url ? reqOrUrl.url : reqOrUrl);
        const tail = (v) => String(v).replace(/^\.\//, '').split('/').pop();
        log.matched.push(key);
        for (const [k, v] of store) if (tail(k) === tail(key)) return v;
        return undefined;
      },
      async put(k, v){ log.put.push(String(k)); store.set(String(k), v); },
      async addAll(){ return true; }
    };
    const sandbox = {
      log,
      caches: { async open(){ return cache; }, async keys(){ return []; }, async delete(){ return true; } },
      fetch: async (req) => {
        log.fetched.push(String(req && req.url ? req.url : req));
        if (o.offline) throw new Error('offline');
        if (o.slow) return new Promise(() => {});          // never answers
        return { ok: true, clone(){ return 'FRESH'; }, body: 'FRESH' };
      },
      setTimeout, clearTimeout, Promise, Error, URL, String, Object,
      // Handlers are CAPTURED, so the real routing decision can be exercised
      // rather than bypassed by calling the two strategies directly.
      self: { handlers: {},
              addEventListener(type, fn){ this.handlers[type] = fn; },
              location: { origin: 'https://x.test' }, clients: { claim(){} },
              skipWaiting(){} },
      Response: { error(){ return 'ERR'; } },
      console
    };
    vm.createContext(sandbox);
    vm.runInContext(SW + '\nthis.__pageNetworkFirst = pageNetworkFirst;' +
      '\nthis.__shellCacheFirst = shellCacheFirst;' +
      '\nthis.__NAV = NAV_TIMEOUT_MS;', sandbox, { filename: 'sw.js' });
    return sandbox;
  }

  // ONLINE: a navigation goes to the NETWORK and the fresh page replaces the
  // saved copy — which is the whole fix.
  // method matters: the listener returns early on anything that is not a GET,
  // so a fake request without one makes EVERY route look like "not handled" —
  // which is how the POST assertion below could have passed for the wrong reason.
  const nav = { url: 'https://x.test/index.html', mode: 'navigate', method: 'GET' };

  // ONLINE: a navigation goes to the NETWORK and the fresh page replaces the
  // saved copy — which is the whole fix.
  const sw = loadSW({ cached: [['./index.html', 'OLD']] });
  const res = await sw.__pageNetworkFirst(nav);
  assert.strictEqual(res.body, 'FRESH', 'online, she gets the new page');
  assert.strictEqual(sw.log.fetched.length, 1, 'the network was asked');
  assert.deepStrictEqual(sw.log.put, ['./index.html'],
    'and the saved copy is REPLACED, so the next offline open is the new one too');

  // OFFLINE: it falls back to the saved copy. This app lives at a stall with
  // poor signal, so losing this would be far worse than a stale page.
  const off = loadSW({ cached: [['./index.html', 'OLD']], offline: true });
  assert.strictEqual(await off.__pageNetworkFirst(nav), 'OLD', 'no signal still opens the app');

  // SLOW: it does not hang on a bad connection — it waits, then serves the copy.
  const slow = loadSW({ cached: [['./index.html', 'OLD']], slow: true });
  assert.ok(slow.__NAV > 0 && slow.__NAV <= 5000,
    'the wait is short enough to be a wait and not a hang: ' + slow.__NAV);
  const started = Date.now();
  assert.strictEqual(await slow.__pageNetworkFirst(nav), 'OLD',
    'a slow network falls back rather than hanging');
  assert.ok(Date.now() - started >= slow.__NAV - 50, 'and it really did wait first');

  // EVERYTHING ELSE stays cache-first: the icons are big, never change, and are
  // not what carries the version.
  const icons = loadSW({ cached: [['./icon-192.png', 'ICON']] });
  assert.strictEqual(await icons.__shellCacheFirst({ url: 'https://x.test/icon-192.png', mode: 'no-cors' }),
    'ICON', 'an icon comes from the cache');
  assert.strictEqual(icons.log.fetched.length, 0, 'without touching the network');

  // --- THE ROUTING ITSELF, through the real fetch listener. Calling the two
  // strategies directly proves they work; it does not prove the worker picks
  // the right one, which is the actual bug being fixed here.
  const route = async (world, req) => {
    const box = loadSW(world);
    const handler = box.self.handlers.fetch;
    assert.ok(typeof handler === 'function', 'the worker must register a fetch handler');
    let answered = null;
    handler({ request: req, respondWith(p){ answered = p; } });
    const value = answered ? await answered : null;
    return { box: box, value: value, answered: answered !== null };
  };

  const navRouted = await route({ cached: [['./index.html', 'OLD']] }, nav);
  assert.strictEqual(navRouted.box.log.fetched.length, 1,
    'a NAVIGATION must go to the network first — cache-first here is the bug that started this');
  assert.strictEqual(navRouted.value.body, 'FRESH');

  const iconRouted = await route({ cached: [['./icon-192.png', 'ICON']] },
    { url: 'https://x.test/icon-192.png', mode: 'no-cors', method: 'GET' });
  assert.strictEqual(iconRouted.box.log.fetched.length, 0,
    'an ICON must NOT go to the network — it is big, it never changes, and it does not carry the version');
  assert.strictEqual(iconRouted.value, 'ICON');

  // A POST is never intercepted at all: the API must always reach the wire.
  const posted = await route({}, { url: 'https://x.test/exec', mode: 'cors', method: 'POST' });
  assert.strictEqual(posted.answered, false, 'the worker does not answer non-GET requests');
});

test('TYPING NEVER REBUILDS THE SCREEN UNDER HER (v2.13.2)', () => {
  // Owner, 2026-08-28: "whenever I type the page goes up." A field whose input
  // handler re-renders its whole panel replaces the very input being typed into
  // — the caret is lost, the keyboard may close, and the page jumps back to
  // wherever the rebuilt panel puts it. v2.13.1's catch-up field did exactly
  // that, on every keystroke.
  //
  // Pinned across the WHOLE input listener rather than for that one field,
  // because this is a shape of mistake and not a single bug: every typed field
  // must patch what it derives, the way updateSplitLive and updateStockCard do.
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const start = src.indexOf("document.addEventListener('input'");
  const end = src.indexOf("document.addEventListener('change'");
  assert.ok(start > 0 && end > start, 'the input listener must still be findable');
  const body = src.slice(start, end);

  for (const rebuild of ['renderIbapa(', 'renderGastos(', 'renderCutoff(', 'renderBenta(', 'renderPanel(']) {
    assert.ok(body.indexOf(rebuild) < 0,
      'no typed field may call ' + rebuild + ' — it replaces the input being typed into. ' +
      'Patch the derived text instead (see updateCatchUp / updateSplitLive).');
  }

  // And the catch-up specifically patches, with the inputs left alone.
  assert.match(body, /updateCatchUp\(\);/, 'the catch-up field patches its derived text');
  const upd = src.slice(src.indexOf('function updateCatchUp()'), src.indexOf('function updateCatchUp()') + 900);
  assert.ok(!/innerHTML/.test(upd),
    'and it does it with textContent — innerHTML on a container holding the inputs is the same bug again');
  assert.match(upd, /el\.textContent = catchNoteText/, 'the per-product line is patched');
  assert.match(upd, /set\('catch-total'/, 'and the total');
});

test('SUPPLIES USED shows on the Cutoff tab, and moves nothing (v2.14.0)', () => {
  // Owner, 2026-09-01: "I want to see the supplies cost thats been used in the
  // cutoff tab, I want to see it in realtime, or every time the used supplies
  // has been logged." Display only — the "Supplies" line below it is money PAID
  // and settles the fortnight with his partner; this is stock OPENED.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const flour = app.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  const sauce = app.state.stockItems.find(x => x.product === 'Takoyaki Sauce');
  flour.unit_cost = 120; flour.unit = 'pack';
  sauce.unit_cost = 490; sauce.unit = 'gallon';
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  const per = app.currentPeriod('2026-08-20');

  // Nothing logged: nothing to show.
  let f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsed, 0);
  assert.deepStrictEqual(f.suppliesUsedRows, []);

  // Six packs and two gallons opened inside the cutoff.
  app.state.stockUsage['2026-08-20'] = [
    { date: '2026-08-20', product: 'Takoyaki Flour', qty: 4, entry_id: 'u1' },
    { date: '2026-08-20', product: 'Takoyaki Sauce', qty: 2, entry_id: 'u2' }
  ];
  app.state.stockUsage['2026-08-22'] = [
    { date: '2026-08-22', product: 'Takoyaki Flour', qty: 2, entry_id: 'u3' }
  ];
  f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsed, 6 * 120 + 2 * 490,
    'every night in the cutoff, priced at what each unit costs');
  // Sorted by money, so the biggest line is first.
  assert.strictEqual(f.suppliesUsedRows[0].product, 'Takoyaki Sauce');
  assert.strictEqual(f.suppliesUsedRows[0].cost, 980);
  const fl = f.suppliesUsedRows.find(r => r.product === 'Takoyaki Flour');
  assert.strictEqual(fl.qty, 6, 'nights are summed per product');
  assert.strictEqual(fl.cost, 720);

  // A night OUTSIDE the cutoff contributes nothing.
  app.state.stockUsage['2026-09-02'] = [
    { date: '2026-09-02', product: 'Takoyaki Flour', qty: 50, entry_id: 'u4' }
  ];
  assert.strictEqual(app.computeCutoff(per).suppliesUsed, 6 * 120 + 2 * 490,
    'only this cutoff');

  // NO COST ON FILE: the quantity is counted, the money is NOT invented, and the
  // product is named so he can go and set it.
  sauce.unit_cost = '';
  f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsed, 720, 'the priced part only');
  assert.deepStrictEqual(f.suppliesUsedUnpriced, ['Takoyaki Sauce']);
  assert.strictEqual(f.suppliesUsedRows.find(r => r.product === 'Takoyaki Sauce').cost, null,
    'never costed at nothing');

  // AND IT MOVES NO MONEY. This is the guarantee that lets it sit on the tab
  // that settles the fortnight.
  sauce.unit_cost = 490;
  const withUsage = app.computeCutoff(per);
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  const without = app.computeCutoff(per);
  /* v2.22.0 TURNED THIS AROUND. It asserted that usage "moves nothing" — the
     owner has since asked for exactly the opposite, because his suppliers
     deliver on credit and stock he has opened is a cost the fortnight has run
     up. What still holds, and is now pinned more tightly than "nothing moved"
     ever was: usage may move the RESIDUAL and nothing else, by EXACTLY the
     value opened. */
  for (const k of ['total', 'cash', 'gcash', 'supplies', 'suppliesMinor',
                   'octopus', 'other', 'mama', 'electric', 'salary', 'split']){
    assert.deepStrictEqual(withUsage[k], without[k], 'usage moved ' + k);
  }
  assert.ok(withUsage.suppliesUsed > 0, 'precondition: this fixture prices its usage');
  assert.strictEqual(without.suppliesUsed, 0);
  assert.strictEqual(app.r2(without.remaining - withUsage.remaining), withUsage.suppliesUsed,
    'the residual falls by precisely what was opened — no more, no less');
  assert.strictEqual(noteFixed(app.buildNote(withUsage, per)), noteFixed(app.buildNote(without, per)),
    'and every line but those two is byte-identical either way');
  assert.match(app.buildNote(withUsage, per), /Supplies used \(opened\) - [0-9]/,
    'the value of what was opened is IN the note, beside Supplies');
  assert.match(app.buildNote(without, per), /Supplies used \(opened\) - \n/,
    'while a period with no usage blanks it, exactly as an empty category blanks');
});

test('SOURCE PIN: the Cutoff card separates opened from paid, and a negative explains itself (v2.14.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = src.indexOf('Supplies used this cutoff');
  assert.ok(at > 0, 'the card must exist on the Cutoff tab');
  const card = src.slice(at - 1200, at + 2400);
  assert.match(card, /if \(num\(f\.suppliesUsed\) > 0 \|\| asArr\(f\.suppliesUsedRows\)\.length\)/,
    'it stays away when nothing has been opened');
  // v2.16.0: the sentence must name the rows that are actually on screen. The
  // single "Supplies" row it used to point at no longer exists.
  assert.match(card, /shows below as <b>Supplies \(major\)<\/b>/, 'it names its own row');
  assert.match(card, /not <b>Supplies \(minor\)<\/b>/, 'and the row it is NOT');
  assert.match(card, /money you '\s*\+\n?\s*'<b>paid<\/b>/, 'it says what that other one is');
  assert.match(card, /may be opened across the next two/, 'and why they differ');
  assert.ok(!/It is not the “Supplies” line below/.test(card),
    'and it no longer points at a label the total card stopped printing');
  assert.match(card, /it IS deducted from Remaining/,
    'v2.22.0: the card no longer claims this is outside the totals — it is one of them');
  assert.match(card, /deliver on credit/, 'and says WHY a cost you have not paid still counts');
  assert.ok(!/Nothing here is added to any total/.test(card),
    'the old promise is gone, not merely softened');

  // The below-zero message must no longer send him at the door that hides the
  // difference — that advice predates the catch-up entirely.
  const neg = src.slice(src.indexOf('Below zero'), src.indexOf('Below zero') + 500);
  assert.match(neg, /more is logged as opened than the count and the deliveries can account for/,
    'a negative figure explains itself');
  assert.match(neg, /dated ON the count day is left out on purpose/,
    'and names the rule that most often causes it');
  assert.ok(!/Count what is really there and tap/.test(neg),
    'and it no longer tells him to correct the count, which hides the difference');
});

test('THE EXPENSES SCREEN CAN GO BACK to a cutoff that has ended (v2.17.0)', () => {
  // Owner, 2026-09-01: "its hard to backtrack in the app", then "for the 8/16
  // delete my prior entry, use the one I typed here". It was not hard, it was
  // IMPOSSIBLE: renderGastos listed currentPeriod(todayStr()) and nothing else,
  // and the delete button only exists on a row the list draws. An expense in a
  // cutoff that had ended could not be seen, corrected or deleted from the app.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const now = app.currentPeriod('2026-09-05');
  const prev = app.shiftPeriod(now, -1);
  const older = app.shiftPeriod(prev, -1);

  // Three expenses, one in each of three consecutive cutoffs.
  app.applyLocalExpense({ date: '2026-09-03', category: 'Supplies', item: 'Veggies',
    amount: 111, backlogRef: '', notes: '', entryId: 'gp-now' });
  app.applyLocalExpense({ date: '2026-08-16', category: 'Supplies', item: 'Veggies',
    amount: 84, backlogRef: '', notes: '', entryId: 'gp-prev-1' });
  app.applyLocalExpense({ date: '2026-08-28', category: 'Supplies', item: 'Eggs',
    amount: 255, backlogRef: '', notes: '', entryId: 'gp-prev-2' });
  app.applyLocalExpense({ date: '2026-08-04', category: 'Octopus', item: '',
    amount: 680, backlogRef: '', notes: '', entryId: 'gp-older' });

  // EACH CUTOFF SEES ITS OWN, and no other's.
  const ids = (per) => app.gastosFor(per).map(e => e.entry_id).sort();
  assert.deepStrictEqual(ids(now), ['gp-now']);
  assert.deepStrictEqual(ids(prev), ['gp-prev-1', 'gp-prev-2'],
    'the cutoff that has ENDED is reachable, which is the whole point');
  assert.deepStrictEqual(ids(older), ['gp-older']);

  // NEWEST FIRST, so the most recent entry is the one under her thumb.
  assert.deepStrictEqual(app.gastosFor(prev).map(e => e.date), ['2026-08-28', '2026-08-16']);

  // SAME DAY, MANY ENTRIES: ordered by updated_at within the date, reversed, so
  // a run of same-day entries reads in the order she typed them.
  app.state.expenses['gp-a'] = { date: '2026-08-16', category: 'Supplies', item: 'A',
    amount: 1, backlog_ref: '', notes: '', entry_id: 'gp-a', updated_at: '2026-09-01 21:27:37' };
  app.state.expenses['gp-b'] = { date: '2026-08-16', category: 'Supplies', item: 'B',
    amount: 2, backlog_ref: '', notes: '', entry_id: 'gp-b', updated_at: '2026-09-01 21:28:17' };
  const sameDay = app.gastosFor(prev).filter(e => e.date === '2026-08-16').map(e => e.entry_id);
  assert.ok(sameDay.indexOf('gp-b') < sameDay.indexOf('gp-a'),
    'within one date the LATER entry comes first: ' + sameDay.join(','));

  // A BLANK OR JUNK DATE cannot smuggle a row into a period. inPeriod decides,
  // and it is the same rule the Cutoff screen and the note already use.
  app.state.expenses['gp-junk'] = { date: '', category: 'Other', item: 'X', amount: 9,
    backlog_ref: '', notes: '', entry_id: 'gp-junk', updated_at: '' };
  for (const per of [now, prev, older]){
    assert.ok(app.gastosFor(per).every(e => e.entry_id !== 'gp-junk'),
      'a dateless row belongs to no cutoff');
  }

  // WHAT THE SCREEN CALLS EACH CUTOFF. Every "this cutoff" is false on a screen
  // that can be stepped, and "No expenses yet this cutoff" over a fortnight that
  // had plenty is a lie about the business rather than about the screen.
  const here = app.currentPeriod(app.todayStr());
  const back = app.shiftPeriod(here, -1);
  const wNow = app.gastosWords(here), wBack = app.gastosWords(back);
  assert.strictEqual(wNow.current, true);
  assert.strictEqual(wBack.current, false);
  assert.strictEqual(wNow.heading, 'Expenses this cutoff');
  assert.strictEqual(wBack.heading, 'Expenses', 'an earlier cutoff is not "this" one');
  assert.strictEqual(wNow.empty, 'No expenses yet this cutoff. Tap + to add one.');
  assert.strictEqual(wBack.empty, 'Nothing is logged for ' + app.periodLabel(back) + '.',
    'and an empty earlier cutoff SAYS which cutoff it found nothing in');
  assert.ok(wBack.empty.indexOf('this cutoff') < 0, 'never "this cutoff" about another one');
  assert.strictEqual(wNow.sub, 'This cutoff');
  assert.strictEqual(wBack.sub, String(app.currentPeriod(back.start).start.slice(0, 4)),
    'and the caption carries the year instead');

  // THE DATE A NEW ENTRY GETS while an earlier cutoff is on screen: the period's
  // LAST day, never today — or it saves correctly and vanishes from the list he
  // saved it on. Already the Cutoff screen's rule; now this screen's too.
  assert.strictEqual(app.cutoffExpenseDate(prev), prev.end);
  assert.strictEqual(app.cutoffExpenseDate(app.currentPeriod(app.todayStr())), app.todayStr(),
    'and today when today is inside the cutoff being shown');
  assert.strictEqual(app.cutoffExpenseDate(app.shiftPeriod(app.currentPeriod(app.todayStr()), 1)), '',
    'and NOTHING for a cutoff that has not begun');
});

test('SOURCE PIN: the Expenses screen steps, and every rule follows the shown cutoff (v2.17.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const start = src.indexOf('function renderGastos(){');
  assert.ok(start > 0);
  const screen = src.slice(start, src.indexOf('function submitGasto(){'));

  // THE LIST follows the stepper, not the calendar.
  assert.match(screen, /const per = gastosPer \|\| currentPeriod\(todayStr\(\)\)/,
    'the screen renders the cutoff being LOOKED AT');
  assert.ok(!/const per = currentPeriod\(todayStr\(\)\);/.test(screen),
    'and no longer pins itself to the current one');
  assert.match(screen, /data-act="gastos-prev"/, 'a way back');
  assert.match(screen, /data-act="gastos-next"/, 'and forward');
  assert.match(screen, /previewIncomplete\(per\)/,
    'an empty list from beyond the phone window must not read as "no expenses"');
  assert.match(screen, /It reaches further back than this phone keeps/,
    'and the warning SAYS so — the guard without the sentence teaches nothing');
  assert.match(screen, /this list is not the full record for this cutoff/,
    'in words he can act on');

  // EVERY "this cutoff" IS A CLAIM THAT CAN BE FALSE once the screen steps, so
  // none of them may be written inline: the screen reads gastosWords(), whose
  // behaviour is tested above. Source-pinning the sentences was NOT enough —
  // mutating isCurrent's definition left every sentence intact and slipped past.
  assert.match(screen, /const w = gastosWords\(per\);/, 'the wording comes from the rule');
  assert.match(screen, /esc\(w\.heading\)/, 'the heading');
  assert.match(screen, /esc\(w\.empty\)/, 'the empty-list line');
  assert.match(screen, /esc\(w\.sub\)/, 'the stepper caption');
  assert.ok(!/isCurrent/.test(screen),
    'and the screen no longer decides any of it inline');
  assert.ok(!/'No expenses yet this cutoff/.test(screen),
    'the wording lives in one place, not two');
  assert.match(screen, /if \(!cutoffExpenseDate\(per\)\)/,
    'a cutoff that has not begun is not offered a form it would be refused from');

  // THE HANDLERS move the period AND the date the form will use, together.
  const acts = src.slice(src.indexOf("act === 'gastos-open'"), src.indexOf("act === 'gastos-pick'"));
  for (const a of ['gastos-open', 'gastos-prev', 'gastos-next']){
    assert.ok(acts.indexOf(a) >= 0, a + ' is wired');
  }
  assert.strictEqual((acts.match(/cutoffExpenseDate\(/g) || []).length, 3,
    'all three set the entry date from the cutoff on screen');
  assert.ok(!/gx\.date = todayStr\(\);/.test(acts),
    'opening the form no longer always dates the entry today');

  // "SAVED ELSEWHERE" is measured against the cutoff ON SCREEN. Measured against
  // the current one it would either hide a row that really did land elsewhere or
  // cry "saved elsewhere" about a row sitting right there in the list.
  const submit = src.slice(src.indexOf('function submitGasto(){'), src.indexOf('function deleteGasto('));
  assert.match(submit, /const here = gastosPer \|\| currentPeriod\(todayStr\(\)\)/,
    'the comparison follows the stepper');
});

test('the residual agrees to the CENTAVO with a fractional unit cost (v2.22.0)', () => {
  /* Found while reviewing, not by a failure: Code.gs rounds the opened value
     (round2) and THEN subtracts it; the phone was subtracting the raw sum and
     rounding once at the end. With a unit cost of more than two decimals those
     can land a centavo apart — and the note's fmt() would have hidden it. The
     phone now rounds before it subtracts, and this test carries such a cost
     precisely so the two cannot drift back. */
  const srv = loadServer();
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data;
  const app0 = syncedClient(boot);
  const D = ymdDaysAgo(2);
  const per = app0.currentPeriod(D);

  /* 3 packs at 120.375: raw 361.125, which is EXACT in binary (a multiple of
     1/8), so this cannot flake on float representation. round2 takes it to
     361.13. Subtracting the raw figure from an integer leaves .875, which rounds
     to .88 — i.e. a residual ending in .12 — where subtracting the rounded one
     leaves .13. That is the centavo of drift, forced into the open.

     (The first draft of this test used 33.333 x 3 = 99.999; the .001 simply
     rounded away and the buggy code passed. A fixture has to be built so the
     wrong answer is a DIFFERENT number, not a number that rounds to the same.) */
  const items = boot.stockItems.map(x => ({ product: x.product, unit: x.unit, active: x.active,
    reorderAt: x.reorder_at, unitCost: x.product === 'Takoyaki Flour' ? 120.375 : '' }));
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: items } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 40, eod: 10, entryId: 'frac-n' }],
    stock: [{ product: 'Takoyaki Flour', qty: 3 }], entryId: 'frac-day' } }).ok, true);

  const cut = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cut.ok, true, cut.error);
  const f = cut.data.figures;
  assert.strictEqual(f.supplies_used, 361.13, '361.125 rounds to 361.13 on the sheet');

  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  // THE FULL SEAM, raw figures included — this is the assertion that would have
  // failed before the fix.
  assertCutoffSeam(app, per, cut.data);
  const local = app.computeCutoff(per);
  assert.strictEqual(local.suppliesUsed, 361.13, 'the phone rounds the same way');
  assert.strictEqual(local.remaining, f.remaining, 'and the residual matches to the centavo');
  // The residual is built from the ROUNDED figure: total minus everything else
  // minus exactly 361.13, never 361.125.
  assert.strictEqual(local.remaining,
    app.r2(local.total - local.mama - local.split - local.suppliesMinor - 361.13 -
           local.salary - local.electric));
  assert.notStrictEqual(local.remaining,
    app.r2(local.total - local.mama - local.split - local.suppliesMinor - 361.125 -
           local.salary - local.electric),
    'and it is provably NOT the unrounded subtraction — the two differ by a centavo here');
});

test('THE OPENED VALUE IS AN ALLOCATION, and the block adds to Total (v2.22.0)', () => {
  /* Owner, 2026-09-02: "all has been paid and I still got 12,933 remaining?
     thats impossible, because where will I get the money for supplies major?"
     Then: "just focus on the front numbers, from mama to the bottom of the list,
     the total should be the total sales."

     He was right. His suppliers deliver on credit, so stock he has OPENED is a
     cost the fortnight has already run up whether the bill is paid or not.
     Leaving it out made Remaining read as money he was free to take when part
     of it was already spoken for. */
  const srv = loadServer();
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data;
  const app0 = syncedClient(boot);
  const D = ymdDaysAgo(2);
  const per = app0.currentPeriod(D);

  // Price one product, open some of it, and buy something on the same night.
  const items = boot.stockItems.map(x => ({ product: x.product, unit: x.unit, active: x.active,
    reorderAt: x.reorder_at, unitCost: x.product === 'Takoyaki Flour' ? 120 : '' }));
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: items } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveExpense', payload: {
    date: D, category: 'Supplies', item: 'Veggies', amount: 300,
    backlogRef: '', notes: '', entryId: 'alloc-min' } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 60, eod: 10, entryId: 'alloc-n' }],
    stock: [{ product: 'Takoyaki Flour', qty: 6 }], entryId: 'alloc-day' } }).ok, true);

  const cut = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cut.ok, true, cut.error);
  const f = cut.data.figures;
  assert.strictEqual(f.supplies_used, 720, '6 packs at 120');

  // THE BLOCK ADDS TO TOTAL — from Mama to the bottom, which is what he asked for.
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies_minor + f.supplies_used + f.salary +
    f.electric + f.remaining,
    'total = mama + split + minor + used + salary + electric + remaining');

  // AND IT IS DEDUCTED, not merely displayed. Proving that means comparing with
  // the same period costed at nothing — but the rows now carry the cost they
  // were saved at (see the snapshot test below), so blanking the CURRENT cost
  // must NOT move this period. To get the never-priced figure, the night is
  // re-saved with no cost on file, which re-snapshots it blank.
  const bare = boot.stockItems.map(x => ({ product: x.product, unit: x.unit,
    active: x.active, reorderAt: x.reorder_at, unitCost: '' }));
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: bare } }).ok, true);
  const afterEdit = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } }).data.figures;
  assert.strictEqual(afterEdit.supplies_used, 720,
    'blanking the current cost does not un-price a night already saved at 120');
  assert.strictEqual(afterEdit.remaining, f.remaining, 'so the settled residual holds');
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 60, eod: 10, entryId: 'alloc-n' }],
    stock: [{ product: 'Takoyaki Flour', qty: 6 }], entryId: 'alloc-day' } }).ok, true);
  const noCost = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } }).data.figures;
  assert.strictEqual(noCost.supplies_used, 0, 'nothing priceable, nothing priced');
  assert.strictEqual(noCost.supplies_used_unpriced, 1, 'and the product is COUNTED as unpriced');
  assert.strictEqual(noCost.remaining - f.remaining, 720,
    'pricing the stock lowered Remaining by exactly its cost');
  // Every OTHER figure is untouched by the costing.
  for (const k of ['total', 'cash', 'gcash', 'mama', 'split', 'supplies',
                   'supplies_minor', 'octopus', 'other', 'salary', 'electric']){
    assert.strictEqual(noCost[k], f[k], 'costing moved ' + k);
  }
  // Restore the cost for the phone comparison below: the rows are blank, so
  // they fall back to the current 120 and price again — setting a cost LATER
  // still values stock that was never priced.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: items } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } }).data.figures.supplies_used, 720,
    'a blank snapshot falls back to the cost on file now');

  // THE PHONE AGREES, byte for byte and figure for figure.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: items } }).ok, true);
  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const local = app.computeCutoff(per);
  assert.strictEqual(local.suppliesUsed, 720);
  assert.strictEqual(local.remaining, f.remaining, 'the residual matches the sheet exactly');
  assert.strictEqual(app.buildNote(local, per), cut.data.note_text);

  // A TYPED SPLIT MUST NOT UN-DEDUCT IT. cutoffWithSplit rebuilds the residual
  // from scratch, and forgetting the opened value there would hand the money
  // back the moment he touched the Split field.
  const bumped = app.cutoffWithSplit(local, app.num(local.split) + 500);
  assert.strictEqual(bumped.remaining, app.r2(local.remaining - 500),
    'only the split moved it, by exactly the split');
  assert.strictEqual(bumped.total,
    bumped.mama + bumped.split + bumped.suppliesMinor + app.noteUsedFig(bumped) +
    bumped.salary + bumped.electric + bumped.remaining,
    'and the identity still closes with a typed split');
  assert.strictEqual(app.noteUsedFig(bumped), 720, 'the opened value survived the split');
});

test('SOURCE PIN: the backlog overlap is SAID on the card, only when it exists (v2.22.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = src.indexOf("'<div class=\"co-row\"><span>Supplies (major)</span>'");
  assert.ok(at > 0);
  const card = src.slice(at, at + 1400);
  assert.match(card, /num\(f\.backlogInMinor\) > 0 && num\(f\.suppliesUsed\) > 0/,
    'drawn only when BOTH figures exist — with either at zero there is no overlap');
  assert.match(card, /deducted twice/, 'and it names the consequence');
  // The sentence is split across a string concatenation in the source, so it is
  // matched in its two halves rather than as one run of text.
  assert.match(card, /once when it was ' \+/, 'and the mechanism (first half)');
  assert.match(card, /'opened, once when it was paid\./, 'and the mechanism (second half)');
  assert.match(card, /esc\(peso\(f\.backlogInMinor\)\)/, 'with the amount, escaped');
  assert.match(card, /color:var\(--alert\)/, 'in the colour the app reserves for money problems');
});

test('A COST EDITED LATER DOES NOT RESTATE A SAVED CUTOFF (v2.22.0)', () => {
  /* Found by the adversarial review, reproduced against Code.gs before this
     existed: the opened value became an allocation, apiCutoff priced usage at
     the CURRENT unit_cost, so editing Flour 120 → 130 under Maintenance moved a
     generated period's Remaining and Generate overwrote the archive. Money that
     has moved was being restated — the one thing every other snapshot here
     (price, cheese_price, salary, in_cutoff) exists to prevent.

     Usage rows now carry the cost they were priced at WHEN SAVED. */
  const srv = loadServer();
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data;
  const app0 = syncedClient(boot);
  const D = ymdDaysAgo(2);
  const per = app0.currentPeriod(D);
  const setCost = (c) => assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: boot.stockItems.map(x => ({ product: x.product, unit: x.unit, active: x.active,
      reorderAt: x.reorder_at, unitCost: x.product === 'Takoyaki Flour' ? c : '' })) } }).ok, true);
  const cut = () => post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } }).data;
  const saveNight = () => assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 60, eod: 10, entryId: 'snap-n' }],
    stock: [{ product: 'Takoyaki Flour', qty: 6 }], entryId: 'snap-day' } }).ok, true);

  setCost(120);
  saveNight();
  const settled = cut();
  assert.strictEqual(settled.figures.supplies_used, 720);

  // THE EDIT THAT USED TO RESTATE. Nothing about this period may move.
  setCost(130);
  const afterEdit = cut();
  assert.strictEqual(afterEdit.figures.supplies_used, 720, 'the rows keep the 120 they were saved at');
  assert.strictEqual(afterEdit.figures.remaining, settled.figures.remaining, 'Remaining holds');
  assert.strictEqual(afterEdit.note_text, settled.note_text, 'the note is byte-identical');

  // THE ROW CARRIES IT, on the sheet and into the phone.
  const rows = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data.stockUsage
    .filter(u => u.date === D && u.product === 'Takoyaki Flour');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].unit_cost), 120, 'the snapshot rides in the bootstrap');
  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  assert.strictEqual(app.state.stockUsage[D][0].unit_cost, 120, 'and the phone keeps it');
  assert.strictEqual(app.computeCutoff(per).suppliesUsed, 720,
    'so the phone prices the night at 120 too, though its StockItems now say 130');
  assert.strictEqual(app.computeCutoff(per).remaining, afterEdit.figures.remaining,
    'and the two sides agree on the residual');

  // CORRECTING A WRONG COST ON A SAVED NIGHT MEANS RE-SAVING THE NIGHT — the same
  // door a wrong price has, and the app already says so for prices.
  saveNight();
  assert.strictEqual(cut().figures.supplies_used, 780, 'the re-save snapshots the 130');

  // A ROW SAVED WITH NO COST ON FILE gets valued the moment a cost is entered:
  // its snapshot is blank, so it falls back to whatever is on file when read.
  setCost('');
  saveNight();
  // A SECOND unpriced night of the same product, so the unpriced figure is
  // provably a count of PRODUCTS and not of rows — with one row either reads 1.
  const D2 = D !== per.start ? per.start : app0.addDays(D, 1);
  assert.ok(D2 >= per.start && D2 <= per.end && D2 !== D, 'precondition: another night in period');
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D2, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 30, eod: 10, entryId: 'snap-n2' }],
    stock: [{ product: 'Takoyaki Flour', qty: 2 }], entryId: 'snap-day2' } }).ok, true);
  assert.strictEqual(cut().figures.supplies_used, 0);
  assert.strictEqual(cut().figures.supplies_used_unpriced, 1,
    'one PRODUCT nobody could price, though two of its nights are in the period');
  setCost(125);
  assert.strictEqual(cut().figures.supplies_used, 8 * 125, 'both nights valued at the cost entered later');
  assert.strictEqual(cut().figures.supplies_used_unpriced, 0);
});

test('THE PHONE SNAPSHOTS AS IT SAVES, and prices rows exactly as the sheet does (v2.22.0)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  const D = '2026-08-20';
  const per = app.currentPeriod(D);
  const flour = app.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  const sauce = app.state.stockItems.find(x => x.product === 'Takoyaki Sauce');
  const mayo  = app.state.stockItems.find(x => x.product === 'Japanese Mayo');
  flour.unit_cost = 120; sauce.unit_cost = ''; mayo.unit_cost = 0;

  // SAVING A NIGHT LOCALLY SNAPSHOTS THE COST ON FILE — the same lookup
  // apiSaveDay makes — so the mirror agrees with the sheet before the sync lands.
  app.applyLocalDay({ date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0,
    notes: '', counts: [], stock: [{ product: 'Takoyaki Flour', qty: 6 },
    { product: 'Takoyaki Sauce', qty: 2 }, { product: 'Japanese Mayo', qty: 1 }], entryId: 'loc-1' });
  const byName = {};
  for (const r of app.state.stockUsage[D]) byName[r.product] = r;
  assert.strictEqual(byName['Takoyaki Flour'].unit_cost, 120, 'snapshotted');
  assert.strictEqual(byName['Takoyaki Sauce'].unit_cost, '', 'no cost on file → blank, never 0');
  assert.strictEqual(byName['Japanese Mayo'].unit_cost, 0, 'a cost of ZERO is a figure, and is kept');

  // THE SNAPSHOT WINS over a later edit.
  flour.unit_cost = 130;
  let f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsed, 720, 'priced at the 120 it was saved with, not today\'s 130');

  // A BLANK SNAPSHOT FALLS BACK to the cost on file now.
  sauce.unit_cost = 490;
  f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsed, 720 + 980, 'the sauce is valued the moment a cost exists');
  assert.deepStrictEqual(f.suppliesUsedUnpriced, [], 'and nothing is unpriced');

  // ZERO IS PRICED, not "no cost set" — the same rule as Code.gs's usableCost.
  // The phone used to require > 0, so the two notes disagreed on the suffix.
  const mayoRow = f.suppliesUsedRows.find(r => r.product === 'Japanese Mayo');
  assert.strictEqual(mayoRow.cost, 0, 'priced at nothing, which is a price');
  assert.ok(f.suppliesUsedUnpriced.indexOf('Japanese Mayo') < 0, 'not counted as unpriced');

  // CASE-FOLDED FALLBACK, as the sheet does it. A hand-edited row may not match
  // the product's case exactly; the two sides must still price it the same way.
  app.state.stockUsage[D].push({ date: D, product: 'takoyaki flour', qty: 1, entry_id: 'x',
    updated_at: '', unit_cost: '' });
  f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsed, 720 + 980 + 130, 'the lowercase row prices at the current 130');

  // PARTLY PRICED: known money counts, and the product is still NAMED.
  sauce.unit_cost = '';
  app.state.stockUsage[D].push({ date: D, product: 'Takoyaki Sauce', qty: 1, entry_id: 'y',
    updated_at: '', unit_cost: 490 });
  f = app.computeCutoff(per);
  const sauceRow = f.suppliesUsedRows.find(r => r.product === 'Takoyaki Sauce');
  assert.strictEqual(sauceRow.cost, 490, 'the snapshotted row is priced');
  assert.ok(f.suppliesUsedUnpriced.indexOf('Takoyaki Sauce') >= 0,
    'but the product is named, because the other 2 gal could not be');
  assert.strictEqual(sauceRow.qty, 3, 'and the quantity is the whole of it');

  // NOTHING OF IT PRICEABLE: null, never 0.
  app.state.stockUsage[D] = app.state.stockUsage[D].filter(r => r.entry_id !== 'y');
  f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsedRows.find(r => r.product === 'Takoyaki Sauce').cost, null);
});

test('A COST EDIT DROPS THE NOTE ON SCREEN (v2.22.0)', () => {
  // Found by the review: lastNote was dropped for a day, expense or split edit,
  // but never for a cost edit — and a cost edit now moves Remaining, so the
  // figures card would show one residual with a "saved" note underneath showing
  // another, which is exactly what invalidateNoteFor exists to prevent.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const flour = app.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  flour.unit_cost = 120;
  const row = (c) => ({ rows: [{ product: 'Takoyaki Flour', unit: 'pack', reorderAt: '', active: true,
    unitCost: c }] });

  app.lastNote = { key: 'k', text: 'Remaining - 5,193', demo: false };
  app.applyLocalStockItems(row(130));
  assert.strictEqual(app.lastNote, null, 'a changed cost drops the note');

  app.lastNote = { key: 'k', text: 'x', demo: false };
  app.applyLocalStockItems(row(130));
  assert.notStrictEqual(app.lastNote, null, 'the SAME cost re-saved changes nothing, and keeps it');

  app.applyLocalStockItems({ rows: [{ product: 'Takoyaki Flour', unit: 'pack', reorderAt: 3,
    active: true, unitCost: '' }] });
  assert.notStrictEqual(app.lastNote, null, 'a batch that carries no cost leaves it alone too');

  flour.unit_cost = '';
  app.applyLocalStockItems(row(120));
  assert.strictEqual(app.lastNote, null, 'and setting a cost where there was none drops it');
});

test('THE BACKLOG OVERLAP IS REPORTED, not silently double-counted (v2.22.0)', () => {
  /* A Backlog payment folds into `other`, and so into supplies_minor. If the
     backlog being paid is for bulk stock whose consumption is already in
     supplies_used, that money comes off twice — in two different cutoffs.

     The owner's instruction was explicit: "dont touch the backlogs I tell when
     to pay backlogs." So the behaviour is UNCHANGED and the figure is REPORTED
     instead, which is the honest middle: he keeps control, and the app stops
     being quietly wrong about it. */
  const srv = loadServer();
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data;
  const app0 = syncedClient(boot);
  const D = ymdDaysAgo(2);
  const per = app0.currentPeriod(D);

  const clean = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } }).data.figures;
  assert.strictEqual(clean.backlog_in_minor, 0, 'no backlog payments, nothing to report');

  const name = boot.backlogs && boot.backlogs.length ? boot.backlogs[0].name : '';
  assert.ok(name, 'the fixture has a backlog to pay');
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveExpense', payload: {
    date: D, category: 'Backlog', item: 'Backlog payment', amount: 900,
    backlogRef: name, notes: '', entryId: 'bl-1' } }).ok, true);
  // AND an ordinary Supplies row on the same night, so a report that swept up
  // every category would read 1,150 and be caught — a fixture with only the
  // backlog row cannot tell "Backlog" from "everything".
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveExpense', payload: {
    date: D, category: 'Supplies', item: 'Veggies', amount: 250,
    backlogRef: '', notes: '', entryId: 'bl-veg' } }).ok, true);

  const after = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } }).data.figures;
  assert.strictEqual(after.backlog_in_minor, 900, 'the overlap is the BACKLOG part only, to the peso');
  // IT IS STILL INSIDE minor — behaviour deliberately unchanged.
  assert.strictEqual(after.supplies_minor, clean.supplies_minor + 900 + 250,
    'a backlog payment still counts as money paid, exactly as before');
  assert.strictEqual(after.remaining, clean.remaining - 900 - 250);
  // And the identity closes either way.
  for (const g of [clean, after]){
    assert.strictEqual(g.total,
      g.mama + g.split + g.supplies_minor + g.supplies_used + g.salary +
      g.electric + g.remaining);
  }

  // THE PHONE COMPUTES THE SAME FIGURE from its own rows.
  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  assert.strictEqual(app.computeCutoff(per).backlogInMinor, 900,
    'the phone agrees, so a warning drawn from it cannot contradict the sheet');
});

test('THE CUTOFF STOCK BLOCK SHOWS WHAT IT STARTED WITH (v2.21.0)', () => {
  // Owner, 2026-09-02: "how to correct the count of bonito, it says 1 bag came
  // in 2 bags opened." Nothing needed correcting — he had a bag already, from
  // the Aug 15 count. The row simply never said so, and "1 came in, 2 opened"
  // against "counted 0" reads as impossible without it.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  for (const k in app.state.stockCounts) delete app.state.stockCounts[k];
  for (const k in app.state.stockDeliveries) delete app.state.stockDeliveries[k];
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  const per = { start: '2026-08-16', end: '2026-08-31' };

  // HIS EXACT BONITO HISTORY.
  app.state.stockCounts['2026-08-15'] = [{ date: '2026-08-15', product: 'Bonito',
    counted_qty: 1, entry_id: 'c15', updated_at: '2026-08-19 18:50:55' }];
  app.state.stockCounts['2026-08-31'] = [
    { date: '2026-08-31', product: 'Bonito', counted_qty: 2, entry_id: 'c31a', updated_at: '2026-08-31 23:57:33' },
    { date: '2026-08-31', product: 'Bonito', counted_qty: 0, entry_id: 'c31b', updated_at: '2026-08-31 23:57:38' }
  ];
  app.state.stockDeliveries['2026-08-27'] = [{ date: '2026-08-27', product: 'Bonito',
    qty: 1, entry_id: 'd27', updated_at: '2026-08-27 22:37:11' }];
  app.state.stockUsage['2026-08-31'] = [{ date: '2026-08-31', product: 'Bonito',
    qty: 2, entry_id: 'u31' }];

  // THE OPENING BALANCE is the latest count BEFORE the period, not inside it.
  const op = app.openingCountFor('Bonito', per);
  assert.deepStrictEqual([op.date, op.qty], ['2026-08-15', 1],
    'the Aug 15 count is what this cutoff started from');
  // The two Aug 31 counts are INSIDE the period and must not be mistaken for it.
  assert.ok(op.date < per.start, 'strictly before the period begins');

  // AND THE ROW NOW ADDS UP ON ITS FACE: 1 + 1 - 2 = 0.
  // Unit-agnostic on purpose: the unit is fixture data, the ARITHMETIC is the
  // contract. 1 at the start + 1 in - 2 opened = the 0 that was counted.
  const html = app.stockCutoffHTML(per);
  assert.match(html, /1 \w+ at the start/, 'what it started with');
  assert.match(html, /1 \w+ came in/);
  assert.match(html, /2 \w+s? opened/);
  assert.match(html, /counted 0 \w+s? on August 31/);
  const at = html.indexOf('at the start'), came = html.indexOf('came in');
  assert.ok(at < came, 'the opening balance is FIRST, so the row reads as arithmetic');

  // NO COUNT BEFORE THE PERIOD: null, never 0. "Started with 0" would be a claim
  // this cannot support, and blank is never zero.
  assert.strictEqual(app.openingCountFor('Bonito', { start: '2026-08-01', end: '2026-08-15' }), null,
    'nothing counted before it means UNKNOWN');
  const early = app.stockCutoffHTML({ start: '2026-08-01', end: '2026-08-15' });
  assert.ok(early.indexOf('at the start') < 0, 'and the phrase is simply absent');

  // A PRODUCT WITH NO HISTORY AT ALL, and junk dates, are quiet rather than 0.
  assert.strictEqual(app.openingCountFor('Japanese Mayo', per), null);
  assert.strictEqual(app.openingCountFor('Bonito', {}), null, 'no period, no answer');
  assert.strictEqual(app.openingCountFor('Bonito', { start: 'nope', end: 'nope' }), null);

  // TWO COUNTS ON THE SAME EARLIER DAY: the later one wins, the same rule the
  // baseline uses, so the block and the on-hand figure cannot disagree.
  app.state.stockCounts['2026-08-15'].push({ date: '2026-08-15', product: 'Bonito',
    counted_qty: 5, entry_id: 'c15b', updated_at: '2026-08-19 19:00:00' });
  assert.strictEqual(app.openingCountFor('Bonito', per).qty, 5, 'the later entry of that day');
});

test('THE DATE A COUNT IS FOR, and what it means (v2.21.0)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const today = app.todayStr();

  // TODAY UNTIL HE CHANGES IT, and junk falls back rather than queueing a bad date.
  app.countDateDraft = '';
  assert.strictEqual(app.countDateFor(), today);
  app.countDateDraft = 'nonsense';
  assert.strictEqual(app.countDateFor(), today, 'junk is not a date');
  app.countDateDraft = '0002-08-31';
  assert.strictEqual(app.countDateFor(), '0002-08-31',
    'a well-formed but absurd date IS returned — saveStockCountNow refuses it in the ' +
    'server\'s own words rather than this reader silently swapping it');
  app.countDateDraft = '2026-08-31';
  assert.strictEqual(app.countDateFor(), '2026-08-31', 'and a real pick is honoured');

  // WHAT IT MEANS depends entirely on the date, because a count is an end-of-day
  // figure and everything after it still applies on top.
  app.countDateDraft = today;
  const now = app.countDateHint();
  assert.match(now, /closing time today/);
  app.countDateDraft = '2026-08-31';
  const back = app.countDateHint();
  assert.match(back, /close of/, 'a backdated count names the day it is for');
  assert.match(back, /delivered or opened AFTER that day still counts on top/,
    'and warns that later rows still apply, so on hand may not equal what he typed');
  assert.match(back, /this replaces it/, 'and that it settles a day already counted');
  assert.notStrictEqual(now, back, 'the two cases do not read the same');
});

test('SOURCE PIN: a count can be dated, and says what that means (v2.21.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const save = src.slice(src.indexOf('function saveStockCountNow(product){'),
                         src.indexOf('function saveStockCountNow(product){') + 1600);

  // THE DATE IS CHOSEN, not assumed. The server always accepted a backdated
  // count; only this screen refused to offer one, which left a count typed wrong
  // on the 31st impossible to put right from the app.
  assert.match(save, /const when = countDateFor\(\);/, 'the save reads the chosen date');
  assert.ok(save.indexOf('date: todayStr()') < 0, 'and no longer hard-wires today');
  assert.match(save, /const dateBad = entryDateError\(when\);/,
    'refused in the server\'s own words, so a half-typed year never queues');
  assert.match(save, /payload = \{ date: when,/);

  // THE FIELD, bounded at today — money cannot be counted into the future.
  const ui = src.slice(src.indexOf('id="stCountDate"') - 200, src.indexOf('id="stCountDate"') + 260);
  assert.match(ui, /type="date"/);
  assert.match(ui, /max="' \+ todayStr\(\) \+ '"/, 'no future counts');

  // WHAT IT MEANS depends entirely on the date, and the screen says so.
  const hint = src.slice(src.indexOf('function countDateHint(){'), src.indexOf('function saveStockCountNow'));
  assert.match(hint, /closing time today/, 'today reads as it always did');
  assert.match(hint, /delivered or opened AFTER that day still counts on top/,
    'and a backdated count warns that later rows still apply');
  assert.match(hint, /this replaces it/, 'and that it settles a day already counted');

  // TYPING PATCHES THE SENTENCE, never the panel — a stable id, like every other
  // derived line on this screen.
  const listener = src.slice(src.indexOf("document.addEventListener('input'"),
                             src.indexOf("document.addEventListener('change'"));
  assert.match(listener, /id === 'stCountDate'/);
  assert.match(listener, /\$\('count-date-hint'\)/, 'patched by id');
  assert.match(listener, /hint\.textContent = countDateHint\(\)/, 'with textContent');
});

test('SUPPLIES (MINOR) IS EVERY ENTRY, WHATEVER BUCKET WAS TAPPED (v2.20.0)', () => {
  // Owner, 2026-09-01, after ₱3,957 of daily buying went in under the "Other"
  // bucket and so never reached the Supplies line: "supplies minor must sum all
  // the entries, regardless of what it is, the only things that are not
  // included in the minor are the major."
  const srv = loadServer();
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data;
  const app0 = syncedClient(boot);
  const D = ymdDaysAgo(2);                       // the harness clock, not the wall clock
  const per = app0.currentPeriod(D);
  const add = (category, item, amount, id) => assert.strictEqual(
    post(srv.ctx, { token: srv.token, action: 'saveExpense', payload: {
      date: D, category, item, amount, backlogRef: '', notes: '', entryId: id } }).ok,
    true, category + ' ' + amount);

  // One of each bucket the Expenses screen offers, plus the two that are NOT on
  // it and keep their own lines.
  add('Supplies', 'Veggies', 244, 'm-sup');
  add('Octopus', '', 1500, 'm-oct');
  add('Other', '', 3957, 'm-oth');
  add('Mama', 'Mama', 500, 'm-mama');
  add('Electric', 'Electric bill', 500, 'm-elec');

  const cut = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cut.ok, true, cut.error);
  const f = cut.data.figures;

  // THE THREE EXPENSES-SCREEN CATEGORIES BECOME ONE FIGURE.
  assert.strictEqual(f.supplies_minor, 244 + 1500 + 3957, 'every bucket, whatever was tapped');
  // ...and the parts are STILL there, so the Cutoffs archive keeps the detail.
  assert.strictEqual(f.supplies, 244);
  assert.strictEqual(f.octopus, 1500);
  assert.strictEqual(f.other, 3957);
  // MAMA AND ELECTRIC ARE NOT IN IT — they are not entered on that screen and a
  // partner reads them individually.
  assert.strictEqual(f.mama, 500);
  assert.strictEqual(f.electric, 500);
  assert.ok(f.supplies_minor < f.supplies_minor + f.mama + f.electric);

  // THE IDENTITY CLOSES ON FIVE ALLOCATIONS PLUS THE RESIDUAL — the merged
  // figure standing in for exactly the three it replaced, so `remaining` cannot
  // have moved by a centavo.
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies_minor + f.salary + f.electric + f.remaining,
    'total = mama + split + supplies(minor) + salary + electric + remaining');
  // And the OLD seven-way identity still holds too, which is the proof that this
  // was a rename and not a re-derivation.
  assert.strictEqual(f.total,
    f.mama + f.split + f.supplies + f.octopus + f.salary + f.other + f.electric + f.remaining,
    'the seven parts still add to the same Total');

  // THE NOTE PRINTS ONE LINE AND DROPS THE OTHER TWO.
  const lines = cut.data.note_text.split('\n');
  assert.ok(lines.some(l => l === 'Supplies (minor) - ' + '5,701'), cut.data.note_text);
  assert.ok(!lines.some(l => l.indexOf('Octopus - ') === 0), 'no Octopus line');
  assert.ok(!lines.some(l => l.indexOf('Other payments - ') === 0), 'no Other payments line');

  // THE PHONE AGREES, byte for byte, from figures it computed itself.
  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const local = app.computeCutoff(per);
  assert.strictEqual(local.suppliesMinor, f.supplies_minor, 'the phone merges identically');
  assert.strictEqual(app.buildNote(local, per), cut.data.note_text, 'and writes the same note');
});

test('noteMinorVal: either casing, and a fallback for figures that predate it (v2.20.0)', () => {
  const app = loadClient();
  /* WHY BOTH CASINGS. buildNote is only ever handed computeCutoff's own
     camelCase figures — checked: those are its only two call sites — so the
     snake_case read is DEFENSIVE, not a live path, and this test says so rather
     than pretending otherwise.

     What IS live is the fallback below: an archived Cutoffs row carries
     `supplies`, `octopus` and `other` in their own columns and NO merged field,
     because the merge is computed and never stored. Anything that rebuilds a
     figures object from that row needs the parts to add up to minor. */
  assert.strictEqual(app.noteMinorVal({ suppliesMinor: 4452 }), 4452);
  assert.strictEqual(app.noteMinorVal({ supplies_minor: 4452 }), 4452);
  // A ZERO IS A FIGURE, not an absence — it must not fall through to the parts.
  assert.strictEqual(app.noteMinorVal({ suppliesMinor: 0, supplies: 99 }), 0,
    'an explicit 0 wins over the parts');
  // NO MERGED FIELD AT ALL: an older cached reply, or an archived Cutoffs row.
  // The three parts rebuild it rather than the line reading blank.
  assert.strictEqual(app.noteMinorVal({ supplies: 244, octopus: 1500, other: 3957 }), 5701,
    'the parts rebuild it when the merged field is missing');
  assert.strictEqual(app.noteMinorVal({ supplies: 244 }), 244, 'missing parts are 0');
  assert.strictEqual(app.noteMinorVal({}), 0);
  assert.strictEqual(app.noteMinorVal(null), 0, 'and nothing at all is 0, never NaN');
  assert.strictEqual(app.noteMinorVal({ suppliesMinor: '' , supplies: 7 }), 7,
    'a BLANK merged field falls back — blank is not zero');
});

test("A DAY SAVE SAYS WHAT IT WOULD DESTROY (v2.19.0)", () => {
  // 2026-09-01, from his live sheet. A day save REPLACES its date's StockUsage
  // rows (rewriteDateBlock) rather than merging, which is right — it is how a
  // corrected night corrects. But it means the card must be showing what the
  // sheet holds, and two things silently break that.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const day = Object.keys(app.state.days).filter(d => d < app.todayStr()).sort().pop();
  assert.ok(day, 'the fixture has a past day');

  // NOTHING TO SAY about today: today is being entered, not re-entered.
  assert.strictEqual(app.daySaveRisk({ date: app.todayStr(), stock: [] }), '');
  assert.strictEqual(app.daySaveRisk({ date: '', stock: [] }), '', 'nor about a junk date');
  assert.strictEqual(app.daySaveRisk({ date: 'not-a-date', stock: [] }), '');

  // (1) NO LOCAL COPY OF A PAST DAY. The phone cannot see what it is about to
  // overwrite — this is the case that cost him real data, and the only signal
  // available is that it holds no record of the date at all.
  const unknown = app.addDays(day, -400);
  assert.ok(!app.state.days[unknown], 'precondition: the phone has never seen it');
  const blind = app.daySaveRisk({ date: unknown, stock: [] });
  assert.match(blind, /no saved copy/, 'it says the phone has nothing for that day');
  assert.match(blind, /REPLACES it with what is on screen/, 'and what saving would do');
  assert.match(blind, /the sales, the wage and the supplies opened/,
    'naming the money too — the wipe takes more than stock');
  assert.match(blind, /Sync now/, 'and the one action that fixes it first');

  // (2) DROPPING ROWS THE PHONE ITSELF HOLDS. Here it CAN name them.
  app.state.stockUsage[day] = [
    { date: day, product: 'Takoyaki Flour', qty: 17, entry_id: 'r-1' },
    { date: day, product: 'Takoyaki Sauce', qty: 3, entry_id: 'r-2' }
  ];
  const dropAll = app.daySaveRisk({ date: day, stock: [] });
  assert.match(dropAll, /will REMOVE what was logged as opened/);
  assert.match(dropAll, /Takoyaki Flour/, 'the products are NAMED');
  assert.match(dropAll, /Takoyaki Sauce/);
  assert.match(dropAll, /17/, 'with their quantities, so the size of the loss is visible');
  assert.match(dropAll, /replaces that night's supplies rather than adding/, 'and why');

  // Dropping ONE of two names only that one.
  const dropOne = app.daySaveRisk({ date: day,
    stock: [{ product: 'Takoyaki Flour', qty: 17 }] });
  assert.match(dropOne, /Takoyaki Sauce/);
  assert.ok(dropOne.indexOf('Takoyaki Flour') < 0, 'a row being kept is not reported as lost');

  // SENDING EVERYTHING BACK is silent — which is the ordinary case, and the one
  // that must not train her to tap through the dialog.
  assert.strictEqual(app.daySaveRisk({ date: day, stock: [
    { product: 'Takoyaki Flour', qty: 17 }, { product: 'Takoyaki Sauce', qty: 3 }] }), '');
  // ADDING to a night is silent too — that is the whole point of the fix he needs.
  assert.strictEqual(app.daySaveRisk({ date: day, stock: [
    { product: 'Takoyaki Flour', qty: 17 }, { product: 'Takoyaki Sauce', qty: 3 },
    { product: 'Bonito', qty: 2 }] }), '');
  // A zero is not a row: it carries no quantity, so it cannot be "lost".
  app.state.stockUsage[day] = [{ date: day, product: 'Takoyaki Flour', qty: 0, entry_id: 'r-0' }];
  assert.strictEqual(app.daySaveRisk({ date: day, stock: [] }), '');
});

test('THE CATCH-UP CHALLENGES A PLAN THAT EMPTIES THE SHELF (v2.19.0)', () => {
  // Owner, 2026-09-01. He typed 0 in every box — a natural "nothing / I do not
  // know" — and the boxes ask what is REALLY LEFT. So the plan claimed his whole
  // shelf had been opened in one night, wrote 12 flour / 4 sauce / 3 mayo /
  // 1 bonito into 2026-09-01, and his Stock-on-hand screen then read zero
  // everywhere. Every individual figure was legal; nothing warned him.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const flour = app.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  const sauce = app.state.stockItems.find(x => x.product === 'Takoyaki Sauce');
  flour.unit_cost = 120; sauce.unit_cost = 490;
  const onHand = {};
  for (const s of app.stockStatusList()) onHand[s.product] = s.on_hand;
  const withStock = Object.keys(onHand).filter(k => onHand[k] > 0);
  assert.ok(withStock.length >= 2, 'the fixture has stock on at least two products');

  // A BLANK BOX IS STILL SKIPPED — the iron rule was never broken here, which is
  // why the fix is a challenge and not a parsing change.
  assert.deepStrictEqual(app.catchUpPlan({}).rows, [], 'nothing typed, nothing planned');
  assert.deepStrictEqual(app.catchUpPlan({ 'Takoyaki Flour': '' }).rows, [], 'blank is not zero');

  // ZERO IN EVERY BOX: the plan is flagged, because nothing is left anywhere.
  const zeros = {};
  for (const k of Object.keys(onHand)) zeros[k] = '0';
  const all = app.catchUpPlan(zeros);
  assert.strictEqual(all.rows.length, withStock.length, 'one row per product that had stock');
  assert.strictEqual(all.emptiesEverything, true, 'and it is flagged as suspect');

  // ONE PRODUCT GOING TO ZERO IS ORDINARY — the last bag of bonito — and must
  // NOT be challenged, or the warning becomes noise and stops being read.
  const one = {};
  one[withStock[0]] = '0';
  assert.strictEqual(app.catchUpPlan(one).emptiesEverything, false,
    'a single product emptying is a normal night');

  // A PLAN THAT LEAVES SOMETHING is not challenged either.
  const some = {};
  for (const k of withStock) some[k] = String(Math.max(0, onHand[k] - 1));
  const partial = app.catchUpPlan(some);
  assert.ok(partial.rows.length >= 2, 'precondition: more than one row');
  assert.strictEqual(partial.emptiesEverything, false, 'one unit left is not an empty shelf');

  // THE WORDS. It names every quantity, names the mistake, and the safe answer
  // is "no" — because the plan LOOKS normal and only the whole-shelf shape gives
  // it away.
  const w = app.catchEmptyWarning(all);
  assert.match(w, /NOTHING is left of anything/);
  for (const k of withStock) assert.ok(w.indexOf(k) >= 0, 'names ' + k);
  assert.match(w, /what is REALLY LEFT on the shelf — not how much to log/,
    'it says which way round the box is, which is the whole misunderstanding');
  assert.match(w, /leave those boxes EMPTY instead/, 'and what to do instead');
  assert.match(w, /Is the shelf really empty\?$/, 'ending on the question, safe answer "no"');
});

test('SOURCE PIN: the guards are wired where they cannot be skipped (v2.19.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');

  // THE DESTRUCTION QUESTION IS ASKED FIRST. Behind "no sales are entered" it
  // would be second in a queue of dialogs, which is how dialogs stop being read.
  const save = src.slice(src.indexOf('function saveBenta(){'), src.indexOf('function saveBenta(){') + 3000);
  const risk = save.indexOf('daySaveRisk(p)');
  const noSales = save.indexOf('No sales are entered');
  assert.ok(risk > 0, 'saveBenta consults it');
  assert.ok(risk < noSales, 'and BEFORE the softer questions');
  assert.match(save, /if \(risk && !confirm\(risk\)\) return;/, 'and a "no" stops the save');

  // THE SHELF CHALLENGE IS IN THE FILL, before anything is written.
  const fill = src.slice(src.indexOf('function catchUpFill(){'), src.indexOf('function catchUpFill(){') + 1400);
  assert.match(fill, /if \(plan\.emptiesEverything && !confirm\(catchEmptyWarning\(plan\)\)\) return;/,
    'a shelf-emptying plan is challenged before it fills a night');

  // THE RESUME REFRESH. Wired into onAppResume, and guarded on every state where
  // a background fetch would be wrong.
  const resume = src.slice(src.indexOf('function onAppResume(){'), src.indexOf('function onAppResume(){') + 1800);
  assert.match(resume, /maybeRefresh\(\);/, 'resume pulls fresh figures');
  const mr = src.slice(src.indexOf('function maybeRefresh(){'), src.indexOf('async function doBootstrap(){'));
  for (const guard of ['config.apiUrl', 'syncing', 'asArr(queue).length', 'isTypingNow']){
    assert.ok(mr.indexOf(guard) >= 0, 'maybeRefresh guards on ' + guard);
  }
  assert.match(mr, /doBootstrap\(\)\.catch\(\(\) => \{\}\)/, 'and it is silent on failure');

  // The stamp is set ONLY on a bootstrap that landed, or a run of failures goes
  // quiet for five minutes on a stale screen.
  const boot = src.slice(src.indexOf('async function doBootstrap(){'), src.indexOf('function applyBootstrap(data){'));
  const stamp = boot.indexOf('lastBootstrapAt = Date.now()');
  const catchAt = boot.indexOf('}catch(e){');
  assert.ok(stamp > 0 && stamp < catchAt, 'stamped in the success path only');
  assert.ok(boot.indexOf('applyBootstrap(data)') < stamp, 'and after the reply is applied');
});

test('A LIST OF DATED AMOUNTS, TYPED ONCE (v2.18.0)', () => {
  // Owner, 2026-09-01: "can you add the supplies I sent to you, I dont want to
  // input manually" — after writing out ten back-dated expenses in one message
  // rather than making ten trips through a date picker. This parses exactly the
  // shape he wrote them in.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const aug = { start: '2026-08-16', end: '2026-08-31' };

  // HIS ACTUAL MESSAGE, pasted verbatim.
  const his = ['8/16 - 244','8/18 - 504','8/19 - 680','8/21 - 446','8/23 - 318',
               '8/26 - 170','8/27 - 1075','8/28 - 255','8/29 - 200','8/31 - 65'].join('\n');
  const p = app.parseDatedAmounts(his, aug);
  assert.strictEqual(p.ok, true, 'his own format reads, exactly as he typed it');
  assert.strictEqual(p.bad, 0);
  assert.strictEqual(p.rows.length, 10);
  assert.strictEqual(p.total, 3957, 'and the batch total is his figure');
  assert.deepStrictEqual(p.rows.map(r => r.date).slice(0, 3),
    ['2026-08-16', '2026-08-18', '2026-08-19'], 'the YEAR comes from the cutoff on screen');
  assert.strictEqual(p.rows[6].amount, 1075, 'a four-figure amount is not truncated');

  // THE SEPARATOR IS NOT A MINUS SIGN. "8/16 - 244" is 244, never -244: a
  // negative here would subtract money from the fortnight it was meant to add.
  assert.ok(p.rows.every(r => r.amount > 0), 'every amount is positive');

  // THE SHAPES HE MIGHT TYPE INSTEAD, all the same day.
  for (const line of ['8/16 - 244', '8/16 244', '08/16 - 244', '8-16 - 244',
                      '2026-08-16 - 244', '16 - 244', '8/16: 244', '8/16 ₱244',
                      '8/16 - 1,244']){
    const one = app.parseDatedAmounts(line, aug);
    assert.strictEqual(one.bad, 0, 'should read: ' + line + ' — ' + (one.rows[0] || {}).error);
    assert.strictEqual(one.rows[0].date, '2026-08-16', 'wrong date for: ' + line);
  }
  assert.strictEqual(app.parseDatedAmounts('8/16 - 1,244', aug).rows[0].amount, 1244,
    'a thousands comma is a separator, not a decimal point');

  // BLANK LINES ARE NOT LINES, so a pasted list with gaps still reads.
  assert.strictEqual(app.parseDatedAmounts('\n8/16 - 244\n\n  \n8/18 - 504\n', aug).rows.length, 2);
  assert.strictEqual(app.parseDatedAmounts('', aug).ok, false, 'nothing typed is not a batch');
  assert.strictEqual(app.parseDatedAmounts(null, aug).rows.length, 0, 'and neither is nothing');

  // A DATE OUTSIDE THE CUTOFF IS AN ERROR, never quietly filed elsewhere. The
  // one thing worse than retyping ten expenses is ten of them landing in a
  // fortnight he has already settled with his partner.
  const out = app.parseDatedAmounts('8/16 - 244\n7/20 - 100', aug);
  assert.strictEqual(out.ok, false, 'the batch refuses while any line is wrong');
  assert.strictEqual(out.bad, 1);
  assert.match(out.rows[1].error, /not in this cutoff/);
  assert.strictEqual(out.total, 244, 'and the bad line adds nothing to the total');

  // NOTHING SAVES WHILE ANYTHING IS UNREADABLE — half a list of money is worse
  // than none of it.
  const junk = app.parseDatedAmounts('8/16 - 244\nbought some veggies\n8/18 - 504', aug);
  assert.strictEqual(junk.ok, false);
  assert.strictEqual(junk.bad, 1);
  assert.strictEqual(junk.rows[1].raw, 'bought some veggies',
    'the line is quoted back so he can see which one to fix');
  assert.match(junk.rows[1].error, /Could not read this line/);

  // AN IMPOSSIBLE DATE SAYS SO, rather than being reported as a cutoff problem.
  // isDateStr only checks the SHAPE — "2026-13-15" and "2026-02-30" both pass it
  // — and either would then be measured against the period and come back as
  // "not in this cutoff", which sends him looking for the wrong problem.
  for (const bad of ['13/15 - 100', '2/30 - 100', '13/40 - 100', '44 - 100', '2026-02-30 - 100']){
    const r = app.parseDatedAmounts(bad, aug).rows[0];
    assert.match(r.error, /not a real date/, bad + ' -> ' + r.error);
  }
  // And a REAL date outside the cutoff still gets the cutoff message, so the two
  // complaints are never confused with each other.
  assert.match(app.parseDatedAmounts('7/20 - 100', aug).rows[0].error, /not in this cutoff/);

  // A BAD ROW CARRIES NO AMOUNT. This is what lets the batch total simply sum
  // every row: there is no such thing as a rejected line with money on it.
  const mixed = app.parseDatedAmounts(
    '8/16 - 244\nnonsense\n13/15 - 999\n2026-02-30 - 999\n7/20 - 999\n00 - 999', aug);
  for (const r of mixed.rows){
    if (r.error) assert.strictEqual(r.amount, null, 'a rejected line has no amount: ' + r.raw);
  }
  assert.strictEqual(mixed.total, 244, 'so the total is the readable lines alone');

  // ZERO AND NEGATIVE ARE REFUSED, not coerced.
  for (const bad of ['8/16 - 0', '8/16 - 0.00']){
    assert.match(app.parseDatedAmounts(bad, aug).rows[0].error, /more than zero/, bad);
  }

  // A DAY THAT HAS NOT HAPPENED cannot have money spent on it — the server
  // refuses it, so the preview refuses it first, where he can see why.
  const sep = app.currentPeriod(app.todayStr());
  const future = app.parseDatedAmounts(app.addDays(app.todayStr(), 1).slice(8) + ' - 100', sep);
  assert.match(future.rows[0].error, /has not happened yet/);

  // A CUTOFF SPANNING TWO MONTHS: a bare day that falls in both is ambiguous
  // and SAYS so rather than picking one.
  const span = { start: '2026-07-30', end: '2026-08-14' };
  assert.strictEqual(app.parseDatedAmounts('8/1 - 50', span).rows[0].date, '2026-08-01',
    'a month/day still resolves across the boundary');
  assert.strictEqual(app.parseDatedAmounts('31 - 50', span).rows[0].date, '2026-07-31',
    'and a bare day resolves to whichever month contains it');

  // A BARE DAY THAT FALLS IN BOTH MONTHS is AMBIGUOUS, and says so rather than
  // picking one. No real cutoff (1-15, 16-end) spans two months, so this cannot
  // come from currentPeriod — but the parser takes any period, and silently
  // guessing a month would be the worst thing it could do with money.
  const wide = { start: '2026-07-20', end: '2026-08-25' };
  const ambBatch = app.parseDatedAmounts('7/21 - 40\n22 - 50', wide);
  const amb = ambBatch.rows[1];
  assert.strictEqual(amb.date, null, 'nothing is guessed');
  assert.strictEqual(amb.amount, null, 'and no money rides on a line that was refused');
  assert.strictEqual(ambBatch.total, 40, 'so the total is the readable line alone');
  assert.match(amb.error, /falls twice in this cutoff/);
  assert.match(amb.error, /Write the month too/, 'and says how to fix it');
  assert.strictEqual(app.parseDatedAmounts('7\/22 - 50', wide).rows[0].date, '2026-07-22',
    'naming the month resolves it');

  // A YEAR BOUNDARY: December 16-31 and January 1-15 are different cutoffs, and
  // the year must come from the period rather than from today.
  const dec = { start: '2025-12-16', end: '2025-12-31' };
  assert.strictEqual(app.parseDatedAmounts('12/20 - 300', dec).rows[0].date, '2025-12-20');
});

test('THE PASTED BATCH CANNOT DOUBLE-CHARGE A CUTOFF (v2.18.0)', () => {
  // The one irreversible mistake this feature could make is charging a fortnight
  // twice. The entry id is derived from (bucket, date), so a second tap of Save
  // UPSERTS the same rows rather than adding a second set — impossible by
  // construction rather than by being careful.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  assert.strictEqual(app.datedAmountId('Veggies', '2026-08-16'), 'bulk-veggies-2026-08-16');
  assert.strictEqual(app.datedAmountId('Veggies', '2026-08-16'),
    app.datedAmountId('Veggies', '2026-08-16'), 'stable across calls');
  assert.notStrictEqual(app.datedAmountId('Veggies', '2026-08-16'),
    app.datedAmountId('Veggies', '2026-08-18'), 'but not across dates');
  assert.notStrictEqual(app.datedAmountId('Veggies', '2026-08-16'),
    app.datedAmountId('Other', '2026-08-16'), 'nor across buckets');
  // A bucket name is SHEET DATA and may carry anything; the id must stay a safe,
  // stable key rather than smuggling punctuation into an entry_id.
  assert.strictEqual(app.datedAmountId("Mama's <b>Sauce</b>", '2026-08-16'),
    'bulk-mama-s-b-sauce-b-2026-08-16');
  assert.ok(/^[a-z0-9-]+$/.test(app.datedAmountId("Mama's <b>Sauce</b>", '2026-08-16')),
    'nothing but lowercase, digits and dashes');

  // AND THE UPSERT REALLY REPLACES. Two saves of the same (bucket, date) leave
  // ONE row, at the second amount — the sheet upserts by entry_id, and the
  // phone's own applier must agree with it or the two disagree until a sync.
  const id = app.datedAmountId('Veggies', '2026-08-16');
  const base = { date: '2026-08-16', category: 'Supplies', item: 'Veggies',
    backlogRef: '', notes: '', paidFrom: 'tin', entryId: id };
  app.applyLocalExpense({ ...base, amount: 244 });
  app.applyLocalExpense({ ...base, amount: 244 });
  const hits = Object.values(app.state.expenses).filter(e => e && e.entry_id === id);
  assert.strictEqual(hits.length, 1, 'one row, not two');
  assert.strictEqual(hits[0].amount, 244);
  app.applyLocalExpense({ ...base, amount: 61 });
  assert.strictEqual(Object.values(app.state.expenses).filter(e => e && e.entry_id === id).length, 1);
  assert.strictEqual(app.state.expenses[id].amount, 61, 'a corrected paste corrects the row');
  assert.strictEqual(app.gastosFor({ start: '2026-08-16', end: '2026-08-31' })
    .filter(e => e.entry_id === id).length, 1, 'and the list shows it once');
});

test('SOURCE PIN: the pasted batch is previewed, never auto-saved (v2.18.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const block = src.slice(src.indexOf('function bulkBlockHTML(per){'), src.indexOf('function submitGasto(){'));
  assert.ok(block.length > 500, 'the block must be findable');

  // THE SAVE BUTTON DOES NOT EXIST while any line is unreadable. Not disabled —
  // absent, so there is nothing to tap and nothing to explain away.
  assert.match(block, /asObj\(parsed\)\.ok\s*\n?\s*\?\s*'<button[^']*data-act="bulk-save"/,
    'Save is drawn only when every line reads');
  assert.match(block, /peso\(parsed\.total\)/, 'and it says the total it is about to add');

  // AND IT LIVES INSIDE THE PATCHED REGION. Typing rewrites only #bulkPreview,
  // and whether Save exists at all depends on what was typed — outside it, he
  // pastes a perfect list and finds nothing to tap. Found by pasting his real
  // list into the real screen, not by any assertion.
  const preview = src.slice(src.indexOf('function bulkPreviewHTML('), src.indexOf('function saveBulk(){'));
  assert.match(preview, /bulkActionsHTML\(parsed\)/,
    'the buttons are part of what the preview returns');
  assert.ok((preview.match(/bulkActionsHTML\(parsed\)/g) || []).length >= 2,
    'including the nothing-typed-yet case, or Close vanishes on an empty box');
  const shell = src.slice(src.indexOf('function bulkBlockHTML(per){'), src.indexOf('function bulkPreviewHTML('));
  assert.ok(shell.indexOf('bulk-save') < 0,
    'and Save is NOT drawn outside the region typing can reach');

  // NOTHING AUTO-SAVES: the save path is a tap, and it confirms first.
  assert.match(block, /function saveBulk\(\)/);
  const save = src.slice(src.indexOf('function saveBulk(){'), src.indexOf('function submitGasto(){'));
  assert.match(save, /if \(!parsed\.ok\) return;/, 'a bad batch cannot be saved at all');
  assert.match(save, /confirm\(/, 'and a good one is confirmed with its total');
  assert.match(save, /entryId: datedAmountId\(gxBulk\.pick, r\.date\)/,
    'every row gets the STABLE id — this is what stops a double charge');
  assert.ok(save.indexOf('uuid()') < 0,
    'a fresh id per save would double-charge the cutoff on a second tap');
  assert.match(save, /enqueue\('saveExpense', payload\)/, 'and each row goes to the sheet');

  // A PICKLIST NAME FILES UNDER SUPPLIES, with its own name as the item —
  // exactly as the single-entry form does. Filing "Veggies" as category
  // "Veggies" would be a category the server refuses outright.
  assert.match(save, /category: isBucket \? gxBulk\.pick : 'Supplies'/,
    'a picklist bucket is a Supplies row, not its own category');
  assert.match(save, /item: isBucket \? '' : gxBulk\.pick/, 'and its name is the item');
  assert.match(save, /const isBucket = gxBulk\.pick === 'Octopus' \|\| gxBulk\.pick === 'Other'/,
    'the two real category buckets are the only exceptions');

  // PAID FROM IS WHITELISTED. The server refuses anything outside the three, and
  // it refuses the WHOLE row — ten rows lost to one bad chip value.
  assert.match(save, /paidFrom: gxBulk\.paidFrom === 'gcash' \|\| gxBulk\.paidFrom === 'own' \? gxBulk\.paidFrom : 'tin'/,
    'anything but gcash or own falls back to the tin, never through unchecked');

  // THE PREVIEW IS ITS OWN STRING so typing can patch it without rebuilding the
  // panel — v2.13.1's bug, pinned generally by the v2.13.2 guard as well.
  assert.match(block, /id="bulkPreview"/);
  const listener = src.slice(src.indexOf("document.addEventListener('input'"),
                             src.indexOf("document.addEventListener('change'"));
  assert.match(listener, /id === 'bulkText'/, 'the textarea is read as it is typed');
  assert.match(listener, /bulkPreviewHTML\(/, 'and only the preview is rewritten');

  // AN OVERWRITE IS NEVER A SURPRISE: a stable id means a second paste replaces,
  // and the preview says so per line before anything is saved.
  assert.match(block, /replaces /, 'the preview names what a row will replace');
});

test('SUPPLIES IN TWO LINES: major is opened, minor is the daily buying (v2.16.0)', () => {
  // Owner, 2026-09-01, in his words: "we need to add one more line to the total
  // card in the cutoff tab / supplies(major) this consists of the supplies used
  // this cutoff card / supplies(minor) this totalts the things inputted daily,
  // eggs, flour, veggies, etc".
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const flour = app.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  const sauce = app.state.stockItems.find(x => x.product === 'Takoyaki Sauce');
  flour.unit_cost = 120; flour.unit = 'pack';
  sauce.unit_cost = 490; sauce.unit = 'gallon';
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  const per = app.currentPeriod('2026-08-20');

  // A NIGHT OF DAILY BUYING inside the cutoff — one of EACH bucket the Expenses
  // screen offers, because v2.20.0 folds all three into minor and a fixture with
  // octopus and other at zero cannot tell the merge from the category alone.
  app.applyLocalExpense({ date: '2026-08-21', category: 'Supplies', item: 'Veggies',
    amount: 260, backlogRef: '', notes: '', entryId: 'minor-1' });
  app.applyLocalExpense({ date: '2026-08-23', category: 'Supplies', item: 'Eggs',
    amount: 140, backlogRef: '', notes: '', entryId: 'minor-2' });
  app.applyLocalExpense({ date: '2026-08-22', category: 'Octopus', item: '',
    amount: 1500, backlogRef: '', notes: '', entryId: 'minor-3' });
  app.applyLocalExpense({ date: '2026-08-24', category: 'Other', item: '',
    amount: 700, backlogRef: '', notes: '', entryId: 'minor-4' });

  // NOTHING OPENED IS LOGGED: the major is NOT ZERO, it is UNKNOWN. A ₱0 here
  // would read as a fortnight that consumed nothing, which is the one thing a
  // fortnight of takoyaki never does.
  let sup = app.suppliesSplit(app.computeCutoff(per));
  assert.strictEqual(sup.majorKnown, false, 'blank is never zero');
  assert.strictEqual(sup.major, null);
  assert.match(sup.why, /Nothing is logged as opened this cutoff/);
  assert.match(sup.why, /Remaining may be too high/,
    'v2.22.0: nothing logged means nothing DEDUCTED, which is the part that matters');

  // OPENED: six packs and two gallons across two nights of the cutoff.
  app.state.stockUsage['2026-08-20'] = [
    { date: '2026-08-20', product: 'Takoyaki Flour', qty: 4, entry_id: 'u1' },
    { date: '2026-08-20', product: 'Takoyaki Sauce', qty: 2, entry_id: 'u2' }
  ];
  app.state.stockUsage['2026-08-22'] = [
    { date: '2026-08-22', product: 'Takoyaki Flour', qty: 2, entry_id: 'u3' }
  ];
  const f = app.computeCutoff(per);
  sup = app.suppliesSplit(f);
  assert.strictEqual(sup.major, 6 * 120 + 2 * 490, 'MAJOR is the value opened, at cost');
  assert.strictEqual(sup.majorKnown, true);

  // MINOR IS THE ALLOCATION, UNTOUCHED. It is Expenses filed under Supplies —
  // which is every picklist bucket, i.e. the daily buying — and it is exactly
  // what the note's "Supplies" line and the total's arithmetic already used.
  // v2.20.0: MINOR is every bucket on the Expenses screen, not the Supplies
  // category alone — which is exactly the bug that sent his ₱3,957 to a line he
  // was not reading.
  assert.strictEqual(sup.minor, f.supplies + f.octopus + f.other,
    'MINOR is supplies + octopus + other');
  assert.notStrictEqual(sup.minor, f.supplies,
    'and demonstrably NOT the Supplies category on its own');
  assert.ok(f.octopus > 0 && f.other > 0, 'the fixture exercises all three parts');

  // THE TWO ARE NEVER ADDED. The same bag is minor when bought and major when
  // opened; a sum of both would charge the business twice for one bag.
  assert.notStrictEqual(sup.minor, sup.minor + sup.major,
    'precondition: the two figures differ, so a mix-up would show');
  // v2.22.0: the major is an allocation, so the identity carries it.
  assert.strictEqual(f.total, f.mama + f.split + f.suppliesMinor + f.suppliesUsed +
    f.salary + f.electric + f.remaining,
    'total = mama + split + minor + used + salary + electric + remaining');
  // AND THE ROW ITSELF CARRIES THE STATEMENT, not this sentence. With everything
  // priced there is NOTHING to say here: the row's own "not in the total" tag
  // answers it, and the long paid-versus-opened reasoning is one card up. A
  // paragraph inside the column of figures pushes Octopus, Salary and Electric
  // down the screen — found by looking at it on a phone, not by any assertion.
  assert.strictEqual(sup.why, '',
    'nothing wrong, nothing missing, nothing to say inside the figures');

  // NOTHING PRICED AT ALL: quantities real, money unknown, and where to fix it.
  flour.unit_cost = ''; sauce.unit_cost = '';
  sup = app.suppliesSplit(app.computeCutoff(per));
  assert.strictEqual(sup.majorKnown, false, 'not ₱0 — unknown');
  assert.strictEqual(sup.major, null);
  assert.match(sup.why, /No product has a cost set/);
  assert.match(sup.why, /NOTHING\s*' \+\s*'?\s*is deducted|NOTHING is deducted/,
    'and that nothing is deducted for it');
  assert.match(sup.why, /Remaining is too high/, 'naming the consequence');
  assert.match(sup.why, /More → Maintenance/, 'and the door that fixes it');

  // PARTLY PRICED: the major is the priceable part, and the rest is NAMED
  // rather than quietly folded in at nothing.
  flour.unit_cost = 120;
  sup = app.suppliesSplit(app.computeCutoff(per));
  assert.strictEqual(sup.major, 720, 'the priced part only');
  assert.strictEqual(sup.majorKnown, true);
  assert.match(sup.why, /^Takoyaki Sauce has no cost set/, 'the unpriced product is named');
  assert.match(sup.why, /counted but not valued/);
  // v2.22.0: it also has to name the CONSEQUENCE, which is new and serious — an
  // unvalued product now makes the DEDUCTION short and Remaining too high, i.e.
  // money he might take out that is already spoken for. Worth the extra words.
  assert.match(sup.why, /the deduction is short/, 'and what that costs him');
  assert.ok(sup.why.length < 160, 'still one sentence, inside a column of figures');

  // A TYPED SPLIT MUST NOT LOSE IT. liveCutoff runs the figures back through
  // cutoffWithSplit, and a merged field dropped there would blank the minor line
  // the moment he touched the Split field.
  const withSplit = app.cutoffWithSplit(f, 4000);
  assert.strictEqual(withSplit.suppliesMinor, sup.minor, 'the merge survives a typed split');
  assert.strictEqual(app.suppliesSplit(withSplit).minor, sup.minor);
  assert.ok(app.buildNote(withSplit, per).indexOf('Supplies (minor) - ' + app.fmt(sup.minor)) > 0,
    'and the note still prints it');
  assert.strictEqual(withSplit.split, 4000, 'precondition: the split really changed');

  // THE MAJOR MOVES THE RESIDUAL AND NOTHING ELSE (v2.22.0) — and by exactly
  // its own value, which is a tighter statement than the "moves nothing" this
  // asserted for six releases.
  const withUsage = app.computeCutoff(per);
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  const without = app.computeCutoff(per);
  for (const k of ['total', 'cash', 'gcash', 'supplies', 'suppliesMinor',
                   'octopus', 'other', 'mama', 'electric', 'salary', 'split']){
    assert.deepStrictEqual(withUsage[k], without[k], 'the major moved ' + k);
  }
  assert.strictEqual(app.r2(without.remaining - withUsage.remaining), withUsage.suppliesUsed,
    'the residual falls by precisely the value opened');
  assert.strictEqual(app.suppliesSplit(without).minor, app.suppliesSplit(withUsage).minor,
    'and the minor does not move when what was opened changes');
});

test('SOURCE PIN: the total card carries both supplies lines, and only one sums (v2.16.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = src.indexOf("'<div class=\"co-row\"><span>Supplies (minor)</span>");
  assert.ok(at > 0, 'the total card must carry the MINOR line');
  const card = src.slice(at, at + 900);

  // MINOR is the merged figure since v2.20.0 — everything entered on the
  // Expenses screen — and it comes from suppliesSplit so the card and the note
  // can never disagree about what "minor" means.
  assert.match(card, /Supplies \(minor\)<\/span><span class="v">' \+ peso\(sup\.minor\)/,
    'minor prints the merged figure from the one rule that defines it');
  assert.ok(card.indexOf('peso(f.supplies)') < 0,
    'and never the Supplies CATEGORY alone — that is the bug this replaced');
  // The two folded rows are gone from the card, or the column would not add up.
  assert.ok(card.indexOf('>Octopus<') < 0, 'no separate Octopus row');
  assert.ok(card.indexOf('>Other payments<') < 0, 'no separate Other payments row');

  // MAJOR comes from the helper, prints '—' when unknown, and says on its face
  // that it is not in the total. A muted style alone is not a statement.
  assert.match(card, /Supplies \(major\)/, 'and the MAJOR line beside it');
  // v2.22.0: major IS one of the summing rows now, so it is drawn as one — no
  // aside styling and no "not in the total", both of which would now be lies.
  assert.ok(card.indexOf('class="co-row aside"') < 0,
    'the major row is an ordinary summing row now');
  assert.ok(card.indexOf('not in the total') < 0,
    'and must not still claim otherwise');
  assert.match(card, /sup\.majorKnown \? peso\(sup\.major\) : '—'/,
    "unknown prints an em dash, never ₱0");
  assert.match(card, /esc\(sup\.why\)/, 'and the explanation is escaped');
  // NOTHING TO SAY, NOTHING DRAWN. The row lives inside the column of figures,
  // so the paragraph must be conditional or it pushes the rest of the block down
  // every fortnight — including the ordinary fortnight where all is well.
  assert.match(card, /\(sup\.why \? '<p class="hint"/,
    'the paragraph is drawn only when there is something wrong or missing');

  // The residual is still computed from the allocations alone: the major appears
  // nowhere in liveCutoff or in the residual row.
  const live = src.slice(src.indexOf('function liveCutoff('), src.indexOf('function liveCutoff(') + 1800);
  assert.ok(live.indexOf('suppliesUsed') < 0 && live.indexOf('suppliesSplit') < 0,
    'the residual may never see what was opened');

  // The ASIDE style must exist, or the row reads as one of the summing rows.
  assert.match(src, /\.co-row\.aside\{/, 'the aside row has its own style');
});

test('CATCH UP can target a cutoff that has ENDED (v2.14.1)', () => {
  // Owner, 2026-09-01: "wheres the value of the used supplies last cutoff". The
  // fortnight nobody logged had ended, and v2.13.1's auto-pick deliberately
  // stayed inside the current cutoff — so the value could never land where he
  // needed it. That guard was justified as "restating money that has moved",
  // which is not true of this figure: it is display only, and the note ignores
  // it. So the auto-pick is now a DEFAULT, not a prohibition.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const flour = app.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  flour.unit_cost = 120; flour.unit = 'pack';
  flour.baseline_date = ''; flour.baseline_qty = 8;
  flour.delivered_before = 0; flour.used_before = 0;
  for (const k in app.state.days) delete app.state.days[k];
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  for (const k in app.state.stockDeliveries) delete app.state.stockDeliveries[k];

  // With no choice made, it still picks for her, inside the current cutoff.
  app.catchNightPick = '';
  const auto = app.catchUpTarget();
  assert.strictEqual(auto, app.catchUpNight(), 'no choice means the automatic pick');
  const nowPer = app.currentPeriod(app.todayStr());
  assert.ok(auto >= nowPer.start && auto <= nowPer.end, 'and that pick stays in this cutoff');

  // HIS CASE: a night in the cutoff that has already ended.
  const lastPer = app.shiftPeriod(nowPer, -1);
  app.catchNightPick = lastPer.end;
  assert.strictEqual(app.catchUpTarget(), lastPer.end,
    'a night in a finished cutoff is allowed — that is the whole point');

  // It SAYS where the value lands, and — since v2.19.0 — the TRUTH about the
  // note. This sentence used to promise "nothing in the note", which v2.15.0
  // made false when it put the supplies-used line INTO the note. It is the
  // sentence that tells him a settled cutoff is safe to touch, so a false
  // reassurance here is worse than no sentence at all.
  // v2.22.0 changed it again: the opened value is DEDUCTED now, so this sentence
  // has to admit the Remaining moves too. What genuinely cannot move — and is
  // what makes a past night safe to choose — is the Total and the Split.
  const lands = app.catchLandsText(lastPer.end);
  assert.match(lands, /cutoff, which has already ended/, 'it names the fortnight and its state');
  assert.match(lands, /Supplies used/, 'and what changes there');
  assert.match(lands, /AND its Remaining/, 'it admits the RESIDUAL moves — that is the deduction');
  assert.match(lands, /what was opened is deducted now/, 'and says why in plain words');
  assert.match(lands, /no Total and no Split/,
    'and what still cannot change, which is what makes choosing a past night safe');
  assert.ok(!/money PAID, not from stock opened/.test(lands),
    'the v2.19.0 wording claimed every settled figure was money PAID — false since v2.22.0');
  assert.ok(!/nothing in the note/.test(lands) && !/no total and no share/.test(lands),
    'neither earlier false promise survives');

  // A night in THIS cutoff says so instead.
  assert.match(app.catchLandsText(auto), /the one running now/);

  // A FUTURE night is refused and falls back to the automatic pick — nothing
  // can be logged as opened on a night that has not happened.
  app.catchNightPick = app.addDays(app.todayStr(), 3);
  assert.strictEqual(app.catchUpTarget(), app.catchUpNight(), 'a future night is not taken');
  app.catchNightPick = 'not-a-date';
  assert.strictEqual(app.catchUpTarget(), app.catchUpNight(), 'nor is nonsense');

  // AND THE VALUE REALLY LANDS THERE. Fill the chosen night, save it, and the
  // ENDED cutoff is the one whose "Supplies used" moves.
  app.catchNightPick = lastPer.end;
  app.state.days[lastPer.end] = { date: lastPer.end, closed: false, total: 2000, cash: 2000, gcash: 0 };
  const beforeLast = app.computeCutoff(lastPer).suppliesUsed;
  const beforeNow = app.computeCutoff(nowPer).suppliesUsed;
  app.catchDraft['Takoyaki Flour'] = 2;          // 8 believed, 2 there => 6 opened
  app.catchUpFill();
  app.applyLocalDay(app.bentaPayload());
  assert.strictEqual(app.computeCutoff(lastPer).suppliesUsed, beforeLast + 6 * 120,
    'the ENDED cutoff now shows the value of what was opened');
  assert.strictEqual(app.computeCutoff(nowPer).suppliesUsed, beforeNow,
    'and the running cutoff is untouched');
  // The chosen night is CLEARED afterwards, so the next catch-up starts from
  // the automatic pick rather than silently reusing a fortnight that has ended.
  assert.strictEqual(app.catchNightPick, '',
    'a past night must not linger as the default for the next catch-up');

  // The note for that ended fortnight is still built from money PAID only.
  const f = app.computeCutoff(lastPer);
  const noteWith = app.buildNote(f, lastPer);
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  // v2.22.0: the opened value AND the residual both change — that is what he
  // asked for. Every other line of a settled fortnight's note stays put.
  assert.strictEqual(noteFixed(noteWith), noteFixed(app.buildNote(app.computeCutoff(lastPer), lastPer)),
    'logging usage into a finished cutoff changes only the opened value and the residual');
});

test('THE NOTE CARRIES THE SUPPLIES USED, and the two builders agree (v2.15.1)', () => {
  // Owner, 2026-09-01: "theres a breakdown in the cutoff, but its still not
  // shown in note." It is now — and on his instruction, "I just want to see it
  // in the supplies section," it sits DIRECTLY BENEATH the Supplies line rather
  // than in a footer. It is still in NO sum: the seven allocation lines add with
  // the residual to Total, and that identity is what his partner checks.
  const srv = loadServer();
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data;
  const app = syncedClient(boot);
  const D = ymdDaysAgo(2);
  const per = app.currentPeriod(D);

  // Give one product a cost and open some of it on a night in the period.
  const items = boot.stockItems.map(x => ({ product: x.product, unit: x.unit, active: x.active,
    reorderAt: x.reorder_at, unitCost: x.product === 'Takoyaki Flour' ? 120 : '' }));
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: items } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 20, eod: 0, entryId: 'n1' }],
    stock: [{ product: 'Takoyaki Flour', qty: 6 }], entryId: 'note-used-1' } }).ok, true);

  const cut = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cut.ok, true, cut.error);

  // THE SERVER writes it, at cost, in the supplies section.
  assert.strictEqual(cut.data.figures.supplies_used, 720, '6 x 120');
  const lines = cut.data.note_text.split('\n');
  const at = lines.findIndex(l => l.indexOf('Supplies used (opened) - ') === 0);
  assert.ok(at > 0, 'the line is in the note');
  assert.strictEqual(lines[at], 'Supplies used (opened) - 720');
  assert.ok(lines[at - 1].indexOf('Supplies (minor) - ') === 0,
    'DIRECTLY BENEATH the Supplies line, which is what he asked for');
  assert.ok(/^(Remaining|Short) - /.test(lines[lines.length - 1]),
    'and the residual is still the LAST line — the footer is gone');

  // THE ALLOCATIONS ARE UNTOUCHED — nothing was added to any sum.
  const f = cut.data.figures;
  // v2.22.0: the line is an allocation, so it is IN the identity now.
  assert.strictEqual(f.total, f.mama + f.split + f.supplies_minor + f.supplies_used +
    f.salary + f.electric + f.remaining,
    'the identity his partner checks still holds with the line present');
  assert.strictEqual(f.total, f.mama + f.split + f.supplies + f.octopus + f.salary +
    f.other + f.electric + f.supplies_used + f.remaining,
    'and so does the seven-part version with the opened value added');

  // THE PHONE BUILDS THE SAME NOTE, byte for byte — the two builders must never
  // drift, and this figure is computed independently on each side.
  const app2 = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const local = app2.computeCutoff(per);
  assert.strictEqual(local.suppliesUsed, 720, 'the phone prices it identically');
  assert.strictEqual(app2.buildNote(local, per), cut.data.note_text,
    'and writes the same note the sheet does, that line included');

  // A PRODUCT WITH NO COST is counted apart and SAID, never priced at nothing.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 20, eod: 0, entryId: 'n1' }],
    stock: [{ product: 'Takoyaki Flour', qty: 6 }, { product: 'Japanese Mayo', qty: 3 }],
    entryId: 'note-used-1' } }).ok, true);
  const cut2 = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cut2.data.figures.supplies_used, 720, 'the uncosted mayo adds no money');
  assert.strictEqual(cut2.data.figures.supplies_used_unpriced, 1);
  assert.match(cut2.data.note_text, /Supplies used \(opened\) - 720 \+ 1 with no cost set/,
    'and the note says how many it could not price, rather than quietly understating');
  const app3 = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  assert.strictEqual(app3.buildNote(app3.computeCutoff(per), per), cut2.data.note_text,
    'the phone matches that too');

  // NO USAGE AT ALL: the line BLANKS rather than vanishing, exactly as an empty
  // category blanks ("Octopus - "), so the note keeps one shape all fortnight.
  const empty = app3.currentPeriod(app3.addDays(per.start, -20));
  const none = app3.buildNote(app3.computeCutoff(empty), empty);
  assert.match(none, /\nSupplies used \(opened\) - \n/,
    'nothing opened means a blank value, not a missing line');
});

test("HIS SHEET, 2026-09-01: the catch-up must not double what it filled (v2.14.2)", () => {
  // Read out of his live sheet. StockUsage for 2026-08-31 held Flour 34, Sauce 6,
  // Mayo 4 — EXACTLY DOUBLE the 17/3/2 the catch-up works out from his counts.
  // The cause: catchUpFill ADDS to the row, and on-hand only moves when the day
  // is SAVED, so filling twice before saving computes the same figure twice and
  // stacks it. It also produced the negative on-hand he reported: before his
  // Aug 31 count, flour read 10 + 10 − 35 = −15.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const P = 'Takoyaki Flour';
  const it = app.state.stockItems.find(x => x.product === P);
  it.unit = 'kg'; it.unit_cost = '';
  it.baseline_date = ''; it.baseline_qty = 19;    // 10 counted + 10 arrived − 1 opened
  it.delivered_before = 0; it.used_before = 0;
  for (const k in app.state.days) delete app.state.days[k];
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  for (const k in app.state.stockDeliveries) delete app.state.stockDeliveries[k];
  const N = app.catchUpNight();
  app.state.days[N] = { date: N, closed: false, total: 2000, cash: 2000, gcash: 0 };

  const qty = () => Number(app.benta.stock.find(r => r.product === P).qty);

  // One fill: 19 believed, 2 counted => 17.
  app.catchDraft[P] = 2;
  app.catchUpFill();
  assert.strictEqual(qty(), 17, 'the first fill puts 17 on the night');

  // A SECOND fill, before saving, must REPLACE its own work — not stack it.
  app.catchDraft[P] = 2;
  app.catchUpFill();
  assert.strictEqual(qty(), 17, 'a second tap must not make it 34');
  app.catchDraft[P] = 2;
  app.catchUpFill();
  assert.strictEqual(qty(), 17, 'nor a third');

  // A figure that was ALREADY on the night, before the catch-up touched it,
  // still survives — that is why it adds rather than assigns.
  const app2 = loadClient();
  app2.applyBootstrap(F.boot);
  const it2 = app2.state.stockItems.find(x => x.product === P);
  it2.baseline_date = ''; it2.baseline_qty = 19;
  it2.delivered_before = 0; it2.used_before = 0;
  for (const k in app2.state.days) delete app2.state.days[k];
  for (const k in app2.state.stockUsage) delete app2.state.stockUsage[k];
  for (const k in app2.state.stockDeliveries) delete app2.state.stockDeliveries[k];
  const N2 = app2.catchUpNight();
  app2.state.days[N2] = { date: N2, closed: false, total: 2000, cash: 2000, gcash: 0 };
  app2.state.stockUsage[N2] = [{ date: N2, product: P, qty: 3, entry_id: 'pre' }];
  app2.catchDraft[P] = 2;
  app2.catchUpFill();
  const withPrior = Number(app2.benta.stock.find(r => r.product === P).qty);
  // 17 again — and that is the arithmetic being SELF-CONSISTENT, not a bug: the
  // 3 already logged has already pulled on-hand down to 16, so the catch-up
  // works out 14, and 3 + 14 = 17. However the total is split between what was
  // logged and what is caught up, it reconciles to "counted 2 out of 19".
  assert.strictEqual(withPrior, 17,
    'the total always reconciles to the count, however it is split: ' + withPrior);
  const contributed = withPrior - 3;
  assert.strictEqual(contributed, 14, 'the catch-up added 14, not 17 — the 3 was already there');
  app2.catchDraft[P] = 2;
  app2.catchUpFill();
  assert.strictEqual(Number(app2.benta.stock.find(r => r.product === P).qty), withPrior,
    'and a repeat fill still only replaces the CATCH-UP part, never the figure that was there');

  // TWO usage rows for ONE product on ONE night (a rewritten block can produce
  // them) must be SUMMED as the base, not the last one taken.
  const app4 = loadClient();
  app4.applyBootstrap(F.boot);
  const it4 = app4.state.stockItems.find(x => x.product === P);
  it4.baseline_date = ''; it4.baseline_qty = 19;
  it4.delivered_before = 0; it4.used_before = 0;
  for (const k in app4.state.days) delete app4.state.days[k];
  for (const k in app4.state.stockUsage) delete app4.state.stockUsage[k];
  for (const k in app4.state.stockDeliveries) delete app4.state.stockDeliveries[k];
  const N4 = app4.catchUpNight();
  app4.state.days[N4] = { date: N4, closed: false, total: 2000, cash: 2000, gcash: 0 };
  app4.state.stockUsage[N4] = [
    { date: N4, product: P, qty: 2, entry_id: 'x1' },
    { date: N4, product: P, qty: 3, entry_id: 'x2' }
  ];
  app4.catchDraft[P] = 2;
  app4.catchUpFill();
  // on_hand = 19 − 5 = 14, counted 2 => 12 missing; base is 2 + 3 = 5 => 17.
  assert.strictEqual(Number(app4.benta.stock.find(r => r.product === P).qty), 17,
    'both saved rows are summed as the base, so the total still reconciles to the count');

  // THE ACTUAL MECHANISM THAT DOUBLED HIS SHEET: the first fill is stashed as a
  // DRAFT (backgrounding the app does that), loadBentaForm re-applies it, and the
  // old code added on top of it. This is the case to pin.
  const app3 = loadClient();
  app3.applyBootstrap(F.boot);
  const it3 = app3.state.stockItems.find(x => x.product === P);
  it3.baseline_date = ''; it3.baseline_qty = 19;
  it3.delivered_before = 0; it3.used_before = 0;
  for (const k in app3.state.days) delete app3.state.days[k];
  for (const k in app3.state.stockUsage) delete app3.state.stockUsage[k];
  for (const k in app3.state.stockDeliveries) delete app3.state.stockDeliveries[k];
  const N3 = app3.catchUpNight();
  app3.state.days[N3] = { date: N3, closed: false, total: 2000, cash: 2000, gcash: 0 };
  app3.catchDraft[P] = 2;
  app3.catchUpFill();
  assert.strictEqual(Number(app3.benta.stock.find(r => r.product === P).qty), 17);
  // Backgrounding the app stashes the form — including the 17 just filled in.
  app3.stashBentaDraft();
  assert.ok(app3.drafts[N3], 'precondition: the fill really was stashed as a draft');
  app3.catchDraft[P] = 2;
  app3.catchUpFill();
  assert.strictEqual(Number(app3.benta.stock.find(r => r.product === P).qty), 17,
    'the draft restored the first fill, and the second must NOT add to it — this is the 34');

  // ONCE SAVED, the contribution is real history: a later catch-up adds to it.
  app.applyLocalDay(app.bentaPayload());
  app.catchDraft[P] = 1;
  app.catchUpFill();
  assert.ok(Number(app.benta.stock.find(r => r.product === P).qty) >= 17,
    'a saved fill is history and is not taken back off');
});

test("HIS SHEET: two counts on one day that disagree are NAMED (v2.14.2)", () => {
  // Also from his sheet: Bonito counted 2 and then 0 on 2026-08-31, five seconds
  // apart. The app takes the later — deterministic and right — but said nothing,
  // so any figure built on the 0 looked unexplained.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const P = 'Bonito';
  const it = app.state.stockItems.find(x => x.product === P) ||
    (app.state.stockItems.push({ product: P, unit: 'Bag', active: true, sort: 9 }),
     app.state.stockItems[app.state.stockItems.length - 1]);
  it.unit = 'Bag';
  for (const k in app.state.stockCounts) delete app.state.stockCounts[k];

  // One count: nothing to say.
  app.state.stockCounts['2026-08-31'] = [
    { date: '2026-08-31', product: P, counted_qty: 2, entry_id: 'b1', updated_at: '2026-08-31 23:57:33' }
  ];
  assert.strictEqual(app.sameDayCountClash(P), '', 'a single count is not a disagreement');

  // His exact pair.
  app.state.stockCounts['2026-08-31'].push(
    { date: '2026-08-31', product: P, counted_qty: 0, entry_id: 'b2', updated_at: '2026-08-31 23:57:38' });
  const said = app.sameDayCountClash(P);
  assert.match(said, /2 counts for August 31 .* that do not agree/);
  // Both figures appear; the order follows newest-first, which is not something
  // worth pinning — that they are BOTH shown is.
  assert.ok(/2 Bags/.test(said) && /0 Bags/.test(said),
    'both figures, so he can see which is which: ' + said);
  assert.match(said, /entered LAST is the one used — 0 Bags/, 'and which one the app is using');
  assert.match(said, /count it again/, 'with what to do if that is wrong');

  // THE SAME figure twice is not a disagreement — a replayed save must not nag.
  for (const k in app.state.stockCounts) delete app.state.stockCounts[k];
  app.state.stockCounts['2026-08-31'] = [
    { date: '2026-08-31', product: P, counted_qty: 2, entry_id: 'b1', updated_at: '2026-08-31 23:57:33' },
    { date: '2026-08-31', product: P, counted_qty: 2, entry_id: 'b2', updated_at: '2026-08-31 23:57:38' }
  ];
  assert.strictEqual(app.sameDayCountClash(P), '', 'the same figure twice says nothing');

  // Counts on DIFFERENT days are the ordinary case and say nothing either.
  for (const k in app.state.stockCounts) delete app.state.stockCounts[k];
  app.state.stockCounts['2026-08-15'] = [
    { date: '2026-08-15', product: P, counted_qty: 1, entry_id: 'a', updated_at: '' }];
  app.state.stockCounts['2026-08-31'] = [
    { date: '2026-08-31', product: P, counted_qty: 0, entry_id: 'b', updated_at: '' }];
  assert.strictEqual(app.sameDayCountClash(P), '');
});

test("HIS SHEET: no unit cost anywhere is not 'nothing was used' (v2.14.2)", () => {
  // Every product in his StockItems has a BLANK unit_cost, so the Cutoff card
  // headlined "Value opened ₱0" — which reads as a fortnight that consumed
  // nothing of value. The quantities are real; the money is simply not known.
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = src.indexOf('Supplies used this cutoff');
  const card = src.slice(at - 1200, at + 2400);
  assert.match(card, /const anyPriced = asArr\(f\.suppliesUsedRows\)\.some\(r => r\.cost !== null\)/,
    'the card asks whether ANYTHING could be priced');
  assert.match(card, /cannot be valued/, 'and says so rather than showing a zero');
  assert.match(card, /the quantities below are real, the money is not worked out at all/,
    'separating what is known from what is not');
  assert.match(card, /More → Maintenance/, 'and where to fix it');

  // And the figure itself stays 0 with every row unpriced — it must not guess.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  app.state.stockItems.forEach(x => { x.unit_cost = ''; });
  const per = app.currentPeriod('2026-08-20');
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  app.state.stockUsage['2026-08-20'] = [
    { date: '2026-08-20', product: 'Takoyaki Flour', qty: 18, entry_id: 'u1' }];
  const f = app.computeCutoff(per);
  assert.strictEqual(f.suppliesUsed, 0, 'no cost on file means no money is invented');
  assert.strictEqual(f.suppliesUsedRows[0].qty, 18, 'but the quantity is still there');
  assert.strictEqual(f.suppliesUsedRows[0].cost, null);
  assert.deepStrictEqual(f.suppliesUsedUnpriced, ['Takoyaki Flour']);
});

test('USED BETWEEN TWO COUNTS: measured, not remembered (v2.14.0)', () => {
  // Owner, 2026-08-28, having already corrected the count: "now how to know how
  // much stocks ive used". Nothing is lost — the earlier count, the deliveries
  // after it and the new count are all still there, and between two counts
  // consumption is a FACT: earlier + delivered − later.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const P = 'Takoyaki Flour';
  const it = app.state.stockItems.find(x => x.product === P);
  it.unit_cost = 120; it.unit = 'pack';
  const clear = () => {
    for (const k in app.state.stockCounts) delete app.state.stockCounts[k];
    for (const k in app.state.stockDeliveries) delete app.state.stockDeliveries[k];
    for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
    for (const k in app.state.expenses) delete app.state.expenses[k];
    app.state.window_start = '';
  };
  const count = (date, qty) => {
    (app.state.stockCounts[date] = app.state.stockCounts[date] || [])
      .push({ date, product: P, counted_qty: qty, entry_id: 'c-' + date + '-' + qty, updated_at: date });
  };
  const arrived = (date, qty) => {
    (app.state.stockDeliveries[date] = app.state.stockDeliveries[date] || [])
      .push({ date, product: P, qty, entry_id: 'd-' + date });
  };
  const opened = (date, qty) => {
    (app.state.stockUsage[date] = app.state.stockUsage[date] || [])
      .push({ date, product: P, qty, entry_id: 'u-' + date });
  };

  // HIS CASE: counted 8 on Aug 15, 12 arrived last week, counted 2 today.
  // 8 + 12 − 2 = 18 used, none of it logged.
  clear();
  count('2026-08-15', 8);
  arrived('2026-08-22', 12);
  count('2026-08-28', 2);
  let u = app.usedBetweenCounts(P);
  assert.ok(u && u.sure, 'two counts and rows in range: it can answer');
  assert.strictEqual(u.from, '2026-08-15');
  assert.strictEqual(u.to, '2026-08-28');
  assert.strictEqual(u.delivered, 12);
  assert.strictEqual(u.used, 18, 'earlier + delivered − later');
  assert.strictEqual(u.logged, 0);
  assert.strictEqual(u.unlogged, 18, 'and none of it has reached the costing');
  assert.strictEqual(u.cost, 18 * 120, 'which is what it cost');

  const said = app.usedBetweenText(P);
  assert.match(said, /Used between your counts on August 15 .* and August 28/);
  assert.match(said, /18 packs/, 'the figure');
  assert.match(said, /8 packs counted, 12 packs arrived, 2 packs left/,
    'and the whole working, so it can be checked against the paper');
  assert.match(said, /None of it is logged as opened yet/);
  assert.match(said, /₱2,160/, 'with the money it represents');

  // PART ALREADY LOGGED: only the remainder is missing from the costing.
  opened('2026-08-24', 5);
  u = app.usedBetweenCounts(P);
  assert.strictEqual(u.used, 18, 'what was used does not change');
  assert.strictEqual(u.logged, 5);
  assert.strictEqual(u.unlogged, 13, 'but what the costing is MISSING does');
  assert.strictEqual(u.cost, 13 * 120);
  assert.match(app.usedBetweenText(P), /5 packs of that is already logged as opened, so 13 packs is not/);

  // THE DATE WINDOW IS STRICT, the same rule the on-hand figure follows: a
  // delivery ON the earlier count day is excluded (a count is end-of-day), and
  // one ON the later count day is included.
  clear();
  count('2026-08-15', 8);
  arrived('2026-08-15', 100);          // same day as the count — excluded
  arrived('2026-08-28', 4);            // same day as the new count — counted
  count('2026-08-28', 2);
  u = app.usedBetweenCounts(P);
  assert.strictEqual(u.delivered, 4,
    'a delivery dated ON the count day is left out, exactly as on-hand leaves it out');
  assert.strictEqual(u.used, 10, '8 + 4 − 2');

  // A DELIVERY THAT RODE ON AN EXPENSE (pre-v2.6.0 rows) still counts.
  clear();
  count('2026-08-15', 8);
  app.state.expenses['e1'] = { date: '2026-08-20', category: 'Supplies', item: 'Flour',
    amount: 600, stock_product: P, stock_qty: 5, entry_id: 'e1', paid_from: '' };
  count('2026-08-28', 3);
  assert.strictEqual(app.usedBetweenCounts(P).used, 10, '8 + 5 − 3');

  // FEWER THAN TWO COUNTS: there is no span, so it says nothing at all.
  clear();
  count('2026-08-28', 2);
  assert.strictEqual(app.usedBetweenCounts(P), null, 'one count is not a span');
  assert.strictEqual(app.usedBetweenText(P), '');

  // TWO COUNTS ON THE SAME DAY say nothing about a span either.
  clear();
  count('2026-08-28', 8);
  count('2026-08-28', 2);
  assert.strictEqual(app.usedBetweenCounts(P), null);

  // IT REFUSES when the span reaches back past what this phone holds — a figure
  // built on rows it cannot see would be a guess dressed as a fact.
  clear();
  count('2026-07-01', 8);
  arrived('2026-07-10', 12);
  count('2026-08-28', 2);
  app.state.window_start = '2026-08-01';
  u = app.usedBetweenCounts(P);
  assert.strictEqual(u.sure, false, 'it does not answer from rows it does not have');
  assert.strictEqual(u.used, undefined, 'and it does not invent a figure');
  assert.match(app.usedBetweenText(P), /does not hold all the rows/);
  assert.match(app.usedBetweenText(P), /The Google Sheet does/, 'pointing at where the answer is');

  // MORE ON THE SHELF THAN IT STARTED WITH is not negative usage.
  clear();
  count('2026-08-15', 2);
  arrived('2026-08-20', 10);
  count('2026-08-28', 20);
  u = app.usedBetweenCounts(P);
  assert.strictEqual(u.used, -8);
  assert.strictEqual(u.unlogged, 0, 'never a negative amount to log');
  assert.match(app.usedBetweenText(P), /nothing was used/);
});

test('CATCH UP: what is missing from the shelf IS what was opened (v2.13.1)', () => {
  // Owner, 2026-08-28: nobody logged supplies for a fortnight, he counted what
  // was left, and "with the remaining supplies, we should see the supplies cost
  // for this cutoff". A stocktake cannot answer that — it re-baselines, so the
  // consumption never reaches the costing. The usage has to be written, and the
  // arithmetic for it is not a guess:
  //     used = what the app believes is there − what is really there
  const app = loadClient();
  app.applyBootstrap(F.boot);

  // Put the shelf in a known state: 8 packs of flour believed on hand, at 120.
  const items = app.state.stockItems;
  const flour = items.find(x => x.product === 'Takoyaki Flour');
  assert.ok(flour, 'precondition: the seeded flour row exists');
  flour.unit_cost = 120;
  // stockStatusOf measures from the SERVER's baseline (baseline_date/qty), not
  // from opening_qty — that is what bootstrap fills in and what the on-hand
  // figure on screen is built from.
  flour.baseline_date = ''; flour.baseline_qty = 8;
  flour.delivered_before = 0; flour.used_before = 0;
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  for (const k in app.state.stockDeliveries) delete app.state.stockDeliveries[k];
  app.state.stockCounts = app.state.stockCounts || {};
  for (const k in app.state.stockCounts) delete app.state.stockCounts[k];

  const onHand = app.stockStatusList().find(s => s.product === 'Takoyaki Flour').on_hand;
  assert.strictEqual(onHand, 8, 'precondition: the app believes 8 packs are there');

  // He counts 2. Six were opened and never written down — 6 x 120 = 720.
  let plan = app.catchUpPlan({ 'Takoyaki Flour': 2 });
  const row = plan.rows.find(r => r.product === 'Takoyaki Flour');
  assert.ok(row, 'it must have something to log');
  assert.strictEqual(row.used, 6, 'eight believed minus two really there');
  assert.strictEqual(row.cost, 720, 'and the peso cost he asked to see');
  assert.strictEqual(plan.cost, 720, 'totalled');

  // A product he did not count is not touched — silence is not a count of zero.
  assert.ok(!plan.rows.some(r => r.product === 'Bonito'),
    'an uncounted product is left alone, not assumed empty');
  plan = app.catchUpPlan({ 'Takoyaki Flour': '' });
  assert.strictEqual(plan.rows.length, 0, 'a blank field is not a count');

  // COUNTING WHAT IT EXPECTED means nothing was missed.
  assert.strictEqual(app.catchUpPlan({ 'Takoyaki Flour': 8 }).rows.length, 0,
    'the shelf agrees, so there is nothing to catch up');

  // MORE than expected is NOT negative usage — it is a delivery nobody logged,
  // and inventing usage from it would be inventing the opposite of the truth.
  plan = app.catchUpPlan({ 'Takoyaki Flour': 11 });
  assert.strictEqual(plan.rows.length, 0, 'nothing is logged as opened');
  assert.strictEqual(plan.overs.length, 1);
  assert.strictEqual(plan.overs[0].extra, 3, 'the surplus is named as a surplus');
  assert.strictEqual(plan.cost, 0, 'and it adds no cost');

  // NO COST ON FILE: the quantity is still caught up, the money is NOT invented.
  flour.unit_cost = '';
  plan = app.catchUpPlan({ 'Takoyaki Flour': 2 });
  assert.strictEqual(plan.rows[0].used, 6, 'the quantity is still right');
  assert.strictEqual(plan.rows[0].cost, null, 'but it is not costed at nothing');
  assert.strictEqual(plan.cost, 0);
  assert.deepStrictEqual(plan.unpriced.map(u => u.product), ['Takoyaki Flour'],
    'it is listed instead, the way the costing screen lists an unpriced item');
});

test('CATCH UP: it fills ONE night, adds to what is there, and saves nothing (v2.13.1)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  // A FIXED date, injected. Building this from the real clock made it unrunnable
  // on the 1st and the 16th, when today IS the start of the cutoff and there is
  // no earlier night inside it to pick — the guard that caught that fired for
  // real on 2026-09-01. A date the test chooses removes the dependency instead
  // of working around it.
  const TODAY = '2026-08-28';
  const per = app.currentPeriod(TODAY);
  const nights = [];
  for (let d = app.addDays(TODAY, -1); d >= per.start && nights.length < 6; d = app.addDays(d, -1)){
    nights.push(d);
  }
  assert.strictEqual(nights.length, 6, 'six nights of room inside Aug 16-31 before the 28th');
  const back = (n) => nights[n - 1];
  for (const k in app.state.days) delete app.state.days[k];
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  for (const d of nights){
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }

  // The night chosen is the most recent one that logged NOTHING — the last night
  // it could have gone unrecorded.
  assert.strictEqual(app.catchUpNight(TODAY), back(1));

  // A night that logged something is skipped, and the search CONTINUES to the
  // next empty one rather than giving up and defaulting to today.
  app.state.stockUsage[back(1)] = [{ date: back(1), product: 'Takoyaki Flour', qty: 2 }];
  assert.strictEqual(app.catchUpNight(TODAY), back(2),
    'the next empty night down, not today');

  // Every night in the cutoff logged: it falls back to tonight rather than
  // reaching into an earlier cutoff, which may already have been settled.
  for (const d of nights){
    app.state.stockUsage[d] = [{ date: d, product: 'Takoyaki Flour', qty: 1 }];
  }
  assert.strictEqual(app.catchUpNight(TODAY), TODAY,
    'never an earlier cutoff — that would restate money that has moved');

  // A CLOSED night is skipped: nothing can be opened on a night the stall shut.
  const shut = nights[0];
  delete app.state.stockUsage[shut];
  app.state.days[shut].closed = true;
  assert.notStrictEqual(app.catchUpNight(TODAY), shut, 'a closed night is never the answer');
  app.state.days[shut].closed = false;

  // AN EMPTY NIGHT IN AN EARLIER CUTOFF IS NEVER REACHED. That fortnight has
  // very likely been settled, and putting supplies into it would restate money
  // that has already moved — which this app never does.
  for (const d of nights){
    app.state.stockUsage[d] = [{ date: d, product: 'Takoyaki Flour', qty: 1 }];
  }
  const older = app.addDays(per.start, -3);
  app.state.days[older] = { date: older, closed: false, total: 900, cash: 900, gcash: 0 };
  assert.strictEqual(app.catchUpNight(TODAY), TODAY,
    'it falls back to tonight rather than reaching into a settled cutoff');

  // --- WHAT catchUpFill ACTUALLY DOES ---------------------------------------
  const app2 = loadClient();
  app2.applyBootstrap(F.boot);
  const flour = app2.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  flour.unit_cost = 120; flour.baseline_date = ''; flour.baseline_qty = 8;
  flour.delivered_before = 0; flour.used_before = 0;
  for (const k in app2.state.days) delete app2.state.days[k];
  for (const k in app2.state.stockUsage) delete app2.state.stockUsage[k];
  const night = app2.catchUpNight();
  app2.loadBentaForm(night);
  // That night ALREADY has a pack logged. It must survive: saving the day
  // rewrites the whole night's usage, so the catch-up has to ADD to it.
  const existing = app2.benta.stock.find(r => r.product === 'Takoyaki Flour');
  assert.ok(existing, 'precondition: the night has a flour row');
  existing.qty = 1;
  app2.applyLocalDay(app2.bentaPayload());
  app2.loadBentaForm(night);

  // Shut the card first, or "it opens the card" cannot be observed: reloading a
  // night that already holds a figure opens it by itself.
  app2.benta.stockOpen = false;
  const before2 = app2.queue.length;
  app2.catchDraft['Takoyaki Flour'] = 2;      // 8 believed... 1 already logged
  const plan = app2.catchUpPlan(app2.catchDraft);
  const want = plan.rows.find(r => r.product === 'Takoyaki Flour').used;
  app2.catchUpFill();

  const filled = app2.benta.stock.find(r => r.product === 'Takoyaki Flour');
  assert.strictEqual(Number(filled.qty), 1 + want,
    'ADDED to the figure already on that night, never replacing it');
  // IT SAVES NOTHING. The last word belongs on Save day, like every other
  // figure in this app.
  assert.strictEqual(app2.queue.length, before2, 'catchUpFill must queue nothing');
  assert.strictEqual(app2.benta.dirty, true, 'it is unsent work, and says so');
  // ...and it takes her to the night it filled in, or she would never find it.
  assert.ok(app2.moved.includes('benta'), 'she is moved to the Sales screen: ' +
    JSON.stringify(app2.moved));
  assert.strictEqual(app2.benta.date, night, 'and the form is on that night');
  assert.strictEqual(app2.benta.stockOpen, true, 'with the stock card open, so it is visible');

  // ...and that is asserted again on a night with NOTHING already logged, where
  // loading the form does not open the card by itself — otherwise "it opens the
  // card" is being proved by the loader rather than by the catch-up.
  const app3 = loadClient();
  app3.applyBootstrap(F.boot);
  const f3 = app3.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  f3.unit_cost = 120; f3.baseline_date = ''; f3.baseline_qty = 8;
  f3.delivered_before = 0; f3.used_before = 0;
  for (const k in app3.state.days) delete app3.state.days[k];
  for (const k in app3.state.stockUsage) delete app3.state.stockUsage[k];
  // Deliveries too: the fixture carries some, and they raise on-hand — the
  // expectation below is derived from on-hand rather than assumed, but the
  // precondition still has to be a shelf nobody has added to.
  for (const k in app3.state.stockDeliveries) delete app3.state.stockDeliveries[k];
  const believed = app3.stockStatusList().find(x => x.product === 'Takoyaki Flour').on_hand;
  assert.strictEqual(believed, 8, 'precondition: eight packs believed on the shelf');
  app3.loadBentaForm(app3.catchUpNight());
  assert.strictEqual(app3.benta.stockOpen, false,
    'precondition: an empty night loads with the card shut');
  app3.catchDraft['Takoyaki Flour'] = 2;
  app3.catchUpFill();
  assert.strictEqual(app3.benta.stockOpen, true, 'the catch-up itself opens it');

  // A CLOSED night cannot take it. Reachable: tonight marked "Closed today"
  // while every other night in the cutoff has logged something, so the picker
  // falls back to tonight — and nothing can be opened on a night the stall shut.
  const app4 = loadClient();
  app4.applyBootstrap(F.boot);
  const f4 = app4.state.stockItems.find(x => x.product === 'Takoyaki Flour');
  f4.unit_cost = 120; f4.baseline_date = ''; f4.baseline_qty = 8;
  f4.delivered_before = 0; f4.used_before = 0;
  for (const k in app4.state.days) delete app4.state.days[k];
  for (const k in app4.state.stockUsage) delete app4.state.stockUsage[k];
  for (const k in app4.state.stockDeliveries) delete app4.state.stockDeliveries[k];
  const T4 = app4.todayStr();
  app4.state.days[T4] = { date: T4, closed: true, total: 0, cash: 0, gcash: 0 };
  assert.strictEqual(app4.catchUpNight(), T4, 'precondition: it falls back to tonight');
  app4.loadBentaForm(T4);
  assert.strictEqual(app4.benta.closed, true, 'precondition: and tonight is closed');
  app4.catchDraft['Takoyaki Flour'] = 2;
  app4.catchUpFill();
  assert.strictEqual(Number(app4.benta.stock.find(r => r.product === 'Takoyaki Flour').qty), 0,
    'nothing is filled onto a closed night');
  assert.deepStrictEqual(Object.keys(app4.catchDraft), ['Takoyaki Flour'],
    'and the typed count is KEPT, so she can pick another night rather than retype it');
  assert.strictEqual(Number(app3.benta.stock.find(r => r.product === 'Takoyaki Flour').qty),
    believed - 2, 'and fills in exactly what is missing from the shelf');
  assert.deepStrictEqual(Object.keys(app2.catchDraft), [],
    'and the typed counts are cleared, so a second tap cannot double it');
});

test('NOTHING LOGGED AS OPENED: the run of nights is named (v2.13.0)', () => {
  // Owner, 2026-08-28: "my moother forgot to log used supplies." A night saves
  // perfectly well with the stock card untouched and nothing ever asked, so the
  // shelf figures drifted for a fortnight and the costing had no supplies to
  // price. He found out by looking in the tray. This is the missing question.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  const reset = () => {
    for (const k in app.state.days) delete app.state.days[k];
    for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  };
  const night = (d, opts) => {
    app.state.days[d] = { date: d, closed: !!(opts && opts.closed), total: 1000, cash: 1000, gcash: 0 };
    if (opts && opts.used) app.state.stockUsage[d] = [{ date: d, product: 'Takoyaki Flour', qty: opts.used }];
  };

  // Four empty nights is a quiet stretch, not a habit — it says nothing.
  reset();
  for (let i = 1; i <= 4; i++) night(back(i));
  assert.strictEqual(app.openedGap().nights, 4);
  assert.strictEqual(app.openedGapText(), '', 'four nights is not yet worth saying');

  // Five is. And it names the COUNT and the date the run began, so he can check
  // it against the paper rather than take it on faith.
  reset();
  for (let i = 1; i <= 5; i++) night(back(i));
  const g = app.openedGap();
  assert.strictEqual(g.nights, 5);
  assert.strictEqual(g.since, back(5), 'the run began on the OLDEST empty night');
  const said = app.openedGapText();
  assert.match(said, /Nothing has been logged as opened for 5 nights running/);
  assert.match(said, /drifting from what is really there/, 'and what it costs him');
  assert.match(said, /the costing has no supplies to price/, 'both consequences, plainly');

  // THE RUN ENDS AT THE FIRST NIGHT THAT DID LOG SOMETHING. The question is
  // "has she stopped doing this", not "how many nights are empty overall".
  reset();
  for (let i = 1; i <= 3; i++) night(back(i));
  night(back(4), { used: 2 });
  for (let i = 5; i <= 12; i++) night(back(i));
  assert.strictEqual(app.openedGap().nights, 3,
    'eight older empty nights are behind a night that DID log — the run is three');
  assert.strictEqual(app.openedGapText(), '', 'so it stays quiet');

  // A CLOSED night opens nothing, so it neither breaks the run nor lengthens it.
  reset();
  for (let i = 1; i <= 3; i++) night(back(i));
  night(back(4), { closed: true });
  for (let i = 5; i <= 6; i++) night(back(i));
  assert.strictEqual(app.openedGap().nights, 5,
    'the closed night is skipped, and the run continues through it');

  // A night that logged a ZERO is still an empty night — a stepper left at 0 is
  // not a figure, it is the absence of one.
  reset();
  for (let i = 1; i <= 5; i++) night(back(i));
  app.state.stockUsage[back(2)] = [{ date: back(2), product: 'Takoyaki Flour', qty: 0 }];
  assert.strictEqual(app.openedGap().nights, 5, 'a logged zero does not end the run');

  // TONIGHT IS NEVER COUNTED: it is not finished, and nagging about a night she
  // is still entering is how a warning stops being read.
  reset();
  for (let i = 1; i <= 4; i++) night(back(i));
  night(TODAY);
  assert.strictEqual(app.openedGap().nights, 4, 'tonight is not one of the empty nights');
  assert.strictEqual(app.openedGapText(), '');
});

test('NOTHING LOGGED AS OPENED: the card opens itself, and never refuses (v2.13.0)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  for (const k in app.state.days) delete app.state.days[k];
  for (const k in app.state.stockUsage) delete app.state.stockUsage[k];
  for (let i = 1; i <= 6; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  app.loadBentaForm(TODAY);

  // A WARNING BEHIND A COLLAPSED HEADER IS NOT A WARNING.
  const html = app.stockCardHTML();
  assert.match(html, /Nothing has been logged as opened for 6 nights running/);
  assert.match(html, /needs a look/, 'the header says so too');
  // Asserted on the real collapse state, not on the word "hidden" appearing
  // somewhere in the markup — every error slot in the body carries that word.
  assert.match(html, /aria-expanded="true"/, 'the card is open, so the warning is visible');
  assert.ok(!/<div class="collapse-body" id="stockBody" hidden>/.test(html),
    'and its body is not the hidden variant');

  // It NEVER refuses: the night is still perfectly savable, because a night
  // where genuinely nothing was opened is a real night.
  assert.deepStrictEqual(Object.keys(app.validateBenta()).filter(k => app.validateBenta()[k]), [],
    'a run of empty nights must not block Save day');

  // LOGGING TONIGHT DOES NOT ERASE THE NIGHTS BEHIND IT. Six nights of flour
  // really were opened and never written down; the shelf figures are still
  // drifting by that much, and the costing still has nothing to price for them.
  // A banner that vanished on one good night would be telling him the backlog
  // had been dealt with when it had not.
  const row = app.benta.stock[0];
  assert.ok(row, 'precondition: there is a product to log');
  row.qty = 1;
  app.applyLocalDay(app.bentaPayload());
  assert.strictEqual(app.openedGap().nights, 6,
    'the six empty nights are still empty — one good night does not fill them');
  assert.match(app.openedGapText(), /6 nights running/);

  // It clears the way a real backlog clears: by those nights getting their
  // figures. Filling the most recent one shortens the run to nothing.
  for (let i = 1; i <= 6; i++){
    const d = back(i);
    app.state.stockUsage[d] = [{ date: d, product: 'Takoyaki Flour', qty: 1 }];
  }
  assert.strictEqual(app.openedGap().nights, 0, 'filled in, so nothing left to say');
  assert.strictEqual(app.openedGapText(), '');
});

test('THE TIN COUNT: over, short, exact — and never a zero nobody entered (v2.12.1)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const D = ymdDaysAgo(2);
  const per = app.currentPeriod(D);

  // ₱2,000 cash in, ₱300 out of the tin → ₱1,700 should be left.
  app.loadBentaForm(D);
  const box4 = app.benta.rows.find(r => r.sku === 'box4');
  box4.sod = 40; box4.eod = 0;
  app.applyLocalDay(app.bentaPayload());
  app.applyLocalExpense({ date: D, category: 'Supplies', item: 'Veggies', amount: 300,
    backlogRef: '', notes: '', paidFrom: 'tin', entryId: 'tin-e1' });
  let f = app.computeCutoff(per);
  const should = f.tinExpected;
  assert.ok(should > 0, 'precondition: the tin should hold something');

  // NOBODY HAS COUNTED. That is a fact, not a zero — reporting a shortage of the
  // whole tin on every uncounted cutoff would make the figure worthless.
  assert.strictEqual(app.tinCountFor(per, f).counted, null, 'uncounted is null, never 0');
  assert.strictEqual(app.tinVerdict(per, f), '', 'and it says nothing at all');

  // EXACT.
  app.applyLocalTinCount({ start: per.start, end: per.end, counted: should, entryId: 'tc-1' });
  f = app.computeCutoff(per);
  assert.strictEqual(app.tinCountFor(per, f).off, 0);
  assert.match(app.tinVerdict(per, f), /exactly what it should hold/);

  // SHORT — named as short, with the peso figure and where to look.
  app.applyLocalTinCount({ start: per.start, end: per.end, counted: should - 200, entryId: 'tc-1' });
  f = app.computeCutoff(per);
  assert.strictEqual(app.tinCountFor(per, f).off, -200);
  let v = app.tinVerdict(per, f);
  assert.match(v, /SHORT of what it should hold/);
  assert.match(v, /a purchase nobody wrote down/, 'and the likely causes, in her terms');

  // OVER — a different story, so a different sentence.
  app.applyLocalTinCount({ start: per.start, end: per.end, counted: should + 50, entryId: 'tc-1' });
  f = app.computeCutoff(per);
  assert.strictEqual(app.tinCountFor(per, f).off, 50);
  v = app.tinVerdict(per, f);
  assert.match(v, /MORE than it should hold/);
  assert.match(v, /a sale that never got written down/);

  // UNKNOWN MONEY QUALIFIES THE VERDICT: a shortage may simply be a payment
  // that never said where it came from, and the sentence must admit that.
  // Measured as a DELTA: the shared fixture already carries expenses in this
  // period that say nothing about their source, so an absolute figure here would
  // be pinning the fixture rather than the behaviour.
  const unknownBefore = app.computeCutoff(per).tinUnknown;
  app.applyLocalExpense({ date: D, category: 'Mama', item: '', amount: 500,
    backlogRef: '', notes: '', entryId: 'tin-unknown' });
  f = app.computeCutoff(per);
  assert.strictEqual(f.tinUnknown, Math.round((unknownBefore + 500) * 100) / 100,
    'a payment that says nothing adds to the unknown total, exactly once');
  assert.match(app.tinVerdict(per, f), /do not say where they came from/,
    'the verdict must not blame a shortage it cannot account for');

  // A count of ZERO is a real answer — the tin was empty — and must read as a
  // shortage of the whole expected figure, not as "not counted".
  app.applyLocalTinCount({ start: per.start, end: per.end, counted: 0, entryId: 'tc-1' });
  f = app.computeCutoff(per);
  assert.strictEqual(app.tinCountFor(per, f).counted, 0, 'a counted zero is a count');
  assert.match(app.tinVerdict(per, f), /SHORT/);
});

test('THE TIN COUNT and the SPLIT share one row without treading on each other (v2.12.1)', () => {
  // Both live on the CutoffInputs row for (start, end). The server's upsert
  // starts from the existing row and overwrites only what it was given; the
  // local mirror has to do the same, or saving one would drop the other.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const per = app.currentPeriod(ymdDaysAgo(2));

  app.applyLocalCutoffSplit({ start: per.start, end: per.end, amount: 3000, entryId: 'ci-1' });
  app.applyLocalTinCount({ start: per.start, end: per.end, counted: 1700, entryId: 'ci-1' });
  let row = app.state.cutoffInputs[app.periodKey(per)];
  assert.strictEqual(row.split_amount, 3000, 'the split survived the count');
  assert.strictEqual(row.tin_counted, 1700, 'and the count is there');

  // ...and the other way round.
  app.applyLocalCutoffSplit({ start: per.start, end: per.end, amount: 4000, entryId: 'ci-1' });
  row = app.state.cutoffInputs[app.periodKey(per)];
  assert.strictEqual(row.tin_counted, 1700, 'the count survived a re-saved split');
  assert.strictEqual(row.split_amount, 4000);

  // THE SEAM: the sheet must behave the same way, in both orders.
  const srv = loadServer();
  const p1 = post(srv.ctx, { token: srv.token, action: 'saveCutoffSplit',
    payload: { start: per.start, end: per.end, amount: 3000, entryId: 'srv-ci' } });
  assert.strictEqual(p1.ok, true, p1.error);
  const p2 = post(srv.ctx, { token: srv.token, action: 'saveTinCount',
    payload: { start: per.start, end: per.end, counted: 1700.5, entryId: 'srv-ci' } });
  assert.strictEqual(p2.ok, true, p2.error);
  assert.strictEqual(p2.data.tin_counted, 1700.5, 'centavos are kept — a tin holds coins');

  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const ci = boot.data.cutoffInputs.find(r => r.start === per.start && r.end === per.end);
  assert.strictEqual(Number(ci.split_amount), 3000, 'the split is still on the row');
  assert.strictEqual(Number(ci.tin_counted), 1700.5, 'beside the count');

  // A negative count is refused rather than clamped: a tin cannot hold less
  // than nothing, and silently reading it as 0 would report a false shortage.
  const bad = post(srv.ctx, { token: srv.token, action: 'saveTinCount',
    payload: { start: per.start, end: per.end, counted: -5, entryId: 'srv-ci' } });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /cannot be negative/);

  // And an UNCOUNTED cutoff comes back blank, not zero.
  const other = app.shiftPeriod(per, -1);
  post(srv.ctx, { token: srv.token, action: 'saveCutoffSplit',
    payload: { start: other.start, end: other.end, amount: 2000, entryId: 'srv-other' } });
  const boot2 = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const ci2 = boot2.data.cutoffInputs.find(r => r.start === other.start);
  assert.strictEqual(ci2.tin_counted, '', 'never counted stays blank on the wire');
  const app2 = syncedClient(boot2.data);
  assert.strictEqual(app2.tinCountFor(other, app2.computeCutoff(other)).counted, null,
    'and reads as "nobody counted" on the phone');
});

test('THE TIN: cash in, less what she took out of it, and what it cannot say (v2.12.0)', () => {
  // Owner, 2026-08-28: "its collected until every cutoff" — the tin is emptied
  // at settlement, not nightly, and Mama buys supplies out of that same tin. So
  // across a fortnight the tin holds its cash sales less the cash SHE took back
  // out. Nothing recorded where an expense's money came from until now.
  const srv = loadServer();
  const app = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const D = ymdDaysAgo(2);
  const per = app.currentPeriod(D);

  // A night that took ₱2,000, all cash.
  app.loadBentaForm(D);
  const box4 = app.benta.rows.find(r => r.sku === 'box4');
  box4.sod = 40; box4.eod = 0;
  const night = app.computeDay(app.bentaPayload());
  app.applyLocalDay(app.bentaPayload());
  assert.strictEqual(Number(night.gcash), 0, 'precondition: an all-cash night');
  const cash = Number(night.cash);

  const spend = (amount, paidFrom, id) => {
    const p = { date: D, category: 'Supplies', item: 'Veggies', amount: amount,
                backlogRef: '', notes: '', entryId: id };
    if (paidFrom !== undefined) p.paidFrom = paidFrom;
    app.applyLocalExpense(p);
    return p;
  };

  // Nothing marked yet: the card must not appear, because it would just be the
  // night's cash restated under a new heading.
  let f = app.computeCutoff(per);
  assert.strictEqual(f.tinOut, 0);
  assert.strictEqual(f.tinUnknown, 0);

  // ₱300 of veggies out of the tin.
  spend(300, 'tin', 'tin-1');
  f = app.computeCutoff(per);
  assert.strictEqual(f.tinOut, 300, 'what she took out of the tin');
  assert.strictEqual(f.tinExpected, Math.round((cash - 300) * 100) / 100, 'and what should be left in it');

  // GCash and his own money do NOT come out of the tin.
  spend(500, 'gcash', 'gc-1');
  spend(250, 'own', 'own-1');
  f = app.computeCutoff(per);
  assert.strictEqual(f.tinOut, 300, 'only tin money is subtracted');
  assert.strictEqual(f.tinExpected, Math.round((cash - 300) * 100) / 100);
  assert.strictEqual(f.tinUnknown, 0, 'a stated source is not an unknown one');

  // A row that says NOTHING — an older queued row, or one of the Cutoff
  // screen's one-tap doors — is counted apart and never assumed either way.
  spend(400, undefined, 'legacy-1');
  f = app.computeCutoff(per);
  assert.strictEqual(f.tinOut, 300, 'an unknown source is NOT quietly treated as the tin');
  assert.strictEqual(f.tinUnknown, 400, 'it is named instead');
  assert.strictEqual(f.tinExpected, Math.round((cash - 300) * 100) / 100,
    'so the figure shown is the one the app can actually stand behind');

  // The card's WORDING is pinned in the source-level test below — renderCutoff
  // writes straight into the DOM, so there is no return value to assert on.

  // THE SEAM: the sheet must store and return it, and an expense that says
  // nothing must land exactly as an older phone's does.
  const r1 = post(srv.ctx, { token: srv.token, action: 'saveExpense', payload:
    { date: D, category: 'Supplies', item: 'Veggies', amount: 300, backlogRef: '',
      notes: '', paidFrom: 'tin', entryId: 'srv-tin' } });
  assert.strictEqual(r1.ok, true, r1.error);
  assert.strictEqual(r1.data.paid_from, 'tin', 'the response is snake_case');
  const r2legacy = post(srv.ctx, { token: srv.token, action: 'saveExpense', payload:
    { date: D, category: 'Supplies', item: 'Eggs', amount: 100, backlogRef: '',
      notes: '', entryId: 'srv-legacy' } });
  assert.strictEqual(r2legacy.ok, true, r2legacy.error);
  assert.strictEqual(r2legacy.data.paid_from, '', 'silence stays silence');

  // A source that is not one of the three is REFUSED, not coerced — filing an
  // unknown source as "the tin" would invent a shortage.
  const bad = post(srv.ctx, { token: srv.token, action: 'saveExpense', payload:
    { date: D, category: 'Supplies', item: 'Eggs', amount: 100, backlogRef: '',
      notes: '', paidFrom: 'pocket', entryId: 'srv-bad' } });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /Invalid paidFrom "pocket"/);
  assert.match(bad.error, /tin, gcash, own, or blank/);

  // And it survives the round trip onto the phone.
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const back = boot.data.expenses.find(e => e.entry_id === 'srv-tin');
  assert.strictEqual(back.paid_from, 'tin', 'bootstrap returns it');
  const app2 = syncedClient(boot.data);
  assert.strictEqual(app2.state.expenses['srv-tin'].paid_from, 'tin', 'and the phone keeps it');
  assert.strictEqual(app2.state.expenses['srv-legacy'].paid_from, '', 'a legacy row stays blank');
});

test('SOURCE PIN: the tin card names its unknown money and asks for a count (v2.12.0)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = src.indexOf('What should be in the tin');
  assert.ok(at > 0, 'the card must exist');
  const card = src.slice(at - 600, at + 3600);
  assert.match(card, /if \(num\(f\.tinOut\) > 0 \|\| num\(f\.tinUnknown\) > 0\)/,
    'it stays away until something has actually been marked');
  // Pinned as the CONDITION, not just the sentence: a dead `if` leaves the
  // sentence sitting in the source looking correct (the v2.9.1 lesson).
  assert.match(card, /if \(num\(f\.tinUnknown\) > 0\)\{/,
    'the unknown-money line must be GATED on there being some');
  assert.match(card, /do not say where the money came from, so it is NOT/,
    'unknown money is named, not folded in');
  assert.match(card, /the real figure is lower by that much/,
    'and the DIRECTION of the doubt is stated');
  // v2.12.1: the ask is now the FALLBACK — once she has counted, the verdict
  // takes its place, so both branches are pinned.
  assert.match(card, /Count the tin before you collect it/,
    'it asks for the count while there is none');
  assert.match(card, /const verdict = tinVerdict\(per, f\);/,
    'and once counted, the verdict replaces the ask');
  assert.match(card, /id="tinCountIn"/, 'with a field to count into');
  assert.match(card, /data-act="tin-save"/, 'and a way to save it');

  // AND THE FORM MUST ACTUALLY SEND THE CHOICE. submitGasto reads the DOM, so
  // this is pinned at the payload it builds — the one place the chip's answer
  // becomes a fact the sheet will keep.
  const sub = src.slice(src.indexOf('function submitGasto('), src.indexOf('function submitGasto(') + 2600);
  assert.match(sub, /paidFrom: gx\.paidFrom/,
    'the expense payload must carry where the money came from');
  assert.match(src, /data-act="gastos-paid"/, 'and the chips must exist to choose it');
  assert.match(src, /if \(PAID_FROM_CHOICES\.some\(c => c\.key === want\)\) gx\.paidFrom = want;/,
    'only one of the three may ever be set, never a stale attribute');
});

test('HOW THE NIGHTS COMPARE: weekday averages, honestly counted (v2.11.0)', () => {
  // The Cutoff screen settles with his partner; the costing prices a ball.
  // Neither answers "is Tuesday worth opening?" — which is answerable from
  // figures already on the phone.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  const dow = (d) => app.weekdayName(d);

  for (const k in app.state.days) delete app.state.days[k];
  // 28 finished nights, all open, all ₱1,000 — so every weekday averages the
  // same and the arithmetic is checkable by eye.
  for (let i = 1; i <= 28; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  let wk = app.trendByWeekday();
  assert.strictEqual(wk.length, 7, 'four weeks gives every weekday enough nights');
  assert.ok(wk.every(w => w.avg === 1000 && w.nights === 4), JSON.stringify(wk));

  // A CLOSED night is not a slow night: counting its zero would drag that
  // weekday's average down and make him think a good night was a bad one.
  const shut = back(3);
  const shutDay = dow(shut);
  app.state.days[shut] = { date: shut, closed: true, total: 0, cash: 0, gcash: 0 };
  wk = app.trendByWeekday();
  const row = wk.find(w => w.name === shutDay);
  assert.strictEqual(row.nights, 3, 'the closed night is not counted');
  assert.strictEqual(row.avg, 1000, 'and it does not drag the average down');

  // TONIGHT is not finished, so it is not averaged — the same line the costing
  // and the stock runway draw at yesterday. One system, one answer.
  app.state.days[TODAY] = { date: TODAY, closed: false, total: 1, cash: 1, gcash: 0 };
  const todayRow = app.trendByWeekday().find(w => w.name === dow(TODAY));
  assert.strictEqual(todayRow.avg, 1000, 'tonight is not in the average yet');

  // SORTED BEST FIRST, because the question is which nights are worth opening.
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 28; i++){
    const d = back(i);
    const isTue = dow(d) === 'Tuesday';
    app.state.days[d] = { date: d, closed: false, total: isTue ? 300 : 2000,
                          cash: isTue ? 300 : 2000, gcash: 0 };
  }
  wk = app.trendByWeekday();
  assert.strictEqual(wk[wk.length - 1].name, 'Tuesday', 'the worst night is last');
  assert.strictEqual(wk[wk.length - 1].avg, 300);
  assert.ok(wk[0].avg === 2000, 'and the best is first');

  // A weekday with too FEW nights is left out rather than averaged from one.
  // Nine nights gives every weekday one or two, so NOTHING qualifies — and the
  // honest answer to "which night is best" is then no answer at all.
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 9; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  assert.strictEqual(app.trendByWeekday().length, 0,
    'nine nights is one or two per weekday — no weekday can be averaged yet');

  // Seventeen nights is 2×7 + 3, so exactly THREE weekdays reach the bar. The
  // rest stay out, and the screen says how many it left out.
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 17; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  wk = app.trendByWeekday();
  assert.strictEqual(wk.length, 3, 'only the weekdays with three nights are named');
  assert.ok(wk.every(w => w.nights >= 3), 'never an average from fewer than three nights');
  app.trendState({ open: true });
  assert.match(app.trendHTML(), /4 nights of the week are left out/,
    'and it says out loud what it is not telling him');
});

test('HOW THE NIGHTS COMPARE: what earned, and what did not (v2.11.0)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  for (const k in app.state.days) delete app.state.days[k];
  for (const k in app.state.counts) delete app.state.counts[k];
  for (let i = 1; i <= 12; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
    app.state.counts[d] = [
      { date: d, sku: 'box4', sod: 20, eod: 0, sold: 20, amount: 1000, free_qty: i === 3 ? 2 : 0 }
    ];
  }
  const mix = app.trendBySku();
  assert.strictEqual(mix.nights, 12);
  const b4 = mix.rows.find(r => r.sku === 'box4');
  assert.strictEqual(b4.sold, 240, 'units come from `sold` — what left the tray');
  assert.strictEqual(b4.amount, 12000, 'money comes from the row\'s OWN stored amount');
  assert.strictEqual(b4.free, 2, 'and what was given away is counted apart, not hidden');

  // AN ACTIVE SKU THAT SOLD NOTHING IS THE MOST USEFUL LINE ON THE LIST, so it
  // must appear rather than being absent for lack of a row.
  const idle = mix.rows.filter(r => r.sold === 0 && r.amount === 0);
  assert.ok(idle.length >= 1, 'a product that earned nothing is still listed');
  assert.ok(idle.some(r => r.sku !== 'box4'));

  // Sorted by money, so the answer to "what is earning" is the first line.
  assert.strictEqual(mix.rows[0].sku, 'box4');

  // A night OUTSIDE the window contributes nothing. The window is the last 30
  // OPEN nights, so proving that needs more than thirty nights to exist — with
  // only a dozen logged, a night sixty days back is still inside the window and
  // counting it would be correct.
  for (let i = 13; i <= 34; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
    app.state.counts[d] = [{ date: d, sku: 'box4', sod: 20, eod: 0, sold: 20, amount: 1000 }];
  }
  const inWindow = app.trendBySku();
  assert.strictEqual(inWindow.nights, 30, 'the window caps at thirty open nights');
  assert.strictEqual(inWindow.rows.find(r => r.sku === 'box4').amount, 30000,
    'thirty nights at 1,000 — the four oldest nights are outside and add nothing');
});

test('HOW THE NIGHTS COMPARE: a running cutoff is never compared to a whole one (v2.11.0)', () => {
  // The v2.9.4 lesson, in the one other place it applies: a fortnight that is
  // still running has fewer nights in it, so setting it beside a finished one
  // invents a fall that never happened.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 70; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  const cut = app.trendCutoffs();
  assert.ok(cut, 'two finished cutoffs are available');
  const live = app.currentPeriod(TODAY);
  assert.notStrictEqual(cut.latest.start, live.start,
    'the cutoff being lived in is NOT the one reported');
  assert.ok(cut.latest.end < TODAY, 'the newer of the two has finished');
  assert.ok(cut.before.end < cut.latest.start, 'and the other is the one before it');
  assert.strictEqual(cut.latest.avg, 1000);
  assert.strictEqual(cut.change, cut.latest.total - cut.before.total);

  // With only one fortnight of history there is nothing to compare it TO, and
  // it says so instead of comparing against zero.
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 5; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  assert.strictEqual(app.trendCutoffs(), null, 'one cutoff is not a comparison');
});

test('HOW THE NIGHTS COMPARE: thin history says so, and says why (v2.11.0)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  for (const k in app.state.days) delete app.state.days[k];
  app.trendState({ open: true });

  // Nothing at all.
  assert.match(app.trendHTML(), /No finished nights are logged yet/);

  // Some, but not enough to act on — and it names how many and how many are
  // needed, rather than looking broken.
  for (let i = 1; i <= 3; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  const h = app.trendHTML();
  assert.match(h, /Only 3 nights are logged so far/);
  assert.match(h, /at least 8/, 'the bar is stated, not hidden');
  assert.match(h, /fill in on its own/, 'and it is not asking her to do anything');

  // Closed until asked for: it must not compute on every render of More.
  app.trendState({ open: false });
  assert.match(app.trendHTML(), /Show me the nights/);
  assert.ok(!/Average take/.test(app.trendHTML()), 'nothing is worked out until it is opened');
});

test('STOCK RUNWAY: how long it lasts, at the rate it is actually going (v2.10.2)', () => {
  // The reorder point is a fixed figure — "buy more at 2 packs or less" — and it
  // cannot know that two packs is four nights of flour and half a night of gas.
  // He buys when things run out, so the useful sentence is "about three nights
  // left", early enough to buy on the way home.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  // Dated on the CLIENT's own clock, not ymdDaysAgo's: that helper is pinned to
  // the stub's frozen early-August time, while the phone runs on the real one —
  // so "tonight" would land weeks in the past and be counted as history.
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  // The window is built so EVERY exclusion is load-bearing:
  //   back(12) = the count day itself — open, and must NOT be measured (a
  //              stocktake is an end-of-day figure that already reflects it)
  //   back(11) = a CLOSED night — nothing was opened, so it must not slow the
  //              rate down and make the shelf look longer-lasting than it is
  //   back(1..10) = the ten nights that really are the measurement
  const BASE = back(12);
  for (const k in app.state.days) delete app.state.days[k];
  app.state.days[BASE] = { date: BASE, closed: false, total: 900, cash: 900, gcash: 0 };
  const shutNight = back(11);
  app.state.days[shutNight] = { date: shutNight, closed: true, total: 0, cash: 0, gcash: 0 };
  // Ten open nights since the count, 20 packs opened across them = 2 a night.
  for (let i = 1; i <= 10; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  const item = { product: 'Takoyaki Flour', unit: 'pack', baseline_date: BASE,
                 baseline_qty: 26, used_since: 20, on_hand: 6, reorder_at: 2, low: false };

  const r = app.stockRunway(item);
  assert.ok(r, 'ten nights is enough to measure');
  assert.strictEqual(r.nights, 10, 'measured over the OPEN nights since the count');
  assert.strictEqual(r.perNight, 2);
  assert.strictEqual(r.left, 3, 'six packs at two a night is three nights — FLOORED, not rounded up');
  assert.match(app.stockRunwayText(item), /About 3 nights left, at 2 packs a night over the last 10 nights/);

  // Both exclusions are already in the window above; state them as claims.
  assert.ok(app.state.days[shutNight].closed && shutNight > BASE,
    'precondition: the closed night really does sit inside the measured window');
  assert.strictEqual(app.stockRunway(item).nights, 10,
    'the closed night and the count day are both left out');

  // TONIGHT is not finished, so it is not counted — the same line the costing
  // draws at yesterday. One system, one answer.
  app.state.days[TODAY] = { date: TODAY, closed: false, total: 500, cash: 500, gcash: 0 };
  assert.strictEqual(app.stockRunway(item).nights, 10, 'tonight is not a measured night yet');

  // THIN HISTORY SAYS NOTHING. Four nights is a guess, and this app does not guess.
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 4; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  assert.strictEqual(app.stockRunway(item), null, 'four nights is not a rate');
  assert.strictEqual(app.stockRunwayText(item), '', 'and it says nothing at all');
});

test('STOCK RUNWAY: it stays quiet where it would only be noise (v2.10.2)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const TODAY = app.todayStr();
  const back = (n) => app.addDays(TODAY, -n);
  const BASE = back(11);
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 10; i++){
    const d = back(i);
    app.state.days[d] = { date: d, closed: false, total: 1000, cash: 1000, gcash: 0 };
  }
  const base = { product: 'Takoyaki Flour', unit: 'pack', baseline_date: BASE,
                 baseline_qty: 26, used_since: 20, on_hand: 6, reorder_at: 2, low: false };
  const with_ = (over) => Object.assign({}, base, over);

  // Nothing opened since the count: there is no rate, so there is no runway.
  assert.strictEqual(app.stockRunway(with_({ used_since: 0 })), null);
  // A negative on-hand already has its own, louder sentence on the card
  // ("count it again") — a runway would talk over it with arithmetic built on
  // the very figure that is wrong.
  assert.strictEqual(app.stockRunway(with_({ on_hand: -3 })), null);
  assert.strictEqual(app.stockRunway(with_({ on_hand: 0 })), null, 'nothing left is not a runway');
  // No baseline date at all (a never-counted product) — nothing to measure from.
  assert.strictEqual(app.stockRunway(with_({ baseline_date: '' })), null);

  // LESS THAN A NIGHT LEFT is said as itself, not as "about 0 nights".
  const tight = with_({ on_hand: 1 });          // 1 pack at 2 a night
  assert.strictEqual(app.stockRunway(tight).left, 0);
  assert.match(app.stockRunwayText(tight), /less than a night left\. Buy before opening\./);
  assert.ok(!/About 0 nights/.test(app.stockRunwayText(tight)), 'never "about 0 nights"');

  // A SLOW-MOVING product reads in fractions of a unit without pretending to
  // be precise: 2 gallons over 10 nights is a fifth of a gallon a night.
  const gas = with_({ product: 'Gas', unit: 'gallon', used_since: 2, on_hand: 3 });
  assert.strictEqual(app.stockRunway(gas).left, 15);
  assert.match(app.stockRunwayText(gas), /0\.2 of a gallon a night/);

  // A product with no unit on the sheet still reads as a sentence.
  const noUnit = with_({ unit: '' });
  assert.match(app.stockRunwayText(noUnit), /2 a night/);
});

test('a sku that always sells, suddenly selling none, is QUESTIONED (v2.10.0)', () => {
  // THE FAILURE THIS EXISTS FOR. nori read "nothing sold" for weeks because its
  // start count was stuck at 0 (v2.9.8), and every internal check was satisfied
  // the whole time: the arithmetic held, the counts were present, the buckets
  // balanced. Only the OTHER NIGHTS could have told anyone. This is the textbook
  // exception-report signal — an item that normally sells showing zero while the
  // stock says it was there.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const c = (sku, sod, eod) => ({ sku, sod, eod, cheese_qty:0, gcash_qty:0,
                                  gcash_cheese_qty:0, custom_qty:0 });
  const counts = {};
  // Ten counted nights: nori sold on nine of them.
  for (let i = 1; i <= 10; i++){
    const d = ymdDaysAgo(i);
    counts[d] = [c('box4', 30, 10), c('nori', 20, i === 5 ? 20 : 14)];
  }
  for (const k in app.state.counts) delete app.state.counts[k];
  Object.assign(app.state.counts, counts);

  app.loadBentaForm(ymdDaysAgo(0));
  const row = sku => app.benta.rows.find(r => r.sku === sku);
  // Tonight: the shelf was full and nothing moved — the nori signature exactly.
  row('nori').sod = 20; row('nori').eod = 20;
  row('box4').sod = 30; row('box4').eod = 10;

  const said = app.nightChecks().join('\n');
  assert.match(said, /nothing sold tonight/, 'the night must be questioned');
  assert.match(said, /sold on 9 of the last 10 nights/,
    'and the claim must be AUDITABLE — countable against her own paper');
  assert.match(said, /all 20 are still there/, 'naming the figure that says so');
  assert.match(said, /the end count is the figure to check/, 'and what to look at');
  // box4 sold normally, so it must not be dragged in.
  assert.ok(!/Box 4/.test(said), 'a sku that behaved is not mentioned');

  // AN EMPTY SHELF IS NOT AN ANOMALY. If there was no nori to sell, not selling
  // any is the only possible outcome — saying "nothing sold, all 0 are still
  // there" would be noise, and noise is what makes a warning stop being read.
  row('nori').sod = 0; row('nori').eod = 0;
  assert.ok(!/nothing sold tonight/.test(app.nightChecks().join('\n')),
    'no stock to sell means nothing to question');
  row('nori').sod = 20; row('nori').eod = 20;      // back to the real signature
  assert.match(app.nightChecks().join('\n'), /nothing sold tonight/);

  // IT NEVER REFUSES. The night stays savable — this is a question, not a rule.
  const errs = app.validateBenta();
  assert.deepStrictEqual(Object.keys(errs).filter(k => errs[k]), [],
    'a plausibility question must never block Save day');

  // If the shelf really did empty on those nights too — i.e. nori does NOT
  // usually sell — it says nothing.
  const quiet = loadClient();
  quiet.applyBootstrap(F.boot);
  const rare = {};
  for (let i = 1; i <= 10; i++) rare[ymdDaysAgo(i)] = [c('nori', 20, 20)];
  for (const k in quiet.state.counts) delete quiet.state.counts[k];
  Object.assign(quiet.state.counts, rare);
  quiet.loadBentaForm(ymdDaysAgo(0));
  const qr = quiet.benta.rows.find(r => r.sku === 'nori');
  qr.sod = 20; qr.eod = 20;
  assert.ok(!/nothing sold tonight/.test(quiet.nightChecks().join('\n')),
    'a sku that rarely sells must not be questioned for not selling');
});

test('it says NOTHING from thin history, and blanks are never evidence (v2.10.0)', () => {
  // An opinion drawn from three nights is a guess, and this app does not guess.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const c = (sku, sod, eod) => ({ sku, sod, eod, cheese_qty:0, gcash_qty:0,
                                  gcash_cheese_qty:0, custom_qty:0 });
  const put = (obj) => { for (const k in app.state.counts) delete app.state.counts[k];
                         Object.assign(app.state.counts, obj); };

  const five = {};
  for (let i = 1; i <= 5; i++) five[ymdDaysAgo(i)] = [c('nori', 20, 14)];
  put(five);
  app.loadBentaForm(ymdDaysAgo(0));
  let r = app.benta.rows.find(x => x.sku === 'nori');
  r.sod = 20; r.eod = 20;
  assert.strictEqual(app.nightChecks().length, 0, 'five nights is not enough to have a view');

  // Six nights IS enough — the boundary is real, not decorative.
  const six = {};
  for (let i = 1; i <= 6; i++) six[ymdDaysAgo(i)] = [c('nori', 20, 14)];
  put(six);
  app.loadBentaForm(ymdDaysAgo(0));
  r = app.benta.rows.find(x => x.sku === 'nori');
  r.sod = 20; r.eod = 20;
  assert.match(app.nightChecks().join('\n'), /nothing sold tonight/, 'six nights is');

  // Ten nights that were never finished counting are not ten nights of
  // evidence: a blank figure says nothing, here as everywhere in this app.
  const blanks = {};
  for (let i = 1; i <= 10; i++) blanks[ymdDaysAgo(i)] = [c('nori', 20, '')];
  put(blanks);
  app.loadBentaForm(ymdDaysAgo(0));
  r = app.benta.rows.find(x => x.sku === 'nori');
  r.sod = 20; r.eod = 20;
  assert.strictEqual(app.soldHistory('nori', ymdDaysAgo(0), 10).length, 0,
    'a night with an unread close is not comparable');
  assert.strictEqual(app.nightChecks().length, 0, 'so it holds its tongue');
});

test('a night far from the usual take is flagged, and the card waits its turn (v2.10.0)', () => {
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const c = (sku, sod, eod) => ({ sku, sod, eod, cheese_qty:0, gcash_qty:0,
                                  gcash_cheese_qty:0, custom_qty:0 });
  // Ten ordinary nights at about ₱4,600, plus one CLOSED night — which must not
  // drag the usual figure down, because a closed night is not a slow night.
  for (const k in app.state.counts) delete app.state.counts[k];
  for (const k in app.state.days) delete app.state.days[k];
  for (let i = 1; i <= 10; i++) app.state.counts[ymdDaysAgo(i)] = [c('box4', 40, 10)];

  // The usual take is derived from the very counts above, so the fixture cannot
  // quietly disagree with itself: 30 box4 a night, priced by the real client.
  app.loadBentaForm(ymdDaysAgo(0));
  const row = sku => app.benta.rows.find(r => r.sku === sku);
  row('box4').sod = 40; row('box4').eod = 10;
  const usual = Number(app.computeDay(app.bentaPayload()).total);
  assert.ok(usual > 0, 'precondition: an ordinary night takes something');
  for (let i = 1; i <= 10; i++){
    const d = ymdDaysAgo(i);
    app.state.days[d] = { date: d, closed: false, total: usual, cash: usual, gcash: 0 };
  }
  const shut = ymdDaysAgo(11);
  app.state.days[shut] = { date: shut, closed: true, total: 0, cash: 0, gcash: 0 };
  assert.strictEqual(app.medianOf(app.totalHistory(ymdDaysAgo(0), 10)), usual);
  assert.ok(!app.totalHistory(ymdDaysAgo(0), 20).includes(0),
    'a closed night contributes no zero to the usual figure');

  // An ordinary night says nothing at all — this must be quiet most nights.
  assert.strictEqual(app.nightChecks().length, 0, 'a normal night draws no card');

  // Two sold instead of thirty: said plainly, and said as a POSSIBILITY — a
  // slow night is a real thing and this must not accuse.
  row('box4').sod = 40; row('box4').eod = 38;
  let said = app.nightChecks().join('\n');
  assert.match(said, /where your last 10 nights ran about/, 'the comparison is named');
  assert.match(said, /can simply be a slow night/, 'and it does not accuse');
  assert.match(said, /what a missed count looks like/, 'while naming the other reading');

  // A night well ABOVE the usual is worth one look too (a fat-fingered count
  // reads high just as easily as low).
  row('box4').sod = 400; row('box4').eod = 10;
  assert.match(app.nightChecks().join('\n'), /well above the/, 'both directions are checked');

  // A CLOSED night is never judged. Set up so a check WOULD fire if it were —
  // the stall was shut, so "nothing sold" is the whole point, not an anomaly.
  for (let i = 1; i <= 10; i++) app.state.counts[ymdDaysAgo(i)] = [c('box4', 40, 10), c('nori', 20, 14)];
  app.loadBentaForm(ymdDaysAgo(0));
  row('box4').sod = 40; row('box4').eod = 10;
  row('nori').sod = 20; row('nori').eod = 20;      // the zero signature, armed
  assert.match(app.nightChecks().join('\n'), /nothing sold tonight/,
    'precondition: open, this night WOULD be questioned');
  app.benta.closed = true;
  assert.strictEqual(app.nightChecks().length, 0,
    'shut for the night is not an anomaly — nothing sold is the point');
  app.benta.closed = false;

  // A CLOSED night in HISTORY must not drag the usual take down. The sheet is
  // edited by hand, so a closed row carrying a figure is not impossible — and
  // counting it would make every ordinary night afterwards look suspicious.
  const oddShut = ymdDaysAgo(12);
  app.state.days[oddShut] = { date: oddShut, closed: true, total: 1, cash: 1, gcash: 0 };
  assert.ok(!app.totalHistory(ymdDaysAgo(0), 20).includes(1),
    'a night marked closed is left out of the usual figure whatever it carries');

  // THE CARD WAITS ITS TURN. While any ordinary complaint stands, it draws
  // nothing — one thing to fix at a time, and the specific complaint first.
  // Armed so a check WOULD fire (nori's zero signature) AND a real complaint
  // stands (box4's start count with no end count, the v2.9.0 refusal). Without
  // the gate the two would talk over each other.
  row('nori').sod = 20; row('nori').eod = 20;
  row('box4').sod = 40; row('box4').eod = '';
  assert.match(app.nightChecks().join('\n'), /nothing sold tonight/,
    'precondition: there IS something this card would say');
  assert.ok(Object.keys(app.validateBenta()).some(k => app.validateBenta()[k]),
    'precondition: and the night is not savable');
  assert.strictEqual(app.nightCheckHTML(), '',
    'the specific complaint speaks first — one thing to fix at a time');

  // Once the night is savable, it appears — and it says it is not a blocker.
  row('box4').sod = 40; row('box4').eod = 38;
  const html = app.nightCheckHTML();
  assert.match(html, /One thing to check|A few things to check/);
  assert.match(html, /Nothing here stops you saving/,
    'it must say out loud that it is not a refusal');
});

test('the START COUNT carries for EVERY sku, nori included (v2.9.8)', () => {
  // HIS REPORT, 2026-08-27: "Bug in the starting count of nori, doesnt get the
  // count from the previous day." Reproduced in the browser first: prevEodFor
  // returned the right figure all along (8), and `if (!isBoxSku(r.sku)) continue`
  // threw it away. nori is ALWAYS group=simple, because the spec requires an
  // excluded sku to be — so his own line of business was the one thing the
  // prefill never carried. With a start of 0, counting 8 left read as
  // max(0, 0 − 8) = NOTHING SOLD, and the nori money vanished quietly.
  const app = loadClient();
  const D_OLD = ymdDaysAgo(5), D_MID = ymdDaysAgo(3), D_LAST = ymdDaysAgo(1), FRESH = ymdDaysAgo(0);
  app.applyBootstrap(F.boot);
  const row = sku => app.benta.rows.find(r => r.sku === sku) || {};
  const counts = (obj) => { for (const k in app.state.counts) delete app.state.counts[k];
                            Object.assign(app.state.counts, obj); };
  const c = (sku, sod, eod) => ({ sku, sod, eod, cheese_qty:0, gcash_qty:0,
                                  gcash_cheese_qty:0, custom_qty:0 });

  // 1. THE REPORTED BUG. Last night closed with 8 nori and 12 box4 on the shelf.
  counts({ [D_LAST]: [c('box4', 30, 12), c('nori', 20, 8)] });
  app.loadBentaForm(FRESH);
  assert.strictEqual(row('nori').sod, 8, 'nori must open at last night\'s close');
  assert.strictEqual(row('box4').sod, 12, 'and boxes must not have regressed');
  // The figure this was really about: 8 on the shelf, 8 left, nothing sold —
  // which is only sayable once the start count is right.
  row('nori').eod = 8;
  assert.strictEqual(app.bentaPayload().counts.find(x => x.sku === 'nori').sod, 8,
    'and the corrected start is what gets SENT, not just shown');

  // 2. It reaches back past a night that did not count nori at all.
  counts({ [D_OLD]: [c('nori', 10, 6)], [D_LAST]: [c('box4', 30, 9)] });
  app.loadBentaForm(FRESH);
  assert.strictEqual(row('nori').sod, 6, 'the latest night that DID count it wins');

  // 3. BLANK IS NEVER ZERO. Last night's nori EOD was never read, so nothing is
  // known about what was left: prefill NOTHING and let her count it. Asserting 0
  // would make tonight read high; reaching further back would carry a stale
  // figure across a night we know happened.
  counts({ [D_OLD]: [c('nori', 10, 6)], [D_LAST]: [c('nori', 20, '')] });
  app.loadBentaForm(FRESH);
  assert.notStrictEqual(row('nori').sod, 6,
    'an unread close must NOT reach back past the night it belongs to — that figure is stale');
  // Asserted on the LOOKUP, because through `sod` alone this is invisible: the
  // fresh-row default is already 0, so "prefilled 0" and "not prefilled" look
  // identical on the form. The lookup is where the distinction lives.
  assert.strictEqual(app.prevEodFor('nori', D_LAST < FRESH ? FRESH : FRESH), '',
    'an unread close is NOT an answer of zero — the lookup must say it has none');
  // What is left is the form's own default for a fresh row (0), NOT a claim
  // about last night. Worth stating plainly: a legacy row saved before v2.9.0's
  // blank-EOD refusal is the only way to reach this, and the honest reading of
  // it is "nobody knows", which the prefill declines to guess at.
  const noHistory = (() => { counts({}); app.loadBentaForm(FRESH); return row('nori').sod; })();
  counts({ [D_OLD]: [c('nori', 10, 6)], [D_LAST]: [c('nori', 20, '')] });
  app.loadBentaForm(FRESH);
  assert.strictEqual(row('nori').sod, noHistory,
    'an unread close leaves the row exactly as if there were no history — it invents nothing');

  // 4. A TYPED ZERO IS AN ANSWER — the tray emptied — and must carry as 0.
  counts({ [D_LAST]: [c('nori', 20, 0)] });
  app.loadBentaForm(FRESH);
  assert.strictEqual(row('nori').sod, 0, 'zero is a real close and carries');

  // 5. A day with its OWN saved counts is never overwritten by a prefill.
  counts({ [D_MID]: [c('nori', 20, 8)], [D_LAST]: [c('nori', 15, 4)] });
  app.loadBentaForm(D_LAST);
  assert.strictEqual(row('nori').sod, 15, 'its own figures, never the night before\'s close');

  // 6. Nothing before it at all: the row keeps the form's default, and no
  // figure is conjured from an empty history.
  counts({});
  app.loadBentaForm(FRESH);
  assert.strictEqual(app.prevEodFor('nori', FRESH), '',
    'no history means the lookup itself says so, rather than answering 0');
});

test('SOD prefill: a fresh date opens at the previous close; a saved day loads its own', () => {
  const srv = loadServer();
  const D1 = ymdDaysAgo(6), D2 = ymdDaysAgo(4), CLOSED = ymdDaysAgo(2), FRESH = ymdDaysAgo(3);
  // Night one: box4 closes at 4, box6 at 5, nori (simple) at 3.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D1, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [
      { sku: 'box4', sod: 10, eod: 4 }, { sku: 'box6', sod: 6, eod: 5 },
      { sku: 'nori', sod: 4, eod: 3 }
    ], entryId: 'pf-d1' } }).ok, true);
  // Night two: only box4 was counted, closing at 2.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D2, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box4', sod: 7, eod: 2 }], entryId: 'pf-d2' } }).ok, true);
  // A closed day after those: no counts on it, and it must not blank the chain.
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: CLOSED, closed: true, staff: '', customAmount: 0, customGcash: 0, notes: '',
    counts: [], entryId: 'pf-closed' } }).ok, true);
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const app = syncedClient(boot.data);

  // A date with NO saved counts: each BOX sku opens at its latest prior close.
  app.loadBentaForm(FRESH);
  const row = sku => app.benta.rows.find(r => r.sku === sku);
  assert.strictEqual(row('box4').sod, 2, 'the LATEST prior day (D2) wins, not the older D1');
  assert.strictEqual(row('box6').sod, 5, 'a sku D2 did not count reaches back to D1');
  // PIN REVERSED (v2.9.8, owner-directed): v2.7.0 narrowed the prefill to
  // group=box and gave no reason for it anywhere — not here, not in SPEC. nori
  // is counted in and out exactly like a box, and `sold` is sod − eod for every
  // sku, so the narrowing simply lost his nori money. It now carries like any
  // other sku, reaching back to D1 because D2 did not count it.
  assert.strictEqual(row('nori').sod, 3, 'a SIMPLE sku carries over too (v2.9.8)');
  assert.strictEqual(row('box4').eod, 0, 'only the SOD is prefilled — EOD is tonight\'s count');
  // A prefill, never a lock: it is an ordinary editable figure on the row.
  row('box4').sod = 9;
  assert.strictEqual(app.bentaPayload().counts.find(c => c.sku === 'box4').sod, 9);

  // A SAVED day always loads its own figures — never a prefill over them.
  app.loadBentaForm(D2);
  assert.strictEqual(row('box4').sod, 7, 'its own SOD, not D1\'s EOD');
  assert.strictEqual(row('box4').eod, 2);
  assert.strictEqual(row('box6').sod, 0,
    'a saved day shows exactly what it stored — box6 was not counted that night');

  // The day after the CLOSED day still opens at D2's close: a closed day has no
  // counts and the lookup walks past it.
  app.loadBentaForm(ymdDaysAgo(1));
  assert.strictEqual(row('box4').sod, 2);

  // The lookup itself: strictly-before, latest-first, '' when nothing prior.
  assert.strictEqual(app.prevEodFor('box4', FRESH), 2);
  assert.strictEqual(app.prevEodFor('box4', D2), 4, 'from D2 the prior close is D1\'s');
  assert.strictEqual(app.prevEodFor('box4', D1), '', 'no prior day: say nothing, not 0');

  // And a phone with no history at all prefills nothing.
  const blank = loadClient();
  blank.loadBentaForm(clientYmd(0));
  blank.benta.rows.forEach(r => assert.strictEqual(r.sod, 0, r.sku + ' invented an opening count'));
});

test('the GCash card starts collapsed only when every figure in it is 0', () => {
  const srv = loadServer();
  const ALLCASH = ymdDaysAgo(5), CONV = ymdDaysAgo(4), BUCKET = ymdDaysAgo(3);
  const day = (date, extra, id) => post(srv.ctx, { token: srv.token, action: 'saveDay',
    payload: Object.assign({ date, closed: false, staff: 'Mama', customAmount: 0,
      customGcash: 0, notes: '', counts: [Object.assign({ sku: 'box4', sod: 5, eod: 0 },
      extra.count || {})], entryId: id }, extra.top || {}) });
  assert.strictEqual(day(ALLCASH, {}, 'gc-a').ok, true);
  assert.strictEqual(day(CONV, { top: { gcashConverted: 20 } }, 'gc-b').ok, true);
  assert.strictEqual(day(BUCKET, { count: { gcashQty: 1 } }, 'gc-c').ok, true);
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data;

  const app = syncedClient(boot);
  app.loadBentaForm(ALLCASH);
  assert.strictEqual(app.gcashHeld(), false, 'an all-cash night holds no GCash figure');
  assert.strictEqual(app.benta.gcashOpen, false, 'so the card starts closed');
  app.loadBentaForm(CONV);
  assert.strictEqual(app.gcashHeld(), true, 'converted cash alone counts — it lives in this card');
  assert.strictEqual(app.benta.gcashOpen, true, 'nothing already entered is ever hidden');
  const app2 = syncedClient(boot);
  app2.loadBentaForm(BUCKET);
  assert.strictEqual(app2.benta.gcashOpen, true, 'a GCash bucket opens it too');
  // The head figure is everything THIS card controls (sku GCash + conversion).
  assert.strictEqual(app2.gcashSummaryText(app2.computeDay(app2.bentaPayload())), '₱50');
});

test('the phone refuses the conversion and the special order in the SERVER\'s own words', () => {
  const { srv, boot } = v27Fixture();
  // Converted cash above the day's cash: byte-compare against the live server.
  let app = syncedClient(boot);
  app.loadBentaForm(V27_DAY);
  app.benta.gcashConverted = 100000;
  const convErr = app.validateBenta().gcashConverted;
  const p1 = app.bentaPayload();
  p1.entryId = 'v27-conv-refuse';
  const r1 = post(srv.ctx, { token: srv.token, action: 'saveDay', payload: p1 });
  assert.strictEqual(r1.ok, false, 'precondition: the server refuses this day');
  assert.strictEqual(convErr, r1.error,
    'the inline refusal must be the server\'s sentence, byte for byte');
  // Special-order boxes beyond sold: same rule, same words.
  app = syncedClient(boot);
  app.loadBentaForm(V27_DAY);
  app.benta.rows.find(r => r.sku === 'box4').custom = 99;
  const cboxErr = app.validateBenta()['cbox:box4'];
  const p2 = app.bentaPayload();
  p2.entryId = 'v27-cbox-refuse';
  const r2 = post(srv.ctx, { token: srv.token, action: 'saveDay', payload: p2 });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(cboxErr, r2.error);
  // A day the phone finds clean still lands (the validator blocks no good save).
  app = syncedClient(boot);
  app.loadBentaForm(V27_DAY);
  assert.deepStrictEqual(Object.keys(app.validateBenta()), [], 'the loaded day is clean');
});

test('"Sold with cash" is display only, and the receipt says the new lines only when non-zero', () => {
  const { boot } = v27Fixture();
  const app = syncedClient(boot);
  app.loadBentaForm(V27_DAY);
  const c = app.computeDay(app.bentaPayload());
  const recap = app.cashRecapHTML(c);
  assert.ok(recap.indexOf('4 regular × ₱50 + 2 cheese × ₱60') !== -1,
    'the remainder spells out its own arithmetic');
  assert.ok(recap.indexOf('Custom order paid in cash') !== -1, '500 − 100 GCash = 400 in cash');
  assert.ok(recap.indexOf('Converted to GCash') !== -1 && recap.indexOf('−₱120') !== -1,
    'the conversion is shown leaving the cash');
  assert.ok(recap.indexOf('₱600') !== -1, 'and the figure she counts the tin against');
  assert.strictEqual(/<input|<button|data-act=/.test(recap), false,
    'display only: nothing in this card can be typed or tapped');

  // The screen order and the receipt guards are render code, so: source pins.
  const render = slab('function renderBenta(){', 'const CHEV =');
  const iBox = render.indexOf('>Box counts<');
  const iGcash = render.indexOf('gcashCardHTML(');
  const iCash = render.indexOf('id="cashRecap"');
  assert.ok(iBox !== -1 && iGcash !== -1 && iCash !== -1, 'all three sections must render');
  assert.ok(iBox < iGcash && iGcash < iCash, '① Box counts, ② Sold with GCash, ③ Sold with cash — in that order');
  assert.ok(/How many were cheese\?/.test(render), '① carries the cheese FACT stepper');
  const receipt = slab('function updateReceipt(){', 'function rLine(label, amt){');
  assert.ok(/c\.gcashConverted > 0/.test(receipt),
    'the converted-cash sentence prints only when non-zero');
  assert.ok(/c\.lidBoxes > 0/.test(receipt), 'the lid count prints only when non-zero');
  // v2.10.1: the "less …" clause now covers both reasons a sold unit was not
  // priced, joined in one sentence rather than two competing ones.
  assert.ok(/for the special order/.test(receipt) && /given away or ruined/.test(receipt),
    'an affected sku says where its boxes went — to the order, or given away');
  assert.ok(/aside\.length \? ', less ' \+ aside\.join\(' and '\)/.test(receipt),
    'and both reasons read as one clause when both apply');
  assert.ok(/cashRecapHTML\(/.test(receipt),
    'the recap is rebuilt by updateReceipt — one sum, one voice');
});

test('the expense buckets cross the seam, and each tap files exactly one way (v2.7.1)', () => {
  // The owner's list: the form is ONE row — Octopus, the picklist, Other —
  // with no free text and no category chips. PIN MOVED (v2.7.1, deliberate):
  // the v2.7.0 "Something else"/showCats pins are gone WITH the paths they
  // pinned; the mapping they protected (a picked name files as Supplies with
  // that name as the item) is pinned below in its new form.
  const BUCKETS = ['Veggies', 'Eggs', 'Flour', 'Box'];
  // Demo mode (no bootstrap ever): the chips are there from day one.
  const demo = loadClient();
  assert.deepStrictEqual(demo.supplyPicklist(), BUCKETS);
  // The seeded sheet value survives the seam.
  const app = syncedClient(F.boot);
  assert.deepStrictEqual(app.supplyPicklist(), BUCKETS);
  // An owner-edited list is split like `staff`: trimmed, empties dropped.
  const edited = syncedClient(Object.assign({}, F.boot,
    { settings: Object.assign({}, F.boot.settings, { supply_picklist: ' Flour , Eggs ,, ' }) }));
  assert.deepStrictEqual(edited.supplyPicklist(), ['Flour', 'Eggs']);
  // Empty leaves just the two category buckets — the row never disappears.
  const none = syncedClient(Object.assign({}, F.boot,
    { settings: Object.assign({}, F.boot.settings, { supply_picklist: '' }) }));
  assert.deepStrictEqual(none.supplyPicklist(), []);
  // Maintenance sends an edit; a cleared field means leave-alone, never wipe.
  assert.strictEqual(app.maintSettingsPayload({ supply_picklist: 'Flour, Eggs' }).supply_picklist,
    'Flour, Eggs');
  assert.ok(!has(app.maintSettingsPayload({ supply_picklist: '  ' }), 'supply_picklist'));

  // The expense form is render code, so the mapping is pinned at source.
  const gastos = slab('function renderGastos(){', 'function submitGasto(){');
  assert.ok(/\['Octopus', \.\.\.plist, 'Other'\]/.test(gastos),
    'the row is Octopus, the picklist, Other — in that order, always');
  assert.ok(/supplyPicklist\(\)\.filter\(n => n !== 'Octopus' && n !== 'Other'\)/.test(gastos),
    'a picklist name colliding with a bucket is not offered — one tap, one meaning');
  assert.ok(!/Something else/.test(gastos), 'the free-text path is gone from this form');
  assert.ok(!/gastos-cat/.test(gastos), 'and so are the category chips');
  const submit = slab('function submitGasto(){', 'function deleteGasto(id){');
  assert.ok(/const isBucket = gx\.pick === 'Octopus' \|\| gx\.pick === 'Other'/.test(submit),
    'Octopus and Other are the two category buckets on this screen');
  assert.ok(/category: isBucket \? gx\.pick : 'Supplies'/.test(submit),
    'a picked supply IS category Supplies — the note line depends on it');
  assert.ok(/item: isBucket \? '' : gx\.pick/.test(submit),
    'the picked name is the item; the buckets carry none');
  assert.ok(/backlogRef: ''/.test(submit),
    'backlog payments live on the Cutoff screen, never here');
});

test('the conversion converts BOTH ways (v2.7.3): signed on the wire, a chip on the screen', () => {
  const srv = loadServer();
  const D = ymdDaysAgo(2);
  // A night with ₱100 of GCash sales, then ₱60 of GCash cashed out of the tin.
  const r = post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    gcashConverted: -60,
    counts: [{ sku: 'box4', sod: 10, eod: 0, cheeseQty: 0, gcashQty: 2, gcashCheeseQty: 0 }],
    entryId: 'conv-io-1' } });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual([r.data.total, r.data.gcash, r.data.cash], [500, 40, 460],
    'Total unmoved; GCash 100 − 60 cashed out; the tin gains the 60');
  // The signed value crosses the seam, and the form shows size and direction —
  // never a minus sign.
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const app = syncedClient(boot.data);
  assert.strictEqual(app.state.days[D].gcash_converted, -60);
  app.loadBentaForm(D);
  assert.strictEqual(app.num(app.benta.gcashConverted), 60, 'the amount box holds the size, unsigned');
  assert.strictEqual(app.benta.convDir, 'in', 'the chip holds the direction');
  const p = app.bentaPayload();
  assert.strictEqual(p.gcashConverted, -60, 'and the payload re-carries the sign');
  const c = app.computeDay(p);
  assert.deepStrictEqual([c.total, c.gcash, c.cash], [500, 40, 460], 'preview = server, to the peso');
  // The phone refuses past the GCash floor in the server's own sentence.
  app.benta.gcashConverted = '101';
  const errs = app.validateBenta();
  assert.match(String(errs.gcashConverted || ''),
    /The GCash taken out as cash \(101\) cannot be more than the day's GCash \(100\)\./);
  // And past the cash floor the other way, unchanged from v2.7.0.
  app.benta.convDir = 'out';
  app.benta.gcashConverted = '9999';
  assert.match(String(app.validateBenta().gcashConverted || ''),
    /cannot be more than the day's cash/);
  // Source pins for the DOM-bound half: the two direction chips exist and the
  // payload derives its sign from the chip, never from typed text.
  assert.match(HTML, /data-act="conv-dir" data-dir="out"/);
  assert.match(HTML, /data-act="conv-dir" data-dir="in"/);
  assert.match(HTML, /\(benta\.convDir === 'in' \? -1 : 1\) \* Math\.max\(0, num\(benta\.gcashConverted\)\)/);
});

atest('a queued pre-2.7.0 saveDay drains and lands byte-identical to the explicit defaults', async () => {
  const srvA = loadServer();
  const srvB = loadServer();
  const D = ymdDaysAgo(5);
  // Exactly what a pre-2.7.0 build persisted in queue_v1: no gcashConverted,
  // no lidBoxes, no customBoxes key at all.
  const oldPayload = {
    date: D, closed: false, staff: 'Mama', customAmount: 250, customGcash: 50, notes: '',
    counts: [{ sku: 'box4', sod: 8, eod: 2, cheeseQty: 1, gcashQty: 1, gcashCheeseQty: 0 }],
    entryId: 'q-pre27-1'
  };
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srvA.token;
  app.queue.push({ action: 'saveDay', payload: oldPayload, tries: 0 });
  app.hooks.fetch = liveWire(srvA);
  await app.drainQueue();
  assert.strictEqual(app.queue.length, 0, 'the queued night landed');

  // Control: the SAME night sent with the explicit v2.7.0 defaults.
  const rB = post(srvB.ctx, { token: srvB.token, action: 'saveDay',
    payload: Object.assign({}, oldPayload, { gcashConverted: 0, lidBoxes: 0, customBoxes: [] }) });
  assert.strictEqual(rB.ok, true, rB.error);

  const bootA = post(srvA.ctx, { token: srvA.token, action: 'bootstrap', payload: {} }).data;
  const bootB = post(srvB.ctx, { token: srvB.token, action: 'bootstrap', payload: {} }).data;
  assert.deepStrictEqual(bootA.days.find(d => d.date === D), bootB.days.find(d => d.date === D),
    'the stored day must be byte-identical — absence means the harmless default');
  assert.deepStrictEqual(bootA.counts.filter(c => c.date === D), bootB.counts.filter(c => c.date === D));
  // And the phone's mirror says the same after the drain's own refresh.
  assert.strictEqual(app.state.days[D].gcash_converted, 0);
  assert.strictEqual(app.state.days[D].lid_boxes, 0);
});

// ---------------------------------------------------------------------------
// 20. v2.8.0 "What it costs" across the seam. The costing is computed ENTIRELY
// on the server and rendered entirely on the phone, so there is no arithmetic
// to cross-check here — the seam itself is the whole risk. Every one of these
// keys is read by ONE screen and by nothing else, which is what makes a slip
// silent: the screen prints a dash for a missing figure on purpose, so a
// camelCase key would render as "we do not know" rather than as an error.
//
// The two editable costs get the harsher treatment, because they travel BACK:
// a blank that arrives as 0 does not just display wrong, it is written into the
// owner's sheet on the next Maintenance save and prices his balls at nothing.
// ---------------------------------------------------------------------------
console.log('\n--- 20. v2.8.0 across the seam: what it costs, unit_cost, box_cost ---');

/** A client with the costing section OPEN on a given server reply. */
function costingClient(bootData, costData, target) {
  const app = syncedClient(bootData);
  app.costState({ open: true, per: { start: PERIOD.start, end: PERIOD.end },
    target: target === undefined ? '' : target,
    res: costData ? { key: PERIOD.start + '_' + PERIOD.end,
      target: target === undefined ? '' : target, data: costData } : null });
  return app;
}

test('box_cost and unit_cost round-trip the normalizers — blank stays BLANK, 0.375 stays 0.375', () => {
  const app = syncedClient(F.boot);
  const box4 = app.state.prices.find(p => p.sku === 'box4');
  assert.strictEqual(box4.box_cost, 0.375,
    'a third of a centavo survives the seam unrounded — r2 here would restate his own figure');
  assert.strictEqual(app.state.prices.find(p => p.sku === 'nori').box_cost, 0,
    'an explicit 0 is an ANSWER and must arrive as 0, not as blank');
  const flour = app.state.stockItems.find(i => i.product === 'Takoyaki Flour');
  assert.strictEqual(flour.unit_cost, 120);

  // The blank half, which is the one that can write ₱0 into the sheet. Cleared
  // through the REAL server, read back through the REAL normalizers.
  assert.strictEqual(post(F.ctx, { token: F.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: 65, cheesePrice: 80, active: true, boxCost: '' }] } }).ok, true);
  assert.strictEqual(post(F.ctx, { token: F.token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Bonito', unit: 'pack', reorderAt: '', active: true, unitCost: '' }] } }).ok, true);
  const boot2 = post(F.ctx, { token: F.token, action: 'bootstrap', payload: {} });
  assertPairs('bootstrap.prices[]', boot2.data.prices, CONTRACT['bootstrap.prices[]']);
  assertPairs('bootstrap.stockItems[]', boot2.data.stockItems, CONTRACT['bootstrap.stockItems[]']);
  const app2 = syncedClient(boot2.data);
  assert.strictEqual(app2.state.prices.find(p => p.sku === 'box6').box_cost, '',
    'a blank cell must reach the phone as BLANK — as 0 it would come straight back and price the box free');
  assert.strictEqual(app2.state.stockItems.find(i => i.product === 'Bonito').unit_cost, '');

  // ...and an OLDER deployment that still spells them camelCase must not zero
  // them either (the compatibility fallback every other key gets).
  const legacyBoot = Object.assign({}, F.boot, {
    prices: toLegacy(F.boot.prices, CONTRACT['bootstrap.prices[]']),
    stockItems: toLegacy(F.boot.stockItems, CONTRACT['bootstrap.stockItems[]'])
  });
  const app3 = syncedClient(legacyBoot);
  assert.strictEqual(app3.state.prices.find(p => p.sku === 'box4').box_cost, 0.375);
  assert.strictEqual(app3.state.stockItems.find(i => i.product === 'Takoyaki Flour').unit_cost, 120);
});

test('a cost the payload does not mention is LEFT ALONE on the phone too', () => {
  const app = syncedClient(F.boot);
  // What a build that predates this release still has sitting in queue_v1: a
  // price row and a stock row with no cost key at all. Applied locally, both
  // costs must be exactly where they were, or the phone and the sheet start
  // disagreeing about what a box costs.
  app.applyLocalPrices({ rows: [{ sku: 'box4', price: 55, cheesePrice: 65, active: true, inCutoff: true }] });
  const box4 = app.state.prices.find(p => p.sku === 'box4');
  assert.strictEqual(box4.price, 55, 'the price DID move');
  assert.strictEqual(box4.box_cost, 0.375, 'and the cost did not');
  app.applyLocalStockItems({ rows: [{ product: 'Takoyaki Flour', unit: 'sako', reorderAt: 9, active: true }] });
  const flour = app.state.stockItems.find(i => i.product === 'Takoyaki Flour');
  assert.strictEqual(flour.unit, 'sako');
  assert.strictEqual(flour.unit_cost, 120, 'an omitted unitCost is not a ₱0 unit cost');
  // An explicitly typed figure travels and lands UNROUNDED.
  app.applyLocalPrices({ rows: [{ sku: 'box4', price: 55, cheesePrice: 65, active: true, boxCost: 0.425 }] });
  assert.strictEqual(app.state.prices.find(p => p.sku === 'box4').box_cost, 0.425,
    'r2 here would round his 0.425 to 0.43 and drift by pesos over a hundred boxes');
});

test('the Maintenance payload OMITS a blank cost field, on both cards', () => {
  // saveMaintPrices / saveMaintStock are DOM-bound (they read the live inputs
  // and then enqueue), so the omission rule is pinned against the source — the
  // behaviour it produces is pinned above, through applyLocal*, and on the
  // server side in run-tests.js.
  assert.match(HTML, /if \(txt\(m\.boxCost\)\.trim\(\) !== ''\) row\.boxCost = num\(m\.boxCost\);/,
    'a blank box-cost field must leave the KEY OUT — never send 0, never blank the cell');
  assert.match(HTML, /if \(unitCost !== ''\) row\.unitCost = num\(unitCost\);/,
    'and the same on the stock list');
  assert.ok(!/row\.boxCost = r2\(/.test(HTML), 'the box cost is never rounded on the way out');
  assert.ok(!/row\.unitCost = r2\(/.test(HTML), 'nor the unit cost');
  // Both fields exist beside the figures they belong to, and an unset cost says
  // so rather than showing a 0 the owner never typed.
  assert.match(HTML, /data-mboxcost="' \+ sk \+ '" inputmode="decimal" autocomplete="off" placeholder="not set"/);
  assert.match(HTML, /data-munitcost="' \+ esc\(s\.product\) \+ '" inputmode="decimal" autocomplete="off" placeholder="not set"/);
  // A negative cost is refused on the phone in the SERVER's own sentence, byte
  // for byte — asserted against what the live server actually returns.
  const app = syncedClient(F.boot);
  const serverBox = post(F.ctx, { token: F.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: 65, cheesePrice: 80, active: true, boxCost: -1 }] } });
  assert.strictEqual(serverBox.ok, false);
  assert.strictEqual(
    app.priceRowError({ sku: 'box6', label: 'Box 6', group: 'box', size: 6 },
      { price: 65, cheesePrice: 80, active: true, inCutoff: true, boxCost: '-1' }),
    serverBox.error, 'the phone and the server must refuse a negative box cost in the same words');
  const serverUnit = post(F.ctx, { token: F.token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Bonito', unit: 'pack', reorderAt: '', active: true, unitCost: -5 }] } });
  assert.strictEqual(serverUnit.ok, false);
  assert.strictEqual(serverUnit.error, 'Bonito: the unit cost cannot be negative.');
  assert.ok(HTML.indexOf("product + ': the unit cost cannot be negative.'") >= 0,
    'the stock card refuses it in that same sentence');
  // Every Maintenance save throws the costing answer away: it was computed from
  // the figures that just changed. Wired three times, and it really does throw
  // the answer away — an answer left sitting under a fresh label is a figure
  // that no longer describes anything on the sheet.
  assert.strictEqual((HTML.match(/costInvalidate\(\);/g) || []).length, 3,
    'all three Maintenance savers invalidate the costing');
  const inv = costingClient(F.boot, F.costing, '800');
  assert.ok(inv.costState().res, 'precondition: an answer is on screen');
  inv.costInvalidate();
  const after = inv.costState();
  assert.strictEqual(after.res, null, 'the answer is thrown away, not relabelled');
  assert.strictEqual(after.err, '');
  assert.strictEqual(after.stale, true, 'and the screen SAYS the figures were thrown away');
  assert.match(inv.costingHTML(), /A cost was changed, so the old figures were thrown away\./);
});

test('a cutoff still running offers the finished one, and a finished cutoff does not (v2.9.4)', () => {
  const app = costingClient(F.boot, F.costing, '');
  const live = Object.assign({}, F.costing, {
    fixed: Object.assign({}, F.costing.fixed, { period_finished: false }),
    caveats: ['This cutoff is not finished — 7 of its 16 nights have gone by.']
  });
  const h = app.costFiguresHTML({ key: 'k', target: '', data: live },
    { start: PERIOD.start, end: PERIOD.end });
  // The caveat ends by naming what to do; the doing is one tap, not two guesses
  // at the arrows.
  assert.match(h, /Show the last finished cutoff/);
  assert.match(h, /data-act="cost-last-done"/);

  // A finished cutoff has nothing to jump to, so the button stays away — an
  // offer that is always there is an offer that means nothing.
  const done = Object.assign({}, F.costing, {
    fixed: Object.assign({}, F.costing.fixed, { period_finished: true }),
    caveats: ['Something else entirely is wrong with this period.']
  });
  assert.ok(!/cost-last-done/.test(app.costFiguresHTML({ key: 'k', target: '', data: done },
    { start: PERIOD.start, end: PERIOD.end })),
    'a cutoff that has run out must not offer to show itself');

  // And an OLD phone, or a server that never sends the key, must not sprout a
  // button that does nothing: the offer is made only on an explicit false.
  const older = Object.assign({}, F.costing, {
    fixed: { salary: 200, shares: 1000, per_day: 1200 },
    caveats: ['A caveat from a server that predates this key.']
  });
  assert.ok(!/cost-last-done/.test(app.costFiguresHTML({ key: 'k', target: '', data: older },
    { start: PERIOD.start, end: PERIOD.end })),
    'a missing key is not a false one');
});

test('the walk back from ANY cutoff lands on one that has actually run out (v2.9.4)', () => {
  const app = loadClient();
  const today = app.currentPeriod('2026-08-23') && '2026-08-23';
  // The handler walks back while `end >= today`, from whatever is on screen —
  // not "the previous one", which is wrong whenever he has arrowed FORWARD
  // past today. Both directions are checked here.
  const walk = (from) => {
    let p = from, guard = 0;
    while (p.end >= today && guard++ < 40) p = app.shiftPeriod(p, -1);
    return p;
  };
  const live = app.currentPeriod(today);
  assert.strictEqual(live.start, '2026-08-16', 'precondition: Aug 23 sits in 16-31');
  assert.ok(walk(live).end < today, 'from the live cutoff, one step back is enough');
  assert.strictEqual(walk(live).end, '2026-08-15');

  // Three cutoffs into the future — the naive "previous one" would still be
  // unfinished, and would have shown him figures with the same warning again.
  let ahead = live;
  for (let i = 0; i < 3; i++) ahead = app.shiftPeriod(ahead, 1);
  assert.ok(ahead.end > today, 'precondition: that period has not happened');
  assert.ok(app.shiftPeriod(ahead, -1).end > today,
    'and one step back from it is STILL unfinished — which is why it is a walk');
  assert.strictEqual(walk(ahead).end, '2026-08-15', 'the walk gets there anyway');

  // Already looking at a finished cutoff: the walk must not move at all.
  const old = { start: '2026-07-01', end: '2026-07-15' };
  assert.deepStrictEqual(walk(old), old, 'a finished cutoff is already the answer');
});

test('an unsaved night does NOT keep the phone on old code forever (v2.9.7)', () => {
  // HIS REPORT, 2026-08-27: the app stayed on 2.9.5 after 2.9.6 was live.
  // Cause: applyUpdateIfSafe refused flatly while `benta.dirty`, and a RESTORED
  // DRAFT sets dirty on every single load (it genuinely is unsent work). So a
  // phone holding one unsaved night held its update back at every resume, for
  // as long as that night stayed unsaved — indefinitely, and silently.
  const dirty = () => ({ dirty: true, date: '2026-08-27' });

  // The stuck case: a restored draft, nothing focused. It must update, and it
  // must stash the night FIRST so the reload brings it back.
  const g = loadUpdateGate({ benta: dirty() });
  g.updateWaiting = true;
  g.applyUpdateIfSafe();
  assert.strictEqual(g.log.reloads, 1, 'a half-entered night must not block the update forever');
  assert.strictEqual(g.log.stashes, 1, 'and it must be stashed before the reload, not after');

  // The case the gate exists for: her finger is in a field. Waiting here is
  // right — the next resume or save catches it a moment later.
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const t = loadUpdateGate({ benta: dirty(), focusedTag: tag });
    t.updateWaiting = true;
    t.applyUpdateIfSafe();
    assert.strictEqual(t.log.reloads, 0, 'must not reload while a ' + tag + ' has focus');
    assert.strictEqual(t.log.stashes, 0, 'and must not stash behind her back either');
  }

  // In-flight work still blocks, both kinds.
  const mid = loadUpdateGate({ benta: dirty(), syncing: true });
  mid.updateWaiting = true; mid.applyUpdateIfSafe();
  assert.strictEqual(mid.log.reloads, 0, 'never reload with a request in flight');

  const photo = loadUpdateGate({ benta: dirty(), paperBusy: 'Reading the photo…' });
  photo.updateWaiting = true; photo.applyUpdateIfSafe();
  assert.strictEqual(photo.log.reloads, 0, 'never reload while a photograph is being read');

  // A clean form updates and has nothing to stash.
  const clean = loadUpdateGate({ benta: { dirty: false, date: '2026-08-27' } });
  clean.updateWaiting = true; clean.applyUpdateIfSafe();
  assert.strictEqual(clean.log.reloads, 1);
  assert.strictEqual(clean.log.stashes, 0, 'nothing typed, nothing to keep');

  // No pending update: nothing happens, however clean things are.
  const idle = loadUpdateGate({ benta: { dirty: false } });
  idle.applyUpdateIfSafe();
  assert.strictEqual(idle.log.reloads, 0, 'no update waiting, no reload');

  // ONE reload per page load, even if every trigger fires at once.
  const once = loadUpdateGate({ benta: dirty() });
  once.updateWaiting = true;
  once.applyUpdateIfSafe(); once.applyUpdateIfSafe(); once.applyUpdateIfSafe();
  assert.strictEqual(once.log.reloads, 1, 'never a reload loop');

  // And once a reload is UNDER WAY: location.reload() does not stop the world,
  // so a second worker claiming the page before it unloads sets updateWaiting
  // again. Clearing that flag alone would not hold here — `reloadingForUpdate`
  // is what does, and this is the race that makes it load-bearing.
  const race = loadUpdateGate({ benta: { dirty: false, date: '2026-08-27' } });
  race.updateWaiting = true;
  race.applyUpdateIfSafe();
  assert.strictEqual(race.log.reloads, 1, 'precondition: the first reload started');
  race.updateWaiting = true;            // another controllerchange, mid-unload
  race.applyUpdateIfSafe();
  assert.strictEqual(race.log.reloads, 1,
    'a reload already under way must not start a second one');
});

test('a TYPED delivery counts: "Stock came in" is not shadowed by the Sales steppers (v2.9.6)', () => {
  // HIS BUG, 2026-08-27: "when I input the number, it doesnt register, the plus
  // sign must be used in order to count." Reproduced in the browser first, then
  // pinned here. The cause is dispatch order, not arithmetic: the arrival boxes
  // are called "in-arr-0", the document-level input listener tests
  // `id.startsWith('in-')` for the Sales steppers FIRST, and that branch claimed
  // them and threw the keystroke away — leaving the dedicated `in-arr-` branch
  // below it unreachable from the day it was written. Worse than "ignored": with
  // state still 0, one tap of + after typing 10 read 1, so a ten-pack delivery
  // could be logged as one.
  const src = fs.readFileSync(INDEX_HTML, 'utf8');

  // The arrival input must carry its OWN row index, the way the Sales-screen
  // stock rows already do with data-stk — the pattern that never broke.
  const arrBox = src.slice(src.indexOf("id=\"in-arr-'"), src.indexOf("id=\"in-arr-'") + 260);
  assert.match(arrBox, /data-arr="' \+ i \+ '"/,
    'the arrival box must be addressable without parsing its id');

  // ...and be read by that attribute BEFORE any id is looked at.
  const listener = src.indexOf("document.addEventListener('input'");
  assert.ok(listener > 0);
  const byAttr = src.indexOf('ds.arr != null', listener);
  const byId = src.indexOf('const id = ev.target.id;', listener);
  assert.ok(byAttr > 0, 'the arrival rows must be handled by their data attribute');
  assert.ok(byAttr < byId,
    'and BEFORE the id branches — after them is exactly where the keystroke was lost');

  // The dead branch must be gone, not merely reordered around.
  assert.ok(!/id\.startsWith\('in-arr-'\)/.test(src),
    'the unreachable id-based branch must not linger to look like the handler');

  // And the Sales branch must claim ONLY Sales steppers, so the NEXT id
  // beginning with "in-" cannot be swallowed the same silent way.
  // Anchored to the BRANCH, not the first mention of that string — the comment
  // explaining this bug quotes it too.
  const at = src.indexOf("else if (id.startsWith('in-')){");
  assert.ok(at > 0, 'the Sales stepper branch must still exist');
  const salesBranch = src.slice(at, at + 1200);
  assert.match(salesBranch, /if \(st && st\.dataset\.sku\)/,
    'the Sales stepper branch must require a sku, or it swallows other boxes silently');

  // The three families of "in-…" box, each with its own way of being addressed:
  // one shared prefix is what made this collide in the first place.
  for (const [label, attr] of [['Sales counts', 'data-sku'], ['Sales stock', 'data-stk'],
                               ['arrivals', 'data-arr']]) {
    assert.ok(src.indexOf(attr + '="') > 0, label + ' must carry ' + attr);
  }
});

test('SOURCE PIN: the jump is a WALK, not an assumption about the previous cutoff (v2.9.4)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = src.indexOf("act === 'cost-last-done'");
  assert.ok(at > 0, 'the handler must exist');
  const body = src.slice(at, at + 600);
  assert.match(body, /while \(p\.end >= today/,
    'it must WALK back until the cutoff has run out — one step is wrong from a future period');
  assert.match(body, /guard\+\+ < 40/, 'and the walk must be bounded');
  assert.match(body, /costRes = null/, 'and it must throw away the answer that belonged to the old window');
});

test('the screen SHOWS the money it set aside, so the subtraction is not a mystery (v2.8.0)', () => {
  // The gate's MT-1/MT-2 fix subtracts what was paid for things priced per unit.
  // A cost figure that silently disagrees with the Expenses screen reads as a
  // bug, so the set-aside total is on screen with its reason.
  const app = costingClient(F.boot, F.costing, '');
  const withAside = Object.assign({}, F.costing, {
    variable: Object.assign({}, F.costing.variable, { counted_per_unit: 950 })
  });
  const h = app.costFiguresHTML({ key: 'k', target: '', data: withAside },
    { start: PERIOD.start, end: PERIOD.end });
  assert.match(h, /Also paid, counted above instead/);
  assert.match(h, /counting the money too would price every ball dearer than it is/);
  // Nothing paid twice, nothing to explain: the line stays away.
  const none = Object.assign({}, F.costing, {
    variable: Object.assign({}, F.costing.variable, { counted_per_unit: 0 })
  });
  assert.ok(!/Also paid, counted above instead/.test(
    app.costFiguresHTML({ key: 'k', target: '', data: none }, { start: PERIOD.start, end: PERIOD.end })));
});

test('the screen shows the caveats ABOVE the figures they qualify (v2.8.0)', () => {
  // The card exists because the owner's real Aug 16-31 read P1.57 a ball with
  // no purchases logged and advised cutting Box 10 to P83. The warning has to
  // sit above every number it qualifies, and it must say whether the advice is
  // switched off or merely cautious — those are different sentences.
  const app = costingClient(F.boot, F.costing, '800');
  const withFloor = Object.assign({}, F.costing, {
    caveats: ['No purchases are logged in this period, so the cost per ball counts only what came out of stock.'],
    targets: []
  });
  const hOff = app.costFiguresHTML({ key: 'k', target: '800', data: withFloor },
    { start: PERIOD.start, end: PERIOD.end });
  assert.match(hOff, /Read this first/);
  assert.match(hOff, /No purchases are logged in this period/);
  assert.match(hOff, /price advice stays switched off/);
  assert.ok(hOff.indexOf('Read this first') < hOff.indexOf('These nights'),
    'the warning sits ABOVE the figures it qualifies');

  const thin = Object.assign({}, F.costing, {
    caveats: ['9 days in this period have nothing entered, so the prices below are the cautious end.'],
    targets: [{ per_day: 800, prices: [{ sku: 'box10', price: 120 }] }]
  });
  const hOn = app.costFiguresHTML({ key: 'k', target: '800', data: thin },
    { start: PERIOD.start, end: PERIOD.end });
  assert.match(hOn, /9 days in this period have nothing entered/);
  assert.match(hOn, /leans to the cautious side/,
    'advice still on: the wording must not claim it was switched off');
  assert.ok(!/stays switched off/.test(hOn));

  // A caveat carries no sheet data today, but it is server text rendered into
  // markup — escaped exactly once, like every other sentence on this screen.
  const nasty = Object.assign({}, F.costing, { caveats: ['<img src=x onerror=1> & "flour"'], targets: [] });
  const hEsc = app.costFiguresHTML({ key: 'k', target: '', data: nasty },
    { start: PERIOD.start, end: PERIOD.end });
  assert.ok(hEsc.indexOf('<img src=x') === -1, 'never raw');
  assert.match(hEsc, /&lt;img src=x onerror=1&gt; &amp; &quot;flour&quot;|&lt;img src=x onerror=1&gt; &amp; "flour"/);

  // And no caveats means no card at all — a clean period says nothing.
  const clean = Object.assign({}, F.costing, { caveats: [] });
  const hClean = app.costFiguresHTML({ key: 'k', target: '800', data: clean },
    { start: PERIOD.start, end: PERIOD.end });
  assert.ok(!/Read this first/.test(hClean));
});

test('the REAL costing reply renders the REAL screen: every figure, escaped once', () => {
  const app = costingClient(F.boot, F.costing, '800');
  const h = app.costFiguresHTML({ key: PERIOD.start + '_' + PERIOD.end, target: '800', data: F.costing },
    { start: PERIOD.start, end: PERIOD.end });
  // The window is STATED, because the figures mean nothing without it.
  assert.ok(h.indexOf('These nights') >= 0);
  assert.ok(h.indexOf('Nights open') >= 0 && h.indexOf('Balls sold') >= 0);
  // The consumed-vs-paid sentence, which is the whole reason the two cost
  // sources are shown apart.
  assert.match(h, /Stock opened and boxes used are what was <b>used up<\/b>/);
  assert.match(h, /Supplies and octopus are what was <b>paid for<\/b>/);
  assert.match(h, /never added into one figure/);
  // ...and the fence, said on the screen itself.
  assert.match(h, /It changes no cutoff, no note and no price\./);
  // The per-ball stack, the fixed-cost card, the per-sku margins, break-even
  // and the night — all present, and every sku label escaped exactly once.
  assert.ok(h.indexOf('Every ball') >= 0 && h.indexOf('Every night') >= 0);
  assert.ok(h.indexOf('What each box leaves') >= 0);
  assert.ok(h.indexOf('Balls a night just to break even') >= 0);
  assert.ok(h.indexOf('A night takes') >= 0 && h.indexOf('A night costs') >= 0);
  F.costing.per_sku.forEach(r => assert.ok(h.indexOf('>' + r.label + '<') >= 0,
    r.sku + ': its label must be on the screen'));
  assert.ok(h.indexOf('&amp;amp;') < 0, 'nothing may be double-escaped');
  // The target table answers the figure that was ASKED for, and says it is advice.
  assert.match(h, /To leave more a night/);
  assert.match(h, /Advice only — nothing has been saved\./);
  F.costing.targets[0].prices.forEach(pr => assert.ok(
    h.indexOf('>' + app.skuLabel(pr.sku) + '<') >= 0, pr.sku + ': its target price must be listed'));
});

test('sheet data in the costing reply is escaped exactly once, label and name', () => {
  // A product and a sku whose names carry markup — the shape a hand-typed sheet
  // row really takes. Both reach the screen through `label`/`name`, so both are
  // the phone's to escape.
  const app = costingClient(F.boot, null);
  const nasty = {
    start: PERIOD.start, end: PERIOD.end, days_open: 1, balls: 40, revenue: 500,
    variable: { stock: 10, money: 20, boxes: 5, per_ball: 0.88 },
    fixed: { salary: 200, shares: 1000, per_day: 1200 },
    per_sku: [{ sku: 'box4', label: '<img src=x onerror=1>', sold: 10, price: 50,
      cost_per_box: 4, margin_per_box: 46, margin_per_ball: 11.5 }],
    break_even_balls: 100, per_day: { revenue: 500, cost: 1235, left: -735 },
    targets: [], unpriced: [{ kind: 'stock', name: 'Bad & "Worse"', label: 'Bad & "Worse"', qty: 3 }]
  };
  const h = app.costFiguresHTML({ key: PERIOD.start + '_' + PERIOD.end, target: '', data: nasty },
    { start: PERIOD.start, end: PERIOD.end });
  assert.ok(h.indexOf('<img src=x') < 0, 'a sku label may never reach the DOM as markup');
  assert.match(h, /&lt;img src=x onerror=1&gt;/);
  assert.match(h, /Bad &amp; &quot;Worse&quot;/);
  assert.ok(h.indexOf('&amp;amp;') < 0, 'escaped exactly ONCE, not twice');
  // And the label carries the sign: a night that loses money never prints -₱735.
  assert.match(h, /A night loses/);
  assert.ok(h.indexOf('-₱') < 0 && h.indexOf('₱-') < 0, 'the sign lives in the label, never in the figure');
});

test('a NULL from the server is a dash with a reason, never ₱0', () => {
  const app = costingClient(F.boot, null);
  assert.strictEqual(app.costPeso(null), '—');
  assert.strictEqual(app.costNum(null), '—');
  assert.strictEqual(app.costPeso(''), '—', 'and an absent key is the same answer');
  assert.ok(app.costPeso(0) !== '—' && app.costPeso(0).indexOf('0') >= 0,
    'a real 0 is a real figure and prints as one — the dash is reserved for "not known"');
  assert.ok(app.costNum(0) !== '—');
  // The two reasons, in the order the server checks them.
  assert.match(app.costWhyNone(0, 0), /No night in this cutoff is open yet/);
  assert.match(app.costWhyNone(2, 0), /No boxes were counted in this cutoff/);
  assert.strictEqual(app.costWhyNone(2, 40), '');
  // A whole reply of nulls — the empty fortnight the server really returns.
  const srv = loadServer();
  const empty = post(srv.ctx, { token: srv.token, action: 'costing',
    payload: { start: PERIOD.start, end: PERIOD.end } });
  assert.strictEqual(empty.ok, true, empty.error);
  assert.strictEqual(empty.data.variable.per_ball, null);
  assert.strictEqual(empty.data.fixed.per_day, null);
  assert.strictEqual(empty.data.break_even_balls, null);
  assertNoCamelKeys('empty costing', empty.data);
  const h = app.costFiguresHTML({ key: PERIOD.start + '_' + PERIOD.end, target: '', data: empty.data },
    { start: PERIOD.start, end: PERIOD.end });
  assert.ok(h.indexOf('—') >= 0, 'the unknowns render as dashes');
  assert.match(h, /No night in this cutoff is open yet, so there is nothing to divide by\./);
  assert.match(h, /so there is nothing to spread them over/);
  assert.match(h, /so there is no typical night/);
  assert.ok(h.indexOf('Nothing has been sold in this cutoff yet.') >= 0 ||
    h.indexOf('What each box leaves') >= 0, 'the per-sku card still says something');
});

test('unpriced things are NAMED on the screen, with what went uncosted', () => {
  // Built through the real server: a cost cleared, then a night that opens that
  // product and sells that box.
  const srv = loadServer();
  const D = ymdDaysAgo(2);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveStockItems',
    payload: { rows: [{ product: 'Bonito', unit: 'pack', reorderAt: '', active: true, unitCost: '' }] } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'savePrices',
    payload: { rows: [{ sku: 'box6', price: 65, cheesePrice: 80, active: true, boxCost: '' }] } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 0, customGcash: 0, notes: '',
    counts: [{ sku: 'box6', sod: 12, eod: 0, cheeseQty: 0, gcashQty: 0, gcashCheeseQty: 0 }],
    stock: [{ product: 'Bonito', qty: 2 }], entryId: 'unp-1' } }).ok, true);
  const cur = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const app = syncedClient(cur.data);
  // The window the fixture's night actually falls in. Taken from the DATE, not
  // from the client's clock: the stubbed server's today and this machine's today
  // are different days on purpose (see ymdDaysAgo).
  const window = { start: PERIOD.start, end: PERIOD.end };
  const cost = post(srv.ctx, { token: srv.token, action: 'costing',
    payload: { start: window.start, end: window.end } });
  assert.strictEqual(cost.ok, true, cost.error);
  assert.deepStrictEqual(cost.data.unpriced, [
    { kind: 'stock', name: 'Bonito', label: 'Bonito', qty: 2 },
    { kind: 'box', name: 'box6', label: 'Box 6', qty: 12 }
  ], 'the server names both, stock first');
  assertNoCamelKeys('unpriced costing', cost.data);
  app.costState({ open: true, per: window,
    res: { key: window.start + '_' + window.end, target: '', data: cost.data } });
  const h = app.costFiguresHTML({ key: window.start + '_' + window.end, target: '', data: cost.data }, window);
  assert.match(h, /2 things have no cost on file/);
  assert.match(h, /These are <b>not<\/b> in any figure above — not even at ₱0\./);
  assert.match(h, /opened with no unit cost/);
  assert.match(h, /boxes sold with no box cost/);
  assert.ok(h.indexOf('>Bonito<') >= 0 && h.indexOf('>Box 6<') >= 0);
  // And the figures they were left out of really do exclude them.
  assert.strictEqual(cost.data.variable.stock, 0);
  assert.strictEqual(cost.data.variable.boxes, 0);
  const b6 = cost.data.per_sku.find(s => s.sku === 'box6');
  assert.deepStrictEqual([b6.cost_per_box, b6.margin_per_box], [null, null]);
});

test('the target field never shows prices that answer a figure it no longer holds', () => {
  const app = costingClient(F.boot, F.costing, '800');
  // Answered for 800, field says 800: the prices show.
  let out = app.costTargetOutHTML({ key: PERIOD.start + '_' + PERIOD.end, target: '800', data: F.costing });
  assert.match(out, /To leave ₱800 a night/);
  assert.match(out, /Advice only — nothing has been saved\./);
  // Typed past it: the table is REPLACED by an instruction, never left standing
  // under a figure it does not answer — the same rule as the split field's
  // refusal on the Cutoff screen.
  app.costState({ target: '1200' });
  out = app.costTargetOutHTML({ key: PERIOD.start + '_' + PERIOD.end, target: '800', data: F.costing });
  assert.match(out, /Tap “Work out the prices” to answer for ₱1,200 a night\./);
  assert.ok(out.indexOf('Advice only') < 0, 'no price table may survive the figure changing');
  // Blank means no target at all — not ₱0.
  app.costState({ target: '' });
  out = app.costTargetOutHTML({ key: PERIOD.start + '_' + PERIOD.end, target: '', data: F.costing });
  assert.match(out, /Empty means no target, so there is nothing to show\./);
  assert.ok(out.indexOf('₱0') < 0, 'a blank field is never answered as zero');
});

test('the costing section is wired, closed by default, and asks the SERVER for everything', () => {
  // DOM-bound halves, pinned against the source the way every other renderer
  // guard in this suite is.
  assert.match(HTML, /try\{ h \+= costingHTML\(\); \}catch\(err\)\{ console\.error\(err\); \}/,
    'rendered from renderIbapa, and a bad reply cannot take the More tab down');
  // Every action is both OFFERED (a button) and HANDLED (a branch in the tap
  // router) — a button with no branch is a dead control, a branch with no button
  // is dead code.
  ['cost-open', 'cost-close', 'cost-refresh', 'cost-prev', 'cost-next', 'cost-target'].forEach(a => {
    assert.ok(HTML.indexOf('data-act="' + a + '"') >= 0, a + ': no button offers it');
    assert.ok(HTML.indexOf("act === '" + a + "'") >= 0, a + ': nothing handles the tap');
  });
  assert.match(HTML, /await api\('costing', payload\)/, 'the figures come from the server, always');
  assert.match(HTML, /if \(typed !== ''\) payload\.targetPerDay = num\(typed\);/,
    'a blank target sends NO key — the harmless default, and the shape an older phone sends');
  // No local fallback: a phone with no API says so in one sentence instead of
  // drawing a screen of zeros it invented.
  assert.match(HTML, /The costing is worked out by the server from the whole sheet, so it needs the API/);
  // It never queues anything and never touches the note.
  assert.ok(!/enqueue\('costing'/.test(HTML), 'costing is a pure read and must never be queued');
  const app = costingClient(F.boot, null);
  app.costState({ open: false });
  const closed = app.costingHTML();
  assert.match(closed, /data-act="cost-open"/, 'it starts closed, behind a button — Mama never needs it');
  assert.ok(closed.indexOf('Every ball') < 0, 'and shows no figures until he asks');
  // The period navigation is the Cutoff screen's, so "this cutoff" means the
  // same fortnight on both screens.
  app.costState({ open: true, per: app.currentPeriod(app.todayStr()) });
  assert.match(app.costingHTML(), /class="period-nav"/);
  assert.match(app.costingHTML(), /This cutoff/);
});

test('THE FENCE across the seam: the costing changes no figure the cutoff shows', () => {
  // One server, one period. Take the cutoff and the phone's own preview, ask
  // for the costing, then take both again: not a peso may differ, and not a
  // cell of the sheet.
  const srv = loadServer();
  const D = ymdDaysAgo(2);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveDay', payload: {
    date: D, closed: false, staff: 'Mama', customAmount: 200, customGcash: 100, notes: '',
    counts: [{ sku: 'box4', sod: 10, eod: 0, cheeseQty: 2, gcashQty: 1, gcashCheeseQty: 0 }],
    stock: [{ product: 'Takoyaki Flour', qty: 1 }], entryId: 'fence-1' } }).ok, true);
  assert.strictEqual(post(srv.ctx, { token: srv.token, action: 'saveExpense', payload: {
    date: D, category: 'Supplies', item: 'Veggies', amount: 400, backlogRef: '', notes: '',
    entryId: 'fence-x1' } }).ok, true);
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  const app = syncedClient(boot.data);
  const per = { start: PERIOD.start, end: PERIOD.end };   // the fortnight D falls in
  const cutBefore = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cutBefore.ok, true, cutBefore.error);
  const previewBefore = JSON.stringify(app.computeCutoff(per));

  const cost = post(srv.ctx, { token: srv.token, action: 'costing',
    payload: { start: per.start, end: per.end, targetPerDay: 900 } });
  assert.strictEqual(cost.ok, true, cost.error);
  assert.ok(cost.data.targets.length === 1, 'the advice was computed');

  const cutAfter = post(srv.ctx, { token: srv.token, action: 'cutoff',
    payload: { start: per.start, end: per.end, dryRun: true } });
  assert.strictEqual(cutAfter.data.note_text, cutBefore.data.note_text,
    'the note is byte-identical — costing is information, not money that has moved');
  assert.deepStrictEqual(cutAfter.data.figures, cutBefore.data.figures);
  // The phone's own preview, computed from the mirror, is untouched too: nothing
  // the costing returned may enter it.
  const app2 = syncedClient(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  assert.strictEqual(JSON.stringify(app2.computeCutoff(per)), previewBefore,
    'the phone\'s preview agrees with itself before and after');
  // And the revenue the costing reports IS the cutoff's own total, so the two
  // screens can never tell different stories about one fortnight.
  assert.strictEqual(cost.data.revenue, cutAfter.data.figures.total);
});

// ---------------------------------------------------------------------------
console.log('\n--- 21. v2.9.0 "Read it from the paper": the reading, the prefill, the cross-check ---');

/** A phone that has booted against the real server and has the photo reader
 *  set up, with the Sales form open on DAY. Every paper test starts here. */
function paperApp(date) {
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = F.token;
  app.cfg.visionUrl = 'https://vision.example/exec';
  app.cfg.visionToken = SEAM_TOK;
  app.applyBootstrap(F.boot);
  app.loadBentaForm(date || DAY);
  return app;
}

/** ONE photograph, all the way through BOTH projects: a canned model reply ->
 *  the real Vision.gs -> the phone's own normReading, with the form open on that
 *  night. Every cross-check and blank test below starts here, so what is under
 *  test is the real seam and not two hand-written objects that happen to agree. */
function readVia(said, date) {
  const d = date || DAY;
  const app = paperApp(d);
  const reading = visionRead(said, { date: d, skus: app.paperSkus(d) }).reading;
  return { app, data: reading, reading: app.normReading(reading, d) };
}
/** The reading on screen AND on the form — the state the cross-check reads. */
function showing(t) {
  t.app.paper = { date: t.reading.date, reading: t.reading };
  t.app.applyReadingToForm(t.reading);
  return t;
}
/** The owner's page with one thing changed. */
function paperWith(over) {
  return Object.assign(JSON.parse(JSON.stringify(PAPER_READ)), over || {});
}

test('the phone sends its OWN vocabulary, camelCase, and never the sheet', () => {
  // REQUESTS are camelCase — the standing rule, the other direction. The vision
  // app has no SpreadsheetApp call anywhere in it, so this list is the only way
  // it can know that "B4" is box4 at ₱50 with cheese at ₱60.
  const skus = paperApp(DAY).paperSkus(DAY);
  // The fixture every contract pin above was built from IS what the phone sends.
  assert.deepStrictEqual(skus, PAPER_SKUS,
    'the sku list must carry camelCase cheesePrice/inCutoff at this day\'s stored figures');
  const nori = skus.find(s => s.sku === 'nori');
  assert.strictEqual(nori.inCutoff, false, 'the excluded sku travels, and travels marked');
  for (const s of skus) {
    assert.ok(!has(s, 'cheese_price'), 'a REQUEST key must not be snake_case: cheese_price');
    assert.ok(!has(s, 'in_cutoff'), 'a REQUEST key must not be snake_case: in_cutoff');
  }
  // And this list is the ONLY vocabulary there is. The vision project cannot
  // read the sheet at all (pinned at the fence, in run-tests.js), so a photo
  // sent without it has nothing to match a row against and is refused rather
  // than guessed at.
  const bare = vpost(loadVisionSeam(), { token: SEAM_TOK, action: 'readSheet', payload: {
    date: DAY, mimeType: 'image/jpeg', imageBase64: SEAM_IMG } });
  assert.strictEqual(bare.ok, false);
  assert.match(bare.error, /no product list/);
  assert.match(bare.error, /typed in by hand/, 'and the way through is always still there');
});

test('the READING is snake_case throughout, and every figure is where the phone reads it', () => {
  const d = RD.reading;
  assertPairs('readSheet', d, CONTRACT['readSheet']);
  assertPairs('readSheet.counts[]', d.counts, CONTRACT['readSheet.counts[]']);
  assertNoCamelKeys('readSheet', d);
  // The DATE IS THE PHONE'S. It knows which night it photographed.
  assert.strictEqual(d.date, DAY);
  assert.strictEqual(d.total_on_paper, PAPER_TOTAL, 'the figure the whole cross-check rests on');
  assert.strictEqual(d.counts.length, 4);
  assert.deepStrictEqual(d.counts[0],
    { sku: 'box4', sod: 31, eod: 28, cheese: 1, gcash: 0, gcash_cheese: 0, confidence: 0.95 });
  // The photo was kept BEFORE the model was asked, so the reading can be taken
  // back to the paper it came from.
  assert.strictEqual(d.photo_saved, true);
  assert.ok(/^https?:\/\//.test(d.photo_url), 'a real link, or the phone drops it: ' + d.photo_url);
  assert.strictEqual(d.photo_error, '');
  assert.strictEqual(d.model, 'gemini-3.6-flash');
});

test('the reading survives the phone\'s own normalizer, and a camelCase reader would not', () => {
  const app = paperApp(DAY);
  const rd = app.normReading(RD.reading, DAY);
  assert.strictEqual(rd.total_on_paper, PAPER_TOTAL);
  assert.strictEqual(rd.counts.length, 4);
  assert.strictEqual(rd.counts[0].gcash_cheese, 0, 'gcash_cheese, not gcashCheese');
  assert.strictEqual(rd.counts.find(c => c.sku === 'box4').label, 'Box 4',
    'the LABEL comes from the phone, never from the reply');
  assert.strictEqual(rd.photo_url, RD.reading.photo_url);
  // A reply that is not a reading is refused, not massaged into an empty form
  // that looks like it worked.
  assert.throws(() => app.normReading({ notes: 'I see a piece of paper.' }, DAY),
    /not come back as a reading/);
  // A sku this phone does not sell is never guessed into one that it does.
  const bogus = app.normReading({ counts: [{ sku: 'box99', sod: 5, eod: 1 }] }, DAY);
  assert.strictEqual(bogus.counts.length, 0, 'an unknown sku is dropped, never renamed');
});

// --- photo_url: provenance, all the way round the loop ----------------------

test('photo_url round-trips the normalizers, both spellings', () => {
  const app = loadSyncClient();
  const LINK = 'https://drive.google.com/file/d/abc123/view';
  const modern = app.applyBootstrap({ days: [{ date: DAY, total: 1, cash: 1, gcash: 0, photo_url: LINK }] });
  assert.strictEqual(app.state.days[DAY].photo_url, LINK, 'snake_case is canonical');
  const legacy = loadSyncClient();
  legacy.applyBootstrap({ days: [{ date: DAY, total: 1, cash: 1, gcash: 0, photoUrl: LINK }] });
  assert.strictEqual(legacy.state.days[DAY].photo_url, LINK,
    'a legacy camelCase server must not silently drop the link');
  // And a link that is not a link never becomes an href or a sheet cell.
  assert.strictEqual(app.paperLink('javascript:alert(1)'), '');
  assert.strictEqual(app.paperLink('the photo is in the folder'), '');
  assert.strictEqual(app.paperLink(LINK), LINK);
});

atest('the photo link travels the whole loop: payload -> sheet -> bootstrap -> form -> payload', async () => {
  const srv = loadServer();
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  app.hooks.fetch = liveWire(srv);
  app.applyBootstrap(post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} }).data);
  const LINK = 'https://drive.google.com/file/d/paper-' + DAY + '/view';
  app.loadBentaForm(DAY);
  const p = app.bentaPayload();
  p.photoUrl = LINK;
  p.entryId = 'photo-loop-1';
  app.applyLocalDay(p);
  app.enqueue('saveDay', p);
  await app.drainQueue();
  assert.strictEqual(app.queue.length, 0, 'the save landed');
  assert.deepStrictEqual(app.attention, [], 'and was not refused: ' + JSON.stringify(app.attention));
  // The SHEET holds it, by header name.
  const log = srv.ss.getSheetByName('DailyLog').getDataRange().getValues();
  const row = log.slice(1).find(r => r[0] === DAY);
  assert.strictEqual(row[log[0].indexOf('photo_url')], LINK, 'the sheet stores the link');
  // A fresh phone booting against that sheet gets it back...
  const boot = post(srv.ctx, { token: srv.token, action: 'bootstrap', payload: {} });
  assertPairs('bootstrap.days[]', boot.data.days, CONTRACT['bootstrap.days[]']);
  const fresh = loadSyncClient();
  fresh.applyBootstrap(boot.data);
  fresh.loadBentaForm(DAY);
  // ...and an ORDINARY re-save keeps it, because the server rebuilds the row
  // from the payload: a save that omitted it would clear the cell and a
  // corrected night would quietly stop pointing at its paper.
  assert.strictEqual(fresh.bentaPayload().photoUrl, LINK,
    'a re-save must carry the link the sheet already holds');
});

// --- THE PREFILL -----------------------------------------------------------

test('THE PREFILL: the reading fills the form and the money is the money the sheet stores', () => {
  const app = paperApp(DAY);
  const rd = app.normReading(RD.reading, DAY);
  app.applyReadingToForm(rd);
  const b = app.benta;
  const box4 = b.rows.find(r => r.sku === 'box4');
  assert.strictEqual(box4.sod, 31, 'the saved day\'s own 10 must be REPLACED by what the paper says');
  assert.strictEqual(box4.eod, 28);
  assert.strictEqual(box4.cheese, 1);
  assert.strictEqual(b.fromPaper, true, 'the form says out loud where these came from');
  assert.strictEqual(b.dirty, true, 'and it is unsaved work, so a date change asks before losing it');
  assert.strictEqual(b.photoUrl, rd.photo_url, 'the night can point at its paper once it is saved');
  // The wage, the staff, the note and the stock the page never carried are LEFT
  // ALONE — a reading fills the page, it does not blank the rest of the night.
  assert.strictEqual(b.salary, 200);
  assert.strictEqual(b.staff, 'Mama');
  assert.strictEqual(b.notes, 'party tray', 'the day\'s own note is Mama\'s sentence, not the model\'s');

  // The figures, through the REAL payload and the REAL computeDay.
  const p = app.bentaPayload();
  assert.deepStrictEqual(
    p.counts.find(c => c.sku === 'box4'),
    { sku: 'box4', sod: 31, eod: 28, cheeseQty: 1, gcashQty: 0, gcashCheeseQty: 0,
      freeQty: 0, price: 50, cheesePrice: 60, inCutoff: true },
    'a reading never invents a give-away: freeQty rides along as 0');
  const c = app.computeDay(p);
  assert.strictEqual(c.total, PAPER_TOTAL);
  assert.strictEqual(c.gcash, PAPER_GCASH);
  assert.strictEqual(c.cash, PAPER_CASH);
  assert.strictEqual(c.excluded, PAPER_EXCL, 'nori\'s money sits BESIDE the day, in the tin');

  // ...and the SERVER, recomputing from the same payload, agrees to the peso.
  const srv = loadServer();
  p.entryId = 'paper-prefill-1';
  const saved = post(srv.ctx, { token: srv.token, action: 'saveDay', payload: p });
  assert.strictEqual(saved.ok, true, saved.error);
  assert.strictEqual(saved.data.total, PAPER_TOTAL, 'the phone and the sheet read one night');
  assert.strictEqual(saved.data.gcash, PAPER_GCASH);
  assert.strictEqual(saved.data.excluded_total, PAPER_EXCL);
  assert.strictEqual(saved.data.photo_url, rd.photo_url, 'and the paper is on the row');
});

test('THE MAPPING: a cheese box paid by GCash counts in cheese AND in GCash cheese', () => {
  // The prompt tells the model exactly that, so `cheese` is ALL the cheese on
  // the row however it was paid. The sheet's four buckets are exclusive, so the
  // phone has to subtract — and the review card then reads the form's own two
  // questions back out.
  const t = readVia({ counts: [
    { sku: 'box4', sod: 20, eod: 10, cheese: 4, gcash: 3, gcash_cheese: 1, confidence: 0.9 }
  ], custom_amount: 0, custom_gcash: 0, total_on_paper: 0, notes: '', unread: [] });
  const app = t.app, rd = t.reading;
  app.applyReadingToForm(rd);
  const row = app.benta.rows.find(r => r.sku === 'box4');
  assert.strictEqual(row.gcashCheese, 1, 'gcashCheese = gcash_cheese');
  assert.strictEqual(row.cheese, 3, 'cheese = cheese - gcash_cheese (the cheese paid in CASH)');
  assert.strictEqual(row.gcash, 3, 'gcash = gcash (plain boxes paid by GCash)');
  // The form's own two questions come straight back out of those buckets.
  const f = app.paperFormFigures(rd.counts[0]);
  assert.strictEqual(f.cheeseAll, 4, '"How many were cheese?" — all of them, however paid');
  assert.strictEqual(f.gcashAll, 4, '"Sold with GCash" — 3 plain + 1 cheese');
  assert.strictEqual(f.gcashOfCheese, 1);
  assert.strictEqual(f.sold, 10);
  assert.strictEqual(app.uiVal(row, 'C'), 4, 'and the screen shows the same four');
  assert.strictEqual(app.uiVal(row, 'G'), 4);

  // What this mapping CANNOT get wrong is the figure the cross-check tests: a
  // misread of WHICH cheese box was paid how moves money between Cash and
  // GCash and never changes the Total. That is why an agreeing total is still
  // evidence, and why the split is printed for the eye instead.
  const before = app.computeDay(app.bentaPayload());
  const shifted = readVia({ counts: [
    { sku: 'box4', sod: 20, eod: 10, cheese: 4, gcash: 2, gcash_cheese: 2, confidence: 0.9 }
  ], custom_amount: 0, custom_gcash: 0, total_on_paper: 0, notes: '', unread: [] }).reading;
  app.applyReadingToForm(shifted);
  const after = app.computeDay(app.bentaPayload());
  assert.strictEqual(after.total, before.total, 'the TOTAL cannot move on the payment split');
  assert.notStrictEqual(after.cash, before.cash, 'but the Cash/GCash split does — so it is shown');
});

// --- THE CROSS-CHECK -------------------------------------------------------

test('THE CROSS-CHECK agrees: the paper\'s own total and the form\'s, in one sentence', () => {
  const app = showing(readVia(PAPER_READ)).app;
  const cx = app.paperCross();
  assert.strictEqual(cx.state, 'agree');
  assert.strictEqual(cx.said, 'The paper says ₱2,365 and so does this — good.');
  // The card carries it, escaped, and says nothing about a gap.
  const h = app.paperCrossHTML({});
  assert.ok(h.indexOf('₱2,365 and so does this') > -1, h);
  assert.ok(h.indexOf('short') < 0 && h.indexOf('too much') < 0, h);
});

test('THE CROSS-CHECK names the gap IN PESOS and points at the rows it was least sure of', () => {
  // The owner's own crossed-out figure: the page's standing total is 2,605.
  const raw = paperWith({ total_on_paper: 2605 });
  raw.counts.find(c => c.sku === 'box10').confidence = 0.6;
  const app = showing(readVia(raw)).app;
  const cx = app.paperCross();
  assert.strictEqual(cx.state, 'differ');
  assert.ok(cx.said.indexOf('The paper says ₱2,605 but these figures add up to ₱2,365') === 0, cx.said);
  assert.ok(cx.said.indexOf('₱240 short') > -1, 'the gap is named IN PESOS: ' + cx.said);
  assert.ok(cx.said.indexOf('Look at Box 10 first') > -1,
    'and points at the row it was least sure of: ' + cx.said);
  assert.ok(cx.said.indexOf('Nothing is saved yet') > -1,
    'a mismatch INFORMS, it never blocks: ' + cx.said);
  // The other direction reads the other way round, in the same shape.
  const app2 = showing(readVia(paperWith({ total_on_paper: 2000 }))).app;
  assert.ok(app2.paperCross().said.indexOf('₱365 too much') > -1, app2.paperCross().said);
});

test('money kept OUT of the cutoff is not a mismatch — the paper counts the tin', () => {
  // Nori's ₱50 sits in the same tin and is very likely inside the page's own
  // total, while it is deliberately outside the day's Total here. When THAT is
  // the whole difference, the two DO agree, and crying mismatch would be a
  // false alarm on an ordinary night.
  // PIN MOVED (v2.9.0, deliberate): the gate was right that this branch cannot
  // claim proof. A reading that fell short by EXACTLY the excluded amount lands
  // here too, so the wording now states the assumption and hands the judgement
  // to the one person who knows whether the page's total counted the nori in.
  const app = showing(readVia(paperWith({ total_on_paper: PAPER_TOTAL + PAPER_EXCL }))).app;
  const cx = app.paperCross();
  assert.strictEqual(cx.state, 'agree', cx.said);
  assert.ok(cx.said.indexOf('₱50 kept out of the cutoff') > -1, cx.said);
  assert.match(cx.said, /agree IF the paper’s total counts the nori in/,
    'the assumption is STATED, not hidden behind "Good."');
  assert.match(cx.said, /If it does not, then something is ₱50 out/,
    'and the other reading of the same arithmetic is named too');
});

function asArrLike(v){ return Array.isArray(v) ? v.slice() : []; }

test('a page dated another night is CALLED OUT, not quietly believed (v2.9.1)', () => {
  // The trap the owner was one tap away from: his sample page is dated 5/18. An
  // old page photographed while the form is on today fills TODAY with May's
  // figures — and the cross-check AGREES, because those figures match that
  // page's own total perfectly. Nothing on screen would have objected.
  const t = showing(readVia(paperWith({ date_on_paper: '5/18' })));
  const app = t.app;
  assert.strictEqual(t.reading.date_on_paper, '5/18', 'kept exactly as the pen wrote it');
  const pd = app.paperPageDate();
  assert.ok(pd, 'a page dated 5/18 is not the night this form is on');
  assert.strictEqual(pd.raw, '5/18');
  assert.match(pd.date, /^\d{4}-05-18$/, 'and it resolves to the night it IS: May 18');
  assert.ok(pd.date <= app.todayStr(), 'never resolved into the future');

  // The page's own date matching the form is SILENCE — either way round, since
  // the pen writes no year and no agreed order.
  const on = app.benta.date, parts = app.d2parts(on);
  for (const written of [parts.m + '/' + parts.d, parts.d + '/' + parts.m,
                         parts.m + '-' + parts.d, 'DATE ' + parts.m + '/' + parts.d]){
    const q = showing(readVia(paperWith({ date_on_paper: written })));
    assert.strictEqual(q.app.paperPageDate(), null, 'no complaint about ' + written);
  }
  // An unreadable or absent date says NOTHING — a smudged corner is not evidence.
  for (const written of ['', 'DATE', 'aug']){
    const q = showing(readVia(paperWith({ date_on_paper: written })));
    assert.strictEqual(q.app.paperPageDate(), null, 'silence on ' + JSON.stringify(written));
  }
  // RENDERED, not merely present in the source: the mutation round proved a
  // source pin passes happily while the check itself is dead.
  const shown = app.paperCardHTML();
  assert.match(shown, /This page is dated 5\/18/, 'the warning is on the screen');
  assert.match(shown, /data-act="paper-goto"/, 'with the offer to go to that night');
  assert.ok(shown.indexOf('This page is dated') < shown.indexOf('Box 10'),
    'and it sits ABOVE the figures it qualifies');
  // A page dated tonight renders no warning at all.
  const same = showing(readVia(paperWith({ date_on_paper: parts.m + '/' + parts.d })));
  assert.ok(!/This page is dated/.test(same.app.paperCardHTML()),
    'no false alarm when the page IS this night');
});

test('an empty end count is REFUSED at Save day — the guard that outlives the card (v2.9.0)', () => {
  // The gate's RI-2, and the worst outcome this release could cause. An unread
  // end count leaves the box empty; every sum reads empty as 0, so a start
  // count of 55 prices all 55 as sold. The paper card said so loudly — but the
  // card is dismissible and is NOT persisted, so after "Hide this" or a reload
  // the inflated night saved silently. The refusal therefore lives in
  // validateBenta, where Save day cannot get past it.
  const app = loadClient();
  app.applyBootstrap(F.boot);
  const D = ymdDaysAgo(1);
  app.loadBentaForm(D);
  const row = app.benta.rows.find(r => r.sku === 'box10');
  row.sod = 55; row.eod = '';                 // exactly what an unread figure leaves
  const errs = app.validateBenta();
  assert.ok(errs['sku:box10'], 'it must refuse — nothing else stops this night');
  assert.match(errs['sku:box10'],
    /Box 10: the end count is empty, so all 55 would count as sold\. Type what was left — 0 if the tray emptied\./);
  // And the inflation it prevents is real: with the blank read as 0, that line
  // prices the whole shelf.
  const line = () => app.computeDay(app.bentaPayload()).lines.find(l => l.sku === 'box10');
  assert.strictEqual(line().sold, 55, 'the blank is summed as 0, so all 55 read as sold');
  assert.strictEqual(line().amount, 55 * 105, 'the figure the refusal exists to stop');
  // ZERO is a real answer and always accepted — that is the whole distinction.
  row.eod = 0;
  assert.ok(!app.validateBenta()['sku:box10'], 'a typed 0 is an answer, not a gap');
  assert.strictEqual(line().amount, 55 * 105, 'and it books the same money, now on purpose');
  // A blank on a row nobody touched stays silent: an untouched row is not a gap.
  const other = app.benta.rows.find(r => r.sku === 'box4');
  other.sod = ''; other.eod = '';
  assert.ok(!app.validateBenta()['sku:box4'], 'an empty row is just an empty row');
});

test('a gap in the reading is NAMED, never blamed on Mama\'s arithmetic (v2.9.0)', () => {
  // The gate's RI-3 and XC-1: when the totals disagreed, the cross-check could
  // say "every figure was read clearly, so the difference is more likely in the
  // adding-up on the paper itself" — while the SAME reading listed unread
  // figures, or was missing a whole product row. It blamed her arithmetic for
  // the app's own blind spot. Three shapes of gap, all of them named now.
  const FALSE_CLAIM = /Every figure on the page came back read/;

  // 1. the model itself said it could not read the special order
  const raw1 = paperWith({ total_on_paper: PAPER_TOTAL + 500 });
  delete raw1.custom_amount;
  const cx1 = showing(readVia(raw1)).app.paperCross();
  assert.strictEqual(cx1.state, 'differ');
  assert.match(cx1.said, /did not get/, cx1.said);
  assert.match(cx1.said, /special-order amount/, cx1.said);
  assert.ok(!FALSE_CLAIM.test(cx1.said), 'and it does not claim everything was read');

  // 2. a whole product ROW never came back — which can appear in no list, since
  //    an omitted row cannot name itself.
  const raw2 = paperWith({ total_on_paper: PAPER_TOTAL + 900 });
  raw2.counts = asArrLike(raw2.counts).filter(c => c.sku !== 'box10');
  const t2 = showing(readVia(raw2));
  const cx2 = t2.app.paperCross();
  assert.strictEqual(cx2.state, 'differ');
  assert.match(cx2.said, /no line for it came back at all/, cx2.said);
  assert.ok(!FALSE_CLAIM.test(cx2.said));

  // 3. nothing missing and nothing unsure: only THEN may it point at the paper,
  //    and even then it says to check the adding-up before changing figures.
  const clean = paperWith({ total_on_paper: PAPER_TOTAL + 40 });
  const cx3 = showing(readVia(clean)).app.paperCross();
  assert.strictEqual(cx3.state, 'differ');
  assert.ok(FALSE_CLAIM.test(cx3.said) || /Look at /.test(cx3.said),
    'a clean reading may point at the paper, or at its least-sure line: ' + cx3.said);
  // Whatever it says, it never blocks the night.
  assert.match(cx3.said, /Nothing is saved yet/);
});

test('no total on the paper claims nothing — it says there is nothing to check against', () => {
  const raw = paperWith({});
  delete raw.total_on_paper;
  const t = showing(readVia(raw));
  const app = t.app, rd = t.reading;
  assert.strictEqual(rd.total_on_paper, '', 'unread, so BLANK');
  assert.ok(rd.unread.some(u => /total/i.test(u)), 'and named: ' + JSON.stringify(rd.unread));
  const cx = app.paperCross();
  assert.strictEqual(cx.state, 'unknown');
  assert.ok(cx.said.indexOf('nothing to check these figures against') > -1, cx.said);
  // A reading belongs to ONE night. Moving the form elsewhere puts it away
  // rather than letting it describe figures it never read.
  app.loadBentaForm(ymdDaysAgo(1));
  assert.strictEqual(app.paperCross(), null, 'no cross-check for a night it never saw');
});

// --- BLANK IS NOT ZERO -----------------------------------------------------

test('a row the paper left WHOLLY unread is questioned, not passed over (v2.10.0)', () => {
  // The one way a count row genuinely goes blank on both sides: the photo reader
  // returns the sku with neither figure read (the schema requires only `sku`, so
  // an omitted field IS how the model says "could not read this"). Both blank is
  // a legitimate "we did not sell it tonight", so this asks rather than refuses —
  // but it must not pass over a product that normally sells.
  const t = readVia({ counts: [
    { sku: 'box4', sod: 40, eod: 10 },
    { sku: 'nori' }                        // named, and nothing read for it
  ], custom_amount: 0, custom_gcash: 0, total_on_paper: 0, notes: '', unread: [] });
  const app = t.app;
  app.applyReadingToForm(t.reading);
  const nori = app.benta.rows.find(r => r.sku === 'nori');
  assert.strictEqual(nori.sod, '', 'precondition: the start really is blank');
  assert.strictEqual(nori.eod, '', 'precondition: and so is the close');

  // Give nori a history in which it is counted and sells.
  const c = (sku, sod, eod) => ({ sku, sod, eod, cheese_qty:0, gcash_qty:0,
                                  gcash_cheese_qty:0, custom_qty:0 });
  // Dated relative to the FORM's own night, not to today — these paper tests
  // run on a fixed DAY, and history has to sit before it to count.
  const before = (n) => {
    const [y, m, d] = String(app.benta.date).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d - n));
    return dt.toISOString().slice(0, 10);
  };
  for (const k in app.state.counts) delete app.state.counts[k];
  for (let i = 1; i <= 10; i++) app.state.counts[before(i)] = [c('nori', 20, 14)];

  const said = app.nightChecks().join('\n');
  assert.match(said, /has no counts tonight/, 'a normally-counted product must not slip through blank');
  assert.match(said, /sold on 10 of them/, 'with the auditable claim attached');
  assert.match(said, /If it really was not out tonight, leave it/,
    'and permission to leave it, because blank is a real answer');
});

test('BLANK STAYS BLANK: a figure the paper did not give is EMPTY on the form, never 0', () => {
  // "one cheese, could not tell how it was paid", and no end count at all. The
  // OMITTED field is how the schema lets the model say "I could not read this".
  const t = readVia({ counts: [
    { sku: 'box4', sod: 31, cheese: 1, gcash: 0, confidence: 0.5 }
  ], custom_amount: 0, custom_gcash: 0, total_on_paper: 60, notes: '', unread: [] });
  const app = t.app, rd = t.reading;
  assert.strictEqual(rd.counts[0].eod, '', 'an unread end count is BLANK');
  assert.strictEqual(rd.counts[0].gcash_cheese, '', 'and so is an unread overlap');
  assert.ok(rd.unread.some(u => u.indexOf('Box 4') === 0),
    'every blank is NAMED, in the owner\'s words: ' + JSON.stringify(rd.unread));
  app.applyReadingToForm(rd);
  const row = app.benta.rows.find(r => r.sku === 'box4');
  assert.strictEqual(row.eod, '', 'the form holds the blank, not a 0');
  assert.strictEqual(row.gcashCheese, '');
  assert.strictEqual(row.cheese, 1,
    'the one cheese it DID read stands; the subtraction treats the unread overlap as none');
  // What the SCREEN shows: empty boxes, and no invented "Sold".
  assert.strictEqual(app.stepVal(row.eod), '', 'a blank box shows blank');
  assert.strictEqual(app.stepVal(row.sod), 31, 'a read figure shows itself');
  assert.strictEqual(app.soldVal(row), '', '"31 in, end of day unread" is NOT 31 sold');
  assert.strictEqual(app.uiVal(row, 'GC'), '', 'and neither is the unread overlap a 0');
  assert.strictEqual(app.uiVal(row, 'C'), 1,
    'a SUM may only read blank when every bucket behind it does');
  // A ZERO it really read is a zero, and is not reported as unread.
  assert.strictEqual(rd.counts[0].gcash, 0);
  assert.ok(rd.unread.indexOf('Box 4 paid by GCash') < 0,
    'a real 0 must never be listed as unread: ' + JSON.stringify(rd.unread));
  assert.ok(rd.unread.indexOf('Box 4 with cheese and paid by GCash') > -1,
    'while the one it truly could not see IS listed: ' + JSON.stringify(rd.unread));
  // The review card says so out loud, and prints "not read" rather than a 0.
  const card = app.paperReviewHTML(rd);
  assert.ok(card.indexOf('not read') > -1, card.slice(0, 400));
  assert.ok(card.indexOf('Every one of these is EMPTY on the form, not 0') > -1);
});

test('a start count with no end count is called out — the total prices the whole shelf as sold', () => {
  // The one blank that INVENTS money: every figure the app sums reads a blank
  // as 0, so a row with 31 in and nothing at the end reads as 31 sold while the
  // total above it looks perfectly ordinary.
  const app = showing(readVia({ counts: [
    { sku: 'box4', sod: 31, cheese: 0, gcash: 0, gcash_cheese: 0, confidence: 0.5 }
  ], custom_amount: 0, custom_gcash: 0, total_on_paper: 150, notes: '', unread: [] })).app;
  const h = app.paperCrossHTML({});
  assert.ok(h.indexOf('The end count is still empty on <b>Box 4</b>') > -1, h);
  assert.ok(h.indexOf('count every one of those boxes as sold') > -1, h);
  // Filled in, it settles — the sentence is read off the FORM, not the reading.
  app.benta.rows.find(r => r.sku === 'box4').eod = 28;
  assert.ok(app.paperCrossHTML({}).indexOf('The end count is still empty') < 0,
    'a gap he has just closed must stop saying it is open');
});

// --- NOTHING AUTO-SAVES ----------------------------------------------------

atest('NOTHING AUTO-SAVES: a whole reading queues nothing and writes no day', async () => {
  const srv = loadServer();
  const app = paperApp(DAY);
  app.cfg.token = srv.token;
  const logBefore = JSON.stringify(srv.ss.getSheetByName('DailyLog').getDataRange().getValues());
  const daysBefore = JSON.stringify(app.state.days);
  // Both doors are watched: the tracker's api() and the reader's own.
  const seen = [];
  app.hooks.fetch = (url, opts) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body) });
    if (String(url).indexOf('vision') > -1) {
      const ctx = loadVisionSeam();
      ctx.UrlFetchApp._reply(200, geminiSaid(PAPER_READ));
      return Promise.resolve({ ok: true, text: async () =>
        ctx.doPost({ postData: { contents: opts.body } }).getContent() });
    }
    return Promise.resolve({ ok: true, text: async () =>
      srv.ctx.doPost({ postData: { contents: opts.body } }).getContent() });
  };
  await app.paperTake({ size: 900000, name: 'paper.jpg' });

  assert.strictEqual(app.paperErr, '', 'the reading worked: ' + app.paperErr);
  assert.strictEqual(app.paperShowingFor(DAY), true, 'and it is on screen');
  assert.strictEqual(app.benta.rows.find(r => r.sku === 'box4').sod, 31, 'the form was filled');
  // ONE request left this phone, and it was the reader's.
  assert.strictEqual(seen.length, 1, 'the reading path made ' + seen.length + ' requests');
  assert.strictEqual(seen[0].url, 'https://vision.example/exec');
  assert.strictEqual(seen[0].body.action, 'readSheet');
  assert.strictEqual(seen[0].body.token, SEAM_TOK, 'its OWN token, never the sheet\'s');
  assert.notStrictEqual(seen[0].body.token, srv.token, 'two doors, two keys');
  // Nothing queued, nothing stored, not a cell of the sheet moved.
  assert.strictEqual(app.queue.length, 0, 'a reading must never queue a saveDay');
  assert.strictEqual(JSON.stringify(app.state.days), daysBefore,
    'the reading wrote a day into local state — it must only touch the FORM');
  assert.strictEqual(JSON.stringify(srv.ss.getSheetByName('DailyLog').getDataRange().getValues()),
    logBefore, 'the sheet must be byte-identical after a reading');
  // The night is committed by the ORDINARY Save day, and only then.
  const p = app.bentaPayload();
  p.entryId = 'paper-then-save';
  app.applyLocalDay(p);
  app.enqueue('saveDay', p);
  await app.drainQueue();
  assert.strictEqual(app.state.days[DAY].total, PAPER_TOTAL, 'and then it lands, as it always did');
});

test('SOURCE PIN: the photo-reader module cannot save, queue or persist anything', () => {
  // The whole feature is one slab of the shipped file, so this is checkable at
  // the source: if a later edit ever reaches for the queue from inside the
  // reading path, this goes red before it can auto-save a night.
  const paperSrc = S_PAPER;
  for (const forbidden of ['enqueue(', 'saveBenta(', 'persistState(', 'persistQueue(',
    'drainQueue(', 'doBootstrap(', 'applyLocalDay(', 'applyServerDay(']) {
    assert.ok(paperSrc.indexOf(forbidden) < 0,
      'the reading path must never call ' + forbidden + ' — nothing about this feature may save a day');
  }
  // bentaPayload IS called — once, by the cross-check, to price the form the way
  // the receipt prices it. Reading the payload is not sending it, and this is
  // the only place the module touches it.
  assert.strictEqual((paperSrc.match(/bentaPayload\(\)/g) || []).length, 1,
    'the cross-check reads the payload to compare; nothing here may send one');
  assert.ok(/const c = computeDay\(bentaPayload\(\)\);/.test(paperSrc),
    'and that one place is the comparison itself');
  // It reaches the wire through its OWN door, with its own URL and its own
  // token, and never through api() (which carries the sheet's).
  assert.ok(/config\.visionUrl/.test(paperSrc) && /config\.visionToken/.test(paperSrc));
  assert.ok(!/config\.apiUrl/.test(paperSrc) && !/config\.token\b/.test(paperSrc),
    'the photo reader must never read the sheet\'s URL or the sheet\'s token');
  // ONE call to the wire in the whole module, and it goes to the reader's own
  // URL. Pinned as the CALL rather than the word, because the module's comments
  // name api() deliberately (to explain that it shares its transport and
  // nothing else).
  // Pinned as ANY fetch-shaped call, so reintroducing a bare unbounded fetch()
  // here goes red too: a photograph that hangs forever spends her data and her
  // patience with nothing on screen to cancel (v2.9.3).
  const wire = paperSrc.match(/[A-Za-z]*fetch[A-Za-z]*\([^,)]*/g) || [];
  assert.deepStrictEqual(wire, ['fetchWithTimeout(config.visionUrl'],
    'the photo reader must reach the wire exactly once, through its own URL, and through the BOUNDED call');
  assert.ok(/VISION_TIMEOUT_MS/.test(paperSrc), 'and that call must carry a deadline');
  // The reading writes `benta` and the paper card, and nothing else.
  assert.ok(/benta\.fromPaper = true;/.test(paperSrc), 'the form must SAY where the figures came from');
  // The ordinary save is what clears the marker — pinned at the save itself,
  // which is outside this slab.
  const save = slab('function saveBenta(){', 'function prefersReduced(){');
  assert.ok(/paperClear\(p\.date\);/.test(save) && /benta\.fromPaper = false;/.test(save),
    'Save day is what stops the form saying "nothing has been saved"');
});

// --- UNTRUSTED TEXT --------------------------------------------------------

test('everything the model says is escaped exactly once on its way to the screen', () => {
  const t = readVia({
    counts: [{ sku: 'box4', sod: 3, eod: 1, cheese: 0, gcash: 0, gcash_cheese: 0, confidence: 0.9 }],
    custom_amount: 0, custom_gcash: 0, total_on_paper: 100,
    notes: 'a smudge <script>alert("x")</script> & a blot',
    unread: ['<img src=x onerror="alert(1)"> the corner']
  });
  const app = t.app, rd = t.reading;
  const h = app.paperReviewHTML(rd);
  assert.ok(h.indexOf('<script>') < 0, 'model prose must never reach the DOM as markup');
  assert.ok(h.indexOf('<img') < 0, 'nor an unread line');
  assert.ok(h.indexOf('&lt;script&gt;') > -1, 'escaped exactly once (not &amp;lt;)');
  assert.ok(h.indexOf('&amp;lt;') < 0, 'and not twice');
  assert.ok(h.indexOf('&amp; a blot') > -1, 'the ampersand too');
  // A "link" that is not an http(s) address never becomes an href.
  const bad = app.normReading({ counts: [], total_on_paper: 0,
    photo_url: 'javascript:alert(1)' }, DAY);
  assert.strictEqual(bad.photo_url, '');
  assert.ok(app.paperReviewHTML(bad).indexOf('javascript:') < 0,
    'a non-link must never be offered as one');
  // Sheet data lands in the same markup (the product labels), escaped too.
  const t2 = readVia({ counts: [{ sku: 'box4', sod: 3 }], custom_amount: 0,
    custom_gcash: 0, total_on_paper: 0, notes: '', unread: [] });
  t2.app.state.prices.find(p => p.sku === 'box4').label = 'Box <4> & "cheese"';
  const h2 = t2.app.paperReviewHTML(t2.app.normReading(t2.data, DAY));
  assert.ok(h2.indexOf('Box &lt;4&gt; &amp; &quot;cheese&quot;') > -1, h2.slice(0, 600));
  assert.ok(h2.indexOf('<4>') < 0);
});

// --- ABSENT, RATHER THAN PRESENT AND BROKEN --------------------------------

test('no photo reader configured = no button anywhere, and no request possible', () => {
  const app = paperApp(DAY);
  app.cfg.visionUrl = '';
  app.cfg.visionToken = '';
  assert.strictEqual(app.visionReady(), false);
  assert.strictEqual(app.paperCardHTML(), '',
    'the feature is ABSENT on a phone that has not been given it, not present and broken');
  // Half of it is still nothing: a URL with no token is a button that can only
  // ever be refused, and a dead button is worse than an absent one.
  app.cfg.visionUrl = 'https://vision.example/exec';
  assert.strictEqual(app.visionReady(), false);
  assert.strictEqual(app.paperCardHTML(), '');
  app.cfg.visionToken = SEAM_TOK;
  assert.ok(app.paperCardHTML().indexOf('data-act="paper-shoot"') > -1,
    'and it appears the moment BOTH halves are there');
  // A closed day has no page of figures to read.
  app.benta.closed = true;
  assert.strictEqual(app.paperCardHTML(), '');
  // SOURCE PIN: the button is both OFFERED and HANDLED, and the card is wired
  // into the Sales screen at all (both are DOM-bound, so they are pinned here).
  assert.ok(/if \(!visionReady\(\) \|\| !isObj\(benta\)\) return '';/.test(S_PAPER),
    'paperCardHTML must return nothing at all when the reader is not set up');
  for (const act of ['paper-shoot', 'paper-hide', 'vision-test']) {
    assert.ok(HTML.indexOf('data-act="' + act + '"') > -1, act + ' is never offered');
    assert.ok(HTML.indexOf("act === '" + act + "'") > -1, act + ' is offered but not handled');
  }
  const render = slab('function renderBenta(){', 'const CHEV =');
  assert.ok(/h \+= paperCardHTML\(\);/.test(render), 'the card must be on the Sales screen');
  assert.ok(/try\{ h \+= paperCardHTML\(\); \}catch/.test(render),
    'and guarded, so a reading can never take the night-entry screen down');
});

test('an offline phone says so BEFORE the camera opens, and spends no photograph', () => {
  // A photograph taken for nothing costs her a second trip to the paper, so
  // both refusals happen before the camera is ever asked for.
  const app = paperApp(DAY);
  app.hooks.fetch = () => { throw new Error('the wire must not be touched'); };
  const el = { value: 'x', clicked: 0, click(){ this.clicked++; } };
  app.hooks.els.paperShot = el;
  app.nav.onLine = false;
  app.paperShoot();
  assert.strictEqual(el.clicked, 0, 'the camera must not open with no signal');
  assert.ok(/no internet just now/.test(app.paperErr), app.paperErr);
  assert.ok(/type the night in by hand/.test(app.paperErr), app.paperErr);
  assert.deepStrictEqual(app.hooks.confirms, [], 'and nothing was asked before it');
  // Set up but not configured refuses in its own words, equally early.
  app.nav.onLine = true;
  app.cfg.visionToken = '';
  app.paperShoot();
  assert.strictEqual(el.clicked, 0);
  assert.ok(/not set up on this phone/.test(app.paperErr), app.paperErr);
  // Configured and online, it asks ONCE before replacing figures already on the
  // form, and only then opens the camera.
  app.cfg.visionToken = SEAM_TOK;
  app.paperShoot();
  assert.strictEqual(app.hooks.confirms.length, 1, 'one question, and only when there is something to lose');
  assert.ok(/replace the figures now on the form/.test(app.hooks.confirms[0]));
  assert.strictEqual(el.clicked, 1, 'and then the camera opens');
  assert.strictEqual(el.value, '', 'cleared FIRST, or the same picture cannot be chosen twice');
});

// --- THE SIZE CAP ----------------------------------------------------------

atest('the phone never sends a photo the reader would refuse for its size', async () => {
  const app = paperApp(DAY);
  // A 12-megapixel original. The ladder cuts quality before size and stops at
  // the first pass that fits, so the bytes SENT are under the reader's own cap —
  // which is proved by handing them to the real Vision.gs.
  app.hooks.bitmap = () => ({ width: 4032, height: 3024, close(){} });
  let sentBody = null;
  app.hooks.fetch = (url, opts) => {
    sentBody = JSON.parse(opts.body);
    const ctx = loadVisionSeam();
    ctx.UrlFetchApp._reply(200, geminiSaid(PAPER_READ));
    return Promise.resolve({ ok: true, text: async () =>
      ctx.doPost({ postData: { contents: opts.body } }).getContent() });
  };
  await app.paperTake({ size: 7 * 1024 * 1024, name: 'IMG_0001.HEIC' });
  assert.strictEqual(app.paperErr, '', app.paperErr);
  const b64 = sentBody.payload.imageBase64;
  assert.ok(app.b64Bytes(b64) <= 4 * 1024 * 1024,
    'the phone sent ' + app.b64Bytes(b64) + ' bytes, over the reader\'s 4 MB cap');
  assert.strictEqual(sentBody.payload.mimeType, 'image/jpeg',
    'whatever the camera wrote, it leaves this phone re-encoded');
  // The ladder was walked, not jumped: the first attempt was the best quality.
  assert.ok(app.hooks.encodes.length >= 1);
  assert.strictEqual(app.hooks.encodes[0].q, 0.8);
  assert.ok(app.hooks.encodes[0].w <= 1600 && app.hooks.encodes[0].h <= 1600,
    'the long edge is brought down to 1600 before anything is sent');
  // And a picture that will not fit even at the bottom of the ladder is refused
  // HERE, in one plain sentence, rather than sent to be refused there.
  const app2 = paperApp(DAY);
  app2.hooks.jpegChars = () => 9 * 1024 * 1024;
  app2.hooks.fetch = () => { throw new Error('nothing may be sent'); };
  await app2.paperTake({ size: 20 * 1024 * 1024, name: 'huge.jpg' });
  assert.ok(/too big to send even after shrinking/.test(app2.paperErr), app2.paperErr);
  assert.ok(/type the night in by hand/.test(app2.paperErr),
    'and every refusal says the way through is always still there');
});

atest('the reader\'s own refusals reach the screen as themselves, and fill nothing in', async () => {
  const app = paperApp(DAY);
  const before = JSON.stringify(app.benta.rows);
  app.hooks.fetch = (url, opts) => {
    const ctx = loadVisionSeam();
    ctx.UrlFetchApp._reply(429, { error: { message: 'Quota exceeded for requests' } });
    return Promise.resolve({ ok: true, text: async () =>
      ctx.doPost({ postData: { contents: opts.body } }).getContent() });
  };
  await app.paperTake({ size: 800000, name: 'paper.jpg' });
  assert.ok(/no quota left right now/.test(app.paperErr), app.paperErr);
  assert.ok(/type the night in by hand/.test(app.paperErr), app.paperErr);
  assert.ok(app.paperErr.indexOf(SEAM_KEY) < 0, 'and never carries the key out');
  assert.strictEqual(app.paper, null, 'nothing is shown');
  assert.strictEqual(JSON.stringify(app.benta.rows), before,
    'and not one figure on the form was touched');
  assert.strictEqual(app.queue.length, 0);
});



// ---------------------------------------------------------------------------
// v2.9.3 — THE SCREEN SHE READS, MEASURED.
// The app is used at night, outdoors, at whatever brightness the phone is left
// on, by a woman in her sixties. Contrast is not decoration here, so it is
// arithmetic in a test rather than an opinion in a review: these ratios are
// recomputed from the palette in the shipped file every run.
// ---------------------------------------------------------------------------

function _lum(hex){
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b){
  const la = _lum(a), lb = _lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function cssVar(src, name){
  const m = src.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})'));
  assert.ok(m, 'the palette must still define --' + name);
  return m[1];
}

test('the palette MEASURES up: boundaries 3:1, accent-as-text 4.5:1 (v2.9.3)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const bg = cssVar(src, 'bg'), paper = cssVar(src, 'paper'), ink = cssVar(src, 'ink');
  const strong = cssVar(src, 'line-strong'), accentText = cssVar(src, 'accent-text');

  // WCAG 1.4.11: a boundary that tells her WHICH BOX a figure goes in is a UI
  // component, and needs 3:1. The old --line was 1.25:1 — beautiful, and very
  // nearly invisible on a dimmed screen.
  assert.ok(contrast(strong, bg) >= 3, '--line-strong on --bg is ' + contrast(strong, bg).toFixed(2) + ', needs 3');
  assert.ok(contrast(strong, paper) >= 3, '--line-strong on --paper is ' + contrast(strong, paper).toFixed(2) + ', needs 3');

  // 1.4.3: text needs 4.5:1. --accent is 4.04 — fine as a FILL behind white,
  // thin as a colour ON the background, which is how the date kicker uses it.
  assert.ok(contrast(accentText, bg) >= 4.5,
    '--accent-text on --bg is ' + contrast(accentText, bg).toFixed(2) + ', needs 4.5');
  assert.ok(contrast(accentText, paper) >= 4.5,
    '--accent-text on --paper is ' + contrast(accentText, paper).toFixed(2) + ', needs 4.5');

  // The body text was always fine; pinned so a future "softening" cannot pass.
  assert.ok(contrast(ink, bg) >= 7, 'body text should clear AAA, is ' + contrast(ink, bg).toFixed(2));

  // A white-on-accent FILL (primary button, pressed chip) still has to work.
  assert.ok(contrast('#FFFFFF', cssVar(src, 'accent')) >= 3,
    'white on the accent fill is ' + contrast('#FFFFFF', cssVar(src, 'accent')).toFixed(2));
});

test('every boundary a finger aims at uses the STRONG line (v2.9.3)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  // The rules whose border IS the target: the card that groups a night's
  // figures, the fields, the steppers, the chips. A hairline here is what makes
  // her tap the wrong box.
  for (const rule of ['.card{', '.input{', '.chip{', '.step-btn{', '.step-val{']) {
    // Anchored to the start of a line: '.step-btn{' also occurs inside
    // '.stepper.sm .step-btn{', and reading the wrong rule's body would let a
    // hairline through while the test went green.
    const at = src.indexOf('\n' + rule);
    assert.ok(at > 0, 'the rule ' + rule + ' must still exist as its own rule');
    const body = src.slice(at, src.indexOf('}', at));
    assert.ok(/var\(--line-strong\)/.test(body),
      rule + ' must draw its border with --line-strong, not the hairline');
    assert.ok(!/border:[^;]*var\(--line\)/.test(body),
      rule + ' must not fall back to the 1.25:1 --line for its border');
  }
});

test('the selected tab says so with more than colour, and the theme is declared (v2.9.3)', () => {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  const at = src.indexOf('.tab[aria-selected="true"]{');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('}', at));
  // 1.4.1: colour may not be the ONLY way of conveying which screen she is on.
  assert.ok(/box-shadow:inset/.test(body),
    'the selected tab needs a shape cue too — colour alone fails a colour-blind eye and bright sun');
  // aria-selected is the cue a screen reader gets; it was already there.
  assert.ok(/aria-selected=/.test(src), 'and the tab must still announce itself');

  // Without this, Android/Chrome forced-dark invents its own inversion of a
  // design that has exactly one intended appearance — and money turns unreadable.
  assert.ok(/<meta name="color-scheme" content="light">/.test(src),
    'the page must declare its scheme so forced-dark does not reinvent it');
  assert.ok(/color-scheme:light;/.test(src), 'and declare it in CSS as well');
});

// ---------------------------------------------------------------------------
// v2.13.3 — THE ESCAPE HATCH.
// ---------------------------------------------------------------------------

atest('GET THE LATEST VERSION: clears the saved PAGE, never the work (v2.13.3)', async () => {
  // Owner, 2026-08-28: "its not updating." This app updates itself, and when
  // that gets stuck there was no way out from the phone — the only advice left
  // was "clear the site data", which throws away every unsent night with it.
  const g = loadUpdateGate({ benta: { dirty: false } });
  await g.forceUpdate();

  // The saved copy of the app goes — BOTH caches, so a reload cannot be served
  // the old page again.
  assert.deepStrictEqual(g.log.cachesDeleted, ['octogo-shell-v1.0.0', 'octogo-fonts-v1'],
    'every cached copy of the app is dropped');
  assert.strictEqual(g.log.unregistered, 1, 'and the worker holding them is unregistered');
  assert.strictEqual(g.log.reloads, 1, 'then it loads fresh, once');
  // THE POINT OF THE WHOLE THING: localStorage is never written or cleared.
  // The queue, the drafts, the config and the attention list all live there.
  assert.strictEqual(g.log.storeWrites, 0, 'her work is not touched at all');
  // And the ordinary update path must not fire a SECOND reload behind it.
  assert.strictEqual(g.reloadingForUpdate, true, 'one reload, not two');
});

atest('GET THE LATEST VERSION: refuses while anything is unsent (v2.13.3)', async () => {
  // A reload is safe for a DRAFT — it comes back. A queued mutation that has
  // not reached the sheet is work this phone is the only copy of, and no
  // convenience is worth going near it.
  const g = loadUpdateGate({ benta: { dirty: false },
    queue: [{ action: 'saveDay', payload: {} }, { action: 'saveExpense', payload: {} }] });
  await g.forceUpdate();
  assert.deepStrictEqual(g.log.cachesDeleted, [], 'nothing is cleared');
  assert.strictEqual(g.log.unregistered, 0, 'nothing is unregistered');
  assert.strictEqual(g.log.reloads, 0, 'and nothing is reloaded');
  assert.match(g.log.hint, /2 entries still waiting to reach the sheet/,
    'it says how many, so the refusal is checkable');
  assert.match(g.log.hint, /Sync now/, 'and what to do instead');

  // A send in flight is the same answer for the same reason.
  const mid = loadUpdateGate({ benta: { dirty: false }, syncing: true });
  await mid.forceUpdate();
  assert.strictEqual(mid.log.reloads, 0, 'never mid-send');
  assert.match(mid.log.hint, /being sent right now/);
});

atest('GET THE LATEST VERSION: the page says where it came from (v2.13.3)', async () => {
  // A version that will not move has to be SEEABLE, or the only tool left is
  // guessing at someone else's phone.
  const cached = loadUpdateGate({ benta: { dirty: false } });
  assert.match(cached.swStateText(), /a saved copy on this phone/);
  cached.updateWaiting = true;
  assert.match(cached.swStateText(), /a newer one is downloaded and waiting/,
    'an update sitting unapplied is exactly the state that needs naming');

  const fresh = loadUpdateGate({ benta: { dirty: false }, controlled: false });
  assert.match(fresh.swStateText(), /no saved copy yet/,
    'and a page with no worker says so rather than implying one');
});

// ---------------------------------------------------------------------------
// v2.9.3 — NOTHING WAITS FOREVER.
// ---------------------------------------------------------------------------

atest('a request that never comes back GIVES UP, and the night stays in the queue (v2.9.3)', async () => {
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = 'tok';
  app.hooks.timerCap = 5;          // the code still asks for its real 30s
  const D = ymdDaysAgo(2);

  const v = dayPayload(D, 100, 'stalled');
  app.applyLocalDay(v);
  app.enqueue('saveDay', v);

  // The way mobile data actually fails mid-request: the socket is open, the
  // tower is gone, and the promise simply never settles. No error, ever.
  let calls = 0;
  app.hooks.fetch = () => { calls++; return new Promise(() => {}); };

  await app.drainQueue();

  assert.strictEqual(calls, 1, 'precondition: it did reach the wire');
  assert.strictEqual(app.syncing, false,
    'the drain must END — a stuck syncing flag silently stops every later night');
  assert.strictEqual(app.queue.length, 1,
    'giving up must not throw the night away — it is still queued to retry');
  assert.strictEqual(app.state.days[D].total, 5000,
    'and her figures are still on the phone, untouched');
  // What she READS matters as much as what happens: a save that timed out may
  // in fact have landed, and the retry is safe, so the sentence must not tell
  // her the night failed.
  assert.match(app.lastSyncError, /did not answer within 30 seconds/,
    'the wait is named in seconds, in her words');
  assert.match(app.lastSyncError, /Nothing is lost/,
    'and it must NOT say the night failed — it may even have landed');
  assert.ok(!/AbortError|Failed to fetch|signal/i.test(app.lastSyncError),
    'no browser string ever reaches the screen');

  // A retry is safe BECAUSE every queued action upserts on a key: the same
  // save landing twice rewrites one row. Proven here end to end.
  const srv = loadServer();
  app.cfg.token = srv.token;
  app.hooks.fetch = liveWire(srv);
  await app.drainQueue();
  assert.strictEqual(app.queue.length, 0, 'the retry lands');
  const rows = srv.ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .filter(r => r[0] === D);
  assert.strictEqual(rows.length, 1, 'ONE row for that night, not one per attempt');
});

atest('the deadline is the app\'s own, not the platform\'s (v2.9.3)', async () => {
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = 'tok';
  app.hooks.timerCap = 5;

  // A WebView that ACCEPTS a signal and then ignores it — real behaviour on
  // some old Android builds. If the deadline were a callback on the signal
  // alone, this request would hang forever and this test would time out.
  app.hooks.fetch = (url, opts) => {
    assert.ok(opts.signal, 'the abort is still sent, so a cooperating platform can drop the socket');
    return new Promise(() => {});
  };
  const D = ymdDaysAgo(3);
  const v = dayPayload(D, 100, 'ignored-signal');
  app.applyLocalDay(v);
  app.enqueue('saveDay', v);

  await app.drainQueue();
  assert.strictEqual(app.syncing, false, 'released by the race, not by the signal');
  assert.strictEqual(app.queue.length, 1);
});

atest('a throw on the FAILURE path cannot jam sync forever (v2.9.3)', async () => {
  const srv = loadServer();
  const app = loadSyncClient();
  app.cfg.apiUrl = 'https://api.example/exec';
  app.cfg.token = srv.token;
  const D = ymdDaysAgo(4);

  const v = dayPayload(D, 100, 'jam');
  app.applyLocalDay(v);
  app.enqueue('saveDay', v);

  // The server REFUSES, and then the code that reports the refusal throws —
  // the one path where an escape used to leave `syncing` true for the life of
  // the app, so the pill said "Syncing…" and nothing ever left the phone again.
  app.hooks.fetch = () => Promise.resolve({
    ok: true,
    text: async () => JSON.stringify({ ok: false, error: 'refused for the test' })
  });
  const realToast = app.hooks.toasts;
  Object.defineProperty(app.hooks, 'toasts', {
    get(){ throw new Error('the reporting itself broke'); },
    configurable: true
  });

  let escaped = null;
  try{ await app.drainQueue(); }catch(err){ escaped = err; }

  Object.defineProperty(app.hooks, 'toasts', { value: realToast, configurable: true, writable: true });

  assert.ok(escaped, 'precondition: the failure path really did throw');
  assert.strictEqual(app.syncing, false,
    'and syncing was released anyway — the finally, not the line after the loop');

  // The proof that matters: the NEXT night still gets out.
  const D2 = ymdDaysAgo(5);
  const v2 = dayPayload(D2, 60, 'after-the-jam');
  app.applyLocalDay(v2);
  app.enqueue('saveDay', v2);
  app.hooks.fetch = liveWire(srv);
  await app.drainQueue();
  assert.strictEqual(srv.ss.getSheetByName('DailyLog').getDataRange().getValues().slice(1)
    .filter(r => r[0] === D2).length, 1,
    'the night after a jam reaches the sheet');
});

// ---------------------------------------------------------------------------
// The async race tests run through the REAL drainQueue/doBootstrap promises,
// so they are awaited in order here — and the summary waits for them.
(async () => {
  /* EVERY ASYNC TEST GETS A WATCHDOG (v2.9.3).
     A test that awaits a promise which never settles does not hang node — it
     empties the event loop, and node EXITS 0, silently, without the summary
     and without the tests that were still queued behind it. So a real forever
     -hang used to read as a clean pass, which is precisely the bug the timeout
     work is about. A hang now fails, loudly, as itself. */
  process.on('exit', (code) => {
    if (!summaryPrinted && code === 0) {
      console.error('\nFAILED: the suite exited before printing its summary — an async test' +
        ' awaited something that never settled (node exits 0 when the event loop empties).' +
        '\n        The last test to start was: ' + (lastStarted || '(none)'));
      process.exitCode = 1;
    }
  });
  for (const t of ASYNC_TESTS) {
    lastStarted = t.name;
    try {
      let w = null;
      try{
        await Promise.race([
          t.fn(),
          new Promise((_, rej) => {
            w = setTimeout(() => rej(new Error('TIMED OUT after ' + (WATCHDOG_MS / 1000) +
              's — something in this test never settles')), WATCHDOG_MS);
          })
        ]);
      }finally{
        // Cleared on the winning path, so a passing suite is not held open for
        // ten seconds per test — and NOT unref'd, so a real hang reaches the
        // watchdog and gets named instead of vanishing into a silent exit.
        if (w) clearTimeout(w);
      }
      passed++;
      console.log('  PASS  ' + t.name);
    } catch (err) {
      failed++;
      failures.push({ name: t.name, err });
      console.log('  FAIL  ' + t.name + '\n        ' + String(err.message).split('\n').join('\n        '));
    }
  }
  summaryPrinted = true;
  console.log('\n============================================');
  console.log('  ' + passed + ' passed, ' + failed + ' failed  (' + path.basename(__filename) + ')');
  console.log('============================================');
  if (failed > 0) {
    failures.forEach(f => console.error('\nFAILED: ' + f.name + '\n' + f.err.stack));
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
