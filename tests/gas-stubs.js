'use strict';
// Minimal Google Apps Script environment stubs, faithful where it matters:
// - getRange(row, col, nRows, nCols) THROWS when the range exceeds the grid
//   (this is the real failure mode the capacity fix guards against)
// - setValues/clearContent operate on a fixed grid; only appendRow and
//   insertRowsAfter grow it (as in real Sheets)
// - an operation log records write ordering so tests can assert
//   "setValues before clearContent"

const crypto = require('crypto');

function formatDate(date, tz, fmt) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = {};
  dtf.formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  if (parts.hour === '24') parts.hour = '00';
  return fmt
    .replace('yyyy', parts.year)
    .replace('MM', parts.month)
    .replace('dd', parts.day)
    .replace('HH', parts.hour)
    .replace('mm', parts.minute)
    .replace('ss', parts.second);
}

class FakeRange {
  constructor(sheet, r0, c0, nRows, nCols, wholeColumn) {
    this.sheet = sheet;
    this.r0 = r0; this.c0 = c0;
    this.nRows = nRows; this.nCols = nCols;
    this.wholeColumn = !!wholeColumn;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nRows; r++) {
      const row = [];
      for (let c = 0; c < this.nCols; c++) {
        row.push(this.sheet.grid[this.r0 - 1 + r][this.c0 - 1 + c]);
      }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nRows || values.some(v => v.length !== this.nCols)) {
      throw new Error('The number of rows or columns in the data does not match the range.');
    }
    this.sheet.log.push({ op: 'setValues', r0: this.r0, c0: this.c0, nRows: this.nRows, nCols: this.nCols });
    for (let r = 0; r < this.nRows; r++) {
      for (let c = 0; c < this.nCols; c++) {
        this.sheet.grid[this.r0 - 1 + r][this.c0 - 1 + c] = values[r][c];
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    this.sheet.log.push({ op: 'clearContent', r0: this.r0, c0: this.c0, nRows: this.nRows, nCols: this.nCols });
    for (let r = 0; r < this.nRows; r++) {
      for (let c = 0; c < this.nCols; c++) {
        this.sheet.grid[this.r0 - 1 + r][this.c0 - 1 + c] = '';
      }
    }
    return this;
  }
  setNumberFormat(fmt) {
    this.sheet.log.push({ op: 'setNumberFormat', fmt, r0: this.r0, c0: this.c0, nRows: this.nRows, nCols: this.nCols, wholeColumn: this.wholeColumn });
    if (this.wholeColumn) {
      for (let c = 0; c < this.nCols; c++) this.sheet.columnFormats[this.c0 + c] = fmt;
    } else {
      for (let r = 0; r < this.nRows; r++) {
        for (let c = 0; c < this.nCols; c++) {
          this.sheet.cellFormats[`${this.r0 + r},${this.c0 + c}`] = fmt;
        }
      }
    }
    return this;
  }
}

class FakeSheet {
  constructor(name, maxRows = 1000, maxCols = 26) {
    this.name = name;
    this.grid = [];
    for (let r = 0; r < maxRows; r++) this.grid.push(new Array(maxCols).fill(''));
    this.maxCols = maxCols;
    this.frozenRows = 0;
    this.columnFormats = {}; // col -> fmt (whole-column formats survive grid growth)
    this.cellFormats = {};   // "r,c" -> fmt
    this.log = [];
  }
  getName() { return this.name; }
  getMaxRows() { return this.grid.length; }
  getMaxColumns() { return this.maxCols; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  lastDataRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) {
      if (this.grid[r].some(c => c !== '' && c !== null)) return r + 1;
    }
    return 0;
  }
  lastDataCol() {
    let last = 0;
    for (const row of this.grid) {
      for (let c = row.length - 1; c >= last; c--) {
        if (row[c] !== '' && row[c] !== null) { last = c + 1; break; }
      }
    }
    return last;
  }
  /** Real API: "the position of the last column that has content" — SHEET-WIDE,
   *  so it sees a column holding data under a blank header. 0 when empty. */
  getLastColumn() { return this.lastDataCol(); }
  getLastRow() { return this.lastDataRow(); }
  getDataRange() {
    const nR = Math.max(1, this.lastDataRow());
    const nC = Math.max(1, this.lastDataCol());
    return new FakeRange(this, 1, 1, nR, nC);
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+):([A-Z]+)$/.exec(a);
      if (!m) throw new Error('Unsupported A1 notation in stub: ' + a);
      const colNum = s => s.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
      const c0 = colNum(m[1]);
      const c1 = colNum(m[2]);
      return new FakeRange(this, 1, c0, this.getMaxRows(), c1 - c0 + 1, true);
    }
    const row = a, col = b, nRows = c === undefined ? 1 : c, nCols = d === undefined ? 1 : d;
    if (row < 1 || col < 1 || nRows < 1 || nCols < 1 ||
        row + nRows - 1 > this.getMaxRows() || col + nCols - 1 > this.maxCols) {
      // Same failure the real API produces when the range exceeds the grid.
      throw new Error('The coordinates or dimensions of the range are invalid.');
    }
    return new FakeRange(this, row, col, nRows, nCols);
  }
  appendRow(row) {
    this.log.push({ op: 'appendRow' });
    const at = this.lastDataRow() + 1;
    if (at > this.getMaxRows()) this.insertRowsAfter(this.getMaxRows(), 1); // appendRow auto-grows
    for (let c = 0; c < row.length; c++) this.grid[at - 1][c] = row[c];
    return this;
  }
  insertRowsAfter(afterRow, howMany) {
    this.log.push({ op: 'insertRowsAfter', afterRow, howMany });
    if (afterRow < 1 || afterRow > this.getMaxRows()) {
      throw new Error('Those rows are out of bounds.');
    }
    const fresh = [];
    for (let i = 0; i < howMany; i++) fresh.push(new Array(this.maxCols).fill(''));
    this.grid.splice(afterRow, 0, ...fresh);
    return this;
  }
  deleteRow(rowPos) {
    this.log.push({ op: 'deleteRow', rowPos });
    this.grid.splice(rowPos - 1, 1);
    return this;
  }
  /** Widen the grid, shifting every cell right of `afterCol` — same as the real
   *  API. Needed by the append-only migration when the schema is wider than the
   *  sheet's grid (an owner who deleted his unused columns has exactly that). */
  insertColumnsAfter(afterCol, howMany) {
    this.log.push({ op: 'insertColumnsAfter', afterCol, howMany });
    if (afterCol < 1 || afterCol > this.maxCols) {
      throw new Error('Those columns are out of bounds.');
    }
    const blanks = new Array(howMany).fill('');
    for (const row of this.grid) row.splice(afterCol, 0, ...blanks);
    this.maxCols += howMany;
    const moved = c => (Number(c) > afterCol ? Number(c) + howMany : Number(c));
    const cols = {};
    for (const c in this.columnFormats) cols[moved(c)] = this.columnFormats[c];
    this.columnFormats = cols;
    const cells = {};
    for (const k in this.cellFormats) {
      const rc = k.split(',');
      cells[rc[0] + ',' + moved(rc[1])] = this.cellFormats[k];
    }
    this.cellFormats = cells;
    return this;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = {};
    this.timezone = 'America/New_York'; // deliberately NOT Manila by default
  }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) {
    const sh = new FakeSheet(name);
    this.sheets[name] = sh;
    return sh;
  }
  setSpreadsheetTimeZone(tz) { this.timezone = tz; return this; }
  getSpreadsheetTimeZone() { return this.timezone; }
  getUrl() { return 'https://sheets.example/fake'; }
  getId() { return 'fake-spreadsheet-id'; }
  getName() { return 'Octogo Takoyaki - Marikina'; }
}

