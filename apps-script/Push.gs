/** Low-stock Web Push (RFC8030/8292).
 * Payloadless pushes wake the worker; its read-only capability fetches the
 * current notice. No financial data or API write token goes to a push service.
 * Only subscription/config metadata is stored in Script Properties.
 */
var PUSH_CONFIG_KEY = 'OCTOGO_PUSH_CONFIG_V1';
var PUSH_DEVICE_PREFIX = 'OCTOGO_PUSH_DEVICE_';
/** Owner can run this once in the editor when Google requests the new scope. */
function authorizeStockNotifications() {
  UrlFetchApp.fetch('https://fcm.googleapis.com/',{muteHttpExceptions:true,followRedirects:false});
  return 'Notification delivery is authorized.';
}
function pushProps_() { return PropertiesService.getScriptProperties(); }
function pushJson_(s, fallback) { try { return JSON.parse(s) || fallback; } catch (_) { return fallback; } }
function pushConfig_() { return pushJson_(pushProps_().getProperty(PUSH_CONFIG_KEY), null); }
function pushPublicConfig_(p) {
  var c = pushConfig_();
  var r=p && /^[A-Za-z0-9_-]{43}$/.test(asStr(p.id)) ? pushJson_(pushProps_().getProperty(pushDeviceKey_(p.id)),null) : null;
  return {ready:!!c, publicKey:c ? c.publicKey : '',registered:!!(r && r.readHash===pushHash_(asStr(p.readToken)))};
}
function pushB64_(bytes) { return Utilities.base64EncodeWebSafe(Array.from(bytes,function(b){return b>127?b-256:b;})).replace(/=+$/, ''); }
function pushBytes_(s) { return new Uint8Array(Utilities.base64DecodeWebSafe(s)); }
function pushHash_(s) { return pushB64_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function pushConfigure_(p) {
  var old = pushConfig_();
  if (old) return pushPublicConfig_(); // Safe retry; never rotate subscribed phones' keys.
  if (!/^[A-Za-z0-9_-]{43}$/.test(asStr(p.privateKey))) throw new Error('Invalid notification key.');
  var key = pushBytes_(p.privateKey), publicKey = pushB64_(OctogoPushCrypto.publicKey(key));
  // Fail setup now if the owner has not yet granted the external-request scope.
  // This fixed URL is only a connectivity/authorization check; no secrets sent.
  UrlFetchApp.fetch('https://fcm.googleapis.com/', {muteHttpExceptions:true, followRedirects:false});
  pushProps_().setProperty(PUSH_CONFIG_KEY, JSON.stringify({privateKey:p.privateKey, publicKey:publicKey}));
  return pushPublicConfig_();
}
function pushEndpoint_(value) {
  var s=asStr(value), m=/^https:\/\/([^\/?#]+)(\/[^#\s]*)$/.exec(s);
  if (!m || s.length > 2048) throw new Error('This notification address is not supported.');
  var host=m[1];
  var allowed=(host==='fcm.googleapis.com' && /^\/(fcm\/send|wp)\//.test(m[2])) ||
    (/^([a-z0-9-]+\.)?push\.apple\.com$/.test(host)) ||
    (host==='updates.push.services.mozilla.com' && /^\/wpush\//.test(m[2]));
  if (!allowed) throw new Error('This browser’s notification service is not supported.');
  return {url:s, origin:'https://'+host};
}
function pushDeviceKey_(id) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(asStr(id))) throw new Error('Notification registration is missing.');
  return PUSH_DEVICE_PREFIX+id;
}
function pushDevices_() {
  var all=pushProps_().getProperties(), out=[];
  Object.keys(all).filter(function(k){return k.indexOf(PUSH_DEVICE_PREFIX)===0;}).forEach(function(k){
    var r=pushJson_(all[k],null); if(r) out.push({key:k,record:r});
  });
  return out;
}
function pushStock_(ss) {
  var items=readStockItems(ss).list.filter(function(s){return s.active;});
  var status=stockStatusFor(items,ss);
  return items.map(function(item){
    var s=status[item.product];
    // Unknown inventory isn't an empty shelf. Wait for a count or movement.
    var known=!!s.baseline_date || s.delivered_since>0 || s.used_since>0;
    return {product:item.product,unit:item.unit,qty:s.on_hand,level:known?(s.out?2:s.low?1:0):0};
  });
}
function pushLevels_(rows) {
  var out=Object.create(null); rows.forEach(function(r){out[r.product]=r.level;}); return out;
}
function pushSubscribe_(ss,p) {
  if(!pushConfig_()) throw new Error('Notifications are not ready yet. Please try again later.');
  var endpoint=pushEndpoint_(p.endpoint).url;
  if(!/^[a-f0-9]{64}$/.test(asStr(p.readToken))) throw new Error('Invalid notification registration.');
  var id=pushHash_(endpoint), key=pushDeviceKey_(id), props=pushProps_();
  var old=pushJson_(props.getProperty(key),null);
  if(!old && pushDevices_().length>=20) throw new Error('Twenty phones are already registered. Turn alerts off on an unused phone first.');
  var r=old || {endpoint:endpoint,levels:pushLevels_(pushStock_(ss)),lastSent:0};
  r.readHash=pushHash_(p.readToken);r.updatedAt=Date.now();
  props.setProperty(key,JSON.stringify(r));
  return {id:id,enabled:true};
}
function pushRemove_(p) {
  var key=pushDeviceKey_(p.id), r=pushJson_(pushProps_().getProperty(key),null);
  if(r && r.readHash!==pushHash_(asStr(p.readToken))) throw new Error('This phone’s registration could not be confirmed.');
  pushProps_().deleteProperty(key);return {enabled:false};
}
function pushAuthorization_(endpoint,c) {
  var origin=pushEndpoint_(endpoint).origin;
  var enc=function(s){return pushB64_(Utilities.newBlob(s).getBytes());};
  var unsigned=enc(JSON.stringify({typ:'JWT',alg:'ES256'}))+'.'+enc(JSON.stringify({
    aud:origin,exp:Math.floor(Date.now()/1000)+3600,sub:'https://nayt13santos.github.io/inventory-and-sales/'
  }));
  var signature=OctogoPushCrypto.sign(new Uint8Array(Utilities.newBlob(unsigned).getBytes()),pushBytes_(c.privateKey));
  return 'vapid t='+unsigned+'.'+pushB64_(signature)+', k='+c.publicKey;
}
function pushSend_(key,r,c) {
  var props=pushProps_();
  try {
    var response=UrlFetchApp.fetch(pushEndpoint_(r.endpoint).url,{
      method:'post',payload:'',muteHttpExceptions:true,followRedirects:false,
      headers:{Authorization:pushAuthorization_(r.endpoint,c),TTL:'3600',Urgency:'normal',Topic:'octogo-stock'}
    });
    var code=response.getResponseCode();
    if(code===404 || code===410){props.deleteProperty(key);return {sent:false,expired:true};}
    if(code<200 || code>=300) throw new Error('Push service '+code);
    r.lastSent=Date.now();r.retryAt=0;r.lastError='';
    props.setProperty(key,JSON.stringify(r));return {sent:true};
  } catch(err) {
    r.retryAt=Date.now()+300000;r.lastError='Delivery will retry on the next sync.';
    props.setProperty(key,JSON.stringify(r));return {sent:false};
  }
}
function pushCheck_(ss) {
  var c=pushConfig_();if(!c)return;
  var devices=pushDevices_();if(!devices.length)return;
  var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try {
    // Re-read after taking the lock: simultaneous phones must not send twice.
    devices=pushDevices_();var rows=pushStock_(ss), levels=pushLevels_(rows), props=pushProps_();
    devices.forEach(function(device){
      var r=device.record, prior=r.levels || {}, changed=rows.filter(function(s){return s.level>0 && s.level>Number(prior[s.product]||0);});
      // Recovery re-arms the alert, even while a previous send is retrying.
      Object.keys(prior).forEach(function(p){if(!levels[p])delete prior[p];});
      r.levels=prior;
      if(!changed.length){props.setProperty(device.key,JSON.stringify(r));return;}
      if(r.retryAt>Date.now()){props.setProperty(device.key,JSON.stringify(r));return;}
      r.notice={products:changed.map(function(s){return s.product;}),at:Date.now(),test:false};
      // Save the notice BEFORE the push can arrive; the worker reads it.
      props.setProperty(device.key,JSON.stringify(r));
      var result=pushSend_(device.key,r,c);
      if(result.sent){r.levels=levels;props.setProperty(device.key,JSON.stringify(r));}
    });
  } finally {lock.releaseLock();}
}
function pushTest_(p) {
  var key=pushDeviceKey_(p.id), props=pushProps_(), r=pushJson_(props.getProperty(key),null), c=pushConfig_();
  if(!r || !c || r.readHash!==pushHash_(asStr(p.readToken))) throw new Error('Turn notifications on again for this phone.');
  if(r.lastTest && Date.now()-r.lastTest<30000) throw new Error('Wait a few seconds before sending another test.');
  r.lastTest=Date.now();r.notice={test:true,at:Date.now()};props.setProperty(key,JSON.stringify(r));
  var result=pushSend_(key,r,c);
  if(!result.sent) throw new Error(result.expired?'This phone’s notification permission expired. Turn alerts on again.':'The test could not be delivered. Try again shortly.');
  return {sent:true};
}
function pushNotice_(p) {
  var r=pushJson_(pushProps_().getProperty(pushDeviceKey_(p.id)),null);
  if(!r || !/^[a-f0-9]{64}$/.test(asStr(p.readToken)) || r.readHash!==pushHash_(p.readToken)) throw new Error('Notification access expired.');
  if(r.notice && r.notice.test && Date.now()-r.notice.at<3600000)
    return {title:'Octogo alerts are working',body:'This phone is ready for low-stock and out-of-stock alerts.'};
  var wanted=r.notice ? r.notice.products || [] : [];
  var rows=pushStock_(SpreadsheetApp.getActive()).filter(function(s){return s.level>0 && wanted.indexOf(s.product)>=0;});
  if(!rows.length) return {title:'Octogo stock updated',body:'Open the app to see the latest supply counts.'};
  return {title:rows.some(function(s){return s.qty<0;})?'Check your stock count':rows.some(function(s){return s.level===2;})?'Supplies need restocking':'Supplies are getting low',
    body:rows.slice(0,5).map(function(s){return s.product+': '+(s.qty<0?'count needs checking':s.qty===0?'out of stock':s.qty+' '+s.unit+' remaining');}).join(' · ').slice(0,400)};
}
