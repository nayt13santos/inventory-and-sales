/* ============================================================================
 * Octogo Tracker — READ IT FROM THE PAPER  (v2.9.0)
 *
 * A THIRD, STANDALONE Apps Script project — deliberately NOT part of the
 * sheet's bound script, and not part of the backups project either. The reason
 * is the same fence that put the backups in their own project, for the same
 * cost of getting it wrong:
 *
 *   Apps Script grants permissions per PROJECT, and the bound script is what
 *   serves the phones. Reading a photograph needs the ability to make an
 *   INTERNET REQUEST (UrlFetchApp) and somewhere to keep the photograph
 *   (DriveApp). Adding either to the bound project would grow the permission
 *   set the LIVE web app runs under, and until the owner re-authorised it in
 *   the editor an ordinary night's save could start failing. A convenience
 *   must never be able to break the till.
 *
 *   It also keeps the SECRETS apart. This project holds a Gemini API key —
 *   a key that costs money if it leaks — and the sheet's own token must never
 *   be typed in here. Two projects, two secrets, neither able to spend the
 *   other. If this project is ever compromised, the worst it can do is read
 *   photographs; it cannot write a single figure into the sheet, because it
 *   has no SpreadsheetApp call anywhere in it and never learns the sheet id.
 *
 * WHAT IT DOES: the phone photographs the paper Mama already writes the night
 * on, sends the picture here with its OWN product list, and gets back a
 * READING — the figures as written. It writes NOTHING. The reading pre-fills
 * the Sales form, the owner checks it against the paper in his hand, and the
 * night is committed by the ordinary "Save day" in the tracker, with every
 * existing validation intact. Nothing here can save a day or move a figure.
 *
 * SETUP (once, ~5 minutes) — see SETUP.md:
 *   1. script.google.com -> New project -> name it "Octogo Vision"
 *   2. Paste this whole file in, replacing the placeholder code.
 *   3. Put a Gemini API key in GEMINI_API_KEY below (aistudio.google.com ->
 *      "Get API key"). It belongs to THIS project and nothing else.
 *   4. Invent a long random VISION_TOKEN below. It is this app's OWN shared
 *      secret — NEVER paste the sheet's token here, and never the other way
 *      round: two doors, two keys.
 *   5. Deploy -> New deployment -> Web app -> execute as ME, access ANYONE.
 *   6. Run visionCheck() once and approve the prompts, then hit the deployed
 *      URL with action "ping" from the phone to confirm the wiring — a ping
 *      spends no Gemini quota at all.
 * ========================================================================== */
'use strict';

var VERSION = '2.9.2';
var TZ = 'Asia/Manila';

/** The Gemini API key, from aistudio.google.com. This project's only paid
 *  resource: it lives here, alone, and appears in a REQUEST HEADER only —
 *  never in a URL and never in a logged body, because URLs and bodies are the
 *  two things that end up in logs and error messages. */
var GEMINI_API_KEY = 'PASTE_THE_GEMINI_API_KEY_HERE';

/** This web app's OWN shared secret, checked on every request. Invent a long
 *  random string. It must NOT be the sheet's token: the tracker's token opens
 *  a door that writes money, and a photo-reader has no business holding it. */
var VISION_TOKEN = 'PASTE_A_LONG_RANDOM_TOKEN_HERE';

var KEY_PLACEHOLDER = 'PASTE_THE_GEMINI_API_KEY_HERE';
var TOKEN_PLACEHOLDER = 'PASTE_A_LONG_RANDOM_TOKEN_HERE';

/** Where every photograph is kept, so a reading can always be traced back to
 *  the paper it came from. Created on first use. */
var PHOTO_FOLDER = 'Octogo Sales Photos';

/** The vision model. SWAPPABLE ON PURPOSE: this is the one line to change when
 *  a better or cheaper model appears, or when a quota moves — nothing else in
 *  this file knows the model's name, and the reading shape the phone consumes
 *  does not change with it. */
var MODEL = 'gemini-2.5-flash';

var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

/** The biggest photograph this app will accept, ~4 MB. The phone resizes before
 *  sending (long edge ~1600px, JPEG), which lands far under this; the cap is
 *  here so a raw 12-megapixel original is refused in a plain sentence instead
 *  of dying inside the request with something nobody can read. */
var MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** What a phone camera actually produces. Small on purpose: an unexpected type
 *  is far more likely a broken client than a photograph worth reading. */
var ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

var MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic'
};

// ---------------------------------------------------------------------------
// Web app entry points. Same contract as the tracker's own API, deliberately:
// POST with text/plain (Apps Script cannot answer a CORS preflight), body
// JSON {token, action, payload}, reply {ok:true, data} or {ok:false, error}.
// Requests camelCase, responses snake_case — the standing rule, both ways.
// ---------------------------------------------------------------------------

/** Connectivity ping. No token needed, and it reveals nothing but a version. */
function doGet(e) {
  return jsonOut_({ ok: true, data: { name: 'octogo-vision', version: VERSION } });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Empty request body. Expected JSON {token, action, payload}.');
    }
    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      throw new Error('Request body is not valid JSON.');
    }
    // "null", a bare number or a string all PARSE as valid JSON but are not a
    // request; reading .action off them would spill engine debris at the owner.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Request body is not valid JSON. Expected {token, action, payload}.');
    }
    var action = asStr_(body.action);
    var payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

    // The token is checked BEFORE anything else costs anything: no Drive write,
    // no Gemini call, no quota spent by a caller who cannot say the password.
    if (asStr_(body.token) !== visionTokenOrThrow_()) {
      // Says nothing about what the right answer looks like, and never echoes
      // what was sent — an error message is the wrong place for either secret.
      throw new Error('Invalid token.');
    }

    var data;
    switch (action) {
      case 'ping':
        // Deliberately answers WITHOUT touching Gemini, so the owner can prove
        // the deployment and the token are right before spending any quota.
        // key_configured is a yes/no; the key itself never leaves this project.
        data = { version: VERSION, model: MODEL, key_configured: hasKey_() };
        break;
      case 'readSheet':
        data = apiReadSheet_(payload);
        break;
      default:
        throw new Error('Unknown action: "' + action + '".');
    }
    return jsonOut_({ ok: true, data: data });
  } catch (err) {
    return jsonOut_({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// The two constants the owner fills, read the way Backups.gs reads its sheet
// id: tolerantly, and refusing in sentences that name the REAL reasons an
// owner sees "still the placeholder" AFTER typing the thing in. "You didn't
// type it" is the one explanation that is usually false, so it is not said.
// Trailing underscore = private, so these stay out of the Run dropdown.
// ---------------------------------------------------------------------------

function cleanConst_(v) {
  return String(v === null || v === undefined ? '' : v)
    .trim().replace(/^['"]+|['"]+$/g, '').trim();
}

/** True when a key is filled in at all. Used by ping so setup can be checked
 *  without a Gemini call — and it never returns the key itself. */
function hasKey_() {
  var k = cleanConst_(GEMINI_API_KEY);
  return !!k && k !== KEY_PLACEHOLDER;
}

function geminiKeyOrThrow_() {
  var key = cleanConst_(GEMINI_API_KEY);
  if (!key || key === KEY_PLACEHOLDER) {
    throw new Error('GEMINI_API_KEY is still "' + KEY_PLACEHOLDER + '" in the code that just RAN, ' +
      'so no photo can be read — the night can still be typed in by hand. If you already pasted ' +
      'the key, one of these three is why: (1) the file was not saved — press the save icon (or ' +
      'Ctrl+S) first, because a deployment serves the SAVED code; (2) this project has a SECOND ' +
      'file with the same script in it — look at the file list on the left and delete the spare, ' +
      'because two files both setting GEMINI_API_KEY means the other one wins; (3) the key went ' +
      'somewhere other than the line starting "var GEMINI_API_KEY =". Run visionCheck() to see ' +
      'what the saved code holds.');
  }
  return key;
}

function visionTokenOrThrow_() {
  var tok = cleanConst_(VISION_TOKEN);
  if (!tok || tok === TOKEN_PLACEHOLDER) {
    throw new Error('VISION_TOKEN is still "' + TOKEN_PLACEHOLDER + '" in the code that just RAN, ' +
      'so this app cannot check who is calling it. If you already typed a token, one of these ' +
      'three is why: (1) the file was not saved — press the save icon (or Ctrl+S) first, because ' +
      'a deployment serves the SAVED code; (2) this project has a SECOND file with the same ' +
      'script in it — look at the file list on the left and delete the spare, because two files ' +
      'both setting VISION_TOKEN means the other one wins; (3) the token went somewhere other ' +
      'than the line starting "var VISION_TOKEN =". It must be a long random string of its own ' +
      'and NEVER the sheet\'s token. Run visionCheck() to see what the saved code holds.');
  }
  return tok;
}

/** Run this from the editor any time to SEE whether the saved code is ready,
 *  without spending a single unit of Gemini quota. It reports what is filled
 *  in and never prints either secret — the length is enough to tell a real
 *  token from a stray keystroke. */
function visionCheck() {
  var keyOk = hasKey_();
  var tokOk = false;
  try { visionTokenOrThrow_(); tokOk = true; } catch (e) { tokOk = false; }
  var said = 'Octogo Vision ' + VERSION + ' — model ' + MODEL + '; ' +
    'GEMINI_API_KEY ' + (keyOk ? 'is set (' + cleanConst_(GEMINI_API_KEY).length + ' characters)' : 'is NOT set') + '; ' +
    'VISION_TOKEN ' + (tokOk ? 'is set (' + cleanConst_(VISION_TOKEN).length + ' characters)' : 'is NOT set') + '; ' +
    'photos go to the Drive folder "' + PHOTO_FOLDER + '".';
  Logger.log(said);
  return said;
}

// ---------------------------------------------------------------------------
// action readSheet
// ---------------------------------------------------------------------------

/**
 * Read one photograph of the paper. In order, and the order matters:
 *   1. validate the payload — nothing is spent on a request that is wrong;
 *   2. KEEP THE PHOTO FIRST, so a reading can always be traced back to the
 *      paper it came from even if the reading itself later looks wrong. If the
 *      save fails the reading still happens and says the photo was not kept —
 *      losing the filing cabinet must not lose the night;
 *   3. ask Gemini, with a strict prompt built from the phone's OWN product
 *      vocabulary and a structured-output schema;
 *   4. normalise the reply into the reading shape, where anything unreadable
 *      is BLANK and NAMED, never 0.
 * It writes nothing anywhere near the sheet and cannot save a day.
 */
function apiReadSheet_(payload) {
  // --- 1. Validate. The key is checked here rather than at the top of doPost
  // so that a `ping` still answers on a half-finished setup and tells the owner
  // which constant is missing.
  var key = geminiKeyOrThrow_();

  var date = reqEntryDate_(payload.date, 'date');

  var mimeType = asStr_(payload.mimeType).toLowerCase();
  if (!mimeType) {
    throw new Error('No mimeType was sent with the photo, so this app cannot tell what kind of ' +
      'image it is — the night can still be typed in by hand.');
  }
  if (ALLOWED_MIME.indexOf(mimeType) < 0) {
    throw new Error('This app can read a photo saved as ' + joinAnd_(ALLOWED_MIME) + ', not "' +
      mimeType + '" — take the picture again with the camera in the app, or type the night in by hand.');
  }

  var image = asStr_(payload.imageBase64)
    // A phone that sends the whole data: URL is doing the obvious thing, so it
    // works; whitespace from a line-wrapped encoder is harmless too.
    .replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!image) {
    throw new Error('No photo was sent, so there is nothing to read — the night can still be ' +
      'typed in by hand.');
  }
  if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(image)) {
    throw new Error('The photo did not arrive as readable image data, so nothing could be read ' +
      'from it — take the picture again, or type the night in by hand.');
  }
  var bytes = base64Bytes_(image);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error('That photo is ' + mb_(bytes) + ' MB, which is bigger than the ' +
      mb_(MAX_IMAGE_BYTES) + ' MB this app accepts — take it again with the camera in the app, ' +
      'which shrinks it, or type the night in by hand.');
  }

  var skus = normaliseSkus_(payload.skus);

  // --- 2. Keep the photo FIRST. A failure here is reported, never fatal.
  var kept = savePhoto_(image, mimeType, date);

  // --- 3. Ask Gemini.
  var reply = callGemini_(key, image, mimeType, buildPrompt_(date, skus));

  // --- 4. Normalise into the reading. snake_case, blanks named, nothing 0.
  var reading = normaliseReading_(reply, date, skus);
  reading.photo_saved = kept.saved;
  reading.photo_url = kept.url;
  reading.photo_id = kept.id;
  reading.photo_error = kept.error;
  reading.model = MODEL;
  return reading;
}

/** The phone's OWN product vocabulary — this app never reads the sheet, so
 *  "B4" becomes box4 by the owner's own labels and nothing else. */
function normaliseSkus_(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('The phone sent no product list, so there is no way to tell which product a ' +
      'row on the paper belongs to — the night can still be typed in by hand.');
  }
  var out = [];
  var seen = Object.create(null);
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i] || {};
    var sku = asStr_(s.sku);
    if (!sku || seen[sku]) continue;   // no sku, no identity; first row wins
    seen[sku] = true;
    out.push({
      sku: sku,
      label: asStr_(s.label) || sku,
      size: asNum_(s.size),
      // Requests are camelCase (cheesePrice), the standing rule. An older phone
      // that omits one sends the harmless default: no price to check against.
      price: asNum_(s.price),
      cheese_price: asNum_(s.cheesePrice),
      in_cutoff: s.inCutoff === undefined ? true : asBool_(s.inCutoff)
    });
  }
  if (out.length === 0) {
    throw new Error('The product list the phone sent has no usable products in it, so a row on ' +
      'the paper cannot be matched to anything — the night can still be typed in by hand.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// The photograph, kept first
// ---------------------------------------------------------------------------

/** One file per reading, named by the DATE ON THE PAPER plus a clock stamp —
 *  the date is what anybody looking for it will search on, and the stamp keeps
 *  a second attempt at the same night from overwriting the first. */
function savePhoto_(image, mimeType, date) {
  try {
    var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
    var folder = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
    var name = 'Sales ' + date + ' ' + Utilities.formatDate(new Date(), TZ, 'HHmmss') +
      (MIME_EXT[mimeType] || '');
    var blob = Utilities.newBlob(Utilities.base64Decode(image), mimeType, name);
    var file = folder.createFile(blob);
    return { saved: true, id: asStr_(file.getId()), url: asStr_(file.getUrl()), error: '' };
  } catch (err) {
    // Losing the filing cabinet must not lose the night: the reading carries on
    // and SAYS the photo was not kept, in the owner's words, so he knows this
    // one reading cannot be checked against the picture later.
    return {
      saved: false, id: '', url: '',
      error: 'The photo could not be kept in Drive (' +
        scrub_((err && err.message) ? err.message : String(err)) +
        '), so this reading cannot be checked against the picture later.'
    };
  }
}

// ---------------------------------------------------------------------------
// The prompt: the owner's own shorthand, spelled out
// ---------------------------------------------------------------------------

/**
 * The vocabulary matters more than the wording. Mama's paper is a real
 * notation, not free text — `B4 | 31-28 | 1c = 60 | 2 = 100` is a product, a
 * SOD-EOD pair, one cheese box at its cheese price and two plain boxes at the
 * plain price. A model that is not TOLD that reads it as arithmetic homework.
 * The prices are handed over so the model can CHECK its own reading against
 * them, never so it can invent a count that makes the money work.
 */
function buildPrompt_(date, skus) {
  var vocab = skus.map(function (s) {
    var bits = [];
    bits.push('  ' + s.sku + ' = "' + s.label + '"');
    var shorthand = shorthandFor_(s.label);
    if (shorthand) bits.push(' (the paper writes it "' + shorthand + '")');
    if (s.price) bits.push(' — plain ' + s.price);
    if (s.cheese_price) bits.push(', with cheese ' + s.cheese_price);
    if (!s.in_cutoff) bits.push(' [sold, but its money is kept out of the cutoff]');
    return bits.join('');
  }).join('\n');

  return [
    'You are reading ONE photograph of a handwritten nightly sales log from a takoyaki stall.',
    'The night on the paper is ' + date + '. Report ONLY what is written. Never guess.',
    '',
    'THE PAPER, in the owner\'s own shorthand:',
    '  * One row per product. A real row reads:   B4 | 31-28 | 1c = 60 | 2 = 100',
    '  * The first token names the product: "B4" is the label "Box 4", shortened.',
    '  * "31-28" is SOD-EOD: 31 boxes at the start of the day, 28 left at the end.',
    '  * "1c = 60" is ONE box WITH CHEESE, priced at that product\'s cheese price.',
    '  * "2 = 100" is TWO plain boxes at that product\'s plain price.',
    '  * "Gc" (also "GC", "gc", "gcash") marks a figure as PAID BY GCASH rather than cash.',
    '    "1c Gc" is one cheese box paid by GCash, so it counts in cheese AND in GCash cheese.',
    '  * A figure with a line THROUGH it is CANCELLED and is replaced by the figure written',
    '    below or beside it. Report only the figure that still stands. "2735 -> 2605" crossed',
    '    out means 2605.',
    '  * The LAST STANDING total on the page is the night\'s own total: report it as',
    '    total_on_paper. If two totals appear and one is crossed out, the standing one wins.',
    '  * The page usually carries a DATE, often at the top ("DATE 5/18"). Report it in',
    '    date_on_paper EXACTLY as it is written — do not reformat it, do not add a year, and',
    '    do not work it out from anything else. If no date is written, or you cannot read it,',
    '    leave date_on_paper out.',
    '  * A special order taken outside the menu is written as a PESO AMOUNT, not a box count:',
    '    report it as custom_amount, and whatever part of it was paid by GCash as custom_gcash.',
    '',
    'THE ONLY PRODUCTS THAT EXIST (use these sku codes exactly, nothing else):',
    vocab,
    '',
    'RULES YOU MUST FOLLOW:',
    '  1. Report one entry in "counts" for each product ROW ACTUALLY ON THE PAPER, and no others.',
    '     Use the sku code from the list above. If a row names something that is not on that list,',
    '     do not invent a sku for it: leave the row out and say so in "unread".',
    '  2. If the paper shows NONE of something (no cheese on that row, no GCash), report 0.',
    '     If you CANNOT READ something, LEAVE THAT FIELD OUT COMPLETELY and name it in "unread".',
    '     Never write 0 for a figure you could not read, and never estimate one.',
    '  3. sod, eod, cheese, gcash and gcash_cheese are whole counts of boxes, never pesos.',
    '  4. confidence is your own certainty for that row, 0 to 1.',
    '  5. The prices above are for CHECKING your reading ("2 = 100" at 50 each is consistent).',
    '     They are never a reason to change a figure you can plainly read.',
    '  6. Put anything else worth a human\'s eye — a smudge, a note in the margin, an arithmetic',
    '     slip on the paper itself — in "notes", in one or two plain sentences.'
  ].join('\n');
}

/** "Box 4" -> "B4": the abbreviation the owner actually writes. First letter of
 *  each word plus the trailing number, which is exactly how the paper reads.
 *  A label the rule cannot shorten simply gets no hint, and the label itself
 *  still stands in the vocabulary. */
function shorthandFor_(label) {
  var m = /^([A-Za-z])[A-Za-z]*\s+(\d+)$/.exec(asStr_(label).trim());
  return m ? (m[1].toUpperCase() + m[2]) : '';
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/** The structured-output schema. This is what turns "a model that describes a
 *  photo" into "a model that fills a form": every field is optional except the
 *  sku, precisely so that OMITTING a field is the model's way of saying "I
 *  could not read this" — which is the whole blank-never-zero rule, enforced
 *  by the schema rather than hoped for in prose. */
function readingSchema_() {
  var count = { type: 'INTEGER', nullable: true };
  var money = { type: 'NUMBER', nullable: true };
  return {
    type: 'OBJECT',
    properties: {
      counts: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            sku: { type: 'STRING' },
            sod: count,
            eod: count,
            cheese: count,
            gcash: count,
            gcash_cheese: count,
            confidence: { type: 'NUMBER', nullable: true }
          },
          required: ['sku']
        }
      },
      custom_amount: money,
      custom_gcash: money,
      total_on_paper: money,
      // The date WRITTEN on the page, exactly as the pen wrote it ("5/18"),
      // never normalised and never guessed (v2.9.1). It is not what the night
      // gets saved as — the phone's date always wins — it exists so the phone
      // can notice that this page is not the night on screen.
      date_on_paper: { type: 'STRING', nullable: true },
      notes: { type: 'STRING', nullable: true },
      unread: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['counts']
  };
}

/**
 * One call, one photograph. muteHttpExceptions is not optional: without it a
 * 429 or a 500 arrives as an Apps Script exception whose text is engine debris,
 * and the owner would see that instead of "the quota is used up". With it, the
 * status is a number this code can turn into a sentence.
 *
 * The key travels in a HEADER, never in the URL and never in the body. A URL
 * ends up in logs and in every error message that quotes it; a body is the
 * thing most likely to be dumped when something goes wrong. A header is the
 * one place a secret can sit without being printed by accident.
 */
function callGemini_(key, image, mimeType, prompt) {
  var url = GEMINI_ENDPOINT + MODEL + ':generateContent';
  var body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        // The photograph itself, inline — one request, no upload step, nothing
        // left behind on Google's side to clean up.
        { inline_data: { mime_type: mimeType, data: image } }
      ]
    }],
    generationConfig: {
      // Zero temperature: this is transcription, not writing. The same photo
      // must read the same way twice, or the cross-check against the paper's
      // own total means nothing.
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: readingSchema_()
    }
  };

  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: { 'x-goog-api-key': key },
      muteHttpExceptions: true
    });
  } catch (err) {
    // The request never left the building — no network, DNS, a timeout.
    throw new Error('The photo could not be sent for reading (' +
      scrub_((err && err.message) ? err.message : String(err)) +
      '), so nothing was filled in — try again, or type the night in by hand.');
  }

  var code = Number(res.getResponseCode());
  var text = asStr_(res.getContentText());
  if (code !== 200) throw new Error(httpRefusal_(code, text));

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('The reading service answered with something that is not a reading, so ' +
      'nothing was filled in — the night can still be typed in by hand.');
  }
  return parsed;
}

