#!/usr/bin/env node
'use strict';

let main;

try {
  ({ main } = require('../dist/index.js'));
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND') {
    console.error('loop-until: compiled output is missing. Run `npm run build` first.');
    process.exitCode = 1;
    return;
  }
  throw error;
}

main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
