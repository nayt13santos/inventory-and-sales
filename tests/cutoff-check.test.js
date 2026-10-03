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
      applyLocalCutoffCheck,applyLocalTinCount,applyLocalCutoffSplit,normCutoffInput,splitFor,cashLinesHTML,mirrorRecordedSplit,
      sanitizeState,sanitizeQueue,reapplyQueue,computeCutoff,buildNote,
      cutoffMoneyFlow,cutoffMoneyFlowHTML,cutoffUnknownSource,gcashCutoffHTML,splitEdits};
  `)();
}
const per={start:'2026-09-16',end:'2026-09-30'}, key=per.start+'_'+per.end;
function confirmed() {
  return {version:1,statuses:{minor:'paid',salary:'paid',mama:'pending',electric:'pending',split:'pending',major:'pending'},
    tin:{minor:7276,salary:2800,mama:'',electric:'',split:'',major:''},
    opening:0,paper:23502,paperSalary:1200,basis:''};
}
function fixture() {
  const a=app();
  Object.assign(a.state.expenses,{
    minor:{entry_id:'minor',date:per.end,category:'Supplies',amount:7276,paid_from:'tin'},
    other:{entry_id:'gcash',date:per.end,category:'Other',amount:396,paid_from:'gcash'},
    mama:{entry_id:'mama',date:per.end,category:'Mama',amount:500,paid_from:'tin'},
    electric:{entry_id:'electric',date:per.end,category:'Electric',amount:500,paid_from:'tin'}
  });
  a.state.cutoffInputs[key]={...per,split_amount:6000,tin_counted:14626,entry_id:'period'};
  const f={total:28405,cash:24602,gcash:3803,excluded:100,salary:2800,split:6000,mama:500,electric:500,
    suppliesMinor:7672,suppliesUsed:6830,backlogPaid:0,tinOut:8276,tinUnknown:0,remaining:4103,
    excludedLines:[{sku:'nori',label:'Nori',qty:4,amount:100}]};
  const c=confirmed(); c.basis=a.cutoffCheckBasis(per,f);
  a.applyLocalCutoffCheck({...per,entryId:'period',check:c});
  return {a,f,c};
}
let passed=0;
function test(name,fn){fn();passed++;console.log('  PASS  '+name);}
function reconciledFixture(){
  const x=fixture();
  x.a.state.expenses.mama.paid_from='';x.a.state.expenses.electric.paid_from='';
  x.f.tinOut=7276;x.f.tinUnknown=1000;
  x.save=()=>{x.c.basis=x.a.cutoffCheckBasis(per,x.f);x.a.applyLocalCutoffCheck({...per,entryId:'period',check:x.c});};
  x.save();return x;
}
test('running balance combines cash and GCash once, then reserves nori and unpaid allocations',()=>{
  const {a,f}=reconciledFixture(),flow=a.cutoffMoneyFlow(per,f);
  assert.deepEqual(flow.issues,[]);
  for(const [field,value] of Object.entries({receipts:28505,totalPaid:10472,cashLeft:14626,gcashLeft:3407,
    left:18033,reserved:100,available:17933,due:13830,remaining:4103})) assert.equal(flow[field],value,field);
  assert.deepEqual(flow.paidLines.map(l=>[l.key,l.amount]),[['minor',7672],['salary',2800]]);
  assert.deepEqual(flow.dueLines.map(l=>[l.key,l.amount]),[['mama',500],['electric',500],['split',6000],['major',6830]]);
  const h=a.cutoffMoneyFlowHTML(per,f);
  let at=-1;
  for(const label of ['Total received','Already left the money','Money left now','Still to deduct','Remaining after deductions']){
    const next=h.indexOf(label);assert(next>at,label);at=next;
  }
  assert.match(h,/₱4,103/);assert.match(h,/Cash matches your saved count/);assert.doesNotMatch(h,/<input|<select|Needs checking/);
  assert.equal(a.cutoffUnknownSource(per),0,'confirmed unpaid rows are not missing payments');
  assert.doesNotMatch(a.cutoffCashHTML(per,f),/no payment source/);
  assert.doesNotMatch(a.gcashCutoffHTML(f,per),/no source recorded/);
});
test('partly or fully paying the split moves money between the two sections without double deduction',()=>{
  for(const paid of [1000,6000]){
    const {a,f,c,save}=reconciledFixture();c.statuses.split=paid===6000?'paid':'partial';c.tin.split=paid;
    a.state.cutoffInputs[key].tin_counted=14626-paid;save();
    const flow=a.cutoffMoneyFlow(per,f);
    assert.deepEqual(flow.issues,[]);assert.equal(flow.remaining,4103);
    assert.equal(flow.dueLines.find(l=>l.key==='split')?.amount||0,6000-paid);
  }
});
test('a GCash payment is deducted once; personal payments do not leave the business money',()=>{
  for(const source of ['gcash','own']){
    const {a,f,c,save}=reconciledFixture();a.state.expenses.mama.paid_from=source;c.statuses.mama='paid';c.tin.mama=0;save();
    const flow=a.cutoffMoneyFlow(per,f);
    assert.deepEqual(flow.issues,[]);assert.equal(flow.due,13330);
    assert.equal(flow.gcashLeft,source==='gcash'?2907:3407);
    assert.equal(flow.remaining,source==='gcash'?4103:4603);
    if(source==='own')assert.match(a.cutoffMoneyFlowHTML(per,f),/no reimbursement is assumed/);
  }
});
test('unconfirmed or conflicting money never claims a usable final balance',()=>{
  for(const mode of ['unknown-source','pending-tin','pending-gcash','unknown-status','partial-blank','partial-over',
    'unpriced','count-gap','opening-blank','stale','partial-supplier']){
    const {a,f,c,save}=reconciledFixture();
    if(mode==='unknown-source')a.state.expenses.other.paid_from='';
    if(mode==='pending-tin')a.state.expenses.mama.paid_from='tin';
    if(mode==='pending-gcash')a.state.expenses.mama.paid_from='gcash';
    if(mode==='unknown-status')c.statuses.salary='unknown';
    if(mode==='partial-blank'){c.statuses.split='partial';c.tin.split='';}
    if(mode==='partial-over'){c.statuses.split='partial';c.tin.split=6001;}
    if(mode==='unpriced')f.suppliesUsedUnpriced=['flour'];
    if(mode==='count-gap')a.state.cutoffInputs[key].tin_counted=10006;
    if(mode==='opening-blank')c.opening='';
    if(mode==='partial-supplier'){
      c.statuses.major='partial';c.tin.major=100;
      a.state.expenses.backlog={entry_id:'backlog',date:per.end,category:'Backlog',amount:100,paid_from:'tin'};
      a.state.cutoffInputs[key].tin_counted=14526;
    }
    save();if(mode==='stale')f.salary+=200;
    assert.equal(a.cutoffMoneyFlow(per,f).remaining,null,mode);
    assert.match(a.cutoffMoneyFlowHTML(per,f),/Needs checking/,mode);
  }
});
test('unsaved, rejected, or unsynced changes keep the final amount provisional',()=>{
  for(const mode of ['check','count','split','queue','rejected','paper']){
    const {a,f,c,save}=reconciledFixture();
    if(mode==='check')a.checkEdits[key]=c;
    if(mode==='count')a.tinEdits[key]='14626';
    if(mode==='split')a.splitEdits[key]='5000';
    if(mode==='queue')a.queue.push({action:'saveExpense',payload:{date:per.end}});
    if(mode==='rejected')a.attention.push({action:'saveTinCount',payload:{...per}});
    if(mode==='paper'){c.paper=20000;save();}
    assert.match(a.cutoffMoneyFlowHTML(per,f),/Remaining after deductions<\/span><span class="money-value unknown">Needs checking/,mode);
  }
});
test('opening cash stays available, a missing count is estimated, and a negative balance is a shortfall',()=>{
  const {a,f,c,save}=reconciledFixture();c.opening=200;a.state.cutoffInputs[key].tin_counted=14826;save();
  assert.equal(a.cutoffMoneyFlow(per,f).remaining,4303);
  assert.match(a.cutoffMoneyFlowHTML(per,f),/Starting total/);
  a.state.cutoffInputs[key].tin_counted='';
  assert.match(a.cutoffMoneyFlowHTML(per,f),/Count the cash below/);
  f.split=20000;save();assert.equal(a.cutoffMoneyFlow(per,f).remaining,-9697);
  assert.match(a.cutoffMoneyFlowHTML(per,f),/Shortfall after deductions/);
});
test('Sept paper and cash reconcile without re-deducting paid wages/minor or pending items',()=>{
  const {a,f,c}=fixture(),r=a.cutoffCashCheck(per,f,c);
  assert.equal(r.expected,14626); assert.equal(r.paid,10076);
  assert.equal(r.comparable,23502); assert.equal(r.paperDifference,0);
  assert.equal(r.difference,0); assert.equal(r.complete,true);
  assert.equal(r.conflicts.length,2,'Mama/electric remain inconsistent with Expenses');
  assert.doesNotMatch(a.cutoffCashHTML(per,f),/Cash balances against/);
});
test('the cash remaining is listed line by line, in the open, with where each figure came from (v2.26.1)',()=>{
  // Owner: "i need to see the cash remaining in the breakdown, list everything."
  const {a,f,c}=fixture(),r=a.cutoffCashCheck(per,f,c);
  assert.deepEqual(r.lines.map(l=>[l.key,l.cash,l.source]),[
    ['minor',7276,'confirmed'],['salary',2800,'confirmed'],['mama',0,'pending'],
    ['electric',0,'pending'],['split',0,'pending'],['major',0,'pending']],
    'every category on its own line: confirmed figures, and still-to-pay at nothing');
  assert.equal(r.opening,0);
  assert.equal(r.lines.reduce((s,l)=>s+l.cash,0),r.paid,'the lines add up to exactly what the arithmetic subtracts');
  const h=a.cutoffCashHTML(per,f);
  assert.match(h,/Cash remaining, line by line/);
  assert.doesNotMatch(h,/How the cash balance is worked out/,'no longer folded away');
  assert.doesNotMatch(h,/Actually paid from tin/,'no lump sum');
  for (const s of ['Takoyaki cash received','Nori cash','Cash already in tin at start','Supplies \\(minor\\)','Salary',
    'Mama \\(still to pay\\)','Electric bill \\(still to pay\\)','Split \\(still to pay\\)','Supplies \\(major\\) \\(still to pay\\)',
    'Cash remaining \\(expected in tin\\)']) assert.match(h,new RegExp(s),s);
  assert.doesNotMatch(h,/Borrowed/,'v2.28.0: borrowing is gone from the list');
  assert.match(h,/Cash remaining \(expected in tin\)<\/span><span class="v">₱14,626/,'and the list ends where the paper does');
  // Once Mama is marked paid with the cash box left blank, the line carries the
  // Expenses figure and says so; a status nobody set reads as "not checked".
  const c2=confirmed(); c2.statuses.mama='paid'; c2.statuses.electric='unknown'; c2.basis=a.cutoffCheckBasis(per,f);
  const r2=a.cutoffCashCheck(per,f,c2);
  assert.deepEqual(r2.lines.find(l=>l.key==='mama'),{key:'mama',label:'Mama',status:'paid',cash:500,source:'expenses'});
  assert.deepEqual(r2.lines.find(l=>l.key==='electric'),{key:'electric',label:'Electric bill',status:'unknown',cash:500,source:'unknown'});
  assert.equal(r2.expected,13626,'and the cash remaining moves by exactly those lines');
  a.applyLocalCutoffCheck({...per,entryId:'period',check:c2});
  const h2=a.cutoffCashHTML(per,f);
  assert.match(h2,/Mama \(from Expenses\)<\/span><span class="v">−₱500/);
  assert.match(h2,/Electric bill \(not checked\)<\/span><span class="v">−₱500/);
  assert.match(h2,/Cash remaining \(expected in tin\)<\/span><span class="v">₱13,626/);
});
test('the incorrect Sept18 nori record still surfaces as a 275 difference, never hidden',()=>{
  const {a,f,c}=fixture(); f.excluded=375;
  const r=a.cutoffCashCheck(per,f,c);
  assert.equal(r.expected,14901);assert.equal(r.difference,-275);assert.equal(r.paperDifference,275);
  assert(r.issues.some(s=>s.includes('Source figures changed')));
});
test('category cash totals replace recorded cash; GCash is not deducted from tin',()=>{
  const {a,f,c}=fixture(); c.tin.minor=7000;
  const r=a.cutoffCashCheck(per,f,c);
  assert.equal(r.paid,9800);assert.equal(r.expected,14902);
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
  assert.equal(a.cutoffCashCheck(per,f,c).expected,13626);
  c.statuses.split='pending';
  assert(a.cutoffCashCheck(per,f,c).issues.some(s=>s.includes('still to pay conflicts')));
});
test('payment groups state cost-versus-cash meaning and keep remaining out of checklist',()=>{
  const {a,f}=fixture(),h=a.cutoffPaymentHTML(per,f);
  assert.match(h,/Already deducted/);assert.match(h,/Still to pay/);
  assert.match(h,/Value of stock consumed/);assert.match(h,/Includes purchases paid through GCash/);
  assert.doesNotMatch(h,/>Remaining</);
  assert.match(a.cutoffCheckFormHTML(per),/Paper cash-sales total/);assert.doesNotMatch(a.cutoffCheckFormHTML(per),/Borrowed/,"v2.28.0: no borrowing field");
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
  assert.equal(a.cutoffCashCheck(per,f).difference,-4626,"10,000 counted against 14,626 expected (v2.28.0: no borrowing term)");
});
test('saved offline check survives queue normalisation and replays after refresh',()=>{
  const {a,c}=fixture(),payload={...per,entryId:'period',check:c};
  const q=a.sanitizeQueue([{action:'saveCutoffCheck',payload}]);assert.equal(q.length,1);
  a.queue.push(q[0]);delete a.state.cutoffInputs[key];a.reapplyQueue();
  assert.equal(a.cutoffCheckSaved(per).paper,23502);
});
test('unsaved checks/counts, paper mismatch and rejected period entries cannot claim cleared',()=>{
  for(const mode of ['check','count','paper','rejected-count','rejected-split','legacy-day']){
    const {a,f,c}=fixture();delete a.state.expenses.mama;delete a.state.expenses.electric;
    c.basis=a.cutoffCheckBasis(per,f);a.applyLocalCutoffCheck({...per,entryId:'period',check:c});
    if(mode==='check')a.checkEdits[key]=c;
    if(mode==='count')a.tinEdits[key]='14626';
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
  assert.equal(JSON.parse(rows[0].reconciliation_json).paper,23502);
  assert.deepEqual(ss.getSheetByName('Expenses').getDataRange().getValues(),before);
  assert.deepEqual(post('cutoff',{...per,dryRun:true}).data,noteBefore);
  assert(post('saveCutoffSplit',{...per,entryId:'period',amount:5500}).ok);
  assert(post('saveTinCount',{...per,entryId:'period',counted:10000}).ok);
  assert.equal(JSON.parse(ctx.readCutoffInputs(ss)[0].reconciliation_json).paper,23502);
  const a=app();a.state.cutoffInputs[key]=a.normCutoffInput(JSON.parse(JSON.stringify(ctx.readCutoffInputs(ss)[0])));
  assert.equal(a.cutoffCheckSaved(per).paper,23502);
});
test('backend rejects invalid money/status or contradictory pending cash without writing',()=>{
  const {ctx,ss,post}=server();
  for(const raw of ['abc',-1,'Infinity',true,{},1e12]){
    const check=confirmed();check.opening=raw;
    assert.equal(post('saveCutoffCheck',{...per,entryId:'period',check}).ok,false,String(raw));
  }
  let check=confirmed();check.statuses.salary='done';assert.equal(post('saveCutoffCheck',{...per,entryId:'period',check}).ok,false);
  check=confirmed();check.tin.mama=500;assert.equal(post('saveCutoffCheck',{...per,entryId:'period',check}).ok,false);
  assert.equal(ctx.readCutoffInputs(ss).length,0);
});
test('a checklist or a tin count alone writes NO split: the usual amount, or the archived one, still rules (v2.28.0)',()=>{
  // v2.26.0 review: the first checklist on a cutoff stamped TODAY'S default
  // split into the row, which then outranked the archived split of a note
  // already sent; and a tin-count-only row read its blank split as ₱0.
  let {ctx,ss,post}=server();
  assert(post('saveCutoffCheck',{...per,entryId:'period',check:confirmed()}).ok);
  let row=ctx.readCutoffInputs(ss)[0];
  assert.equal(row.split_amount,'','nothing invented');assert.equal(row.tin_counted,'');
  let cut=post('cutoff',{...per,dryRun:true}).data;
  assert.equal(cut.figures.split,ctx.splitDefaultOf(ctx.readSettings(ss)),'the usual amount still rules');
  assert.match(cut.note_text,/Split - 3,000\(1,500 each\)/);
  // A tin count alone: the same — never "Split - ".
  ({ctx,ss,post}=server());
  assert(post('saveTinCount',{...per,entryId:'period',counted:14626}).ok);
  cut=post('cutoff',{...per,dryRun:true}).data;
  assert.equal(cut.figures.split,3000);assert.match(cut.note_text,/Split - 3,000\(1,500 each\)/);
  // An ARCHIVED split outranks the default even after its row is gone and a
  // checklist is saved: the note already sent does not move.
  ({ctx,ss,post}=server());
  assert(post('saveCutoffSplit',{...per,entryId:'period',amount:4000}).ok);
  assert(post('cutoff',{...per,dryRun:false}).ok);
  const ci=ss.getSheetByName('CutoffInputs');ci.deleteRow(2);
  assert.equal(ctx.readCutoffInputs(ss).length,0,'precondition: the row is gone, the archive remains');
  assert.equal(post('cutoff',{...per,dryRun:true}).data.figures.split,4000);
  assert(post('saveCutoffCheck',{...per,entryId:'period',check:confirmed()}).ok);
  cut=post('cutoff',{...per,dryRun:true}).data;
  assert.equal(cut.figures.split,4000,'the archived split still rules after the checklist');
  assert.match(cut.note_text,/Split - 4,000\(2,000 each\)/);
  // And the phone reads a blank split the same way.
  const a=app();a.state.cutoffInputs[key]=a.normCutoffInput({...per,split_amount:'',tin_counted:'',reconciliation_json:'',entry_id:'period'});
  // STRICT on purpose: assert.equal would let a coerced 0 through (0 == '').
  assert.strictEqual(a.state.cutoffInputs[key].split_amount,'','kept blank, not 0');
  assert.deepEqual(a.splitFor(per),{amount:3000,entered:false},'and the usual amount rules on the phone too');
  // The first checklist on a cutoff with no row leaves the split ABSENT — the
  // phone does not invent today's default where the server writes none.
  const b=app();b.applyLocalCutoffCheck({...per,entryId:'period',check:confirmed()});
  assert.strictEqual(b.state.cutoffInputs[key].split_amount,undefined,'no split written by the checklist');
  assert.deepEqual(b.splitFor(per),{amount:3000,entered:false});
  b.applyLocalCutoffSplit({...per,entryId:'period',amount:4000});
  assert.deepEqual(b.splitFor(per),{amount:4000,entered:true},'only the Split field itself enters one');
});
test('a real generation records the split it used on a blank-split row too, and the phone mirrors it (v2.28.0)',()=>{
  // v2.28.0 review: the server stamped the split only when NO row existed, so a
  // row a tin count or a checklist created kept a blank split for ever — the
  // sheet then read the archive while the phone, which has no archive, read
  // the Settings default; a later split_default edit moved the two apart.
  let {ctx,ss,post}=server();
  assert(post('saveTinCount',{...per,entryId:'period',counted:14626}).ok);
  assert.strictEqual(ctx.readCutoffInputs(ss)[0].split_amount,'','precondition: blank split');
  assert(post('cutoff',{...per,dryRun:false}).ok);
  let rows=ctx.readCutoffInputs(ss);assert.equal(rows.length,1,'the same row, not a second one');
  assert.strictEqual(rows[0].split_amount,3000,'the split the note was built with is now a fact in the sheet');
  assert.equal(Number(rows[0].tin_counted),14626,'the count survives');assert.equal(rows[0].entry_id,'period','so does the entry_id');
  assert(post('saveSettings',{settings:{split_default:3500}}).ok);
  let cut=post('cutoff',{...per,dryRun:true}).data;
  assert.strictEqual(cut.figures.split,3000,'a later default edit cannot move a note already sent');
  assert.match(cut.note_text,/Split - 3,000\(1,500 each\)/);
  const a=app();a.state.cutoffInputs[key]=a.normCutoffInput(JSON.parse(JSON.stringify(rows[0])));
  assert.deepEqual(a.splitFor(per),{amount:3000,entered:true},'and the phone reads the recorded figure after its next bootstrap');
  // Until that bootstrap, the phone mirrors the figure from the cutoff reply.
  const b=app();b.mirrorRecordedSplit(per,{figures:{split:3000,per_partner:1500},note_text:'x'});
  assert.deepEqual(b.splitFor(per),{amount:3000,entered:true},'mirrored on a phone with no row');
  assert.equal(b.queue.length,0,'not queued: the sheet already has it');
  const c=app();c.applyLocalTinCount({...per,entryId:'period',counted:14626});c.mirrorRecordedSplit(per,{figures:{split:3000}});
  assert.deepEqual(c.splitFor(per),{amount:3000,entered:true});assert.equal(c.state.cutoffInputs[key].tin_counted,14626,'merged over the count');
  assert.equal(c.state.cutoffInputs[key].entry_id,'period');
  const d=app();d.applyLocalCutoffSplit({...per,entryId:'period',amount:5000});d.mirrorRecordedSplit(per,{figures:{split:3000}});
  assert.deepEqual(d.splitFor(per),{amount:5000,entered:true},'an entered split is never touched');
  const e=app();for(const bad of [{},{figures:{}},{figures:{split:'abc'}},{figures:{split:-1}},null]) e.mirrorRecordedSplit(per,bad);
  assert.strictEqual(e.state.cutoffInputs[key],undefined,'nothing invented from a reply without a figure');
  assert.match(html,/mirrorRecordedSplit\(per, data\);\s*persistState\(\);\s*lastNote = \{ key:periodKey\(per\)/,'the generation handler mirrors before it keeps the note');
  // The archived case: the recorded figure is the archive's, not the default.
  ({ctx,ss,post}=server());
  assert(post('saveCutoffSplit',{...per,entryId:'period',amount:4000}).ok);assert(post('cutoff',{...per,dryRun:false}).ok);
  ss.getSheetByName('CutoffInputs').deleteRow(2);
  assert(post('saveCutoffCheck',{...per,entryId:'period',check:confirmed()}).ok);
  assert.strictEqual(ctx.readCutoffInputs(ss)[0].split_amount,'');
  assert(post('cutoff',{...per,dryRun:false}).ok);
  rows=ctx.readCutoffInputs(ss);assert.equal(rows.length,1);
  assert.strictEqual(rows[0].split_amount,4000,'the archived split, recorded on the checklist\'s row');
  assert.equal(JSON.parse(rows[0].reconciliation_json).paper,23502,'the checklist survives');
});
test('borrowing is gone: a stored borrowed figure changes nothing, and the kept-out line is named from the data (v2.28.0)',()=>{
  // Owner: "lets not input borrowed anymore, its paid every cutoff anyway" →
  // "not optional, remove it at all". A loan from the tin is back before the
  // count, so the tin is compared whole: an older checklist's borrowed key is
  // ignored, never subtracted, and the form, the list and the save carry no
  // such field.
  const {a,f,c}=fixture(); c.borrowed=4620;
  const r=a.cutoffCashCheck(per,f,c);
  assert.strictEqual(r.expected,14626,'opening 0 + cash 24,602 + nori 100 − minor 7,276 − salary 2,800; no borrowed term');
  assert.strictEqual(r.difference,0);
  assert(!('borrowed' in r),'nothing about borrowing comes back');
  assert.doesNotMatch(a.cutoffCheckFormHTML(per),/[Bb]orrow/,'no field on the form');
  assert.doesNotMatch(a.cutoffCashHTML(per,f),/[Bb]orrow/,'no line on the card');
  assert(!('borrowed' in a.cutoffCheckSaved(per)),'and the saved shape has no such key');
  // The kept-out line names whatever sold outside the total — never "Nori" by
  // habit: the price list may call it something else, or keep out more skus.
  const g={...f,excludedLines:[{sku:'nori',label:'Seaweed snack',qty:4,amount:100}]};
  assert.match(a.cashLinesHTML(g,r),/Seaweed snack cash<\/span><span class="v">\+₱100/);
  a.state.prices=[{sku:'box6',label:'Box of 6',in_cutoff:true},{sku:'nori',label:'Nori sheet',in_cutoff:false},{sku:'drink',label:'Drink',in_cutoff:false}];
  assert.match(a.cashLinesHTML({...f,excludedLines:[]},r),/Nori sheet, Drink cash<\/span><span class="v">\+₱100/,'with nothing sold, every kept-out sku on the price list');
  assert.match(a.cashLinesHTML({...f,excludedLines:[],excluded:0},{...r,expected:14526}),/Nori sheet, Drink cash<\/span><span class="v">—/);
});
console.log(`${passed} cutoff checklist checks passed.`);
