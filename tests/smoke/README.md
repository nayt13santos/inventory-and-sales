# Phone-size smoke test

`phone.js` opens the real `pwa/index.html` in headless Chromium, emulating a
phone (375×812 and 360×740, both @2x, mobile mode on), injects a realistic
fixture into `state` so every screen has content, and walks the four tabs.

It exists because of v2.22.1: a sentence landed inside a `white-space:nowrap`
span on the Cutoff tab, the document grew wider than the phone, the fixed
100%-width tab bar grew with it, and the fourth tab was drawn off-screen.
483 Node tests passed — Node has no layout engine. The owner found it on his
phone. This makes that class of bug fail CI.

## What it checks

On each tab (Sales, Expenses, Cutoff, More), and again after stepping the
Expenses and Cutoff screens back one cutoff:

| | check | on failure |
|---|---|---|
| a | `documentElement.scrollWidth` ≤ the **screen** width (375 / 360) — no sideways overflow | names every element whose right edge is past the screen (tag, class, first 60 chars of text) |
| b | all four `nav.tabbar` buttons are on the screen and visible | names the tab and which edge is off |
| c | no console errors, no uncaught page errors | quotes them |
| d | the tab's `<section id="panel-…">` rendered some text | says it was empty |

Measured against the screen width the emulator was given, **not**
`window.innerWidth`: on a phone an overflowing document does not just scroll
sideways — the layout viewport grows to fit it, so `innerWidth`, `scrollWidth`
and a `position:fixed; width:100%` bar all stretch together. The v2.22.1
build reports `scrollWidth 401`, `innerWidth 401` on a 375px screen, with the
tab bar's right end 26px off the glass; `scrollWidth <= innerWidth` holds in
that state and would have passed.

Exit code is non-zero if anything fails; otherwise one `PASS` line per screen
per viewport.

## Run it locally

```sh
npm i --no-save puppeteer@25.9.0     # once, from the repo root (node_modules/ is gitignored)
node tests/smoke/phone.js            # checks ./pwa
PWA_DIR=/some/other/pwa node tests/smoke/phone.js
```

It serves the folder itself on an ephemeral `127.0.0.1` port with Node's `http`
module — no python, no dev server. Puppeteer is **pinned to 25.9.0** in the
script header and in `.github/workflows/deploy.yml`; bump both together.

The only network the page reaches for is the Google Fonts stylesheet it links.
If that is unreachable the run notes it and measures with the fallback font
rather than failing, so it also works offline.

## In CI

`.github/workflows/deploy.yml` runs it as the `smoke` job next to `test`;
`deploy-app` and `deploy-script` both `needs: [test, smoke]`, so nothing is
published if the phone check fails.

## Proof it bites (the mutation used)

Re-introducing the exact v2.22.1 bug in a **scratch copy** of `pwa/` (never
the repo file) makes the Cutoff tab fail on both viewports and name the span:

1. In the `main{` CSS rule, remove `overflow-x:hidden;`.
2. In `stockCutoffHTML`, change the inner
   `'<div class="stk-line-what">' + esc(bits.join(', ') || '—') + '</div>` to
   `'<span class="v" style="white-space:nowrap">' + esc(bits.join(', ') || '—') + '</span>`
   (the line ends `</div></div>';` — the second `</div>` closes `.stk-line` and stays).

As a script:

```sh
cp -R pwa /tmp/pwa-broken
cat > /tmp/mutate.js <<'EOF'
const fs = require('fs'); const f = process.argv[2];
let s = fs.readFileSync(f, 'utf8');
s = s.replace(/^(main\{[^\n]*?)overflow-x:hidden;\s*/m, '$1');
const from = '\'<div class="stk-line-what">\' + esc(bits.join(\', \') || \'—\') + \'</div>';
const to   = '\'<span class="v" style="white-space:nowrap">\' + esc(bits.join(\', \') || \'—\') + \'</span>';
if (!s.includes(from)) throw new Error('stk-line-what line not found');
fs.writeFileSync(f, s.replace(from, to));
EOF
node /tmp/mutate.js /tmp/pwa-broken/index.html
PWA_DIR=/tmp/pwa-broken node tests/smoke/phone.js
# -> FAIL 375x812 Cutoff
#      - sideways overflow: documentElement.scrollWidth … > innerWidth 375px …
#          <span class="v"> "12.5 kgs at the start, 5 kgs came in, … opened" …
```

## Fixture

Built inside the page from its own `todayStr()` / `currentPeriod()` /
`shiftPeriod()`, so the current cutoff and the previous one both carry data
whatever day CI runs. A takoyaki stall: Takoyaki Flour (kg), Takoyaki Sauce
(gal), Japanese Mayo (kg), Bonito / Aonori / Togarashi (Bag) with unit costs
(Aonori deliberately unpriced); every night of the previous cutoff and every
past night of this one saved with per-sku counts (two closed days); stock
usage with and without a snapshotted `unit_cost`; stocktakes on the last
night of each earlier cutoff (the "at the start" figure); deliveries; expenses
in all six categories across `paid_from` values; an entered split and counted
tin for the previous cutoff. It is passed through the app's own
`sanitizeState()`, so it can only be a state the app would accept anyway.