/** Every HTTP failure as ONE plain sentence that says what happened and that
 *  hand-typing is always still there. The quota case is called out by name
 *  because it is the one the owner will actually meet, and it is temporary. */
function httpRefusal_(code, text) {
  var detail = scrub_(geminiMessage_(text));
  var tail = ' — the night can still be typed in by hand.';
  if (code === 429) {
    return 'The reading service has no quota left right now, so this photo was not read' +
      (detail ? ' (' + detail + ')' : '') + ' — wait a while and try again, or type the night in by hand.';
  }
  if (code === 401 || code === 403) {
    return 'The reading service would not accept this project\'s key, so this photo was not read' +
      (detail ? ' (' + detail + ')' : '') + ' — check GEMINI_API_KEY in the Octogo Vision project' + tail;
  }
  if (code >= 400 && code < 500) {
    return 'The reading service could not use this photo (it answered ' + code +
      (detail ? ': ' + detail : '') + '), so nothing was filled in' + tail;
  }
  return 'The reading service had a problem of its own (it answered ' + code +
    (detail ? ': ' + detail : '') + '), so nothing was filled in — try again in a moment, or ' +
    'type the night in by hand.';
}

/** The human-readable part of a Gemini error body, if there is one. Kept short:
 *  a refusal is one sentence, not a stack trace pasted into a phone. */
