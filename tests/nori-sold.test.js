#!/usr/bin/env node
'use strict';

// Nori's one-field UI must use the existing API safely, without rewriting
// untouched historical stock counts or turning free units into paid sales.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { FakeSpreadsheet, makeContext, formatDate, FIXED_NOW } = require('./gas-stubs');
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'pwa/index.html'), 'utf8');
function slab(start, end) {
  const at = marker => {
    const pattern = marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
    const hit = new RegExp(pattern).exec(HTML);
    return hit ? hit.index : -1;
  };
  const a = at(start), b = at(end);
  assert(a >= 0 && b > a, `Missing source boundary: ${start} / ${end}`);
  return HTML.slice(a, b);
}
function loadApp() {
  const source = [
    slab('function readStored(k){', "let state  = sanitizeState(readStored('state_v1'));"),
    slab('const EN_MONTHS  =', 'function computeDay(p){'),
    slab('function computeDay(p){', 'function invalidateNoteFor(date){'),
    slab('function loadBentaForm(date){', '// SKU list to render:'),
    slab('function rowUI(r){', 'function syncRowInputs(sku, r){'),
    slab('function isWhole(v){', "/** 'sku:box4' -> 'err-sku-box4'"),
    slab('function prettySku(sku){', 'function listPhrase(names){'),
    slab('const ROW_FIELDS =', '/* ---- The presentation of the SAME three entered buckets'),
    slab('// The three ENTERED buckets, with the label each one shows.', '/* ---- The needs-attention card.'),
    slab('function skuSplitText(pr, row){', '// The row fields a stepper may write.'),
    slab('function bentaStep(sku, field, dir){', 'function afterCountChange(sku){')
  ].join('\n');
  return new Function(`
    const store={read(){return null;},set(){}};
    ${source}
    let state=freshState(), queue=[], config=freshConfig(), attention=[], drafts={}, benta=null;
    const UI_FIELDS={};
    const inputs={};
    function $(id){return inputs[id] || null;}
    function persistDrafts(){}
    function wageIsCustom(){return false;}
    function toast(){}
    function afterCountChange(){}
    function uiStep(){throw Error('Unexpected bucket step');}
    return {get state(){return state;},get benta(){return benta;},get drafts(){return drafts;},
      loadBentaForm,bentaPayload,computeDay,validateBenta,stashBentaDraft,applyBentaDraft,sanitizeDrafts,
      noriUsesSoldField,noriSoldVal,setNoriSold,setNoriFree,noriCountHTML,skuSplitText,bentaStep,nightChecks,
      restoreDrafts(raw){drafts=sanitizeDrafts(raw);},inputs};
  `)();
}
const DATE = formatDate(new Date(FIXED_NOW.getTime()-2*86400000),'Asia/Manila','yyyy-MM-dd');
const PRIOR = formatDate(new Date(FIXED_NOW.getTime()-3*86400000),'Asia/Manila','yyyy-MM-dd');
function nori(app) { return app.benta.rows.find(r => r.sku === 'nori'); }
function wireNori(app) { return app.bentaPayload().counts.find(r => r.sku === 'nori'); }
function newDay() { const app = loadApp(); app.loadBentaForm(DATE); return app; }
function historical(app, free = 1) {
  app.state.days[DATE] = { date: DATE, total: 0, gcash: 0, salary: 200, closed: false };
  app.state.counts[DATE] = [{ date: DATE, sku: 'nori', sod: 11, eod: 8, sold: 3,
    free_qty: free, amount: (3-free)*25, price:25, in_cutoff:false }];
  app.loadBentaForm(DATE);
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('new nori starts at zero sales, never yesterday’s stock; box carryover remains', () => {
  const app = loadApp();
  app.state.counts[PRIOR] = [{sku:'nori',sod:20,eod:11},{sku:'box4',sod:30,eod:12}];
  app.loadBentaForm(DATE);
  assert.strictEqual(app.noriSoldVal(nori(app)), 0);
  assert.strictEqual(app.benta.rows.find(r=>r.sku==='box4').sod, 12);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 0);
});
test('historical paid amount is displayed without rewriting SOD/EOD', () => {
  const app = newDay(); historical(app);
  assert.strictEqual(app.noriSoldVal(nori(app)), 2);
  assert.strictEqual(wireNori(app).sod, 11);
  assert.strictEqual(wireNori(app).eod, 8);
  app.setNoriSold(nori(app), '2');
  assert.strictEqual(wireNori(app).sod, 11);
  assert.strictEqual(wireNori(app).eod, 8);
  app.benta.notes = 'Only the note changed';
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 50);
});
test('explicit sold edit uses a backend-compatible count without changing freebies', () => {
  const app = newDay(); historical(app);
  app.setNoriSold(nori(app), '4');
  assert.strictEqual(wireNori(app).sod, 5);
  assert.strictEqual(wireNori(app).eod, 0);
  assert.strictEqual(wireNori(app).freeQty, 1);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 100);
});
test('free edits preserve paid sales, including a night with only free nori', () => {
  const app = newDay(); historical(app);
  app.setNoriFree(nori(app), '3');
  assert.strictEqual(app.noriSoldVal(nori(app)), 2);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 50);
  app.setNoriSold(nori(app), 0);
  assert.strictEqual(wireNori(app).sod, 3);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 0);
  assert.strictEqual(app.validateBenta()['sku:nori'], undefined);
});
test('one visible quantity input replaces both stock inputs', () => {
  const app = newDay(), pr = app.state.prices.find(p=>p.sku==='nori');
  const html = app.noriCountHTML(pr, nori(app));
  assert.strictEqual((html.match(/<input\b/g)||[]).length, 1);
  assert.match(html, /Quantity sold/);
  assert.match(html, /id="in-nori-noriSold"/);
  assert.doesNotMatch(html, /id="in-nori-(?:sod|eod)"/);
  assert.match(html, /0 if none/);
  assert.match(HTML, /directSold \? noriCountHTML\(pr, row\)/);
});
test('zero sold gives a zero money explanation, not a start/end prompt', () => {
  const app = newDay(), pr = app.state.prices.find(p=>p.sku==='nori');
  app.setNoriFree(nori(app), 2);
  const text = app.skuSplitText(pr, nori(app));
  assert.match(text, /0 × ₱25 = ₱0/);
  assert.doesNotMatch(text, /start|end counts/i);
});
test('cleared sold answer stays blank, blocks saving, and survives draft restore', () => {
  const app = newDay();
  app.setNoriSold(nori(app), '');
  app.setNoriFree(nori(app), 2);
  app.benta.dirty = true;
  assert.strictEqual(app.noriSoldVal(nori(app)), '');
  assert.match(app.validateBenta()['sku:nori'], /enter the quantity sold/);
  app.stashBentaDraft();
  const draft = JSON.parse(JSON.stringify(app.drafts));
  app.restoreDrafts(draft);
  app.loadBentaForm(DATE);
  assert.strictEqual(app.noriSoldVal(nori(app)), '');
  assert.strictEqual(nori(app).free, 2);
  assert.match(app.validateBenta()['sku:nori'], /enter the quantity sold/);
  app.setNoriSold(nori(app), '0');
  assert.strictEqual(app.validateBenta()['sku:nori'], undefined);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 0);
});
test('fractional, negative, and nonnumeric paid answers cannot save', () => {
  for (const raw of ['1.5', '-1', 'no', '2x']) {
    const app = newDay(); app.setNoriSold(nori(app), raw);
    assert(app.validateBenta()['sku:nori'], `${raw} must fail validation`);
  }
});
test('invalid free quantity cannot silently become zero or rewrite paid sales', () => {
  const app = newDay(); app.setNoriSold(nori(app), 2);
  app.setNoriFree(nori(app), 'bad');
  assert(app.validateBenta()['free:nori']);
  app.setNoriFree(nori(app), 3);
  assert.strictEqual(app.noriSoldVal(nori(app)), 2);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 50);
});
test('new paid/free draft restores both answers without interpreting them as stock', () => {
  const app = newDay(); app.setNoriSold(nori(app), 4); app.setNoriFree(nori(app), 2);
  app.benta.dirty = true; app.stashBentaDraft();
  app.restoreDrafts(JSON.parse(JSON.stringify(app.drafts)));
  app.loadBentaForm(DATE);
  assert.strictEqual(app.noriSoldVal(nori(app)), 4);
  assert.strictEqual(nori(app).free, 2);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 100);
});
test('anomaly hint names the quantity-sold field and never claims stock remains', () => {
  const app = newDay();
  const before = new Date(DATE+'T00:00:00Z');
  for (let i=1;i<=6;i++) {
    const d = new Date(before.getTime()-i*86400000).toISOString().slice(0,10);
    app.state.counts[d] = [{sku:'nori',sod:11,eod:8,free_qty:1}];
  }
  const said = app.nightChecks().join('\n');
  assert.match(said, /nothing sold tonight/);
  assert.match(said, /Quantity sold/);
  assert.doesNotMatch(said, /end count|still there/);
});
test('unchanged legacy drafts preserve their stock readings and free units', () => {
  const app = newDay(); historical(app);
  app.benta.dirty = true; app.stashBentaDraft();
  app.restoreDrafts(JSON.parse(JSON.stringify(app.drafts)));
  app.loadBentaForm(DATE);
  assert.strictEqual(wireNori(app).sod, 11);
  assert.strictEqual(wireNori(app).eod, 8);
  assert.strictEqual(wireNori(app).freeQty, 1);
  assert.strictEqual(app.noriSoldVal(nori(app)), 2);
});
test('sold and free steppers preserve independent answers', () => {
  const app = newDay();
  app.bentaStep('nori','noriSold',1);
  app.bentaStep('nori','free',1);
  app.bentaStep('nori','free',1);
  assert.strictEqual(app.noriSoldVal(nori(app)), 1);
  assert.strictEqual(nori(app).free, 2);
  assert.strictEqual(app.computeDay(app.bentaPayload()).excluded, 25);
  app.bentaStep('nori','noriSold',-1);
  app.bentaStep('nori','noriSold',-1);
  assert.strictEqual(app.noriSoldVal(nori(app)), 0);
  assert.strictEqual(nori(app).free, 2);
});
test('existing server accepts serialized offline payload and prices paid units once', () => {
  const app = newDay(); app.setNoriSold(nori(app), 4); app.setNoriFree(nori(app), 2);
  const payload = JSON.parse(JSON.stringify(app.bentaPayload()));
  payload.entryId = 'nori-sold-field-contract';
  const ss = new FakeSpreadsheet(), server = makeContext(ss);
  vm.createContext(server);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'apps-script','Code.gs'),'utf8'), server);
  const token = server.setupSheet();
  const out = JSON.parse(server.doPost({postData:{contents:JSON.stringify({token,action:'saveDay',payload})}}).getContent());
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.data.excluded_total, 100);
  const saved = out.data.lines.find(r=>r.sku==='nori');
  assert.strictEqual(saved.sold, 6);
  assert.strictEqual(saved.free_qty, 2);
  assert.strictEqual(saved.amount, 100);
  app.state.days[DATE] = {date:DATE,total:0,gcash:0,salary:200};
  app.state.counts[DATE] = server.readCounts(ss).filter(r=>r.date===DATE);
  app.loadBentaForm(DATE);
  assert.strictEqual(app.noriSoldVal(nori(app)), 4);
  assert.strictEqual(wireNori(app).freeQty, 2);
});
console.log(`\n${passed} nori quantity-sold checks passed.`);
