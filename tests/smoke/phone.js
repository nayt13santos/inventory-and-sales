#!/usr/bin/env node
'use strict';
/* ============================================================================
   PHONE-SIZE BROWSER SMOKE TEST for pwa/index.html.

   WHY THIS EXISTS. On 2026-09-03 a sentence landed inside a white-space:nowrap
   span on the Cutoff tab. The document grew wider than the phone, the
   position:fixed 100%-width tab bar grew with it, and the fourth tab was drawn
   off the right edge of the screen. 483 Node tests passed — Node has no layout
   engine — and the owner found it on his phone. This script renders the REAL
   page in headless Chromium at phone size so that class of bug fails CI.

   WHAT IT CHECKS, on each of the four tabs (Sales, Expenses, Cutoff, More), at
   375×812 and 360×740, deviceScaleFactor 2, mobile emulation on, with a
   realistic fixture injected so every screen has content:
     a. no sideways overflow — documentElement.scrollWidth <= the SCREEN width
        (on failure it names every element whose right edge is past the screen)
     b. all four nav.tabbar buttons are on the screen and visible
     c. no console errors and no uncaught page errors
     d. the tab's panel rendered some text
   Expenses and Cutoff are also stepped back one cutoff and re-checked.

   MEASURED AGAINST THE SCREEN, NOT window.innerWidth. On a phone (and under
   mobile emulation) an overflowing document does not just scroll sideways: the
   LAYOUT VIEWPORT grows to fit it, so innerWidth, scrollWidth and a
   position:fixed 100%-width bar all stretch together — the v2.22.1 build
   reports scrollWidth 401 and innerWidth 401 on a 375px screen, and the tab
   bar's right end is 26px off the glass. `scrollWidth <= innerWidth` is true
   in that state. The 375/360 the emulator was told is the only honest ruler.

   RUN
     node tests/smoke/phone.js                    # checks ../../pwa
     PWA_DIR=/path/to/other/pwa node tests/smoke/phone.js
   NEEDS
     puppeteer@25.9.0 — PINNED. Keep the install step in
     .github/workflows/deploy.yml on the same version.
       npm i --no-save puppeteer@25.9.0            (from the repo root)
   It serves PWA_DIR itself, with Node's http module on an ephemeral 127.0.0.1
   port, and shuts the server down when it is done. No python, no dev server.
   The only network the page touches is the Google Fonts stylesheet it links;
   if that cannot be fetched the run says so and measures with the fallback
   font instead of failing, so the test also works offline.
   ============================================================================ */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PUPPETEER_VERSION = '25.9.0';
const PWA_DIR = path.resolve(process.env.PWA_DIR || path.join(__dirname, '..', '..', 'pwa'));
const HARD_TIMEOUT_MS = 120000;

