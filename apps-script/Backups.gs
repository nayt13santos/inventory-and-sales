/* ============================================================================
 * Octogo Tracker — WEEKLY BACKUPS  (v2.7.5)
 *
 * A SEPARATE, STANDALONE Apps Script project — deliberately NOT part of the
 * sheet's bound script, and this is the whole point:
 *
 *   Apps Script grants permissions per PROJECT, and the bound script is what
 *   serves the phones. Copying files needs Drive permission and a schedule
 *   needs trigger permission; adding either to the bound project would grow
 *   the permissions the LIVE web app runs under, and until the owner
 *   re-authorised it in the editor, an ordinary night's save could start
 *   failing. A backup must never be able to break the thing it protects.
 *   So it lives here, alone, with its own permissions and its own schedule.
 *
 * SETUP (once, ~2 minutes) — see SETUP.md:
 *   1. script.google.com -> New project -> name it "Octogo Backups"
 *   2. Paste this whole file in, replacing the placeholder code.
 *   3. Put the sheet's id in SPREADSHEET_ID below (it is the long string in
 *      the sheet's URL between /d/ and /edit).
 *   4. Run setupBackups() once and approve the prompts.
 * From then on Google runs backupSheet() weekly on its own — no phone and no
 * computer needs to be open, and the tracker itself is never touched.
 * ========================================================================== */
'use strict';

/** The sheet to protect: the long id from its URL, between /d/ and /edit. */
var SPREADSHEET_ID = 'PASTE_THE_SHEET_ID_HERE';

var BACKUP_FOLDER = 'Octogo Tracker Backups';
var BACKUP_KEEP = 8;                 // ~two months of Mondays
var TZ = 'Asia/Manila';

/** Run ONCE from the editor. Arms the weekly schedule — replacing any earlier
 *  one rather than stacking a second — and makes the first copy immediately,
 *  so "did it work?" has an answer today rather than next Monday. */
function setupBackups() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === 'PASTE_THE_SHEET_ID_HERE') {
    throw new Error('Put the sheet id in SPREADSHEET_ID first (the long string in the sheet URL between /d/ and /edit).');
  }
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'backupSheet') ScriptApp.deleteTrigger(triggers[i]);
  }
  // The documented weekly shape: onWeekDay + atHour. Google fires it within
  // that hour; no everyWeeks() alongside it, which errors on some runtimes.
  // inTimezone is NOT optional here: atHour is read in the SCRIPT PROJECT's
  // timezone, and this project is one the owner creates fresh — it inherits
  // whatever zone Google gives it, which is rarely Manila. Without this the
  // "Monday 6am" promise can land ~15 hours off (v2.7.5).
  ScriptApp.newTrigger('backupSheet').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).inTimezone(TZ).create();
  var made = backupSheet();
  // The Apps Script editor NEVER displays a return value, so a successful run
  // would print nothing while a failure prints a red stack — success has to be
  // as loud as failure or the owner cannot tell it worked (v2.7.5).
  var said = 'Weekly backup armed (Mondays, ~6am Manila). ' + made;
  Logger.log(said);
  return said;
}

/** One dated copy per day however many times this runs, then the OLDEST
 *  copies beyond BACKUP_KEEP go to the trash. The date lives in the NAME and
 *  is the sort key, so nothing depends on Drive's own timestamps. */
function backupSheet() {
  // The sheet as a DRIVE FILE, never through SpreadsheetApp: its name is all
  // this needs, and getFileById gives it without the project ever asking for
  // permission to read or write spreadsheet CONTENT. Narrower is safer — this
  // project can copy the file and nothing else (v2.7.5).
  var file = DriveApp.getFileById(SPREADSHEET_ID);
  var it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
  var name = 'Backup ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + ' — ' + file.getName();

  var backups = [];
  var exists = false;
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var fn = f.getName();
    if (fn === name) exists = true;
    if (fn.indexOf('Backup ') === 0) backups.push(f);
  }
  if (!exists) {
    backups.push(file.makeCopy(name, folder));
  }
  // Newest names sort first; everything past BACKUP_KEEP is trashed — Drive's
  // own trash then holds it ~30 days, a deliberate second net over a hard delete.
  backups.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  for (var k = BACKUP_KEEP; k < backups.length; k++) backups[k].setTrashed(true);
  var said = 'Made "' + name + '" in Drive folder "' + BACKUP_FOLDER + '" (' +
    Math.min(backups.length, BACKUP_KEEP) + ' kept).';
  Logger.log(said);
  return said;
}