function geminiMessage_(text) {
  var msg = '';
  try {
    var o = JSON.parse(text);
    if (o && o.error && o.error.message) msg = String(o.error.message);
  } catch (e) {
    msg = '';
  }
  msg = msg.replace(/\s+/g, ' ').trim();
  return msg.length > 160 ? msg.slice(0, 157) + '...' : msg;
}

/** Never let the key travel back out in a message. Anything this app quotes
 *  from somewhere else goes through here first — a leaked key costs money, and
 *  the one place a secret reliably escapes is an error the owner forwards. */
function scrub_(s) {
  var out = String(s === null || s === undefined ? '' : s);
  var key = cleanConst_(GEMINI_API_KEY);
  if (key && key !== KEY_PLACEHOLDER) out = out.split(key).join('(the key)');
  var tok = cleanConst_(VISION_TOKEN);
  if (tok && tok !== TOKEN_PLACEHOLDER) out = out.split(tok).join('(the token)');
  return out;
}

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

/**
 * Gemini's reply -> the reading the phone consumes. snake_case throughout, the
 * standing rule for a response.
 *
 * Two things this function exists to guarantee, because both are money:
 *   - ANYTHING UNREADABLE IS BLANK, never 0. A zero it did read is a zero; a
 *     figure it could not see is '' and is NAMED in `unread`. A blank that
 *     became 0 would look like a real answer and would quietly cost the night
 *     its sales, which is the entire reason this app cannot save a day.
 *   - a reply that is not a READING is refused, not massaged. A model that
 *     wrote prose has not read the paper, and pretending otherwise would fill
 *     the form with nothing while looking like it worked.
 */
