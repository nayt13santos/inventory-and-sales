'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),crypto=require('crypto');
const {FakeSpreadsheet,makeContext}=require('./gas-stubs');
const root=path.resolve(__dirname,'..');
const endpoint='https://fcm.googleapis.com/fcm/send/test-device',readToken='a'.repeat(64);
let passed=0;
function test(name,fn){fn();passed++;console.log('  PASS  '+name);}
test('the deployed manifest requests only existing Sheets access and notification delivery',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'apps-script/appsscript.json'),'utf8'));
  assert.deepEqual(manifest.oauthScopes.slice().sort(),[
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/spreadsheets'
  ]);
});
function app(){
  const ss=new FakeSpreadsheet(),ctx=makeContext(ss);vm.createContext(ctx);
  for(const f of ['PushCrypto.gs','Push.gs','Code.gs'])vm.runInContext(fs.readFileSync(path.join(root,'apps-script',f),'utf8'),ctx,{filename:f});
  const token=ctx.setupSheet();
  const call=(action,payload={},auth=token)=>JSON.parse(ctx.doPost({postData:{contents:JSON.stringify({action,payload,token:auth})}}).getContent());
  const privateKey=crypto.createHash('sha256').update('TEST-ONLY Octogo signing key').digest('base64url');
  assert(call('configurePush',{privateKey}).ok);
  ctx.UrlFetchApp._reply(201,'');
  return {ss,ctx,token,privateKey,call};
}
function setup(rows=[{product:'Mayo',unit:'kg',qty:3,level:0}]){
  const a=app();let current=rows;a.ctx.pushStock_=()=>current;
  a.setRows=r=>{current=r;};
  const sub=a.call('savePushSubscription',{endpoint,readToken});assert(sub.ok,sub.error);a.id=sub.data.id;
  a.requests=()=>a.ctx.UrlFetchApp._requests.filter(r=>r.method==='post');
  a.check=()=>a.ctx.pushCheck_(a.ss);
  a.notice=()=>a.call('pushNotice',{id:a.id,readToken},'');
  return a;
}
test('VAPID JWT verifies independently with Node crypto and has the correct audience and expiry',()=>{
  const a=app(),c=a.ctx.pushConfig_(),auth=a.ctx.pushAuthorization_(endpoint,c);
  const jwt=auth.match(/t=([^,]+)/)[1],parts=jwt.split('.');
  const head=JSON.parse(Buffer.from(parts[0],'base64url')),body=JSON.parse(Buffer.from(parts[1],'base64url'));
  assert.equal(head.alg,'ES256');assert.equal(body.aud,'https://fcm.googleapis.com');
  assert.equal(body.exp,Math.floor(a.ctx.Date.now()/1000)+3600);
  const pub=Buffer.from(c.publicKey,'base64url');
  const key=crypto.createPublicKey({key:{kty:'EC',crv:'P-256',x:pub.subarray(1,33).toString('base64url'),y:pub.subarray(33).toString('base64url')},format:'jwk'});
  assert(crypto.verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')));
  assert.equal(auth,a.ctx.pushAuthorization_(endpoint,c),'deterministic signature needs no runtime random source');
});
test('setup retries preserve the signing key and do not expose private keys',()=>{
  const a=app(),before=a.ctx.pushConfig_();
  const answer=a.call('configurePush',{privateKey:'x'.repeat(43)});
  assert(answer.ok);assert.equal(a.ctx.pushConfig_().privateKey,before.privateKey);
  assert(!JSON.stringify(a.call('pushConfig')).includes(a.privateKey));
});
test('only approved HTTPS push endpoints can receive outbound requests',()=>{
  const a=app();
  for(const url of ['http://fcm.googleapis.com/fcm/send/a','https://fcm.googleapis.com.evil.test/fcm/send/a','https://user@fcm.googleapis.com/fcm/send/a','https://127.0.0.1/x','https://fcm.googleapis.com:443/fcm/send/a','https://fcm.googleapis.com/other','https://evil.test/x','https://web.push.apple.com/x#fragment'])
    assert.equal(a.call('savePushSubscription',{endpoint:url,readToken}).ok,false,url);
  for(const url of [endpoint,'https://fcm.googleapis.com/wp/a','https://web.push.apple.com/abc','https://updates.push.services.mozilla.com/wpush/v2/a'])assert.equal(a.ctx.pushEndpoint_(url).url,url);
});
test('subscription setup does not rewrite business data or immediately spam existing low stock',()=>{
  const a=setup([{product:'Mayo',unit:'kg',qty:1,level:1}]);
  const before=JSON.stringify(a.ss);a.check();
  assert.equal(a.requests().length,0);assert.equal(JSON.stringify(a.ss),before);
  assert.equal(a.call('pushConfig',{id:a.id,readToken}).data.registered,true);
});
test('low threshold sends once, out-of-stock escalates, restocking re-arms',()=>{
  const a=setup();
  a.setRows([{product:'Mayo',unit:'kg',qty:1,level:1}]);a.check();a.check();
  assert.equal(a.requests().length,1);assert.match(a.notice().data.body,/1 kg remaining/);
  a.setRows([{product:'Mayo',unit:'kg',qty:0,level:2}]);a.check();a.check();
  assert.equal(a.requests().length,2);assert.match(a.notice().data.body,/out of stock/);
  a.setRows([{product:'Mayo',unit:'kg',qty:1,level:1}]);a.check();assert.equal(a.requests().length,2,'partial refill below threshold stays quiet');
  a.setRows([{product:'Mayo',unit:'kg',qty:4,level:0}]);a.check();
  a.setRows([{product:'Mayo',unit:'kg',qty:1,level:1}]);a.check();assert.equal(a.requests().length,3);
});
test('several low items are grouped in one alert per opted-in device',()=>{
  const a=setup();assert(a.call('savePushSubscription',{endpoint:'https://web.push.apple.com/second',readToken:'b'.repeat(64)}).ok);
  a.setRows([{product:'Mayo',unit:'kg',qty:1,level:1},{product:'Sauce',unit:'gallon',qty:0,level:2}]);a.check();
  assert.equal(a.requests().length,2);assert.match(a.notice().data.body,/Mayo.*Sauce/);
  const sent=a.requests()[0];assert.equal(sent.payload,'');assert.equal(sent.headers.TTL,'3600');
  assert(!JSON.stringify(sent).includes(a.token));assert(!JSON.stringify(sent).includes(readToken));
});
test('notice access is device-specific and cannot authorize financial reads or writes',()=>{
  const a=setup();
  assert.equal(a.call('pushNotice',{id:a.id,readToken:'b'.repeat(64)},'').ok,false);
  assert.equal(a.call('bootstrap',{},readToken).ok,false);
  assert.equal(a.call('saveDay',{date:'2026-08-01'},readToken).ok,false);
  assert.equal(a.call('testPush',{id:a.id,readToken},'').ok,false);
  assert.equal(a.call('removePushSubscription',{id:a.id,readToken:'b'.repeat(64)}).ok,false);
});
test('expired subscriptions are removed; transient failures retain the low transition for retry',()=>{
  for(const code of [404,410,429,503]){
    const a=setup();a.ctx.UrlFetchApp._reply(code,'');a.setRows([{product:'Mayo',unit:'kg',qty:1,level:1}]);a.check();
    const ds=a.ctx.pushDevices_();
    if(code===404||code===410){assert.equal(ds.length,0);continue;}
    assert.equal(ds.length,1);assert.equal(ds[0].record.levels.Mayo,0);
    a.check();assert.equal(a.requests().length,1,'failed send backs off');
    const r=ds[0].record;r.retryAt=0;a.ctx.pushProps_().setProperty(ds[0].key,JSON.stringify(r));
    a.ctx.UrlFetchApp._reply(201,'');a.check();assert.equal(a.requests().length,2);
  }
});
test('a delayed notification reads current stock instead of claiming an item is still out after restocking',()=>{
  const a=setup();a.setRows([{product:'Mayo',unit:'kg',qty:0,level:2}]);a.check();
  a.setRows([{product:'Mayo',unit:'kg',qty:4,level:0}]);
  assert.doesNotMatch(a.notice().data.body,/out of stock/);assert.match(a.notice().data.title,/updated/);
});
test('negative stock asks for a count, unknown stock never claims an empty shelf',()=>{
  const a=app();assert(a.ctx.pushStock_(a.ss).every(s=>s.level===0));
  const b=setup();b.setRows([{product:'Mayo',unit:'kg',qty:-2,level:2}]);b.check();
  assert.match(b.notice().data.body,/count needs checking/);assert.doesNotMatch(b.notice().data.body,/out of stock/);
});
test('real stocktake API sends on threshold transition and notification failures cannot fail a completed save',()=>{
  const a=app();const save=qty=>a.call('saveStockCount',{date:'2026-08-01',product:'Japanese Mayo',qty,entryId:'test-count'});
  assert(save(5).ok);assert(a.call('savePushSubscription',{endpoint,readToken}).ok);
  assert(save(1).ok);assert.equal(a.ctx.UrlFetchApp._requests.filter(r=>r.method==='post').length,1);
  a.ctx.pushCheck_=()=>{throw new Error('Temporary notification problem');};
  assert(save(0).ok);assert.equal(a.ctx.computeStockStatus(a.ss)['Japanese Mayo'].on_hand,0);
});
test('test notification is explicit, rate-limited, and disabling a phone revokes notice access',()=>{
  const a=setup();assert(a.call('testPush',{id:a.id,readToken}).ok);
  assert.match(a.notice().data.title,/working/);
  assert.equal(a.call('testPush',{id:a.id,readToken}).ok,false);
  assert(a.call('removePushSubscription',{id:a.id,readToken}).ok);
  assert.equal(a.notice().ok,false);assert.equal(a.ctx.pushDevices_().length,0);
});
function worker(){
  const cachesByName=new Map(),handlers={},shown=[],requests=[],opened=[];
  const cacheAPI={keys:async()=>[...cachesByName.keys()],delete:async k=>cachesByName.delete(k),open:async name=>{
    if(!cachesByName.has(name))cachesByName.set(name,new Map());const m=cachesByName.get(name);
    return {put:async(k,v)=>m.set(k,v),match:async k=>m.has(k)?m.get(k).clone():undefined};
  }};
  let fail=false;
  const ctx={URL,Response,AbortController,setTimeout,clearTimeout,console,caches:cacheAPI,
    fetch:async(url,opts)=>{requests.push({url,opts});if(fail)throw new Error('Offline');return new Response(JSON.stringify({ok:true,data:{title:'Supplies are getting low',body:'Mayo: 1 kg remaining'}}));},
    self:{addEventListener:(k,fn)=>{handlers[k]=fn;},location:{origin:'https://shop.test'},
      registration:{scope:'https://shop.test/app/',showNotification:async(title,opts)=>shown.push({title,opts})},
      clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async u=>opened.push(u)}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'pwa/sw.js'),'utf8'),ctx);
  const fire=async(type,data={})=>{let promise;handlers[type]({...data,waitUntil:p=>{promise=p;}});if(promise)await promise;};
  return {ctx,shown,requests,opened,cacheAPI,fire,fail:()=>{fail=true;}};
}
async function asyncTest(name,fn){await fn();passed++;console.log('  PASS  '+name);}
(async()=>{
  await asyncTest('worker stores only the read capability and preserves it across app updates',async()=>{
    const w=worker();let ack;
    const data={apiUrl:'https://script.google.com/macros/s/test/exec',id:'a'.repeat(43),readToken,token:'WRITE-TOKEN-MUST-NOT-BE-STORED'};
    await w.fire('message',{data:{type:'stock-alert-settings',data},source:{url:'https://shop.test/app/'},ports:[{postMessage:r=>{ack=r;}}]});
    assert(ack.ok);await w.cacheAPI.open('octogo-shell-old');await w.fire('activate');
    assert((await w.cacheAPI.keys()).includes('octogo-push-settings-v1'));assert(!(await w.cacheAPI.keys()).includes('octogo-shell-old'));
    await w.fire('push');assert.equal(w.shown[0].title,'Supplies are getting low');
    assert(!w.requests[0].opts.body.includes('WRITE-TOKEN'));assert.match(w.requests[0].opts.body,/pushNotice/);
  });
  await asyncTest('worker rejects arbitrary destinations and settings from unrelated pages',async()=>{
    const w=worker();let ack;
    for(const [apiUrl,source] of [['https://evil.test/','https://shop.test/app/'],['https://script.google.com/macros/s/test/exec','https://other.test/']]){
      await w.fire('message',{data:{type:'stock-alert-settings',data:{apiUrl,id:'a'.repeat(43),readToken}},source:{url:source},ports:[{postMessage:r=>{ack=r;}}]});
      assert.equal(ack.ok,false);
    }
    await w.fire('push');assert.equal(w.requests.length,0);assert.equal(w.shown.length,1);
  });
  await asyncTest('offline notice lookup still produces a visible alert and clicking opens the stock route',async()=>{
    const w=worker();
    await w.fire('message',{data:{type:'stock-alert-settings',data:{apiUrl:'https://script.google.com/macros/s/test/exec',id:'a'.repeat(43),readToken}},source:{url:'https://shop.test/app/'}});
    w.fail();await w.fire('push');assert.match(w.shown[0].opts.body,/Open Octogo/);
    let closed=false;await w.fire('notificationclick',{notification:{close:()=>{closed=true;},data:{url:'https://evil.test'}}});
    assert(closed);assert.equal(w.opened[0],'https://shop.test/app/?view=stock');
  });
  await asyncTest('clicking an alert focuses the existing app and sends it to stock',async()=>{
    const w=worker();let focused=false,message;
    w.ctx.self.clients.matchAll=async()=>[{url:'https://shop.test/app/',focus:async()=>{focused=true;},postMessage:m=>{message=m;}}];
    await w.fire('notificationclick',{notification:{close:()=>{}}});assert(focused);assert.equal(message.type,'open-stock');assert.equal(w.opened.length,0);
  });
  console.log(passed+' push server and worker checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