/* ---- Drive + trigger stubs (v2.7.5 backups). A fake Drive holding named
   folders of named files, and a trigger registry, so backupSheet() and
   setupBackups() are tested for real: copies land, prunes trash the OLDEST,
   re-arming replaces rather than stacks. ---- */
function makeFakeDrive() {
  const folders = new Map(); // name -> folder object
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const makeFolder = (name) => {
    const files = [];
    return {
      _files: files,
      getName: () => name,
      getFiles: () => iter(files.filter(f => !f._trashed)),
      /** Uploading a blob (v2.9.0 — the vision project keeps every photo it
       *  reads). Set drive._failCreateFile to a reason and this throws exactly
       *  the way a Drive quota or a permissions problem does, which is the
       *  failure the reading has to survive. */
      createFile(blob) {
        if (drive._failCreateFile) throw new Error(drive._failCreateFile);
        const id = 'photo-id-' + (++drive._seq);
        const f = {
          _trashed: false, _blob: blob, _id: id,
          getName: () => blob.getName(),
          getId: () => id,
          getUrl: () => 'https://drive.example/file/d/' + id + '/view',
          setTrashed(v) { this._trashed = !!v; }
        };
        files.push(f);
        return f;
      }
    };
  };
  const drive = {
    _folders: folders,
    _seq: 0,
    _failCreateFile: null,
    getFoldersByName(name) { return iter(folders.has(name) ? [folders.get(name)] : []); },
    createFolder(name) {
      if (drive._failCreateFile) throw new Error(drive._failCreateFile);
      const f = makeFolder(name); folders.set(name, f); return f;
    },
    getFileById(id) {
      return {
        _id: id,
        // A Google Sheet IS a Drive file: its name is readable here, which is
        // why the backup project needs no spreadsheet permission at all.
        getName: () => 'Octogo Takoyaki - Marikina',
        makeCopy(name, folder) {
          const copy = { _trashed: false, getName: () => name, setTrashed(v) { this._trashed = !!v; } };
          folder._files.push(copy);
          return copy;
        }
      };
    }
  };
  return drive;
}