const VIEWPORTS = [
  { w: 375, h: 812, note: 'iPhone-class',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { w: 360, h: 740, note: 'common Android',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36' }
];

// key = the argument showTab() takes; prev = the data-act that steps that
// screen back one cutoff (re-checked after the click).
const TABS = [
  { key: 'benta',  label: 'Sales' },
  { key: 'gastos', label: 'Expenses', prev: 'gastos-prev' },
  { key: 'cutoff', label: 'Cutoff',   prev: 'cutoff-prev' },
  { key: 'ibapa',  label: 'More' }
];

/* ------------------------------------------------------------------------- */
/* A tiny static file server for PWA_DIR.                                     */
/* ------------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
function staticServer(root){
  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (_){ res.writeHead(400); res.end('bad request'); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)){ res.writeHead(403); res.end('forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()){ res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found: ' + pathname); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}
function listen(server){
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/* ------------------------------------------------------------------------- */
/* THE FIXTURE. Runs INSIDE the page (it is stringified by page.evaluate), so   */
/* it can only use the page's own globals and what it defines itself.          */
/*                                                                            */
/* Globals it relies on, all declared at the top level of the page script:     */
/*   functions: todayStr, currentPeriod, shiftPeriod, periodKey,               */
/*              sanitizeState, ensureShape, loadBentaForm, updateStatus        */
/*   `let`s:    state, cutoffPer, gastosPer                                     */
/* Dates are built from the page's own todayStr()/currentPeriod(), so the     */
/* "current cutoff" (1–15 or 16–end) and the previous one both carry data on   */
/* whatever day CI happens to run.                                            */
/* ------------------------------------------------------------------------- */
function injectFixture(){
  'use strict';
  for (const fn of ['todayStr', 'currentPeriod', 'shiftPeriod', 'periodKey', 'sanitizeState', 'ensureShape']){
    if (typeof globalThis[fn] !== 'function') throw new Error('fixture: page global ' + fn + '() is missing');
  }
  if (typeof state !== 'object') throw new Error('fixture: page global `state` is missing');

  const today  = todayStr();
  const cur    = currentPeriod(today);
  const prev   = shiftPeriod(cur, -1);
  const before = shiftPeriod(prev, -1);

  const pad    = n => String(n).padStart(2, '0');
  const dayOf  = ds => Number(ds.slice(8, 10));
  const dateIn = (per, d) => per.start.slice(0, 8) + pad(d);
  // Every date of a period (a period never crosses a month), optionally
  // stopping BEFORE a date — used to keep tonight un-entered.
  const datesOf = (per, stopBefore) => {
    const out = [];
    for (let d = dayOf(per.start); d <= dayOf(per.end); d++){
      const ds = dateIn(per, d);
      if (stopBefore && ds >= stopBefore) break;
      out.push(ds);
    }
    return out;
  };
  const prevDates = datesOf(prev);
  const curDates  = datesOf(cur, today);     // saved nights so far; tonight deliberately NOT entered
  const stamp = ds => ds + 'T21:30:00+08:00';
  let seq = 0;
  const id = tag => 'smoke-' + tag + '-' + (++seq);

  // --- stock picklist, with unit costs (one deliberately blank) --------------
  const stockItems = [
    ['Takoyaki Flour', 'kg',  95.5, 20, 5],
    ['Takoyaki Sauce', 'gal', 780,  3,  1],
    ['Japanese Mayo',  'kg',  210,  6,  2],
    ['Bonito',         'Bag', 320,  4,  1],
    ['Aonori',         'Bag', '',   4,  1],    // no cost on file -> "not priced" branch
    ['Togarashi',      'Bag', 150,  3,  '']    // no reorder point
  ].map(([product, unit, unit_cost, opening_qty, reorder_at], i) => ({
    product, unit, active: true, sort: i + 1,
    opening_qty, opening_date: before.start, reorder_at, unit_cost,
    baseline_qty: opening_qty, baseline_date: before.start,
    delivered_since: 0, used_since: 0, delivered_before: 0, used_before: 0
  }));

  // --- saved days + their per-sku counts -------------------------------------
  // sold = sod − eod (boxes at the start of the night minus boxes left), split
  // into four exclusive buckets that sum to sold, priced from the seed Prices.
  const PRICES = { box4: [50, 60], box6: [65, 80], box10: [105, 125], nori: [25, ''] };
  const SOD    = { box4: 40, box6: 30, box10: 18, nori: 12 };
  const days = {}, counts = {};
  const closedOn = new Set([prevDates[2], prevDates[9]].filter(Boolean));
  let k = 0;
  const saveDay = (ds, closed) => {
    k++;
    if (closed){
      days[ds] = { date: ds, closed: true, staff: 'Mama', salary: 0, gcash: 0, total: 0, cash: 0,
        notes: 'Closed — typhoon signal', entry_id: id('day'), updated_at: stamp(ds) };
      return;
    }
    const rows = [];
    let total = 0, gcash = 0, excluded = 0;
    for (const sku of Object.keys(PRICES)){
      const [price, cheese_price] = PRICES[sku];
      const sod  = SOD[sku];
      const sold = Math.max(1, Math.round(sod * (0.35 + ((k * 7 + sku.length) % 5) * 0.1)));
      const eod  = sod - sold;
      const c  = cheese_price ? Math.min(sold, 1 + (k % 3)) : 0;      // cash, cheese
      const gc = cheese_price ? Math.min(sold - c, k % 2) : 0;        // GCash, cheese
      const g  = Math.min(sold - c - gc, 1 + (k % 3));                // GCash, plain
      const reg = sold - c - gc - g;                                   // cash, plain
      const cp = cheese_price || price;
      const amount = reg * price + c * cp + g * price + gc * cp;
      const gcash_amount = g * price + gc * cp;
      const in_cutoff = sku !== 'nori';
      rows.push({ date: ds, sku, sod, eod, sold, cheese_qty: c, gcash_qty: g, gcash_cheese_qty: gc,
        regular_qty: reg, amount, gcash_amount, price, cheese_price, custom_qty: 0, free_qty: 0,
        entry_id: id('cnt'), in_cutoff });
      if (in_cutoff){ total += amount; gcash += gcash_amount; } else excluded += amount;
    }
    counts[ds] = rows;
    days[ds] = {
      date: ds, closed: false, staff: k % 3 ? 'Mama' : 'Ate Jen',
      salary: k % 5 === 0 ? '' : 200,            // one blank -> falls back to the settings rate
      gcash, total, cash: total - gcash,
      custom_amount: 0, custom_gcash: 0, excluded_total: excluded,
      gcash_converted: k % 4 === 0 ? Math.min(100, gcash) : 0,
      lid_boxes: 2 + (k % 3),
      notes: k % 6 === 0 ? 'Rain in the evening, slow after 8' : '',
      entry_id: id('day'), updated_at: stamp(ds)
    };
  };
  for (const ds of prevDates) saveDay(ds, closedOn.has(ds));
  for (const ds of curDates)  saveDay(ds, false);

  // --- stock usage: some rows with a snapshotted unit_cost, some blank -------
  const stockUsage = {};
  const use = (ds, product, qty, unit_cost) =>
    (stockUsage[ds] = stockUsage[ds] || []).push({ date: ds, product, qty, unit_cost, entry_id: id('use'), updated_at: stamp(ds) });
  [...prevDates, ...curDates].filter(ds => !closedOn.has(ds)).forEach((ds, i) => {
    use(ds, 'Takoyaki Flour', 1.5, 95.5);                 // snapshotted cost
    if (i % 2 === 0) use(ds, 'Takoyaki Sauce', 0.5, '');   // blank -> priced from the cost on file
    if (i % 3 === 0) use(ds, 'Japanese Mayo', 1, 210);
    if (i % 4 === 0) use(ds, 'Bonito', 1, '');             // blank -> cost on file
    if (i % 5 === 0) use(ds, 'Aonori', 1, '');             // blank AND no cost on file -> "not priced"
    if (i % 6 === 1) use(ds, 'Togarashi', 0.5, 150);
  });

  // --- stocktakes: the last night of each earlier cutoff is the next one's ---
  // "at the start" figure, which is exactly the sentence that overflowed.
  const stockCounts = {};
  const count = (ds, product, counted_qty) =>
    (stockCounts[ds] = stockCounts[ds] || []).push({ date: ds, product, counted_qty, entry_id: id('stk'), updated_at: stamp(ds) });
  for (const it of stockItems) count(before.end, it.product, it.opening_qty);
  count(prev.end, 'Takoyaki Flour', 12.5); count(prev.end, 'Takoyaki Sauce', 2);
  count(prev.end, 'Japanese Mayo', 4);     count(prev.end, 'Bonito', 3);
  count(prev.end, 'Aonori', 2);            count(prev.end, 'Togarashi', 1.5);
  if (curDates.length) count(curDates[curDates.length - 1], 'Takoyaki Flour', 9);

  // --- deliveries (whole units arrived, no money) -----------------------------
  const stockDeliveries = {};
  const deliver = (ds, product, qty) =>
    (stockDeliveries[ds] = stockDeliveries[ds] || []).push({ date: ds, product, qty, entry_id: id('dlv'), updated_at: stamp(ds) });
  deliver(prevDates[1], 'Takoyaki Flour', 10); deliver(prevDates[1], 'Takoyaki Sauce', 2);
  deliver(prevDates[6], 'Japanese Mayo', 3);
  deliver(cur.start, 'Takoyaki Flour', 5); deliver(cur.start, 'Bonito', 2); deliver(cur.start, 'Aonori', 2);

  // --- expenses across every category and every paid_from value --------------
  const expenses = {};
  const spend = (ds, category, item, amount, extra) => {
    const e = Object.assign({ date: ds, category, item, amount, backlog_ref: '', notes: '', paid_from: 'tin',
      stock_product: '', stock_qty: 0, entry_id: id('exp'), updated_at: stamp(ds) }, extra || {});
    expenses[e.entry_id] = e;
  };
  const dailyBuying = dates => dates.forEach((ds, i) => {
    if (closedOn.has(ds)) return;
    spend(ds, 'Supplies', 'Eggs', 180 + (i % 3) * 12);
    if (i % 2 === 0) spend(ds, 'Supplies', 'Veggies', 120, { paid_from: 'gcash' });
    if (i % 3 === 0) spend(ds, 'Supplies', 'Box', 300, { paid_from: 'own' });
    if (i % 4 === 1) spend(ds, 'Other', 'Tricycle fare', 60, { paid_from: '' });   // a row from before the column
  });
  dailyBuying(prevDates); dailyBuying(curDates);
  spend(prevDates[0], 'Mama', 'Mama share', 500);
  spend(prevDates[4], 'Octopus', 'Frozen octopus 10kg', 2500, { paid_from: 'gcash' });
  spend(prevDates[5], 'Electric', 'Meralco', 500, { paid_from: 'own' });
  spend(prevDates[7], 'Backlog', 'Octopus supplier — payment', 2000, { backlog_ref: 'Octopus supplier', paid_from: 'gcash' });
  spend(prevDates[8], 'Supplies', 'Togarashi 3 bags', 450, { stock_product: 'Togarashi', stock_qty: 3, notes: 'Paid delivery' });
  const curAnchor = curDates[0] || cur.start;
  spend(curAnchor, 'Mama', 'Mama share', 500);
  spend(curAnchor, 'Octopus', 'Frozen octopus 8kg', 2000, { paid_from: 'gcash' });
  spend(curDates[1] || curAnchor, 'Backlog', 'Octopus supplier — payment', 1500, { backlog_ref: 'Octopus supplier' });

  // --- the previous cutoff's entered split and counted tin --------------------
  const cutoffInputs = {};
  cutoffInputs[periodKey(prev)] = { start: prev.start, end: prev.end, split_amount: 3000, tin_counted: 5400,
    entry_id: id('cut'), updated_at: stamp(prev.end) };

  const backlogs = [{ name: 'Octopus supplier', description: 'Frozen octopus on credit, 20 kg',
    total_amount: 12000, start_date: before.start, active: true }];

  const settings = { branch: 'Tañong', staff: 'Mama, Ate Jen', supply_picklist: 'Veggies, Eggs, Flour, Box' };

  // Through the app's own sanitizer, so the fixture can only ever be a state
  // the app itself would accept from storage or from the sheet.
  state = sanitizeState({ settings, stockItems, backlogs, days, counts, stockUsage, stockCounts,
    stockDeliveries, cutoffInputs, expenses, window_start: '' });
  ensureShape();
  // Both period screens open on the current cutoff again.
  if (typeof cutoffPer !== 'undefined') cutoffPer = null;
  if (typeof gastosPer !== 'undefined') gastosPer = null;
  // The Sales form was built at boot from an empty state — rebuild it.
  if (typeof loadBentaForm === 'function') loadBentaForm(today);
  if (typeof updateStatus === 'function') updateStatus();

  return {
    version: typeof APP_VERSION === 'string' ? APP_VERSION : '?',
    today, current: periodKey(cur), previous: periodKey(prev),
    days: Object.keys(state.days).length,
    expenses: Object.keys(state.expenses).length,
    usageDates: Object.keys(state.stockUsage).length
  };
}

/* ------------------------------------------------------------------------- */
/* THE AUDIT. Also runs inside the page. Returns the list of problems found on  */
/* the screen as it is right now (checks a, b and d; c is gathered in Node).    */
/* ------------------------------------------------------------------------- */
function auditInPage(args){
  'use strict';
  const key = args.key;
  const W = args.width, H = args.height;              // the phone's screen, as the emulator was told
  const iw = window.innerWidth, ih = window.innerHeight;   // the layout viewport — it can GROW (see header)
  const problems = [];
  const describe = el => {
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    const text = ((el.innerText != null ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return '<' + el.tagName.toLowerCase() + (cls ? ' class="' + cls + '"' : '') + '> "' + text + '"';
  };

  // a. No sideways overflow past the screen. On failure, name what sticks out.
  const sw = document.documentElement.scrollWidth;
  if (sw > W || iw > W){
    const offenders = [];
    for (const el of document.querySelectorAll('body, body *')){
      if (el instanceof SVGElement) continue;          // icon internals only ever follow their button
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > W + 1) offenders.push(describe(el) + '  right=' + Math.round(r.right) + 'px');
    }
    problems.push('sideways overflow on a ' + W + 'px screen: documentElement.scrollWidth ' + sw + 'px' +
      (iw > W ? ', and the layout viewport grew to ' + iw + 'px with it — a fixed 100%-width bar stretches to that, so its right end is off the glass' : '') +
      '. ' + offenders.length + ' element(s) reach past the right edge of the screen:' +
      offenders.slice(0, 25).map(s => '\n        ' + s).join('') +
      (offenders.length > 25 ? '\n        … and ' + (offenders.length - 25) + ' more' : ''));
  }

  // b. All four tab-bar buttons on the screen and visible.
  const tabs = Array.from(document.querySelectorAll('nav.tabbar button'));
  if (tabs.length !== 4) problems.push('tab bar: expected 4 buttons, found ' + tabs.length);
  for (const b of tabs){
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    const name = (b.textContent || '').trim() || b.id;
    const why = [];
    if (r.right > W + 0.5) why.push('right edge at ' + Math.round(r.right) + 'px on a ' + W + 'px screen' + (r.left >= W ? ' (entirely off-screen)' : ''));
    if (r.left < -0.5) why.push('left edge ' + Math.round(r.left) + 'px < 0');
    if (r.top < -0.5 || r.bottom > H + 0.5) why.push('off the screen vertically (top ' + Math.round(r.top) + ', bottom ' + Math.round(r.bottom) + ', screen height ' + H + ')');
    if (!(r.width > 0 && r.height > 0) || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) why.push('not visible');
    if (why.length) problems.push('tab "' + name + '": ' + why.join('; '));
  }

  // d. The panel for this tab is showing and has something in it.
  const panel = document.getElementById('panel-' + key);
  const textLength = panel ? (panel.innerText || '').trim().length : 0;
  if (!panel) problems.push('panel: #panel-' + key + ' is missing');
  else if (panel.hidden) problems.push('panel: #panel-' + key + ' is still hidden');
  else if (!textLength) problems.push('panel: #panel-' + key + ' rendered empty');

  return { problems, scrollWidth: sw, innerWidth: iw, innerHeight: ih, screenWidth: W, textLength };
}

// Two frames, then a breath: enough for the re-render to lay out and paint.
const settle = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30)))));

