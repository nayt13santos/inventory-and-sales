#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { FakeSpreadsheet, makeContext } = require('./gas-stubs');
const root = path.resolve(__dirname,'..');
const html = fs.readFileSync(path.join(root,'pwa/index.html'),'utf8');
function slab(a,b) {
  const at = s => {
    const m = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+')).exec(html);
    assert(m, 'Missing boundary '+s); return m.index;
  };
  return html.slice(at(a),at(b));
}
function app() {
  return new Function(`
    const store={read(){return null;},set(){}};
    ${slab('function readStored(k){', "let state  = sanitizeState(readStored('state_v1'));")}
    ${slab('const EN_MONTHS  =', 'function computeDay(p){')}
    ${slab('function computeDay(p){', 'function invalidateNoteFor(date){')}
    ${slab('function invalidateNoteFor(date){','function enqueue(action, payload){')}
    ${slab('function cutoffPaymentHTML(per, f){','function renderCutoff(){')}
    ${slab('function suppliesSplit(f){','function excludedBlockHTML(f){')}
    let state=freshState(),queue=[],attention=[],config=freshConfig(),drafts={},lastNote=null;
    const tinEdits={};
    function previewIncomplete(){return false;}
    function missingDaysInPeriod(){return [];}
    function cutoffMissingDays(){return [];}
    function cutoffMissingMoney(){return [];}
    return {state,queue,attention,config,tinEdits,checkEdits,checkMoney,cutoffCashCheck,cutoffCheckBasis,
      cutoffCheckSaved,cutoffCashHTML,cutoffPaymentHTML,cutoffCheckFormHTML,
      applyLocalCutoffCheck,applyLocalTinCount,applyLocalCutoffSplit,normCutoffInput,
      sanitizeState,sanitizeQueue,reapplyQueue,computeCutoff,buildNote};
  `)();
}
const per={start:'2026-09-16',end:'2026-09-30'}, key=per.start+'_'+per.end;
function confirmed() {
  return {version:1,statuses:{minor:'paid',salary:'paid',mama:'pending',electric:'pending',split:'pending',major:'pending'},
    tin:{minor:7276,salary:2800,mama:'',electric:'',split:'',major:''},
    opening:0,borrowed:4620,paper:23502,paperSalary:1200,basis:''};
}
function fixture() {
  const a=app();
  Object.assign(a.state.expenses,{
    minor:{entry_id:'minor',date:per.end,category:'Supplies',amount:7276,paid_from:'tin'},
    other:{entry_id:'gcash',date:per.end,category:'Other',amount:396,paid_from:'gcash'},
    mama:{entry_id:'mama',date:per.end,category:'Mama',amount:500,paid_from:'tin'},
    electric:{entry_id:'electric',date:per.end,category:'Electric',amount:500,paid_from:'tin'}
  });
  a.state.cutoffInputs[key]={...per,split_amount:6000,tin_counted:10006,entry_id:'period'};
  const f={total:28405,cash:24602,gcash:3803,excluded:100,salary:2800,split:6000,mama:500,electric:500,
    suppliesMinor:7672,suppliesUsed:6830,backlogPaid:0,tinOut:8276,tinUnknown:0,remaining:4103};
  const c=confirmed(); c.basis=a.cutoffCheckBasis(per,f);
  a.applyLocalCutoffCheck({...per,entryId:'period',check:c});
  return {a,f,c};
}
let passed=0;
function test(name,fn){fn();passed++;console.log('  PASS  '+name);}
test('Sept paper and cash reconcile without re-deducting paid wages/minor or pending items',()=>{
  const {a,f,c}=fixture(),r=a.cutoffCashCheck(per,f,c);
  assert.equal(r.expected,10006); assert.equal(r.paid,10076);
  assert.equal(r.comparable,23502); assert.equal(r.paperDifference,0);
  assert.equal(r.difference,0); assert.equal(r.complete,true);
  assert.equal(r.conflicts.length,2,'Mama/electric remain inconsistent with Expenses');
  assert.doesNotMatch(a.cutoffCashHTML(per,f),/Cash balances against/);
});
test('the incorrect Sept18 nori record still surfaces as a 275 difference, never hidden',()=>{
  const {a,f,c}=fixture(); f.excluded=375;
  const r=a.cutoffCashCheck(per,f,c);
  assert.equal(r.expected,10281);assert.equal(r.difference,-275);assert.equal(r.paperDifference,275);
  assert(r.issues.some(s=>s.includes('Source figures changed')));
});
test('category cash totals replace recorded cash; GCash is not deducted from tin',()=>{
  const {a,f,c}=fixture(); c.tin.minor=7000;
  const r=a.cutoffCashCheck(per,f,c);
  assert.equal(r.paid,9800);assert.equal(r.expected,10282);
  assert(r.conflicts.some(s=>s.includes('Supplies (minor)')));
  assert.equal(a.state.expenses.minor.amount,7276,'confirmation never changes Expenses');
});
test('blank is unknown, not zero; negative, nonfinite and nonnumeric amounts are refused',()=>{
  const {a,f}=fixture(); const c=a.cutoffCheckSaved({start:'2026-10-01',end:'2026-10-15'});
  assert.equal(c.opening,'');assert.equal(c.statuses.salary,'unknown');
  assert.equal(a.cutoffCashCheck(per,f,c).complete,false);
  for(const v of ['',null,undefined,' ','abc','1x',-1,Infinity,NaN,true,{},1e12]) assert.equal(a.checkMoney(v),null,String(v));
  assert.equal(a.checkMoney('0'),0);assert.equal(a.checkMoney('12.35'),12.35);
});
test('partial payments debit the confirmed cash once, pending with cash is a conflict',()=>{
  const {a,f,c}=fixture();c.statuses.split='partial';c.tin.split=1000;
  assert.equal(a.cutoffCashCheck(per,f,c).expected,9006);
  c.statuses.split='pending';
  assert(a.cutoffCashCheck(per,f,c).issues.some(s=>s.includes('still to pay conflicts')));
});
test('payment groups state cost-versus-cash meaning and keep remaining out of checklist',()=>{
  const {a,f}=fixture(),h=a.cutoffPaymentHTML(per,f);
  assert.match(h,/Already deducted/);assert.match(h,/Still to pay/);
  assert.match(h,/Value of stock consumed/);assert.match(h,/Includes purchases paid through GCash/);
  assert.doesNotMatch(h,/>Remaining</);
  assert.match(a.cutoffCheckFormHTML(per),/Borrowed this cutoff/);
});
test('save/normalise/reload preserves checklist, split and counted cash independently',()=>{
  const {a,f,c}=fixture();
  a.state.cutoffInputs[key]=a.normCutoffInput(JSON.parse(JSON.stringify(a.state.cutoffInputs[key])));
  assert.deepEqual(a.cutoffCheckSaved(per).statuses,c.statuses);
  a.applyLocalCutoffSplit({...per,entryId:'period',amount:5000});
  a.applyLocalTinCount({...per,entryId:'period',counted:10000});
  assert.equal(a.cutoffCheckSaved(per).tin.minor,7276);
  assert.equal(a.state.cutoffInputs[key].split_amount,5000);
  assert.equal(a.state.cutoffInputs[key].tin_counted,10000);
  assert.equal(a.cutoffCashCheck(per,f).difference,-6);
});
test('saved offline check survives queue normalisation and replays after refresh',()=>{
  const {a,c}=fixture(),payload={...per,entryId:'period',check:c};
  const q=a.sanitizeQueue([{action:'saveCutoffCheck',payload}]);assert.equal(q.length,1);
  a.queue.push(q[0]);delete a.state.cutoffInputs[key];a.reapplyQueue();
  assert.equal(a.cutoffCheckSaved(per).borrowed,4620);
});
test('unsaved checks/counts, paper mismatch and rejected period entries cannot claim cleared',()=>{
  for(const mode of ['check','count','paper','rejected-count','rejected-split','legacy-day']){
    const {a,f,c}=fixture();delete a.state.expenses.mama;delete a.state.expenses.electric;
    c.basis=a.cutoffCheckBasis(per,f);a.applyLocalCutoffCheck({...per,entryId:'period',check:c});
    if(mode==='check')a.checkEdits[key]=c;
    if(mode==='count')a.tinEdits[key]='10006';
    if(mode==='paper'){c.paper=20000;a.applyLocalCutoffCheck({...per,entryId:'period',check:c});}
    if(mode.startsWith('rejected'))a.attention.push({kind:'rejected',action:mode==='rejected-count'?'saveTinCount':'saveCutoffSplit',payload:{...per}});
    if(mode==='legacy-day')a.attention.push({kind:'gcash',action:'saveDay',date:per.start,payload:{date:per.start}});
    assert.doesNotMatch(a.cutoffCashHTML(per,f),/Cash balances against/,mode);
  }
});
test('changed source figures require review and do not inherit a settled status on a new cutoff',()=>{
  const {a,f}=fixture();f.salary+=200;
  assert(a.cutoffCashCheck(per,f).issues.some(s=>s.includes('Source figures changed')));
  assert.equal(a.cutoffCheckSaved({start:'2026-10-01',end:'2026-10-15'}).statuses.salary,'unknown');
});
function server(){
  const ss=new FakeSpreadsheet(),ctx=makeContext(ss);vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root,'apps-script/Code.gs'),'utf8'),ctx);
  const token=ctx.setupSheet();
  const post=(action,payload)=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify({token,action,payload})}}).getContent());
  return {ss,ctx,post};
}
test('backend persists checklist idempotently and never creates expenses or rewrites allocations',()=>{
  const {ss,ctx,post}=server();
  assert(post('saveCutoffSplit',{...per,entryId:'period',amount:6000}).ok);
  assert(post('saveTinCount',{...per,entryId:'period',counted:10006}).ok);
  const before=ss.getSheetByName('Expenses').getDataRange().getValues();
  const noteBefore=post('cutoff',{...per,dryRun:true}).data;
  const p={...per,entryId:'period',check:confirmed()};
  assert(post('saveCutoffCheck',p).ok);assert(post('saveCutoffCheck',p).ok);
  const rows=ctx.readCutoffInputs(ss);assert.equal(rows.length,1);
  assert.equal(rows[0].split_amount,6000);assert.equal(Number(rows[0].tin_counted),10006);
  assert.equal(JSON.parse(rows[0].reconciliation_json).borrowed,4620);
  assert.deepEqual(ss.getSheetByName('Expenses').getDataRange().getValues(),before);
  assert.deepEqual(post('cutoff',{...per,dryRun:true}).data,noteBefore);
  assert(post('saveCutoffSplit',{...per,entryId:'period',amount:5500}).ok);
  assert(post('saveTinCount',{...per,entryId:'period',counted:10000}).ok);
  assert.equal(JSON.parse(ctx.readCutoffInputs(ss)[0].reconciliation_json).borrowed,4620);
  const a=app();a.state.cutoffInputs[key]=a.normCutoffInput(JSON.parse(JSON.stringify(ctx.readCutoffInputs(ss)[0])));
  assert.equal(a.cutoffCheckSaved(per).paper,23502);
});
test('backend rejects invalid money/status or contradictory pending cash without writing',()=>{
  const {ctx,ss,post}=server();
  for(const raw of ['abc',-1,'Infinity',true,{},1e12]){
    const check=confirmed();check.borrowed=raw;
    assert.equal(post('saveCutoffCheck',{...per,entryId:'period',check}).ok,false,String(raw));
  }
  let check=confirmed();check.statuses.salary='done';assert.equal(post('saveCutoffCheck',{...per,entryId:'period',check}).ok,false);
  check=confirmed();check.tin.mama=500;assert.equal(post('saveCutoffCheck',{...per,entryId:'period',check}).ok,false);
  assert.equal(ctx.readCutoffInputs(ss).length,0);
});
test('first checklist preserves default split and blank counted cash, not a zero cash count',()=>{
  const {ctx,ss,post}=server();assert(post('saveCutoffCheck',{...per,entryId:'period',check:confirmed()}).ok);
  const row=ctx.readCutoffInputs(ss)[0];assert.equal(row.split_amount,ctx.splitDefaultOf(ctx.readSettings(ss)));
  assert.equal(row.tin_counted,'');
});
console.log(`${passed} cutoff checklist checks passed.`);