/* ---- UrlFetchApp (v2.9.0 — the vision project, the ONLY project allowed to
   make an internet request). The reply is what the test SETS, so the whole
   canned-reply matrix (a good reading, prose, a 429, an empty candidates
   array) is exercised without a single live call. Every request is recorded
   whole, so a test can assert the URL, the method, muteHttpExceptions, the
   prompt and schema shape — and that the API KEY IS NOT IN THE BODY. ---- */
function makeFakeUrlFetch() {
  const requests = [];
  const state = { code: 200, body: '{}', throwWith: null };
  return {
    _requests: requests,
    /** Set the canned reply. `body` may be a string or an object. */
    _reply(code, body) {
      state.code = code;
      state.body = (typeof body === 'string') ? body : JSON.stringify(body);
    },
    /** Make fetch itself throw — no network, DNS, a timeout. */
    _throw(message) { state.throwWith = message; },
    _last() { return requests[requests.length - 1]; },
    /** The body as the request actually carries it, for "the key is not here". */
    _lastBodyText() { const r = requests[requests.length - 1]; return r ? String(r.payload) : ''; },
    _lastBodyJson() { return JSON.parse(this._lastBodyText()); },
    fetch(url, params) {
      params = params || {};
      requests.push({
        url: url,
        method: params.method,
        contentType: params.contentType,
        headers: params.headers || {},
        payload: params.payload,
        muteHttpExceptions: params.muteHttpExceptions
      });
      if (state.throwWith) throw new Error(state.throwWith);
      return {
        getResponseCode: () => state.code,
        getContentText: () => state.body
      };
    }
  };
}

function makeFakeScriptApp() {
  const triggers = [];
  return {
    _triggers: triggers,
    WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', SUNDAY: 'SUNDAY' },
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(t) { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger(fn) {
      const make = () => { const t = { getHandlerFunction: () => fn, _tz: chain._tz }; triggers.push(t); return t; };
      const chain = { timeBased: () => chain, everyWeeks: () => chain, onWeekDay: () => chain,
        atHour: () => chain, inTimezone: (tz) => { chain._tz = tz; return chain; }, create: make };
      return chain;
    }
  };
}

// ---------------------------------------------------------------------------
// A FIXED clock for the harness.
//
// Code.gs reads the clock in exactly two places: nowStamp() (`new Date()`) and
// bootstrap's 90-day window (`Date.now()`). Both suites are full of fixed date
// literals (2026-07-30, the legacy sheet's 2026-07-20, ...) whose position
// inside that window would otherwise depend on the day the suite is RUN — so a
// green suite would quietly start failing months from now, on a LIVE system,
// for no reason anybody could see in the diff. Freezing "now" pins that.
// Pass an explicit instant to makeContext for a case that needs another today.
// ---------------------------------------------------------------------------
const FIXED_NOW = new Date('2026-08-01T13:00:00+08:00'); // Manila, mid-afternoon

/** Date with `new Date()` / Date.now() pinned. Subclasses the REAL Date so its
 *  instances still pass Intl's internal brand check inside formatDate. */
function frozenDateClass(now) {
  const fixed = now.getTime();
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  };
}

function makeContext(activeSpreadsheet, now) {
  return {
    Date: frozenDateClass(now || FIXED_NOW),
    SpreadsheetApp: { getActive: () => activeSpreadsheet, openById: () => activeSpreadsheet },
    DriveApp: makeFakeDrive(),
    ScriptApp: makeFakeScriptApp(),
    // Present in every context so the FENCE test is meaningful: if Code.gs ever
    // grew a UrlFetchApp call it would WORK here, and only the source-level
    // fence assertion would catch it. A stub that threw would let the fence
    // look self-enforcing when it is not.
    UrlFetchApp: makeFakeUrlFetch(),
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      // Blobs (v2.9.0): the photo on its way into Drive. base64Decode hands
      // back real bytes so a test can prove the file holds the image it sent.
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      newBlob: (bytes, mime, name) => ({
        _bytes: bytes,
        getBytes: () => bytes,
        getContentType: () => mime,
        getName: () => name
      })
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => {
        const o = { text, mime: null };
        o.setMimeType = (m) => { o.mime = m; return o; };
        o.getContent = () => o.text;
        return o;
      }
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },
    Logger: { log: () => {} }
  };
}

module.exports = { FakeSheet, FakeSpreadsheet, makeContext, formatDate, FIXED_NOW,
  makeFakeDrive, makeFakeUrlFetch };