/* ------------------------------------------------------------------------- */
/* Drive one viewport through every tab.                                       */
/* ------------------------------------------------------------------------- */
async function runViewport(browser, baseUrl, vp){
  const size = vp.w + 'x' + vp.h;
  console.log('\n' + size + ' @2x (' + vp.note + ')');
  const context = await browser.createBrowserContext();   // fresh storage, no service-worker cache
  const page = await context.newPage();
  const errors = [];     // c. console errors + uncaught exceptions, in order
  const notes = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const loc = msg.location() || {};
    const url = loc.url || '';
    if (/fonts\.(googleapis|gstatic)\.com/.test(url)){
      notes.push('webfont not fetched (' + msg.text() + ') — measured with the fallback font');
      return;
    }
    errors.push('console.error: ' + msg.text() + (url ? '  (' + url + (loc.lineNumber != null ? ':' + (loc.lineNumber + 1) : '') + ')' : ''));
  });
  page.on('pageerror', err => errors.push('uncaught: ' + ((err && err.message) || err)));

  await page.setUserAgent(vp.ua);
  await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(baseUrl + '/', { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => typeof showTab === 'function' && !!document.querySelector('#panel-benta'), { timeout: 15000 });
  // Let the display font arrive (or not) before anything is measured.
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));

  const fx = await page.evaluate(injectFixture);
  console.log('  app v' + fx.version + ' · today ' + fx.today + ' · this cutoff ' + fx.current + ' · previous ' + fx.previous +
    ' · fixture: ' + fx.days + ' days, ' + fx.expenses + ' expenses, stock usage on ' + fx.usageDates + ' dates');
  for (const n of Array.from(new Set(notes))) console.log('  note: ' + n);

  let allOk = true;
  const step = async (label, key, act) => {
    const before = errors.length;
    let problems = [];
    let r = null;
    try {
      await act();
      await settle(page);
      r = await page.evaluate(auditInPage, { key, width: vp.w, height: vp.h });
      problems = r.problems.slice();
      const fresh = errors.slice(before);
      if (fresh.length) problems.push('console/page errors (' + fresh.length + '):' + fresh.map(e => '\n        ' + e).join(''));
    } catch (err){
      problems.push('step threw: ' + ((err && err.message) || err));
    }
    if (problems.length){
      allOk = false;
      console.log('FAIL ' + size + ' ' + label + problems.map(p => '\n    - ' + p).join(''));
    } else {
      console.log('PASS ' + size + ' ' + label + ' — panel ' + r.textLength + ' chars, document ' + r.scrollWidth + 'px wide on a ' + r.screenWidth + 'px screen, 4 tabs on screen, no errors');
    }
  };

  for (const tab of TABS){
    await step(tab.label, tab.key, () => page.evaluate(k => showTab(k), tab.key));
    if (tab.prev){
      await step(tab.label + ' (previous cutoff)', tab.key, () => page.click('[data-act="' + tab.prev + '"]'));
    }
  }
  await context.close();
  return allOk;
}