function normaliseReading_(reply, date, skus) {
  var cand = (reply && Array.isArray(reply.candidates)) ? reply.candidates : [];
  if (cand.length === 0) {
    throw new Error('The reading service sent nothing back for this photo, so nothing was ' +
      'filled in — try again, or type the night in by hand.');
  }
  var parts = (cand[0] && cand[0].content && Array.isArray(cand[0].content.parts))
    ? cand[0].content.parts : [];
  var text = '';
  for (var p = 0; p < parts.length; p++) {
    if (parts[p] && typeof parts[p].text === 'string') text += parts[p].text;
  }
  text = text.trim();
  // Some models fence their JSON even when asked not to; unwrapping that is
  // tolerance, not massaging — the content underneath is still the model's.
  var fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) text = fenced[1].trim();

  var got = null;
  if (text) {
    try { got = JSON.parse(text); } catch (e) { got = null; }
  }
  if (!got || typeof got !== 'object' || Array.isArray(got) || !Array.isArray(got.counts)) {
    // The prose case, and the empty case. One sentence, and it names the way out.
    throw new Error('The photo did not come back as a reading of the paper, so nothing was ' +
      'filled in — the night can still be typed in by hand.');
  }

  var known = Object.create(null);
  var labelOf = Object.create(null);
  for (var i = 0; i < skus.length; i++) {
    known[skus[i].sku] = true;
    labelOf[skus[i].sku] = skus[i].label;
  }

  var unread = [];
  var seenUnread = Object.create(null);
  var note = function (said) {
    said = asStr_(said).replace(/\s+/g, ' ').trim();
    if (!said || seenUnread[said]) return;
    seenUnread[said] = true;
    unread.push(said);
  };
  // The model's own list of what it could not read comes first: it is the only
  // party that knows what it was looking at.
  if (Array.isArray(got.unread)) got.unread.forEach(note);

  var counts = [];
  var seenSku = Object.create(null);
  for (var r = 0; r < got.counts.length; r++) {
    var row = got.counts[r] || {};
    var sku = asStr_(row.sku);
    if (!sku) {
      note('a row on the paper with no product name on it');
      continue;
    }
    if (!known[sku]) {
      // Never invented into a real sku: the phone's list is the only vocabulary,
      // and a guess here would put a night's boxes on the wrong product.
      note('a row on the paper read as "' + sku + '", which is not a product on this phone');
      continue;
    }
    if (seenSku[sku]) {
      note(labelOf[sku] + ' appears more than once — only the first row was taken');
      continue;
    }
    seenSku[sku] = true;
    var label = labelOf[sku];
    var line = { sku: sku };
    ['sod', 'eod', 'cheese', 'gcash', 'gcash_cheese'].forEach(function (f) {
      var v = intOrBlank_(row[f]);
      line[f] = v;
      if (v === '') note(label + ' ' + FIELD_WORDS[f]);
    });
    line.confidence = fracOrBlank_(row.confidence);
    counts.push(line);
  }

  var customAmount = moneyOrBlank_(got.custom_amount);
  if (customAmount === '') note('the special-order amount');
  var customGcash = moneyOrBlank_(got.custom_gcash);
  if (customGcash === '') note('the GCash part of the special order');
  var total = moneyOrBlank_(got.total_on_paper);
  // The one figure the whole cross-check rests on, so its absence is said
  // plainly rather than left for the phone to discover as a blank.
  if (total === '') note('the night\'s own total on the paper');

  // The date the PEN wrote, kept exactly as read and never resolved here
  // (v2.9.1). It decides nothing — it exists so the phone can notice that the
  // page in the photograph is not the night on its screen, which is otherwise
  // invisible: an old page's figures agree with its own total perfectly, so the
  // cross-check would bless a May night saved onto an August day.
  var onPaper = asStr_(got.date_on_paper).trim().slice(0, 40);

  return {
    // The DATE IS THE PHONE'S, not the model's. The phone knows which night it
    // photographed; a model reading a date off a smudged corner does not, and a
    // reading filed under the wrong night is worse than no reading at all.
    date: date,
    date_on_paper: onPaper,
    counts: counts,
    custom_amount: customAmount,
    custom_gcash: customGcash,
    total_on_paper: total,
    notes: asStr_(got.notes),
    unread: unread
  };
}

