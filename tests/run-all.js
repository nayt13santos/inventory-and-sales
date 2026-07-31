#!/usr/bin/env node
'use strict';
/* Runs every suite in this directory, in order, and exits non-zero if any of
   them fails.
     run-tests.js     — Code.gs in isolation (sheet writes, cutoff maths, note)
     contract.test.js — the REAL seam: Code.gs responses -> the PWA's readers
   Usage: node run-all.js */

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = ['run-tests.js', 'contract.test.js'];

let failedSuites = 0;
for (const suite of SUITES) {
  console.log('\n############################################');
  console.log('#  ' + suite);
  console.log('############################################');
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failedSuites++;
}

console.log('\n############################################');
if (failedSuites === 0) {
  console.log('#  ALL SUITES PASSED (' + SUITES.length + ')');
  console.log('############################################');
} else {
  console.log('#  ' + failedSuites + ' of ' + SUITES.length + ' SUITES FAILED');
  console.log('############################################');
  process.exit(1);
}
