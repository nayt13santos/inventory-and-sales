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
}

function makeContext(activeSpreadsheet) {
  return {
    SpreadsheetApp: { getActive: () => activeSpreadsheet },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID()
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

module.exports = { FakeSheet, FakeSpreadsheet, makeContext, formatDate };