var FIELD_WORDS = {
  sod: 'at the start of the day',
  eod: 'left at the end of the day',
  cheese: 'with cheese',
  gcash: 'paid by GCash',
  gcash_cheese: 'with cheese and paid by GCash'
};

// ---------------------------------------------------------------------------
// Small helpers. Deliberate duplicates of the tracker's own: this is a
// SEPARATE project and cannot import from it, and a photo-reader quietly
// drifting from the tracker's idea of "a real date" would be worse than two
// copies of eight lines.
// ---------------------------------------------------------------------------

function asStr_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function asNum_(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function asBool_(v) {
  if (typeof v === 'boolean') return v;
  var s = asStr_(v).toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

/** A whole count, or BLANK. Never 0 by accident: null, undefined, '', a word,
 *  a negative or a fraction all read as "not read", which is what they are. */
function intOrBlank_(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return '';
  var n = Number(String(v).replace(/[,\s]/g, ''));
  if (!isFinite(n) || n < 0) return '';
  if (Math.abs(n - Math.round(n)) > 1e-9) return '';
  return Math.round(n);
}

/** A peso amount, or BLANK. A stray "₱" or thousands comma is tolerated — the
 *  model is copying what a person wrote. */
function moneyOrBlank_(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return '';
  var n = Number(String(v).replace(/[₱,\s]/g, ''));
  if (!isFinite(n) || n < 0) return '';
  return Math.round(n * 100) / 100;
}

/** The model's own certainty, 0 to 1, or blank. A figure outside that range is
 *  not a confidence and is not quietly clamped into one. */
function fracOrBlank_(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return '';
  var n = Number(v);
  if (!isFinite(n) || n < 0 || n > 1) return '';
  return Math.round(n * 100) / 100;
}

/** Bytes behind a base64 string, WITHOUT decoding it — the point of the cap is
 *  to refuse a huge image cheaply, and decoding first would defeat that. */
function base64Bytes_(b64) {
  var n = b64.length;
  if (n === 0) return 0;
  var pad = 0;
  if (b64.charAt(n - 1) === '=') pad++;
  if (n > 1 && b64.charAt(n - 2) === '=') pad++;
  return Math.floor(n / 4) * 3 - pad;
}

function mb_(bytes) {
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
}

function joinAnd_(list) {
  if (!list || list.length === 0) return '';
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1];
}

/** Shape-strict, like the tracker's reqDate: the phone always sends canonical
 *  yyyy-MM-dd, so anything else is a broken client rather than a hand edit. */
function reqDate_(v, label) {
  var s = asStr_(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error((label || 'date') + ' must be a yyyy-MM-dd string (got "' + asStr_(v) + '").');
  }
  var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth_(y, m)) {
    throw new Error((label || 'date') + ' is not a real calendar date (got "' + s + '").');
  }
  return s;
}

/** The date of a RECORDED EVENT: a night that has happened, since the stall
 *  opened. A photo of tomorrow is a mangled date, and a reading filed there
 *  would sit where nobody looks. "Today" is Manila's today, never the server's. */
function reqEntryDate_(v, label) {
  var s = reqDate_(v, label);
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (s > today) {
    throw new Error('That date (' + s + ') has not happened yet. Pick today or an earlier day.');
  }
  if (s < '2020-01-01') {
    throw new Error('That date (' + s + ') is before 2020, which cannot be right. Check the year.');
  }
  return s;
}

function daysInMonth_(y, m) {
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
