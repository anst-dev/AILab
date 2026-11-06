'use strict';
// Evaluation used by the tests: prints "score: <value.txt>", fails when the value is not a number.
const fs = require('node:fs');
const v = parseFloat(fs.readFileSync('value.txt', 'utf8'));
if (!Number.isFinite(v)) {
  console.error('value.txt is broken');
  process.exit(1);
}
setTimeout(() => {
  console.log('---');
  console.log(`score: ${v}`);
}, 200 + Math.random() * 800);