/* ------------------------------------------------------------------------- */
async function main(){
  const t0 = Date.now();
  if (!fs.existsSync(path.join(PWA_DIR, 'index.html'))){
    console.error('phone smoke: no index.html in ' + PWA_DIR + ' (set PWA_DIR to the folder that holds the app)');
    process.exit(2);
  }
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch (_){
    console.error('phone smoke: puppeteer is not installed. From the repo root run:\n  npm i --no-save puppeteer@' + PUPPETEER_VERSION);
    process.exit(2);
  }
  try {
    const installed = require('puppeteer/package.json').version;
    if (installed !== PUPPETEER_VERSION) console.log('note: puppeteer ' + installed + ' is installed; this script is pinned to ' + PUPPETEER_VERSION);
  } catch (_){ /* the package may not export its package.json — not worth failing over */ }

  // Never hang a CI job: a wedged browser is a failure, not a wait.
  setTimeout(() => { console.error('phone smoke: gave up after ' + HARD_TIMEOUT_MS / 1000 + 's'); process.exit(3); }, HARD_TIMEOUT_MS).unref();

  const server = staticServer(PWA_DIR);
  const port = await listen(server);
  const baseUrl = 'http://127.0.0.1:' + port;
  console.log('phone smoke: serving ' + PWA_DIR + ' at ' + baseUrl);

  const browser = await puppeteer.launch({
    headless: true,
    // The page under test is this repo's own static file, so Chrome's sandbox
    // buys nothing here — and switching it off is what keeps the launch working
    // on GitHub's Ubuntu 24.04 runners, which restrict unprivileged user
    // namespaces. --disable-dev-shm-usage is for small /dev/shm in containers.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  let ok = true;
  try {
    for (const vp of VIEWPORTS){
      if (!(await runViewport(browser, baseUrl, vp))) ok = false;
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const checks = VIEWPORTS.length * TABS.reduce((n, t) => n + 1 + (t.prev ? 1 : 0), 0);
  if (ok) console.log('\nPASS — ' + checks + ' screens fit the phone, no errors (' + secs + 's)');
  else console.log('\nFAIL — see the FAIL lines above (' + secs + 's)');
  process.exitCode = ok ? 0 : 1;
}

main().catch(err => {
  console.error('phone smoke: ' + ((err && err.stack) || err));
  process.exit(2);
});
